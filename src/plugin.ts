import { type CompressionCore, type Config, type CoreMessage, type NudgeDecision, countMessageTokens } from "acp-kernel";
import { buildStatusPanel } from "acp-kernel/panel";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { acquireInFlight, effectiveConfig, findSessionByCanonicalId, listSessions, markCompactionBoundary, markDirty, peekSession, releaseInFlight, withSessionLock, type Session } from "./session.js";
import { ABSORB_TOOL_NAME, BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES, PROXY_TOOL_NAMES, RETRIEVE_TOOL_NAME, RULE_TOOL, RULE_TOOL_NAME, RULE_TOOL_OPENAI, RULE_TOOL_RESPONSES, SEARCH_CONTEXT_CONVERSATION_ID_PARAM, SEARCH_CONTEXT_TOOL_NAME, absorbToolsFor, retrieveToolsFor } from "./compress-tool.js";
import { absorbEnabled, effectiveAbsorbConfig, isProxyToolFor } from "./absorb.js";
import { effectiveRulesConfig, rulesEnabled } from "./rules-feature.js";
import { executeProxyTool } from "./loop/core.js";
import { normalizeSseLineEndings } from "./sse-util.js";
import { composeStreamFilters, containsMarkerLineText, containsRenderTagText, containsToolCallXmlFragment, createMarkerLineFilter, createTagEchoFilter, mayStartMarkerLine, mayStartRenderTag, stripAcpTags, stripAnthropicText, stripOpenaiChatText, stripResponsesText, type TagEchoFilter } from "./loop/tag-echo-filter.js";
import { log as loggerLog } from "./logger.js";
import { ccrEnabled, ccrLoopConfig, contentStoreOf, retrieveToolName } from "./store.js";
import { imageUsageSuffix } from "./image-compress.js";
import { emitStreamError, emitUpstreamTruncation } from "./stream-error.js";
import { degenerateTurnWarning } from "./degenerate-turn.js";
import { warnCacheCollapse } from "./cache-warn.js";
import { recordCacheSample } from "./cache-ledger.js";
import { promptInputTotal, type WireProtocol } from "./util.js";
import { stateDir } from "./paths.js";
import { awaitDrain } from "./server/stream-io.js";

// The proxy's own version, read from package.json at runtime (works in both dev
// via tsx and bundled via tsup). Shown in the /acp panel header, aligned with
// billion-context-pi's `billion-context-pi@<version>` format.
const PROXY_VERSION = (() => {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkg = path.join(path.dirname(here), "..", "package.json");
        return (JSON.parse(fs.readFileSync(pkg, "utf8")).version as string) ?? "dev";
    } catch {
        return "dev";
    }
})();

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
/** #920: legacy-lane marker. Set by the absorbed opencode-acp wrapper for
 *  sessions that still run through the legacy DCP machinery — the proxy
 *  forwards such requests VERBATIM (no wire injection, no session binding,
 *  no compress loop): the legacy extension owns compression for them. */
export const PLUGIN_BYPASS_HEADER = "x-bili-plugin-bypass";
export const PLUGIN_CONTEXT_WINDOW_HEADER = "x-bili-plugin-context-window";
export const PLUGIN_MAX_OUTPUT_HEADER = "x-bili-plugin-max-output";
export const PLUGIN_MODEL_HEADER = "x-bili-plugin-model";
/** #1102/#1106: stamped "1" by plugins whose host mints one conversation id per
 *  persona (opencode: subagents get their own child session ids). Since the
 *  instructions fingerprint became an allowlist (#1106 — exempt is the
 *  default for every non-codex/non-claude signal), this declaration is
 *  vestigial: hosts keep stamping it for protocol compatibility with older
 *  proxies, but current proxies key verbatim regardless. */
export const PLUGIN_INSTRUCTIONS_MUTABLE_HEADER = "x-bili-plugin-instructions-mutable";

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

export function pluginBypassHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
    return headerValue(headers, PLUGIN_BYPASS_HEADER);
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

/** Configured max output tokens (runtime-info protocol #955). Same gate as
 *  the window header: a plain client must not be able to move the proxy's
 *  output-headroom reservation by name. Used only when the request body
 *  carries no max_tokens of its own — the wire value always wins. */
export function pluginReportedMaxOutput(headers: Record<string, string | string[] | undefined>): number | undefined {
    const raw = pluginAgentHeader(headers) === undefined ? undefined : headerValue(headers, PLUGIN_MAX_OUTPUT_HEADER);
    if (raw === undefined) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Current model id (runtime-info protocol #955). Informational + lets the
 *  proxy correlate the per-agent runtime table with the request's model
 *  before trusting the table's window. Same plugin gate. */
export function pluginReportedModel(headers: Record<string, string | string[] | undefined>): string | undefined {
    if (pluginAgentHeader(headers) === undefined) return undefined;
    const raw = headerValue(headers, PLUGIN_MODEL_HEADER);
    return raw !== undefined && /^\S{1,256}$/.test(raw) ? raw : undefined;
}

/** #956 hardening: per-request plugin window/max-output headers describe the
 *  model the plugin CONFIGURED — when the request body carries a different
 *  model (mid-switch race, or a provider-model composite like
 *  "provider/model"), those headers must not size this request. Match is
 *  exact or on the last path segment (openai-compatible bodies use
 *  "provider/model" while plugins stamp the bare model id). A missing model
 *  header keeps the pre-#956 trust (window-only reporters still work). */
export function pluginHeadersMatchModel(headers: Record<string, string | string[] | undefined>, bodyModel: string | undefined): boolean {
    const reported = pluginReportedModel(headers);
    if (reported === undefined || bodyModel === undefined) return true;
    if (reported === bodyModel) return true;
    return bodyModel.split("/").pop() === reported;
}

type ConversationEntry = { sessionId: string; lastSeen: number };
type RememberedMessages = { processed: CoreMessage[]; original: CoreMessage[]; nudge?: NudgeDecision };

const MAX_PLUGIN_CONVERSATIONS = 1024;

const conversations = new Map<string, ConversationEntry>();
const remembered = new Map<string, RememberedMessages>();

// #1158: one-shot "no model requests arrived" warnings, keyed by conversation
// id. A tool call proves the model already answered, so an id with ZERO model
// requests means its traffic never reached this proxy (SDK-injected fetch,
// e.g. dsh llm-pi-ai under a bare profile install) or is stale after a host
// resume — warn once per conversation instead of on every rejected tool call.
const warnedNoModelRequests = new Set<string>();
const WARNED_NO_MODEL_REQUESTS_CAP = 4096;

// The conversationId → session mapping is in-memory. Persist it so a resumed
// or restarted proxy can still resolve /acp + tool calls to the (persisted)
// session without waiting for a fresh model request. Best-effort: a crash
// before the debounced write just means the next model request repopulates it.
const conversationsFile = () => path.join(stateDir(), "plugin-conversations.json");
let conversationsSaveTimer: NodeJS.Timeout | undefined;
let conversationsDirty = false;

function writeConversationsFile(): void {
    if (!conversationsDirty) return;
    try {
        const obj: Record<string, ConversationEntry> = {};
        for (const [k, v] of conversations) obj[k] = v;
        fs.mkdirSync(stateDir(), { recursive: true });
        // #406: the only state file that used to be written in place — a
        // torn write or a dying dual instance must not zero every route.
        const filePath = conversationsFile();
        const draft = `${filePath}.${process.pid}.bili-tmp`;
        fs.writeFileSync(draft, JSON.stringify(obj));
        fs.renameSync(draft, filePath);
        conversationsDirty = false;
    } catch {
        // best-effort persistence; ignore write failures
    }
}

function scheduleSaveConversations(): void {
    if (conversationsSaveTimer) clearTimeout(conversationsSaveTimer);
    conversationsSaveTimer = setTimeout(() => {
        conversationsSaveTimer = undefined;
        writeConversationsFile();
    }, 300);
}

/** Flush the conversation map to disk immediately (called on shutdown). */
export function flushConversations(): void {
    if (conversationsSaveTimer) {
        clearTimeout(conversationsSaveTimer);
        conversationsSaveTimer = undefined;
    }
    writeConversationsFile();
}

/** Restore the persisted conversationId → session map. Called at startup,
 *  AFTER initSessions so the referenced sessions are already loaded. */
export function loadConversations(): void {
    let raw: string;
    try {
        raw = fs.readFileSync(conversationsFile(), "utf8");
    } catch {
        return;
    }
    try {
        const obj = JSON.parse(raw) as Record<string, ConversationEntry>;
        for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v.sessionId === "string" && v.sessionId.length > 0) {
                conversations.set(k, { sessionId: v.sessionId, lastSeen: typeof v.lastSeen === "number" ? v.lastSeen : Date.now() });
            }
        }
    } catch {
        // #406: preserve the corrupt bytes for forensics instead of
        // silently zeroing every route on the next debounced write.
        try {
            fs.renameSync(conversationsFile(), `${conversationsFile()}.corrupt-${Date.now()}`);
        } catch {}
        loggerLog("warn", "[plugin] plugin-conversations.json is corrupt — backed up beside the original, starting an empty routing table");
    }
    conversationsDirty = false;
}

/** Index a plugin session by its conversation id (the key the plugin uses on
 *  the tool API). Re-inserting moves the entry to the end so plain Map
 *  insertion order doubles as an LRU clock. */
export function recordPluginSession(conversationId: string, sessionId: string): void {
    conversations.delete(conversationId);
    conversations.set(conversationId, { sessionId, lastSeen: Date.now() });
    conversationsDirty = true;
    // remembered[sessionId] is intentionally left alone here: this runs OUTSIDE
    // the session lock. rememberPluginMessages() rewrites it under the lock
    // after forward(), and the tool API reads it under the lock — so no
    // out-of-lock mutation that could leave a concurrent tool call on a stale
    // (empty) snapshot.
    if (conversations.size > MAX_PLUGIN_CONVERSATIONS) {
        const oldest = conversations.keys().next().value;
        if (oldest !== undefined) conversations.delete(oldest);
    }
    scheduleSaveConversations();
}

/** Keep the last prepare()'s view for a plugin session so tool-API execution
 *  sees the exact refs the model was shown (mirrors the wire-mode loop, which
 *  runs executeProxyTool against prepared.processedMessages). */
