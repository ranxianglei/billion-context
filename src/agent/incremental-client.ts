// Shared incremental-turn client for native extensions (#3248).
//
// Lives in the HOST process (bundled with each native adapter: pi / omp /
// fetch-patched native lanes) and owns the per-conversation ack state:
//   1. probe the lane once per proxy base (GET /__bili/plugin/turn, TTL
//      cache; 404/failed → stay full-resend, byte-identical to today);
//   2. diff the outgoing wire messages against the last acknowledged set —
//      matching prefix → send only the delta; mismatch (edit / branch) →
//      resync with the full history; the server's ack header is the only
//      authority for sinceSeq;
//   3. any lane-level failure (409 storm, 503) falls back to the original
//      full-resend request with the marker removed — behavior equals the
//      pre-incremental world for that turn.
//
// Wire contract: see PLUGIN.md "Incremental turns". Messages are raw wire
// messages ({role, content: string | blocks[]}) — the lane derives stable
// content ids server-side, so hosts without their own message ids work.

import { createHash } from "node:crypto";
import type { DirectSendPrep } from "./native-intercept.js";

/** Marker header the lane's divert recognizes. Client-side copy of
 * INCREMENTAL_TURN_MARKER_HEADER in src/incremental-lane.ts — the host-side
 * helper must not import server modules. Keep the two in sync. */
export const INCREMENTAL_TURN_MARKER_HEADER = "x-bili-plugin-turn";

/** #3329: per-request correlation id stamped on each planned incremental
 * turn. The ack channel (native-intercept's onResponse) only carries the URL,
 * and several conversations share one provider URL — keying the pending-ack
 * table by URL mis-attributes a late response to whichever conversation
 * planned last on that URL. The id rides the outgoing request and is read
 * back from THAT dispatch's own headers when its response lands, so
 * attribution is exact per request. It never travels to the proxy for any
 * purpose (the lane ignores it) — pure in-process correlation. */
export const INCREMENTAL_TURN_ID_HEADER = "x-bili-turn-id";

let turnIdCounter = 0;

/** Fresh per-request turn id: time base + process counter + random tail.
 * Uniqueness only needs to hold inside this process (the id never crosses a
 * wire boundary for correlation purposes). */
