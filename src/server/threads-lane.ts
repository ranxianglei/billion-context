// [#2926] anthropic Threads lane — mirror, budget, reforge.
//
// Anthropic Threads moves conversation state server-side: a `create` request
// carries the full history once, every later `continue` carries only the
// delta (a `previous_message_id`), and the API offers no way to delete or
// rewrite what already sits in the thread. bili's core lever — rewriting the
// resent history — therefore does not exist on this wire: the compress
// machinery must stand down entirely (byte-faithful passthrough), and a fold
// can only ever be delivered by minting a WHOLE NEW thread whose create
// carries the folded history.
//
// This lane does exactly that, in three parts:
//
//   1. CAPTURE (always on, unified sidecar permitting): every create/continue
//      is mirrored into the unified store (`session_ext` keys
//      `threads:mirror:*`) — create replaces the mirror (it is the client's
//      authoritative snapshot), continue appends its delta — and every model
//      reply is appended from the forwarded response stream (#3744: the
//      thread holds state server-side that the client never re-sends, so
//      without it the mirror is blind to half the conversation). Storage is
//      append-only chunks under the 4 MiB per-value cap.
//   2. BUDGET: the mirror estimate (shape tokens + post-fold entries +
//      folded summary) against the configured window. The wire itself is
//      useless as a signal — a continue body is always small no matter how
//      big the server-side thread has grown — so the mirror is the only
//      local truth.
//   3. REFORGE (rollout `anthropicThreadsReforge`, default off): when the
//      mirror crosses the window on a continue, bili swaps that continue for
//      a fresh `create` whose messages = [summary of the folded prefix,
//      verbatim tail ring, the client's delta]. The client's system/tools
//      are copied byte-faithfully from the captured create shape — host
//      instructions never enter the summary. The response streams back
//      untouched; because the message-id chain IS the thread identity, the
//      client's next continue (echoing the new tail id) lands in the new
//      thread with zero redirection.
//
// Failure posture is fail-open everywhere: legacy-only storage (no unified
// sidecar) captures nothing and never reforges; a failed summary side-call
// forwards the continue untouched (repeat failures cool down per-session —
// a broken side-call must not re-upload the transcript every turn, #3569).
// The lane must never be the reason a threads client breaks.

import { SessionStore } from "../persist.js";
import { featureEnabled } from "../rollout.js";
import { estimateRawBodyTokens } from "../preflight.js";
import { defaultCountTokens } from "acp-kernel";
import type { Session } from "../session.js";
import { fetchWithTimeout } from "../fetch-util.js";
import { proxyDispatcher } from "../upstream-proxy.js";

/** Raw wire message as the client sent it. Stored verbatim so the reforge
 *  can replay tail entries byte-faithfully (shape drift between anthropic
 *  wire and CoreMessage round-trips would be a rewrite of its own). */
interface ThreadsMirrorEntry {
    role?: unknown;
    content?: unknown;
}

interface ThreadsMirrorShape {
    model?: string;
    system?: unknown;
    tools?: unknown;
    maxTokens?: number;
}

export interface ThreadsMirrorMeta {
    version: 1;
    /** Captured from the client's create; the reforge copies it
     *  byte-faithfully so host instructions never enter the summary. */
    shape?: ThreadsMirrorShape;
    shapeTokens: number;
    /** Entries before this index are covered by `foldedSummary`. */
    foldedBefore: number;
    foldedSummary?: string;
    count: number;
}

interface ThreadsMirror {
    available: boolean;
    meta: ThreadsMirrorMeta;
    entries: ThreadsMirrorEntry[];
}

export interface ThreadsReforgePlan {
    sessionId: string;
    entries: ThreadsMirrorEntry[];
    meta: ThreadsMirrorMeta;
    windowTokens: number;
}

const EXT_META_KEY = "threads:mirror:meta";
const EXT_CHUNK_PREFIX = "threads:mirror:chunk:";
/** Keep each session_ext value well under the 4 MiB store cap. */
const CHUNK_BYTE_LIMIT = 1_500_000;
/** An entry whose serialized form exceeds this is elided from the mirror —
 *  base64 media blobs would otherwise turn the mirror into a media store;
 *  the CAS (`content` table) is the right home for bulk payloads. */