export function rememberPluginMessages(sessionId: string, processed: CoreMessage[], original: CoreMessage[], nudge?: NudgeDecision): void {
    // #1307: auxiliary requests (auto-review / classifier prompts) bound to the
    // same session key can carry a normal output budget and any message count,
    // so both the ≤200 heuristic and size-based guards are proxies that a new
    // host shape walks through. The causal signal is IDENTITY: a main turn
    // RESENDS the conversation, so it always carries messages the previous
    // snapshot already holds (content-hash ids are stable); an auxiliary
    // prompt shares NOTHING with it by construction. A zero-overlap view that
    // is also smaller than the snapshot is therefore not a continuation —
    // refuse to evict (the tool API anchors compress ranges from this
    // snapshot; losing it dangles every long-session ref). Known cost: a
    // genuine restart on the same session id keeps the stale snapshot for one
    // round; the next resending turn self-heals. Fresh sessions and larger or
    // overlapping views always write.
    const incoming = processed.length > 0 ? processed : original;
    const previous = remembered.get(sessionId);
    if (previous) {
        const previousView = previous.processed.length > 0 ? previous.processed : previous.original;
        if (previousView.length > incoming.length) {
            const knownIds = new Set(previousView.map((m) => m.id));
            if (!incoming.some((m) => knownIds.has(m.id))) return;
        }
    }
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
export type PendingPluginRegister = { conversationId: string; agent: string; ts: number; parentConversationId?: string };

/** Runtime-info protocol entry (#955): what the client's OWN config says it
 *  will run — reported at plugin bootstrap and on model switch, before (and
 *  independent of) any model request. Ranked in the native-window chain
 *  directly under the per-request header report; entries carry their model
 *  id and the table is only consulted when that id matches the request's
 *  model (a stale post-switch entry must never size a different model). */
export type PluginRuntimeInfo = {
    agent: string;
    model: string;
    contextWindow?: number;
    maxOutput?: number;
    baseURL?: string;
    source: string;
    ts: number;
};

const pluginRuntimeTable = new Map<string, PluginRuntimeInfo>();
const MAX_PLUGIN_RUNTIME_ENTRIES = 32;

export function recordPluginRuntimeInfo(entry: PluginRuntimeInfo): void {
    pluginRuntimeTable.delete(entry.agent);
    pluginRuntimeTable.set(entry.agent, entry);
    while (pluginRuntimeTable.size > MAX_PLUGIN_RUNTIME_ENTRIES) {
        const oldest = pluginRuntimeTable.keys().next().value;
        if (oldest === undefined) break;
        pluginRuntimeTable.delete(oldest);
    }
}

/** Latest runtime-info for an agent, usable for `model` only (undefined =
 *  no report, or a report for a different model). */
export function pluginRuntimeInfoFor(agent: string | undefined, model: string | undefined): PluginRuntimeInfo | undefined {
    if (agent === undefined || model === undefined) return undefined;
    const entry = pluginRuntimeTable.get(agent);
    if (entry === undefined || entry.model !== model) return undefined;
    return entry;
}

/** Accept the bootstrap/model-switch report. Body:
 *  { agent, model, contextWindow?, maxOutput?, baseURL?, source?,
 *    conversationId? } — agent+model are required; numbers are validated.
 *  Loopback-gated like every /__bili/plugin/* endpoint (the route lives
 *  under the same admin gate in server.ts). */
export function handlePluginRuntimeInfo(payload: string, res: import("node:http").ServerResponse): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(payload);
    } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
        return;
    }
    const body = parsed as { agent?: unknown; model?: unknown; contextWindow?: unknown; maxOutput?: unknown; baseURL?: unknown; source?: unknown };
    const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
    const agent = str(body.agent, 64);
    const model = str(body.model, 256);
    if (agent === undefined || model === undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "agent and model are required" }));
        return;
    }
    recordPluginRuntimeInfo({
        agent,
        model,
        contextWindow: num(body.contextWindow),
        maxOutput: num(body.maxOutput),
        baseURL: str(body.baseURL, 2048),
        source: str(body.source, 64) ?? "client-config",
        ts: Date.now(),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
}

const MAX_PENDING_REGISTERS = 64;

const pendingRegisters: PendingPluginRegister[] = [];

/** Queue a launcher-mode registration. `identity: true` means the host puts
 *  the SAME id on every model request (claude code: x-claude-code-session-id
 *  === CLAUDE_CODE_SESSION_ID) — bind by identity match only. `identity:
 *  false` (headless codex spawn) means requests carry no matching id — bind
 *  the next NEW session instead. Splitting the two keeps a foreign session
 *  from eating an identity registration it can never claim. */
export function queuePluginRegister(conversationId: string, agent: string, identity: boolean, parentConversationId?: string): void {
    if (!identity) {
        for (let i = 0; i < pendingRegisters.length; i++) {
            if (pendingRegisters[i]!.conversationId === conversationId) {
                pendingRegisters.splice(i, 1);
                break;
            }
        }
        pendingRegisters.push({ conversationId, agent, ts: Date.now(), ...(parentConversationId ? { parentConversationId } : {}) });
        while (pendingRegisters.length > MAX_PENDING_REGISTERS) pendingRegisters.shift();
    } else {
        registeredIds.set(conversationId, { agent, ...(parentConversationId ? { parentConversationId } : {}) });
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
const registeredIds = new Map<string, { agent: string; parentConversationId?: string }>();

/** Identity-driven binding (#162): hosts whose model requests carry the SAME
 *  id the MCP shell registered (claude code: every request has
 *  x-claude-code-session-id === CLAUDE_CODE_SESSION_ID === the registered
 *  conversation id) bind the moment any of their requests shows up — no
 *  ordering race with the shell's initialize. */
export function consumePluginRegisterFor(conversationId: string): { agent: string; parentConversationId?: string } | undefined {
    const entry = registeredIds.get(conversationId);
    if (entry !== undefined) {
        // The registration describes the CONVERSATION, not a one-shot token:
        // switching models/upstreams mid-conversation resolves to a NEW
        // session (session key = protocol|upstream|apiKey|conversation) that
        // must still bind — omp TUI flows that switch models would otherwise
        // drop back to wire mode on every switch. Keep the entry and refresh
        // LRU order so the size cap evicts least-recently-active conversations.
        registeredIds.delete(conversationId);
        registeredIds.set(conversationId, entry);
    }
    return entry;
}

export function handlePluginRegister(payload: string, res: import("node:http").ServerResponse): void {
    let parsed: { conversationId?: unknown; agent?: unknown; identity?: unknown; parentConversationId?: unknown };
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
    // [#1333] optional declared derivation (pi RLM child): the parent
    // conversation the proxy should seed this conversation from.
    let parentConversationId = typeof parsed.parentConversationId === "string" ? parsed.parentConversationId.trim() : "";
    if (parentConversationId === conversationId) parentConversationId = "";
    queuePluginRegister(conversationId, agent, parsed.identity === true, parentConversationId || undefined);
    res.end(JSON.stringify({ ok: true, conversationId, agent }));
}

export function handlePluginCompact(payload: string, res: import("node:http").ServerResponse): void {
    let parsed: { conversationId?: unknown };
    try {
        parsed = JSON.parse(payload) as { conversationId?: unknown };
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
    const { session, entry } = resolveConversation(conversationId);
    // #760: the verbatim-id fallback above can resolve a session with NO map
    // entry (first call), so only the session itself gates execution.
    if (!session) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({
            ok: false,
            error: entry
                ? `unknown plugin conversation id "${conversationId}" (id registered but session not resident)`
                : `unknown plugin conversation id "${conversationId}" (no model request has arrived with this conversation id yet)`,
        }));
        return;
    }
    markCompactionBoundary(session);
    if (entry) entry.lastSeen = Date.now();
    res.end(JSON.stringify({ ok: true, conversationId }));
}

// #760: per-call conversation_id for MCP tools. Hosts that share ONE shim
// process across several concurrent conversations have no env/meta session
// channel, so the model supplies the target conversation per call (the proxy
// prints its own session id in the wire notes). The param is added to CLONED
// schemas only — wire-mode injection serves the kernel constants directly and
// those models are routed by request identity, not arguments.
const CONVERSATION_ID_PARAM = {
    type: "string" as const,
    description:
        "Your bili conversation id (the value from the 'your bili conversation id' line in the proxy notes). " +
        "Pass it on every call when your host shares one MCP process across several concurrent conversations; " +
        "omit it when the host bound the session itself.",
};

function withConversationIdParam(tool: unknown): unknown {
    const copy = structuredClone(tool);
    if (!copy || typeof copy !== "object") return copy;
    const t = copy as Record<string, unknown>;
    const add = (schema: unknown): void => {
        if (!schema || typeof schema !== "object") return;
        const s = schema as { properties?: Record<string, unknown> };
        s.properties = { ...(s.properties ?? {}), conversation_id: CONVERSATION_ID_PARAM };
    };
    if (t.input_schema !== undefined) add(t.input_schema);
    else {
        const fn = t.function;
        if (fn && typeof fn === "object") add((fn as { parameters?: unknown }).parameters);
        else add(t.parameters);
    }
    return copy;
}

// #841: search_context's conversation_id doubles as a cross-session read-only
// search target — widen that one entry's param description beyond the shared
// routing text (same wording the wire-mode BILI_ constants serve).
function withSearchContextConversationDescription(tools: unknown[]): unknown[] {
    return tools.map((tool) => {
        const t = tool as Record<string, unknown> | null | undefined;
        if (!t || typeof t !== "object") return tool;
        const fn = t.function as { name?: unknown } | undefined;
        const name = typeof t.name === "string" ? t.name : (fn && typeof fn.name === "string" ? fn.name : undefined);
        if (name !== SEARCH_CONTEXT_TOOL_NAME) return tool;
        const copy = structuredClone(t) as Record<string, unknown>;
        const cfn = copy.function as { parameters?: unknown } | undefined;
        const schema = (copy.input_schema ?? cfn?.parameters ?? copy.parameters) as { properties?: Record<string, unknown> } | undefined;
        const props = schema?.properties;
        const param = props?.conversation_id;
        if (!props || !param || typeof param !== "object") return tool;
        props.conversation_id = { ...(param as Record<string, unknown>), ...SEARCH_CONTEXT_CONVERSATION_ID_PARAM };
        return copy;
    });
}

export function handlePluginManifest(res: import("node:http").ServerResponse, config: Config): void {
    // #1192: hosts register whatever the manifest serves verbatim (pi/omp/dsh/
    // opencode native plugins, MCP shims), so advertising an opt-in tool this
    // proxy's config leaves disabled guarantees a rejected call the moment the
    // model uses it. Advertise absorb/acp_rule only when base-config enabled;
    // per-request provider/model overrides may still differ (conservative: the
    // manifest never advertises what the base config disables) and per-session
    // enablement stays enforced at execution (isProxyToolFor / executeProxyTool).
    // #1359: the advertised name is the base-config toolName, matching the
    // plugin-lane gate (which adjudicates the same base block).
    const absorbOn = absorbEnabled(config);
    const absorbName = config.absorb?.toolName ?? ABSORB_TOOL_NAME;
    const absorbTools = absorbOn ? absorbToolsFor(absorbName) : undefined;
    const rulesOn = rulesEnabled(config);
    // [#1271] acp_retrieve is advertised only while the base config enables CCR (same
    // #1192 conservative rule as absorb/acp_rule). The proxy wires it on the anthropic/
    // openai lanes in plugin mode; the responses wire is deliberately NOT advertised —
    // that proxy disarms CCR there, so advertising would break #1192.
    const ccrOn = config.ccr?.enabled === true;
    const ccrName = config.ccr?.toolName ?? RETRIEVE_TOOL_NAME;
    const ccrTools = ccrOn ? retrieveToolsFor(ccrName) : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        ok: true,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        proxy: "billion-context",
        version: VERSION,
        toolNames: [...PROXY_TOOL_NAMES, ...(absorbTools ? [absorbName] : []), ...(rulesOn ? [RULE_TOOL_NAME] : []), ...(ccrOn ? [ccrName] : [])],
        tools: {
            anthropic: withSearchContextConversationDescription([...BILI_ACP_TOOLS_ANTHROPIC, ...(absorbTools ? [absorbTools.anthropic] : []), ...(rulesOn ? [RULE_TOOL] : []), ...(ccrTools ? [ccrTools.anthropic] : [])].map(withConversationIdParam)),
            openai: withSearchContextConversationDescription([...BILI_ACP_TOOLS_OPENAI, ...(absorbTools ? [absorbTools.openai] : []), ...(rulesOn ? [RULE_TOOL_OPENAI] : []), ...(ccrTools ? [ccrTools.openai] : [])].map(withConversationIdParam)),
            responses: withSearchContextConversationDescription([...BILI_ACP_TOOLS_RESPONSES, ...(absorbTools ? [absorbTools.responses] : []), ...(rulesOn ? [RULE_TOOL_RESPONSES] : [])].map(withConversationIdParam)),
        },
        headers: { agent: PLUGIN_AGENT_HEADER, conversation: PLUGIN_CONVERSATION_HEADER, contextWindow: PLUGIN_CONTEXT_WINDOW_HEADER, maxOutput: PLUGIN_MAX_OUTPUT_HEADER, model: PLUGIN_MODEL_HEADER, instructionsMutable: PLUGIN_INSTRUCTIONS_MUTABLE_HEADER },
        toolEndpoint: "/__bili/plugin/tool",
        statusEndpoint: "/__bili/plugin/status",
        runtimeInfoEndpoint: "/__bili/plugin/runtime-info",
    }));
}

export type PluginToolDeps = {
    core: CompressionCore;
    config: Config;
    log: (level: string, msg: string) => void;
};

/** Reverse-lookup the conversation id bound to a session id. #656: the
 *  status endpoint's fallback branch picks the latest active SESSION, but a
 *  caller that needs to ADOPT it (an MCP shim whose captured conversation id
 *  went stale after the host resumed) must be told the session's conversation
 *  id, not have its own stale id echoed back. Most-recently-seen binding wins
 *  when several conversations share one session. */
function conversationIdForSession(sessionId: string): string | undefined {
    let bestId: string | undefined;
    let bestSeen = -Infinity;
    for (const [cid, entry] of conversations) {
        if (entry.sessionId === sessionId && entry.lastSeen > bestSeen) {
            bestId = cid;
            bestSeen = entry.lastSeen;
        }
    }
    return bestId;
}

/** Resolve a caller-supplied conversation id to a resident session through every
 *  known channel, in precedence order: (1) the persisted conversation→session map
 *  (plugin binding / prior calls), (2) the verbatim session id (#760 — the id IS
 *  the client-provided conversation value), (3) the proxy-derived canonical pfa-*
 *  alias (#760b — every session exposes a stable canonical id the model echoes
 *  back from the wire notes). Paths 2/3 record the resolved mapping so later
 *  calls hit path 1 directly. Read-only w.r.t. creation: an unknown id finds
 *  nothing and creates nothing. */
export function resolveConversation(conversationId: string): { session: Session | undefined; entry?: ConversationEntry } {
    const entry = conversations.get(conversationId);
    let session = entry ? peekSession(entry.sessionId) : undefined;
    if (!session) {
        session = peekSession(conversationId) ?? findSessionByCanonicalId(conversationId);
        if (session) recordPluginSession(conversationId, session.id);
    }
    return { session, entry };
}

/** #1192: model-facing explanation for an opt-in tool the host registered but
 *  this session's effective config has disabled. Returns undefined when the
 *  name is not one of the known opt-in tools (a truly unknown tool keeps the
 *  generic 400 with its allowed list). */
