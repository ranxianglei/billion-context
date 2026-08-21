import { type CompressionCore, type Config, type CoreMessage, type NudgeDecision } from "acp-kernel";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { acquireInFlight, markDirty, peekSession, releaseInFlight, withSessionLock, type Session } from "./session.js";
import { ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, PROXY_TOOL_NAMES } from "./compress-tool.js";
import { executeProxyTool } from "./loop/core.js";
import { normalizeSseLineEndings } from "./sse-util.js";
import type { WireProtocol } from "./util.js";

// Cooperative plugin protocol ("内外呼应", issue #1): an agent-side plugin
// registers the ACP tools NATIVELY with its agent and runs the agent's own
// tool loop, while the proxy stays the single compression authority (state,
// history folding, philosophy prompt, nudges). The plugin:
//   1. GETs /__bili/plugin/manifest and registers the served tool schemas
//      natively (single source of truth — zero schema drift between proxy
//      and plugin),
//   2. sends x-bili-plugin: <agent> + x-bili-plugin-conversation: <id> on
//      every model request. The proxy then suppresses wire-level tool
//      injection for that session (tools are native) and stops intercepting
//      proxy-named tool calls — the model's compress call flows back to the
//      agent untouched, the plugin forwards it to (3),
//   3. executes tools via POST /__bili/plugin/tool {conversationId, tool,
//      args}, under the session lock, against the same executeProxyTool the
//      wire-mode compress loop uses.

export const PLUGIN_AGENT_HEADER = "x-bili-plugin";
export const PLUGIN_CONVERSATION_HEADER = "x-bili-plugin-conversation";
export const PLUGIN_CONTEXT_WINDOW_HEADER = "x-bili-plugin-context-window";

export const PLUGIN_PROTOCOL_VERSION = 1;

const VERSION = (() => {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkg = path.join(path.dirname(here), "..", "package.json");
        return (JSON.parse(fs.readFileSync(pkg, "utf8")).version as string) ?? "dev";
    } catch {
        return "dev";
    }
})();

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const v = headers[name];
    const s = typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
    const t = s?.trim();
    return t && t.length > 0 ? t : undefined;
}

export function pluginAgentHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
    return headerValue(headers, PLUGIN_AGENT_HEADER);
}

export function pluginConversationHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
    return headerValue(headers, PLUGIN_CONVERSATION_HEADER);
}

/** The plugin reports its agent's own model context window (what the agent
 *  configured, e.g. a pinned/overridden contextWindow). It replaces the
 *  native-window source (built-in table / models.dev registry) in the config
 *  cascade — operator tuning (compress.modelContextLimit) still outranks it. */
