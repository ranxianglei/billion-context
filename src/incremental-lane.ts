/**
 * #3248 — incremental lane: native-mode clients send only the delta.
 *
 * Contract (POST /__bili/plugin/turn, loopback-gated like every /__bili/
 * surface; headers: x-bili-plugin + optional x-bili-plugin-model):
 *
 *   {
 *     "conversationId": "conv-x",       // stable client conversation id
 *     "sinceSeq": 0,                    // canonical length the client has acked
 *     "resync": false,                  // true → messages[] is a full replacement
 *     "system": "..." | [blocks],       // latest system text (sticky when omitted)
 *     "path": "/v1/messages",           // optional forward path: bare relative (default, rides the lane's default upstream) or /bili/<upstream>/… embedded
 *     "request": { model, max_tokens, tools, stream, ... },  // anthropic params (allowlist)
 *     "messages": [ ...anthropic wire messages... ]
 *       // seed turn   (sinceSeq 0):  full history
 *       // delta turn  (sinceSeq N):  everything after acked seq — INCLUDING the
 *       //                          previous assistant reply (client-owned, #2938-style)
 *   }
 *
 * Responses:
 *   200 — upstream response streamed through; x-bili-applied-seq header carries
 *         the canonical length after the delta was applied.
 *   409 — { error: "seq-mismatch" | "turn-in-flight", serverSeq } — the client
 *         MUST recover with a full resync turn (resync: true, full messages[]).
 *   503 — storage.unified unavailable: the canonical log lives in the unified
 *         messages table (shadow | full); legacy-only lanes cannot serve it.
 *
 * Canonical history model:
 *   - Canonical form = kernel BiliMessage (core). The delta (anthropic wire)
 *     is converted with anthropicToCore; assembly back to wire uses
 *     coreToAnthropic with the persisted cache_control marks. ids derive
 *     deterministically from content (deriveMessageId), so the assembled
 *     prefix is byte-stable across turns → the pipeline's fold ledger sees a
 *     zero-churn resent history (the #3248 payoff: reconciliation retires).
 *   - Durability rides the EXISTING pipeline save path: the assembled body is
 *     processed as a normal plugin-lane request, so snapshotMessages →
 *     rawTail ingest (#3007) + watermark (#3166) append the raw history to the
 *     unified messages table. A post-response flush best-effort closes the
 *     ack/persist gap; a crash in between surfaces as 409 → client resync
 *     (the client keeps its own local history — it is the source of truth
 *     until it chooses to prune, which is exactly the threads-lane model).
 *   - Session identity: NONE of its own. The synthetic request carries the
 *     client's own `x-bili-plugin-conversation` + `x-bili-plugin` headers, so
 *     the pipeline resolves the SAME session id normal plugin traffic for
 *     this conversation would (x-bili-plugin-conversation is the strongest
 *     conversation signal, src/session-id.ts). A conversation can therefore
 *     migrate freely between full-resend mode and the incremental lane —
 *     same session, same fold ledger, same unified-table canonical (the
 *     table rows the pipeline already writes via rawTail ingest #3007 are
 *     exactly the canonical this lane replays). Lane-private state (sticky
 *     system, cache marks) lives in session_ext rows `inc:system` /
 *     `inc:cache-marks` on that same session.
 *
 * Not in v1 (tracked on #3248): server-authored-prefix fast path in the
 * pipeline (skip strip/reconcile walk over the prefix — today the assembled
 * body is walked like any resent history; the walk is cheap and finds
 * nothing, but it is the remaining O(full) CPU), explicit edit/branch ops
 * (R1 message ids), durable acks.
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { anthropicToCore, coreToAnthropic, type BiliMessage } from "acp-kernel/wire";
import { getStore } from "./persist.js";
import { peekSession } from "./session.js";
import { pluginAgentHeader, pluginReportedModel } from "./plugin.js";
import { headerValue, readBody } from "./server.js";
import { featureEnabled } from "./rollout.js";
import { MSG_IDS_BODY_FIELD, MSG_SEQS_BODY_FIELD, applyMsgIdPin, validateMsgIds } from "./msgid-pin.js";

export const INCREMENTAL_TURN_PATH = "/__bili/plugin/turn";

/** Strict body-shape test for the marker divert: is this buffered body an
 * incremental turn payload (vs an ordinary anthropic model request)? The
 * host extension stamps the marker whenever the lane advertises the
 * feature, but individual turns may still ride full-resend (retries, dead
 * conversations, side lanes) — the shape is the final word, so a marker'd
 * ordinary body replays through the normal pipeline untouched. */
export function incrementalTurnBodyShape(raw: Buffer): boolean {
    if (raw.length < 2 || raw.length > 64 * 1024 * 1024) return false;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.toString("utf8"));
    } catch {
        return false;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const body = parsed as Record<string, unknown>;
    // An anthropic model request ALWAYS carries a top-level model string;
    // the incremental payload never does (model lives inside `request`).
    return typeof body.conversationId === "string" && body.conversationId.length > 0
        && typeof body.sinceSeq === "number" && Number.isInteger(body.sinceSeq) && body.sinceSeq >= 0
        && Array.isArray(body.messages)
        && body.model === undefined;
}

/** Lane-side mirror of wireMessagesLookAnthropic (src/agent/incremental-client.ts — keep the two in sync): the lane ingests with anthropicToCore and re-emits with coreToAnthropic, so only the anthropic wire shape is convertible. OpenAI tool shapes (assistant.tool_calls, role:"tool"/"function", tool_call_id) would be silently dropped or mis-mapped into user text — reject loudly at the boundary instead of trusting every host to pre-filter (#3433). Empty lists PASS here: a pure sticky-system update carries no messages (the client-side predicate rejects them; the empty-without-system case is already a 400 below). */
function laneMessagesLookAnthropic(messages: unknown): boolean {
    if (!Array.isArray(messages)) return false;
    for (const m of messages) {
        if (m === null || typeof m !== "object") return false;
        const msg = m as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
        if (typeof msg.role !== "string" || msg.role === "tool" || msg.role === "function") return false;
        if (msg.tool_calls !== undefined || msg.tool_call_id !== undefined) return false;
        if (typeof msg.content !== "string" && !Array.isArray(msg.content)) return false;
    }
    return true;
}