export function newIncrementalTurnId(): string {
    return `${Date.now().toString(36)}-${(turnIdCounter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// #3304: originals stash for the direct-send guard. When an adapter swaps a
// request's body for the incremental payload, it stashes the ORIGINAL body
// string under that turn's id. If the proxy dies before the send lands,
// native-intercept's fall-back consults createPrepareDirectSend below and
// either restores these bytes (availability) or refuses the direct send
// (safety) — a lane-only payload never reaches a provider that cannot parse
// it. Entries age out by TTL (a single turn never outlives minutes) and are
// capped so a leak cannot grow the map.
const ORIGINAL_TTL_MS = 5 * 60_000;
const ORIGINAL_MAX_ENTRIES = 256;
const originalBodies = new Map<string, { body: string; at: number }>();

/** Stash the pre-swap body of one planned turn under its turn id. */
export function rememberOriginalBody(turnId: string, body: string): void {
    const now = Date.now();
    for (const [key, entry] of originalBodies) if (now - entry.at >= ORIGINAL_TTL_MS) originalBodies.delete(key);
    if (originalBodies.size >= ORIGINAL_MAX_ENTRIES) {
        let oldestKey: string | undefined;
        let oldestAt = Number.POSITIVE_INFINITY;
        for (const [key, entry] of originalBodies) {
            if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key; }
        }
        if (oldestKey !== undefined) originalBodies.delete(oldestKey);
    }
    originalBodies.set(turnId, { body, at: now });
}

/** Non-consuming lookup: a host-level retry re-dispatches the SAME request
 *  (same turn id) and must get the original back again, so entries are kept
 *  until TTL instead of being deleted on read. */
export function originalBodyForTurn(turnId: string): string | null {
    const entry = originalBodies.get(turnId);
    if (entry === undefined || Date.now() - entry.at >= ORIGINAL_TTL_MS) return null;
    return entry.body;
}

/** #3304: prepareDirectSend implementation for lanes that stamp the turn id
 *  ATOMICALLY with the body swap (dsh / omp / opencode-native): presence of
 *  x-bili-turn-id on the outgoing request proves the body was replaced, so
 *  a missing/expired original means "mutated but unrecoverable" → refuse
 *  rather than risk sending lane-only bytes upstream. Lanes without the hook
 *  (every non-incremental traffic) keep today's byte-identical behavior. */
export function createPrepareDirectSend(): (url: string, input: string | URL | Request, init: RequestInit | undefined) => Promise<DirectSendPrep> {
    return async (_url, input, init) => {
        let turnId: string | null = null;
        try {
            const src = (init?.headers ?? (input instanceof Request ? input.headers : undefined)) as ConstructorParameters<typeof Headers>[0] | undefined;
            if (src !== undefined) turnId = new Headers(src).get(INCREMENTAL_TURN_ID_HEADER);
        } catch {
            turnId = null;
        }
        if (turnId === null) return { outcome: "as-is" };
        const body = originalBodyForTurn(turnId);
        return body === null ? { outcome: "unrestorable" } : { outcome: "restored", body };
    };
}

/** #3304: is this parsed body an incremental envelope — i.e. WOULD the
 *  lane's marker divert claim it? Mirrors incrementalTurnBodyShape in
 *  src/incremental-lane.ts (keep in sync): such a body is lane-only, so it
 *  must never be forwarded to the real upstream as-is. Returns the
 *  conversationId when it matches (pi correlates its stash through it),
 *  undefined otherwise. */
export function incrementalEnvelopeConversationId(body: unknown): string | undefined {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const b = body as Record<string, unknown>;
    if (typeof b.conversationId !== "string" || b.conversationId.length === 0) return undefined;
    if (typeof b.sinceSeq !== "number" || !Number.isInteger(b.sinceSeq) || b.sinceSeq < 0) return undefined;
    if (!Array.isArray(b.messages)) return undefined;
    if (b.model !== undefined) return undefined;
    return b.conversationId;
}

/** #3329: drop pending entries older than `ttlMs` — a planned turn whose
 * response never comes (network-dead request) must not pin its slot forever.
 * Memory hygiene only since attribution is exact per request: correctness no
 * longer depends on how long an entry survives. */
export function sweepStale<T extends { at: number }>(map: Map<string, T>, ttlMs: number): void {
    const now = Date.now();
    for (const [key, entry] of map) if (now - entry.at >= ttlMs) map.delete(key);
}

/** Same allowlist the lane accepts in `request` (mirror of
 * REQUEST_PARAM_KEYS in src/incremental-lane.ts — keep in sync). */
const REQUEST_PARAM_KEYS = [
    "model", "max_tokens", "temperature", "top_p", "top_k", "stop_sequences",
    "stream", "tools", "tool_choice", "metadata", "thinking", "service_tier",
    "parallel_tool_calls",
    // Anthropic-on-Vertex has no `model` in the body — `anthropic_version`
    // carries the wire revision instead (live capture 2026-10-15). Must stay
    // identical to the lane's copy in src/incremental-lane.ts.
    "anthropic_version",
] as const;
const REQUEST_PARAM_KEY_SET = new Set<string>(REQUEST_PARAM_KEYS);

/** Keys the lane assembles from the wire's top level — hosts pass the full
 *  anthropic body as `request`, so these are by-design, not dropped. */
const LANE_OWNED_REQUEST_KEYS = new Set(["messages", "system"]);

/** #3406 item 6: params dropped here never reach the lane (its own warn
 *  cannot fire for helper-planned turns), so surface them once per
 *  conversation+key. Bounded: past the pair budget the map resets and the
 *  next epoch warns again. */
const droppedParamWarned = new Map<string, Set<string>>();
let droppedParamWarnPairs = 0;
const DROPPED_PARAM_WARN_BUDGET = 4096;

function warnDroppedRequestParams(conversationId: string, request: Record<string, unknown>): void {
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
    console.error(`[bili-incremental] ${conversationId}: request parameter(s) outside the incremental allowlist are not sent: ${unwarned.join(", ")} — extend REQUEST_PARAM_KEYS (src/agent/incremental-client.ts) if they must reach the upstream (#3406)`);
}

export interface IncrementalWireMessage {
    role: string;
    content: unknown;
}

/** #4491 host msgids: the host's stable message ids for the NEXT outgoing
 *  request of a conversation, as (id, role) pairs in session order. Stashed
 *  by the host-side extension event (it owns the sessionManager) and read
 *  back by the fetch-layer planner (it owns the actually-sent messages);
 *  the consumer aligns by count+role against the real wire set and refuses
 *  the whole field on any mismatch — a misaligned id would pin the wrong
 *  identity server-side, while a missing field merely falls back to
 *  content-derived ids. */
export interface HostMsgIdHintEntry {
    id: string;
    role: string;
}

const HOST_MSGID_HINT_TTL_MS = 30_000;
const hostMsgIdHints = new Map<string, { entries: HostMsgIdHintEntry[]; at: number }>();

/** Record the branch-entry (id, role) snapshot for a conversation's next
 *  outgoing request. Overwrites per request — one hint per conversation,
 *  always the generation of the payload being dispatched. */
export function noteHostMsgIdHint(conversationId: string, entries: HostMsgIdHintEntry[]): void {
    sweepStale(hostMsgIdHints, HOST_MSGID_HINT_TTL_MS);
    hostMsgIdHints.set(conversationId, { entries, at: Date.now() });
}

/** The stashed hint for a conversation, or undefined when none is fresh. */
export function hostMsgIdHintFor(conversationId: string): HostMsgIdHintEntry[] | undefined {
    const entry = hostMsgIdHints.get(conversationId);
    if (entry === undefined || Date.now() - entry.at >= HOST_MSGID_HINT_TTL_MS) return undefined;
    return entry.entries;
}

interface ConvState {
    /** Last server ack (x-bili-applied-seq) — flat message count. */
    sinceSeq: number;
    /** Wire hashes of everything the server has acknowledged, in order. */
    sent: string[];
    /** Sticky system (JSON) we told the lane; resend only on change. */
    systemJson: string | undefined;
    /** Per-conversation kill switch after unrecoverable failures. */
    dead: boolean;
}

const convs = new Map<string, ConvState>();

// #4491 host msgids: ids this client has already put on an envelope for the
// conversation — the client-side mirror of the lane's canonical id set. The
// lane HARD-FAILS a non-resync turn (400) whose msgIds reuse a live canonical
// id ("msgIds reuse an existing canonical id"), so a delta candidate already
// in this set degrades to "no field" instead of killing the request: the
// realistic trigger is a host retry re-planning the same delta after the
// first attempt may have landed server-side. A resync/seed replaces the set
// wholesale, exactly like the server replaces the canonical.
const msgidClaims = new Map<string, Set<string>>();

/** Local mirror of the lane's validateMsgIds reject classes
 *  (src/msgid-pin.ts — keep in sync; the host bundle must not import server
 *  modules). The lane hard-fails a turn on a poisoned id array, so the host
 *  screens candidates BEFORE they ride the envelope: anything the server
 *  would reject degrades to "no field" here (content-derived ids) instead of
 *  a 400 that kills the whole request. */
const MSGID_MAX_LEN = 512;
const MSGID_RESERVED_PREFIX = "acp_summary_";
const MSGID_BAD_CHARS = /[\s\p{C}]/u;

function screenMsgIds(ids: unknown): ids is string[] {
    if (!Array.isArray(ids) || ids.length === 0) return false;
    const seen = new Set<string>();
    for (const v of ids) {
        if (typeof v !== "string" || v.length === 0 || v.length > MSGID_MAX_LEN) return false;
        if (v.startsWith(MSGID_RESERVED_PREFIX)) return false;
        if (MSGID_BAD_CHARS.test(v)) return false;
        if (seen.has(v)) return false;
        seen.add(v);
    }
    return true;
}

/** Delta-turn claim gate: undefined when any candidate id was already sent
 *  on an earlier envelope of this conversation (the lane would 400 — see
 *  msgidClaims); otherwise the ids are claimed and returned. */
function claimableDeltaMsgIds(conversationId: string, ids: string[]): string[] | undefined {
    const claims = msgidClaims.get(conversationId);
    if (claims === undefined) {
        msgidClaims.set(conversationId, new Set(ids));
        return ids;
    }
    for (const id of ids) if (claims.has(id)) return undefined;
    for (const id of ids) claims.add(id);
    return ids;
}

const PROBE_TTL_MS = 30_000;
const probeCache = new Map<string, { ok: boolean; at: number }>();

/** Probe the lane's incremental support. Cached per proxy base for 30s; any
 * error or non-200 → not enabled (older servers 404 the GET). */
export async function probeIncrementalTurns(proxyBase: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
    const now = Date.now();
    const cached = probeCache.get(proxyBase);
    if (cached && now - cached.at < PROBE_TTL_MS) return cached.ok;
    let ok = false;
    try {
        const res = await fetchImpl(`${proxyBase}/__bili/plugin/turn`, { method: "GET", signal: AbortSignal.timeout(3000) });
        if (res.ok) {
            const body = await res.json() as { enabled?: unknown };
            ok = body.enabled === true;
        }
    } catch {
        ok = false;
    }
    probeCache.set(proxyBase, { ok, at: now });
    return ok;
}

/** Does this message list look like the Anthropic wire shape the lane's
 *  anthropicToCore can ingest? OpenAI-tool shapes (role:"tool"/"function",
 *  assistant.tool_calls, tool_call_id) are NOT convertible — the adapter
 *  falls back to a full resend for those conversations (correctness over
 *  savings). Content may be a string or a block array, both fine. */
export function wireMessagesLookAnthropic(messages: unknown): messages is IncrementalWireMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) return false;
    for (const m of messages) {
        if (m === null || typeof m !== "object") return false;
        const msg = m as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
        if (typeof msg.role !== "string" || msg.role === "tool" || msg.role === "function") return false;
        if (msg.tool_calls !== undefined || msg.tool_call_id !== undefined) return false;
        if (typeof msg.content !== "string" && !Array.isArray(msg.content)) return false;
    }
    return true;
}

