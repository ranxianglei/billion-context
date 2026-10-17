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

const EXT_KEY_SYSTEM = "inc:system";
const EXT_KEY_CACHE_MARKS = "inc:cache-marks";
const EXT_KEY_BASE_SEQ = "inc:base-seq";

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
interface Canonical {
    sessionId: string;
    msgs: BiliMessage[];
    marks: Map<string, unknown>;
    system: unknown;
    systemSet: boolean;
    /** #3352: wire hash (sha256(role\u0000JSON.stringify(content))[:16]) of
     *  the last wire message this lane applied — the pull receipt boundary.
     *  Warm-cache only: it describes the tail of THIS entry's msgs, which
     *  only applyTurn mutates. Cold rebuilds report null (see
     *  handleIncrementalProbe) — a persisted boundary would go stale when
     *  rawTail rows append after the last incremental turn, and a stale
     *  match would let a client adopt a watermark that counts foreign rows
     *  (duplicate-serving); null forces the honest resync instead. */
    boundary: string | null;
}
const canonicalCache = new Map<string, Canonical>();
const inFlight = new Set<string>();

/** #3352: the exact wire-hash formula incremental-client.ts applies to its
 *  outgoing messages (role + \u0000 + JSON.stringify(content), first 16 hex
 *  chars of sha256). The pull receipt's boundary must be comparable to the
 *  hash the CLIENT computed over its own bytes, so the lane replicates the
 *  formula on the wire messages it applies — never on converted core form
 *  (JSON key order could differ after anthropicToCore→coreToAnthropic and
 *  a false mismatch would resync-loop the conversation). */
function hashWireMessage(msg: { role: string; content: unknown } | undefined): string | null {
    if (msg === undefined || typeof msg.role !== "string") return null;
    return createHash("sha256").update(`${msg.role}\u0000${JSON.stringify(msg.content)}`).digest("hex").slice(0, 16);
}

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
    let rows: { seq: number; content: string }[] | null;
    try {
        rows = getStore().unifiedRawMessages(sessionId);
    } catch {
        return { kind: "unavailable" };
    }
    if (rows === null) return { kind: "unavailable" };
    // Divergent-resync epoch: rows below baseSeq belong to a branch the
    // client already replaced — serve from the current branch only.
    const baseSeq = readBaseSeq(sessionId);
    if (baseSeq > 0) rows = rows.slice(baseSeq);
    const msgs = parseCanonicalRows(rows);
    return msgs === null ? { kind: "bad", err: "malformed canonical rows" } : { kind: "ok", msgs };
}