const EXT_KEY_SYSTEM = "inc:system";
const EXT_KEY_CACHE_MARKS = "inc:cache-marks";
const EXT_KEY_BASE_SEQ = "inc:base-seq";
/** #3798: ordered row pointers (seq numbers) of the CURRENT canonical
 *  branch. The base-seq COUNT cutoff assumed the new branch lands as a
 *  contiguous suffix, but remapPlanToAbsolute reuses rows for identical
 *  (msg_id, content_hash) — a resync sharing history with the rejected
 *  branch maps onto rows BELOW the cutoff, and the count slice silently
 *  drops the shared prefix (cold rebuild served a partial history and 409'd
 *  the client into a reseed loop). Pointers name the exact rows instead. */
const EXT_KEY_CANONICAL_PTRS = "inc:canonical-ptrs";

/** Request-param allowlist for the forwarded anthropic body. `messages` and
 *  `system` are owned by the lane (assembled from canonical + payload.system)
 *  and are never taken from `request`. */
const REQUEST_PARAM_KEYS = [
    "model", "max_tokens", "temperature", "top_p", "top_k", "stop_sequences",
    "stream", "tools", "tool_choice", "metadata", "thinking", "service_tier",
    "parallel_tool_calls",
    // Anthropic-on-Vertex sends no `model` — `anthropic_version` replaces it in
    // the body (`vertex-2023-10-16`, live capture 2026-10-15). Without it in
    // this list the lane rebuilds a Vertex turn without the field the endpoint
    // requires, so a native-extension host (pi/dsh) pointed at Vertex would
    // 400. Kept last so the forwarded field order for every other host is
    // unchanged.
    "anthropic_version",
] as const;
const REQUEST_PARAM_KEY_SET = new Set<string>(REQUEST_PARAM_KEYS);

/** Keys the lane assembles from the payload's top level — hosts mirror the
 *  full anthropic body as `request`, so these are by-design, not dropped. */
const LANE_OWNED_REQUEST_KEYS = new Set(["messages", "system"]);

/** #3406 item 6: warn once per conversation+key when a request param falls
 *  outside the allowlist and is silently not forwarded. Bounded: past the
 *  pair budget the map resets and the next epoch warns again (low-frequency
 *  re-warn instead of unbounded memory). */
const droppedParamWarned = new Map<string, Set<string>>();
let droppedParamWarnPairs = 0;
const DROPPED_PARAM_WARN_BUDGET = 4096;

function warnDroppedRequestParams(conversationId: string, request: Record<string, unknown>, log: (level: string, msg: string) => void): void {
    const fresh = Object.keys(request).filter((key) => !REQUEST_PARAM_KEY_SET.has(key) && !LANE_OWNED_REQUEST_KEYS.has(key));
    if (fresh.length === 0) return;
    const seen = droppedParamWarned.get(conversationId) ?? new Set<string>();
    const unwarned = fresh.filter((key) => !seen.has(key));
    if (unwarned.length === 0) return;
    if (droppedParamWarnPairs + unwarned.length > DROPPED_PARAM_WARN_BUDGET) {
        droppedParamWarned.clear();
        droppedParamWarnPairs = 0;
        seen.clear();
    }
    droppedParamWarnPairs += unwarned.length;
    for (const key of unwarned) seen.add(key);
    droppedParamWarned.set(conversationId, seen);
    log("warn", `[incremental] ${conversationId}: request parameter(s) not in the forward allowlist were dropped: ${unwarned.join(", ")} — extend REQUEST_PARAM_KEYS (src/incremental-lane.ts) if they must reach the upstream (#3406)`);
}

/** Wire headers the client may contribute to the forwarded request. */
const PASSTHROUGH_HEADERS = ["authorization", "anthropic-version", "anthropic-beta"] as const;

/** Canonical prefix per conversation, in memory. Bounded LRU: cold entries
 *  rebuild from the unified messages table on demand (see loadCanonical). */
const CANONICAL_LIMIT = 16;
export interface Canonical {
    sessionId: string;
    msgs: BiliMessage[];
    marks: Map<string, unknown>;
    system: unknown;
    systemSet: boolean;
    /** #4352 ack pull: hash of the last WIRE message the canonical was
     *  advanced with (the client-side incrementalWireHash formula over the
     *  delta's final message). Warm-cache only — a cold rebuild has no wire
     *  bytes to hash and reports null; clients treat a null boundary as
     *  "cannot adopt, keep full resend" and self-heal on the next turn. */
    boundary: string | null;
    /** #5155: pre-serialized anthropic items of the rendered message array
     *  (items JSON.stringify-joined with ","), so a turn renders only its
     *  delta and splices it onto the prefix. null while the history carries
     *  raw system messages (the heal pass is position-dependent) or after a
     *  resync. marksVersion guards against a mark landing on a message the
     *  prefix already rendered. */
    renderPrefix: { items: string; len: number; marksVersion: number } | null;
    marksVersion: number;
}
const canonicalCache = new Map<string, Canonical>();
const inFlight = new Set<string>();
/** #3798: per-conversation pointer-recording chains. The next turn awaits
 *  its predecessor's chain so an applied-seq ack can never outrun the
 *  pointer durability of the turn before it. */
const pendingPtrWork = new Map<string, Promise<void>>();

function touchCache(conversationId: string, entry: Canonical): void {
    canonicalCache.delete(conversationId);
    canonicalCache.set(conversationId, entry);
    while (canonicalCache.size > CANONICAL_LIMIT) {
        const oldest = canonicalCache.keys().next().value as string | undefined;
        if (oldest === undefined || oldest === conversationId) break;
        canonicalCache.delete(oldest);
    }
}

function jsonReply(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
}

/** The pipeline resolves the session id from x-bili-plugin-conversation (the
 *  strongest conversation signal) — the lane must bookkeep under that SAME
 *  id (table reads, session_ext rows, post-turn flush) so incremental and
 *  normal plugin traffic stay one session. */
function laneSessionId(conversationId: string): string {
    return conversationId;
}

/** Rebuild the canonical prefix from the unified messages table. `unavailable`
 *  means storage.unified is off (legacy-only lane → 503); `bad` means the
 *  rows exist but do not parse (→ 409 client resync, never a silently-
 *  truncated history). */
