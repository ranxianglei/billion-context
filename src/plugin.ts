import { type CompressionCore, type Config, type CoreMessage, type NudgeDecision, countMessageTokens, parseStoredPlaceholder, prune } from "acp-kernel";
import { publicSnapshotCapBytes } from "./knobs.js";
import { buildStatusPanel } from "acp-kernel/panel";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getStore } from "./persist.js";
import { cloneStoreForRefs } from "./store.js";
import { acquireInFlight, createSession, getSession, publishForkSession, diagnoseSuccessWithoutUsage, effectiveConfig, findSessionByCanonicalId, listSessions, markCompactionBoundary, markDirty, peekSession, releaseInFlight, statusInputBaseline, withSessionLock, type Session } from "./session.js";
import { clientConversationHeader } from "./session-id.js";
import { ABSORB_TOOL_NAME, BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_OPENAI_NO_RANGE, BILI_ACP_TOOLS_RESPONSES_NO_RANGE, PROXY_TOOL_NAMES, RETRIEVE_TOOL_NAME, RULE_TOOL, RULE_TOOL_NAME, RULE_TOOL_OPENAI, RULE_TOOL_RESPONSES, SEARCH_CONTEXT_TOOL_NAME, absorbToolsFor, retrieveToolsFor } from "./compress-tool.js";
import { externalSummaryEnabled, externalSummaryMaxToolDurationMs, withExternalSummaryTools } from "./external-summary-surface.js";
import { absorbEnabled, effectiveAbsorbConfig, isProxyToolFor } from "./absorb.js";
import { effectiveRulesEnabled, rulesEnabled } from "./rules-feature.js";
import { executeProxyToolAsync } from "./loop/core.js";
import type { ProxyToolResult } from "./proxy-tool-result.js";
import { normalizeSseLineEndings, finalizeSseLineEndings } from "./sse-util.js";
import { composeStreamFilters, containsBiliInternalText, containsEchoResidue, containsMarkerLineText, containsRenderTagText, containsToolCallEmissionText, containsToolCallXmlFragment, createBiliArtifactFilter, createIdentityStreamFilter, createMarkerLineFilter, createTagEchoFilter, isOrphanMarkupText, mayStartBiliInternal, mayStartDegenerateRenderTag, mayStartMarkerLine, mayStartRenderTag, mayStartToolCallEmission, stripAcpTags, stripAnthropicText, stripOpenaiChatText, stripResponsesText, type TagEchoFilter } from "./loop/tag-echo-filter.js";
import { log as loggerLog } from "./logger.js";
import { ccrEnabled, ccrLoopConfig, contentStoreOf, retrieveToolName } from "./store.js";
import { imageUsageSuffix } from "./image-compress.js";
import { emitStreamError, emitUpstreamTruncation } from "./stream-error.js";
import type { TruncationDiag } from "./stream-error.js";

/** #2328 Q2: what the pipes know about the upstream HTTP response whose body
 *  they are piping — threaded in by server.ts so the truncation diag can cite
 *  status/content-type without the pipes holding the Response object. */
export interface UpstreamMeta {
    status?: number;
    contentType?: string;
}

/** #2328 Q4: does the dangling partial event left at a cut carry the opening
 *  bytes of the wire's own terminal? Factual byte evidence only — this never
 *  guesses about frames that parsed but were classified otherwise. */
function tailLooksTerminal(tail: string, protocol: WireProtocol | "responses"): boolean {
    // [DONE] torn anywhere past `data: [DO` is still recognizable as the
    // terminal byte arriving.
    if (/^data: \[DO/.test(tail)) return true;
    if (protocol === "anthropic") return /event: message_stop/.test(tail.slice(0, 64)) || /"type"\s*:\s*"message_stop"/.test(tail);
    if (protocol === "openai") {
        // `"finish_reason":null` rides EVERY chat chunk — only a quoted
        // (non-null) value counts, which is the final chunk's signature.
        return /"finish_reason"\s*:\s*"/.test(tail);
    }
    if (protocol === "google") {
        // finishReason only ever appears on Gemini's terminal chunk.
        return /"finishReason"\s*:\s*"/.test(tail);
    }
    // responses: the completion-family event is the terminal.
    return /event: response\.(?:completed|failed|incomplete)/.test(tail.slice(0, 64)) ||
        /"type"\s*:\s*"response\.(?:completed|failed|incomplete)"/.test(tail);
}
import { degenerateTurnWarning, endsWithDraftClose, requestExpectsProseSummary } from "./degenerate-turn.js";
import { PANEL_BOX_FOOTER } from "./acp-panel.js";
import { describeAdvisory, getAdvisoryState } from "./advisory.js";
import { describeUpdateReady, getUpdateVisibility } from "./update-notes.js";
import { warnCacheCollapse } from "./cache-warn.js";
import { currentContextObservation, recordContextObservation, settleUsageReport } from "./cache-ledger.js";
import { promptInputTotal, type WireProtocol } from "./util.js";
import { stateDir } from "./paths.js";
import { lookupToolWitness, recordToolWitness } from "./tool-ring.js";
import { awaitDrain } from "./server/stream-io.js";
import { incomingCoreMessages } from "./fork-adoption.js";
import { BUILD_COMMIT } from "./version.js";
import { isExternalSummaryBlock } from "./external-summary-marker.js";

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

const PLUGIN_AGENT_HEADER = "x-bili-plugin";
const PLUGIN_CONVERSATION_HEADER = "x-bili-plugin-conversation";
/** #920: legacy-lane marker. Set by the absorbed opencode-acp wrapper for
 *  sessions that still run through the legacy DCP machinery — the proxy
 *  forwards such requests VERBATIM (no wire injection, no session binding,
 *  no compress loop): the legacy extension owns compression for them. */
const PLUGIN_BYPASS_HEADER = "x-bili-plugin-bypass";
const PLUGIN_CONTEXT_WINDOW_HEADER = "x-bili-plugin-context-window";
const PLUGIN_MAX_OUTPUT_HEADER = "x-bili-plugin-max-output";
const PLUGIN_MODEL_HEADER = "x-bili-plugin-model";
/** #1102/#1106: stamped "1" by plugins whose host mints one conversation id per
 *  persona (opencode: subagents get their own child session ids). Since the
 *  instructions fingerprint became an allowlist (#1106 — exempt is the
 *  default for every non-codex/non-claude signal), this declaration is
 *  vestigial: hosts keep stamping it for protocol compatibility with older
 *  proxies, but current proxies key verbatim regardless. */
const PLUGIN_INSTRUCTIONS_MUTABLE_HEADER = "x-bili-plugin-instructions-mutable";
/** #1699: the host's per-request persona/agent id (opencode v2 stamps its own
 *  taxonomy — "title", "build", "plan", ...). Carries INTENT the request body
 *  cannot express: opencode v2 title-gen requests carry NO max_tokens (options
 *  {} for kind==="title"), so the output-budget side-request heuristic (#388)
 *  can never see them — they were misclassified as main turns and got the full
 *  compress prompt + tool injected into the title model. Known side-request
 *  agents route by intent (side-request.ts SIDE_REQUEST_AGENTS); explicit "main"
 *  vetoes side heuristics, while other persona ids remain inert telemetry. */
const PLUGIN_REQUEST_AGENT_HEADER = "x-bili-plugin-agent";

const PLUGIN_PROTOCOL_VERSION = 1;

/** #1567: folds executed through POST /__bili/plugin/tool are minted this
 *  synthetic callId, which the client can never echo back — its own re-sent
 *  compress pair is the summary carrier for such blocks, so the kernel's
 *  in-place acp_summary anchor is redundant and must be stripped (#1567). */
const PLUGIN_FOLD_CALLID_PREFIX = "plugin_";
export function isPluginFoldCallId(callId: string | undefined): boolean {
    return typeof callId === "string" && callId.startsWith(PLUGIN_FOLD_CALLID_PREFIX);
}

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
function pluginContextWindowHeader(headers: Record<string, string | string[] | undefined>): number | undefined {
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

/** #1699: per-request persona id, honored ONLY from an announced plugin (same
 *  gate as window/model): a plain client must not be able to change request
 *  classification by name. A real plugin stamps both headers. */
export function pluginRequestAgentHeader(headers: Record<string, string | string[] | undefined>): string | undefined {
    if (pluginAgentHeader(headers) === undefined) return undefined;
    return headerValue(headers, PLUGIN_REQUEST_AGENT_HEADER);
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
// #2077: which content-store object each session's stored-refs list was last
// evaluated against. Store updates are immutable (storeOriginal returns a new
// object), so a changed object identity is the exact signal that the refs
// list needs re-evaluation — an unchanged-view resend can skip even the refs
// walk. Restored sessions are fresh objects, so their first remember
// re-evaluates automatically.
const snapshotRefsEvaluatedStore = new WeakMap<Session, unknown>();

// #1158: one-shot "no model requests arrived" warnings, keyed by conversation
// id. A tool call proves the model already answered, so an id with ZERO model
// requests means its traffic never reached this proxy (SDK-injected fetch,
// e.g. dsh llm-pi-ai under a bare profile install) or is stale after a host
// resume — warn once per conversation instead of on every rejected tool call.
const warnedNoModelRequests = new Set<string>();
const WARNED_NO_MODEL_REQUESTS_CAP = 4096;
/** #1685 freshness window for single-active arbitration — same scale as the
 *  tool-witness TTL in tool-ring.ts. */
const WITNESS_TTL_MS_PLUGIN = 10 * 60 * 1000;

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
 *  insertion order doubles as an LRU clock. Keys that name a resident session
 *  — or already carry a self-binding — are reserved: binding them to another
 *  session is forced back to the self-binding (#1895). */
export function recordPluginSession(conversationId: string, sessionId: string): void {
    if (conversationId !== sessionId && (peekSession(conversationId) || conversations.get(conversationId)?.sessionId === conversationId)) {
        sessionId = conversationId;
    }
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
export function rememberPluginMessages(sessionId: string, processed: CoreMessage[], original: CoreMessage[], nudge?: NudgeDecision, rawWire?: Buffer): void {
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
    const session = peekSession(sessionId);
    if (session && typeof session.metadata.pluginAgent === "string" && original.length > 0) {
        // #2077: copy-on-write snapshot maintenance. A raw id is a SHA-256 of
        // the message identity plus a deterministic within-conversation
        // duplicate-cluster index (acp-kernel wire/message-id.ts), but ids
        // alone do NOT name the bytes: adapters attach wire flags outside the
        // CoreMessage interface (toolIsError — see forkToolIsError), so the
        // walk below compares full views (sameSnapshotView: exactly the field
        // set forkMessageIdentityHash digests, plus id). Steady state costs a
        // field scan instead of clone + serialize: a pure extension clones
        // only its tail and extends the tracked byte count rather than
        // re-cloning and re-serializing the whole history every request.
        const cap = publicSnapshotCapBytes();
        const dropOverCap = () => {
            session.pluginSnapshot = undefined;
            session.metadata.publicSnapshotCapped = true;
            delete session.metadata.publicSnapshotBytes;
        };
        let changed = false;
        const prev = session.pluginSnapshot;
        if (!prev || session.metadata.publicSnapshotCapped === true) {
            // First write (fresh session, lazy-persist restore gap) or recovery
            // after a cap-drop. Measure BEFORE cloning so an over-cap history
            // pays one serialize, not clone + serialize.
            const bytes = stableJson(original).length;
            if (cap > 0 && bytes > cap) dropOverCap();
            else {
                session.pluginSnapshot = structuredClone(original);
                session.metadata.publicSnapshotBytes = bytes;
                delete session.metadata.publicSnapshotCapped;
            }
            changed = true;
        } else {
            const n = original.length;
            let k = 0;
            while (k < prev.length && k < n && sameSnapshotView(prev[k], original[k])) k++;
            if (k === n && n === prev.length) {
                // Identical view (e.g. an upstream retry re-forwarding the
                // same body): snapshot, byte count and refs list stay valid,
                // and skipping markDirty keeps the revision cache warm so
                // status polls stay O(1). The cap is still enforced from the
                // tracked count on every request, and legacy records predate
                // the count — measure them once into it.
                const trackedBytes = typeof session.metadata.publicSnapshotBytes === "number" ? session.metadata.publicSnapshotBytes : undefined;
                const bytes = trackedBytes ?? stableJson(prev).length;
                if (trackedBytes === undefined) session.metadata.publicSnapshotBytes = bytes;
                if (cap > 0 && bytes > cap) dropOverCap();
                if (trackedBytes === undefined || cap > 0 && bytes > cap) changed = true;
            } else if (k === prev.length) {
                // Pure extension: append the tail (per-element clones keep the
                // snapshot independent of the request's live arrays) and extend
                // the byte count incrementally — appending an element e to an
                // array A grows len(sj(A)) by len(sj(e)) + 1 (its serialization
                // plus one separating comma), so no re-serialization is needed.
                let bytes = typeof session.metadata.publicSnapshotBytes === "number"
                    ? session.metadata.publicSnapshotBytes
                    : stableJson(prev).length;
                for (let i = k; i < n; i++) bytes += stableJson(original[i]).length + 1;
                if (cap > 0 && bytes > cap) dropOverCap();
                else {
                    for (let i = k; i < n; i++) prev.push(structuredClone(original[i]));
                    session.metadata.publicSnapshotBytes = bytes;
                    delete session.metadata.publicSnapshotCapped;
                }
                changed = true;
            } else {
                // Replacement (compression rewrote the history, restart
                // divergence): full rebuild, measured before cloning as above.
                const bytes = stableJson(original).length;
                if (cap > 0 && bytes > cap) dropOverCap();
                else {
                    session.pluginSnapshot = structuredClone(original);
                    session.metadata.publicSnapshotBytes = bytes;
                    delete session.metadata.publicSnapshotCapped;
                }
                changed = true;
            }
        }
        // The refs list must re-evaluate whenever the store object changed —
        // CCR can gain entries between remembers without any history change,
        // and the fork-time fail-closed check reads this list against the
        // CURRENT store.
        const storeChanged = snapshotRefsEvaluatedStore.get(session) !== session.contentStore;
        if (changed || storeChanged) {
            const previousRefs = session.metadata.publicSnapshotStoredRefs;
            session.metadata.publicSnapshotStoredRefs = [...new Set([
                ...(Array.isArray(previousRefs) ? previousRefs : []),
                ...(session.pluginSnapshot ?? []).flatMap((m) => {
                    const ref = session.state.messageRefs.byRaw[m.id];
                    return ref && session.contentStore?.byRef[ref] ? [ref] : [];
                }),
            ])];
            snapshotRefsEvaluatedStore.set(session, session.contentStore);
        }
        if (rawWire !== undefined) {
            // The comparable verdict is a property of the wire body: hash it
            // (native speed) and only re-parse + walk when the body actually
            // changed, so a retry with an identical body stays cheap.
            const wireHash = createHash("sha256").update(rawWire).digest("hex");
            if (session.metadata.publicSnapshotWireHash !== wireHash) {
                let comparable: boolean;
                try {
                    const wire = JSON.parse(rawWire.toString("utf8")) as Record<string, unknown>;
                    comparable = comparableHistory(wire.messages ?? wire.input ?? wire.contents);
                } catch {
                    comparable = false;
                }
                session.metadata.publicSnapshotWireHash = wireHash;
                if (session.metadata.publicSnapshotTextComparable !== comparable) {
                    session.metadata.publicSnapshotTextComparable = comparable;
                    changed = true;
                }
            }
        }
        if (changed || storeChanged) markDirty(session);
    }
}

// Launcher mode (#162): hosts that cannot attach per-request headers
// (claude/codex spawned by `bili claude` / `bili codex`) pre-register their
// conversation via POST /__bili/plugin/register — typically from a Claude
// Code SessionStart hook or at codex spawn time. A pending register is
// consumed by the FIRST model request that creates a NEW session afterwards
// (server.ts binding step): that session becomes plugin-mode (native tools,
// wire injection suppressed) and the conversation id becomes its tool-API key
// — no x-bili-plugin headers required.
type PendingPluginRegister = { conversationId: string; agent: string; ts: number; parentConversationId?: string };

/** Runtime-info protocol entry (#955): what the client's OWN config says it
 *  will run — reported at plugin bootstrap and on model switch, before (and
 *  independent of) any model request. Ranked in the native-window chain
 *  directly under the per-request header report; entries carry their model
 *  id and are only usable when that id matches the request's model (a stale
 *  post-switch entry must never size a different model). Entries carrying a
 *  conversationId are keyed by it (#1531), not by agent — one process runs
 *  many sessions (main + subagents) that share the agent name but report
 *  different windows, and a single per-agent slot let the last reporter
 *  clobber everyone else's entry. */
type PluginRuntimeInfo = {
    agent: string;
    model: string;
    contextWindow?: number;
    maxOutput?: number;
    baseURL?: string;
    conversationId?: string;
    source: string;
    ts: number;
};

const pluginRuntimeTable = new Map<string, PluginRuntimeInfo>();
const pluginRuntimeByConversation = new Map<string, PluginRuntimeInfo>();
const MAX_PLUGIN_RUNTIME_ENTRIES = 32;

function evictOldestRuntimeEntries(map: Map<string, PluginRuntimeInfo>): void {
    while (map.size > MAX_PLUGIN_RUNTIME_ENTRIES) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

export function recordPluginRuntimeInfo(entry: PluginRuntimeInfo): void {
    const conv = entry.conversationId !== undefined && entry.conversationId.length > 0 ? entry.conversationId : undefined;
    const table = conv !== undefined ? pluginRuntimeByConversation : pluginRuntimeTable;
    table.delete(conv ?? entry.agent);
    table.set(conv ?? entry.agent, entry);
    evictOldestRuntimeEntries(table);
}

/** Latest runtime-info for an agent, usable for `model` only (undefined =
 *  no report, or a report for a different model). */
export function pluginRuntimeInfoFor(agent: string | undefined, model: string | undefined): PluginRuntimeInfo | undefined {
    if (agent === undefined || model === undefined) return undefined;
    const entry = pluginRuntimeTable.get(agent);
    if (entry === undefined || entry.model !== model) return undefined;
    return entry;
}

/** Latest runtime-info registered under a conversation id, usable for
 *  `model` only (#1531). */
export function pluginRuntimeInfoForConversation(conversationId: string | undefined, model: string | undefined): PluginRuntimeInfo | undefined {
    if (conversationId === undefined || model === undefined) return undefined;
    const entry = pluginRuntimeByConversation.get(conversationId);
    if (entry === undefined || entry.model !== model) return undefined;
    return entry;
}

/** The narrow conversation signal a header-less runtime-info lookup can
 *  match on (#1531): client conversation header → custom session header →
 *  body prompt_cache_key. Mirrors the identity chain's precedence at exactly
 *  the points where a reported conversationId could have been minted (omp
 *  stamps prompt_cache_key with its session uuid, #957/#1230); any divergence
 *  from the full binding identity degrades to a miss — legacy behavior —
 *  never a wrong hit. */
export function runtimeConversationId(headers: Record<string, string | string[] | undefined>, parsed: unknown, sessionHeaderName?: string): string | undefined {
    const fromClient = clientConversationHeader(headers);
    if (fromClient !== undefined && fromClient.length > 0) return fromClient;
    const custom = sessionHeaderName !== undefined ? headerValue(headers, sessionHeaderName) : undefined;
    if (custom !== undefined) return custom;
    const pck = typeof parsed === "object" && parsed !== null ? (parsed as { prompt_cache_key?: unknown }).prompt_cache_key : undefined;
    return typeof pck === "string" && pck.trim().length > 0 ? pck.trim() : undefined;
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
    const body = parsed as { agent?: unknown; model?: unknown; contextWindow?: unknown; maxOutput?: unknown; baseURL?: unknown; conversationId?: unknown; source?: unknown };
    const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
    const agent = str(body.agent, 64);
    const model = str(body.model, 256);
    if (agent === undefined || model === undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "agent and model are required" }));
        return;
    }
    const conversationId = str(body.conversationId, 256);
    recordPluginRuntimeInfo({
        agent,
        model,
        contextWindow: num(body.contextWindow),
        maxOutput: num(body.maxOutput),
        baseURL: str(body.baseURL, 2048),
        ...(conversationId !== undefined ? { conversationId } : {}),
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
        // #2408: a parent declaration is sticky for a conversation — a
        // follow-up register WITHOUT one (claude's MCP shim re-registering the
        // session the fork hook already declared) must not erase it.
        const parent = parentConversationId ?? registeredIds.get(conversationId)?.parentConversationId;
        registeredIds.set(conversationId, { agent, ...(parent ? { parentConversationId: parent } : {}) });
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

// #2322: the host named the conversation (pi /name) — remember it as the
// session's display title. B-channel design: a dedicated endpoint (instead
// of a request header) so set/rename/CLEAR are all expressible (empty name =
// clear, falling display back to the derived first-message title) and the
// name lands immediately, not on the next model request.
const HOST_TITLE_MAX = 200;

export function handlePluginSessionName(payload: string, res: import("node:http").ServerResponse): void {
    let parsed: { conversationId?: unknown; name?: unknown };
    try {
        parsed = JSON.parse(payload) as { conversationId?: unknown; name?: unknown };
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
    if (typeof parsed.name !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "name must be a string (empty clears)" }));
        return;
    }
    const { session, entry } = resolveConversation(conversationId);
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
    let name = parsed.name.replace(/\s+/g, " ").trim();
    if (name.length > HOST_TITLE_MAX) name = name.slice(0, HOST_TITLE_MAX);
    if (name) session.meta.hostTitle = name;
    else delete session.meta.hostTitle;
    markDirty(session);
    if (entry) entry.lastSeen = Date.now();
    res.end(JSON.stringify({ ok: true, conversationId }));
}

// #1685: the conversation_id tool parameter is GONE from the manifest — the
// model must never see or echo a conversation id (zero-injection identity:
// the proxy routes by outbound tool_use witness / body id / single-active
// arbitration; see tool-ring.ts). Wire-mode injection serves the kernel
// constants directly, which never carried the param.

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
    // #1712: decompress's startId/endId (range restore) executes only on CCR-armed
    // sessions, so the manifest advertises them only when the base config enables
    // CCR (#1345 plugin policy = base block verbatim) — same conservative #1192
    // rule as acp_retrieve above. CCR-off manifests serve the no-range variants so
    // a registered agent never sees range fields execution would refuse.
    const externalSummary = externalSummaryEnabled(config);
    const acpAnthropic = withExternalSummaryTools(ccrOn ? BILI_ACP_TOOLS_ANTHROPIC : BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, externalSummary);
    const acpOpenai = withExternalSummaryTools(ccrOn ? BILI_ACP_TOOLS_OPENAI : BILI_ACP_TOOLS_OPENAI_NO_RANGE, externalSummary);
    // Responses wire: plugin mode structurally disarms CCR there (#1271 —
    // PLUGIN_CCR_WIRES excludes it), so range restore can never execute for a
    // registered agent on that wire — always the no-range variant, mirroring
    // how ccrTools above is never spread into the responses array.
    const acpResponses = withExternalSummaryTools(BILI_ACP_TOOLS_RESPONSES_NO_RANGE, externalSummary);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        ok: true,
        protocolVersion: PLUGIN_PROTOCOL_VERSION,
        proxy: "billion-context",
        version: VERSION,
        commit: BUILD_COMMIT,
        toolNames: [...PROXY_TOOL_NAMES, ...(absorbTools ? [absorbName] : []), ...(rulesOn ? [RULE_TOOL_NAME] : []), ...(ccrOn ? [ccrName] : [])],
        tools: {
            anthropic: [...acpAnthropic, ...(absorbTools ? [absorbTools.anthropic] : []), ...(rulesOn ? [RULE_TOOL] : []), ...(ccrTools ? [ccrTools.anthropic] : [])],
            openai: [...acpOpenai, ...(absorbTools ? [absorbTools.openai] : []), ...(rulesOn ? [RULE_TOOL_OPENAI] : []), ...(ccrTools ? [ccrTools.openai] : [])],
            responses: [...acpResponses, ...(absorbTools ? [absorbTools.responses] : []), ...(rulesOn ? [RULE_TOOL_RESPONSES] : [])],
        },
        headers: { agent: PLUGIN_AGENT_HEADER, conversation: PLUGIN_CONVERSATION_HEADER, contextWindow: PLUGIN_CONTEXT_WINDOW_HEADER, maxOutput: PLUGIN_MAX_OUTPUT_HEADER, model: PLUGIN_MODEL_HEADER, instructionsMutable: PLUGIN_INSTRUCTIONS_MUTABLE_HEADER },
        toolEndpoint: "/__bili/plugin/tool",
        statusEndpoint: "/__bili/plugin/status",
        runtimeInfoEndpoint: "/__bili/plugin/runtime-info",
        // #2652: maxToolDurationMs = the budget's totalTimeoutMs ceiling, so agent-side
        // bridges size their compress-call HTTP wait to the real server bound instead of a
        // fixed constant. Absent when the chain is off (classic summaries commit locally).
        capabilities: { ...(externalSummary ? { externalSummary: { enabled: true, summaryOptional: true, submittedSummary: "hint", maxToolDurationMs: externalSummaryMaxToolDurationMs(config) } } : {}), fork: { protocolVersion: 1, endpoint: "/__bili/plugin/fork", snapshotEndpoint: "/__bili/plugin/snapshot" } },
    }));
}

