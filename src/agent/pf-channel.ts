// #5403/#5418 full-resend watermark channel — the ONE client-side state machine.
//
// Owner decision 2026-11-02: the watermark handshake was wired per-lane
// (dsh headersFor / pi before_provider_headers+after_provider_response /
// opencode chat.headers+onResponse), and per-lane msgid lists had FOUR separate
// captures (dsh hostMsgIdsOf, pi laneMsgIdsForWire, opencode harvest/align,
// omp ompTurnMsgIds). All native lanes funnel their model requests through the
// ONE globalThis.fetch patch (native-intercept.ts), so this module holds the
// shared state and the chokepoint emits; lanes may differ ONLY in WHERE their
// ids get captured (each host exposes its message list at a different event):
//   - learnStamp:  one central read of x-bili-pf-seq in native-intercept
//                  (every routed success site),
//   - capture:     a thin adapter per client calling pfCaptureIds(sid, ids),
//   - emit:        one pfRequestHeaders() merge in native-intercept at the
//                  routed-send site (count + tail-ids alike).
//
// Wire form: x-bili-pf-count = last-seen total T (pure count mode);
// x-bili-pf-tail-ids = percent-encoded "[id(K-1)] + new element ids" joined
// with LITERAL commas (commas INSIDE ids travel %2C — unambiguous). A captured
// list missing or shorter than K degrades to count-only: never partial.
//
// Owner ruling 2026-11-02 (m02989): hosts compress and REWRITE their histories,
// so all-or-nothing alignment proofs against the wire fight reality and kill
// the channel (a single compacted summary entry used to poison every later
// turn). The identity ladder does not need the proofs: msgids are unique
// forever (kernel contract), ORDER binds them to positions inside the
// verified delta window, and the byte-level head check remains the boundary
// truth. Capture therefore screens SLOTS, not the list as a whole — an
// id-bearing element travels with its id, an id-less one (native-compaction
// summaries, personas) rides the UNIDENTIFIED placeholder below; nothing is
// ever dropped from or re-ordered inside the captured span.
const COUNT_HEADER = "x-bili-pf-count";
const TAIL_IDS_HEADER = "x-bili-pf-tail-ids";
const CONVERSATION_HEADER = "x-bili-plugin-conversation";
const SEQ_HEADER = "x-bili-pf-seq";
// #7064 §8: the pin-mode signal (server stamps it WITH the pf-seq header;
// the literal duplicates src/msgid-pin.ts MSGID_MODE_HEADER — the agent
// bundles are import-free leaves, same rule as PF_SLOT_UNKNOWN).
const MSGID_MODE_HEADER = "x-bili-msgid-mode";
export const PF_SLOT_UNKNOWN = "?";

const MAX_ID_LEN = 512;
const RESERVED_PREFIX = "acp_summary_";
// #4491/#4834 identity screening — same rules as msgid-pin validateMsgIds and
// the incremental-lane adapters; keep them in sync (a bad id degrades the WHOLE
// list to absent, never a partial list onto the wire).
const BAD_ID_CHARS = /[\s\p{C}]/u;
const MAX_IDS = 2048; // long-conversation ceiling; a longer captured list keeps
                // ONLY its last MAX_IDS entries (baseOffset below) — the
                // steady-state tail slice lives in that window, so ultra-long
                // sessions still send tail-only instead of the full body
const MAX_TRACKED = 1024; // sid table cap — at capacity exactly ONE oldest session is evicted (#6044)
// #6785 review fix (2026-11-19): byte budget for the tail-ids HEADER value.
// Node's default maxHeaderSize covers the WHOLE header block (16 KB), and
// post-§8 this header is the sole id carrier on the openai lane — an
// oversized value (hundreds of new cores in one turn) would 431 the entire
// model request. Over budget ⇒ the tail is not emitted and the full form is
// NOT suppressed either (the pre-§8 body send pins fine; one turn of extra
// bytes beats a dead request).
const TAIL_MAX_BYTES = 8 * 1024;

type Tracked = {
    t?: number;
    ids?: string[];
    /** #6785 review fix (2026-11-19, owner): when the captured list exceeded
     *  MAX_IDS, ids holds only its LAST MAX_IDS entries — baseOffset is where
     *  that window starts in FULL-list coordinates (undefined ⇒ full list
     *  kept). A requested slice reaching below the window degrades to
     *  count-only + full body (the full form pins fine) — never a pin-less
     *  loop. */
    baseOffset?: number;
    /** #7064 §8: what the server told us we may send next turn (learned
     *  from x-bili-msgid-mode; cleared on any >=4xx response — the server
     *  re-converges one turn later). "incremental" ⇒ steady-state turns
     *  suppress the full msgid list and ride only the tail-ids header. */
    mode?: "incremental" | "full";
    /** #7064 §8 phase 2 (non-watermark lanes): this session's LAST FULL id
     *  list as captured this turn — the tail form is derived from it
     *  client-side (pfIdTailForm) because these lanes get no x-bili-pf-seq
     *  (the watermark plane is openai-lane only). Cleared alongside mode. */
    prevIds?: string[];
};