function readCanonicalFromStore(sessionId: string): { kind: "ok"; msgs: BiliMessage[] } | { kind: "unavailable" } | { kind: "bad"; err: string } {
    let rows: { seq: number; content: string; ts: number | null }[] | null;
    try {
        rows = getStore().unifiedRawMessages(sessionId);
    } catch {
        return { kind: "unavailable" };
    }
    if (rows === null) return { kind: "unavailable" };
    // #3798 pointer replay: the ext key names the current branch's rows in
    // canonical order. Present-but-broken must NEVER serve a partial history
    // — report bad and let the lane force an honest client resync.
    const ptrs = readCanonicalPointers(sessionId);
    // Pointer freshness is guarded at the WRITE side, not here: a resync
    // invalidates them durably (null, pre-response) and the wrap-up chain
    // re-records the new branch's rows. A null here therefore means either
    // "no pointers yet" or "invalidated, rewrite lost to a crash" — both
    // fall to the legacy epoch slice, which serves the CURRENT branch by
    // construction. Identical-history resyncs deliberately rely on the
    // pointers surviving (rows are REUSED below the count cutoff, #3798).
    if (ptrs !== null) {
        if (ptrs.length === 0) return { kind: "ok", msgs: [] };
        const bySeq = new Map(rows.map((r) => [r.seq, r]));
        const picked: { seq: number; content: string; ts: number | null }[] = [];
        for (const seq of ptrs) {
            const row = bySeq.get(seq);
            if (row === undefined) return { kind: "bad", err: "canonical pointers reference missing rows" };
            picked.push(row);
        }
        const msgs = parseCanonicalRows(picked);
        return msgs === null ? { kind: "bad", err: "malformed canonical rows" } : { kind: "ok", msgs };
    }
    // Legacy epoch (no pointers recorded yet): rows below baseSeq belong to
    // a branch the client already replaced — serve from the current branch only.
    const baseSeq = readBaseSeq(sessionId);
    if (baseSeq > 0) rows = rows.slice(baseSeq);
    const msgs = parseCanonicalRows(rows);
    return msgs === null ? { kind: "bad", err: "malformed canonical rows" } : { kind: "ok", msgs };
}

function parseCanonicalRows(rows: { seq: number; content: string; ts?: number | null }[]): BiliMessage[] | null {
    const msgs: BiliMessage[] = [];
    for (const row of rows) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.content);
        } catch {
            return null;
        }
        if (!parsed || typeof parsed !== "object" || typeof (parsed as BiliMessage).id !== "string" || typeof (parsed as BiliMessage).role !== "string") {
            return null;
        }
        // #4316 layer 3: stamp the unified-ledger seq (store rows are 0-based,
        // the ledger display space is 1-based — same convention as the
        // plugin render endpoint). Store-served canonical messages carry
        // their position on the server-owned log, so fold coverage can key
        // on seq intervals instead of content-hash ids (id churn immune).
        // #4313: ts rides the column, never the stored bytes — hydrate it back
        // onto the message object (absent/NULL = pre-feature, tag stays
        // attribute-free).
        msgs.push({ ...(parsed as BiliMessage), ledgerSeq: row.seq + 1, ...(typeof row.ts === "number" ? { ts: row.ts } : {}) });
    }
    return msgs;
}

function loadMarks(sessionId: string): Map<string, unknown> {
    try {
        const raw = getStore().getSessionExt(sessionId, EXT_KEY_CACHE_MARKS);
        if (Array.isArray(raw)) {
            return new Map(raw.filter((e): e is [string, unknown] => Array.isArray(e) && typeof e[0] === "string"));
        }
    } catch {
        // ext surface unavailable → marks degrade (upstream cache re-pay once); not fatal.
    }
    return new Map();
}

/** Divergent-resync epoch (#3248 review finding): a resync REPLACES the
 *  canonical, but the unified messages table is append-only — the rejected
 *  branch's rows stay. Recording the row count at resync time gives cold
 *  rebuilds the absolute index the CURRENT branch starts at, so the table
 *  keeps its audit copy without polluting the served canonical. Degrades
 *  to the full-union read whenever the ext surface is unavailable (legacy). */
function readBaseSeq(sessionId: string): number {
    try {
        const v = getStore().getSessionExt(sessionId, EXT_KEY_BASE_SEQ);
        return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
    } catch {
        return 0;
    }
}

/** #3798: read the persisted canonical pointers. Null = legacy epoch (the
 *  base-seq count fallback); an array = pointer replay (possibly empty — an
 *  explicitly empty canonical); anything else = malformed → treated as
 *  legacy (the next successful turn rewrites them). */
/** #5155: coreToAnthropic merges runs of consecutive same-role messages
 *  into one output item and flushes around raw system messages, so a prefix
 *  cut at i is reusable only when i-1/i sit on an item boundary: a raw
 *  message on either side, or a role change (runs would otherwise merge
 *  across the cut in the full render but not when the halves are rendered
 *  apart). */
export function laneRenderBoundaryFlushes(msgs: BiliMessage[], i: number): boolean {
    if (i <= 0 || i >= msgs.length) return false;
    const a = msgs[i - 1]!;
    const b = msgs[i]!;
    if ((a as { rawAnthropicMessage?: unknown }).rawAnthropicMessage !== undefined) return true;
    if ((b as { rawAnthropicMessage?: unknown }).rawAnthropicMessage !== undefined) return true;
    const target = (m: BiliMessage): "assistant" | "user" => (m.role === "assistant" ? "assistant" : "user");
    return target(a) !== target(b);
}

/** #5155: serialized anthropic items for this turn's assembled body — the
 *  cached prefix spliced with the freshly rendered delta when the cut is a
 *  boundary and the mark version still matches, otherwise a full render
 *  that also refreshes the cache. Byte-identical to stringifying
 *  coreToAnthropic(msgs, marks) whole (splice joins on ",", exactly what the
 *  array serializer emits between items). */