export type PluginToolDeps = {
    core: CompressionCore;
    config: Config;
    log: (level: string, msg: string) => void;
    // Browser-reachable origin of THIS proxy (http://host:port) for the human-facing
    // Web UI deep links inside panels/reports; absent in test harnesses/embeds.
    webOrigin?: string;
    signal?: AbortSignal;
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

/** Native session ids outrank lookup aliases: shared prompt_cache_key values
 *  must not redirect a parent to a child. Repair legacy conflicting mappings
 *  on lookup; unknown ids still create no session. */
export function resolveConversation(conversationId: string): { session: Session | undefined; entry?: ConversationEntry } {
    let entry = conversations.get(conversationId);
    let session = peekSession(conversationId) ?? (entry ? peekSession(entry.sessionId) : undefined);
    if (!session) {
        session = findSessionByCanonicalId(conversationId);
    }
    if (session && entry?.sessionId !== session.id) {
        recordPluginSession(conversationId, session.id);
        entry = conversations.get(conversationId);
    }
    return { session, entry };
}

type ForkIdentity = { rawId: string; ref: string; identityHash: string };

// Only inspect message content, not arbitrary tool arguments containing a `type` key.
function comparableHistory(value: unknown): boolean {
    if (value === null || typeof value === "string") return true;
    if (Array.isArray(value)) return value.every(comparableHistory);
    if (!value || typeof value !== "object") return false;
    const part = value as Record<string, unknown>;
    if (part.type !== undefined && !["message", "text", "input_text", "output_text", "tool_use", "tool_result", "function_call", "function_call_output"].includes(String(part.type))) return false;
    if (part.type === "tool_use" || part.type === "function_call") return true;
    if (part.audio !== undefined && part.audio !== null) return false;
    if (part.content !== undefined) return comparableHistory(part.content);
    if (part.output !== undefined) return comparableHistory(part.output);
    if (part.parts !== undefined) return comparableHistory(part.parts);
    return typeof part.text === "string" || Array.isArray(part.tool_calls);
}
type ForkRequest = {
    protocolVersion: 1;
    parentConversationId: string;
    childConversationId: string;
    parentRevision: string;
    branchPoint: { messageCount: number; orderHash: string };
    orderedMessages: ForkIdentity[];
    idempotencyKey: string;
};

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const obj = value as Record<string, unknown>;
        return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function forkHash(value: unknown): string {
    return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function forkOrderHash(messages: ForkIdentity[]): string {
    return createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex");
}

function forkToolIsError(message: CoreMessage): boolean {
    return (message as CoreMessage & { toolIsError?: boolean }).toolIsError === true;
}

export function forkMessageIdentityHash(message: CoreMessage): string {
    return forkHash([message.role, message.contentType, message.text ?? null, message.toolName ?? null, message.toolCallId ?? null, message.thinkingTokens ?? null, message.summaryOfBlockId ?? null, forkToolIsError(message)]);
}

/** #2077 CoW view equality for rememberPluginMessages' prefix walk: compares
 *  exactly the field set forkMessageIdentityHash digests, plus id. An id
 *  prefix match alone would keep a stale snapshot when a resent history flips
 *  an adapter-attached flag (toolIsError) under unchanged ids — the snapshot
 *  must track every byte fork matching can see. If an adapter ever attaches a
 *  new runtime field, it MUST be added here and to forkMessageIdentityHash
 *  together. */
function sameSnapshotView(a: CoreMessage, b: CoreMessage): boolean {
    return a.id === b.id && a.role === b.role && a.contentType === b.contentType
        && a.text === b.text && a.toolName === b.toolName && a.toolCallId === b.toolCallId
        && a.thinkingTokens === b.thinkingTokens && a.summaryOfBlockId === b.summaryOfBlockId
        && forkToolIsError(a) === forkToolIsError(b);
}

/** Read under the session lock; compare ordered semantics, never just an id set. */
export function publicForkInputMatches(session: Session, protocol: WireProtocol, parsed: unknown): boolean {
    const prefix = session.pluginSnapshot;
    if (session.metadata.publicForkReceipt === undefined || !prefix) return false;
    try {
        const incoming = incomingCoreMessages(protocol, parsed);
        return incoming !== null && incoming.length >= prefix.length && prefix.every((message, index) => {
            const candidate = incoming[index]!;
            const ref = session.state.messageRefs.byRaw[message.id];
            return ref !== undefined && session.state.messageRefs.byRef[ref] === message.id
                && candidate.id === message.id && forkMessageIdentityHash(candidate) === forkMessageIdentityHash(message);
        });
    } catch {
        return false;
    }
}

/** Cheap, cache-backed read of the fork parentRevision. forkSnapshot() is a
 *  pure function of the session content and status polling would otherwise
 *  re-hash the entire history (plus the CCR store, payload by payload) on
 *  every call (#2017 review item E); revisionEpoch — bumped by markDirty on
 *  every mutation — keys the cache, so an unchanged session costs O(1).
 *  Same fail-closed errors as forkSnapshot itself propagate to the caller. */
function sessionRevisionOf(session: Session): string {
    const epoch = session.revisionEpoch ?? 0;
    const cache = session.pluginRevisionCache;
    if (cache && cache.epoch === epoch) return cache.revision;
    const revision = forkSnapshot(session).parentRevision;
    session.pluginRevisionCache = { epoch, revision };
    return revision;
}

function forkSnapshot(session: Session) {
    const messages = session.pluginSnapshot;
    if (!messages) throw new Error(session.metadata.publicSnapshotCapped === true ? "raw snapshot exceeded the retention cap (BILI_PUBLIC_SNAPSHOT_CAP_BYTES); fork is refused rather than retaining an unbounded raw copy" : "raw snapshot unavailable; send a fresh plugin model request");
    if (session.metadata.publicSnapshotTextComparable === false || messages.some((m) => (m.thinkingTokens ?? 0) > 0)) throw new Error("multimodal or opaque content cannot be compared by text");
    const store = contentStoreOf(session);
    const expectedStoredRefs = session.metadata.publicSnapshotStoredRefs;
    if (Array.isArray(expectedStoredRefs) && expectedStoredRefs.some((ref) => typeof ref !== "string" || !store.byRef[ref])) throw new Error("CCR original index unavailable");
    const indexedHashes = new Set(Object.values(store.byRef).map((entry) => entry.hash));
    if (Object.entries(store.byHash).some(([hash, text]) => !indexedHashes.has(hash) || typeof text !== "string" || createHash("sha256").update(text, "utf8").digest("hex") !== hash)) throw new Error("CCR original payload/index inconsistent");
    if (Object.entries(store.byRef).some(([ref, entry]) => typeof store.byHash[entry.hash] !== "string" || session.state.messageRefs.byRaw[entry.rawId] !== ref || session.state.messageRefs.byRef[ref] !== entry.rawId)) throw new Error("CCR original alias inconsistent");
    const orderedMessages = messages.map((m): ForkIdentity => {
        const ref = session.state.messageRefs.byRaw[m.id];
        if (!ref || session.state.messageRefs.byRef[ref] !== m.id) throw new Error("raw/ref mapping inconsistent");
        const entry = store.byRef[ref];
        const placeholder = m.text ? parseStoredPlaceholder(m.text) : null;
        if ((entry && (entry.rawId !== m.id || typeof store.byHash[entry.hash] !== "string")) || (placeholder && (placeholder.ref !== ref || !entry))) throw new Error("CCR original unavailable or alias inconsistent");
        return { rawId: m.id, ref, identityHash: forkMessageIdentityHash(m) };
    });
    const state = { ...session.state, imageFullRestored: session.state.imageFullRestored ?? [], imageShrinks: session.state.imageShrinks ?? [] };
    const parentRevision = forkHash({ sessionId: session.id, messages, state, blockContents: Object.fromEntries(session.blockContents), contentStore: store });
    return { protocolVersion: 1, status: "exact", sessionId: session.id, parentRevision, orderHash: forkOrderHash(orderedMessages), orderedMessages, messages: messages.map((m, i) => ({ rawId: m.id, ref: orderedMessages[i]!.ref, role: m.role, text: m.text, toolName: m.toolName, toolCallId: m.toolCallId, contentType: m.contentType, toolIsError: forkToolIsError(m) })) };
}

function resolveForkConversation(id: string): Session | undefined {
    if (peekSession(id)) return peekSession(id);
    if (getStore().loadSync(id)) return getSession(id);
    const { session, entry } = resolveConversation(id);
    if (session) return session;
    const persistedId = entry?.sessionId ?? id;
    if (!getStore().loadSync(persistedId)) return undefined;
    return getSession(persistedId);
}

function forkReply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

export async function handlePluginSnapshot(conversationId: string, res: ServerResponse): Promise<void> {
    if (!conversationId) return forkReply(res, 400, { ok: false, code: "INVALID_REQUEST", error: "conversationId is required" });
    const session = resolveForkConversation(conversationId);
    if (!session) return forkReply(res, 404, { ok: false, code: "PARENT_NOT_FOUND", error: "unknown plugin conversation" });
    acquireInFlight(session);
    try {
        await withSessionLock(session, () => forkReply(res, 200, { ok: true, conversationId, ...forkSnapshot(session) }));
    } catch (err) {
        forkReply(res, 409, { ok: false, status: "unavailable", code: "SNAPSHOT_UNAVAILABLE", error: String(err) });
    } finally {
        releaseInFlight(session);
    }
}

function parseForkRequest(payload: string): ForkRequest {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected fork object");
    const b = value as Record<string, unknown>;
    const identifier = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
    const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    if (b.protocolVersion !== 1) throw new Error("unsupported fork protocolVersion (expected 1)");
    if (!identifier(b.parentConversationId) || !identifier(b.childConversationId) || !identifier(b.idempotencyKey) || !hash(b.parentRevision)) throw new Error("invalid fork identity/revision");
    if (b.parentConversationId === b.childConversationId) throw new Error("parent and child must differ");
    const point = b.branchPoint as Record<string, unknown> | null;
    if (!point || !Number.isSafeInteger(point.messageCount) || (point.messageCount as number) < 0 || !hash(point.orderHash) || !Array.isArray(b.orderedMessages) || b.orderedMessages.length !== point.messageCount) throw new Error("invalid branchPoint/orderedMessages");
    const orderedMessages = b.orderedMessages.map((v: unknown): ForkIdentity => {
        if (!v || typeof v !== "object") throw new Error("invalid ordered identity");
        const item = v as Record<string, unknown>;
        if (!identifier(item.rawId) || typeof item.ref !== "string" || !/^m\d{5,}$/.test(item.ref) || !hash(item.identityHash)) throw new Error("invalid raw/ref identity");
        return { rawId: item.rawId, ref: item.ref, identityHash: item.identityHash };
    });
    return { protocolVersion: 1, parentConversationId: b.parentConversationId, childConversationId: b.childConversationId, parentRevision: b.parentRevision, branchPoint: { messageCount: point.messageCount as number, orderHash: point.orderHash }, orderedMessages, idempotencyKey: b.idempotencyKey };
}

/** [#2399 stage 2] omp/pi identity-register their session ids at session_start
 *  — BEFORE a fork child's first model request can trigger the extension-side
 *  adoption — so a fork POST for such a child arrives with the id already in
 *  registeredIds. That register carries the SAME parent the fork request
 *  declares, so it is a compatible lineage claim by the same host, not a rival
 *  child: allow the fork through and drop the register entry on success (the
 *  fork-created conversation then binds by the conversations map, exactly like
 *  a dsh-style child that never registered). A registered id WITHOUT a parent
 *  declaration, or with a different parent, stays a conflict. */
function forkChildHeldBySameParent(child: string, parent: string): boolean {
    return registeredIds.get(child)?.parentConversationId === parent;
}

export async function handlePluginFork(payload: string, res: ServerResponse): Promise<void> {
    let request: ForkRequest;
    try { request = parseForkRequest(payload); }
    catch (err) { return forkReply(res, 400, { ok: false, code: "INVALID_REQUEST", error: String(err) }); }
    const requestHash = forkHash(request);
    const replay = (): boolean => {
        const existing = resolveForkConversation(request.childConversationId);
        if (!existing) return false;
        const receipt = existing.metadata.publicForkReceipt as { requestHash?: unknown; response?: unknown } | undefined;
        if (receipt?.requestHash === requestHash) forkReply(res, 200, { ...(receipt.response as Record<string, unknown>), replayed: true });
        else forkReply(res, 409, { ok: false, code: "CHILD_CONFLICT", error: "child conversation already exists or idempotency payload differs" });
        return true;
    };
    if (replay()) return;
    if (conversations.has(request.childConversationId) || pendingRegisters.some((r) => r.conversationId === request.childConversationId) || (registeredIds.has(request.childConversationId) && !forkChildHeldBySameParent(request.childConversationId, request.parentConversationId))) return forkReply(res, 409, { ok: false, code: "CHILD_CONFLICT", error: "child conversation already registered" });
    const parent = resolveForkConversation(request.parentConversationId);
    if (!parent) return forkReply(res, 404, { ok: false, code: "PARENT_NOT_FOUND", error: "parent conversation not found" });
    acquireInFlight(parent);
    try {
        await withSessionLock(parent, () => {
            if (replay()) return;
            if (conversations.has(request.childConversationId) || pendingRegisters.some((r) => r.conversationId === request.childConversationId) || (registeredIds.has(request.childConversationId) && !forkChildHeldBySameParent(request.childConversationId, request.parentConversationId))) return forkReply(res, 409, { ok: false, code: "CHILD_CONFLICT", error: "child conversation already registered" });
            let snapshot: ReturnType<typeof forkSnapshot>;
            try { snapshot = forkSnapshot(parent); }
            catch (err) { return forkReply(res, 409, { ok: false, status: "unavailable", code: "SNAPSHOT_UNAVAILABLE", error: String(err) }); }
            if (snapshot.parentRevision !== request.parentRevision) return forkReply(res, 409, { ok: false, code: "PARENT_REVISION_CONFLICT", error: "parent revision changed" });
            const prefix = snapshot.orderedMessages.slice(0, request.branchPoint.messageCount);
            if (prefix.length !== request.branchPoint.messageCount || forkOrderHash(request.orderedMessages) !== request.branchPoint.orderHash || stableJson(prefix) !== stableJson(request.orderedMessages)) return forkReply(res, 409, { ok: false, code: "BRANCH_POINT_CONFLICT", error: "ordered prefix/hash does not match parent" });
            const rawIds = new Set(prefix.map((m) => m.rawId));
            const child = createSession(request.childConversationId, { ...parent.meta, label: request.childConversationId });
            const crossing = parent.state.blocks.filter((b) => b.effectiveMessageIds.some((id) => rawIds.has(id)) && !b.effectiveMessageIds.every((id) => rawIds.has(id)));
            const blocks = parent.state.blocks.filter((b) => b.effectiveMessageIds.length > 0 && b.effectiveMessageIds.every((id) => rawIds.has(id)));
            const blockIds = new Set(blocks.map((b) => b.blockId));
            const expandedChildren = new Set(crossing.flatMap((b) => b.directBlockIds));
            for (const b of [...blocks, ...crossing]) {
                const content = parent.blockContents.get(b.blockId);
                if (!content || !content.full || typeof content.full.text !== "string" || !content.full.text || b.directBlockIds.some((id) => !parent.state.blocks.some((childBlock) => childBlock.blockId === id))) return forkReply(res, 409, { ok: false, status: "unavailable", code: "PARENT_STATE_INCOMPLETE", error: "nested block/original content unavailable" });
            }
            for (const b of blocks) {
                if (b.directBlockIds.some((id) => !blockIds.has(id))) return forkReply(res, 409, { ok: false, status: "unavailable", code: "PARENT_STATE_INCOMPLETE", error: "nested block outside matched prefix" });
                child.state.blocks.push({ ...structuredClone(b), ...(expandedChildren.has(b.blockId) ? { active: false, expanded: true } : {}) });
                child.blockContents.set(b.blockId, structuredClone(parent.blockContents.get(b.blockId)!));
            }
            // Keep the issued ref namespace reserved, including dead refs, to prevent reuse.
            child.state.messageRefs = structuredClone(parent.state.messageRefs);
            for (const { rawId, ref } of prefix) {
                child.state.messageRefs.byRaw[rawId] = ref;
                child.state.messageRefs.byRef[ref] = rawId;
                if (parent.state.tokenSnapshot[ref] !== undefined) child.state.tokenSnapshot[ref] = parent.state.tokenSnapshot[ref];
            }
            child.state.nextBlockId = parent.state.nextBlockId;
            child.state.nextRunId = parent.state.nextRunId;
            child.state.lastPassIds = prefix.map((m) => m.rawId);
            child.state.rules = structuredClone(parent.state.rules);
            child.state.nextRuleId = parent.state.nextRuleId;
            child.state.hiddenOrphanRefs = parent.state.hiddenOrphanRefs?.filter((ref) => prefix.some((m) => m.ref === ref));
            // #2362: inverse of the orphan filter — a dead ref whose message IS
            // in the forked prefix is visible again in the child; refs outside
            // it stay dead (their messages are absent from the child too).
            child.state.deadRefs = parent.state.deadRefs?.filter((ref) => !prefix.some((m) => m.ref === ref));
            child.state.stats.tokensCompressed = child.state.blocks.filter((b) => b.active).reduce((sum, b) => sum + b.compressedTokens, 0);
            child.state.stats.compressionCount = blocks.length;
            if (prefix.length === snapshot.orderedMessages.length) child.state.nudge = structuredClone(parent.state.nudge);
            child.pluginSnapshot = structuredClone(parent.pluginSnapshot!.slice(0, request.branchPoint.messageCount));
            const forkView = prune(child.pluginSnapshot, child.state);
            // Hiding the original pair is safe only if its summary survives the fork.
            child.state.absorbed = structuredClone(parent.state.absorbed?.filter((a) =>
                rawIds.has(a.callMessageId) && rawIds.has(a.resultMessageId) && (
                    (a.absorbCallId !== undefined && forkView.some((m) => m.contentType === "tool-call" && m.toolCallId === a.absorbCallId)) ||
                    child.state.blocks.some((b) => b.active && !b.expanded && a.summary.length > 0 && b.summary.includes(a.summary))
                )) ?? []);
            child.lastMessages = structuredClone(child.pluginSnapshot);
            child.lastMessagesFolded = false;
            const parentStore = contentStoreOf(parent);
            for (const { ref, rawId } of prefix) {
                const entry = parentStore.byRef[ref];
                if (entry && (entry.rawId !== rawId || typeof parentStore.byHash[entry.hash] !== "string")) return forkReply(res, 409, { ok: false, status: "unavailable", code: "PARENT_STATE_INCOMPLETE", error: "CCR original unavailable or alias inconsistent" });
            }
            child.contentStore = cloneStoreForRefs(parentStore, new Set(prefix.map((m) => m.ref))) ?? undefined;
            child.metadata.publicSnapshotTextComparable = true;
            child.metadata.publicSnapshotStoredRefs = Object.keys(child.contentStore?.byRef ?? {});
            for (const key of ["pluginAgent", "lastModel", "effectiveConfig", "effectiveCcr", "effectiveContextLimit", "lastWindowSource", "systemPromptTokens"]) if (parent.metadata[key] !== undefined) child.metadata[key] = structuredClone(parent.metadata[key]);
            child.metadata.parentConversationId = request.parentConversationId;
            child.metadata.parentRevision = request.parentRevision;
            child.stats.contextTokens = prune(child.pluginSnapshot, child.state).reduce((sum, m) => sum + countMessageTokens(m), 0) + (typeof child.metadata.systemPromptTokens === "number" ? child.metadata.systemPromptTokens : 0);
            child.stats.contextTokensSource = "estimate";
            recordContextObservation(child, child.stats.contextTokens, "estimate");
            const response = { ok: true, status: crossing.length > 0 ? "expanded" : "exact", protocolVersion: 1, parentConversationId: request.parentConversationId, childConversationId: request.childConversationId, sessionId: child.id, parentRevision: request.parentRevision, childRevision: forkSnapshot(child).parentRevision, branchPoint: request.branchPoint, expandedBlocks: crossing.map((b) => b.blockId), inheritedBlocks: child.state.blocks.map((b) => ({ id: b.blockId, tier: b.tier, active: b.active, expanded: b.expanded === true })), replayed: false };
            child.metadata.publicForkReceipt = { requestHash, response };
            publishForkSession(child);
            recordPluginSession(request.childConversationId, child.id);
            // [#2399 stage 2] the host's session_start identity register claimed
            // this id with the same parent (see forkChildHeldBySameParent) — the
            // fork-created conversation supersedes it; a lingering entry would
            // re-bind plugin mode on the child's next request, which the map
            // binding already does without dragging the derived-parent path in.
            registeredIds.delete(request.childConversationId);
            remembered.set(child.id, { processed: structuredClone(child.pluginSnapshot), original: structuredClone(child.pluginSnapshot) });
            // #2077: the parent snapshot is now an external contract — this child
            // was cut from it, and later forks/replays depend on its continuity.
            // The receipt lives on the CHILD only, so without this sticky flag a
            // lazily-persisted parent would drop its snapshot on disk and the next
            // restart would 409. Flush eagerly (publishForkSession precedent) so
            // the flag and the snapshot land in one write.
            parent.metadata.publicSnapshotRetained = true;
            if (!getStore().flushSync(parent)) loggerLog("warn", `fork ${request.childConversationId}: parent snapshot flush failed (${parent.id}); the debounced save will retry`);
            forkReply(res, 201, response);
        });
    } catch (err) {
        forkReply(res, 503, { ok: false, status: "unavailable", code: "FORK_FAILED", error: String(err) });
    } finally {
        releaseInFlight(parent);
    }
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
function chainVerdictFor(conversationId: string): ChainVerdict | undefined {
    return chainVerdicts.get(conversationId);
}
export function _resetChainVerdictsForTest(): void {
    chainVerdicts.clear();
}
export function _chainVerdictMapForTest(): Map<string, ChainVerdict> {
    return chainVerdicts;
}

/** #1357 Phase 1: the /acp panel rendered when a conversation carried
 *  historical ACP content with no prior local state. That content is now
 *  ADVISORY-only — observed but NOT treated as a foreign chain, so the request
 *  was processed normally and the conversation owns its own compression session.
 *  Every /acp surface (pi / dsh / opencode) displays `panel` verbatim, so the
 *  server renders it once and all clients show it without agent-side changes. */
function chainAdvisoryPanel(v: ChainVerdict): string {
    return `ℹ️ billion-context: this conversation carried ACP-shaped content (evidence: ${v.kind}, protocol ${v.protocol}) with no prior local compression state. Historical ACP content is advisory-only (#1357) — it was NOT treated as a foreign bili chain, so the request was processed normally and this conversation owns its own compression session. Last observation: ${new Date(v.at).toISOString()}. See the [chain] warn in the bili log.`;
}

/** Browser deep link into the built-in Web UI session detail page; undefined when no
 *  usable origin was provided (tests/embeds) or the id is empty. */
function webSessionUrl(origin: string | undefined, sessionId: string): string | undefined {
    const o = typeof origin === "string" ? origin.trim().replace(/\/+$/, "") : "";
    if (o.length === 0 || sessionId.length === 0) return undefined;
    return `${o}/__bili/#/session/${encodeURIComponent(sessionId)}`;
}

export function handlePluginStatus(conversationId: string, res: import("node:http").ServerResponse, deps: PluginToolDeps, fallbackLatest = false): void {
    let session = resolveForkConversation(conversationId);
    const entry = conversations.get(conversationId);
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
        // #1357 Phase 1: a content-fallback verdict for THIS conversation means
        // requests ARE arriving and carried historical ACP content — now an
        // ADVISORY observation (processed normally), so the armed-idle notice
        // would mislead ("no model request yet" is false). Answer 200 with a
        // renderable panel; `phase` exposes the state for programmatic consumers.
        const verdict = chainVerdictFor(conversationId);
        if (verdict !== undefined) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, conversationId, phase: "chain-advisory", chain: verdict, panel: chainAdvisoryPanel(verdict), sessionId: null, sessionRevision: null, model: null, contextLimit: null, contextTokens: null, contextTokensSource: "unavailable", contextTokensAt: null, contextGeneration: null }));
            return;
        }
        // Runtime-info protocol (#955): no session exists yet, but the client
        // may have reported its model config at bootstrap — answer from the
        // agent-keyed runtime table so /acp works pre-first-request. Clients
        // without a stable conversation id before their first request probe
        // with their agent name (dsh's fetchStatusLatest sends "dsh").
        const pre = pluginRuntimeTable.get(conversationId) ?? pluginRuntimeByConversation.get(conversationId);
        if (pre !== undefined) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, conversationId, phase: "pre-first-request", model: pre.model, contextLimit: pre.contextWindow ?? null, runtimeInfo: pre, panel: null, sessionId: null, sessionRevision: null, contextTokens: null, contextTokensSource: "unavailable", contextTokensAt: null, contextGeneration: null }));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: fallbackLatest ? "no session with activity since boot — issue a model request or pass the conversation id" : "unknown plugin conversation" }));
        return;
    }
    if (entry) entry.lastSeen = Date.now();
    const limit = session.metadata.effectiveContextLimit;
    const observation = currentContextObservation(session);
    const contextTokensSource = observation?.source ?? "unavailable";
    const contextTokens = observation?.tokens ?? null;
    let sessionRevision: string | null = null;
    try { sessionRevision = sessionRevisionOf(session); } catch {}
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
        const messages = mem ? (mem.processed.length > 0 ? mem.processed : mem.original) : (session.pluginSnapshot ?? []);
        if (messages.length > 0) {
            // #833: base kernelConfig carries no file/provider/model compress
            // settings — render from the session's last resolved Config so the
            // panel matches actual injection behavior.
            const pluginCfg = effectiveConfig(session, deps.config);
            nudge = deps.core.processTurn({
                messages,
                state: session.state,
                config: ccrLoopConfig(session, pluginCfg),
                tokenCount: statusInputBaseline(session),
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
            version: `billion-context@${PROXY_VERSION}${BUILD_COMMIT && BUILD_COMMIT !== "unknown" ? ` (${BUILD_COMMIT})` : ""} · pack: ${session.meta.activePack ?? "default"}`,
            // ⚡ext marker: blocks whose summaries the external summary
            // chain wrote. Display-only set, computed from compressCallId.
            externalBlockIds: new Set(session.state.blocks.filter(isExternalSummaryBlock).map((b) => b.blockId)),
            tokenCount: statusInputBaseline(session),
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
    // Human-only deep link. Deliberately inserted BEFORE the footer line: the LLM-context
    // stripper (src/acp-panel.ts) anchors this box on its top border AND its
    // "Tag visibility" footer — anything appended after the footer would break the whole
    // message match and ship the panel into the model context.
    // #1577: an active advisory must reach the one surface native/plugin-lane
    // users actually see — the /acp panel — via the same before-footer slot the
    // Web UI link uses (the footer anchors the LLM-context stripper).
    const preFooter: string[] = [];
    const adv = getAdvisoryState();
    if (adv.active) {
        preFooter.push(`⚠️ CRITICAL ADVISORY: ${describeAdvisory(adv.active, adv.lastError)}`);
    }
    const upd = getUpdateVisibility(VERSION);
    if (upd.visible) {
        // #1870 visibility for the silent courier, #1977 display policy:
        // silent unless the span carries a critical-tier entry — one line,
        // same before-footer slot as the advisory (remote-doc text; the
        // $-escape below already covers it).
        preFooter.push(describeUpdateReady(upd));
    }
    const webUrl = webSessionUrl(deps.webOrigin, session.id);
    if (webUrl !== undefined) {
        preFooter.push(`Web UI: ${webUrl}`);
    }
    if (panel !== undefined && preFooter.length > 0) {
        // Escape $ so advisory text (remote doc content) cannot be read as
        // replace() pattern syntax ($&, $\`, $') and corrupt the box lines.
        panel = panel.replace(PANEL_BOX_FOOTER, `\n${preFooter.join("\n")}\n${PANEL_BOX_FOOTER}`.replace(/\$/g, "$$$$"));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        ok: true,
        conversationId: resolvedConversationId,
        sessionId: session.id,
        sessionRevision,
        fallback: viaFallback || undefined,
        label: session.meta.label ?? null,
        pluginAgent: session.metadata.pluginAgent ?? null,
        model: session.metadata.lastModel ?? null,
        windowSource: session.metadata.lastWindowSource ?? null,
        runtimeInfo: pluginRuntimeInfoFor(typeof session.metadata.pluginAgent === "string" ? session.metadata.pluginAgent : undefined, typeof session.metadata.lastModel === "string" ? session.metadata.lastModel : undefined)
            ?? pluginRuntimeInfoForConversation(conversationIdForSession(session.id), typeof session.metadata.lastModel === "string" ? session.metadata.lastModel : undefined)
            ?? null,
        contextLimit: typeof limit === "number" ? limit : null,
        contextTokens,
        contextTokensSource,
        contextTokensAt: observation?.at ?? null,
        contextGeneration: observation ? forkHash({ sessionId: session.id, sessionRevision, generation: observation.generation, contextTokens, contextTokensSource, limit, model: session.metadata.lastModel }) : null,
        compressCreditTokens: session.stats.compressCreditTokens ?? 0,
        inputTokens: session.stats.inputTokens,
        outputTokens: session.stats.outputTokens,
        cachedTokens: session.stats.cachedTokens,
        requests: session.stats.requests,
        blocks: session.state.blocks.map((b) => ({ id: b.blockId, tier: b.tier, active: b.active })),
        compressibleRanges: nudge?.compressibleRanges ?? null,
        panel,
        webUrl: webUrl ?? null,
        lastSeen: session.lastSeen,
    }));
}

