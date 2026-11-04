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
// Wire form (v6, #5643): x-bili-pf-tail-ids = percent-encoded FULL element
// id list — one entry per body element, body order, LITERAL commas between
// segments (commas INSIDE ids travel %2C — unambiguous). The server
// reconciles it against its structural scan (|R| == T, all real ids) and
// judges NEW by set difference alone. x-bili-pf-count still carries the
// LAST-STAMPED total from earlier responses (v5 lanes read it; v6 ignores
// it). x-bili-pf-session echoes the server-minted world id once learned.
// A captured list that resolves NO ids degrades to absent: better nothing
// than a partial list onto the wire.
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
// #5643: the v6 world echo header the server mints (pf_<hex12>).
const PF_SESSION_HEADER = "x-bili-pf-session";
const PF_SID_RE = /^pf_[0-9a-f]{12}$/u;
export const PF_SLOT_UNKNOWN = "?";

const MAX_ID_LEN = 512;
const RESERVED_PREFIX = "acp_summary_";
// #4491/#4834 identity screening — same rules as msgid-pin validateMsgIds and
// the incremental-lane adapters; keep them in sync (a bad id degrades the WHOLE
// list to absent, never a partial list onto the wire).
const BAD_ID_CHARS = /[\s\p{C}]/u;
// #5643: v6 sends the FULL list — long-hostory ceilings apply to whole bodies
// now, not just the tail window. 16k elements (~8 MB worst-case id payload,
// typically far less) covers the multi-MiB #5403 conversations in full.
const MAX_IDS = 16_384;
const MAX_TRACKED = 1024; // sid table cap (same hygiene as the old per-lane maps)

type Tracked = { t?: number; ids?: string[]; /** #5643: minted pf_sid echoed back by a v6-enabled server. */ v6?: string };

const tracked = new Map<string, Tracked>();

function takeSlot(sid: string): Tracked {
    let slot = tracked.get(sid);
    if (slot === undefined) {
        if (tracked.size >= MAX_TRACKED) tracked.clear();
        slot = {};
        tracked.set(sid, slot);
    }
    return slot;
}

/** Central learn point (native-intercept success sites): record THIS
 *  request's measured element total T against its conversation id. Non-2xx
 *  responses and malformed stamps are ignored — a broken echo costs nothing
 *  (the server restamps every evaluated response). */
export function pfLearnStamp(headersIn: Record<string, string>, respStatus: number, respHeaders: Headers | null | undefined): void {
    if (respStatus !== 200) return;
    const sid = headersIn[CONVERSATION_HEADER];
    if (sid === undefined || sid.length === 0 || respHeaders === null || respHeaders === undefined) return;
    const slot = takeSlot(sid);
    const raw = respHeaders.get(SEQ_HEADER);
    if (raw !== null && /^\d+$/.test(raw)) {
        const t = Number(raw);
        if (Number.isSafeInteger(t)) slot.t = t;
    }
    // #5643: remember the minted world id once the server hands one over;
    // every later request echoes it (matching rule ①, O(1) + spot-checked).
    const rawSid = respHeaders.get(PF_SESSION_HEADER);
    if (rawSid !== null && PF_SID_RE.test(rawSid)) slot.v6 = rawSid;
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
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS) {
        delete slot.ids;
        return;
    }
    const seen = new Set<string>();
    let known = 0;
    const out: string[] = [];
    for (const v of ids) {
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
}

/** Chokepoint emit (native-intercept routed-send site): the handshake headers
 *  this request should carry, given its outgoing header record (source of the
 *  conversation id). {} whenever nothing pf-related is known for this sid.
 *
 *  #5643 wire form: the FULL captured id list rides on every request (one
 *  segment per body element, body order) — the server reconciles it against
 *  its scan and judges purely by set difference, so no window math happens
 *  here anymore. The count claim keeps its old meaning (last-stamped total,
 *  emitted only once known) for v5 lanes and for count-only clients; v6
 *  servers ignore it. Cold start: turn ONE carries the full list WITHOUT a
 *  count — v6 uses that very turn as its legal arm entrance (register pos
 *  0..T-1) while v5-only servers fall through to the legacy full-parse path
 *  (they require the count to engage at all). */
export function pfRequestHeaders(incoming: Record<string, string>): Record<string, string> {
    const sid = incoming[CONVERSATION_HEADER];
    if (sid === undefined || sid.length === 0) return {};
    const slot = tracked.get(sid);
    if (slot === undefined) return {};
    const out: Record<string, string> = {};
    if (slot.t !== undefined && slot.t >= 1) out[COUNT_HEADER] = String(slot.t);
    const ids = slot.ids;
    if (ids !== undefined && ids.length >= 1) out[TAIL_IDS_HEADER] = ids.map(encodeURIComponent).join(",");
    if (slot.v6 !== undefined) out[PF_SESSION_HEADER] = slot.v6;
    return out;
}