function parseCanonicalRows(rows: { seq: number; content: string }[]): BiliMessage[] | null {
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
        msgs.push(parsed as BiliMessage);
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
        if (count > 0) store.setSessionExt(sessionId, EXT_KEY_BASE_SEQ, count);
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

function loadSystem(sessionId: string): unknown {
    try {
        return getStore().getSessionExt(sessionId, EXT_KEY_SYSTEM);
    } catch {
        return undefined;
    }
}

/** Seed/append/resync validation + application. Pure over the canonical. */
function applyTurn(
    entry: Canonical,
    sinceSeq: number,
    resync: boolean,
    deltaWire: { role: string; content: unknown }[],
    systemUpdate = false,
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
    const base = resync ? [] : entry.msgs;
    entry.msgs = [...base, ...flat.msgs];
    // #3352 pull receipt: the boundary follows the wire tail THIS turn
    // applied — every non-empty apply moves it; a system-only append keeps
    // the tail (and the boundary) unchanged; a system-only resync empties
    // the canonical, so the boundary goes null with it.
    if (deltaWire.length > 0) entry.boundary = hashWireMessage(deltaWire[deltaWire.length - 1]);
    else if (resync) entry.boundary = null;
    for (const [id, mark] of flat.cacheControls) entry.marks.set(id, mark);
    return { ok: true, appliedSeq: entry.msgs.length, marks: flat.cacheControls };
}

/**
 * Serve one incremental turn. `forward` re-enters the proxy pipeline with a
 * synthetic anthropic request (same process, no loopback hop) and owns the
 * response end-to-end — this handler only decorates it with the ack header.
 */
/** Test seam: drop the warm canonical caches and in-flight locks so a test
 * can simulate a process restart (cold rebuild from the unified table). */
export function __resetIncrementalLaneForTests(): void {
    canonicalCache.clear();
    inFlight.clear();
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
 *  resend, which is the default everywhere.
 *
 *  #3352: with `?conversation=<sid>` the probe also returns a RECEIPT for
 *  hosts with no response seam (opencode V2 observes neither the response
 *  headers nor a fetch-patch onResponse — without a receipt their every
 *  turn re-seeds). The receipt carries the warm canonical's length plus its
 *  boundary (wire hash of the last applied wire message). The client adopts
 *  the watermark only when the boundary equals the hash of the last message
 *  it sent — a mismatch (foreign rawTail rows, rewound store, lost branch)
 *  means the tail is NOT the client's, and adopting would double-count: the
 *  receipt is declined instead and the client re-syncs. Boundary is
 *  warm-only by construction (cold rebuilds return null) because the table
 *  can hold rows the lane never applied; appliedSeq of a null-boundary
 *  receipt is still reported for observability but never adoptable. */
export function handleIncrementalProbe(res: http.ServerResponse, conversationId?: string): void {
    const sidecar = (() => {
        try {
            return getStore().replicasAvailable();
        } catch {
            return false;
        }
    })();
    let conversation: { appliedSeq: number; boundary: string | null } | undefined;
    if (conversationId !== undefined && conversationId.length > 0) {
        let entry = canonicalCache.get(conversationId);
        if (entry === undefined) {
            const rebuilt = readCanonicalFromStore(laneSessionId(conversationId));
            if (rebuilt.kind === "ok") {
                entry = { sessionId: laneSessionId(conversationId), msgs: rebuilt.msgs, marks: new Map(), system: undefined, systemSet: false, boundary: null };
            }
        }
        // Deliberately NOT cached: this partial entry (marks/system skipped)
        // exists only to answer the receipt; caching it would poison a later
        // turn into skipping loadMarks/loadSystem.
        conversation = {
            appliedSeq: entry === undefined ? 0 : entry.msgs.length,
            boundary: entry === undefined || entry.sessionId !== laneSessionId(conversationId) ? null : entry.boundary,
        };
    }
    jsonReply(res, 200, {
        ok: true,
        protocol: 1,
        feature: "pluginIncrementalTurns",
        enabled: featureEnabled("pluginIncrementalTurns") && sidecar,
        storage: sidecar ? "unified" : "legacy-only",
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
    const deltaWire = payload.messages;

    // Per-conversation turn lock: the ack contract is strictly sequential.
    if (inFlight.has(conversationId)) return jsonReply(res, 409, { error: "turn-in-flight", conversationId });
    inFlight.add(conversationId);
    let release: (() => void) | undefined;
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
            entry = { sessionId, msgs: rebuilt.msgs, marks: loadMarks(sessionId), system: loadSystem(sessionId), systemSet: false, boundary: null };
        }
        const applied = applyTurn(entry, sinceSeq, resync, deltaWire as never, "system" in payload);
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

        const body: Record<string, unknown> = { ...forwarded, messages: coreToAnthropic(entry.msgs, entry.marks) as never };
        if (entry.system !== undefined && entry.system !== null) body.system = entry.system;
        const bodyBuf = Buffer.from(JSON.stringify(body));

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
        release = (): void => {
            (res as { writeHead?: unknown }).writeHead = originalWriteHead as unknown as never;
        };
        log("info", `[incremental] turn ${conversationId} since=${String(sinceSeq)} applied=${String(appliedSeq)} agent=${agent} model=${String(model)} → forward ${path}`);
        // Best-effort durability close-out: flush the session once the
        // response has fully left so the canonical table catches up with the
        // ack before the client can act on the next turn.
        res.on("finish", () => {
            try {
                const session = peekSession(sessionId);
                if (session) void getStore().writeNow(session).catch(() => undefined);
            } catch {
                // flushing is opportunistic; the debounced save path covers it anyway
            }
        });
        await forward(synthetic, res);
    } finally {
        release?.();
        inFlight.delete(conversationId);
    }
}