export function pluginContextWindowHeader(headers: Record<string, string | string[] | undefined>): number | undefined {
    const raw = headerValue(headers, PLUGIN_CONTEXT_WINDOW_HEADER);
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The reported window is honored ONLY from a request that also announces
 *  itself as a plugin (x-bili-plugin). This header is protocol-internal:
 *  honoring it from a plain (non-plugin) client would let anyone who can
 *  reach the endpoint rewrite the nudge denominator. A real plugin sends
 *  both headers together (see the manifest's `headers` block). */
export function pluginReportedContextWindow(headers: Record<string, string | string[] | undefined>): number | undefined {
    return pluginAgentHeader(headers) !== undefined ? pluginContextWindowHeader(headers) : undefined;
}

type ConversationEntry = { sessionId: string; lastSeen: number };
type RememberedMessages = { processed: CoreMessage[]; original: CoreMessage[]; nudge?: NudgeDecision };

const MAX_PLUGIN_CONVERSATIONS = 1024;

const conversations = new Map<string, ConversationEntry>();
const remembered = new Map<string, RememberedMessages>();

/** Index a plugin session by its conversation id (the key the plugin uses on
 *  the tool API). Re-inserting moves the entry to the end so plain Map
 *  insertion order doubles as an LRU clock. */
export function recordPluginSession(conversationId: string, sessionId: string): void {
    conversations.delete(conversationId);
    conversations.set(conversationId, { sessionId, lastSeen: Date.now() });
    // remembered[sessionId] is intentionally left alone here: this runs OUTSIDE
    // the session lock. rememberPluginMessages() rewrites it under the lock
    // after forward(), and the tool API reads it under the lock — so no
    // out-of-lock mutation that could leave a concurrent tool call on a stale
    // (empty) snapshot.
    if (conversations.size > MAX_PLUGIN_CONVERSATIONS) {
        const oldest = conversations.keys().next().value;
        if (oldest !== undefined) conversations.delete(oldest);
    }
}

/** Keep the last prepare()'s view for a plugin session so tool-API execution
 *  sees the exact refs the model was shown (mirrors the wire-mode loop, which
 *  runs executeProxyTool against prepared.processedMessages). */
export function rememberPluginMessages(sessionId: string, processed: CoreMessage[], original: CoreMessage[], nudge?: NudgeDecision): void {
    const staleSessionIds = new Set(
        [...remembered.keys()].filter((id) => id === sessionId || !peekSession(id)),
    );
    for (const id of staleSessionIds) remembered.delete(id);
    remembered.set(sessionId, { processed, original, nudge });
}

// Launcher mode (#162): hosts that cannot attach per-request headers
// (claude/codex spawned by `bili claude` / `bili codex`) pre-register their
// conversation via POST /__bili/plugin/register — typically from a Claude
// Code SessionStart hook or at codex spawn time. A pending register is
// consumed by the FIRST model request that creates a NEW session afterwards
// (server.ts binding step): that session becomes plugin-mode (native tools,
// wire injection suppressed) and the conversation id becomes its tool-API key
// — no x-bili-plugin headers required.
export type PendingPluginRegister = { conversationId: string; agent: string; ts: number };

const MAX_PENDING_REGISTERS = 64;

const pendingRegisters: PendingPluginRegister[] = [];

/** Queue a launcher-mode registration. `identity: true` means the host puts
 *  the SAME id on every model request (claude code: x-claude-code-session-id
 *  === CLAUDE_CODE_SESSION_ID) — bind by identity match only. `identity:
 *  false` (headless codex spawn) means requests carry no matching id — bind
 *  the next NEW session instead. Splitting the two keeps a foreign session
 *  from eating an identity registration it can never claim. */
export function queuePluginRegister(conversationId: string, agent: string, identity: boolean): void {
    if (!identity) {
        for (let i = 0; i < pendingRegisters.length; i++) {
            if (pendingRegisters[i]!.conversationId === conversationId) {
                pendingRegisters.splice(i, 1);
                break;
            }
        }
        pendingRegisters.push({ conversationId, agent, ts: Date.now() });
        while (pendingRegisters.length > MAX_PENDING_REGISTERS) pendingRegisters.shift();
    } else {
        registeredIds.set(conversationId, agent);
        while (registeredIds.size > MAX_PENDING_REGISTERS) {
            const oldest = registeredIds.keys().next().value;
            if (oldest !== undefined) registeredIds.delete(oldest);
        }
    }
}

/** Headless registrations expire: a registration that no new session has
 *  claimed within this window was orphaned (the spawn never happened, or the
 *  session was created by some other path). Binding a stale one to an
 *  unrelated later session would turn that session into plugin mode with a
 *  foreign conversation id. */
const PENDING_REGISTER_TTL_MS = 10 * 60 * 1000;

/** Take (and remove) the oldest pending registration — called by the server
 *  when a model request resolves a NEW session, to bind that session into
 *  plugin mode. Expired (orphaned) registrations are dropped, never bound.
 *  Entries are appended in time order, so pruning from the front suffices. */
export function takePendingPluginRegister(): PendingPluginRegister | undefined {
    const now = Date.now();
    while (pendingRegisters.length > 0 && now - pendingRegisters[0]!.ts > PENDING_REGISTER_TTL_MS) {
        pendingRegisters.shift();
    }
    return pendingRegisters.shift();
}
const registeredIds = new Map<string, string>();

/** Identity-driven binding (#162): hosts whose model requests carry the SAME
 *  id the MCP shell registered (claude code: every request has
 *  x-claude-code-session-id === CLAUDE_CODE_SESSION_ID === the registered
 *  conversation id) bind the moment any of their requests shows up — no
 *  ordering race with the shell's initialize. */
export function consumePluginRegisterFor(conversationId: string): string | undefined {
    const agent = registeredIds.get(conversationId);
    if (agent !== undefined) registeredIds.delete(conversationId);
    return agent;
}

export function handlePluginRegister(payload: string, res: import("node:http").ServerResponse): void {
    let parsed: { conversationId?: unknown; agent?: unknown; identity?: unknown };
    try {
        parsed = JSON.parse(payload) as { conversationId?: unknown; agent?: unknown; identity?: unknown };
    } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        return;
    }
    const conversationId = typeof parsed.conversationId === "string" ? parsed.conversationId.trim() : "";
    if (!conversationId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "conversationId is required" }));
        return;
    }
    const agent = typeof parsed.agent === "string" && parsed.agent.trim() ? parsed.agent.trim() : "launcher";
    queuePluginRegister(conversationId, agent, parsed.identity === true);
    res.end(JSON.stringify({ ok: true, conversationId, agent }));
}