const ENTRY_BYTE_LIMIT = 512_000;
/** Fold everything except the last N user turns (cut lands on a user-turn
 *  boundary so tool_use/tool_result pairs inside the span stay paired). */
const REFORGE_RING_USER_TURNS = 3;
/** Summary side-call budget. */
const SUMMARY_TIMEOUT_MS = 120_000;
const SUMMARY_MAX_TOKENS = 1024;
/** Transcript handed to the summarizer, capped to bound the side-call. */
const TRANSCRIPT_BYTE_CAP = 400_000;
/** A session whose side-call keeps failing (dead auth, rate limit…) stops
 *  re-uploading its transcript on every continue: the next attempt lands
 *  after this window instead (#3569). */
const SUMMARY_RETRY_COOLDOWN_MS = 10 * 60_000;
/** #3744: headers excluded from the side-call passthrough. Everything else
 *  the client sent rides along verbatim — under subscription OAuth the
 *  upstream only accepts the summarizer request when it looks like the
 *  client's own traffic (full header set, original system prefix intact). */
const SIDE_CALL_STRIP_HEADERS = new Set([
    // hop-by-hop / framing — meaningless or harmful on a fresh connection
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
    // per-target / per-body — must describe THIS call, not the client's
    "host", "content-length", "accept-encoding", "expect",
]);
/** One-shot per-request ids — replaying them on a different request got the
 *  side-call 429'd under subscription OAuth even with full header passthrough
 *  (#3744, variant A → B). */
const SIDE_CALL_ONE_SHOT_HEADERS = new Set([
    "x-client-request-id", "anthropic-dispatch-id", "x-claude-code-prompt-id",
]);
/** Non-streaming replies are buffered whole for the mirror, capped so a
 *  runaway body cannot turn the observer into a media store. */
const JSON_CAPTURE_BYTE_CAP = 8_000_000;
/** A completed reply whose blocks were all un-replayable (thinking /
 *  redacted_thinking only, or an abort mid-thinking) still occupies an
 *  assistant slot in the server-side thread. The mirror records it as this
 *  self-describing block so every later reforged create satisfies the
 *  system-placement rule (a mid-conversation `system` must be followed by an
 *  `assistant` message or end the array) instead of 400-ing on a permanent
 *  ordering gap (#3744 review of #3746). */
const EMPTY_REPLY_PLACEHOLDER = { type: "text", text: "[threads-lane] model reply carried no replayable content (thinking-only or aborted)" };

const SUMMARIZER_SYSTEM = [
    "You are compressing an older slice of a coding-agent conversation so it can be replaced by your summary.",
    "Preserve, in order of importance: (1) the user's actual goals and standing instructions; (2) decisions made and their reasons; (3) code landmarks — file paths, function names, commands, error messages; (4) open items and unresolved questions.",
    "Drop chit-chat, restatements, and raw tool-output bulk; keep concrete values, not prose about them.",
    "Write dense factual notes in bullet form. No preamble, no headers about yourself.",
].join(" ");

const unavailableMirror: ThreadsMirror = {
    available: false,
    meta: { version: 1, shapeTokens: 0, foldedBefore: 0, count: 0 },
    entries: [],
};

function freshMeta(): ThreadsMirrorMeta {
    return { version: 1, shapeTokens: 0, foldedBefore: 0, count: 0 };
}

let mirrorStore: SessionStore | undefined;
const warnedSessions = new Set<string>();
/** sessionId → epoch-ms until which the summary side-call is suppressed. */
const reforgeCooldownUntil = new Map<string, number>();
/** In-flight reply captures (the observer runs async on a tee'd branch). */
const pendingCaptures = new Set<Promise<void>>();

function laneStore(): SessionStore {
    if (!mirrorStore) mirrorStore = new SessionStore({ enabled: true });
    return mirrorStore;
}

export function __resetThreadsLaneForTests(): void {
    mirrorStore?.closeQuietly();
    mirrorStore = undefined;
    warnedSessions.clear();
    reforgeCooldownUntil.clear();
    pendingCaptures.clear();
}

/** Test seam: resolve when every in-flight reply capture has persisted (or
 *  given up), so mirror reads are deterministic. */