const tracked = new Map<string, Tracked>();

function takeSlot(sid: string): Tracked {
    let slot = tracked.get(sid);
    if (slot === undefined) {
        if (tracked.size >= MAX_TRACKED) {
            const oldest = tracked.keys().next().value;
            if (oldest !== undefined) tracked.delete(oldest);
        }
        slot = {};
    } else {
        tracked.delete(sid);
    }
    tracked.set(sid, slot);
    return slot;
}

/** Central learn point (native-intercept success sites): record THIS
 *  request's measured element total T against its conversation id. Non-2xx
 *  responses and malformed stamps are ignored — a broken echo costs nothing
 *  (the server restamps every evaluated response). #7064 §8 also learns the
 *  pin mode here: a >=4xx clears it immediately (mismatch ⇒ the server told
 *  us to go full anyway; the next 2xx restamps it). */
export function pfLearnStamp(headersIn: Record<string, string>, respStatus: number, respHeaders: Headers | null | undefined): void {
    const sid = headersIn[CONVERSATION_HEADER];
    if (respStatus >= 400) {
        if (sid !== undefined && sid.length > 0) {
            const slot = tracked.get(sid);
            if (slot !== undefined) {
                if (slot.mode !== undefined) slot.mode = undefined;
                if (slot.prevIds !== undefined) slot.prevIds = undefined;
            }
        }
        return;
    }
    if (respStatus !== 200 || sid === undefined || sid.length === 0 || respHeaders === null || respHeaders === undefined) return;
    const modeRaw = respHeaders.get(MSGID_MODE_HEADER);
    if (modeRaw === "incremental" || modeRaw === "full") {
        takeSlot(sid).mode = modeRaw;
    }
    const raw = respHeaders.get(SEQ_HEADER);
    if (raw === null || !/^\d+$/.test(raw)) return;
    const t = Number(raw);
    if (!Number.isSafeInteger(t)) return;
    takeSlot(sid).t = t;
}

/** Thin capture adapter contract (called ONCE PER outbound model request,
 *  before the send, by whatever event gives that client access to its
 *  message list — dsh llm/stream scope, pi/omp before_provider_request,
 *  opencode messages.transform): store the per-slot id sequence for THIS
 *  turn's wire elements, position-indexed exactly as the host gave it.
 *
 *  Per-slot discipline (owner 2026-11-02): format-invalid entries become the
 *  UNIDENTIFIED placeholder — they NEVER poison neighbouring slots anymore.
 *  A whole failed resolution (null/undefined/non-array) still clears the
 *  stored list: honest absence beats a stale, mis-positioned one. */
export function pfCaptureIds(sid: string, ids: unknown): void {
    if (sid.length === 0) return;
    const slot = takeSlot(sid);
    if (!Array.isArray(ids) || ids.length === 0) {
        delete slot.ids;
        delete slot.baseOffset;
        return;
    }
    // #6785 review fix (owner): over the ceiling, keep the TAIL, not nothing —
    // the steady-state slice (t-1, t ≈ previous total) sits one core short of
    // the list end and is always inside this window; only a slice reaching
    // below it (stale/small stamp after a big growth) degrades to full body.
    let span: unknown[] = ids;
    let baseOffset: number | undefined;
    if (ids.length > MAX_IDS) {
        span = ids.slice(ids.length - MAX_IDS);
        baseOffset = ids.length - MAX_IDS;
    }
    const seen = new Set<string>();
    let known = 0;
    const out: string[] = [];
    for (const v of span) {
        if (
            typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN ||
            v.startsWith(RESERVED_PREFIX) || BAD_ID_CHARS.test(v) || seen.has(v)
        ) {
            out.push(PF_SLOT_UNKNOWN); // id-less slot (summary/persona/foreign shape) — travel as unknown
            continue;
        }
        seen.add(v);
        known++;
        out.push(v);
    }
    // Nothing identifiable in the whole span ⇒ count-only beats noise.
    slot.ids = known > 0 ? out : undefined;
    if (baseOffset !== undefined) slot.baseOffset = baseOffset;
    else delete slot.baseOffset;
}

/** Chokepoint emit (native-intercept routed-send site): the handshake headers
 *  this request should carry, given its outgoing header record (source of the
 *  conversation id). {} whenever the session never saw a stamp yet. */
export function pfRequestHeaders(incoming: Record<string, string>): Record<string, string> {
    const sid = incoming[CONVERSATION_HEADER];
    if (sid === undefined || sid.length === 0) return {};
    const slot = tracked.get(sid);
    if (slot === undefined) return {};
    tracked.delete(sid);
    tracked.set(sid, slot);
    if (slot.t === undefined) return {};
    const k = slot.t;
    if (k < 1) return {};
    const out: Record<string, string> = { [COUNT_HEADER]: String(k) };
    const tail = tailPayloadFor(slot);
    if (tail !== undefined) out[TAIL_IDS_HEADER] = tail;
    return out;
}