function disabledOptionalToolNote(tool: string, session: Session, config: Config): string | undefined {
    const absorbName = effectiveAbsorbConfig(session, config)?.toolName ?? ABSORB_TOOL_NAME;
    if (tool === absorbName) return `${tool} is not enabled on this bili proxy (compress.absorb.enabled is not true) — nothing was absorbed.`;
    if (tool === RULE_TOOL_NAME) return `${tool} is not enabled on this bili proxy (compress.rules.enabled is not true) — nothing was recorded.`;
    if (!ccrEnabled(session) && tool === retrieveToolName(session)) return `${tool} is not enabled on this bili proxy (compress.ccr.enabled is not true) — nothing was retrieved.`;
    return undefined;
}

/** Context-level visibility for plugin UIs (status bars / slash commands):
 *  the same usage the nudge decision sees, keyed by conversation id. */
// #1218: last chain/content-fallback verdict per conversation. A session
// judged an external chain is passed through WITHOUT creating local state,
// so /acp's no-session answer must be able to say WHY there is no session
// instead of the misleading armed-idle notice. Keyed by the conversation id
// the request carried (client header value or anonymous pfa id); `at` is
// refreshed on every passthrough; bounded FIFO like the warn-once set it
// replaces (server.ts).
export interface ChainVerdict {
    at: number;
    kind: string;
    protocol: string;
}
const chainVerdicts = new Map<string, ChainVerdict>();
export const WARNED_CHAIN_SESSION_CAP = 4096;
/** Records a passthrough verdict; returns true when this is the FIRST verdict
 *  for the session (drives the once-per-session [chain] warn in server.ts). */
export function recordChainVerdict(sessionId: string, kind: string, protocol: string): boolean {
    const first = !chainVerdicts.has(sessionId);
    chainVerdicts.set(sessionId, { at: Date.now(), kind, protocol });
    if (chainVerdicts.size > WARNED_CHAIN_SESSION_CAP) {
        chainVerdicts.delete(chainVerdicts.keys().next().value as string);
    }
    return first;
}
export function chainVerdictFor(conversationId: string): ChainVerdict | undefined {
    return chainVerdicts.get(conversationId);
}
export function _resetChainVerdictsForTest(): void {
    chainVerdicts.clear();
}
export function _chainVerdictMapForTest(): Map<string, ChainVerdict> {
    return chainVerdicts;
}

/** #1218: the /acp panel rendered when a conversation is being passed through
 *  unprocessed. Every /acp surface (pi / dsh / opencode) displays `panel`
 *  verbatim, so the server renders the verdict once and all clients show it
 *  without agent-side changes. */
function chainPassthroughPanel(v: ChainVerdict): string {
    return `⚠️ billion-context: this conversation is being PASSED THROUGH UNPROCESSED — judged an external bili chain by the content fallback (evidence: ${v.kind}, protocol ${v.protocol}). No local compression session exists, so compression is silently disabled for this conversation. Last passthrough: ${new Date(v.at).toISOString()}. If this is your own client, disable the content fallback (chainContentDetection=false, env BILI_CHAIN_CONTENT=0); see the [chain] warn in the bili log.`;
}

export function handlePluginStatus(conversationId: string, res: import("node:http").ServerResponse, deps: PluginToolDeps, fallbackLatest = false): void {
    const { session: resolvedSession, entry } = resolveConversation(conversationId);
    let session = resolvedSession;
    let viaFallback = false;
    let resolvedConversationId = conversationId;
    if (!session && fallbackLatest) {
        // #404: only sessions with real activity in THIS process qualify.
        // Before the fix every boot-restored session carried lastSeen =
        // restore time, so a 245-way tie resolved by insertion (readdir)
        // order and could attach a fresh client to an unrelated old session.
        const latest = listSessions()
            .filter((s) => s.restored !== true)
            .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0];
        if (latest) {
            session = latest;
            viaFallback = true;
            // #656: name the conversation that was actually resolved — the
            // caller asked with a stale id and must learn the real one.
            resolvedConversationId = conversationIdForSession(latest.id) ?? conversationId;
        }
    }
    if (!session) {
        // #1218: a chain/content-fallback verdict for THIS conversation means
        // requests ARE arriving — passed through unprocessed — so the
        // armed-idle notice would mislead ("no model request yet" is false).
        // Answer 200 with a renderable panel; `phase` exposes the state for
        // programmatic consumers.
        const verdict = chainVerdictFor(conversationId);
        if (verdict !== undefined) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, conversationId, phase: "chain-passthrough", chain: verdict, panel: chainPassthroughPanel(verdict) }));
            return;
        }
        // Runtime-info protocol (#955): no session exists yet, but the client
        // may have reported its model config at bootstrap — answer from the
        // agent-keyed runtime table so /acp works pre-first-request. Clients
        // without a stable conversation id before their first request probe
        // with their agent name (dsh's fetchStatusLatest sends "dsh").
        const pre = pluginRuntimeTable.get(conversationId);
        if (pre !== undefined) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, conversationId, phase: "pre-first-request", model: pre.model, contextLimit: pre.contextWindow ?? null, runtimeInfo: pre, panel: null }));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: fallbackLatest ? "no session with activity since boot — issue a model request or pass the conversation id" : "unknown plugin conversation" }));
        return;
    }
    if (entry) entry.lastSeen = Date.now();
    const limit = session.metadata.effectiveContextLimit;
    const mem = remembered.get(session.id);
    const modelContextLimit = typeof limit === "number" && limit > 0 ? limit : 0;
    // #387: the remembered nudge is a prepare-time snapshot. A compress tool
    // executed after the last model request mutates state without re-running
    // prepare, so that snapshot would list already-compressed refs as
    // compressible next to the new blocks (stale ranges + live blocks in one
    // panel). Recompute from live state on every status read — same pattern
    // as acp_status; on failure omit the nudge/ranges sections instead of
    // serving the stale snapshot.
    let nudge: NudgeDecision | undefined;
    try {
        const messages = mem ? (mem.processed.length > 0 ? mem.processed : mem.original) : [];
        if (messages.length > 0) {
            // #833: base kernelConfig carries no file/provider/model compress
            // settings — render from the session's last resolved Config so the
            // panel matches actual injection behavior.
            const pluginCfg = effectiveConfig(session, deps.config);
            nudge = deps.core.processTurn({
                messages,
                state: session.state,
                config: ccrLoopConfig(session, pluginCfg),
                tokenCount: session.stats.lastInputTokens,
                renderTags: "none",
                contentStore: contentStoreOf(session),
            }).nudge;
        }
    } catch {
        nudge = undefined;
    }
    let panel: string | undefined;
    try {
        // #532: the kernel breakdown classifies messages only; bili measured
        // the outbound system+tools overhead at prepare time (same source as
        // estimateInputTokens) and stored it on the session. Feeding it in is
        // what makes Sent/SysPrompt reflect reality instead of undercounting
        // by the full system+tools size every turn. unprunedTokens gets the
        // same addition so the Session-only derivation (unpruned − sent) still
        // isolates pruned originals on one scale.
        const sysTokRaw = session.metadata.systemPromptTokens;
        const systemPromptTokens = typeof sysTokRaw === "number" && Number.isFinite(sysTokRaw) && sysTokRaw > 0 ? sysTokRaw : 0;
        panel = buildStatusPanel({
            version: `billion-context@${PROXY_VERSION} · pack: ${session.meta.activePack ?? "default"}`,
            tokenCount: session.stats.lastInputTokens,
            systemPromptTokens,
            state: session.state,
            nudge,
            modelContextLimit,
            // #1320: countMessageTokens includes host-projected thinking mass
            // (signature-only blocks) on the same scale as the breakdown rows.
            unprunedTokens: mem && mem.original.length > 0
                ? mem.original.reduce((sum, m) => sum + countMessageTokens(m), 0) + systemPromptTokens
                : undefined,
        });
    } catch {
        panel = undefined;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        ok: true,
        conversationId: resolvedConversationId,
        fallback: viaFallback || undefined,
        label: session.meta.label ?? null,
        pluginAgent: session.metadata.pluginAgent ?? null,
        model: session.metadata.lastModel ?? null,
        windowSource: session.metadata.lastWindowSource ?? null,
        runtimeInfo: pluginRuntimeInfoFor(typeof session.metadata.pluginAgent === "string" ? session.metadata.pluginAgent : undefined, typeof session.metadata.lastModel === "string" ? session.metadata.lastModel : undefined) ?? null,
        contextLimit: typeof limit === "number" ? limit : null,
        contextTokens: session.stats.lastInputTokens,
        inputTokens: session.stats.inputTokens,
        outputTokens: session.stats.outputTokens,
        cachedTokens: session.stats.cachedTokens,
        requests: session.stats.requests,
        blocks: session.state.blocks.map((b) => ({ id: b.blockId, tier: b.tier, active: b.active })),
        panel,
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
    const { session, entry } = resolveConversation(conversationId);
    // #760: the verbatim-id fallback above can resolve a session with NO map
    // entry (first call), so only the session itself gates execution.
    if (!session) {
        // #656: two distinct failures shared one message before. An id that was
        // NEVER registered is the classic stale-shim-id case (host resumed its
        // session after the MCP shim captured CLAUDE_CODE_SESSION_ID) — say so,
        // and log it: these 404s used to be invisible in bili.log.
        if (!entry) {
            // #1158: a tool call implies the model ALREADY answered, yet no model
            // request ever carried this conversation id — its traffic never reached
            // this proxy at all. The exact cause is still under investigation with
            // runtime evidence (candidates: the LLM transport bypasses the
            // intercepted fetch via an SDK-injected fetch / non-global dispatcher,
            // a host-side attribution gap leaves the traffic unclaimed by the
            // takeover gate, or the id went stale after a host resume). Whatever
            // it is, it was silently unselfable before; the first hit now leaves
            // an actionable trace, and the trace names no single confirmed cause.
            if (!warnedNoModelRequests.has(conversationId)) {
                if (warnedNoModelRequests.size >= WARNED_NO_MODEL_REQUESTS_CAP) warnedNoModelRequests.clear();
                warnedNoModelRequests.add(conversationId);
                deps.log("warn", `[plugin] NO MODEL REQUESTS seen for conversation ${conversationId} (tool "${tool}"): the model answered without any of its requests reaching this proxy — candidates: its LLM transport bypasses the intercepted fetch (SDK-injected fetch or non-global dispatcher), the host's attribution left this traffic unclaimed by the proxy, or the conversation id is stale after a host resume. Verify: send a message and look for processTurn lines in bili.log — none appearing means the traffic never reaches the proxy; routing through the client's bili launcher (baseURL rewrite) reaches it regardless of which fetch the transport uses.`);
            }
        } else {
            deps.log("warn", `[plugin] tool "${tool}" rejected for conversation ${conversationId}: id registered but session not resident in this proxy instance`);
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({
            ok: false,
            error: !entry
                ? "unknown plugin conversation (no model request has arrived with this conversation id yet — if your messages ARE still reaching the model, its LLM transport may be bypassing this proxy's fetch interception (SDK-injected fetch / non-global dispatcher), the host's attribution may have left this traffic unclaimed by the proxy, or the id may be stale after a host resume; check bili.log for processTurn lines)"
                : "unknown plugin conversation (id registered but its session is not resident in this proxy instance — a fresh model request re-binds it)",
        }));
        return;
    }
    // Absorb/rules enablement is per-session (last resolved config), so the
    // gate needs the session — it runs after the lookup above.
    if (!isProxyToolFor(tool, session, deps.config)) {
        // #1192: a known opt-in tool disabled by this session's effective config
        // (registered from a manifest served while it was enabled) answers with
        // model-facing text on the same channel executeRule/executeAbsorb use
        // for failures — a hard 400 would surface as an unfixable red error card.
        const note = disabledOptionalToolNote(tool, session, deps.config);
        if (note !== undefined) {
            deps.log("info", `[${session.id}] [plugin] ${tool} called but disabled — replied with explanation`);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, result: note }));
            return;
        }
        const allowed = [...PROXY_TOOL_NAMES];
        const absorb = effectiveAbsorbConfig(session, deps.config);
        if (absorb?.enabled === true) allowed.push(absorb.toolName ?? ABSORB_TOOL_NAME);
        if (effectiveRulesConfig(session, deps.config)?.enabled === true) allowed.push(RULE_TOOL_NAME);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `unknown tool "${tool}" (expected one of: ${allowed.join(", ")})` }));
        return;
    }
    if (entry) entry.lastSeen = Date.now();
    const args = parsed.args && typeof parsed.args === "object" ? { ...(parsed.args as Record<string, unknown>) } : {};
    // #760: the MCP manifest advertises an optional conversation_id argument
    // for per-call routing; routing itself uses the body-level conversationId
    // field, so strip it before kernel arg parsing sees it.
    delete args.conversation_id;
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
                // #833: run proxy tools under the session's last resolved Config
                // (same values the wire path used), not the base kernelConfig.
                config: effectiveConfig(session, deps.config),
                messages,
                session,
                log: (m) => deps.log("info", `[${session.id}] [plugin] ${m}`),
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
    // #760b: evidence-based plugin-mode flip. A successful MCP tool execution proves
    // this session's host owns the bili compression tools, so bind it to plugin mode
    // (sticky) — the next model request stops injecting the duplicate ephemeral wire
    // tools. Guarded: only flips a session with NO existing agent binding, never
    // overriding a pi/omp/opencode plugin or a launcher-registered agent.
    if (typeof session.metadata.pluginAgent !== "string") {
        session.metadata.pluginAgent = "mcp";
    }
    markDirty(session);
    deps.log("info", `[${session.id}] [plugin] tool ${tool} executed via plugin (${result.length} chars)`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, tool, conversationId, result }));
}