export function __awaitThreadsCapturesForTests(): Promise<void> {
    return Promise.allSettled([...pendingCaptures]).then(() => undefined);
}

export function isThreadsBody(parsed: unknown): boolean {
    const thread = (parsed as { thread?: unknown } | null)?.thread;
    if (typeof thread !== "object" || thread === null) return false;
    const type = (thread as { type?: unknown }).type;
    return type === "create" || type === "continue";
}

function serializeEntry(entry: ThreadsMirrorEntry): { ok: true; value: ThreadsMirrorEntry } | { ok: false; bytes: number } {
    const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    if (bytes > ENTRY_BYTE_LIMIT) return { ok: false, bytes };
    return { ok: true, value: entry };
}

function loadMirror(store: SessionStore, sessionId: string): ThreadsMirror {
    try {
        const metaRaw = store.getSessionExt(sessionId, EXT_META_KEY);
        if (metaRaw === undefined || metaRaw === null) {
            return { available: true, meta: freshMeta(), entries: [] };
        }
        const meta = metaRaw as ThreadsMirrorMeta;
        const entries: ThreadsMirrorEntry[] = [];
        for (let i = 0; ; i++) {
            const chunkRaw = store.getSessionExt(sessionId, EXT_CHUNK_PREFIX + String(i).padStart(4, "0"));
            if (chunkRaw === undefined || chunkRaw === null) break;
            const chunk = chunkRaw as { entries?: unknown };
            if (Array.isArray(chunk?.entries)) entries.push(...(chunk.entries as ThreadsMirrorEntry[]));
        }
        entries.length = Math.min(entries.length, meta.count);
        return { available: true, meta, entries };
    } catch {
        // Legacy-only store (liveShadow throws) or a dead sidecar: the lane
        // degrades to pure passthrough — capture nothing, reforge nothing.
        return { ...unavailableMirror };
    }
}

function persistMirror(store: SessionStore, sessionId: string, meta: ThreadsMirrorMeta, entries: ThreadsMirrorEntry[], log: (level: string, msg: string) => void): void {
    try {
        const chunks: { entries: ThreadsMirrorEntry[] }[] = [];
        let current: ThreadsMirrorEntry[] = [];
        let currentBytes = 2; // "[]"
        for (const entry of entries) {
            const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
            if (current.length > 0 && currentBytes + bytes > CHUNK_BYTE_LIMIT) {
                chunks.push({ entries: current });
                current = [];
                currentBytes = 2;
            }
            current.push(entry);
            currentBytes += bytes + 1;
        }
        chunks.push({ entries: current });
        store.setSessionExt(sessionId, EXT_META_KEY, meta);
        for (let i = 0; i < chunks.length; i++) {
            store.setSessionExt(sessionId, EXT_CHUNK_PREFIX + String(i).padStart(4, "0"), chunks[i]);
        }
        // Drop stale chunks beyond the new count (a create replaced a longer history).
        for (let i = chunks.length; i < 512; i++) {
            const key = EXT_CHUNK_PREFIX + String(i).padStart(4, "0");
            if (store.getSessionExt(sessionId, key) === undefined || store.getSessionExt(sessionId, key) === null) break;
            store.deleteSessionExt(sessionId, key);
        }
    } catch (err) {
        if (!warnedSessions.has(sessionId)) {
            warnedSessions.add(sessionId);
            log("warn", `[${sessionId}] [threads] mirror write failed (${String(err)}) — lane degraded to passthrough for this session (#2926)`);
        }
    }
}

/** Capture one threads turn into the mirror. Create is the client's
 *  authoritative full snapshot (replace); continue appends its delta. */