export function handlePluginManifest(res: import("node:http").ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        ok: true,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        proxy: "billion-context",
        version: VERSION,
        toolNames: [...PROXY_TOOL_NAMES],
        tools: {
            anthropic: ACP_TOOLS_ANTHROPIC,
            openai: ACP_TOOLS_OPENAI,
            responses: ACP_TOOLS_RESPONSES,
        },
        headers: { agent: PLUGIN_AGENT_HEADER, conversation: PLUGIN_CONVERSATION_HEADER, contextWindow: PLUGIN_CONTEXT_WINDOW_HEADER },
        toolEndpoint: "/__bili/plugin/tool",
        statusEndpoint: "/__bili/plugin/status",
    }));
}

export type PluginToolDeps = {
    core: CompressionCore;
    config: Config;
    log: (level: string, msg: string) => void;
};

/** Context-level visibility for plugin UIs (status bars / slash commands):
 *  the same usage the nudge decision sees, keyed by conversation id. */
export function handlePluginStatus(conversationId: string, res: import("node:http").ServerResponse): void {
    const entry = conversations.get(conversationId);
    const session = entry ? peekSession(entry.sessionId) : undefined;
    if (!entry || !session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unknown plugin conversation" }));
        return;
    }
    entry.lastSeen = Date.now();
    const limit = session.metadata.effectiveContextLimit;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        ok: true,
        conversationId,
        sessionId: session.id,
        label: session.meta.label ?? null,
        pluginAgent: session.metadata.pluginAgent ?? null,
        contextLimit: typeof limit === "number" ? limit : null,
        contextTokens: session.stats.lastInputTokens,
        inputTokens: session.stats.inputTokens,
        outputTokens: session.stats.outputTokens,
        cachedTokens: session.stats.cachedTokens,
        requests: session.stats.requests,
        blocks: session.state.blocks.map((b) => ({ id: b.blockId, tier: b.tier, active: b.active })),
        lastSeen: session.lastSeen,
    }));
}

