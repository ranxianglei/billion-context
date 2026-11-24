/**
 * Egress op-log recording — segment 3 of the op-log outbound view (proposal
 * discussions/7398, revised self-contained-bytes design discussions/7439
 * ruling 1, #6785 perf work). Each turn diffs the outbound conversation view
 * against the previous turn's and appends the sparse op batch to the dual
 * tables. Outbound bytes are served from the log only behind the serve key
 * (segment 4b). Gated by rollout key `egressPlane` (default 0 = no recording
 * at all).
 *
 * SELF-CONTAINED BYTES (ruling 7439-1): each view row carries the message's
 * FINAL core JSON string directly (the system row carries the system text).
 * No hash references, no fingerprint fields, no content table — the content
 * identity of a row is the byte string itself (the diff keys on msgid and
 * compares bytes directly), so the op-log replays and serves with nothing
 * but the two egress tables.
 *
 * Identity contract (KDD#11/KDD#17): a view row's msgid is the message's
 * kernel-space id — host msgid in pinned 2×2 lanes (the pin restamps ids
 * position-for-position), content-hash mint otherwise (kernel mints are
 * never re-issued). Ephemeral rows (nudge, sysNotes) are EXCLUDED: they are
 * by-design transient (KDD#7 prefix-cache-anchor) and would churn +I/-D
 * every nudge cycle with no serving value; the leading system block IS a
 * row under the constant msgid "egress-system" (its byte stability is what
 * the cache anchor relies on, and a system change shows up as a +U on that
 * row — content identity is bytes, position/identity is the msgid).
 */

import { diffEgressView, EgressStateCorruptError, type EgressOp, type EgressViewRow } from "./egress-state.js";
import { log as loggerLog } from "../logger.js";

/** #6785 ruling 7439-5: a pinned (server-authoritative) session whose op-log
 * has NO healthy point must FAIL the turn — never run on client bytes, never
 * degrade to legacy. Thrown by the egress-authority seam and rethrown into
 * the server funnel by the lane catch (like FoundationRejectError) so the
 * generic "kernel transform failed, forwarding unchanged" path — which
 * would forward the client's own bytes — can never swallow it. */
export class EgressAuthorityRejectError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EgressAuthorityRejectError";
    }
}

/** Constant msgid of the system block row (no hash — identity is the
 * role, not the content; a system change is a +U carrying the new bytes). */
export const EGRESS_SYSTEM_MSGID = "egress-system";

/** Minimal structural shape — accepts both BiliMessage (wire sidecar) and
 * bare kernel CoreMessage (the degraded-path originalMessages). Exported:
 * prepare-openai names the source array it hands to recordEgressTurn. */
export interface EgressSourceMsg {
    id: string;
    role: string;
    contentType?: unknown;
    text?: unknown;
}

/** Build this turn's view rows: [system?] + one row per conversation
 * message. Deterministic over (ids, roles, texts): same inputs → same rows
 * (byte-equal), which is what makes the next diff sparse. `tokens` is a
 * chars/4 estimate (it only needs to be stable while the content is
 * unchanged); `bytes` is the FINAL core JSON of the message — the same
 * bytes the serve path rebuilds from. `num` is left 0 (unnumbered): the
 * canonical number is assigned when the row's I op is appended/replayed
 * (ruling 7439) — an in-process row never carries a real number. */
export function buildEgressViewRows(
    conversation: readonly EgressSourceMsg[],
    systemText: string | undefined,
): EgressViewRow[] {
    const rows: EgressViewRow[] = [];
    if (systemText !== undefined && systemText.length > 0) {
        rows.push({
            num: 0,
            msgid: EGRESS_SYSTEM_MSGID,
            ref: "",
            tokens: Math.max(1, Math.ceil(systemText.length / 4)),
            type: "system",
            role: "system",
            bytes: systemText,
        });
    }
    for (const m of conversation) {
        const text = typeof m.text === "string" ? m.text : "";
        rows.push({
            num: 0,
            msgid: m.id,
            ref: /^m\d{4,}$/.test(m.id) ? m.id : "",
            tokens: Math.max(1, Math.ceil(text.length / 4)),
            type: m.id.startsWith("acp_summary") ? "acp_summary" : m.role === "tool" ? "tool" : "text",
            role: m.role,
            bytes: JSON.stringify(m),
        });
    }
    return rows;
}

/** The storage seam (UnifiedStore today; keeps the recorder testable). */
export interface EgressOpLogStore {
    /** Record one turn: guarded, validated, appended, compacted — in ONE
     *  transaction (see egressAppendTurn). Throws EgressConcurrentWriteError
     *  when the log moved past `baseSeq` (nothing written) and
     *  EgressStateCorruptError when the log or the batch does not replay.
     *  Returns the stamped view the tables now hold. */
    egressAppendTurn(sessionId: string, ops: EgressOp[], baseSeq: number, nowMs: number): EgressViewRow[];
    egressStateView(sessionId: string): EgressViewRow[];
    /** Rollback reconstruction at any op_seq at or above the newest base. */
    egressStateViewAt(sessionId: string, opSeq: number): EgressViewRow[];
    /** Highest op_seq in the flow (0 = no rows). */
    egressStateMaxSeq(sessionId: string): number;
    /** op_seq of the newest base row (0 = none). Optional: a store without
     *  it limits the recovery walk to the fixed distance below. */
    egressStateBaseSeq?(sessionId: string): number;
    /** Recovery (ruling 7439-5): delete rows past `opSeq` in BOTH tables —
     *  rows beyond a corrupt point are unusable by definition (no replay can
     *  ever include them), so recovery = flow back to the last healthy point.
     *  Append-only covers HEALTHY history only. Returns rows removed. */
    egressStateTruncateAfter(sessionId: string, opSeq: number): number;
}