function wireHash(m: IncrementalWireMessage): string {
    return createHash("sha256").update(`${m.role}\u0000${JSON.stringify(m.content)}`).digest("hex").slice(0, 16);
}

/** Public twin of the internal wire hash for boundary comparisons. The
 *  server-side hashWireBoundary (src/incremental-lane.ts) must stay
 *  byte-identical to this formula. */
export function incrementalWireHash(m: IncrementalWireMessage): string {
    return wireHash(m);
}

/** Receipt served by GET /__bili/plugin/turn?conversation=<id> — the warm
 *  canonical's appliedSeq plus the wire-hash of its last applied message.
 *  A null boundary means "cold, cannot vouch" and must never be adopted. */
interface IncrementalReceipt {
    appliedSeq: number;
    boundary: string | null;
}

/** Fresh (never cached) receipt pull for hosts whose transport hides the
 *  x-bili-applied-seq response header (#4352: pi's after_provider_response
 *  exposes headers only for some provider transports — the ack channel
 *  cannot depend on it). Any failure → null; the caller keeps its pending
 *  plan and the next turn retries. */
export async function pullIncrementalReceipt(
    proxyBase: string,
    conversationId: string,
    fetchImpl: typeof fetch = fetch,
): Promise<IncrementalReceipt | null> {
    try {
        const url = `${proxyBase.replace(/\/$/, "")}/__bili/plugin/turn?conversation=${encodeURIComponent(conversationId)}`;
        const res = await fetchImpl(url, { headers: { "x-bili-plugin": "pi" }, signal: AbortSignal.timeout(3000) });
        if (res.status !== 200) return null;
        const body = (await res.json()) as { ok?: unknown; conversation?: { appliedSeq?: unknown; boundary?: unknown } };
        if (body.ok !== true || typeof body.conversation !== "object" || body.conversation === null) return null;
        const seq = body.conversation.appliedSeq;
        const boundary = body.conversation.boundary;
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
        if (boundary !== null && typeof boundary !== "string") return null;
        return { appliedSeq: seq, boundary: boundary as string | null };
    } catch {
        return null;
    }
}

