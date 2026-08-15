import { type CompressionCore, type Config, type CoreMessage, type NudgeDecision } from "acp-kernel";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { acquireInFlight, markDirty, peekSession, releaseInFlight, withSessionLock, type Session } from "./session.js";
import { ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, PROXY_TOOL_NAMES } from "./compress-tool.js";
import { executeProxyTool } from "./loop/core.js";
import { normalizeSseLineEndings } from "./sse-util.js";

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
    remembered.delete(sessionId);
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
        headers: { agent: PLUGIN_AGENT_HEADER, conversation: PLUGIN_CONVERSATION_HEADER },
        toolEndpoint: "/__bili/plugin/tool",
    }));
}

export type PluginToolDeps = {
    core: CompressionCore;
    config: Config;
    log: (level: string, msg: string) => void;
};

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
    const mem = remembered.get(session.id);
    const messages = mem ? (mem.processed.length > 0 ? mem.processed : mem.original) : [];
    const callId = `plugin_${Date.now().toString(36)}`;
    acquireInFlight(session);
    let result: string;
    try {
        result = await withSessionLock(session, async () =>
            executeProxyTool(tool, args, {
                core: deps.core,
                config: deps.config,
                messages,
                session,
                log: (m) => deps.log("info", `[${session.id}] [plugin] ${m}`),
                nudge: mem?.nudge,
            }, callId),
        );
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
        return { inputTokens: num(usage["input_tokens"]), outputTokens: num(usage["output_tokens"]) };
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

function applyUsageSample(session: Session, sample: UsageSample): void {
    if (sample.inputTokens !== undefined) session.stats.inputTokens += sample.inputTokens;
    if (sample.cachedTokens !== undefined) {
        session.stats.cachedTokens += sample.cachedTokens;
        session.stats.cacheSamples += 1;
    }
    if (sample.inputTokens !== undefined) {
        session.stats.lastInputTokens = sample.inputTokens + (sample.cachedTokens ?? 0);
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
    } finally {
        reader.releaseLock();
        res.end();
    }
    if (acc.inputTokens !== undefined || acc.outputTokens !== undefined || acc.cachedTokens !== undefined) {
        applyUsageSample(session, acc);
        markDirty(session);
    }
}

/** Plugin-mode non-streaming passthrough: same contract as
 *  pipeThroughWithUsage but for a single JSON body. */
export async function pipePluginJson(
    stream: ReadableStream<Uint8Array>,
    res: import("node:http").ServerResponse,
    session: Session,
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
                });
                markDirty(session);
            }
        }
    } catch { /* non-JSON body — forward verbatim */ }
    res.end(text);
}

export function _resetPluginStateForTest(): void {
    conversations.clear();
    remembered.clear();
}
