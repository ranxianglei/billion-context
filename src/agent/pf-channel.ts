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

const COUNT_HEADER = "x-bili-pf-count";
const TAIL_IDS_HEADER = "x-bili-pf-tail-ids";
const CONVERSATION_HEADER = "x-bili-plugin-conversation";
const SEQ_HEADER = "x-bili-pf-seq";

const MAX_ID_LEN = 512;
const RESERVED_PREFIX = "acp_summary_";
// #4491/#4834 identity screening — same rules as msgid-pin validateMsgIds and
// the incremental-lane adapters; keep them in sync (a bad id degrades the WHOLE
// list to absent, never a partial list onto the wire).
const BAD_ID_CHARS = /[\s\p{C}]/u;
const MAX_IDS = 2048; // long-conversation ceiling; the sliced head stays small
const MAX_TRACKED = 1024; // sid table cap (same hygiene as the old per-lane maps)

type Tracked = { t?: number; ids?: string[] };

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
    const raw = respHeaders.get(SEQ_HEADER);
    if (raw === null || !/^\d+$/.test(raw)) return;
    const t = Number(raw);
    if (!Number.isSafeInteger(t)) return;
    takeSlot(sid).t = t;
}

/** Thin capture adapter contract (called ONCE PER outbound model request,
 *  before the send, by whatever event gives that client access to its
 *  message list — dsh llm/stream scope, pi/omp before_provider_request,
 *  opencode messages.transform): store the ALL-OR-NOTHING id list for THIS
 *  turn's wire elements. A FAILED resolution (null/undefined/malformed)
 *  CLEARS the stored list for the session: a stale list from an earlier turn
 *  sliced at today's K could slip past the anchor check and surface as a
 *  length fault — honest absence (count-only) is always preferred.
 *  Any failed screen drops the WHOLE list: never partial onto the wire. */
export function pfCaptureIds(sid: string, ids: unknown): void {
    if (sid.length === 0) return;
    const slot = takeSlot(sid);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS) {
        delete slot.ids;
        return;
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of ids) {
        if (typeof v !== "string" || v.length === 0 || v.length > MAX_ID_LEN) {
            delete slot.ids;
            return;
        }
        if (v.startsWith(RESERVED_PREFIX)) {
            delete slot.ids;
            return;
        }
        if (BAD_ID_CHARS.test(v)) {
            delete slot.ids;
            return;
        }
        if (seen.has(v)) {
            delete slot.ids;
            return;
        }
        seen.add(v);
        out.push(v);
    }
    slot.ids = out;
}

/** Chokepoint emit (native-intercept routed-send site): the handshake headers
 *  this request should carry, given its outgoing header record (source of the
 *  conversation id). {} whenever the session never saw a stamp yet. */
export function pfRequestHeaders(incoming: Record<string, string>): Record<string, string> {
    const sid = incoming[CONVERSATION_HEADER];
    if (sid === undefined || sid.length === 0) return {};
    const slot = tracked.get(sid);
    if (slot === undefined || slot.t === undefined) return {};
    const k = slot.t;
    if (k < 1) return {};
    const out: Record<string, string> = { [COUNT_HEADER]: String(k) };
    const ids = slot.ids;
    if (ids !== undefined && ids.length >= k) {
        out[TAIL_IDS_HEADER] = ids.slice(k - 1).map(encodeURIComponent).join(",");
    }
    return out;
}