type IncrementalPlan =
    | { mode: "seed"; body: string }            // full history, sinceSeq 0 (server may 409 → resync)
    | { mode: "delta"; body: string }           // suffix only, acked sinceSeq
    | { mode: "resync"; body: string }          // full history, resync: true (recovery)
    | { mode: "skip" };                         // nothing to gain / state dead → full resend

interface PlanArgs {
    conversationId: string;
    /** Forward path of the ORIGINAL request (the marker divert uses it);
     * optional — the lane defaults a bare `path` to /v1/messages. */
    path?: string;
    messages: IncrementalWireMessage[];
    /** System from the complete host request; undefined means the host sent none. */
    system: unknown;
    /** Anthropic request params from the original body (model, max_tokens…);
     * optional — missing params ride the lane's defaults. */
    request?: Record<string, unknown>;
    /** #4491: host-stable message ids aligned 1:1 with `messages` (same
     *  length), or undefined when the host cannot vouch for every entry.
     *  Carried onto the envelope as `msgIds` parallel to the messages the
     *  mode actually sends (seed/resync: the full set; delta: the suffix),
     *  so the server pins the client's identity instead of content-derived
     *  hashes. All-or-nothing: a length mismatch, a screen failure, or an
     *  already-claimed id drops the WHOLE field — never a partial or
     *  misaligned array. */
    msgIds?: string[];
}