export function captureThreadsTurn(
    sessionId: string,
    parsed: { thread?: unknown; messages?: unknown; model?: unknown; system?: unknown; tools?: unknown; max_tokens?: unknown },
    log: (level: string, msg: string) => void,
): ThreadsMirror {
    let mirror: ThreadsMirror;
    try {
        mirror = loadMirror(laneStore(), sessionId);
    } catch {
        return { ...unavailableMirror };
    }
    if (!mirror.available) return mirror;
    const store = laneStore();
    const threadType = ((parsed.thread as { type?: unknown } | undefined)?.type) as "create" | "continue" | undefined;
    const incoming = Array.isArray(parsed.messages) ? (parsed.messages as ThreadsMirrorEntry[]) : [];
    let meta = mirror.meta;
    let entries: ThreadsMirrorEntry[];
    if (threadType === "create") {
        // Replace: the create IS the full history (possibly already folded by
        // the client's own compaction); the shape snapshot rides it. Reset bili's
        // own fold tracking too — a stale foldedBefore here would corrupt a later
        // reforge under a re-created session id.
        const shape: ThreadsMirrorShape = {
            ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
            ...(parsed.system !== undefined ? { system: parsed.system } : {}),
            ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
            ...(typeof parsed.max_tokens === "number" ? { maxTokens: parsed.max_tokens } : {}),
        };
        const shapeTokens = estimateRawBodyTokens({ system: parsed.system, tools: parsed.tools, messages: [] });
        meta = { ...freshMeta(), shape, shapeTokens };
        entries = [];
    } else {
        entries = mirror.entries.slice();
    }
    for (const raw of incoming) {
        if (raw === null || typeof raw !== "object") continue;
        const entry: ThreadsMirrorEntry = {
            ...(typeof (raw as { role?: unknown }).role !== "undefined" ? { role: (raw as ThreadsMirrorEntry).role } : {}),
            content: (raw as { content?: unknown }).content,
        };
        const sized = serializeEntry(entry);
        if (sized.ok) {
            entries.push(sized.value);
        } else {
            entries.push({ role: entry.role, content: `[threads-lane] oversized entry elided from the mirror (${sized.bytes} bytes)` });
        }
    }
    meta = { ...meta, count: entries.length };
    persistMirror(store, sessionId, meta, entries, log);
    return { available: true, meta, entries };
}

interface AssistantBlockAcc {
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    json?: string;
}

/** Reassemble the model's reply for one threads turn from the forwarded
 *  response and append it to the mirror. The thread itself holds state
 *  server-side that the client NEVER re-sends (continues carry only deltas),
 *  so without this the mirror is blind to every assistant turn: budgets
 *  undercount, summaries lose half the conversation, and tail rings end in
 *  `user system user system …` shapes a fresh create rejects with a
 *  placement 400 (#3744). Runs on a tee'd branch of the client-bound stream;
 *  fail-open — any error skips the append, never breaks the turn. */