export async function handlePluginTool(
    payload: string,
    res: import("node:http").ServerResponse,
    deps: PluginToolDeps,
): Promise<void> {
    let parsed: { conversationId?: unknown; tool?: unknown; args?: unknown; expectedRevision?: unknown; nativeCaller?: unknown };
    try {
        parsed = JSON.parse(payload) as { conversationId?: unknown; tool?: unknown; args?: unknown; expectedRevision?: unknown; nativeCaller?: unknown };
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected tool object");
    } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
        return;
    }
    const conversationId = typeof parsed.conversationId === "string" ? parsed.conversationId.trim() : "";
    const tool = typeof parsed.tool === "string" ? parsed.tool : "";
    if (parsed.expectedRevision !== undefined && (typeof parsed.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(parsed.expectedRevision))) return forkReply(res, 400, { ok: false, code: "INVALID_REQUEST", error: "expectedRevision must be a snapshot revision" });
    if (parsed.expectedRevision !== undefined && !conversationId) return forkReply(res, 400, { ok: false, code: "INVALID_REQUEST", error: "expectedRevision requires conversationId" });
    // Explicit ids never yield to another session's outbound witness. A
    // conflicting witness rejects unconfirmed ids; host-stamped ids (#2024)
    // remain authoritative. Id-less calls use a unique witness, then a single
    // fresh conversation, or fail loudly without guessing (#1685).
    const bodyArgs = parsed.args && typeof parsed.args === "object" ? parsed.args as Record<string, unknown> : {};
    // #2024/#2072: true only when the caller PROVES the body id is host-stamped
    // per-call metadata — the MCP shim's _meta.threadId, or a host-native agent's
    // own session-manager id (pi / dsh / opencode). Model-transcribed ids and
    // static env/meta bindings never set it, so witness conflicts for those
    // still fail closed.
    const nativeCaller = parsed.nativeCaller === true;
    const witnessIds = tool ? lookupToolWitness(tool, bodyArgs) : new Set<string>();
    let session: Session | undefined;
    let entry: ConversationEntry | undefined;
    let routedBy: "witness" | "body" | "arb" | "native" = "body";
    if (conversationId) {
        session = resolveForkConversation(conversationId);
        entry = conversations.get(conversationId);
        if (session && witnessIds.size > 0 && !witnessIds.has(session.id)) {
            if (!nativeCaller) return forkReply(res, 409, { ok: false, code: "TOOL_CONVERSATION_CONFLICT", error: "outbound tool witness does not match conversationId" });
            routedBy = "native";
            deps.log("warn", `[plugin] tool "${tool}": host-stamped native caller "${conversationId}" conflicts with outbound witness — honoring the native caller, refusing the witness (#2024)`);
        }
    } else if (witnessIds.size === 1) {
        const [wit] = [...witnessIds];
        session = peekSession(wit);
        if (session) {
            const cid = conversationIdForSession(session.id);
            entry = cid ? conversations.get(cid) : undefined;
            routedBy = "witness";
        }
    } else if (witnessIds.size > 1 && !conversationId) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `cannot route tool "${tool}": its (name, arguments) was witnessed in ${witnessIds.size} sessions and the request carries no conversationId — refuse to guess. Re-send with a conversationId, or bind the MCP shim (CLAUDE_CODE_SESSION_ID / BILI_CONVERSATION_ID).` }));
        return;
    }
    if (!session && !conversationId) {
        const now = Date.now();
        let fresh = 0;
        let bestCid: string | undefined;
        let bestSeen = -Infinity;
        for (const [cid, e] of conversations) {
            if (now - e.lastSeen > WITNESS_TTL_MS_PLUGIN) continue;
            fresh++;
            if (e.lastSeen > bestSeen) {
                bestSeen = e.lastSeen;
                bestCid = cid;
            }
        }
        if (bestCid && fresh === 1) {
            entry = conversations.get(bestCid);
            session = entry ? peekSession(entry.sessionId) : undefined;
            if (session) routedBy = "arb";
        } else {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `cannot route tool "${tool}": no conversationId, no outbound witness match, and ${fresh} conversation${fresh === 1 ? "" : "s"} active on this proxy — refuse to guess. Send a model message first, or bind the MCP shim (CLAUDE_CODE_SESSION_ID / BILI_CONVERSATION_ID).` }));
            return;
        }
    }
    if (!session) {
        session = resolveForkConversation(conversationId);
        entry = conversations.get(conversationId);
    }
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
        if (effectiveRulesEnabled(session, deps.config)) allowed.push(RULE_TOOL_NAME);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `unknown tool "${tool}" (expected one of: ${allowed.join(", ")})` }));
        return;
    }
    if (entry) entry.lastSeen = Date.now();
    const args = parsed.args && typeof parsed.args === "object" ? { ...(parsed.args as Record<string, unknown>) } : {};
    // #760 legacy strip, kept for compat: the manifest no longer advertises a
    // conversation_id argument (#1685), but a model trained on the old schema
    // may still echo one — strip it before kernel arg parsing sees it (the
    // witness hash in tool-ring.ts strips the same key).
    delete args.conversation_id;
    const callId = `${PLUGIN_FOLD_CALLID_PREFIX}${Date.now().toString(36)}`;
    acquireInFlight(session);
    let result: ProxyToolResult | undefined;
    try {
        result = await withSessionLock(session, async () => {
            if (parsed.expectedRevision !== undefined) {
                try {
                    if (sessionRevisionOf(session) !== parsed.expectedRevision) {
                        forkReply(res, 409, { ok: false, code: "PARENT_REVISION_CONFLICT", error: "session revision changed" });
                        return undefined;
                    }
                } catch (err) {
                    forkReply(res, 409, { ok: false, status: "unavailable", code: "SNAPSHOT_UNAVAILABLE", error: String(err) });
                    return undefined;
                }
            }
            // Read the remembered snapshot UNDER the session lock: the model
            // request rewrites remembered atomically under this same lock
            // (rememberPluginMessages), so a racing tool call sees a consistent
            // state instead of a stale/empty window.
            const mem = remembered.get(session.id);
            const messages = mem ? (mem.processed.length > 0 ? mem.processed : mem.original) : (session.pluginSnapshot ?? []);
            const before = currentContextObservation(session);
            const creditBefore = session.stats.compressCreditTokens ?? 0;
            const compressBefore = session.lastCompress;
            const pendingBefore = new Set(session.pendingRetrievals.map((p) => p.ref));
            const toolResult = await executeProxyToolAsync(tool, args, {
                core: deps.core,
                // #833: run proxy tools under the session's last resolved Config
                // (same values the wire path used), not the base kernelConfig.
                config: effectiveConfig(session, deps.config),
                messages,
                session,
                log: (m) => deps.log("info", `[${session.id}] [plugin] ${m}`),
            }, callId, undefined, deps.signal);
            const creditDelta = (session.stats.compressCreditTokens ?? 0) - creditBefore;
            const restoredInjections = session.pendingRetrievals.filter((p) => !pendingBefore.has(p.ref));
            // The string tool protocol has distinct success headers for whole/derived and range restores.
            const restored = tool === "decompress" && (/^\[Block [^\n]+ content /.test(toolResult.text) || /^\[decompress [^\n]+: restored \d+ item\(s\)/.test(toolResult.text));
            if (before && (creditDelta !== 0 || session.lastCompress !== compressBefore || restored)) {
                // Credit was already applied to lastInputTokens by the tool; do not net it twice.
                const restoredTokens = restored ? countMessageTokens({ text: toolResult.text }) + restoredInjections.reduce((sum, p) => sum + countMessageTokens(p.injection), 0) : 0;
                recordContextObservation(session, Math.max(0, before.tokens - creditDelta) + restoredTokens, "estimate");
            }
            return toolResult;
        });
    } catch (err) {
        releaseInFlight(session);
        deps.log("warn", `[${session.id}] [plugin] tool ${tool} threw: ${String(err)}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
        return;
    }
    releaseInFlight(session);
    if (result === undefined) return;
    // #760b: evidence-based plugin-mode flip. A successful MCP tool execution proves
    // this session's host owns the bili compression tools, so bind it to plugin mode
    // (sticky) — the next model request stops injecting the duplicate ephemeral wire
    // tools. Guarded: only flips a session with NO existing agent binding, never
    // overriding a pi/omp/opencode plugin or a launcher-registered agent.
    if (typeof session.metadata.pluginAgent !== "string") {
        session.metadata.pluginAgent = "mcp";
    }
    markDirty(session);
    deps.log("info", `[${session.id}] [plugin] tool ${tool} executed via plugin (routed by ${routedBy}, #1685) (${result.text.length} chars, outcome=${result.outcome ?? "n/a"}${result.reason ? `, reason=${result.reason}` : ""})`);
    // Same deep link on the /acp-cache display surfaces: clients wrap this text in
    // [acp-cache]/[/acp-cache] markers and strip it from model context by marker
    // (src/acp-panel.ts). The MCP acp_cache path shares this endpoint — one extra line
    // is harmless context and lets the model tell the user the link, too.
    let sentResult = result.text;
    if (tool === "acp_cache") {
        const wu = webSessionUrl(deps.webOrigin, session.id);
        if (wu !== undefined) sentResult = `Web UI: ${wu}\n\n${result.text}`;
    }
    // #1875: ok stays the transport/execution signal (200 = the tool ran); the
    // business effect rides additive fields so clients can distinguish an
    // accepted fold from a kernel refusal without parsing the receipt text.
    const body: Record<string, unknown> = { ok: true, tool, conversationId };
    if (result.outcome !== undefined) body.outcome = result.outcome;
    if (result.blocksCreated !== undefined) body.blocksCreated = result.blocksCreated;
    body.result = sentResult;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
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

export function applyUsageSample(session: Session, sample: UsageSample, protocol?: WireProtocol, upstreamOrigin?: string): void {
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
    if (sample.inputTokens !== undefined && total > 0) {
        // #1536: normalize undefined (provider reports no cache tokens) to null
        // so the ledger quarantines the sample instead of booking its whole
        // billed prefix as an unexplained ttlRepay residual (which reads as a
        // 0% hit rate) — mirrors recordUsage in loop/core.ts. A non-reporting
        // provider must also never feed the collapse watch.
        const reportedCached: number | null = typeof sample.cachedTokens === "number" ? sample.cachedTokens : null;
        if (reportedCached !== null) warnCacheCollapse(session, total, reportedCached);
        // #695: per-request parity with the wire path's [acp-usage] — without
        // this, post-fold cache cliffs cannot be attributed from logs.
        const hit = reportedCached === null ? undefined : Math.round((100 * reportedCached) / total);
        const foldNew = session.stats.pendingFoldUsage === true;
        if (foldNew) session.stats.pendingFoldUsage = false;
        loggerLog("info", `[${session.id}] [plugin] [acp-usage] input=${total} ${reportedCached === null ? "(no cache report)" : `cached=${reportedCached} (cache hit ${hit}%)`}${foldNew ? " fold=new" : ""}${imageUsageSuffix(session)}`);
        settleUsageReport(session, { total, reportedCached, output: sample.outputTokens, protocol, upstream: upstreamOrigin });
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

/** #2563: hosts whose native layer owns mid-stream truncation handling —
 *  bili ends the stream raw (nothing synthesized) and lets the host's own
 *  classifier + retry budget take over instead of digesting the cut into a
 *  non-retryable in-band error (#721). Evidence-permitlist, KDD-#9
 *  discipline: pi is proven (local repro — bare pi classifies a truncated
 *  SSE as transient and re-issues the turn; bili's in-band wording fell
 *  outside its transient table so every cut surfaced as a hard error).
 *  dsh/opencode/codex host-side handling is unverified → they keep the
 *  legacy in-band signal until traffic evidence says otherwise. */
const TRANSPARENT_TRUNCATION_AGENTS = new Set(["pi"]);

export function transparentTruncationApplies(session?: Session): boolean {
    const agent = session?.metadata?.pluginAgent;
    return typeof agent === "string" && TRANSPARENT_TRUNCATION_AGENTS.has(agent);
}

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
    upstreamOrigin?: string,
    // True when the outbound request carried the [ACP absorb] instruction:
    // the model may then answer with a tool call written as prose, and the
    // filters apply the whole-field emission drop (gated on request
    // provenance, not string shape — m00885).
    absorbInstructed?: boolean,
    // The shipped request text: an emission-shaped span the user asked to
    // output verbatim is echoed, not dropped (m00885).
    requestText?: string,
    // #2328 Q2: upstream HTTP status/content-type of the response this stream
    // came from, for the truncation diag. Optional so existing callers/tests
    // stay source-compatible; the plugin lane's resolveFakeCompletion refetch
    // swallows the original response object, hence optional.
    upstreamMeta?: UpstreamMeta,
): Promise<void> {
    let reader = stream.getReader();
    let decoder = new TextDecoder("utf-8");
    let buf = "";
    const acc: UsageSample = {};
    let sawStrippedEcho = false;
    // #2405(c): one warn line per event, session-prefixed — the former second
    // write through the request logger landed in the SAME tee file, doubling
    // every count taken from bili.log.
    const who = session ? `[${session.id}] ` : "";
    const onTagDrop = (snippet: string) => {
        droppedTagInFrame = true;
        sawStrippedEcho = true;
        loggerLog("warn", `${who}[tag-echo] stripped model-emitted render tag (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
    };
    // #2190: the filter released bytes that still carry echo-residue shape —
    // the leak is now observable instead of silent. Log-only; the bytes were
    // already decided by the state machine.
    const onResidueWarn = (snippet: string) => {
        loggerLog("warn", `${who}[tag-echo] filter released echo-residue-shaped bytes (#2190): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
    };
    const onMarkerDrop = (snippet: string) => {
        sawStrippedEcho = true;
        loggerLog("warn", `${who}[marker-echo] stripped model-emitted ACP confirmation marker (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
    };
    const onBiliDrop = (snippet: string) => {
        sawStrippedEcho = true;
        loggerLog("warn", `${who}[bili-artifact] stripped model-emitted internal artifact (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
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
            // #1960/KDD#10: signed thinking (Anthropic `thinking_delta`, Gemini
            // `thought` parts) must ride byte-for-byte — any rewrite desyncs its
            // signature and bricks replay. Route it through an identity filter
            // instead of the prose filters (matches the loop adapters).
            // Unified ACP invariant (#2229): the same treatment extends to the
            // openai reasoning fields — the thinking channel is NEVER
            // rewritten, only the visible text channel is.
            const signedThinking = field === "thinking" || (protocol === "openai" && (field === "reasoning_content" || field === "reasoning"));
            s = { filter: signedThinking ? createIdentityStreamFilter() : composeStreamFilters(composeStreamFilters(createTagEchoFilter(onTagDrop, onResidueWarn, absorbInstructed, requestText), createMarkerLineFilter(onMarkerDrop)), createBiliArtifactFilter(onBiliDrop)), field, index };
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
    // #2328 Q2/Q4: termination diagnostics — every truncation emit below
    // carries these on the in-band error frame (meta) and the log line.
    let diagEvents = 0;
    let diagBytes = 0;
    let diagUnparseable = 0;
    const diagLastTypes: string[] = [];
    const diagPushType = (label: string) => {
        diagLastTypes.push(label);
        if (diagLastTypes.length > 5) diagLastTypes.shift();
    };
    // #1501 option C: tool-call observations on this verbatim lane, keyed per
    // protocol (openai: choice:toolIndex, anthropic: block:N, google:
    // candidate/part). Bytes are forwarded untouched (#1039); the tracker only
    // settles a once-per-response warn when upstream emits a call whose name
    // never arrives (#1484 class), so the observed rate can settle the
    // drop-vs-keep policy without touching fidelity.
    // #1501 option C — now also the #1685 witness feed: `args` accumulates the
    // full argument JSON (observe-only; bytes are still forwarded verbatim per
    // #1039) so settleWitnesses can ring-record each complete tool call for
    // id-less MCP routing.
    const seenToolCalls = new Map<string, { label: string; id: string; name: string; argsLen: number; frags: number; args: string }>();
    const settleWitnesses = () => {
        if (!session) return;
        for (const tc of seenToolCalls.values()) {
            if (tc.name.length === 0) continue;
            recordToolWitness(session.id, tc.name, tc.args);
        }
    };
    // Degenerate-turn retry (#732/#821 for this pipe). The first attempt's
    // terminal event is dropped when the retry takes over, so the client sees
    // one turn: its framing stays open, and the retry's content blocks are
    // shifted past the ones already streamed.
    let degenerateRetried = false;
    let truncationRetried = false;
    let forwardedAny = false;
    let inRetry = false;
    let retryIndexOffset = 0;
    let blocksForwarded = 0;
    /** One-shot re-issue when a turn reaches its terminal with nothing visible:
     *  the tag-echo case, where the filter empties the only text block and the
     *  host aborts an empty completed turn. Returns true when the retry stream
     *  took over, in which case the caller drops the terminal event of the
     *  attempt it came from. Consults truncationRetried: a request whose stream
     *  already spent its one re-issue on a zero-visible cut (#2171) cannot also
     *  re-send on a degenerate completion — one re-issue per request, total. */
    const retryEmptyTurn = async (reason: string | undefined): Promise<boolean> => {
        if (refetch === undefined || truncationRetried) return false;
        // #2303: a terminal turn whose visible prose ends with a compression-draft
        // closing tag and no tool call is non-converged even though it has visible
        // text — the model wrote a handoff/compression draft in prose instead of
        // issuing the action it described (149 silent stops / 70 sessions, DSH
        // native). Treat it like the empty-turn shape below so at worst the client
        // gets one extra continuation instead of losing the whole turn.
        // #2612: the request's OWN instruction can make this shape the correct
        // answer — a client compaction asking for a plain-text <summary> block
        // must not be retried (its compliant reply IS a draft tail).
        const draftTail = visibleTextChars > 0 && !sawToolUse && endsWithDraftClose(proseAcc) && !requestExpectsProseSummary(requestText);
        // Markup released from a held span carries nothing the host can act on:
        // an unclosed render tag stalls the turn exactly like an empty one.
        if (!draftTail && (visibleTextChars > releasedMarkupChars || sawToolUse)) return false;
        if (reason === undefined || !CLEAN_TURN_REASONS.has(reason)) return false;
        if (res.destroyed || res.writableEnded) return false;
        if (degenerateRetried) {
            // The retry degenerated too. An empty turn is indistinguishable from a
            // model that produced nothing and the session reads as idle while it is
            // dead, so the client gets an error the host would never surface (#870).
            log?.("[plugin] degenerate terminal turn again after the retry; emitting an in-band error (#870)");
            // #870 deliberately chose a COMPLETED turn carrying the error text (visible to the host); keep the legacy shape here regardless of the global streamErrorShape default.
            emitStreamError(res, protocol, "the turn degenerated again after the continuation nudge", undefined, "completion");
            return true;
        }
        // A turn the model left genuinely bare — no thought, no stripped echo,
        // no released markup — is the upstream's own empty answer, not a stall:
        // re-issuing it double-bills an empty completion (#732/#821 keep the
        // same boundary in the compress loop). A draft-tail turn is NOT bare:
        // it delivered a full handoff draft, which is precisely the stall signal.
        if (!sawThinking && !sawStrippedEcho && releasedMarkupChars === 0 && !draftTail) return false;
        degenerateRetried = true;
        log?.(draftTail
            ? "[plugin] terminal turn ends with a compression-draft closing tag and no tool call; retrying once with a continuation nudge (#2303)"
            : "[plugin] degenerate terminal turn (no usable output); retrying once with a continuation nudge (#732/#821)");
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
    /** #2171: one-shot re-issue when the upstream stream dies having delivered
     *  NOTHING client-visible (only SSE keep-alive comments, which are
     *  protocol-invisible). The observed relay failure accepts the request,
     *  returns 200 + event-stream headers, never emits a single data frame,
     *  and is cut ~180s later by its no-first-byte timeout; a manual re-send
     *  of the identical request always heals with a warm prefix cache, and the
     *  hung attempt never produced a usage frame, so the retry is
     *  unambiguously safe: no duplication risk (nothing was delivered), no
     *  side effects (stateless completion), zero billing for the dead attempt.
     *  Shares the single stream-level re-issue budget with retryEmptyTurn so a
     *  request re-sends at most once; anything parsed, held, or written keeps
     *  the #721 in-band error (partial content must not be regenerated). */
    const retryZeroByteCut = async (): Promise<boolean> => {
        if (refetch === undefined) return false;
        if (degenerateRetried || truncationRetried) return false;
        // Zero-visible predicate: no framing opened, no content block started,
        // no prose accumulated or held by the tag filter, no unparseable frame
        // forwarded verbatim, no partial SSE event left in the buffer.
        if (sawThinking || sawToolUse || blocksForwarded > 0 || visibleTextChars > 0 ||
            proseAcc.length > 0 || streams.size > 0 || forwardedAny || buf.length > 0) return false;
        if (res.destroyed || res.writableEnded) return false;
        let next: ReadableStream<Uint8Array> | null = null;
        try {
            next = await refetch();
        } catch (e) {
            log?.(`[plugin] zero-byte cut retry failed (${e instanceof Error ? e.message : String(e)}); falling through to the truncation signal (#2171)`);
            return false;
        }
        if (!next) return false;
        truncationRetried = true;
        log?.("[plugin] upstream stream cut after headers with zero visible output; re-issuing the request once (#2171)");
        sawTerminal = false;
        finalFinishReason = undefined;
        streams.clear();
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
    // #2328 Q2/Q4: the diag snapshot riding every truncation emit below. Built
    // at emit time so the counters reflect the final (possibly retried)
    // attempt; `buf` is whatever partial SSE event the cut left dangling.
    const buildTruncationDiag = (cause: "eof" | "read-error"): TruncationDiag => ({
        cause,
        classification: buf.length > 0 && tailLooksTerminal(buf, protocol) ? "terminal-bytes-unrecognized" : "no-terminal-seen",
        protocol,
        events: diagEvents,
        unparseableForwarded: diagUnparseable,
        bytes: diagBytes,
        lastEventTypes: [...diagLastTypes],
        eofBufferBytes: buf.length,
        ...(buf.length > 0 ? { eofBufferHead: buf.slice(0, 80).replace(/[\r\n]+/g, "\\n") } : {}),
        ...(finalFinishReason !== undefined ? { finishReason: finalFinishReason } : {}),
        visibleChars: visibleTextChars,
        sawStrippedEcho,
        retryZeroByteCutSpent: truncationRetried,
        retryDegenerateSpent: degenerateRetried,
        ...(upstreamMeta?.status !== undefined ? { upstreamStatus: upstreamMeta.status } : {}),
        ...(upstreamMeta?.contentType !== undefined ? { upstreamContentType: upstreamMeta.contentType } : {}),
    });
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
                    // #1760: a released tail is preserved content unless its bytes
                    // are orphan markup — counting held CJK prose as residue made
                    // every single-line non-ASCII answer read as degenerate.
                    if (isOrphanMarkupText(tail)) releasedMarkupChars += tail.length;
                }
            }
        }
        return out;
    };
    // #1546: resolve ONE (field, index) stream's held tail without touching the
    // others. A terminal frame folds its own fields' tails into their deltas so
    // the finish marker lands after every byte of that field — flushing them as
    // separate synthetic chunks ahead of the frame would reorder a tail that was
    // held from THIS frame's own text (e.g. "hello <a" → "<a" before "hello ").
    const flushFieldTail = (field: string, index: number): string => {
        const s = streams.get(`${field}:${index}`);
        return s ? s.filter.flush() : "";
    };
    const write = (s: string) => {
        if (res.destroyed || res.writableEnded) return;
        forwardedAny = true;
        if (!res.write(Buffer.from(s, "utf8"))) {
            return awaitDrain(res);
        }
    };
    // #411: an aborted read (client cancel / upstream cut) must still land the
    // usage sniffed so far — anthropic message_start reports input_tokens
    // before any prose, and dropping it froze lastInputTokens at the previous
    // turn's value, corrupting every later nudge decision.
    const settleUsage = () => {
        if (!session) return;
        if (acc.inputTokens !== undefined || acc.outputTokens !== undefined || acc.cachedTokens !== undefined || acc.creationTokens !== undefined) {
            applyUsageSample(session, acc, protocol, upstreamOrigin);
            markDirty(session);
        }
        // #1595: clean completion but no input usage sample — name it (the
        // cut-stream paths below have sawTerminal=false, so they stay
        // distinguishable from transport failures).
        if (sawTerminal && acc.inputTokens === undefined) diagnoseSuccessWithoutUsage(session, `plugin-passthrough-${protocol}`);
    };
    // #498: whether a terminal event ([DONE] / message_stop) was seen. A
    // stream that ends without one was cut mid-flight.
    let sawTerminal = false;
    const maybeWarnDegenerate = () => {
        if (!sawTerminal || res.destroyed || res.writableEnded) return;
        let inputChars = 0;
        let dropCount = 0;
        let dropped = false;
        for (const s of streams.values()) {
            const st = s.filter.stats();
            inputChars += st.inputChars;
            dropCount += st.dropCount;
            dropped = dropped || st.dropped;
        }
        const msg = degenerateTurnWarning({
            reason: finalFinishReason,
            terminalReason: protocol === "anthropic" ? "end_turn" : protocol === "google" ? "STOP" : "stop",
            toolCalls: sawToolUse ? 1 : 0,
            text: { inputChars, outputChars: visibleTextChars, dropped, dropCount },
            sawThinking,
            wire: `plugin-passthrough-${protocol}`,
        });
        if (msg) loggerLog("warn", `${who}${msg}`);
    };
    // #1368: parity with the proxy pipe's #361 detector (src/server.ts) — model
    // prose carrying tool-call-shaped XML (a call drafted as literal text) is
    // logged once per request for attribution. Warn only: stripping is
    // forbidden, a shape-based match cannot tell an echo from legitimate prose
    // discussing such markup (#295/#361). Off the per-frame hot path by design.
    const maybeWarnProtocolFragment = () => {
        if (proseAcc.length === 0 || !containsToolCallXmlFragment(proseAcc)) return;
        loggerLog("warn", `${who}[tag-echo] detected: plugin passthrough response text contains tool-call XML fragment (possible tag echo; left untouched)`);
    };
    // #1501 option C: once-per-response visibility into nameless tool calls on
    // this verbatim lane (#1484 class). Bytes stay untouched (#1039); the warn
    // exists so the observed rate settles the drop-vs-keep policy without
    // touching fidelity — light, not surgery (BLIND TUNNEL WARNING pattern #897).
    const maybeWarnNamelessToolCalls = () => {
        const nameless = [...seenToolCalls.values()].filter((tc) => tc.name.length === 0);
        if (nameless.length === 0) return;
        const parts = nameless.map((tc) => `${tc.label}${tc.id ? ` id=${tc.id}` : ""} argsLen=${tc.argsLen} frags=${tc.frags}`).join(" | ");
        loggerLog("warn", `${who}[plugin] nameless tool call(s) forwarded verbatim (${protocol}, ${nameless.length}): ${parts} (#1501 observe-only)`);
    };
    // #2405(c): per-response strip total. The one-shot detail line above only
    // proves stripping happened at least once; this makes the full count
    // observable for coverage acceptance without logging every event. n==1 is
    // already fully described by its detail line, so stay silent there. The
    // guard mirrors the adapter twins: the terminal sequence and the catch
    // path both call this, so a throw between the two must not double-log.
    let stripSummarized = false;
    const maybeSummarizeStrips = () => {
        if (stripSummarized) return;
        stripSummarized = true;
        let total = 0;
        for (const s of streams.values()) total += s.filter.stats().dropCount;
        if (total > 1) loggerLog("warn", `${who}[tag-echo] stripped ${total} occurrence(s) total in this response`);
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
            // #2190: no-choices frames bypass the state machine — audit them.
            // No tool_calls exclusion needed: arguments live under choices.
            auditRawForward(rawEvent);
            return anyPending() ? flushTails() + rawEvent + "\n\n" : rawEvent + "\n\n";
        }
        let rebuilt: Record<string, unknown> | null = null;
        let droppedText = false;
        let keptText = false;
        let hadText = false;
        // #1546: a frame carrying a non-null finish_reason is terminal — its held
        // tails must be drained before it reaches the client, never after.
        let isTerminal = false;
        for (let ci = 0; ci < choices.length; ci++) {
            const ch = choices[ci] as Record<string, unknown> | null;
            // #2405: an EMPTY finish_reason is not terminal — relays exist that stamp
            // finish_reason:"" on every chunk; treating it as terminal folds the held
            // render-tag tail on each event, releasing fragments before they can be
            // recognized and silently disabling stripping.
            if (ch && typeof ch["finish_reason"] === "string" && ch["finish_reason"] !== "") {
                finalFinishReason = ch["finish_reason"] as string;
                isTerminal = true;
            }
            const d = ch?.["delta"];
            if (!d || typeof d !== "object") continue;
            const dd = d as Record<string, unknown>;
            if (dd["tool_calls"] !== undefined) {
                sawToolUse = true;
                // #1501 observe-only: accumulate fragments per tool-call index;
                // the stream-end settle warns when a name never arrives (#1484).
                if (Array.isArray(dd["tool_calls"])) {
                    for (let ti = 0; ti < dd["tool_calls"].length; ti++) {
                        const tcf = dd["tool_calls"][ti];
                        if (!tcf || typeof tcf !== "object") continue;
                        const t = tcf as Record<string, unknown>;
                        const tIdx = typeof t["index"] === "number" ? t["index"] : ti;
                        const key = `${ci}:${tIdx}`;
                        const accTc = seenToolCalls.get(key) ?? { label: `idx=${tIdx}`, id: "", name: "", argsLen: 0, frags: 0, args: "" };
                        if (typeof t["id"] === "string" && t["id"]) accTc.id = t["id"];
                        const fn = t["function"];
                        if (fn && typeof fn === "object") {
                            const f = fn as Record<string, unknown>;
                            if (typeof f["name"] === "string") accTc.name += f["name"];
                            if (typeof f["arguments"] === "string") {
                                accTc.argsLen += f["arguments"].length;
                                accTc.args += f["arguments"];
                            }
                        }
                        accTc.frags++;
                        seenToolCalls.set(key, accTc);
                    }
                }
            }
            // #1039 invariant: tool_calls fragments in this delta are user
            // intent and pass through untouched — only the text fields below
            // are ever stripped (see tag-echo-filter.ts header).
            for (const field of ["content", "reasoning_content", "reasoning"]) {
                const v = dd[field];
                if (typeof v !== "string") continue;
                // #1546: an empty-string field carries no text — treating it as
                // text blocked the no-text flush path and let a terminal frame
                // leap ahead of a held tail.
                if (v.length > 0) hadText = true;
                if (field !== "content" && v.length > 0) sawThinking = true;
                // An absorb-instructed request may carry a whole-field
                // tool-call emission: route it to the filter so the
                // whole-field decision runs (m00885). Degenerate-close
                // residue (#2190) rides the same routing.
                if (!mayStartRenderTag(v) && !mayStartMarkerLine(v) && !mayStartBiliInternal(v) && !mayStartDegenerateRenderTag(v) && !(absorbInstructed === true && mayStartToolCallEmission(v)) && !anyPending()) {
                    if (v.length > 0) {
                        keptText = true;
                        proseAcc += v;
                        // #2190: residue audit — bytes that bypassed the state
                        // machine must be observable, not silent.
                        if (containsEchoResidue(v)) loggerLog("warn", `[tag-echo] fast path forwarded echo-residue-shaped bytes (#2190): ${v.slice(0, 80).replace(/\n/g, " ")}`);
                    }
                    if (field === "content") visibleTextChars += v.length;
                    continue;
                }
                const index = typeof ch?.["index"] === "number" ? ch["index"] : ci;
                const [released, pushedChanged] = pushField(field, index, v);
                let clean = released;
                let changed = pushedChanged;
                if (isTerminal) {
                    // Fold this field's held tail into its own delta so the finish
                    // marker lands after every byte of the field (#1546).
                    const tail = flushFieldTail(field, index);
                    if (tail.length > 0) {
                        clean = released + tail;
                        changed = true;
                        proseAcc += tail;
                    }
                }
                if (clean.length === 0) droppedText = true;
                else {
                    keptText = true;
                    if (field === "content") {
                        visibleTextChars += clean.length;
                        // #1760: the folded tail is residue only when its bytes are
                        // orphan markup (e.g. an unclosed-tag interior); a plain-
                        // prose tail is preserved content (#1546's unconditional
                        // count misfired on single-line non-ASCII answers).
                        const tailLen = clean.length - released.length;
                        if (tailLen > 0 && isOrphanMarkupText(clean.slice(released.length))) releasedMarkupChars += tailLen;
                        // What a dropped tag leaves behind is its own interior: the
                        // host finds no tool call in it and stalls the turn.
                        if (droppedTagInFrame) {
                            releasedMarkupChars += released.length;
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
        // #1546: a terminal frame must reach the client only after every held
        // tail is drained. Tails of fields THIS frame carried were folded into
        // their deltas above; drain whatever remains (other fields/choices) as
        // synthetic chunks ahead of the frame so nothing lands after finish.
        const drain = isTerminal && anyPending() ? flushTails() : "";
        if (rebuilt) {
            // Delta carried no visible text after stripping: drop the whole
            // chunk instead of forwarding an empty content delta. Only when
            // EVERY managed text field emptied out — a sibling field with real
            // content must survive (#463).
            if (droppedText && !keptText && !hadTextOtherThanTextFields(rebuilt["choices"])) {
                return "";
            }
            return drain + rebuildEvent(rawEvent, rebuilt);
        }
        // #2190: these exits forward frames whose text lived outside the
        // managed fields — audit them (argument frames excluded: #1039).
        if (!openaiFrameHasToolCalls(choices)) auditRawForward(rawEvent);
        if (drain.length > 0) return drain + rawEvent + "\n\n";
        if (!hadText && anyPending()) return flushTails() + rawEvent + "\n\n";
        return rawEvent + "\n\n";
    };
    const processAnthropic = (ev: Record<string, unknown>, rawEvent: string): string => {
        if (ev["type"] === "content_block_start") {
            const cb = ev["content_block"] as Record<string, unknown> | undefined;
            const bt = cb && typeof cb === "object" ? cb["type"] : undefined;
            if (bt === "tool_use") {
                sawToolUse = true;
                // The start block carries the full name, so absence is final (#1501).
                const blockIndex = typeof ev["index"] === "number" ? ev["index"] : 0;
                seenToolCalls.set(`block:${blockIndex}`, {
                    label: `block=${blockIndex}`,
                    id: cb && typeof cb["id"] === "string" ? cb["id"] : "",
                    name: cb && typeof cb["name"] === "string" ? cb["name"] : "",
                    argsLen: 0,
                    frags: 1,
                    args: "",
                });
            } else if (bt === "thinking" || bt === "redacted_thinking") sawThinking = true;
            // #2248: raw exit — content_block_start payloads never enter the filter.
            auditRawForward(rawEvent);
            return anyPending() ? flushTails() + rawEvent + "\n\n" : rawEvent + "\n\n";
        }
        if (ev["type"] !== "content_block_delta") {
            // #2248: raw exit — non-delta events never enter the filter.
            auditRawForward(rawEvent);
            return anyPending() ? flushTails() + rawEvent + "\n\n" : rawEvent + "\n\n";
        }
        const d = ev["delta"] as Record<string, unknown> | undefined;
        const index = typeof ev["index"] === "number" ? ev["index"] : 0;
        // input_json_delta (tool-call arguments) is deliberately unmanaged:
        // #1039 — argument bytes are user intent, forwarded verbatim.
        if (d?.["type"] === "input_json_delta") {
            const accTc = seenToolCalls.get(`block:${index}`);
            if (accTc && typeof d["partial_json"] === "string") {
                accTc.argsLen += d["partial_json"].length;
                accTc.args += d["partial_json"];
            }
        }
        const field = d?.["type"] === "thinking_delta" ? "thinking" : d?.["type"] === "text_delta" ? "text" : null;
        if (field === null || typeof d?.[field] !== "string") {
            // #2248: raw exit — unmanaged delta types never enter the filter.
            // input_json_delta excluded: tool-call arguments are user intent (#1039).
            if (d?.["type"] !== "input_json_delta") auditRawForward(rawEvent);
            return rawEvent + "\n\n";
        }
        const raw = d[field] as string;
        if (field === "thinking" && raw.length > 0) sawThinking = true;
        // Whole-field tool-call emission on an absorb-instructed request
        // (m00885): the filter's field-start hold decides on the complete
        // field, so the fast path must not pre-empt it.
        if (!mayStartRenderTag(raw) && !mayStartMarkerLine(raw) && !mayStartBiliInternal(raw) && !mayStartDegenerateRenderTag(raw) && !(absorbInstructed === true && mayStartToolCallEmission(raw)) && !anyPending()) {
            if (raw.length > 0) {
                proseAcc += raw;
                // #2190: residue audit — see the twin above.
                if (containsEchoResidue(raw)) loggerLog("warn", `[tag-echo] fast path forwarded echo-residue-shaped bytes (#2190): ${raw.slice(0, 80).replace(/\n/g, " ")}`);
            }
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
            // #2248: raw exit — non-candidates frames never enter the filter.
            auditRawForward(rawEvent);
            return anyPending() ? flushTails() + rawEvent + "\n\n" : rawEvent + "\n\n";
        }
        let rebuilt: Record<string, unknown> | null = null;
        let droppedText = false;
        let keptText = false;
        let hadText = false;
        // #1546: a chunk carrying finishReason is terminal — its held tails must
        // be drained before it reaches the client, never after.
        let isTerminal = false;
        for (let ci = 0; ci < candidates.length; ci++) {
            const cand = candidates[ci] as Record<string, unknown> | null;
            if (!cand || typeof cand !== "object") continue;
            // #2405: same relay quirk on the Gemini wire — empty finishReason is not terminal.
            if (typeof cand["finishReason"] === "string" && cand["finishReason"] !== "") {
                // Gemini's terminal event IS this chunk — the client throws when
                // a stream ends without one, so `lastChunkMeta` carries it for
                // the synthetic tail (see syntheticTail).
                finalFinishReason = cand["finishReason"] as string;
                sawTerminal = true;
                lastChunkMeta = { ...lastChunkMeta, finishReason: finalFinishReason };
                isTerminal = true;
            }
            const content = cand["content"];
            if (!content || typeof content !== "object") continue;
            const parts = (content as Record<string, unknown>)["parts"];
            if (!Array.isArray(parts)) continue;
            const index = typeof cand["index"] === "number" ? cand["index"] : ci;
            for (let pi = 0; pi < parts.length; pi++) {
                const p = parts[pi] as Record<string, unknown> | null;
                if (!p || typeof p !== "object") continue;
                if (p["functionCall"] !== undefined) {
                    sawToolUse = true;
                    // Gemini delivers functionCall whole in one part, so a missing
                    // name is final here (#1501). Observe-only — bytes untouched.
                    const fcObj = p["functionCall"] && typeof p["functionCall"] === "object" ? p["functionCall"] as Record<string, unknown> : undefined;
                    const fcArgs = fcObj && fcObj["args"] !== null && typeof fcObj["args"] === "object" ? JSON.stringify(fcObj["args"]) : "";
                    seenToolCalls.set(`cand:${ci}/part:${pi}`, {
                        label: `candidate=${ci}/part=${pi}`,
                        id: "",
                        name: fcObj && typeof fcObj["name"] === "string" ? fcObj["name"] : "",
                        argsLen: fcArgs.length,
                        frags: 1,
                        args: fcArgs,
                    });
                }
                if (p["thought"] === true) sawThinking = true;
                const raw = p["text"];
                if (typeof raw !== "string") continue;
                // #1546: an empty-string part carries no text — see processOpenai.
                if (raw.length > 0) hadText = true;
                // A reasoning part streams through the same machine under its own
                // field, so an interleaved thought/text pair in one frame never
                // shares held-back state.
                const field = p["thought"] === true ? "thinking" : "text";
                // Whole-field tool-call emission on an absorb-instructed
                // request (m00885) — see processOpenai. Degenerate-close
                // residue (#2190) rides the same routing.
                if (!mayStartRenderTag(raw) && !mayStartMarkerLine(raw) && !mayStartBiliInternal(raw) && !mayStartDegenerateRenderTag(raw) && !(absorbInstructed === true && mayStartToolCallEmission(raw)) && !anyPending()) {
                    if (raw.length > 0) {
                        keptText = true;
                        proseAcc += raw;
                        // #2190: residue audit — see the twin above.
                        if (containsEchoResidue(raw)) loggerLog("warn", `[tag-echo] fast path forwarded echo-residue-shaped bytes (#2190): ${raw.slice(0, 80).replace(/\n/g, " ")}`);
                    }
                    if (field === "text") visibleTextChars += raw.length;
                    continue;
                }
                const [released, pushedChanged] = pushField(field, index, raw);
                let clean = released;
                let changed = pushedChanged;
                if (isTerminal) {
                    // Fold this part's held tail into its own text so the
                    // finishReason lands after every byte of the part (#1546).
                    const tail = flushFieldTail(field, index);
                    if (tail.length > 0) {
                        clean = released + tail;
                        changed = true;
                        proseAcc += tail;
                    }
                }
                if (clean.length === 0) droppedText = true;
                else {
                    keptText = true;
                    if (field === "text") {
                        visibleTextChars += clean.length;
                        // #1760: residue only for markup-shaped tails, like the
                        // openai fold and flushTails.
                        const tailLen = clean.length - released.length;
                        if (tailLen > 0 && isOrphanMarkupText(clean.slice(released.length))) releasedMarkupChars += tailLen;
                    }
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
        // #1546: drain held tails ahead of the terminal (finishReason) chunk so
        // nothing lands after it — parts THIS chunk carried were folded above.
        const drain = isTerminal && anyPending() ? flushTails() : "";
        if (rebuilt) {
            // Text carried was entirely stripped away: drop the whole chunk
            // instead of forwarding an empty text part — but only when EVERY
            // managed part emptied out and the frame carries nothing else (a
            // finishReason / functionCall / usageMetadata sibling must survive,
            // the chat processor's #463 rule).
            if (droppedText && !keptText && !googleFrameHasNonText(rebuilt)) return "";
            return drain + rebuildEvent(rawEvent, rebuilt);
        }
        // #2248: raw exit — text outside managed parts never enters the filter.
        // Frames carrying non-text parts (functionCall/functionResponse, ...) hold
        // structured or user data (#1039) and are excluded from the audit.
        if (!googleFrameHasNonText(ev)) auditRawForward(rawEvent);
        if (drain.length > 0) return drain + rawEvent + "\n\n";
        if (!hadText && anyPending()) return flushTails() + rawEvent + "\n\n";
        return rawEvent + "\n\n";
    };
    try {
        let pendingFinal: string | null = null;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                // #2171: an EOF with nothing client-visible yet is safely
                // re-issuable — try the one-shot retry before giving up.
                if (!sawTerminal && !res.destroyed && !res.writableEnded && (await retryZeroByteCut())) continue;
                // #2323: a CRLF/lone-CR whose final byte arrived last is held back
                // by the streaming normalizer; resolve it and re-drive the completed
                // event through the same path below before deciding truncation.
                const resolved = finalizeSseLineEndings(buf);
                if (resolved === buf) break;
                buf = "";
                pendingFinal = resolved;
            } else {
                if (value && value.length > 0) diagBytes += value.byteLength;
                pendingFinal = value && value.length > 0 ? decoder.decode(value, { stream: true }) : null;
            }
            if (pendingFinal !== null) {
                buf = normalizeSseLineEndings(buf + pendingFinal);
                let idx: number;
                while ((idx = buf.indexOf("\n\n")) !== -1) {
                    const rawEvent = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const dataLines = rawEvent.split("\n").filter((l) => l.startsWith("data:"));
                    if (dataLines.length === 0) continue;
                    const jsonStr = dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n").trim();
                    if (!jsonStr) continue;
                    if (jsonStr === "[DONE]") {
                        diagEvents++;
                        diagPushType("[DONE]");
                        sawTerminal = true;
                        await write(flushTails() + rawEvent + "\n\n");
                        continue;
                    }
                    let ev: Record<string, unknown>;
                    try {
                        ev = JSON.parse(jsonStr) as Record<string, unknown>;
                    } catch {
                        diagEvents++;
                        diagUnparseable++;
                        diagPushType("unparseable");
                        // #2190: unparseable frames bypass every filter — audit them.
                        auditRawForward(rawEvent);
                        await write(rawEvent + "\n\n");
                        continue;
                    }
                    diagEvents++;
                    // #2328: wire-native label where one exists; the chat wires
                    // without a `type` get a synthesized one so the last-events
                    // trail is readable in the diag.
                    if (protocol === "anthropic") diagPushType(typeof ev["type"] === "string" ? ev["type"] as string : "frame");
                    else if (protocol === "openai") {
                        const c0 = Array.isArray(ev["choices"]) ? (ev["choices"] as unknown[])[0] : undefined;
                        const fr = c0 && typeof c0 === "object" ? (c0 as Record<string, unknown>)["finish_reason"] : undefined;
                        diagPushType(typeof fr === "string" ? `chunk:finish=${fr}` : "chunk");
                    } else if (protocol === "google") {
                        const c0 = Array.isArray(ev["candidates"]) ? (ev["candidates"] as unknown[])[0] : undefined;
                        const fr = c0 && typeof c0 === "object" ? (c0 as Record<string, unknown>)["finishReason"] : undefined;
                        diagPushType(typeof fr === "string" ? `chunk:finish=${fr}` : "chunk");
                    } else diagPushType("frame");
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
            if (done) break;
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
        maybeWarnNamelessToolCalls();
        maybeSummarizeStrips();
        settleWitnesses();
        if (truncated) {
            // #721 → #2563: the client still owns the stream from here.
            // Permitlist hosts (pi) get the raw cut — their native layer
            // classifies it as transient and retries; everyone else gets the
            // in-band truncation signal.
            emitUpstreamTruncation(res, protocol, finalFinishReason !== undefined, log, buildTruncationDiag("eof"), transparentTruncationApplies(session));
            return;
        }
    } catch (e) {
        settleUsage();
        maybeWarnNamelessToolCalls();
        maybeSummarizeStrips();
        settleWitnesses();
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
        loggerLog("warn", `[plugin] upstream stream read failed (${protocol}): ${String(e instanceof Error ? e.message : e)} — truncation signal path`);
        emitUpstreamTruncation(res, protocol, finalFinishReason !== undefined, log, buildTruncationDiag("read-error"), transparentTruncationApplies(session));
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
        // #2405: an empty finish_reason carries nothing the client needs.
        if (typeof ch["finish_reason"] === "string" && ch["finish_reason"] !== "") return true;
        const d = ch["delta"] as Record<string, unknown> | undefined;
        if (!d) continue;
        for (const k of Object.keys(d)) {
            if (k !== "content" && k !== "reasoning_content" && k !== "reasoning") return true;
        }
    }
    return false;
}

// #2190: residue audit for frames forwarded verbatim by a raw exit — i.e. a
// frame whose text lives OUTSIDE the managed fields (or is not parseable) and
// therefore never touches the tag-echo state machine. Log-only: the bytes are
// forwarded exactly as received (#1039 wire fidelity); the point is that such
// a leak is observable in the log instead of silent.
function auditRawForward(rawEvent: string): void {
    if (containsEchoResidue(rawEvent)) {
        loggerLog("warn", `[tag-echo] raw forward carried echo-residue-shaped bytes (#2190): ${rawEvent.slice(0, 80).replace(/\n/g, " ")}`);
    }
}

// #2190 companion to auditRawForward: tool-call argument fragments are user
// intent (#1039) and may legitimately match the residue shape, so frames
// carrying them are excluded from the audit.
function openaiFrameHasToolCalls(choices: unknown): boolean {
    if (!Array.isArray(choices)) return false;
    for (const c of choices) {
        const d = c && typeof c === "object" ? (c as Record<string, unknown>)["delta"] : undefined;
        if (d && typeof d === "object" && (d as Record<string, unknown>)["tool_calls"] !== undefined) return true;
    }
    return false;
}

// #2248 companion to auditRawForward (responses wire): tool-call argument
// streams (response.function_call_arguments.*, response.custom_tool_call_input.*)
// fall through the unrecognized-type exit and are user intent (#1039) — exclude.
function responsesFrameHasToolCalls(ev: Record<string, unknown>): boolean {
    const t = ev["type"];
    if (typeof t === "string" && (t.includes("function_call") || t.includes("custom_tool_call"))) return true;
    if (ev["arguments"] !== undefined) return true;
    const item = ev["item"];
    if (item && typeof item === "object") {
        const it = (item as Record<string, unknown>)["type"];
        if (it === "function_call" || it === "custom_tool_call") return true;
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
        // #2405: an empty finishReason carries nothing the client needs.
        if (typeof cand["finishReason"] === "string" && cand["finishReason"] !== "") return true;
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
    upstreamOrigin?: string,
    // See pipePluginChatWithStrip: whole-field tool-call emission drop,
    // gated on the request carrying the [ACP absorb] instruction (m00885).
    absorbInstructed?: boolean,
    // m00885: echoed (user-requested verbatim) emission spans survive.
    requestText?: string,
    // #2328 Q2 — see pipePluginChatWithStrip.
    upstreamMeta?: UpstreamMeta,
): Promise<void> {
    let reader = stream.getReader();
    let decoder = new TextDecoder("utf-8");
    let buf = "";
    const acc: UsageSample = {};
    // #2328 Q2/Q4 — see the chat-pipe twin.
    let diagEvents = 0;
    let diagBytes = 0;
    let diagUnparseable = 0;
    const diagLastTypes: string[] = [];
    const diagPushType = (label: string) => {
        diagLastTypes.push(label);
        if (diagLastTypes.length > 5) diagLastTypes.shift();
    };
    const who = session ? `[${session.id}] ` : "";
    const onTagDrop = (snippet: string) => {
        loggerLog("warn", `${who}[tag-echo] stripped model-emitted render tag (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
    };
    // #2190: log-only residue audit — see the twin above.
    const onResidueWarn = (snippet: string) => {
        loggerLog("warn", `${who}[tag-echo] filter released echo-residue-shaped bytes (#2190): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
    };
    const onBiliDrop = (snippet: string) => {
        loggerLog("warn", `${who}[bili-artifact] stripped model-emitted internal artifact (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
    };
    const tagFilter = composeStreamFilters(
        composeStreamFilters(
            createTagEchoFilter(onTagDrop, onResidueWarn, absorbInstructed, requestText),
            createMarkerLineFilter((snippet) => {
                loggerLog("warn", `${who}[marker-echo] stripped model-emitted ACP confirmation marker (plugin passthrough): ${snippet.slice(0, 80).replace(/\n/g, " ")}`);
            }),
        ),
        createBiliArtifactFilter(onBiliDrop),
    );
    // #673: turn-level observability for degenerate terminal turns.
    let sawFunctionCall = false;
    // #1685 witness feed: function_call items carry their name at
    // output_item.added and their FULL argument string at
    // function_call_arguments.done; both are accumulate-then-record at settle.
    const witnessedCalls = new Map<string, { name: string; args: string; named: boolean }>();
    const settleWitnesses = () => {
        if (!session) return;
        for (const wc of witnessedCalls.values()) {
            if (!wc.named || wc.name.length === 0) continue;
            recordToolWitness(session.id, wc.name, wc.args);
        }
    };
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
    let truncationRetried = false;
    let forwardedAny = false;
    let inRetry = false;
    /** Text the client actually assembled from this attempt's deltas. */
    let visibleTextChars = 0;
    /** #1778: clean prose forwarded via the byte-identical fast path (never
     *  enters tagFilter, so stats().outputChars alone misses it). The
     *  degenerate-turn warn (#673) and the retryEmptyTurn gate (#732/#821)
     *  both consult this — missing it false-warned every plain-prose turn on
     *  the plugin responses lane and, worse, let the one-shot retry fire on
     *  reasoning turns whose text had already reached the client. */
    let fastPathChars = 0;
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
    /** #2171 (responses twin of the chat pipe's helper): one-shot re-issue
     *  when the upstream stream dies having delivered NOTHING client-visible
     *  (only SSE keep-alive comments, which are protocol-invisible). The
     *  observed relay failure returns 200 + event-stream headers, never emits
     *  a single data frame, and is cut ~180s later; a manual re-send always
     *  heals with a warm prefix cache and the dead attempt bills nothing, so
     *  the retry is unambiguously safe. Shares the single stream-level
     *  re-issue budget with retryEmptyTurn; anything parsed, held, or written
     *  keeps the #721 in-band error. */
    const retryZeroByteCut = async (): Promise<boolean> => {
        if (refetch === undefined) return false;
        if (degenerateRetried || truncationRetried) return false;
        // Zero-visible predicate: no item framing held, no status observed, no
        // prose accumulated or held by the filters, no verbatim frame
        // forwarded, no partial SSE event left in the buffer.
        if (sawFunctionCall || sawReasoning || visibleTextChars > 0 || fastPathChars > 0 ||
            proseAcc.length > 0 || heldEvents.length > 0 || heldVisibleChars > 0 ||
            argStreams.size > 0 || responseStatus !== undefined || forwardedAny || buf.length > 0) return false;
        if (res.destroyed || res.writableEnded) return false;
        let next: ReadableStream<Uint8Array> | null = null;
        try {
            next = await refetch();
        } catch (e) {
            log?.(`[plugin] zero-byte cut retry failed (${e instanceof Error ? e.message : String(e)}); falling through to the truncation signal (#2171)`);
            return false;
        }
        if (!next) return false;
        truncationRetried = true;
        log?.("[plugin] upstream stream cut after headers with zero visible output; re-issuing the request once (#2171)");
        sawTerminal = false;
        heldEvents = [];
        heldVisibleChars = 0;
        heldItemId = undefined;
        heldOutputIndex = undefined;
        heldResponseId = undefined;
        tagFilter.flush();
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
    const write = (s: string): Promise<void> => {
        if (res.destroyed || res.writableEnded) return Promise.resolve();
        forwardedAny = true;
        if (!res.write(Buffer.from(s, "utf8"))) {
            return awaitDrain(res);
        }
        return Promise.resolve();
    };
    // #411: keep the usage sniffed before an abort (see
    // pipePluginChatWithStrip).
    const settleUsage = () => {
        if (!session) return;
        if (acc.inputTokens !== undefined || acc.outputTokens !== undefined || acc.cachedTokens !== undefined) {
            applyUsageSample(session, acc, "responses", upstreamOrigin);
            markDirty(session);
        }
        // #1595: same as the chat-pipe twin — sawTerminal gates out cuts.
        if (sawTerminal && acc.inputTokens === undefined) diagnoseSuccessWithoutUsage(session, "plugin-passthrough-responses");
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
            // #1778: fast-path prose bypasses the filter, so surface it here —
            // otherwise every clean-prose turn looks like an empty one.
            text: fastPathChars > 0 ? { inputChars: st.inputChars, outputChars: st.outputChars + fastPathChars, dropped: st.dropped, dropCount: st.dropCount } : st,
            sawThinking: sawReasoning,
            wire: "plugin-passthrough-responses",
        });
        if (msg) loggerLog("warn", `${who}${msg}`);
    };
    // #2405(c): per-response strip total — see the chat-pipe twin above, incl.
    // the terminal/catch double-call guard.
    let stripSummarized = false;
    const maybeSummarizeStrips = () => {
        if (stripSummarized) return;
        stripSummarized = true;
        const total = tagFilter.stats().dropCount;
        if (total > 1) loggerLog("warn", `${who}[tag-echo] stripped ${total} occurrence(s) total in this response`);
    };
    // #1368: once-per-request #361 detector for the Responses pipe — see the
    // chat-pipe twin above for the warn-only rationale (#295/#361).
    const maybeWarnProtocolFragment = () => {
        if (proseAcc.length === 0 || !containsToolCallXmlFragment(proseAcc)) return;
        loggerLog("warn", `${who}[tag-echo] detected: plugin passthrough response text contains tool-call XML fragment (possible tag echo; left untouched)`);
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
    // #2328 Q2/Q4 — see the chat-pipe twin. Responses-specific extras: the
    // last completion-family status observed (a failed/incomplete status on a
    // "truncated" stream changes the diagnosis) and how many done-family
    // frames were still held for the degenerate-turn retry when the cut hit.
    const buildTruncationDiag = (cause: "eof" | "read-error"): TruncationDiag => ({
        cause,
        classification: buf.length > 0 && tailLooksTerminal(buf, "responses") ? "terminal-bytes-unrecognized" : "no-terminal-seen",
        protocol: "responses",
        events: diagEvents,
        unparseableForwarded: diagUnparseable,
        bytes: diagBytes,
        lastEventTypes: [...diagLastTypes],
        eofBufferBytes: buf.length,
        ...(buf.length > 0 ? { eofBufferHead: buf.slice(0, 80).replace(/[\r\n]+/g, "\\n") } : {}),
        ...(responseStatus !== undefined ? { responseStatus } : {}),
        visibleChars: visibleTextChars,
        sawStrippedEcho,
        retryZeroByteCutSpent: truncationRetried,
        retryDegenerateSpent: degenerateRetried,
        heldEvents: heldEvents.length,
        ...(upstreamMeta?.status !== undefined ? { upstreamStatus: upstreamMeta.status } : {}),
        ...(upstreamMeta?.contentType !== undefined ? { upstreamContentType: upstreamMeta.contentType } : {}),
    });
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
        // truncationRetried: one re-issue per request, total — see the chat-pipe twin.
        if (degenerateRetried || truncationRetried || refetch === undefined) return false;
        // #2303: same shape as the chat-pipe twin — visible prose ending in a
        // compression-draft closing tag with no function call is non-converged.
        // #2612: except when the request itself demands that shape (client
        // compaction summary instruction) — see the chat-pipe twin.
        const draftTail = (visibleTextChars > 0 || heldVisibleChars > 0) && !sawFunctionCall && endsWithDraftClose(proseAcc) && !requestExpectsProseSummary(requestText);
        if (!draftTail && (visibleTextChars > 0 || heldVisibleChars > 0 || sawFunctionCall)) return false;
        if (status !== "completed") return false;
        if (res.destroyed || res.writableEnded) return false;
        // A turn the model left genuinely bare — no reasoning, no stripped
        // echo — is the upstream's own empty answer, not a stall: re-issuing it
        // double-bills an empty completion (#732/#821 keep the same boundary in
        // the compress loop). A draft-tail turn delivered a full handoff draft:
        // precisely the stall signal.
        if (!sawReasoning && !sawStrippedEcho && !draftTail) return false;
        degenerateRetried = true;
        log?.(draftTail
            ? "[plugin] terminal turn ends with a compression-draft closing tag and no function call; retrying once with a continuation nudge (#2303)"
            : "[plugin] degenerate terminal turn (no visible output); retrying once with a continuation nudge (#732/#821)");
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
            s = { filter: composeStreamFilters(createTagEchoFilter(onTagDrop, onResidueWarn, absorbInstructed, requestText), createBiliArtifactFilter(onBiliDrop)), type, field, meta };
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
        let pendingFinal: string | null = null;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                // #2171: an EOF with nothing client-visible yet is safely
                // re-issuable — try the one-shot retry before giving up.
                if (!sawTerminal && !res.destroyed && !res.writableEnded && (await retryZeroByteCut())) continue;
                // #2323: a CRLF/lone-CR whose final byte arrived last is held back
                // by the streaming normalizer; resolve it and re-drive the completed
                // event through the same path below before deciding truncation.
                const resolved = finalizeSseLineEndings(buf);
                if (resolved === buf) break;
                buf = "";
                pendingFinal = resolved;
            } else {
                if (value && value.length > 0) diagBytes += value.byteLength;
                pendingFinal = value && value.length > 0 ? decoder.decode(value, { stream: true }) : null;
            }
            if (pendingFinal !== null) {
                buf = normalizeSseLineEndings(buf + pendingFinal);
                let idx: number;
                while ((idx = buf.indexOf("\n\n")) !== -1) {
                    const rawEvent = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    const dataLines = rawEvent.split("\n").filter((l) => l.startsWith("data:"));
                    if (dataLines.length === 0) continue;
                    const jsonStr = dataLines.map((l) => l.slice(5).replace(/^ /, "")).join("\n").trim();
                    if (!jsonStr || jsonStr === "[DONE]") {
                        if (jsonStr === "[DONE]") {
                            diagEvents++;
                            diagPushType("[DONE]");
                            sawTerminal = true;
                        }
                        await write(rawEvent + "\n\n");
                        continue;
                    }
                    let ev: Record<string, unknown>;
                    try {
                        ev = JSON.parse(jsonStr) as Record<string, unknown>;
                    } catch {
                        diagEvents++;
                        diagUnparseable++;
                        diagPushType("unparseable");
                        // #2190: unparseable frames bypass every filter — audit them.
                        auditRawForward(rawEvent);
                        await write(rawEvent + "\n\n");
                        continue;
                    }
                    diagEvents++;
                    if (typeof ev["type"] === "string") diagPushType(ev["type"] as string);
                    const sample = usageFromSseEvent(ev);
                    if (sample) mergeUsageSample(acc, sample);
                    const type = ev["type"];
                    if (typeof type === "string") {
                        if (type.startsWith("response.reasoning")) sawReasoning = true;
                        if (type === "response.output_item.added" || type === "response.output_item.done") {
                            const item = ev["item"] as Record<string, unknown> | undefined;
                            const it = item?.["type"];
                            if (it === "function_call" || it === "custom_tool_call") sawFunctionCall = true;
                            if (it === "function_call") {
                                const key = typeof item?.["id"] === "string" && item["id"] ? item["id"] as string : `oi:${typeof ev["output_index"] === "number" ? ev["output_index"] as number : 0}`;
                                const wc = witnessedCalls.get(key) ?? { name: "", args: "", named: false };
                                if (typeof item?.["name"] === "string" && item["name"].length > 0) {
                                    wc.name = item["name"];
                                    wc.named = true;
                                }
                                if (typeof item?.["arguments"] === "string" && item["arguments"].length > 0) wc.args = item["arguments"];
                                witnessedCalls.set(key, wc);
                            }
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
                        const itemId = typeof ev["item_id"] === "string" && ev["item_id"] ? ev["item_id"] : `oi:${typeof ev["output_index"] === "number" ? ev["output_index"] as number : 0}`;
                        const wc = witnessedCalls.get(itemId) ?? { name: "", args: "", named: false };
                        if (typeof ev["arguments"] === "string") wc.args = ev["arguments"];
                        witnessedCalls.set(itemId, wc);
                        await write(flushArgTails() + rawEvent + "\n\n");
                        continue;
                    }
                    // #933: done-family events also carry full text payloads — strip those too.
                    // The done is not visible text to the degenerate-turn retry below, so it
                    // is stripped and released directly.
                    if (type === "response.reasoning_summary_part.done") {
                        // Unified ACP invariant: reasoning summaries are the
                        // thinking channel — byte-verbatim, no strip pass. The
                        // text still feeds proseAcc so degenerate-turn
                        // accounting sees it.
                        proseAcc += responsesEventText(ev);
                        await write(flushArgTails() + flushTail(rawEvent + "\n\n"));
                        continue;
                    }
                    if (type === "response.output_text.done" || type === "response.content_part.done" || type === "response.output_item.done") {
                        // HELD until the completion event decides the turn (see
                        // retryEmptyTurn): releasing it earlier would hand the
                        // client the echo's own text exactly when the retry is
                        // about to replace it.
                        // #2190: degenerate-close residue never trips RENDER_TAG_DETECT — check its shape too.
                        // Whole-field tool-call emission (m00885) — an absorb-instructed
                        // turn may answer as prose; drop the span, not just the tags.
                        const dropEmission = absorbInstructed === true && containsToolCallEmissionText(jsonStr);
                        const hadEchoText = containsRenderTagText(jsonStr) || containsMarkerLineText(jsonStr) || containsBiliInternalText(jsonStr) || containsEchoResidue(jsonStr) || dropEmission;
                        if (hadEchoText) sawStrippedEcho = true;
                        let evOut = ev;
                        let rebuild = hadEchoText || retryRewritePending();
                        if (rebuild) evOut = stripResponsesText(ev, dropEmission, requestText);
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
                        // #2190: degenerate-close residue never trips RENDER_TAG_DETECT — check its shape too.
                        // Whole-field tool-call emission (m00885) — an absorb-instructed
                        // turn may answer as prose; drop the span, not just the tags.
                        const dropEmission = absorbInstructed === true && containsToolCallEmissionText(jsonStr);
                        const hadEchoText = containsRenderTagText(jsonStr) || containsMarkerLineText(jsonStr) || containsBiliInternalText(jsonStr) || containsEchoResidue(jsonStr) || dropEmission;
                        if (hadEchoText) sawStrippedEcho = true;
                        let evOut = ev;
                        let rebuild = hadEchoText || retryRewritePending();
                        if (rebuild) evOut = stripResponsesText(ev, dropEmission, requestText);
                        rewriteRetryIds(evOut);
                        // Hosts finish on this frame, before EOF settles billing and late usage.
                        if (session && acc.inputTokens !== undefined && acc.inputTokens > 0) {
                            const credit = session.stats.compressCreditTokens ?? 0;
                            recordContextObservation(session, Math.max(0, acc.inputTokens - credit), credit > 0 ? "estimate" : "usage");
                            markDirty(session);
                        }
                        await write(rebuild ? rebuildEvent(rawEvent, evOut) : rawEvent + "\n\n");
                        continue;
                    }
                    if (type === "response.output_text.delta" && typeof ev["delta"] === "string") {
                        const delta = ev["delta"] as string;
                        if (delta.length === 0) {
                            await write(rawEvent + "\n\n");
                            continue;
                        }
                        // Whole-field emission head (m00885): the filter's
                        // field-start hold must see the first bytes. Degenerate
                        // close (#2190) rides the same routing.
                        if (!retryRewritePending() && !mayStartRenderTag(delta) && !mayStartMarkerLine(delta) && !mayStartBiliInternal(delta) && !mayStartDegenerateRenderTag(delta) && !(absorbInstructed === true && mayStartToolCallEmission(delta)) && !tagFilter.pending()) {
                            proseAcc += delta;
                            visibleTextChars += delta.length;
                            fastPathChars += delta.length;
                            // #2190: residue audit — see the twin above.
                            if (delta.length > 0 && containsEchoResidue(delta)) loggerLog("warn", `[tag-echo] fast path forwarded echo-residue-shaped bytes (#2190): ${delta.slice(0, 80).replace(/\n/g, " ")}`);
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
                    // Reasoning summary deltas are the thinking channel —
                    // byte-verbatim under the unified ACP invariant (never
                    // filtered). Function_call argument deltas are user intent
                    // and pass through verbatim (#1039), falling into the
                    // generic rawEvent write below.
                    if (type === "response.reasoning_summary_text.delta" && typeof ev["delta"] === "string") {
                        const v = ev["delta"] as string;
                        if (v.length > 0) proseAcc += v;
                        await write(rawEvent + "\n\n");
                        continue;
                    }
                    // #2248: raw exit — unrecognized event types never enter the
                    // filter. Tool-call argument streams are user intent (#1039)
                    // and are excluded from the audit.
                    if (!responsesFrameHasToolCalls(ev)) auditRawForward(rawEvent);
                    await write(rawEvent + "\n\n");
                }
            }
            if (done) break;
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
        maybeSummarizeStrips();
        settleUsage();
        settleWitnesses();
        // #721 → #2563: never leave the stream hanging on a missing done-family
        // event. Permitlist hosts (pi) get the raw cut for their native
        // classifier; everyone else gets the in-band error frame.
        if (!sawTerminal && !res.destroyed && !res.writableEnded) {
            emitUpstreamTruncation(res, "responses", false, log, buildTruncationDiag("eof"), transparentTruncationApplies(session));
            return;
        }
    } catch (e) {
        settleUsage();
        maybeSummarizeStrips();
        settleWitnesses();
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
        loggerLog("warn", `[plugin] upstream stream read failed (responses): ${String(e instanceof Error ? e.message : e)} — truncation signal path`);
        emitUpstreamTruncation(res, "responses", false, log, buildTruncationDiag("read-error"), transparentTruncationApplies(session));
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
function stripGoogleChunk<T>(obj: T, drop: boolean = false, requestText?: string): T {
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
                    // #1960/KDD#10: thought parts carry a thoughtSignature — leave them byte-for-byte.
                    p && typeof p === "object" && (p as Record<string, unknown>)["thought"] !== true && typeof (p as Record<string, unknown>)["text"] === "string"
                        ? { ...(p as Record<string, unknown>), text: stripAcpTags((p as Record<string, unknown>)["text"] as string, drop, requestText) }
                        : p,
                ),
            },
        };
    });
    return obj;
}

// Without `alt=sse` a Gemini streaming response is a JSON ARRAY of the same
// chunk objects, so the non-stream strip applies to each element as well.
function stripGoogleText<T>(obj: T, drop: boolean = false, requestText?: string): T {
    if (Array.isArray(obj)) {
        obj.forEach((c) => {
            stripGoogleChunk(c, drop, requestText);
        });
        return obj;
    }
    return stripGoogleChunk(obj, drop, requestText);
}

export async function pipePluginJson(
    stream: ReadableStream<Uint8Array>,
    res: import("node:http").ServerResponse,
    session?: Session,
    protocol?: WireProtocol,
    upstreamOrigin?: string,
    // m00885 provenance gate: the request body carried the kernel's
    // "[ACP absorb]" instruction. Off ⇒ whole-field tool-call text in the
    // JSON body is legitimate prose and survives the strip.
    absorbInstructed?: boolean,
    // m00885: echoed (user-requested verbatim) emission spans survive.
    requestText?: string,
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
        let sawInputSample = false;
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
                }, protocol, upstreamOrigin);
                markDirty(session);
                sawInputSample = true;
            }
        }
        // Gemini reports its usage in a top-level `usageMetadata` instead of
        // `usage` (same object on a non-streaming body as on an SSE chunk) —
        // feed it too, so a `:generateContent` turn also anchors
        // lastInputTokens for the nudge/fit decisions.
        if (session && !usage) {
            const sample = googleUsageSample(json);
            if (sample && sample.inputTokens !== undefined) {
                applyUsageSample(session, sample, protocol, upstreamOrigin);
                markDirty(session);
                sawInputSample = true;
            }
        }
        // #1595: parsed success body carrying no input usage report — name it.
        if (session && !sawInputSample) diagnoseSuccessWithoutUsage(session, "plugin-json");
        // #1685: a non-streaming plugin response still carries the model's
        // complete tool calls — same witness feed as the SSE pipes, from the
        // one full-body parse this path already does. Observe-only (#1039).
        if (session) recordJsonToolWitnesses(session.id, json, protocol);
    } catch { /* non-JSON body — forward verbatim */ }
        // #2190: degenerate-close residue never trips RENDER_TAG_DETECT — check its shape too.
        // m00885: an absorb-instructed turn may answer with a whole-field
        // tool-call emission written as prose — the raw-body probe is
        // escape-tolerant so it fires on the serialized JSON too.
        const dropEmission = absorbInstructed === true && containsToolCallEmissionText(text);
        if (json && (dropEmission || containsRenderTagText(text) || containsMarkerLineText(text) || containsBiliInternalText(text) || containsEchoResidue(text))) {
        // #206 parity for the non-streaming plugin path: the compress loop's
        // JSON branch strips render tags from every round; a verbatim plugin
        // JSON response would re-feed the model's tag echoes. Strips mutate in
        // place, so this composes with the #408 usage backfill above — one
        // parse, one reserialize.
        json = protocol === "responses" ? stripResponsesText(json, dropEmission, requestText)
            : protocol === "anthropic" ? stripAnthropicText(json, dropEmission, requestText)
            : protocol === "google" ? stripGoogleText(json, dropEmission, requestText)
            : stripOpenaiChatText(json, dropEmission, requestText);
        mutated = true;
    }
    if (mutated && json) {
        res.end(Buffer.from(JSON.stringify(json), "utf8"));
        return;
    }
    res.end(text);
}

/** #1685 witness feed for non-streaming plugin responses: pull every complete
 *  tool call out of the parsed body, per wire protocol, and ring-record it.
 *  Names/arguments here are final (no streaming fragments). */
function recordJsonToolWitnesses(sessionId: string, json: Record<string, unknown>, protocol: WireProtocol | undefined): void {
    try {
        if (protocol === "anthropic") {
            const content = json["content"];
            if (!Array.isArray(content)) return;
            for (const block of content) {
                if (!block || typeof block !== "object") continue;
                const b = block as Record<string, unknown>;
                if (b["type"] !== "tool_use") continue;
                if (typeof b["name"] !== "string" || b["name"].length === 0) continue;
                recordToolWitness(sessionId, b["name"], b["input"] !== null && b["input"] !== undefined ? b["input"] as Record<string, unknown> : "");
            }
            return;
        }
        if (protocol === "responses") {
            const output = json["output"];
            if (!Array.isArray(output)) return;
            for (const item of output) {
                if (!item || typeof item !== "object") continue;
                const o = item as Record<string, unknown>;
                if (o["type"] !== "function_call") continue;
                if (typeof o["name"] !== "string" || o["name"].length === 0) continue;
                recordToolWitness(sessionId, o["name"], typeof o["arguments"] === "string" ? o["arguments"] : "");
            }
            return;
        }
        if (protocol === "google") {
            const candidates = json["candidates"];
            if (!Array.isArray(candidates)) return;
            for (const cand of candidates) {
                if (!cand || typeof cand !== "object") continue;
                const content = (cand as Record<string, unknown>)["content"];
                if (!content || typeof content !== "object") continue;
                const parts = (content as Record<string, unknown>)["parts"];
                if (!Array.isArray(parts)) continue;
                for (const p of parts) {
                    if (!p || typeof p !== "object") continue;
                    const fc = (p as Record<string, unknown>)["functionCall"];
                    if (!fc || typeof fc !== "object") continue;
                    const f = fc as Record<string, unknown>;
                    if (typeof f["name"] !== "string" || f["name"].length === 0) continue;
                    recordToolWitness(sessionId, f["name"], f["args"] !== null && f["args"] !== undefined ? f["args"] as Record<string, unknown> : "");
                }
            }
            return;
        }
        const choices = json["choices"];
        if (!Array.isArray(choices)) return;
        for (const choice of choices) {
            if (!choice || typeof choice !== "object") continue;
            const message = (choice as Record<string, unknown>)["message"];
            if (!message || typeof message !== "object") continue;
            const toolCalls = (message as Record<string, unknown>)["tool_calls"];
            if (!Array.isArray(toolCalls)) continue;
            for (const tc of toolCalls) {
                if (!tc || typeof tc !== "object") continue;
                const fn = (tc as Record<string, unknown>)["function"];
                if (!fn || typeof fn !== "object") continue;
                const f = fn as Record<string, unknown>;
                if (typeof f["name"] !== "string" || f["name"].length === 0) continue;
                recordToolWitness(sessionId, f["name"], typeof f["arguments"] === "string" ? f["arguments"] : "");
            }
        }
    } catch {
        /* observe-only: a malformed body must not break forwarding */
    }
}

export function _resetPluginStateForTest(): void {
    conversations.clear();
    remembered.clear();
    pendingRegisters.length = 0;
    registeredIds.clear();
    pluginRuntimeTable.clear();
    pluginRuntimeByConversation.clear();
    warnedNoModelRequests.clear();
}

export function _rememberedForTest(): Map<string, RememberedMessages> {
    return remembered;
}