function buildBody(args: PlanArgs, sinceSeq: number, messages: IncrementalWireMessage[], resync: boolean, includeSystem: boolean, msgIds?: string[]): string {
    // `request` is optional at the call sites (a host may plan with only
    // messages+system); missing params simply ride their lane defaults.
    const src = args.request ?? {};
    const request: Record<string, unknown> = {};
    for (const key of REQUEST_PARAM_KEYS) if (key in src) request[key] = src[key];
    warnDroppedRequestParams(args.conversationId, src);
    const body: Record<string, unknown> = {
        conversationId: args.conversationId,
        sinceSeq,
        path: args.path ?? "/v1/messages",
        request,
        messages,
    };
    if (resync) body.resync = true;
    if (includeSystem) body.system = args.system === undefined ? null : args.system;
    // #4491: only a provably-parallel, non-empty array rides the envelope —
    // an empty delta (pure sticky-system update) pins nothing and stays off.
    if (msgIds !== undefined && msgIds.length === messages.length && msgIds.length > 0) body.msgIds = msgIds;
    return JSON.stringify(body);
}

/** Plan the incremental form of one outgoing model request. `forceResync`
 * replans after a 409 (seed hit a live canonical, or an edit diverged). */
export function planIncrementalTurn(args: PlanArgs, forceResync = false): IncrementalPlan {
    const state = convs.get(args.conversationId);
    if ((state !== undefined && state.dead) || args.messages.length === 0) return { mode: "skip" };
    // #4491: vouched ids must be exactly parallel to the outgoing set and
    // pass the local screen; anything else means "no field" this turn.
    const fullIds = args.msgIds !== undefined && args.msgIds.length === args.messages.length && screenMsgIds(args.msgIds) ? args.msgIds : undefined;
    const systemJson = args.system === undefined ? undefined : JSON.stringify(args.system);
    if (state === undefined || forceResync) {
        const includeSystem = state === undefined || systemJson !== state.systemJson;
        // First attempt (and every forced replan) sends the FULL set with
        // resync:true — a wholesale canonical replacement never 409s, so the
        // first incremental turn works whether the server-side history is
        // empty (fresh conversation) or already live (interop with
        // full-resend traffic: the client's view is authoritative and
        // identical-or-newer). Only DELTA turns can 409.
        if (fullIds !== undefined) msgidClaims.set(args.conversationId, new Set(fullIds));
        return { mode: forceResync ? "resync" : "seed", body: buildBody(args, 0, args.messages, true, includeSystem, fullIds) };
    }
    const hashes = args.messages.map(wireHash);
    // Prefix alignment: everything previously acked must still lead the list.
    const n = Math.min(state.sent.length, hashes.length);
    let aligned = true;
    for (let i = 0; i < n; i++) {
        if (state.sent[i] !== hashes[i]) { aligned = false; break; }
    }
    if (!aligned || hashes.length < state.sent.length) {
        if (fullIds !== undefined) msgidClaims.set(args.conversationId, new Set(fullIds));
        return { mode: "resync", body: buildBody(args, 0, args.messages, true, systemJson !== state.systemJson, fullIds) };
    }
    if (hashes.length === state.sent.length) {
        // Equal message set: normally a retry of the same turn → normal path.
        // But a SYSTEM change is still a real outgoing turn — send an empty
        // delta so the lane forwards the assembled request with the new
        // sticky system (the canonical itself is unchanged).
        if (systemJson !== state.systemJson) {
            return { mode: "delta", body: buildBody(args, state.sinceSeq, [], false, true) };
        }
        return { mode: "skip" }; // retry of the same turn → normal path
    }
    const deltaIds = fullIds !== undefined ? claimableDeltaMsgIds(args.conversationId, fullIds.slice(state.sent.length)) : undefined;
    return {
        mode: "delta",
        body: buildBody(args, state.sinceSeq, args.messages.slice(state.sent.length), false, systemJson !== state.systemJson, deltaIds),
    };
}