export function observeThreadsAssistantReply(
    sessionId: string,
    body: ReadableStream<Uint8Array>,
    sse: boolean,
    signal: AbortSignal,
    log: (level: string, msg: string) => void,
): void {
    const capture: Promise<void> = (async () => {
        try {
            const reader = body.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            const accs = new Map<number, AssistantBlockAcc>();
            let sawEvent = false;
            let jsonBytes = 0;
            const processFrame = (frame: string): void => {
                const datas: string[] = [];
                for (const line of frame.split("\n")) {
                    if (line.startsWith("data:")) datas.push(line.slice(5).trimStart());
                }
                if (datas.length === 0) return;
                let ev: Record<string, unknown>;
                try { ev = JSON.parse(datas.join("\n")) as Record<string, unknown>; } catch { return; }
                sawEvent = true;
                const type = typeof ev.type === "string" ? ev.type : "";
                const index = typeof ev.index === "number" ? ev.index : -1;
                if (type === "content_block_start") {
                    const cb = (ev.content_block ?? {}) as Record<string, unknown>;
                    accs.set(index, {
                        type: typeof cb.type === "string" ? cb.type : undefined,
                        ...(typeof cb.text === "string" ? { text: cb.text } : {}),
                        ...(typeof cb.id === "string" ? { id: cb.id } : {}),
                        ...(typeof cb.name === "string" ? { name: cb.name } : {}),
                    });
                } else if (type === "content_block_delta" && index >= 0) {
                    const acc = accs.get(index);
                    if (!acc) return;
                    const delta = (ev.delta ?? {}) as Record<string, unknown>;
                    if (delta.type === "text_delta" && typeof delta.text === "string") {
                        acc.text = (acc.text ?? "") + delta.text;
                    } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
                        acc.json = (acc.json ?? "") + delta.partial_json;
                    }
                }
            };
            try {
                while (!signal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    if (sse) {
                        buf += chunk.replace(/\r\n/g, "\n");
                        let sep: number;
                        while ((sep = buf.indexOf("\n\n")) !== -1) {
                            processFrame(buf.slice(0, sep));
                            buf = buf.slice(sep + 2);
                        }
                        if (buf.length > 1_000_000) buf = ""; // undelimited runaway frame — drop the fragment
                    } else {
                        jsonBytes += Buffer.byteLength(chunk, "utf8");
                        if (jsonBytes <= JSON_CAPTURE_BYTE_CAP) buf += chunk;
                    }
                }
            } finally {
                try { await reader.cancel(); } catch { /* already closed/released */ }
            }
            buf += decoder.decode(); // flush a trailing multi-byte character split across the final chunk
            let content: unknown[] | null;
            if (sse) {
                content = [];
                for (const acc of accs.values()) {
                    // thinking/redacted_thinking are signature-verified scratch
                    // (#1960 family) and other block types are not replay-safe —
                    // only text/tool_use enter the mirror.
                    if (acc.type === "text") {
                        content.push({ type: "text", text: acc.text ?? "" });
                    } else if (acc.type === "tool_use") {
                        let input: unknown = {};
                        if (acc.json) { try { input = JSON.parse(acc.json); } catch { input = {}; } }
                        content.push({ type: "tool_use", id: acc.id ?? "", name: acc.name ?? "", input });
                    }
                }
                // sawEvent distinguishes "the reply existed but nothing
                // replayable survived the filter" (placeholder — see
                // EMPTY_REPLY_PLACEHOLDER) from "we observed nothing at all"
                // (honest skip: an abort before the first event proves no
                // reply bytes reached us).
                if (!sawEvent) {
                    content = null;
                } else if (content.length === 0) {
                    content = [EMPTY_REPLY_PLACEHOLDER];
                }
            } else {
                try {
                    const json = JSON.parse(buf) as { content?: unknown };
                    if (!Array.isArray(json.content)) {
                        content = null; // not a well-formed reply body — record nothing
                    } else {
                        content = json.content.filter((b) => {
                            if (typeof b !== "object" || b === null) return false;
                            const t = (b as { type?: unknown }).type;
                            return t === "text" || t === "tool_use";
                        }) as unknown[];
                        if (content.length === 0) content = [EMPTY_REPLY_PLACEHOLDER];
                    }
                } catch {
                    content = null;
                }
            }
            if (content === null) return;
            const entry: ThreadsMirrorEntry = { role: "assistant", content };
            const sized = serializeEntry(entry);
            const pushEntry: ThreadsMirrorEntry = sized.ok
                ? sized.value
                : { role: "assistant", content: `[threads-lane] oversized assistant reply elided from the mirror (${sized.bytes} bytes)` };
            const store = laneStore();
            const mirror = loadMirror(store, sessionId);
            if (!mirror.available) return;
            const entries = [...mirror.entries, pushEntry];
            persistMirror(store, sessionId, { ...mirror.meta, count: entries.length }, entries, log);
        } catch {
            // fail-open: mirroring must never break the turn (#2926 posture)
        }
    })();
    pendingCaptures.add(capture);
    void capture.finally(() => pendingCaptures.delete(capture));
}

/** Mirror estimate: shape + folded summary + post-fold entries. The wire
 *  body is useless here (a continue is always small) — this is the lane's
 *  only budget truth. */
export function estimateThreadsTokens(meta: ThreadsMirrorMeta, entries: ThreadsMirrorEntry[]): number {
    const tail = entries.slice(Math.min(meta.foldedBefore, entries.length));
    const tailTokens = estimateRawBodyTokens({ messages: tail });
    const summaryTokens = meta.foldedSummary !== undefined ? defaultCountTokens(meta.foldedSummary) : 0;
    return meta.shapeTokens + tailTokens + summaryTokens;
}

export function threadsReforgeEnabled(): boolean {
    try {
        return featureEnabled("anthropicThreadsReforge");
    } catch {
        return false;
    }
}

/** Index of the first tail-ring entry: everything before it gets folded.
 *  Cut on a user-turn boundary (counting user roles from the end) so
 *  tool_use/tool_result pairs inside the folded span never split. */