export function laneItemsForTurn(entry: Canonical, cut: number): string {
    const msgs = entry.msgs;
    const prefix = entry.renderPrefix;
    const anyRaw = msgs.some((m) => (m as { rawAnthropicMessage?: unknown }).rawAnthropicMessage !== undefined);
    if (!anyRaw && prefix !== null && prefix.len === cut && prefix.marksVersion === entry.marksVersion && (cut === msgs.length || laneRenderBoundaryFlushes(msgs, cut))) {
        const deltaMsgs = msgs.slice(cut);
        let items: string;
        if (deltaMsgs.length === 0) {
            items = prefix.items;
        } else {
            const deltaStr = coreToAnthropic(deltaMsgs, entry.marks).map((it) => JSON.stringify(it)).join(",");
            items = prefix.items.length === 0 ? deltaStr : prefix.items + "," + deltaStr;
        }
        entry.renderPrefix = { items, len: msgs.length, marksVersion: entry.marksVersion };
        return items;
    }
    const items = coreToAnthropic(msgs, entry.marks).map((it) => JSON.stringify(it)).join(",");
    entry.renderPrefix = anyRaw ? null : { items, len: msgs.length, marksVersion: entry.marksVersion };
    return items;
}

/** #5155: splice pre-serialized items into the body skeleton. The sentinel
 *  rides the messages array so its serialized form pins the exact splice
 *  point; if the sentinel somehow collides with string values in the
 *  skeleton (forwarded passthrough fields), fall back to a plain full
 *  stringify — correct, just slower. */
const LANE_RENDER_SENTINEL = "\u0000bili-splice-anchor\uE000";

export function laneBodyBuffer(skeleton: Record<string, unknown>, itemsStr: string): Buffer {
    const withSentinel = JSON.stringify({ ...skeleton, messages: [LANE_RENDER_SENTINEL] });
    const needle = JSON.stringify(LANE_RENDER_SENTINEL);
    const at = withSentinel.indexOf(needle);
    if (at >= 0 && withSentinel.indexOf(needle, at + 1) < 0) {
        return Buffer.from(withSentinel.slice(0, at) + itemsStr + withSentinel.slice(at + needle.length));
    }
    return Buffer.from(JSON.stringify({ ...skeleton, messages: JSON.parse(`[${itemsStr}]`) as unknown[] }));
}

function readCanonicalPointers(sessionId: string): number[] | null {
    let v: unknown;
    try {
        v = getStore().getSessionExt(sessionId, EXT_KEY_CANONICAL_PTRS);
    } catch {
        return null;
    }
    if (!Array.isArray(v)) return null;
    if (v.every((e) => typeof e === "number" && Number.isSafeInteger(e) && e >= 0)) return v as number[];
    return null;
}

/** Stable projection of a core message for pointer matching. The row's
 *  content is the PIPELINE's serialization (prepare re-derives core from the
 *  assembled wire body), which re-stamps presentation fields like
 *  wireIndex by full-body position - verbatim JSON equality would miss.
 *  Content-derived ids are unique per content, but the in-memory canonical
 *  keeps the base id while the store clusters duplicate rows as
 *  `<base-id>_<n>` (see CLUSTER_ID_SUFFIX_RE), so exact id equality only
 *  pins the first occurrence. */