/** Record this turn's outbound conversation view as sparse ops. `prev` is
 * this turn's starting point — the previous turn's view when present,
 * otherwise a one-shot hydrate from the tables (owner ruling 7439-3: the
 * tables are the only state; there is no long-lived in-memory view cache).
 * The append, the compaction it may trigger (a batch with a -D — the fold
 * shape; cancellation is the trigger, per the proposal) and the guard
 * against a log that moved since `baseSeq` was read are ONE transaction
 * (egressAppendTurn). Any EgressStateCorruptError / EgressConcurrentWriteError
 * propagates — the caller handles it per the degrade ladder (no fuzzy
 * fallback, KDD discipline).
 *
 * Returns the STAMPED view — the replay of the log as the tables now hold
 * it, whose rows carry the canonical numbers (I rows: the number their
 * append assigned; spine rows: inherited). The client-built `next` (num 0
 * everywhere) is diff input only; nothing unnumbered ever leaves this
 * function. `baseSeq` belongs with a caller-supplied `prev` (the op_seq that
 * view was read at); without it the guard is off (single-writer callers). */
export function recordEgressTurn(args: {
    store: EgressOpLogStore;
    sessionId: string;
    prev: EgressViewRow[] | undefined;
    /** op_seq `prev` was read at (enables the moved-log guard). */
    baseSeq?: number;
    conversation: readonly EgressSourceMsg[];
    systemText: string | undefined;
    nowMs: number;
}): EgressViewRow[] {
    const { store, sessionId, conversation, systemText, nowMs } = args;
    let prev = args.prev;
    let baseSeq = args.baseSeq;
    if (prev === undefined) {
        // Cursor first, view second: a writer landing in between makes the
        // guard refuse this turn instead of stacking ops on a moved log.
        baseSeq = store.egressStateMaxSeq(sessionId);
        prev = store.egressStateView(sessionId);
    }
    const next = buildEgressViewRows(conversation, systemText);
    const ops = diffEgressView(prev, next);
    if (ops.length === 0) return prev;
    return store.egressAppendTurn(sessionId, ops, baseSeq ?? store.egressStateMaxSeq(sessionId), nowMs);
}


/** Bounded walk-back distance when the flow's current point is corrupt. */
const EGRESS_HEALTHY_WALK_MAX = 16;

/** Ruling 7439-5 degrade ladder — hydrate the flow's CURRENT point; when it
 * fails replay (a corrupt row), walk back to the NEWEST healthy op_seq
 * (bounded walk) and TRUNCATE past it: rows beyond a corrupt point are
 * unusable by definition (no replay can ever include them), so recovery
 * means flowing back to the last healthy point in the tables themselves —
 * never to the client's bytes. Returns null = no healthy NON-EMPTY point:
 * a session that HAS rows but none that replay is whole-flow-unreadable,
 * and the caller hard-fails the turn instead of falling back to client
 * bytes (ruling 7439-5). The only legitimate empty flow is a ROW-LESS
 * session, which the try path above returns as seq 0 / degraded=false
 * (the turn-1 bootstrap). An empty replay at a lower op_seq while rows
 * exist is corruption reaching the floor, not a live empty session — an
 * empty base row is never written (recordEgressTurn no-ops an empty diff
 * and compaction only runs on non-empty views). The truncated count is
 * observability for the warn log. */
export function recoverEgressBase(
    store: EgressOpLogStore,
    sessionId: string,
    options: { walk?: boolean } = {},
): { view: EgressViewRow[]; seq: number; degraded: boolean; truncated: number } | null {
    const maxSeq = store.egressStateMaxSeq(sessionId);
    let damage: string;
    try {
        const view = store.egressStateView(sessionId);
        return { view, seq: maxSeq, degraded: false, truncated: 0 };
    } catch (err) {
        // #7574: only a log that does not replay is corruption. Any other
        // failure (busy, locked, I/O) is rethrown and the rows stay as they
        // are — this ladder's next step DELETES rows, so it must never run
        // on a guess. It used to start on every error.
        if (!(err instanceof EgressStateCorruptError)) throw err;
        damage = err.reason;
    }
    // #7574: a session whose log is only a mirror (no authority) never
    // loses rows over it — no walk-back, no truncation. The turn is served
    // unrecorded until an operator resets the log (POST /__bili/egress/reset).
    if (options.walk === false) return null;
    // Walk back to the NEWEST healthy op_seq: at most EGRESS_HEALTHY_WALK_MAX
    // steps, but never stop above the newest base row — the base is a full
    // view on its own, so it is always a healthy point and the walk must be
    // able to reach it (a busy folding session compacts every few ops).
    const walkFloor = Math.max(0, maxSeq - EGRESS_HEALTHY_WALK_MAX);
    const baseSeq = store.egressStateBaseSeq?.(sessionId) ?? 0;
    const floor = baseSeq > 0 ? Math.min(walkFloor, baseSeq) : walkFloor;
    for (let x = maxSeq - 1; x >= floor; x--) {
        let view: EgressViewRow[];
        try {
            view = store.egressStateViewAt(sessionId, x);
        } catch (err) {
            if (err instanceof EgressStateCorruptError) continue; // keep walking
            throw err;
        }
        if (view.length > 0) {
            const truncated = store.egressStateTruncateAfter(sessionId, x);
            loggerLog(
                "error",
                `[storage] egress session=${sessionId}: the outbound log did not replay (${damage}) — ${truncated} row(s) after op_seq ${x} were removed and the session continues from op_seq ${x} (${view.length} rows)`,
            );
            return { view, seq: x, degraded: true, truncated };
        }
    }
    return null;
}