function ringCutIndex(meta: ThreadsMirrorMeta, entries: ThreadsMirrorEntry[]): number | undefined {
    const from = Math.min(meta.foldedBefore, entries.length);
    let userTurns = 0;
    for (let i = entries.length; i > from; i--) {
        if (entries[i - 1]?.role === "user") {
            userTurns++;
            // Keep the last REFORGE_RING_USER_TURNS user turns: the cut is
            // the START of the Nth-from-last user turn (>=, not >).
            if (userTurns >= REFORGE_RING_USER_TURNS) return i - 1;
        }
    }
    return undefined; // fewer than N+1 user turns in the tail — nothing to fold
}

function renderBlock(block: unknown): string {
    if (typeof block === "string") return block;
    if (block === null || typeof block !== "object") return String(block);
    const b = block as { type?: string; text?: unknown; name?: string; input?: unknown; content?: unknown; tool_use_id?: string; thinking?: unknown };
    if (b.type === "text" && typeof b.text === "string") return b.text;
    if (b.type === "thinking" && typeof b.thinking === "string") return "";
    if (b.type === "tool_use") return `[tool_use ${String(b.name)}] ${JSON.stringify(b.input ?? {}).slice(0, 2000)}`;
    if (b.type === "tool_result") {
        const inner = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "").slice(0, 2000);
        return `[tool_result ${String(b.tool_use_id ?? "")}] ${inner}`;
    }
    return JSON.stringify(block).slice(0, 2000);
}

function renderEntry(entry: ThreadsMirrorEntry): string {
    const role = typeof entry.role === "string" ? entry.role : "?";
    const content = typeof entry.content === "string" ? entry.content
        : Array.isArray(entry.content) ? entry.content.map(renderBlock).join("\n")
        : JSON.stringify(entry.content ?? "").slice(0, 2000);
    return `# ${role}\n${content}`;
}

function renderTranscript(entries: ThreadsMirrorEntry[]): string {
    const parts: string[] = [];
    let bytes = 0;
    for (const entry of entries) {
        const part = renderEntry(entry);
        bytes += Buffer.byteLength(part, "utf8");
        if (bytes > TRANSCRIPT_BYTE_CAP) {
            parts.push("[older entries elided by transcript cap]");
            break;
        }
        parts.push(part);
    }
    return parts.join("\n\n");
}

/** The captured client system when usable as-is (non-empty string or block
 *  array) — otherwise undefined and the caller falls back to the hand-built
 *  billing/summarizer system. */
function capturedSystemVerbatim(system: unknown): unknown {
    if (typeof system === "string") return system.trim() !== "" ? system : undefined;
    if (Array.isArray(system)) return system.length > 0 ? system : undefined;
    return undefined;
}

function buildSummaryRequestBody(shape: ThreadsMirrorShape | undefined, model: string | undefined, meta: ThreadsMirrorMeta, entries: ThreadsMirrorEntry[], cut: number, billingBlock: { type: "text"; text: string } | undefined): Record<string, unknown> {
    const transcript = renderTranscript(entries.slice(Math.min(meta.foldedBefore, cut), cut));
    const verbatim = capturedSystemVerbatim(shape?.system);
    if (verbatim !== undefined) {
        // #3744 variant B (proven against subscription OAuth): the client's
        // original system rides untouched — billing attribution, host identity
        // and cache-control anchors all intact — and the summarizer
        // instructions join the USER message instead of the system slot.
        return {
            model: model ?? shape?.model ?? "claude-sonnet-4-5",
            max_tokens: SUMMARY_MAX_TOKENS,
            stream: false,
            system: verbatim,
            messages: [{ role: "user", content: `${transcript}\n\n---\n\n${SUMMARIZER_SYSTEM}` }],
        };
    }
    const system: unknown[] = billingBlock !== undefined ? [billingBlock, { type: "text", text: SUMMARIZER_SYSTEM }] : [{ type: "text", text: SUMMARIZER_SYSTEM }];
    return {
        model: model ?? shape?.model ?? "claude-sonnet-4-5",
        max_tokens: SUMMARY_MAX_TOKENS,
        stream: false,
        system,
        messages: [{ role: "user", content: transcript }],
    };
}