const CLUSTER_ID_SUFFIX_RE = /^(\["h_[0-9a-f]{16})_\d+/;
function stableMessageKey(m: Record<string, unknown>): string {
    const text = typeof m.text === "string" ? m.text : typeof m.content === "string" ? m.content : null;
    const media = typeof m.imageBase64 === "string" ? m.imageBase64.length : null;
    return JSON.stringify([m.id, m.role, m.contentType, text, media]);
}

/** #3798/#5155: after a turn, pin the canonical to the exact rows that
 *  carry it. Matching uses the stable projection (see stableMessageKey) —
 *  the row content is the pipeline's serialization, which re-stamps
 *  presentation fields like wireIndex by full-body position, so verbatim
 *  JSON equality would miss. #5155 windowed: only rows strictly above the
 *  highest recorded pointer can hold the new tail, so upkeep parses a
 *  handful of fresh rows instead of walking the whole table every turn.
 *  Any miss → leave the previous pointers untouched (never a partial list);
 *  with the debounced save this is the common case right after a turn — a
 *  later settled turn records them. */
function recordCanonicalPointers(sessionId: string, msgs: BiliMessage[], log: (l: string, m: string) => void): void {
    try {
        const store = getStore();
        const prevPtrs = readCanonicalPointers(sessionId);
        let ptrs: number[];
        let rows: { seq: number; content: string; ts: number | null }[] | null;
        if (prevPtrs !== null && prevPtrs.length <= msgs.length) {
            ptrs = [...prevPtrs];
            rows = store.unifiedRawMessages(sessionId, ptrs.length > 0 ? Math.max(...ptrs) : -1);
        } else {
            ptrs = [];
            rows = store.unifiedRawMessages(sessionId);
        }
        if (rows === null) return;
        // Duplicate-content messages are clustered by the content store under
        // `<base-id>_<n>` row ids while the in-memory canonical keeps the base
        // id, so an exact-key lookup misses on every occurrence past the first
        // (e.g. repeated identical tool args). Match on the cluster-stripped
        // key and hand out settled rows in seq order: same stripped key means
        // identical role/contentType/text/media, so any of the clustered rows
        // materializes that canonical message byte-identically.
        const byStable = new Map<string, number[]>();
        for (const r of rows) {
            try {
                const key = stableMessageKey(JSON.parse(r.content) as Record<string, unknown>).replace(CLUSTER_ID_SUFFIX_RE, "$1");
                const bucket = byStable.get(key);
                if (bucket === undefined) byStable.set(key, [r.seq]);
                else bucket.push(r.seq);
            } catch {
                // unparseable row -> skip; a miss keeps the previous pointers
            }
        }
        for (let i = ptrs.length; i < msgs.length; i++) {
            const m = msgs[i]!;
            const bucket = byStable.get(stableMessageKey(m as unknown as Record<string, unknown>).replace(CLUSTER_ID_SUFFIX_RE, "$1"));
            const seq = bucket === undefined ? undefined : bucket.shift();
            if (seq === undefined) {
                // #5155: with the debounced save the unsettled tail is the
                // common case right after a turn — record the settled prefix
                // (progress beats all-or-nothing now that pointer freshness
                // is decoupled from the ack) and let the next flush/turn
                // finish the list. A settled prefix is always a correct
                // prefix of the canonical; a cold rebuild in the window
                // serves a short history and the client resyncs (409).
                break;
            }
            ptrs.push(seq);
            // #4316 PR2/3: while walking the settled rows anyway, stamp the
            // in-memory canonical with its ledger position — the warm entry
            // keeps in-memory messages that predate the rows, so the stamps
            // must flow BACK into it each wrap-up for the next turn's
            // assembly (store seq is 0-based; the ledger display space is
            // 1-based, same convention as parseCanonicalRows).
            m.ledgerSeq = seq + 1;
        }
        if (ptrs.length === 0) {
            log("debug", `[incremental] canonical pointers not recorded for ${sessionId}: no message rows settled yet (debounced save) — retrying on the next flush`);
            return;
        }
        store.setSessionExt(sessionId, EXT_KEY_CANONICAL_PTRS, ptrs);
    } catch (err) {
        log("warn", `[incremental] canonical pointers not recorded for ${sessionId}: ${String(err)}`);
    }
}

async function recordResyncBaseSeq(sessionId: string, log: (l: string, m: string) => void): Promise<void> {
    try {
        const store = getStore();
        // Settle any debounced save of the outgoing branch FIRST, so the
        // count cannot miss its rows (a straggler row landing above the
        // marker would pollute the next branch's slice).
        const warm = peekSession(sessionId);
        if (warm) await store.writeNow(warm);
        const rows = store.unifiedRawMessages(sessionId);
        const count = rows ? rows.length : 0;
        if (count > 0) {
            store.setSessionExt(sessionId, EXT_KEY_BASE_SEQ, count);
            // #3798: the old branch's pointers are now meaningless — dropping
            // them HERE (pre-response, durable with the epoch) means a crash
            // can never resurrect the replaced branch through stale pointers;
            // the post-turn chain re-records the new branch's pointers.
            store.setSessionExt(sessionId, EXT_KEY_CANONICAL_PTRS, null);
        }
    } catch (err) {
        log("warn", `[incremental] resync epoch not recorded for ${sessionId}: ${String(err)} — cold rebuilds will serve the full row union until the next resync`);
    }
}

function persistLaneState(sessionId: string, system: unknown, systemSet: boolean, marks: Map<string, unknown>, log: (l: string, m: string) => void): void {
    try {
        const store = getStore();
        if (systemSet) store.setSessionExt(sessionId, EXT_KEY_SYSTEM, system as never);
        store.setSessionExt(sessionId, EXT_KEY_CACHE_MARKS, [...marks.entries()] as never);
    } catch (err) {
        // shadow-only lanes without ext access fail here every turn — warn once per call site is enough for v1.
        log("warn", `[incremental] failed to persist lane state for ${sessionId}: ${String(err)}`);
    }
}

export function loadSystem(sessionId: string): unknown {
    try {
        return getStore().getSessionExt(sessionId, EXT_KEY_SYSTEM);
    } catch {
        return undefined;
    }
}

/** Seed/append/resync validation + application. Pure over the canonical. */
/** Byte-identical to the client-side incrementalWireHash
 *  (src/agent/incremental-client.ts) over the raw wire message — the two
 *  formulas must never diverge or the pull-ack boundary check degrades into
 *  permanent false mismatches. */
function hashWireBoundary(m: { role: string; content: unknown }): string {
    return createHash("sha256").update(`${m.role}\u0000${JSON.stringify(m.content)}`).digest("hex").slice(0, 16);
}

function applyTurn(
    entry: Canonical,
    sinceSeq: number,
    resync: boolean,
    deltaWire: { role: string; content: unknown }[],
    systemUpdate = false,
    /** #4491: optional client msgids parallel to deltaWire. Pinned onto the
     *  converted core messages so the canonical (and every downstream row /
     *  ref) carries the CLIENT's identity, not a content-derived hash. A
     *  malformed or already-claimed id hard-fails the turn (400) — an id
     *  collision in the ledger would misattribute decompress lookups. */
    deltaIds?: string[],
): { ok: true; appliedSeq: number; marks: Map<string, unknown> } | { ok: false; status: 400 | 409; error: string; serverSeq: number } {
    const serverSeq = entry.msgs.length;
    if (resync) {
        // Full replacement: the client is the source of truth for the whole
        // history (edit / branch reset / recovery). Marks and system survive.
    } else if (sinceSeq !== serverSeq) {
        // Strict ack contract — including sinceSeq 0 against a populated
        // canonical: a client that believes it is seeding a fresh server must
        // say so with resync: true, never silently replace live history.
        return { ok: false, status: 409, error: "seq-mismatch", serverSeq };
    }
    if (!Array.isArray(deltaWire) || (deltaWire.length === 0 && !systemUpdate)) {
        return { ok: false, status: 400, error: "messages must be a non-empty array", serverSeq };
    }
    const flat = deltaWire.length === 0 ? { msgs: [], cacheControls: new Map<string, unknown>() } : anthropicToCore({ messages: deltaWire as never } as never);
    let deltaMsgs = flat.msgs;
    if (deltaIds !== undefined) {
        const v = validateMsgIds(deltaIds, flat.msgs.length);
        if (!v.ok && v.reason !== "length-mismatch") {
            return { ok: false, status: 400, error: `msgIds invalid (${v.reason})`, serverSeq };
        }
        if (v.ok) {
            const claimed = new Set(entry.msgs.map((m) => m.id));
            for (const id of v.ids) {
                if (!resync && claimed.has(id)) return { ok: false, status: 400, error: "msgIds reuse an existing canonical id", serverSeq };
            }
            deltaMsgs = applyMsgIdPin(flat.msgs, v.ids);
        }
        // !v.ok && reason === "length-mismatch": the envelope gate already
        // proved the ids are parallel to the WIRE messages, so a mismatch
        // HERE means the wire→core conversion expanded multi-block messages
        // (1 wire → N core rows — assistant [text+tool_use], user
        // [text+tool_result]) — exactly the "core conversion can legally map
        // wire messages non-1:1" case the lane contract (#4491, envelope
        // gate in applyIncrementalTurn) says must DEGRADE to derived ids,
        // never hard-fail. A 400 here made every dsh/omp turn carrying a
        // multi-block message fail forever — the client retries the same
        // shape and has no 400 recovery (only 200/409/503 are handled).
    }
    const base = resync ? [] : entry.msgs;
    entry.msgs = [...base, ...deltaMsgs];
    const marksTouched = flat.cacheControls.size > 0;
    for (const [id, mark] of flat.cacheControls) entry.marks.set(id, mark);
    // #5155: a mark can legally target an id the prefix already rendered
    // (content-derived id collision with a re-sent message), so any cache
    // control invalidates the pre-serialized prefix; resync replaces the
    // history wholesale.
    if (marksTouched) entry.marksVersion++;
    if (resync) entry.renderPrefix = null;
    entry.boundary = deltaWire.length > 0
        ? hashWireBoundary(deltaWire[deltaWire.length - 1])
        : (resync ? null : entry.boundary);
    return { ok: true, appliedSeq: entry.msgs.length, marks: flat.cacheControls };
}

/**
 * Serve one incremental turn. `forward` re-enters the proxy pipeline with a
 * synthetic anthropic request (same process, no loopback hop) and owns the
 * response end-to-end — this handler only decorates it with the ack header.
 */
/** Test seam: drop the warm canonical caches and in-flight locks so a test
 * can simulate a process restart (cold rebuild from the unified table). */
/** Test seam: the per-conversation pointer-durability chain for the most
 *  recent turn, so tests can model a REAL client (whose next turn awaits
 *  the chain server-side) before simulating a restart. A crash inside the
 *  chain's window leaves the pointers one turn stale — same window as the
 *  unified rows themselves. */
export function __incrementalPtrChainForTests(conversationId: string): Promise<void> | undefined {
    return pendingPtrWork.get(conversationId);
}

export function __resetIncrementalLaneForTests(): void {
    canonicalCache.clear();
    inFlight.clear();
    pendingPtrWork.clear();
    droppedParamWarned.clear();
    droppedParamWarnPairs = 0;
}

/** Marker header native extensions stamp on an ordinary model request to
 * divert it into the incremental lane (#3248). The request's own URL is the
 * forward path, so no provider/baseURL reconfiguration is needed. */
export const INCREMENTAL_TURN_MARKER_HEADER = "x-bili-plugin-turn";

/** Effective gate for the marker path + probe: the rollout feature must be
 *  enabled for this install AND the unified sidecar must be live (shadow or
 *  full both feed the canonical table; legacy-only cannot serve rebuilds). */
export function incrementalTurnsEnabled(): boolean {
    if (!featureEnabled("pluginIncrementalTurns")) return false;
    try {
        return getStore().replicasAvailable();
    } catch {
        return false;
    }
}

/** GET probe on the turn path: capabilities for native extensions. A 404 on
 *  older servers means "no incremental support" — clients fall back to full
 *  resend, which is the default everywhere. */
export function handleIncrementalProbe(res: http.ServerResponse, conversationId?: string): void {
    const sidecar = (() => {
        try {
            return getStore().replicasAvailable();
        } catch {
            return false;
        }
    })();
    // #4352 ack pull: `?conversation=<id>` upgrades the probe into a receipt
    // poll. Served from the WARM canonical only — a cold rebuild here must
    // not touchCache (a probe is not a turn), and a rebuilt entry has no wire
    // boundary to hash, so an honest null forces the client to keep full
    // resend for one more turn instead of adopting a guess.
    let conversation: { appliedSeq: number; boundary: string | null } | undefined;
    if (conversationId !== undefined && conversationId.length > 0) {
        const entry = canonicalCache.get(conversationId);
        conversation = {
            appliedSeq: entry !== undefined && entry.sessionId === laneSessionId(conversationId) ? entry.msgs.length : 0,
            boundary: entry !== undefined && entry.sessionId === laneSessionId(conversationId) ? entry.boundary : null,
        };
    }
    jsonReply(res, 200, {
        ok: true,
        protocol: 1,
        feature: "pluginIncrementalTurns",
        enabled: featureEnabled("pluginIncrementalTurns") && sidecar,
        storage: sidecar ? "unified" : "legacy-only",
        // #4491: server-owned history for plugin lanes (msgid pinning + the
        // /__bili/plugin/render endpoint). Shims gate their splice on this.
        serverHistory: featureEnabled("pluginLaneServerHistory"),
        ...(conversation !== undefined ? { conversation } : {}),
    });
}

export async function handleIncrementalTurn(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    log: (level: string, msg: string) => void,
    forward: (syntheticReq: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
    originalPath?: string,
    /** Marker-divert callers have already buffered the request body (to
     * shape-test it); pass it here so the stream is not re-read. */
    rawBody?: Buffer,
): Promise<void> {
    const agent = pluginAgentHeader(req.headers);
    if (!agent) return jsonReply(res, 400, { error: "incremental lane requires the x-bili-plugin header (agent identity)" });
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse((rawBody !== undefined ? rawBody : await readBody(req)).toString("utf8")) as Record<string, unknown>;
    } catch {
        return jsonReply(res, 400, { error: "invalid JSON body" });
    }
    const conversationId = typeof payload.conversationId === "string" ? payload.conversationId.trim() : "";
    if (!conversationId || conversationId.length > 512) return jsonReply(res, 400, { error: "conversationId must be a non-empty string (≤512 chars)" });
    const sinceSeq = typeof payload.sinceSeq === "number" && Number.isInteger(payload.sinceSeq) && payload.sinceSeq >= 0 ? payload.sinceSeq : -1;
    if (sinceSeq === -1) return jsonReply(res, 400, { error: "sinceSeq must be a non-negative integer" });
    const resync = payload.resync === true;
    const system = "system" in payload ? payload.system : undefined;
    // Forward path for the assembled request. Both routing forms are
    // accepted: a bare relative path ("/v1/messages" — rides the lane's
    // configured default upstream) or the explicit /bili/<upstream>/…
    // embedded form. The marker divert passes the ORIGINAL request URL as
    // `originalPath` — when present it wins, because the caller routed an
    // ordinary model request (no provider/baseURL reconfiguration).
    const path = originalPath !== undefined
        ? originalPath
        : typeof payload.path === "string" && payload.path.length > 0 ? payload.path : "/v1/messages";
    if (!path.startsWith("/") || path.length > 2048) return jsonReply(res, 400, { error: "path must be a relative HTTP path (/v1/messages or /bili/<upstream>/…)" });
    const request = payload.request && typeof payload.request === "object" && !Array.isArray(payload.request) ? payload.request as Record<string, unknown> : {};
    const model = typeof payload.model === "string" && payload.model.length > 0 ? payload.model : pluginReportedModel(req.headers);
    const forwarded: Record<string, unknown> = {};
    for (const key of REQUEST_PARAM_KEYS) if (key in request) forwarded[key] = request[key];
    warnDroppedRequestParams(conversationId, request, log);
    if (typeof model === "string" && model.length > 0) forwarded.model = model;
    if (typeof forwarded.model !== "string" || forwarded.model.length === 0) return jsonReply(res, 400, { error: "request.model is required" });
    if (!Array.isArray(payload.messages)) return jsonReply(res, 400, { error: "messages must be an array (seed: full history; delta: everything after sinceSeq; empty allowed for a pure sticky-system update)" });
    if (payload.messages.length === 0 && payload.system === undefined) return jsonReply(res, 400, { error: "messages must be a non-empty array (seed: full history; delta: everything after sinceSeq)" });
    if (!laneMessagesLookAnthropic(payload.messages)) return jsonReply(res, 400, { error: 'messages must be anthropic wire shape — OpenAI tool shapes (assistant.tool_calls, role:"tool", tool_call_id) cannot ride the lane and stay on full resend', conversationId });
    const deltaWire = payload.messages;
    // #4491: optional client msgids parallel to messages (absent = legacy
    // content-derived identities). Identity-poisoning shapes (bad entry,
    // duplicate, reserved prefix, re-claimed id) hard-fail in applyTurn; a
    // mere count mismatch degrades to derived ids — the core conversion can
    // legally map wire messages non-1:1, and a mismatched array pins nothing.
    let deltaIds: string[] | undefined;
    if (payload.msgIds !== undefined) {
        if (!Array.isArray(payload.msgIds)) return jsonReply(res, 400, { error: "msgIds must be an array parallel to messages" });
        const candidate = payload.msgIds as string[];
        if (candidate.length === deltaWire.length) {
            deltaIds = candidate;
        } else {
            log("warn", `[incremental] ${conversationId}: msgIds length ${String(candidate.length)} != messages length ${String(deltaWire.length)} — ignoring ids this turn (#4491)`);
        }
    }

    // Per-conversation turn lock: the ack contract is strictly sequential.
    // The 409 fires only for turns arriving while the holder is INSIDE its
    // response phase (between entry and forward completion) — a concurrent
    // sender gets the documented refusal. Turns arriving after the ack
    // (holder in wrap-up: rows + pointer durability) pass the guard and
    // AWAIT that wrap-up chain first, so an ack can never outrun the
    // previous turn's rows (#3798). A turn that slips in behind such a
    // waiter re-checks inFlight and takes the retriable 409.
    if (inFlight.has(conversationId)) return jsonReply(res, 409, { error: "turn-in-flight", conversationId });
    const pendingPtrs = pendingPtrWork.get(conversationId);
    if (pendingPtrs) await pendingPtrs;
    if (inFlight.has(conversationId)) return jsonReply(res, 409, { error: "turn-in-flight", conversationId });
    inFlight.add(conversationId);
    let releaseChain: (() => void) | undefined;
    let settled = false;
    const chain = new Promise<void>((resolve) => {
        releaseChain = resolve;
    });
    pendingPtrWork.set(conversationId, chain);
    try {
        const sessionId = laneSessionId(conversationId);
        let entry = canonicalCache.get(conversationId);
        if (!entry || entry.sessionId !== sessionId) {
            // Warm cache is per-process; after a restart (or LRU eviction) the
            // canonical prefix is rebuilt from the unified messages table —
            // which normal plugin traffic for this conversation ALSO feeds
            // (rawTail ingest), so a mode switch needs no ceremony.
            const rebuilt = readCanonicalFromStore(sessionId);
            if (rebuilt.kind === "unavailable") {
                return jsonReply(res, 503, { error: "incremental lane requires storage.unified (shadow or full); this lane runs legacy-only" });
            }
            if (rebuilt.kind === "bad") {
                log("warn", `[incremental] canonical rebuild failed for ${sessionId}: ${rebuilt.err} — requesting client resync`);
                return jsonReply(res, 409, { error: "seq-mismatch", serverSeq: 0, reason: rebuilt.err, conversationId });
            }
            entry = { sessionId, msgs: rebuilt.msgs, marks: loadMarks(sessionId), system: loadSystem(sessionId), systemSet: false, boundary: null, renderPrefix: null, marksVersion: 0 };
        }
        const msgsBefore = entry.msgs.length;
        const applied = applyTurn(entry, sinceSeq, resync, deltaWire as never, "system" in payload, deltaIds);
        if (!applied.ok) {
            touchCache(conversationId, entry);
            return jsonReply(res, applied.status, { error: applied.error, serverSeq: applied.serverSeq, conversationId });
        }
        if ("system" in payload) {
            entry.system = system;
            entry.systemSet = true;
        }
        touchCache(conversationId, entry);
        // Record the epoch BEFORE the forward lands the new branch's rows.
        if (resync) await recordResyncBaseSeq(sessionId, log);
        persistLaneState(sessionId, entry.system, entry.systemSet, entry.marks, log);

        const body: Record<string, unknown> = { ...forwarded };
        // #5155: the messages array is spliced from the pre-serialized prefix
        // (#5155 laneItemsForTurn) — only the delta rides the renderer.
        const itemsStr = laneItemsForTurn(entry, resync ? 0 : msgsBefore);
        if (entry.system !== undefined && entry.system !== null) body.system = entry.system;
        // #4491: the assembled prefix re-enters the pipeline as a fresh body —
        // stamp the canonical ids so prepare pins exactly what the lane owns
        // (content-derived when the client sent none; client-pinned when it
        // did). The pipeline strips the field before forwarding upstream.
        if (featureEnabled("pluginLaneServerHistory")) {
            body[MSG_IDS_BODY_FIELD] = entry.msgs.map((m) => m.id);
            // #4316 PR2/3: seq stamps ride the same internal transport. The
            // canonical prefix carries its stamps from the unified rows
            // (parseCanonicalRows); this turn's delta tail has no rows yet,
            // but the wrap-up appends them at maxSeq+1 in order (#5155:
            // asynchronously — the stamps may not have landed yet when the
            // next turn assembles). Stamps always form a prefix of
            // entry.msgs, so projecting the unstamped suffix from the last
            // stamped seq (+1 from 0 when nothing is stamped yet — the first
            // resync's rows settle in message order) is exact.
            let maxSeq = -1; // 0-based store seq of the last stamped message
            for (const m of entry.msgs) if (typeof m.ledgerSeq === "number") maxSeq = Math.max(maxSeq, m.ledgerSeq - 1);
            let next = maxSeq + 1;
            for (const m of entry.msgs) {
                if (typeof m.ledgerSeq !== "number") {
                    m.ledgerSeq = next + 1;
                    next++;
                }
            }
            const seqs = entry.msgs.map((m) => m.ledgerSeq);
            body[MSG_SEQS_BODY_FIELD] = seqs;
        }
        const bodyBuf = laneBodyBuffer(body, itemsStr);

        const headers: Record<string, string> = {
            "content-type": "application/json",
            "content-length": String(bodyBuf.length),
            host: headerValue(req, "host") ?? "127.0.0.1",
            // Session identity rides the CLIENT's own conversation header (the
            // strongest signal in the pipeline) — see laneSessionId().
            "x-bili-plugin": agent,
            "x-bili-plugin-conversation": conversationId,
            accept: headerValue(req, "accept") ?? "application/json",
        };
        // Plugin capability headers the client may contribute on the turn
        // POST (context window / max output reports for the [window] clamp).
        for (const h of ["x-bili-plugin-context-window", "x-bili-plugin-max-output"] as const) {
            const v = headerValue(req, h);
            if (v !== undefined) headers[h] = v;
        }
        for (const h of PASSTHROUGH_HEADERS) {
            const v = headerValue(req, h);
            if (v !== undefined) headers[h] = v;
        }
        if (model !== undefined) headers["x-bili-plugin-model"] = model;

        const synthetic = Readable.from([bodyBuf]) as unknown as http.IncomingMessage;
        Object.assign(synthetic, {
            method: "POST",
            url: path,
            headers,
            // #3343: the REAL caller's socket object — never a forged or
            // field-copied loopback one (a `?? "127.0.0.1"` fallback would
            // re-forge peers whose address is undefined, e.g. unix sockets).
            // Every downstream gate (admin plane, tunnel admission,
            // provenance) must judge the actual peer; loopback topology is
            // unchanged (real == 127.0.0.1), a non-loopback peer degrades to
            // ordinary model traffic and can no longer ride onto the
            // management plane.
            socket: req.socket,
        });

        // Ack header: stamped ONLY on 2xx — a non-2xx response means the turn
        // did not land, and a host trusting the ack unconditionally would skip
        // its resend and lose the user's message (#3344). In-repo clients gate
        // on 200 already, so this tightens the contract rather than changing
        // any live behavior.
        const appliedSeq = applied.appliedSeq;
        const originalWriteHead = res.writeHead.bind(res) as (...args: never[]) => ReturnType<typeof res.writeHead>;
        (res as { writeHead?: unknown }).writeHead = (...args: unknown[]) => {
            const status = typeof args[0] === "number" ? args[0] : 200;
            if (status >= 200 && status < 300) {
                try {
                    res.setHeader("x-bili-applied-seq", String(appliedSeq));
                } catch {
                    // header injection is best-effort; the seq is also in the log line
                }
            }
            return (originalWriteHead as (...a: unknown[]) => ReturnType<typeof res.writeHead>)(...args);
        };
        const releaseWriteHead = (): void => {
            (res as { writeHead?: unknown }).writeHead = originalWriteHead as unknown as never;
        };
        log("info", `[incremental] turn ${conversationId} since=${String(sinceSeq)} applied=${String(appliedSeq)} agent=${agent} model=${String(model)} → forward ${path}`);
        // Best-effort durability close-out: flush the session once the
        // response has fully left so the canonical table catches up with the
        // ack before the client can act on the next turn.
        await forward(synthetic, res);
        releaseWriteHead();
        // #3798: forward() completing means the response phase is over — the
        // holder leaves inFlight here, and the wrap-up chain (rows + pointer
        // durability) floats behind the ack; the next turn awaits it at
        // entry. Persist failures only delay pointer freshness — the epoch
        // guard covers a cold rebuild in the window.
        inFlight.delete(conversationId);
        const session = peekSession(sessionId);
        settled = true;
        // #5155: the debounced save coalesces consecutive turns' full-envelope
        // flushes (a synchronous writeNow per turn serialized + fsynced the
        // whole ~24MB envelope on large histories); pointer upkeep no longer
        // waits on the flush — rows that have not settled yet leave the
        // previous pointers in place and a later settled turn records them.
        // A crash inside the window costs a 409 resync (the contract the lane
        // already blesses), never a wrong history.
        try {
            if (session) getStore().scheduleSave(session);
        } catch {
            // best-effort, same failure posture as the old writeNow chain
        }
        // #5155: rows settle in the debounced flush, so a synchronous
        // pointer attempt here would re-walk the tail for a guaranteed miss;
        // afterNextFlush resolves immediately when no flush is pending, which
        // converges right after an already-settled turn all the same.
        // This floats BEHIND the chain release: the ack is never delayed by
        // pointer freshness, and a crash in the window costs a 409 resync.
        void getStore()
            .afterNextFlush(sessionId)
            .then(() => {
                const live = canonicalCache.get(conversationId);
                if (live && live.sessionId === sessionId) recordCanonicalPointers(sessionId, live.msgs, log);
            })
            .catch(() => undefined);
        releaseChain?.();
        if (pendingPtrWork.get(conversationId) === chain) pendingPtrWork.delete(conversationId);
    } finally {
        // Exception path (never entered the wrap-up): release everything.
        if (!settled) {
            releaseChain?.();
            inFlight.delete(conversationId);
            if (pendingPtrWork.get(conversationId) === chain) pendingPtrWork.delete(conversationId);
        }
    }
}