/** #6785 review fix: the encoded tail-ids payload this turn, or undefined
 *  when the carrier must stay off: not enough captured ids, a slice reaching
 *  BELOW the kept tail window (a >2048 capture whose stamp predates the
 *  window — the full form rides instead), or the joined value exceeding
 *  TAIL_MAX_BYTES. The SAME verdict feeds the header emit
 *  (pfRequestHeaders) and the full-form suppression (pfSuppressFullMsgIds):
 *  suppressing the body while the header carrier is absent strands the
 *  session pin-less FOREVER — the server sees neither form, sends no mode
 *  signal, and the client keeps suppressing. */
function tailPayloadFor(slot: Tracked): string | undefined {
    const t = slot.t;
    const ids = slot.ids;
    if (t === undefined || t < 1 || ids === undefined) return undefined;
    const base = slot.baseOffset ?? 0;
    if (t - 1 < base) return undefined; // slice reaches below the kept window
    if (ids.length < t - base) return undefined;
    const payload = ids.slice(t - 1 - base).map(encodeURIComponent).join(",");
    return payload.length <= TAIL_MAX_BYTES ? payload : undefined;
}

/** #7064 §8: whether the full msgid list may be SUPPRESSED on THIS outbound
 *  request (steady-state incremental — the ledger pins the prefix; only the
 *  bounded tail-ids header above carries the new ids). Full form stays
 *  authoritative at bootstrap (nothing learned) and at reanchor: a wire
 *  SHORTER than the last measured T means the host compacted/truncated —
 *  the learned mode is stale and this turn MUST send the full list (the
 *  server re-anchors and restamps the mode one round-trip later).
 *  wireCount = the id list this turn would have carried. */
export function pfSuppressFullMsgIds(sid: string, wireCount: number): boolean {
    if (sid.length === 0) return false;
    const slot = tracked.get(sid);
    if (slot === undefined || slot.mode !== "incremental" || slot.t === undefined) return false;
    if (wireCount < slot.t) {
        slot.mode = undefined; // shrink ⇒ reanchor next turn — never suppress on the shrinking turn
        return false;
    }
    // #6785 review fix: suppression is coupled to the CARRIER actually going
    // out this turn (see tailPayloadFor). When the carrier cannot go out
    // (stale stamp below the kept tail window, or over-byte-budget tail),
    // the full form rides instead: the pre-§8 behavior, which pins fine,
    // rather than a pin-less loop.
    return tailPayloadFor(slot) !== undefined;
}

/** #7064 §8 phase 2 (owner ruling 2026-11-18): the TAIL form for lanes
 *  WITHOUT a watermark plane (anthropic / responses egress — their servers
 *  never stamp x-bili-pf-seq, so pfRequestHeaders can't run): derive the
 *  bounded "anchor + new cores" list from this turn's FULL list and this
 *  session's previous full list. Returns undefined ⇒ send the full list.
 *
 *  Rules (one-round convergence, same contract as the server's
 *  tryIncrementalPin):
 *   - mode !== "incremental"            → full (nothing learned yet),
 *   - no previous full list             → full (bootstrap), store this one,
 *   - list SHORTER than the previous    → full (host compacted/rewrote —
 *     reanchor), store this one,
 *   - prefix MISMATCH vs the previous   → full (history rewrite — reanchor),
 *     store this one,
 *   - otherwise                         → [previous.last, ...new cores];
 *     store this turn's list.
 *  The server re-proves anchor + width + entries and signals "full" back
 *  when anything drifted — a wrong tail costs one degraded turn, never a
 *  mis-pin. fullIds = this turn's whole core-aligned id list (the very
 *  list that would have been stamped full). */
export function pfIdTailForm(sid: string, fullIds: string[] | undefined): string[] | undefined {
    if (sid.length === 0 || fullIds === undefined || fullIds.length === 0) return undefined;
    const slot = tracked.get(sid);
    if (slot === undefined || slot.mode !== "incremental") return undefined;
    const prev = slot.prevIds;
    if (prev === undefined) {
        slot.prevIds = [...fullIds]; // bootstrap: this turn establishes the baseline
        return undefined;
    }
    if (fullIds.length < prev.length) {
        slot.prevIds = [...fullIds]; // shrink ⇒ full reanchor next round trip
        return undefined;
    }
    for (let i = 0; i < prev.length; i++) {
        if (fullIds[i] !== prev[i]) {
            slot.prevIds = [...fullIds]; // rewrite ⇒ full reanchor next round trip
            return undefined;
        }
    }
    slot.prevIds = [...fullIds];
    return [prev[prev.length - 1], ...fullIds.slice(prev.length)];
}