export async function handlePluginTool(
    payload: string,
    res: import("node:http").ServerResponse,
    deps: PluginToolDeps,
): Promise<void> {
    let parsed: { conversationId?: unknown; tool?: unknown; args?: unknown };
    try {
        parsed = JSON.parse(payload) as { conversationId?: unknown; tool?: unknown; args?: unknown };
    } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        return;
    }
    const conversationId = typeof parsed.conversationId === "string" ? parsed.conversationId.trim() : "";
    const tool = typeof parsed.tool === "string" ? parsed.tool : "";
    if (!conversationId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `conversationId is required (send the same value as the ${PLUGIN_CONVERSATION_HEADER} header)` }));
        return;
    }
    if (!PROXY_TOOL_NAMES.has(tool)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `unknown tool "${tool}" (expected one of: ${[...PROXY_TOOL_NAMES].join(", ")})` }));
        return;
    }
    const entry = conversations.get(conversationId);
    const session = entry ? peekSession(entry.sessionId) : undefined;
    if (!entry || !session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unknown plugin conversation (no model request has arrived with this conversation id yet)" }));
        return;
    }
    entry.lastSeen = Date.now();
    const args = parsed.args && typeof parsed.args === "object" ? (parsed.args as Record<string, unknown>) : {};
    const callId = `plugin_${Date.now().toString(36)}`;
    acquireInFlight(session);
    let result: string;
    try {
        result = await withSessionLock(session, async () => {
            // Read the remembered snapshot UNDER the session lock: the model
            // request rewrites remembered atomically under this same lock
            // (rememberPluginMessages), so a racing tool call sees a consistent
            // state instead of a stale/empty window.
            const mem = remembered.get(session.id);
            const messages = mem ? (mem.processed.length > 0 ? mem.processed : mem.original) : [];
            return executeProxyTool(tool, args, {
                core: deps.core,
                config: deps.config,
                messages,
                session,
                log: (m) => deps.log("info", `[${session.id}] [plugin] ${m}`),
                nudge: mem?.nudge,
            }, callId);
        });
    } catch (err) {
        releaseInFlight(session);
        deps.log("warn", `[${session.id}] [plugin] tool ${tool} threw: ${String(err)}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
        return;
    }
    releaseInFlight(session);
    markDirty(session);
    deps.log("info", `[${session.id}] [plugin] tool ${tool} executed via plugin (${result.length} chars)`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, tool, conversationId, result }));
}

type UsageSample = { inputTokens?: number; cachedTokens?: number; outputTokens?: number };

function num(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function usageFromSseEvent(obj: Record<string, unknown>): UsageSample | undefined {
    const type = obj["type"];
    if (type === "message_start") {
        const usage = (obj["message"] as Record<string, unknown> | undefined)?.["usage"] as Record<string, unknown> | undefined;
        if (!usage) return undefined;
        const input = num(usage["input_tokens"]);
        if (input === undefined) return undefined;
        return { inputTokens: input, cachedTokens: num(usage["cache_read_input_tokens"]) };
    }
    if (type === "message_delta") {
        const usage = obj["usage"] as Record<string, unknown> | undefined;
        if (!usage) return undefined;
        // Some relays echo `input_tokens: 0` in message_delta (the field is
        // normally absent — message_start is authoritative for the input size,
        // which is fixed within a turn). A 0 here is never a legitimate new
        // value; merging it would zero acc.inputTokens (set by message_start)
        // and collapse lastInputTokens to the cached portion only.
        const input = num(usage["input_tokens"]);
        return { inputTokens: input && input > 0 ? input : undefined, outputTokens: num(usage["output_tokens"]) };
    }
    if (type === "response.completed") {
        const usage = (obj["response"] as Record<string, unknown> | undefined)?.["usage"] as Record<string, unknown> | undefined;
        if (!usage) return undefined;
        return {
            inputTokens: num(usage["input_tokens"]),
            outputTokens: num(usage["output_tokens"]),
            cachedTokens: num((usage["input_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]),
        };
    }
    const usage = obj["usage"] as Record<string, unknown> | undefined;
    if (usage && (num(usage["prompt_tokens"]) !== undefined || num(usage["completion_tokens"]) !== undefined)) {
        return {
            inputTokens: num(usage["prompt_tokens"]),
            outputTokens: num(usage["completion_tokens"]),
            cachedTokens: num((usage["prompt_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]),
        };
    }
    return undefined;
}

function applyUsageSample(session: Session, sample: UsageSample, protocol?: WireProtocol): void {
    // inputTokens is protocol-native: Anthropic reports it NEW-only (cached
    // separate); OpenAI/Responses report the TOTAL (cached already included).
    // Add cached back in only when it is not already part of inputTokens.
    const includesCached = protocol === "openai" || protocol === "responses";
    if (sample.cachedTokens !== undefined) {
        session.stats.cachedTokens += sample.cachedTokens;
        session.stats.cacheSamples += 1;
    }
    if (sample.inputTokens !== undefined) {
        const total =
            sample.inputTokens +
            (!includesCached && sample.cachedTokens !== undefined ? sample.cachedTokens : 0);
        session.stats.inputTokens += total;
        session.stats.lastInputTokens = total;
    }
    if (sample.outputTokens !== undefined) session.stats.outputTokens += sample.outputTokens;
}

/** Merge an SSE event's usage fields into the per-response accumulator.
 *  Later events overwrite fields they carry (anthropic reports input on
 *  message_start and output on message_delta), so `lastInputTokens` ends up
 *  holding the LAST reported context size — the value the nudge decision
 *  reads on the next prepare(). */
function mergeUsageSample(acc: UsageSample, sample: UsageSample): void {
    if (sample.inputTokens !== undefined) acc.inputTokens = sample.inputTokens;
    if (sample.cachedTokens !== undefined) acc.cachedTokens = sample.cachedTokens;
    if (sample.outputTokens !== undefined) acc.outputTokens = sample.outputTokens;
}

/** Plugin-mode streaming passthrough: forward upstream bytes verbatim (the
 *  agent's native tool loop must see the model's tool calls untouched) while
 *  sniffing usage out of the SSE events — without this, lastInputTokens
 *  would never update and compression nudges would never fire. */
export async function pipeThroughWithUsage(
    stream: ReadableStream<Uint8Array>,
    res: import("node:http").ServerResponse,
    session: Session,
    protocol?: WireProtocol,
): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    const acc: UsageSample = {};
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
                if (!res.write(Buffer.from(value))) {
                    await new Promise<void>((r) => res.once("drain", () => r()));
                }
                buf = normalizeSseLineEndings(buf + decoder.decode(value, { stream: true }));
                let idx: number;
                while ((idx = buf.indexOf("\n\n")) !== -1) {
                    const rawEvent = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const dataLines = rawEvent.split("\n").filter((l) => l.startsWith("data:"));
                    if (dataLines.length === 0) continue;
                    const jsonStr = dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n").trim();
                    if (!jsonStr || jsonStr === "[DONE]") continue;
                    try {
                        const ev = JSON.parse(jsonStr) as Record<string, unknown>;
                        const sample = usageFromSseEvent(ev);
                        if (sample) mergeUsageSample(acc, sample);
                    } catch { /* non-JSON data line */ }
                }
            }
            if (res.destroyed || res.writableEnded) break;
        }
        // Apply BEFORE res.end() in the finally below: the client can issue
        // its next request (e.g. /__bili/plugin/status, or the follow-up turn
        // that reads lastInputTokens for the nudge decision) the moment the
        // stream completes, and those must already see this usage.
        if (acc.inputTokens !== undefined || acc.outputTokens !== undefined || acc.cachedTokens !== undefined) {
            applyUsageSample(session, acc, protocol);
            markDirty(session);
        }
    } finally {
        reader.releaseLock();
        res.end();
    }
}

/** Plugin-mode non-streaming passthrough: same contract as
 *  pipeThroughWithUsage but for a single JSON body. */
export async function pipePluginJson(
    stream: ReadableStream<Uint8Array>,
    res: import("node:http").ServerResponse,
    session: Session,
    protocol?: WireProtocol,
): Promise<void> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) chunks.push(Buffer.from(value));
    }
    reader.releaseLock();
    const text = Buffer.concat(chunks).toString("utf8");
    try {
        const json = JSON.parse(text) as Record<string, unknown>;
        const usage = json["usage"] as Record<string, unknown> | undefined;
        if (usage) {
            const input = num(usage["prompt_tokens"]) ?? num(usage["input_tokens"]);
            if (input !== undefined) {
                applyUsageSample(session, {
                    inputTokens: input,
                    outputTokens: num(usage["completion_tokens"]) ?? num(usage["output_tokens"]),
                    cachedTokens:
                        num((usage["prompt_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]) ??
                        num((usage["input_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]) ??
                        num(usage["cache_read_input_tokens"]),
                }, protocol);
                markDirty(session);
            }
        }
    } catch { /* non-JSON body — forward verbatim */ }
    res.end(text);
}

export function _resetPluginStateForTest(): void {
    conversations.clear();
    remembered.clear();
    pendingRegisters.length = 0;
    registeredIds.clear();
}