/** Record a 200 ack: `appliedSeq` is the response's x-bili-applied-seq and
 * `messages` the wire set the server just acknowledged. An ack clears the
 * rejection circuit — the conversation is healthy again. */
export function noteIncrementalAck(conversationId: string, appliedSeq: number, messages: IncrementalWireMessage[], system: unknown): void {
    rejectionCircuit.delete(conversationId);
    convs.set(conversationId, {
        sinceSeq: appliedSeq,
        sent: messages.map(wireHash),
        systemJson: system === undefined ? undefined : JSON.stringify(system),
        dead: false,
    });
}

/** Consecutive 409s (no intervening ack) that trip the sticky kill switch.
 * A SINGLE 409 just resets the conversation state — the next turn re-seeds
 * with a full resync:true body, which cannot 409 — so transient drift (sidecar
 * degraded at boot, one upstream 5xx between apply and forward, a sibling host
 * re-seeding) self-heals on the very next turn instead of permanently
 * downgrading the conversation (#3369). */
const REJECTION_CIRCUIT = 3;

/** Consecutive rejections per conversation, OUTSIDE `convs` — a reset deletes
 * the wire state, but the circuit counter must survive it. */
const rejectionCircuit = new Map<string, number>();

/** Record a lane rejection (409 seq drift). Returns "reset" when the next
 * turn re-seeds (transient drift — the common case) and "dead" when the
 * sticky kill switch tripped (persistent drift: full resend for the rest of
 * the process lifetime, exactly the pre-#3369 behavior). */
export function noteIncrementalRejection(conversationId: string): "reset" | "dead" {
    const strikes = (rejectionCircuit.get(conversationId) ?? 0) + 1;
    if (strikes >= REJECTION_CIRCUIT) {
        rejectionCircuit.delete(conversationId);
        convs.set(conversationId, { sinceSeq: 0, sent: [], systemJson: undefined, dead: true });
        return "dead";
    }
    rejectionCircuit.set(conversationId, strikes);
    convs.delete(conversationId); // next turn re-seeds: full set, resync:true, sinceSeq 0
    return "reset";
}

/** Sticky per-conversation fallback after an unrecoverable lane failure —
 * the conversation keeps working via plain full resend. */
export function markIncrementalDead(conversationId: string): void {
    const state = convs.get(conversationId);
    if (state) state.dead = true;
}

/** Drop the cached probe for one proxy base (e.g. after a 503 — the lane's
 * rollout flag or sidecar liveness changed). The next turn re-probes. */
export function clearIncrementalProbe(proxyBase: string): void {
    probeCache.delete(proxyBase);
}

export function __resetIncrementalClientForTests(): void {
    convs.clear();
    probeCache.clear();
    rejectionCircuit.clear();
    droppedParamWarned.clear();
    droppedParamWarnPairs = 0;
    originalBodies.clear();
    hostMsgIdHints.clear();
    msgidClaims.clear();
}