// creationTokens = Anthropic cache-write segment (cache_creation_input_tokens):
// part of the context size, but NOT a cache hit (#790).
type UsageSample = { inputTokens?: number; cachedTokens?: number; outputTokens?: number; creationTokens?: number };

function num(v: unknown): number | undefined {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Gemini reports usage in a top-level `usageMetadata` object — identically on
 *  an SSE chunk and on a non-streaming body: `promptTokenCount` is the whole
 *  context (the `cachedContentTokenCount` prefix included) and thinking tokens
 *  are billed ON TOP of the candidate's, so both count as output. */
function googleUsageSample(obj: Record<string, unknown>): UsageSample | undefined {
    const meta = obj["usageMetadata"];
    if (!meta || typeof meta !== "object") return undefined;
    const u = meta as Record<string, unknown>;
    const cand = num(u["candidatesTokenCount"]);
    const thoughts = num(u["thoughtsTokenCount"]);
    return {
        inputTokens: num(u["promptTokenCount"]),
        outputTokens: cand === undefined && thoughts === undefined ? undefined : (cand ?? 0) + (thoughts ?? 0),
        cachedTokens: num(u["cachedContentTokenCount"]),
    };
}

function usageFromSseEvent(obj: Record<string, unknown>): UsageSample | undefined {
    const type = obj["type"];
    if (type === "message_start") {
        const usage = (obj["message"] as Record<string, unknown> | undefined)?.["usage"] as Record<string, unknown> | undefined;
        if (!usage) return undefined;
        // Per-field snapshot (#790): a zero is a real value here (a fully
        // cache-hit turn reports input_tokens: 0), so record whatever is
        // present and let later events overwrite field by field.
        const sample: UsageSample = {};
        const input = num(usage["input_tokens"]);
        if (input !== undefined) sample.inputTokens = input;
        const read = num(usage["cache_read_input_tokens"]);
        if (read !== undefined) sample.cachedTokens = read;
        const creation = num(usage["cache_creation_input_tokens"]);
        if (creation !== undefined) sample.creationTokens = creation;
        return Object.keys(sample).length > 0 ? sample : undefined;
    }
    if (type === "message_delta") {
        const usage = obj["usage"] as Record<string, unknown> | undefined;
        if (!usage) return undefined;
        // Some relays echo `input_tokens: 0` in message_delta (the field is
        // normally absent — message_start is authoritative for the input size,
        // which is fixed within a turn). A 0 here is never a legitimate new
        // value; merging it would zero out acc.inputTokens (set by message_start)
        // and collapse lastInputTokens to the cached portion only. The same
        // guard covers the cache segments (#790): a zeroed echo must not
        // clobber real values carried from message_start.
        const input = num(usage["input_tokens"]);
        const read = num(usage["cache_read_input_tokens"]);
        const creation = num(usage["cache_creation_input_tokens"]);
        const sample: UsageSample = {};
        if (input !== undefined && input > 0) sample.inputTokens = input;
        if (read !== undefined && read > 0) sample.cachedTokens = read;
        if (creation !== undefined && creation > 0) sample.creationTokens = creation;
        const output = num(usage["output_tokens"]);
        if (output !== undefined) sample.outputTokens = output;
        return Object.keys(sample).length > 0 ? sample : undefined;
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
    const google = googleUsageSample(obj);
    if (google) return google;
    const usage = obj["usage"] as Record<string, unknown> | undefined;
    if (usage && (num(usage["prompt_tokens"]) !== undefined || num(usage["completion_tokens"]) !== undefined)) {
        return {
            inputTokens: num(usage["prompt_tokens"]),
            outputTokens: num(usage["completion_tokens"]),
            // DeepSeek-style upstreams report KV-cache hits as top-level
            // prompt_cache_hit_tokens instead of the standard details field (#779).
            cachedTokens: num((usage["prompt_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]) ?? num(usage["prompt_cache_hit_tokens"]),
        };
    }
    return undefined;
}

export function applyUsageSample(session: Session, sample: UsageSample, protocol?: WireProtocol): void {
    // inputTokens is protocol-native: Anthropic reports it NEW-only (cached
    // separate); OpenAI/Responses report the TOTAL (cached already included).
    // promptInputTotal adds back every segment not part of inputTokens —
    // cached, plus the Anthropic cache-write segment under split semantics
    // (#408/#790). Cache writes count toward context size, never toward hits.
    const total = sample.inputTokens !== undefined ? promptInputTotal(protocol, sample.inputTokens, sample.cachedTokens, sample.creationTokens) : 0;
    // #793: a zero-total input sample carries no information — every real
    // request has input tokens, so this is a gateway placeholder (message_start
    // 0s) or a relay echo settled before the authoritative usage arrived
    // (typically on client abort mid-stream). Adopting it would clobber the
    // last trusted lastInputTokens with 0 and freeze nudge at 0%.
    if (sample.inputTokens !== undefined && total <= 0) {
        loggerLog("warn", `[${session.id}] [plugin] skipped zero-total usage sample (placeholder/echo) — keeping lastInputTokens=${session.stats.lastInputTokens}`);
    }
    if (sample.cachedTokens !== undefined && total > 0) {
        session.stats.cachedTokens += sample.cachedTokens;
        session.stats.cacheSamples += 1;
    }
    if (sample.inputTokens !== undefined && total > 0) {
        session.stats.inputTokens += total;
        // Net out pending compress savings (see stream.ts applyRanges): plugin
        // compress tool results shrink the next request, not this report.
        session.stats.lastInputTokens = Math.max(0, total - (session.stats.compressCreditTokens ?? 0));
        session.stats.lastInputTokensSource = "usage";
        // #1110: a real usage report retires the one-shot overflow arm.
        delete session.stats.overflowArmTokens;
        warnCacheCollapse(session, total, sample.cachedTokens ?? 0);
        // #695: per-request parity with the wire path's [acp-usage] — without
        // this, post-fold cache cliffs cannot be attributed from logs.
        const hit = sample.cachedTokens === undefined ? undefined : Math.round((100 * (sample.cachedTokens ?? 0)) / total);
        const foldNew = session.stats.pendingFoldUsage === true;
        if (foldNew) session.stats.pendingFoldUsage = false;
        loggerLog("info", `[${session.id}] [plugin] [acp-usage] input=${total} cached=${sample.cachedTokens ?? "n/a"}${hit === undefined ? "" : ` (cache hit ${hit}%)`}${foldNew ? " fold=new" : ""}${imageUsageSuffix(session)}`);
        recordCacheSample(session, { at: Date.now(), input: total, cached: sample.cachedTokens ?? 0, output: sample.outputTokens });
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
    if (sample.creationTokens !== undefined) acc.creationTokens = sample.creationTokens;
    if (sample.outputTokens !== undefined) acc.outputTokens = sample.outputTokens;
}

/** Terminal reasons after which the model genuinely finished its turn. A
 *  refusal or a safety block must never be re-prompted, and a token-capped turn
 *  would only truncate again — so the degenerate-turn retry (#732/#821 for the
 *  plugin pipe) engages on these alone. */
const CLEAN_TURN_REASONS = new Set(["stop", "end_turn", "stop_sequence"]);

const ANTHROPIC_BLOCK_EVENT = /^content_block_(start|delta|stop)$/;

/** Plugin-mode streaming passthrough for the OpenAI chat-completions and
 *  Anthropic wires: forward upstream events byte-identical (the agent's
 *  native tool loop must see the model's tool calls untouched) while (a)
 *  sniffing usage so lastInputTokens keeps tracking reality and (b) running
 *  model prose through the tag-echo state machine — #206 parity with
 *  pipePluginResponsesWithStrip. The verbatim variant let a model-emitted
 *  render tag echo land in the agent's replayed history and amplify into the
 *  "endless blank output" loop observed with pi + qwen (issue #14).
 *
 *  Also serves proxy-mode chat SSE that skipped compress injection (#460:
 *  title-gen exclusion / ACP_NO_INJECT_TOOL / classifier bypass). Pass no
 *  session there — usage accounting must be skipped or a title-gen call's
 *  tiny input_tokens would clobber lastInputTokens and break compression
 *  triggering for the main conversation.
 *
 *  `refetch` supplies the one-shot degenerate-turn retry (#732/#821): when the
 *  turn reaches its terminal with nothing visible — the tag-echo case, where
 *  the filter empties the only text block so the host aborts an empty turn —
 *  the pipe re-issues the request through it and splices the retry's content
 *  into the client stream the first attempt already opened. Omit it for the
 *  plain pass-through. */
export async function pipePluginChatWithStrip(
    stream: ReadableStream<Uint8Array>,
    res: ServerResponse,
    protocol: WireProtocol,
    session?: Session,
    log?: (msg: string) => void,
    refetch?: () => Promise<ReadableStream<Uint8Array> | null>,
): Promise<void> {
    let reader = stream.getReader();
    let decoder = new TextDecoder("utf-8");
    let buf = "";
    const acc: UsageSample = {};
    let sawStrippedEcho = false;
    const onTagDrop = (snippet: string) => {
        droppedTagInFrame = true;
        sawStrippedEcho = true;
        loggerLog("warn", `[tag-echo] stripped model-emitted render tag (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
        log?.(`[tag-echo] stripped model-emitted render tag from plugin passthrough text`);
    };
    const onMarkerDrop = (snippet: string) => {
        sawStrippedEcho = true;
        loggerLog("warn", `[marker-echo] stripped model-emitted ACP confirmation marker (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
        log?.(`[marker-echo] stripped model-emitted ACP confirmation marker from plugin passthrough text`);
    };
    // One state machine per (field, block/choice index) — interleaved choices
    // or content blocks must not share partial-tag state. Tool-call arguments
    // never flow through a stream (#1039): they are forwarded verbatim.
    interface PipeStream {
        filter: TagEchoFilter;
        field: string;
        index: number;
    }
    const streams = new Map<string, PipeStream>();
    const filterFor = (field: string, index: number) => {
        const key = `${field}:${index}`;
        let s = streams.get(key);
        if (!s) {
            s = { filter: composeStreamFilters(createTagEchoFilter(onTagDrop), createMarkerLineFilter(onMarkerDrop)), field, index };
            streams.set(key, s);
        }
        return s;
    };
    const anyPending = () => {
        for (const s of streams.values()) if (s.filter.pending()) return true;
        return false;
    };
    let lastChunkMeta: Record<string, unknown> = {};
    const syntheticTail = (s: PipeStream, tail: string): string => {
        if (protocol === "anthropic") {
            const deltaType = s.field === "thinking" ? "thinking_delta" : "text_delta";
            return `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: s.index, delta: { type: deltaType, [s.field]: tail } })}\n\n`;
        }
        if (protocol === "google") {
            // The tail rides a synthesized candidate chunk. It must REPEAT the
            // finishReason observed so far (lastChunkMeta, set by processGoogle)
            // because the Gemini client throws when the stream's final chunk
            // carries none — flushing a held tail after the finishReason frame
            // would otherwise end the stream reason-less.
            const part = s.field === "thinking" ? { thought: true, text: tail } : { text: tail };
            const candidate = {
                index: s.index,
                content: { role: "model", parts: [part] },
                ...(typeof lastChunkMeta["finishReason"] === "string" ? { finishReason: lastChunkMeta["finishReason"] } : {}),
            };
            const frame = typeof lastChunkMeta["modelVersion"] === "string" ? { modelVersion: lastChunkMeta["modelVersion"], candidates: [candidate] } : { candidates: [candidate] };
            return `data: ${JSON.stringify(frame)}\n\n`;
        }
        return `data: ${JSON.stringify({ ...lastChunkMeta, object: "chat.completion.chunk", choices: [{ index: s.index, delta: { [s.field]: tail } }] })}\n\n`;
    };
    // #673: turn-level observability for degenerate terminal turns.
    let sawToolUse = false;
    let sawThinking = false;
    let visibleTextChars = 0;
    /** Post-filter prose of every attempt, for the once-per-request #361
     *  tool-call-XML warn at stream end (#1368): warn only, never stripped. */
    let proseAcc = "";
    /** Of that text, the chars released from a held markup span (the
     *  unclosed-tag case): markup the filter declined to swallow. A turn whose
     *  only visible output is this is as dead to the host as an empty one. */
    let releasedMarkupChars = 0;
    /** Set while a frame is being rewritten because a render tag was dropped:
     *  the text that survives such a frame is the tag's own interior. */
    let droppedTagInFrame = false;
    let finalFinishReason: string | undefined;
    // Degenerate-turn retry (#732/#821 for this pipe). The first attempt's
    // terminal event is dropped when the retry takes over, so the client sees
    // one turn: its framing stays open, and the retry's content blocks are
    // shifted past the ones already streamed.
    let degenerateRetried = false;
    let inRetry = false;
    let retryIndexOffset = 0;
    let blocksForwarded = 0;
    /** One-shot re-issue when a turn reaches its terminal with nothing visible:
     *  the tag-echo case, where the filter empties the only text block and the
     *  host aborts an empty completed turn. Returns true when the retry stream
     *  took over, in which case the caller drops the terminal event of the
     *  attempt it came from. */
    const retryEmptyTurn = async (reason: string | undefined): Promise<boolean> => {
        if (refetch === undefined) return false;
        // Markup released from a held span carries nothing the host can act on:
        // an unclosed render tag stalls the turn exactly like an empty one.
        if (visibleTextChars > releasedMarkupChars || sawToolUse) return false;
        if (reason === undefined || !CLEAN_TURN_REASONS.has(reason)) return false;
        if (res.destroyed || res.writableEnded) return false;
        if (degenerateRetried) {
            // The retry degenerated too. An empty turn is indistinguishable from a
            // model that produced nothing and the session reads as idle while it is
            // dead, so the client gets an error the host would never surface (#870).
            log?.("[plugin] degenerate terminal turn again after the retry; emitting an in-band error (#870)");
            emitStreamError(res, protocol, "the turn degenerated again after the continuation nudge");
            return true;
        }
        // A turn the model left genuinely bare — no thought, no stripped echo,
        // no released markup — is the upstream's own empty answer, not a stall:
        // re-issuing it double-bills an empty completion (#732/#821 keep the
        // same boundary in the compress loop).
        if (!sawThinking && !sawStrippedEcho && releasedMarkupChars === 0) return false;
        degenerateRetried = true;
        log?.("[plugin] degenerate terminal turn (no usable output); retrying once with a continuation nudge (#732/#821)");
        let next: ReadableStream<Uint8Array> | null = null;
        try {
            next = await refetch();
        } catch (e) {
            log?.(`[plugin] degenerate-terminal retry failed (${e instanceof Error ? e.message : String(e)}); passing the empty turn through`);
            return false;
        }
        if (!next) return false;
        // The turn is NOT over: the retry stream carries its own terminal, and a
        // cut in it must still raise the truncation signal (#721).
        sawTerminal = false;
        finalFinishReason = undefined;
        retryIndexOffset = blocksForwarded;
        inRetry = true;
        // The first attempt's held filter state belongs to text the client never
        // saw (an emptying tag echo): the retry's content is filtered from
        // scratch, so a partial tag there cannot swallow its opening characters.
        streams.clear();
        // The first attempt is terminal and its body is drained; close the
        // reader we are abandoning rather than leaving the socket held.
        try {
            await reader.cancel();
        } catch {
            /* already closed */
        }
        reader = next.getReader();
        decoder = new TextDecoder("utf-8");
        buf = "";
        return true;
    };
    /** While the retry stream feeds the client, the message the FIRST attempt
     *  opened is still open: nothing may re-open it. Returns true when the event
     *  was consumed. */
    const retryFraming = (ev: Record<string, unknown>): boolean => {
        if (!inRetry) return false;
        return ev["type"] === "message_start";
    };
    /** The retry's content blocks must land AFTER the ones the client already
     *  saw. The offset is applied to the serialized payload — a processor with
     *  nothing to strip forwards the original bytes, so rewriting only the parsed
     *  event would leave the client's own index untouched. */
    const offsetRetryIndices = (payload: string): string => {
        if (!inRetry || retryIndexOffset === 0) return payload;
        return payload
            .split("\n")
            .map((line) => {
                if (!line.startsWith("data:")) return line;
                const json = line.slice(5).trim();
                if (!json.startsWith("{")) return line;
                let o: Record<string, unknown>;
                try {
                    o = JSON.parse(json) as Record<string, unknown>;
                } catch {
                    return line;
                }
                if (typeof o["index"] !== "number" || !ANTHROPIC_BLOCK_EVENT.test(String(o["type"]))) return line;
                o["index"] = (o["index"] as number) + retryIndexOffset;
                return `data: ${JSON.stringify(o)}`;
            })
            .join("\n");
    };
    const flushTails = (): string => {
        let out = "";
        for (const s of streams.values()) {
            const tail = s.filter.flush();
            if (tail.length > 0) {
                out += syntheticTail(s, tail);
                proseAcc += tail;
                if (s.field === "content" || s.field === "text") {
                    visibleTextChars += tail.length;
                    releasedMarkupChars += tail.length;
                }
            }
        }
        return out;
    };
    const write = (s: string) => {
        if (res.destroyed || res.writableEnded) return;
        if (!res.write(Buffer.from(s, "utf8"))) {
            return awaitDrain(res);
        }
    };
    // #411: an aborted read (client cancel / upstream cut) must still land the
    // usage sniffed so far — anthropic message_start reports input_tokens
    // before any prose, and dropping it froze lastInputTokens at the previous
    // turn's value, corrupting every later nudge decision.
    const settleUsage = () => {
        if (session && (acc.inputTokens !== undefined || acc.outputTokens !== undefined || acc.cachedTokens !== undefined || acc.creationTokens !== undefined)) {
            applyUsageSample(session, acc, protocol);
            markDirty(session);
        }
    };
    // #498: whether a terminal event ([DONE] / message_stop) was seen. A
    // stream that ends without one was cut mid-flight.
    let sawTerminal = false;
    const maybeWarnDegenerate = () => {
        if (!sawTerminal || res.destroyed || res.writableEnded) return;
        let inputChars = 0;
        let dropped = false;
        for (const s of streams.values()) {
            const st = s.filter.stats();
            inputChars += st.inputChars;
            dropped = dropped || st.dropped;
        }
        const msg = degenerateTurnWarning({
            reason: finalFinishReason,
            terminalReason: protocol === "anthropic" ? "end_turn" : protocol === "google" ? "STOP" : "stop",
            toolCalls: sawToolUse ? 1 : 0,
            text: { inputChars, outputChars: visibleTextChars, dropped },
            sawThinking,
            wire: `plugin-passthrough-${protocol}`,
        });
        if (msg) {
            loggerLog("warn", msg);
            log?.(msg);
        }
    };
    // #1368: parity with the proxy pipe's #361 detector (src/server.ts) — model
    // prose carrying tool-call-shaped XML (a call drafted as literal text) is
    // logged once per request for attribution. Warn only: stripping is
    // forbidden, a shape-based match cannot tell an echo from legitimate prose
    // discussing such markup (#295/#361). Off the per-frame hot path by design.
    const maybeWarnProtocolFragment = () => {
        if (proseAcc.length === 0 || !containsToolCallXmlFragment(proseAcc)) return;
        const who = session ? `[${session.id}] ` : "";
        const msg = `[tag-echo] ${who}plugin passthrough: response text contains tool-call XML fragment (possible tag echo; not stripped)`;
        loggerLog("warn", msg);
        log?.(msg);
    };
    const pushField = (field: string, index: number, text: string): [string, boolean] => {
        const s = filterFor(field, index);
        const clean = s.filter.push(text);
        if (clean.length > 0) proseAcc += clean;
        return [clean, clean !== text];
    };
    const processOpenai = (ev: Record<string, unknown>, rawEvent: string): string => {
        if (typeof ev["id"] === "string" || typeof ev["model"] === "string") {
            lastChunkMeta = { id: ev["id"], created: ev["created"], model: ev["model"] };
        }
        const choices = ev["choices"];
        if (!Array.isArray(choices)) {
            return anyPending() ? flushTails() + rawEvent + "\n\n" : rawEvent + "\n\n";
        }
        let rebuilt: Record<string, unknown> | null = null;
        let droppedText = false;
        let keptText = false;
        let hadText = false;
        for (let ci = 0; ci < choices.length; ci++) {
            const ch = choices[ci] as Record<string, unknown> | null;
            if (ch && typeof ch["finish_reason"] === "string") finalFinishReason = ch["finish_reason"] as string;
            const d = ch?.["delta"];
            if (!d || typeof d !== "object") continue;
            const dd = d as Record<string, unknown>;
            if (dd["tool_calls"] !== undefined) sawToolUse = true;
            // #1039 invariant: tool_calls fragments in this delta are user
            // intent and pass through untouched — only the text fields below
            // are ever stripped (see tag-echo-filter.ts header).
            for (const field of ["content", "reasoning_content", "reasoning"]) {
                const v = dd[field];
                if (typeof v !== "string") continue;
                hadText = true;
                if (field !== "content" && v.length > 0) sawThinking = true;
                if (!mayStartRenderTag(v) && !mayStartMarkerLine(v) && !anyPending()) {
                    if (v.length > 0) {
                        keptText = true;
                        proseAcc += v;
                    }
                    if (field === "content") visibleTextChars += v.length;
                    continue;
                }
                const index = typeof ch?.["index"] === "number" ? ch["index"] : ci;
                const [clean, changed] = pushField(field, index, v);
                if (clean.length === 0) droppedText = true;
                else {
                    keptText = true;
                    if (field === "content") {
                        visibleTextChars += clean.length;
                        // What a dropped tag leaves behind is its own interior: the
                        // host finds no tool call in it and stalls the turn.
                        if (droppedTagInFrame) {
                            releasedMarkupChars += clean.length;
                            droppedTagInFrame = false;
                        }
                    }
                }
                if (changed) {
                    if (!rebuilt) {
                        rebuilt = { ...ev, choices: choices.map((c) => ({ ...(c as Record<string, unknown>), delta: { ...((c as Record<string, unknown>)["delta"] as Record<string, unknown>) } })) };
                    }
                    (rebuilt["choices"] as Record<string, unknown>[])[ci]["delta"] = { ...((rebuilt["choices"] as Record<string, unknown>[])[ci]["delta"] as Record<string, unknown>), [field]: clean };
                }
            }
        }
        if (rebuilt) {
            // Delta carried no visible text after stripping: drop the whole
            // chunk instead of forwarding an empty content delta. Only when
            // EVERY managed text field emptied out — a sibling field with real
            // content must survive (#463).
            if (droppedText && !keptText && !hadTextOtherThanTextFields(rebuilt["choices"])) {
                return "";
            }
            return rebuildEvent(rawEvent, rebuilt);
        }
        if (!hadText && anyPending()) return flushTails() + rawEvent + "\n\n";
        return rawEvent + "\n\n";
    };
    const processAnthropic = (ev: Record<string, unknown>, rawEvent: string): string => {
        if (ev["type"] === "content_block_start") {
            const cb = ev["content_block"] as Record<string, unknown> | undefined;
            const bt = cb && typeof cb === "object" ? cb["type"] : undefined;
            if (bt === "tool_use") sawToolUse = true;
            else if (bt === "thinking" || bt === "redacted_thinking") sawThinking = true;
            return anyPending() ? flushTails() + rawEvent + "\n\n" : rawEvent + "\n\n";
        }
        if (ev["type"] !== "content_block_delta") {
            return anyPending() ? flushTails() + rawEvent + "\n\n" : rawEvent + "\n\n";
        }
        const d = ev["delta"] as Record<string, unknown> | undefined;
        const index = typeof ev["index"] === "number" ? ev["index"] : 0;
        // input_json_delta (tool-call arguments) is deliberately unmanaged:
        // #1039 — argument bytes are user intent, forwarded verbatim.
        const field = d?.["type"] === "thinking_delta" ? "thinking" : d?.["type"] === "text_delta" ? "text" : null;
        if (field === null || typeof d?.[field] !== "string") {
            return rawEvent + "\n\n";
        }
        const raw = d[field] as string;
        if (field === "thinking" && raw.length > 0) sawThinking = true;
        if (!mayStartRenderTag(raw) && !mayStartMarkerLine(raw) && !anyPending()) {
            if (raw.length > 0) proseAcc += raw;
            if (field === "text" && raw.length > 0) visibleTextChars += raw.length;
            return rawEvent + "\n\n";
        }
        const [clean, changed] = pushField(field, index, raw);
        if (!changed) {
            if (field === "text" && raw.length > 0) visibleTextChars += raw.length;
            return rawEvent + "\n\n";
        }
        if (field === "text" && clean.length > 0) {
            visibleTextChars += clean.length;
            if (droppedTagInFrame) {
                releasedMarkupChars += clean.length;
                droppedTagInFrame = false;
            }
        }
        if (clean.length === 0 && Object.keys(d ?? {}).length <= 2) return "";
        return rebuildEvent(rawEvent, { ...ev, delta: { ...d, [field]: clean } });
    };
    /** Tag-echo state machine for the Gemini wire: prose AND reasoning live in
     *  `candidates[*].content.parts[*].text` (a `thought:true` part is the
     *  thinking). Multi-candidate streams and frames interleaving thought/text
     *  parts are handled the way the OpenAI/Anthropic processors handle
     *  choices/content blocks — one filter keyed per (candidate index, field) —
     *  and a `finishReason` chunk is this wire's terminal event. */
    const processGoogle = (ev: Record<string, unknown>, rawEvent: string): string => {
        if (typeof ev["modelVersion"] === "string") lastChunkMeta = { ...lastChunkMeta, modelVersion: ev["modelVersion"] };
        // A top-level `error` object is Gemini's other terminal shape (HTTP-level
        // failures arrive mid-stream too): the client throws on it, so the turn
        // is over and must not also be reported as an upstream truncation.
        if (ev["error"] !== undefined) sawTerminal = true;
        const candidates = ev["candidates"];
        if (!Array.isArray(candidates)) {
            return anyPending() ? flushTails() + rawEvent + "\n\n" : rawEvent + "\n\n";
        }
        let rebuilt: Record<string, unknown> | null = null;
        let droppedText = false;
        let keptText = false;
        let hadText = false;
        for (let ci = 0; ci < candidates.length; ci++) {
            const cand = candidates[ci] as Record<string, unknown> | null;
            if (!cand || typeof cand !== "object") continue;
            if (typeof cand["finishReason"] === "string") {
                // Gemini's terminal event IS this chunk — the client throws when
                // a stream ends without one, so `lastChunkMeta` carries it for
                // the synthetic tail (see syntheticTail).
                finalFinishReason = cand["finishReason"] as string;
                sawTerminal = true;
                lastChunkMeta = { ...lastChunkMeta, finishReason: finalFinishReason };
            }
            const content = cand["content"];
            if (!content || typeof content !== "object") continue;
            const parts = (content as Record<string, unknown>)["parts"];
            if (!Array.isArray(parts)) continue;
            const index = typeof cand["index"] === "number" ? cand["index"] : ci;
            for (let pi = 0; pi < parts.length; pi++) {
                const p = parts[pi] as Record<string, unknown> | null;
                if (!p || typeof p !== "object") continue;
                if (p["functionCall"] !== undefined) sawToolUse = true;
                if (p["thought"] === true) sawThinking = true;
                const raw = p["text"];
                if (typeof raw !== "string") continue;
                hadText = true;
                // A reasoning part streams through the same machine under its own
                // field, so an interleaved thought/text pair in one frame never
                // shares held-back state.
                const field = p["thought"] === true ? "thinking" : "text";
                if (!mayStartRenderTag(raw) && !mayStartMarkerLine(raw) && !anyPending()) {
                    if (raw.length > 0) {
                        keptText = true;
                        proseAcc += raw;
                    }
                    if (field === "text") visibleTextChars += raw.length;
                    continue;
                }
                const [clean, changed] = pushField(field, index, raw);
                if (clean.length === 0) droppedText = true;
                else {
                    keptText = true;
                    if (field === "text") visibleTextChars += clean.length;
                }
                if (changed) {
                    // Deep enough clone of the frame's candidates that the
                    // rebuilt part's text can be replaced without mutating the
                    // parsed event (callers keep `ev` for logs/usage).
                    if (!rebuilt) {
                        rebuilt = {
                            ...ev,
                            candidates: candidates.map((c) => {
                                if (!c || typeof c !== "object") return c;
                                const cand = { ...(c as Record<string, unknown>) };
                                const cont = cand["content"];
                                if (cont && typeof cont === "object" && Array.isArray((cont as Record<string, unknown>)["parts"])) {
                                    const cc = cont as Record<string, unknown>;
                                    cand["content"] = { ...cc, parts: (cc["parts"] as unknown[]).map((q) => (q && typeof q === "object" ? { ...(q as Record<string, unknown>) } : q)) };
                                }
                                return cand;
                            }),
                        };
                    }
                    const rparts = (((rebuilt["candidates"] as Record<string, unknown>[])[ci]["content"] as Record<string, unknown>)["parts"] as Record<string, unknown>[]);
                    rparts[pi] = { ...rparts[pi], text: clean };
                }
            }
        }
        if (rebuilt) {
            // Text carried was entirely stripped away: drop the whole chunk
            // instead of forwarding an empty text part — but only when EVERY
            // managed part emptied out and the frame carries nothing else (a
            // finishReason / functionCall / usageMetadata sibling must survive,
            // the chat processor's #463 rule).
            if (droppedText && !keptText && !googleFrameHasNonText(rebuilt)) return "";
            return rebuildEvent(rawEvent, rebuilt);
        }
        if (!hadText && anyPending()) return flushTails() + rawEvent + "\n\n";
        return rawEvent + "\n\n";
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
                buf = normalizeSseLineEndings(buf + decoder.decode(value, { stream: true }));
                let idx: number;
                while ((idx = buf.indexOf("\n\n")) !== -1) {
                    const rawEvent = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const dataLines = rawEvent.split("\n").filter((l) => l.startsWith("data:"));
                    if (dataLines.length === 0) continue;
                    const jsonStr = dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n").trim();
                    if (!jsonStr) continue;
                    if (jsonStr === "[DONE]") {
                        sawTerminal = true;
                        await write(flushTails() + rawEvent + "\n\n");
                        continue;
                    }
                    let ev: Record<string, unknown>;
                    try {
                        ev = JSON.parse(jsonStr) as Record<string, unknown>;
                    } catch {
                        await write(rawEvent + "\n\n");
                        continue;
                    }
                    if (retryFraming(ev)) continue;
                    if (protocol === "anthropic" && ev["type"] === "content_block_start") blocksForwarded++;
                    if (ev["type"] === "message_stop") sawTerminal = true;
                    if (ev["type"] === "message_delta") {
                        const d = ev["delta"] as Record<string, unknown> | undefined;
                        if (d && typeof d["stop_reason"] === "string") finalFinishReason = d["stop_reason"] as string;
                    }
                    // Each wire declares its terminal on its own event: anthropic on
                    // message_delta's stop_reason, openai on the finish_reason chunk
                    // ([DONE] only closes the stream). Read here so the retry
                    // decision can be taken before that event reaches the client.
                    let turnTerminal: string | undefined;
                    if (protocol === "anthropic" && ev["type"] === "message_delta") turnTerminal = finalFinishReason;
                    else if (protocol === "openai") {
                        const choices = ev["choices"];
                        if (Array.isArray(choices)) {
                            for (const c of choices) {
                                const fr = c && typeof c === "object" ? (c as Record<string, unknown>)["finish_reason"] : undefined;
                                if (typeof fr === "string" && fr.length > 0) {
                                    finalFinishReason = fr;
                                    turnTerminal = fr;
                                }
                            }
                        }
                    }
                    const sample = usageFromSseEvent(ev);
                    if (sample) mergeUsageSample(acc, sample);
                    // #408: backfill the input-side usage so the host anchors on
                    // the uncompressed baseline. Patch `ev` BEFORE the tag-echo
                    // processors run and only rebuild when they return the event
                    // verbatim — otherwise their render-tag stripping is lost.
                    const out = protocol === "anthropic" ? processAnthropic(ev, rawEvent)
                        : protocol === "google" ? processGoogle(ev, rawEvent)
                        : processOpenai(ev, rawEvent);
                    // The gate runs AFTER this event is processed: a coalesced chunk
                    // can carry content AND the finish reason, so its own text has to
                    // count before the turn may be called empty. The event's output is
                    // dropped only when the retry takes the turn over.
                    if (turnTerminal !== undefined && (await retryEmptyTurn(turnTerminal))) continue;
                    if (out.length > 0) await write(offsetRetryIndices(out));
                }
            }
            if (res.destroyed || res.writableEnded) break;
        }
        // #721: upstream EOF without a terminal event must not close the
        // stream bare — the agent would persist the partial turn as complete
        // (the #719 chain). finished=true when a finish reason was delivered:
        // only the trailing terminal byte ([DONE]/message_stop) is missing.
        const truncated = !sawTerminal && !res.destroyed && !res.writableEnded;
        // A dangling partial event left in buf by a mid-event cut would fuse
        // with the next complete frame — SSE joins every data line inside one
        // blank-line-delimited block — corrupting the truncation signal. Drop
        // it when the signal follows: an unterminated event is unparseable by
        // the client anyway (same as the pre-#721 bare end).
        if (!truncated && buf.length > 0 && !res.destroyed && !res.writableEnded) await write(offsetRetryIndices(buf));
        const rest = flushTails();
        if (rest.length > 0 && !res.destroyed && !res.writableEnded) await write(offsetRetryIndices(rest));
        // Settle BEFORE res.end() in the finally below: the client can issue
        // its next request (e.g. /__bili/plugin/status, or the follow-up turn
        // that reads lastInputTokens for the nudge decision) the moment the
        // stream completes, and those must already see this usage.
        settleUsage();
        maybeWarnDegenerate();
        maybeWarnProtocolFragment();
        if (truncated) {
            emitUpstreamTruncation(res, protocol, finalFinishReason !== undefined, log);
            return;
        }
    } catch (e) {
        settleUsage();
        if (res.destroyed || res.writableEnded) {
            log?.("client aborted mid-stream");
            return;
        }
        // #721: upstream read failed while the client is still connected —
        // deliver the in-band truncation signal instead of rethrowing into
        // the top-level handler, which would close the stream bare. Flush
        // held tag tails first so partial prose is never silently lost. The
        // dangling partial event left in buf is dropped (see EOF path above):
        // written raw it would fuse with the signal frame.
        try {
            const rest = flushTails();
            if (rest.length > 0) await write(offsetRetryIndices(rest));
        } catch {
            /* client half-gone; the emission below is best-effort too */
        }
        loggerLog("warn", `[plugin] upstream stream read failed (${protocol}): ${String(e instanceof Error ? e.message : e)} — emitting in-band truncation signal`);
        emitUpstreamTruncation(res, protocol, finalFinishReason !== undefined, log);
        return;
    } finally {
        reader.releaseLock();
        res.end();
    }
}

function hadTextOtherThanTextFields(choices: unknown): boolean {
    if (!Array.isArray(choices)) return true;
    for (const c of choices) {
        if (!c || typeof c !== "object") continue;
        const ch = c as Record<string, unknown>;
        if (typeof ch["finish_reason"] === "string") return true;
        const d = ch["delta"] as Record<string, unknown> | undefined;
        if (!d) continue;
        for (const k of Object.keys(d)) {
            if (k !== "content" && k !== "reasoning_content" && k !== "reasoning") return true;
        }
    }
    return false;
}

/** The Gemini counterpart of hadTextOtherThanTextFields: does a frame whose
 *  text parts were all stripped still carry something the client needs? A
 *  finishReason, a functionCall/functionResponse part, usageMetadata or
 *  promptFeedback keeps the chunk alive; a chunk that only ever held
 *  render-tag echo is dropped whole. */
function googleFrameHasNonText(ev: Record<string, unknown>): boolean {
    if (ev["usageMetadata"] !== undefined || ev["promptFeedback"] !== undefined) return true;
    const candidates = ev["candidates"];
    if (!Array.isArray(candidates)) return true;
    for (const c of candidates) {
        if (!c || typeof c !== "object") continue;
        const cand = c as Record<string, unknown>;
        if (typeof cand["finishReason"] === "string") return true;
        const content = cand["content"];
        const parts = content && typeof content === "object" ? (content as Record<string, unknown>)["parts"] : undefined;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
            if (!p || typeof p !== "object") continue;
            for (const k of Object.keys(p as Record<string, unknown>)) {
                if (k !== "text" && k !== "thought" && k !== "thoughtSignature") return true;
            }
        }
    }
    return false;
}

/**
 * Plugin-mode Responses passthrough with render-tag stripping (#206 parity
 * for VERBATIM plugin streams). In plugin mode the native tool loop owns the
 * tool surface, so function_call events must reach the agent untouched — but
 * the model's *prose* can still echo ACP render tags (observed with omp/
 * qwen: tags flatten into standalone messages, get stamped with refs, replay,
 * and amplify). This pipe keeps every event byte-identical except
 * `response.output_text.delta`, whose delta text streams through the same
 * tag-echo state machine the compress loop uses. A held tail is flushed as a
 * final delta before the first done/completed event so the client's assembled
 * text never loses content.
 *
 *  Also serves proxy-mode Responses SSE that skipped compress injection
 *  (#460, e.g. ACP_NO_INJECT_TOOL). Pass no session there — see
 *  pipePluginChatWithStrip for why usage accounting must be skipped.
 *
 *  #732/#821 parity with pipePluginChatWithStrip: when the turn's completion
 *  reports a clean status with nothing visible — the echoed render tag was the
 *  only thing the model emitted, and the filter emptied it — the agent's own
 *  body is re-issued ONCE with a continuation nudge instead of leaving the host
 *  with an empty completed turn. The retry is reframed onto the ids the client
 *  already holds, so the client still sees one turn. */
export async function pipePluginResponsesWithStrip(
    stream: ReadableStream<Uint8Array>,
    res: ServerResponse,
    session?: Session,
    log?: (msg: string) => void,
    refetch?: () => Promise<ReadableStream<Uint8Array> | null>,
): Promise<void> {
    let reader = stream.getReader();
    let decoder = new TextDecoder("utf-8");
    let buf = "";
    const acc: UsageSample = {};
    const onTagDrop = (snippet: string) => {
        loggerLog("warn", `[tag-echo] stripped model-emitted render tag (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
        log?.(`[tag-echo] stripped model-emitted render tag from plugin passthrough text`);
    };
    const tagFilter = composeStreamFilters(
        createTagEchoFilter(onTagDrop),
        createMarkerLineFilter((snippet) => {
            loggerLog("warn", `[marker-echo] stripped model-emitted ACP confirmation marker (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
            log?.(`[marker-echo] stripped model-emitted ACP confirmation marker from plugin passthrough text`);
        }),
    );
    // #673: turn-level observability for degenerate terminal turns.
    let sawFunctionCall = false;
    let sawReasoning = false;
    /** The model emitted markup the filter stripped (or would strip): proof the
     *  turn produced output, even when none survived to be visible. */
    let sawStrippedEcho = false;
    let responseStatus: string | undefined;
    // Degenerate-turn retry (#732/#821 for this pipe). The first attempt's
    // done-family events are HELD until its completion event decides the turn:
    // released in place on a healthy turn, dropped whole when the retry takes
    // over, so the client sees one turn carrying one set of ids. An opening
    // output_item.added releases them early instead — clients require
    // done(itemN) before added(itemN+1) (#1061) — so by the terminal only the
    // last item's family can still be held.
    let degenerateRetried = false;
    let inRetry = false;
    /** Text the client actually assembled from this attempt's deltas. */
    let visibleTextChars = 0;
    /** Post-filter prose for the once-per-request #361 tool-call-XML warn at
     *  stream end (#1368): warn only, never stripped. */
    let proseAcc = "";
    /** Done-family events held for the attempt in flight. */
    let heldEvents: string[] = [];
    /** Text those held events would hand the client, post-strip. */
    let heldVisibleChars = 0;
    /** The ids the client already holds (first attempt), which the retry's own
     *  created/added events are dropped in favour of. */
    let heldItemId: unknown;
    let heldOutputIndex: unknown;
    let heldResponseId: unknown;
    const write = (s: string): Promise<void> => {
        if (res.destroyed || res.writableEnded) return Promise.resolve();
        if (!res.write(Buffer.from(s, "utf8"))) {
            return awaitDrain(res);
        }
        return Promise.resolve();
    };
    // #411: keep the usage sniffed before an abort (see
    // pipePluginChatWithStrip).
    const settleUsage = () => {
        if (session && (acc.inputTokens !== undefined || acc.outputTokens !== undefined || acc.cachedTokens !== undefined)) {
            applyUsageSample(session, acc, "responses");
            markDirty(session);
        }
    };
    // #498: whether a terminal event (done-family / [DONE]) was seen. A
    // stream that ends without one was cut mid-flight.
    let sawTerminal = false;
    const maybeWarnDegenerate = () => {
        if (!sawTerminal || res.destroyed || res.writableEnded) return;
        const st = tagFilter.stats();
        const msg = degenerateTurnWarning({
            reason: responseStatus,
            terminalReason: "completed",
            toolCalls: sawFunctionCall ? 1 : 0,
            text: st,
            sawThinking: sawReasoning,
            wire: "plugin-passthrough-responses",
        });
        if (msg) {
            loggerLog("warn", msg);
            log?.(msg);
        }
    };
    // #1368: once-per-request #361 detector for the Responses pipe — see the
    // chat-pipe twin above for the warn-only rationale (#295/#361).
    const maybeWarnProtocolFragment = () => {
        if (proseAcc.length === 0 || !containsToolCallXmlFragment(proseAcc)) return;
        const who = session ? `[${session.id}] ` : "";
        const msg = `[tag-echo] ${who}plugin passthrough: response text contains tool-call XML fragment (possible tag echo; not stripped)`;
        loggerLog("warn", msg);
        log?.(msg);
    };
    let lastDeltaMeta: { item_id?: unknown; output_index?: unknown } | null = null;
    const flushTail = (after: string) => {
        const tail = tagFilter.flush();
        if (tail.length > 0) {
            visibleTextChars += tail.length;
            const meta = inRetry && heldItemId !== undefined ? { item_id: heldItemId, output_index: heldOutputIndex } : (lastDeltaMeta ?? {});
            return `data: ${JSON.stringify({ type: "response.output_text.delta", ...meta, delta: tail })}\n\n` + after;
        }
        return after;
    };
    /** Visible (post-strip) text a done-family event carries — what the client
     *  would assemble from it. It decides the turn's degeneracy together with
     *  the deltas already forwarded. */
    const responsesEventText = (ev: Record<string, unknown>): string => {
        let text = typeof ev["text"] === "string" ? (ev["text"] as string) : "";
        const part = ev["part"];
        if (part && typeof part === "object" && typeof (part as Record<string, unknown>)["text"] === "string") {
            text += (part as Record<string, unknown>)["text"] as string;
        }
        const item = ev["item"];
        const content = item && typeof item === "object" ? (item as Record<string, unknown>)["content"] : undefined;
        if (Array.isArray(content)) {
            for (const c of content) {
                if (c && typeof c === "object" && typeof (c as Record<string, unknown>)["text"] === "string") {
                    text += (c as Record<string, unknown>)["text"] as string;
                }
            }
        }
        return text;
    };
    /** Whether a serialized event must be rebuilt rather than forwarded: the
     *  retry's ids are rewritten in the parsed event, and a processor with
     *  nothing to strip forwards the original bytes, which would leave them
     *  untouched. */
    const retryRewritePending = (): boolean =>
        inRetry && (heldItemId !== undefined || heldOutputIndex !== undefined || heldResponseId !== undefined);
    /** While the retry stream feeds the client, the framing the FIRST attempt
     *  opened is still open: the retry's own created/added events would hand the
     *  client a second set of ids, so they are dropped. The retry's reasoning
     *  surface is suppressed with them: its items were never announced (their
     *  added is dropped), so forwarding their part frames would leak ids the
     *  client cannot resolve (#1061). Returns true when the event was consumed. */
    const retryFraming = (type: unknown): boolean => {
        if (!inRetry) return false;
        if (typeof type === "string" && type.startsWith("response.reasoning_summary_")) return true;
        return type === "response.created" || type === "response.output_item.added" || type === "response.content_part.added";
    };
    /** Every id the retry carries is rewritten onto the first attempt's, so the
     *  client's assembled item stays the one it already holds. */
    const rewriteRetryIds = (ev: Record<string, unknown>): void => {
        if (!inRetry) return;
        if (heldItemId !== undefined) ev["item_id"] = heldItemId;
        if (heldOutputIndex !== undefined) ev["output_index"] = heldOutputIndex;
        // `response.output_item.*` carries the item's identity nested as `item.id`
        // rather than `item_id`. The done event is released to the client, so
        // without this the client watches the item it holds be replaced.
        const item = ev["item"];
        if (heldItemId !== undefined && item && typeof item === "object") {
            (item as Record<string, unknown>)["id"] = heldItemId;
        }
        const resp = ev["response"];
        if (!resp || typeof resp !== "object") return;
        const r = resp as Record<string, unknown>;
        if (heldResponseId !== undefined) r["id"] = heldResponseId;
        const output = r["output"];
        if (heldItemId !== undefined && Array.isArray(output)) {
            for (const item of output) {
                if (item && typeof item === "object") (item as Record<string, unknown>)["id"] = heldItemId;
            }
        }
    };
    /** One-shot re-issue when a Responses turn reaches its completion with
     *  nothing visible: the tag-echo case, where the filter empties the only
     *  text the model emitted and the host aborts an empty completed turn.
     *  Returns true when the retry stream took over, in which case the caller
     *  drops the held done-family events AND the completion it came from. */
    const retryEmptyTurn = async (status: string | undefined): Promise<boolean> => {
        if (degenerateRetried || refetch === undefined) return false;
        if (visibleTextChars > 0 || heldVisibleChars > 0 || sawFunctionCall) return false;
        if (status !== "completed") return false;
        if (res.destroyed || res.writableEnded) return false;
        // A turn the model left genuinely bare — no reasoning, no stripped
        // echo — is the upstream's own empty answer, not a stall: re-issuing it
        // double-bills an empty completion (#732/#821 keep the same boundary in
        // the compress loop).
        if (!sawReasoning && !sawStrippedEcho) return false;
        degenerateRetried = true;
        log?.("[plugin] degenerate terminal turn (no visible output); retrying once with a continuation nudge (#732/#821)");
        let next: ReadableStream<Uint8Array> | null = null;
        try {
            next = await refetch();
        } catch (e) {
            log?.(`[plugin] degenerate-terminal retry failed (${e instanceof Error ? e.message : String(e)}); passing the empty turn through`);
            return false;
        }
        if (!next) return false;
        // The turn is NOT over: the retry carries its own terminal, and a cut in
        // it must still raise the truncation signal (#721).
        sawTerminal = false;
        responseStatus = undefined;
        heldEvents = [];
        heldVisibleChars = 0;
        inRetry = true;
        // The first attempt's held filter state belongs to text the client never
        // saw (an emptying tag echo): the retry's content is filtered from
        // scratch, so a partial tag there cannot swallow its opening characters.
        tagFilter.flush();
        // The first attempt is terminal and its body is drained; close the
        // reader we are abandoning rather than leaving the socket held.
        try {
            await reader.cancel();
        } catch {
            /* already closed */
        }
        reader = next.getReader();
        decoder = new TextDecoder("utf-8");
        buf = "";
        return true;
    };
    interface RespArgStream {
        filter: TagEchoFilter;
        type: string;
        field: string;
        meta: Record<string, unknown>;
    }
    const argStreams = new Map<string, RespArgStream>();
    const argStreamFor = (type: string, field: string, ev: Record<string, unknown>) => {
        const id = typeof ev["item_id"] === "string" ? ev["item_id"] : String(ev["output_index"] ?? 0);
        const key = `${type}:${id}`;
        let s = argStreams.get(key);
        if (!s) {
            const meta: Record<string, unknown> = {};
            for (const k of ["item_id", "output_index", "summary_index"]) {
                if (ev[k] !== undefined) meta[k] = ev[k];
            }
            s = { filter: createTagEchoFilter(onTagDrop), type, field, meta };
            argStreams.set(key, s);
        }
        return s;
    };
    const argAnyPending = () => {
        for (const s of argStreams.values()) if (s.filter.pending()) return true;
        return false;
    };
    const flushArgTails = () => {
        let out = "";
        for (const s of argStreams.values()) {
            const tail = s.filter.flush();
            if (tail.length > 0) out += `data: ${JSON.stringify({ type: s.type, ...s.meta, [s.field]: tail })}\n\n`;
        }
        return out;
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) {
                buf = normalizeSseLineEndings(buf + decoder.decode(value, { stream: true }));
                let idx: number;
                while ((idx = buf.indexOf("\n\n")) !== -1) {
                    const rawEvent = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const dataLines = rawEvent.split("\n").filter((l) => l.startsWith("data:"));
                    if (dataLines.length === 0) continue;
                    const jsonStr = dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n").trim();
                    if (!jsonStr || jsonStr === "[DONE]") {
                        if (jsonStr === "[DONE]") sawTerminal = true;
                        await write(rawEvent + "\n\n");
                        continue;
                    }
                    let ev: Record<string, unknown>;
                    try {
                        ev = JSON.parse(jsonStr) as Record<string, unknown>;
                    } catch {
                        await write(rawEvent + "\n\n");
                        continue;
                    }
                    const sample = usageFromSseEvent(ev);
                    if (sample) mergeUsageSample(acc, sample);
                    const type = ev["type"];
                    if (typeof type === "string") {
                        if (type.startsWith("response.reasoning")) sawReasoning = true;
                        if (type === "response.output_item.added" || type === "response.output_item.done") {
                            const item = ev["item"] as Record<string, unknown> | undefined;
                            const it = item?.["type"];
                            if (it === "function_call" || it === "custom_tool_call") sawFunctionCall = true;
                        }
                        const resp = ev["response"] as Record<string, unknown> | undefined;
                        if (resp && typeof resp["status"] === "string") responseStatus = resp["status"] as string;
                        if (!inRetry) {
                            // The ids the client holds are the first attempt's: the
                            // retry is reframed onto them (see rewriteRetryIds).
                            if (type === "response.created" && resp && resp["id"] !== undefined) heldResponseId = resp["id"];
                            if (type === "response.output_item.added") {
                                const added = ev["item"] as Record<string, unknown> | undefined;
                                if (added && added["id"] !== undefined) heldItemId = added["id"];
                                if (ev["output_index"] !== undefined) heldOutputIndex = ev["output_index"];
                            }
                        }
                    }
                    if (retryFraming(type)) continue;
                    // function_call_arguments.done carries tool arguments, not
                    // visible text: forwarded verbatim (#1039).
                    if (type === "response.function_call_arguments.done") {
                        await write(flushArgTails() + rawEvent + "\n\n");
                        continue;
                    }
                    // #933: done-family events also carry full text payloads — strip those too.
                    // The done is not visible text to the degenerate-turn retry below, so it
                    // is stripped and released directly.
                    if (type === "response.reasoning_summary_part.done") {
                        const hadEcho = containsRenderTagText(jsonStr) || containsMarkerLineText(jsonStr);
                        if (hadEcho) sawStrippedEcho = true;
                        const evOut = hadEcho ? stripResponsesText(ev) : ev;
                        proseAcc += responsesEventText(evOut);
                        const out = hadEcho ? rebuildEvent(rawEvent, evOut) : rawEvent + "\n\n";
                        await write(flushArgTails() + flushTail(out));
                        continue;
                    }
                    if (type === "response.output_text.done" || type === "response.content_part.done" || type === "response.output_item.done") {
                        // HELD until the completion event decides the turn (see
                        // retryEmptyTurn): releasing it earlier would hand the
                        // client the echo's own text exactly when the retry is
                        // about to replace it.
                        const hadEchoText = containsRenderTagText(jsonStr) || containsMarkerLineText(jsonStr);
                        if (hadEchoText) sawStrippedEcho = true;
                        let evOut = ev;
                        let rebuild = hadEchoText || retryRewritePending();
                        if (rebuild) evOut = stripResponsesText(ev);
                        rewriteRetryIds(evOut);
                        const doneText = responsesEventText(evOut);
                        heldVisibleChars += doneText.length;
                        proseAcc += doneText;
                        heldEvents.push(rebuild ? rebuildEvent(rawEvent, evOut) : rawEvent + "\n\n");
                        continue;
                    }
                    if (type === "response.output_item.added") {
                        // Everything still held belongs to items upstream opened
                        // before this frame, and strict clients require
                        // done(itemN) before added(itemN+1) — opencode v2 hard-
                        // errors on a new reasoning item while the previous one
                        // is still open (#1061). Flush tails first: a pending
                        // tag/arg tail belongs to the previous item's text and
                        // must precede that item's held done. heldVisibleChars
                        // is kept — flushed text still counts against the
                        // empty-turn gate.
                        let out = flushArgTails() + flushTail("");
                        for (const held of heldEvents) out += held;
                        heldEvents = [];
                        await write(out + rawEvent + "\n\n");
                        continue;
                    }
                    if (type === "response.completed" || type === "response.failed" || type === "response.incomplete") {
                        sawTerminal = true;
                        if (await retryEmptyTurn(type === "response.completed" ? "completed" : undefined)) {
                            // The retry took over: this attempt's held family and
                            // its own completion frame are dropped together. Arg
                            // streams are empty here by construction — a function
                            // call would have blocked the retry via sawFunctionCall.
                            for (const s of argStreams.values()) s.filter.flush();
                            argStreams.clear();
                            heldEvents = [];
                            heldVisibleChars = 0;
                            continue;
                        }
                        const tailFrame = flushTail("");
                        if (tailFrame.length > 0) await write(tailFrame);
                        const argTail = flushArgTails();
                        if (argTail.length > 0) await write(argTail);
                        for (const held of heldEvents) await write(held);
                        heldEvents = [];
                        heldVisibleChars = 0;
                        // The completion frame itself closes the turn: strip it if it
                        // carries echoed text, rewrite retry ids onto the first attempt's.
                        const hadEchoText = containsRenderTagText(jsonStr) || containsMarkerLineText(jsonStr);
                        if (hadEchoText) sawStrippedEcho = true;
                        let evOut = ev;
                        let rebuild = hadEchoText || retryRewritePending();
                        if (rebuild) evOut = stripResponsesText(ev);
                        rewriteRetryIds(evOut);
                        await write(rebuild ? rebuildEvent(rawEvent, evOut) : rawEvent + "\n\n");
                        continue;
                    }
                    if (type === "response.output_text.delta" && typeof ev["delta"] === "string") {
                        const delta = ev["delta"] as string;
                        if (delta.length === 0) {
                            await write(rawEvent + "\n\n");
                            continue;
                        }
                        if (!retryRewritePending() && !mayStartRenderTag(delta) && !mayStartMarkerLine(delta) && !tagFilter.pending()) {
                            proseAcc += delta;
                            await write(rawEvent + "\n\n");
                            continue;
                        }
                        const clean = tagFilter.push(delta);
                        lastDeltaMeta = { item_id: ev["item_id"], output_index: ev["output_index"] };
                        if (!inRetry && heldItemId === undefined && ev["item_id"] !== undefined) {
                            heldItemId = ev["item_id"];
                            heldOutputIndex = ev["output_index"];
                        }
                        if (clean.length === 0) {
                            sawStrippedEcho = true;
                            continue;
                        }
                        visibleTextChars += clean.length;
                        proseAcc += clean;
                        if (clean === delta && !retryRewritePending()) {
                            await write(rawEvent + "\n\n");
                            continue;
                        }
                        const rebuilt = { ...ev, delta: clean };
                        rewriteRetryIds(rebuilt);
                        await write(rebuildEvent(rawEvent, rebuilt));
                        continue;
                    }
                    // Reasoning summary deltas carry visible prose; function_call
                    // argument deltas are user intent and pass through verbatim
                    // (#1039), falling into the generic rawEvent write below.
                    const argField = type === "response.reasoning_summary_text.delta" ? "delta" : null;
                    if (argField !== null && typeof type === "string") {
                        const v = ev[argField];
                        if (typeof v !== "string" || v.length === 0) {
                            await write(rawEvent + "\n\n");
                            continue;
                        }
                        if (!mayStartRenderTag(v) && !argAnyPending() && !tagFilter.pending()) {
                            proseAcc += v;
                            await write(rawEvent + "\n\n");
                            continue;
                        }
                        const s = argStreamFor(type, argField, ev);
                        const clean = s.filter.push(v);
                        if (clean.length === 0) continue;
                        proseAcc += clean;
                        if (clean === v) {
                            await write(flushArgTails() + rawEvent + "\n\n");
                            continue;
                        }
                        await write(flushArgTails() + rebuildEvent(rawEvent, { ...ev, [argField]: clean }));
                        continue;
                    }
                    await write(rawEvent + "\n\n");
                }
            }
            if (res.destroyed || res.writableEnded) break;
        }
        // Stream cut without a done-family event: flush whatever the tag
        // filter still holds so prose is never silently lost.
        if (!res.destroyed && !res.writableEnded) {
            const rest = flushArgTails() + flushTail("");
            if (rest.length > 0) await write(rest);
        }
        maybeWarnDegenerate();
        maybeWarnProtocolFragment();
        settleUsage();
        // #721: same as the chat-pipe twin — never close bare on a missing
        // done-family event. Responses has no separate finish-reason concept
        // (terminal events carry the status), so this is always the error shape.
        if (!sawTerminal && !res.destroyed && !res.writableEnded) {
            emitUpstreamTruncation(res, "responses", false, log);
            return;
        }
    } catch (e) {
        settleUsage();
        if (res.destroyed || res.writableEnded) {
            log?.("client aborted mid-stream");
            return;
        }
        // #721: upstream read failed while the client is still connected —
        // deliver the in-band truncation signal instead of rethrowing into
        // the top-level handler, which would close the stream bare. Flush
        // held tag tails first so partial prose is never silently lost.
        try {
            const rest = flushArgTails() + flushTail("");
            if (rest.length > 0) await write(rest);
        } catch {
            /* client half-gone; the emission below is best-effort too */
        }
        loggerLog("warn", `[plugin] upstream stream read failed (responses): ${String(e instanceof Error ? e.message : e)} — emitting in-band truncation signal`);
        emitUpstreamTruncation(res, "responses", false, log);
        return;
    } finally {
        reader.releaseLock();
        res.end();
    }
}

function rebuildEvent(rawEvent: string, ev: Record<string, unknown>): string {
    const lines = rawEvent.split("\n");
    let replaced = false;
    const out: string[] = [];
    for (const l of lines) {
        if (l.startsWith("data:")) {
            // Multi-line data payloads (never emitted by real upstreams, but
            // tolerated by the parser) collapse into the single rebuilt line —
            // leaving the extra data lines would fuse two JSON payloads.
            if (replaced) continue;
            replaced = true;
            out.push(`data: ${JSON.stringify(ev)}`);
            continue;
        }
        out.push(l);
    }
    return replaced ? out.join("\n") + "\n\n" : `data: ${JSON.stringify(ev)}\n\n`;
}

// Plugin-passthrough parity for the Gemini wire: strip the model prose that
// lives in `candidates[*].content.parts[*].text` — both plain text parts and
// `thought:true` reasoning parts share that one field. Mirrors
// stripOpenaiChatText / stripAnthropicText; mutates in place (the returned
// reference is the input's).
function stripGoogleChunk<T>(obj: T): T {
    if (!obj || typeof obj !== "object") return obj;
    const o = obj as Record<string, unknown>;
    const candidates = o["candidates"];
    if (!Array.isArray(candidates)) return obj;
    o["candidates"] = candidates.map((c) => {
        if (!c || typeof c !== "object") return c;
        const cand = c as Record<string, unknown>;
        const content = cand["content"];
        if (!content || typeof content !== "object") return c;
        const cont = content as Record<string, unknown>;
        if (!Array.isArray(cont["parts"])) return c;
        return {
            ...cand,
            content: {
                ...cont,
                parts: (cont["parts"] as unknown[]).map((p) =>
                    p && typeof p === "object" && typeof (p as Record<string, unknown>)["text"] === "string"
                        ? { ...(p as Record<string, unknown>), text: stripAcpTags((p as Record<string, unknown>)["text"] as string) }
                        : p,
                ),
            },
        };
    });
    return obj;
}

// Without `alt=sse` a Gemini streaming response is a JSON ARRAY of the same
// chunk objects, so the non-stream strip applies to each element as well.
function stripGoogleText<T>(obj: T): T {
    if (Array.isArray(obj)) {
        obj.forEach((c) => {
            stripGoogleChunk(c);
        });
        return obj;
    }
    return stripGoogleChunk(obj);
}

export async function pipePluginJson(
    stream: ReadableStream<Uint8Array>,
    res: import("node:http").ServerResponse,
    session?: Session,
    protocol?: WireProtocol,
): Promise<void> {
    // Also serves proxy-mode JSON responses that skipped compress injection
    // (#460 residual) — pass no session there so usage accounting stays off.
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length > 0) chunks.push(Buffer.from(value));
        }
    } catch (e) {
        // #411: a non-stream body cut mid-read has nothing parseable left, but
        // the response must still end and a client cancel must not surface as
        // a context-free error.
        if (!res.writableEnded) res.end();
        if (res.destroyed || res.writableEnded) return;
        throw e;
    }
    reader.releaseLock();
    const text = Buffer.concat(chunks).toString("utf8");
    let json: Record<string, unknown> | undefined;
    let mutated = false;
    try {
        json = JSON.parse(text) as Record<string, unknown>;
        const usage = json["usage"] as Record<string, unknown> | undefined;
        if (session && usage) {
            const input = num(usage["prompt_tokens"]) ?? num(usage["input_tokens"]);
            if (input !== undefined) {
                const cached =
                    num((usage["prompt_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]) ??
                    num((usage["input_tokens_details"] as Record<string, unknown> | undefined)?.["cached_tokens"]) ??
                    num(usage["cache_read_input_tokens"]) ??
                    // #779: DeepSeek-style top-level field (openai wire)
                    num(usage["prompt_cache_hit_tokens"]);
                const creation = num(usage["cache_creation_input_tokens"]);
                applyUsageSample(session, {
                    inputTokens: input,
                    outputTokens: num(usage["completion_tokens"]) ?? num(usage["output_tokens"]),
                    cachedTokens: cached,
                    creationTokens: creation,
                }, protocol);
                markDirty(session);
            }
        }
        // Gemini reports its usage in a top-level `usageMetadata` instead of
        // `usage` (same object on a non-streaming body as on an SSE chunk) —
        // feed it too, so a `:generateContent` turn also anchors
        // lastInputTokens for the nudge/fit decisions.
        if (session && !usage) {
            const sample = googleUsageSample(json);
            if (sample && sample.inputTokens !== undefined) {
                applyUsageSample(session, sample, protocol);
                markDirty(session);
            }
        }
    } catch { /* non-JSON body — forward verbatim */ }
        if (json && (containsRenderTagText(text) || containsMarkerLineText(text))) {
        // #206 parity for the non-streaming plugin path: the compress loop's
        // JSON branch strips render tags from every round; a verbatim plugin
        // JSON response would re-feed the model's tag echoes. Strips mutate in
        // place, so this composes with the #408 usage backfill above — one
        // parse, one reserialize.
        json = protocol === "responses" ? stripResponsesText(json)
            : protocol === "anthropic" ? stripAnthropicText(json)
            : protocol === "google" ? stripGoogleText(json)
            : stripOpenaiChatText(json);
        mutated = true;
    }
    if (mutated && json) {
        res.end(Buffer.from(JSON.stringify(json), "utf8"));
        return;
    }
    res.end(text);
}

export function _resetPluginStateForTest(): void {
    conversations.clear();
    remembered.clear();
    pendingRegisters.length = 0;
    registeredIds.clear();
    pluginRuntimeTable.clear();
    warnedNoModelRequests.clear();
}

export function _rememberedForTest(): Map<string, RememberedMessages> {
    return remembered;
}