interface ThreadsReforgeOutcome {
    ok: boolean;
    body?: string;
}

function urlPathOf(url: string): string {
    try {
        const u = new URL(url);
        return u.pathname + u.search;
    } catch {
        return "<bad-url>";
    }
}

/** Pull `error.type`/`error.message` out of a failed side-call body so the
 *  warn log says WHY (e.g. `not_found_error`), not just the status (#3569). */
async function sideCallErrorDetail(resp: Response): Promise<string> {
    try {
        const text = await resp.text();
        if (!text || text.length > 8192) return "";
        const json = JSON.parse(text) as { type?: unknown; message?: unknown; error?: { type?: unknown; message?: unknown } };
        const t = typeof json.error?.type === "string" ? json.error.type : typeof json.type === "string" ? json.type : undefined;
        const m = typeof json.error?.message === "string" ? json.error.message : typeof json.message === "string" ? json.message : undefined;
        return [t !== undefined ? `error.type=${t}` : "", m !== undefined ? `error.message=${m.slice(0, 200)}` : ""].filter(Boolean).join(" ");
    } catch {
        return "";
    }
}

function armReforgeCooldown(sessionId: string): void {
    const now = Date.now();
    reforgeCooldownUntil.set(sessionId, now + SUMMARY_RETRY_COOLDOWN_MS);
    const staleBefore = now - SUMMARY_RETRY_COOLDOWN_MS;
    for (const [id, until] of reforgeCooldownUntil) if (id !== sessionId && until < staleBefore) reforgeCooldownUntil.delete(id);
}

/** #3744: the swapped create reached upstream and was REJECTED — roll the
 *  mirror back to its pre-reforge view (the server-side thread never changed)
 *  and arm the same cooldown the side-call failures use, so the next continue
 *  does not immediately re-summarize + re-rebuild into the same wall. */
export function noteReforgeCreateRejected(
    sessionId: string,
    prevMeta: ThreadsMirrorMeta,
    status: number,
    log: (level: string, msg: string) => void,
): void {
    try {
        const store = laneStore();
        const mirror = loadMirror(store, sessionId);
        if (mirror.available) persistMirror(store, sessionId, { ...prevMeta }, mirror.entries, log);
    } catch {
        // fail-open: the cooldown below still breaks the loop
    }
    armReforgeCooldown(sessionId);
    log("warn", `[${sessionId}] [threads] reforged create rejected by upstream (HTTP ${status}) — mirror rolled back to pre-reforge view, summary side-call cooling down (#3744)`);
}

/** Execute an armed reforge: one summarizer side-call (client's auth, aimed
 *  at the SAME endpoint + proxy decision as the main forward — #3569), then
 *  swap the continue for a fresh create. Fail-open — any error returns
 *  ok:false and the caller forwards the original continue; repeat failures
 *  arm a per-session cooldown so a broken session stops re-uploading its
 *  transcript on every turn. */
export async function executeThreadsReforge(
    plan: ThreadsReforgePlan,
    session: Session,
    req: { headers: Record<string, string | string[] | undefined> },
    upstreamUrl: string,
    proxyUrl: string | undefined,
    parsed: { model?: unknown; stream?: unknown; max_tokens?: unknown; temperature?: unknown; top_p?: unknown; messages?: unknown },
    billingBlock: { type: "text"; text: string } | undefined,
    log: (level: string, msg: string) => void,
): Promise<ThreadsReforgeOutcome> {
    const { sessionId, entries, meta, windowTokens } = plan;
    const cut = ringCutIndex(meta, entries);
    if (cut === undefined) return { ok: false };
    const now = Date.now();
    const coolUntil = reforgeCooldownUntil.get(sessionId);
    if (coolUntil !== undefined && now < coolUntil) {
        log("debug", `[${sessionId}] [threads] summary side-call cooling down (${Math.ceil((coolUntil - now) / 1000)}s left) — forwarding continue unchanged (#3569)`);
        return { ok: false };
    }
    try {
        const summaryReq = buildSummaryRequestBody(meta.shape, typeof parsed.model === "string" ? parsed.model : undefined, meta, entries, cut, billingBlock);
        // #3744 variant B: the side-call must look like the client's own
        // traffic — pass EVERY client header through except hop-by-hop /
        // per-body framing and the one-shot per-request ids; bili's own
        // x-bili-* markers never leave the proxy.
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
            if (SIDE_CALL_STRIP_HEADERS.has(name) || SIDE_CALL_ONE_SHOT_HEADERS.has(name) || name.startsWith("x-bili-")) continue;
            if (typeof value === "string") headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(", ");
        }
        headers["content-type"] = "application/json";
        // Same outbound-fetch contract as every other bili call (#551 idle
        // watchdog, direct-dispatcher fallback, manual redirects); the proxy
        // decision rides the dispatcher exactly like the main forward does.
        let summaryText: string | undefined;
        const { response: resp, clearTimer } = await fetchWithTimeout(upstreamUrl, { method: "POST", headers, body: JSON.stringify(summaryReq), ...(proxyUrl ? { dispatcher: proxyDispatcher(proxyUrl) } : {}) }, SUMMARY_TIMEOUT_MS);
        try {
            if (!resp.ok) {
                const detail = await sideCallErrorDetail(resp);
                armReforgeCooldown(sessionId);
                log("warn", `[${sessionId}] [threads] summary side-call failed (HTTP ${resp.status}${detail ? ` ${detail}` : ""}) → ${urlPathOf(upstreamUrl)} — forwarding continue unchanged (#2926/#3569)`);
                return { ok: false };
            }
            const json = (await resp.json()) as { content?: { type?: string; text?: unknown }[] };
            const textBlock = json.content?.find((b) => b.type === "text");
            summaryText = typeof textBlock?.text === "string" ? textBlock.text : undefined;
        } finally {
            clearTimer();
        }
        if (summaryText === undefined || summaryText.trim() === "") {
            armReforgeCooldown(sessionId);
            log("warn", `[${sessionId}] [threads] summary side-call returned no text (${urlPathOf(upstreamUrl)}) — forwarding continue unchanged (#2926/#3569)`);
            return { ok: false };
        }
        const shape = meta.shape ?? {};
        const createBody: Record<string, unknown> = {
            ...(typeof parsed.model === "string" ? { model: parsed.model } : shape.model !== undefined ? { model: shape.model } : {}),
            ...(shape.system !== undefined ? { system: shape.system } : {}),
            ...(shape.tools !== undefined ? { tools: shape.tools } : {}),
            stream: parsed.stream === true,
            ...(typeof parsed.max_tokens === "number" ? { max_tokens: parsed.max_tokens } : shape.maxTokens !== undefined ? { max_tokens: shape.maxTokens } : { max_tokens: 8192 }),
            ...(parsed.temperature !== undefined ? { temperature: parsed.temperature } : {}),
            ...(parsed.top_p !== undefined ? { top_p: parsed.top_p } : {}),
            thread: { type: "create" },
            messages: [
                { role: "user", content: [{ type: "text", text: `[context management] Older conversation history was folded into this summary:\n\n${summaryText}` }] },
                // entries already include this continue's delta (capture ran
                // before the plan was armed) — the ring + delta ride verbatim.
                ...entries.slice(cut),
            ],
        };
        // The folded prefix shrinks the mirror view: post-fold budget counts
        // only the summary + tail ring from now on.
        const newMeta: ThreadsMirrorMeta = { ...meta, foldedBefore: cut, foldedSummary: summaryText, count: entries.length };
        persistMirror(laneStore(), sessionId, newMeta, entries, log);
        reforgeCooldownUntil.delete(sessionId);
        const est = estimateThreadsTokens(newMeta, entries);
        log("info", `[${sessionId}] [threads] reforge: continue swapped for a fresh create (folded ${cut} entries, mirror est ${est} tok vs window ${windowTokens}) (#2926)`);
        return { ok: true, body: JSON.stringify(createBody) };
    } catch (err) {
        armReforgeCooldown(sessionId);
        log("warn", `[${sessionId}] [threads] reforge aborted (${String(err)}; ${urlPathOf(upstreamUrl)}) — forwarding continue unchanged (#2926/#3569)`);
        return { ok: false };
    }
}
