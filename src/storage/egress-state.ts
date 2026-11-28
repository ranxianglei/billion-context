/**
 * Egress state log — the canonical history (flow) and the materialized live
 * view (state) of the outbound conversation.
 *
 * Proposal: discussions/7398, revised design discussions/7439, and the
 * 2026-11-26 RE-ADJUDICATION discussions/7773 (owner ruling — the row
 * alphabet is I/U/D; the B base row never existed in the ruling and is
 * removed everywhere: not written, not read, no letter, no DDL CHECK).
 *
 * THE ROW ALPHABET (7773 §2, addressing re-ruled 2026-11-27):
 *   I  insert          msgid required  {"after": rid|null, ref, tokens,
 *                                       type, role?} + bytes column;
 *                                       rid column = the self-issued row id
 *                                       (see ROW ID below); log_seq column =
 *                                       the canonical number (one number
 *                                       per message, session-scoped)
 *   U  update-after    msgid required  {"role"?} + bytes column (the NEW
 *                                       bytes; detected by byte inequality);
 *                                       rid column = the target row's rid;
 *                                       an explicit num demotes/re-cites
 *                                       (num→0 = demote: the number is
 *                                       retired — permanently occupied by
 *                                       the flow's I row, never re-issued)
 *   D  delete-range    msgid NULL      {"start": rid, "end": rid}
 *                                       inclusive view-order range
 * There is no -U letter: the flow is never pruned, so a before-image is
 * always derivable from the rid's earlier I/U rows.
 *
 * ROW ID (owner ruling 2026-11-27, follow-up to #7773): every log address
 * is the self-issued `rid`, NEVER the msgid. The msgid is the CLIENT-facing
 * identity (pin channel, kernel refs) — a content-hash mint on the proxy
 * side, collidable in principle, and ambiguous across D/I churn. The rid is
 * dense per session (1, 2, 3, …), issued at I from the flow's MAX(rid) + 1
 * (the flow is append-only and physically never deleted, so the frontier
 * always sees every rid ever issued), and NEVER re-issued: a D retires the
 * rid forever, an I takes a fresh one. log_seq stays the kernel CITATION
 * number (mNNNNN) — a separate axis that a fold summary may re-cite after
 * retirement, which is exactly why it cannot serve as a row id.
 *
 * THE TWO TABLES (7773 §2):
 *   eg_flow  — the record: EVERY I/U/D op in order, append-only,
 *                  physically NEVER deleted. Growth optimization is a
 *                  separate, deferred project (#7475 family) — nothing
 *                  here ever prunes it.
 *   eg_state — the MATERIALIZED live view: one row per live message
 *                  (PK (session_id, rid); msgid kept as an indexed column —
 *                  the client-facing identity, read by the pin channel),
 *                  pos = the row's position in the current view. I inserts
 *                  (suffix shifts), U edits in place, D physically deletes
 *                  the range (suffix shifts). Serving reads are `ORDER BY
 *                  pos` DIRECT reads — no replay, no compaction, no base
 *                  concept.
 *
 * SINGLE SOURCE OF TRUTH: every turn's batch of I/U/D is appended to the
 * flow AND applied in place to the state, in ONE transaction — the two
 * tables are the same facts in two shapes. There is no compaction and no
 * second copy of the view anywhere.
 *
 * SELF-CONTAINED BYTES (ruling 7439 裁定 1, still in force): every I/U row
 * carries the message's FINAL core JSON in its own `bytes` column — no
 * hash references, no content table. Content identity is judged by DIRECT
 * BYTE EQUALITY; a replay of the flow needs nothing but the flow table.
 *
 * CANONICAL NUMBER (ruling 7439 + the 2026-11-25 renumber, egress-plane.md
 * §10): the flow's log_seq is the kernel citation number — mNNNNN =
 * m + log_seq, one number, not two. I ops may carry an explicit `num` (the
 * kernel's ledger number for that msgid, read at record time); the dense
 * high-water+1 counter survives only as the fallback for a row whose id
 * has no ledger entry. The constant system row is number 0 — OUTSIDE the
 * citation space (which starts at 1), so "the system prompt does not take
 * a message ref" is true by construction. The number frontier is the
 * flow's MAX(log_seq) — the ONLY source (the flow is never pruned, so it
 * is always correct; the old base-payload defensive fallback is gone).
 *
 * A STATE row carries TWO number columns:
 *   log_seq — the number the I op assigned, IMMUTABLE: it is the row's
 *             anchor to its I twin in the flow (same (msgid, log_seq));
 *   num     — the row's CURRENT canonical number: equals log_seq at
 *             insert, a U with an explicit num changes it (demote → 0).
 *
 * INTEGRITY (ruling 7439 裁定 5 ladder, re-pointed at 7773's data sources):
 * after materialization state and flow are no longer byte twins row-for-
 * row (a U edits the state in place), so the serving read checks
 * STRUCTURAL invariants, cheaply:
 *   - the state's pos sequence is dense 0..n-1;
 *   - every state row has its I twin in the flow (same rid AND same
 *     I-time log_seq);
 * a failed check = rebuild the state by replaying the flow's FULL
 * history (rare path — #7475 measured ~2.6s at 100k rows, one-shot,
 * acceptable); a flow that does not replay is corruption (the caller
 * degrades per the degrade ladder — never to client bytes). The write
 * path enforces the strong invariant at every turn: the batch is
 * validated against the current view (egressReplay), both tables take
 * the same ops in one transaction, and the state's row count is asserted
 * to equal the stamped view's length after the apply.
 *
 * Anchors are RIDS, never display positions — positions shift under
 * other ops, rids do not (self-issued, one-shot, never re-issued; the
 * msgid is the client-facing identity and stays out of the log's
 * addressing — owner ruling 2026-11-27). Any anchor/endpoint violation,
 * missing update target, or duplicate rid is a HARD ERROR
 * (EgressStateCorruptError) — no fuzzy guessing, same discipline as every
 * other lane's "any doubt, fall back whole-turn" rule.
 */

import type { SqliteDatabase } from "./driver.js";
import { log as loggerLog } from "../logger.js";
import { egressUsageForkCopy } from "./egress-usage.js";

export class EgressStateCorruptError extends Error {
    constructor(readonly sessionId: string, readonly reason: string) {
        super(`egress-state corrupt (session=${sessionId}): ${reason}`);
        this.name = "EgressStateCorruptError";
    }
}

/** The session's op log moved AFTER the point this turn started from —
 * another request on the same session (possibly from another bili process
 * sharing the index) recorded first. Nothing was written. The caller skips
 * this turn; the next turn starts from the log as it is now. (#7574: two
 * turns built on the same starting point used to interleave their ops —
 * one of them against anchors that were already gone.) */
export class EgressConcurrentWriteError extends Error {
    constructor(readonly sessionId: string, readonly baseSeq: number, readonly currentSeq: number) {
        super(`egress op log moved during the turn (session=${sessionId}: turn started at op_seq ${baseSeq}, the log is at ${currentSeq})`);
        this.name = "EgressConcurrentWriteError";
    }
}

/** Constant msgid of the system row (no hash — identity is the role, not
 * the content; a system change is a +U carrying the new bytes). The system
 * row is canonical number 0 — outside the citation space, so it can never
 * claim m00001. Defined HERE (the low layer) so the replay validation can
 * name it without importing egress-record (which imports this module). */
export const EGRESS_SYSTEM_MSGID = "egress-system";

/** One row of the current view. The ref (mNNNNN) is the kernel-space
 * display identity, never hash and never re-issued (kernel contract).
 * `num` is the row's CURRENT canonical number (0 = demoted/uncited): real
 * rows store num >= 1, EXCEPT the system row (0 by construction) and a
 * demoted row (U with num 0 — the retired number stays occupied in the
 * flow, never re-issued). `bytes` is the message's FINAL core JSON (post
 * reasoning-drop / image-rescale, pre outbound convert); for the system
 * row it is the system text itself. The row is self-contained: replay +
 * serve need nothing beyond the flow table. */
export interface EgressViewRow {
    /** Self-issued row id (dense per session, one-shot, never re-issued —
     *  the log's addressing key; 2026-11-27 owner ruling). Absent only on
     *  client-built diff inputs (buildEgressViewRows) — diffEgressView
     *  allocates it for every row that enters the log. */
    rid?: number;
    /** Current canonical session-scoped message number (0 = not cited). */
    num: number;
    msgid: string;
    ref: string;
    tokens: number;
    type: string;
    /** Final core JSON of the message (system row: the system text). */
    bytes: string;
    /** The kernel-space role (rebuild needs it; the diff keys on msgid so a
     *  role-only drift is impossible — kernel ids are one-shot). */
    role?: string;
    /** First-observed wall clock (epoch ms) — stamped on the message's I row
     *  (#7577 D3). A msgid is inserted exactly once (kernel ids are one-shot),
     *  so the I row IS the first observation; spine rows inherit it. */
    ts?: number;
}

type EgressOpType = "I" | "D" | "U";
/** 'G' is not an op — it is the GENERATION BOUNDARY row (discussions/7896):
 * a trust boundary written when the writer's LEDGER_GENERATION differs from
 * the flow's last row. Its payload is a FULL materialized-view snapshot;
 * replays start from the latest G at or below their target, so the pre-G
 * prefix (written under an older semantics) is never judged by the new law. */
type EgressFlowRowType = EgressOpType | "G";

/** Ledger GENERATION (discussions/7896, pre-GA discipline): the version
 * stamp of the ROW SEMANTICS of the eg_flow / eg_block_flow logs — the
 * numbering law, the replay invariants, the addressing scheme. DDL/layout
 * changes are NOT generations (they follow the storage schema version); a
 * semantics change is one that makes OLD rows unreadable under the new
 * rules, so the log can no longer be judged row-by-row against it.
 * Raising this constant REQUIRES (review gate, AGENTS.md rule):
 *   (a) the writer appends a 'G' boundary row on the first turn under the
 *       new generation (maybeWriteGenerationBoundary — payload = the full
 *       materialized view at the boundary);
 *   (b) every replay (egressStateAt / egressFlowWalkBack / egressBlockReplay)
 *       starts from the latest G at or below its target — the pre-G prefix
 *       is never judged by the new law;
 *   (c) a cross-generation fixture test (an old prefix containing rows the
 *       new law would reject, replaying cleanly from its G boundary).
 * Rows copied from the pre-rename egress_flow tables carry gen=0 (their
 * writer's law is gone with the old code — same boundary semantics). */
export const LEDGER_GENERATION = 1;

interface FlowRow {
    op_seq: number;
    log_seq: number | null;
    row_type: EgressFlowRowType;
    rid: number | null;
    msgid: string | null;
    payload: string;
    bytes: string | null;
    gen: number;
}

/** One row of the materialized live view (eg_state). `log_seq` is the
 * number the I op assigned (immutable — the I-twin anchor into the flow);
 * `num` is the row's CURRENT canonical number (a U with an explicit num
 * changes it; demote → 0). `sysIn` is the system row only: the CLIENT RAW
 * system text (input form A) — the flow row's bytes are the assembled
 * outbound (A + server blocks); A's home inside the egress tables (the
 * 2026-11-25 renumber retires the session_ext inc:system copy). */
interface StateRow {
    rid: number;
    msgid: string;
    pos: number;
    log_seq: number;
    num: number;
    ref: string;
    tokens: number;
    type: string;
    role: string | null;
    ts: number | null;
    sysIn: string | null;
    bytes: string;
}

const INSERT_FLOW = `INSERT INTO eg_flow (session_id, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_STATE_ROW = `INSERT INTO eg_state (session_id, rid, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SELECT_STATE_ROWS = `SELECT rid, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes FROM eg_state WHERE session_id = ? ORDER BY pos ASC`;

/** The canonical message frontier: the highest number ever ISSUED
 * (retired messages included — I rows only advance it, D/U never do).
 * MAX(log_seq) over the flow rows is the answer and the ONLY source —
 * the flow is append-only (physically never deleted, 7439 ruling + 7773),
 * so it always sees every number ever issued. The old base-payload
 * defensive fallback (for the illegally-pruned builds, df7ac0929 era) is
 * gone with the B row. */
export function egressMessageHighWater(db: SqliteDatabase, sessionId: string): number {
    const row = db
        .prepare("SELECT COALESCE(MAX(log_seq), 0) AS n FROM eg_flow WHERE session_id = ?")
        .get(sessionId) as { n: number } | undefined;
    return Number(row?.n) || 0;
}

/** The row-id frontier (2026-11-27): the highest rid ever ISSUED (retired
 * rows included — rids are never re-issued, and the flow is append-only /
 * never deleted, so MAX(rid) always sees every rid the session has used).
 * U rows carry their target's rid (never a new one), D rows carry NULL, so
 * the plain MAX over the table is the MAX over the I rows. diffEgressView
 * allocates new rids strictly above it. */
export function egressRowHighWater(db: SqliteDatabase, sessionId: string): number {
    const row = db
        .prepare("SELECT COALESCE(MAX(rid), 0) AS n FROM eg_flow WHERE session_id = ?")
        .get(sessionId) as { n: number } | undefined;
    return Number(row?.n) || 0;
}

function nextSeqs(db: SqliteDatabase, sessionId: string): { opSeq: number; num: number } {
    // eg_flow is the record and a superset of eg_state after every
    // turn, so the flow maxima ARE the session's high-waters: the op_seq
    // ordering cursor and the canonical message-number cursor (I rows only
    // — D/U carry NULL and never advance it).
    // #7577 (owner ruling 2026-11-24): DUAL CLOCKS — the block lifecycle log
    // numbers itself (eg_block_flow.op_seq dense within its own table,
    // see egress-block.ts); its rows carry flow_op_seq as a POINTER to this
    // clock (flow's MAX at write time) for cross-table alignment at point
    // forks. The flow table keeps its exclusive number pool: the op_seq and
    // log_seq cursors are eg_flow-only, and its density invariant
    // (#7574) stays intact regardless of what the block table does.
    //
    // #7574: must be read INSIDE the append transaction, never before it.
    const row = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o FROM eg_flow WHERE session_id = ?")
        .get(sessionId) as { o: number } | undefined;
    const head = Number(row?.o) || 0;
    return { opSeq: head + 1, num: egressMessageHighWater(db, sessionId) + 1 };
}

interface InsertOp {
    type: "I";
    msgid: string;
    /** The row's self-issued id — allocated by diffEgressView (dense, above
     *  the flow's rid frontier), REQUIRED (replay/apply hard-fail without
     *  it). 2026-11-27: the log's addressing key. */
    rid: number;
    /** Anchor: the rid of the preceding row of the new view (null = the
     *  row goes to the FRONT — a replaced system prompt). */
    after: number | null;
    ref: string;
    tokens: number;
    typeTag: string;
    bytes: string;
    role?: string;
    /** First-observed wall clock (epoch ms) — stamped by recordEgressTurn
     *  (#7577 D3); the I row is the message's birth, so this is its ts. */
    ts?: number;
    /** Renumber (2026-11-25): the kernel's citation number for this msgid
     *  (mNNNNN minus the prefix) — the op's log_seq when present and > 0.
     *  Absent (or 0) = the dense high-water+1 fallback. Never smaller than
     *  the current high water (kernel numbers are one-shot and the log's
     *  high water includes every retired number, so a cited number for a
     *  genuinely new id IS high-water+1 — the two agree by construction). */
    num?: number;
    /** System row only: the CLIENT RAW system text (input form A) — the
     *  flow row's bytes are the assembled outbound (A + server blocks);
     *  A gains its home inside the egress tables here (renumber 2026-11-25,
     *  egress-plane.md §10; retires the session_ext inc:system copy). */
    sysIn?: string;
}
interface DeleteOp {
    type: "D";
    start: number;
    end: number;
}
interface UpdateOp {
    type: "U";
    /** The target row's self-issued id (2026-11-27: the addressing key). */
    rid: number;
    msgid: string;
    bytes: string;
    role?: string;
    /** System row only: the new client raw system text (see InsertOp). */
    sysIn?: string;
    /** New canonical number (0 = uncited — the row's old number is retired,
     *never re-issued). Absent = the row keeps its number. */
    num?: number;
}
export type EgressOp = InsertOp | DeleteOp | UpdateOp;

/** Highest canonical number used by the view (retired rows are gone from
 * the view but their numbers live on in the flow — the append advances
 * past the stored high-water, which includes them). */
function egressViewHighWater(view: EgressViewRow[]): number {
    let hw = 0;
    for (const r of view) if (r.num > hw) hw = r.num;
    return hw;
}

/** Pure replay: apply ops (in op order) on top of an existing view.
 * Shared by the db-backed replays and the diff engine's own verification.
 * Insert ops take their canonical number from the op when the op carries an
 * explicit `num` (the kernel citation number, renumber 2026-11-25) — the
 * cursor tracks past it — otherwise the next dense number in op order
 * (high-water(prev) + 1, + 2, …): the SAME rule the append uses, so the
 * replayed view is exactly the stamped view the tables would produce.
 * `startHigh` overrides high-water(prev): the append passes the cursor it
 * read from the flow, which includes numbers of rows a fold retired. */
export function egressReplay(prev: EgressViewRow[], ops: EgressOp[], startHigh?: number, sessionId = "diff"): EgressViewRow[] {
    const view: EgressViewRow[] = prev.map((r) => ({ ...r }));
    const idxOf = (rid: number): number => view.findIndex((r) => r.rid === rid);
    let num = startHigh ?? egressViewHighWater(view);
    // Renumber (2026-11-25) — citation rules:
    //  - the live set's numbers must stay UNIQUE; a cited number is
    //    authoritative (kernel ledger), even below the high water — a fold
    //    summary may legitimately take a slot a D retired in the same batch,
    //    or one retired earlier. Only a collision with a row that is LIVE
    //    at the op's position (or with a sibling op in this batch) is
    //    corrupt.
    //  - an UNCITED row takes the dense fallback ABOVE every number the
    //    batch cites, so it can never squat a citation that arrives later
    //    in the same batch (a kernel-generated summary has no refs entry
    //    while the host's fold cell does — both land in one turn).
    const liveNums = new Set<number>();
    for (const r of view) if (r.num > 0) liveNums.add(r.num);
    // Row ids (2026-11-27): unique among LIVE rows — a D retires its rids
    // forever (the flow keeps them spent), an I reuses none of them.
    const liveRids = new Set<number>();
    for (const r of view) if (typeof r.rid === "number") liveRids.add(r.rid);
    let maxCited = 0;
    for (const op of ops) {
        if (op.type === "I" && op.msgid !== EGRESS_SYSTEM_MSGID && typeof op.num === "number" && op.num > 0) maxCited = Math.max(maxCited, op.num);
        if (op.type === "U" && typeof op.num === "number" && op.num > 0) maxCited = Math.max(maxCited, op.num);
    }
    for (const op of ops) {
        if (op.type === "I") {
            if (!Number.isInteger(op.rid) || op.rid < 1) throw new EgressStateCorruptError(sessionId, `insert ${op.msgid} has no row id`);
            if (liveRids.has(op.rid)) throw new EgressStateCorruptError(sessionId, `duplicate row id ${op.rid} (msgid ${op.msgid})`);
            // `after: null` = the first row of the new view → the front.
            // #7574: idxOf answers -1 for a missing anchor, so the old
            // `at < -1` test could never fire and a missing anchor inserted
            // the row at index 0 in silence.
            const at = op.after === null ? -1 : idxOf(op.after);
            if (at === -1 && op.after !== null) throw new EgressStateCorruptError(sessionId, `insert anchor rid ${op.after} missing`);
            const isSystem = op.msgid === EGRESS_SYSTEM_MSGID;
            let assign = 0;
            if (isSystem) {
                num = Math.max(num, 0);
                assign = 0;
            } else {
                const cited = typeof op.num === "number" && op.num > 0 ? op.num : 0;
                if (cited > 0) {
                    if (liveNums.has(cited)) throw new EgressStateCorruptError(sessionId, `cited number ${cited} is already live (msgid ${op.msgid})`);
                    liveNums.add(cited);
                    assign = cited;
                    num = Math.max(num, cited);
                } else {
                    num = Math.max(num, maxCited) + 1;
                    liveNums.add(num);
                    assign = num;
                }
            }
            liveRids.add(op.rid);
            const entry: EgressViewRow = { rid: op.rid, num: assign, msgid: op.msgid, ref: op.ref, tokens: op.tokens, type: op.typeTag, bytes: op.bytes };
            if (op.role !== undefined) entry.role = op.role;
            if (op.ts !== undefined) entry.ts = op.ts;
            view.splice(at + 1, 0, entry);
        } else if (op.type === "D") {
            const s = idxOf(op.start);
            const e = idxOf(op.end);
            if (s < 0) throw new EgressStateCorruptError(sessionId, `delete start rid ${op.start} missing`);
            if (e < 0) throw new EgressStateCorruptError(sessionId, `delete end rid ${op.end} missing`);
            if (s > e) throw new EgressStateCorruptError(sessionId, "delete range inverted");
            for (let i = s; i <= e; i++) {
                const r = view[i];
                if (r !== undefined) {
                    if (r.num > 0) liveNums.delete(r.num);
                    if (typeof r.rid === "number") liveRids.delete(r.rid);
                }
            }
            view.splice(s, e - s + 1);
        } else {
            const i = idxOf(op.rid);
            if (i < 0) throw new EgressStateCorruptError(sessionId, `update target rid ${op.rid} missing`);
            const row = view[i];
            // Cross-check: the flow row's msgid column must name the same
            // row the rid resolves to — a stale column is corruption.
            if (row.msgid !== op.msgid) throw new EgressStateCorruptError(sessionId, `update rid ${op.rid} points at msgid ${row.msgid}, not ${op.msgid}`);
            if (typeof op.num === "number") {
                if (row.num > 0) liveNums.delete(row.num);
                if (op.num > 0) {
                    if (liveNums.has(op.num)) throw new EgressStateCorruptError(sessionId, `cited number ${op.num} is already live (msgid ${op.msgid})`);
                    liveNums.add(op.num);
                }
                row.num = op.num;
                num = Math.max(num, op.num);
            }
            view[i] = { ...row, bytes: op.bytes, ...(op.role !== undefined ? { role: op.role } : {}) };
        }
    }
    return view;
}

/** Deterministic diff between two consecutive views (owner design, 4 upper
 * cases: tail append / nudge appear+vanish / fold replace / content edit).
 * The diff keys on msgid OCCURRENCE + bytes; a spine row's effective num
 * (0 = uncited) is a third input that can flip it to a +U carrying `num`
 * (see below).
 *
 * Spine = a monotonically increasing subsequence of `next` matched to
 * SPECIFIC prev occurrences (greedy pointer scan, O(n+m); any monotone
 * sub-spine replays equivalently, the greedy one is what this implementation
 * picks). Matching is OCCURRENCE-AWARE, not first-wins on msgid (#7851): a
 * collision pair (two prev rows, same msgid, distinct rids) is addressed per
 * occurrence — a next row prefers the occurrence whose bytes agree (the
 * survivor keeps its own rid, a pure -D), else the first occurrence after
 * the pointer (msgid-only, so a content edit still emits a U). No-collision
 * views have one occurrence per msgid, so the match is identical to the old
 * first-wins key there.
 * Spine rows with CHANGED BYTES (direct inequality — no hash) OR a changed
 * effective num (0 = uncited — a kernel protection row that lost or gained
 * its citation) emit +U (with `num` set on a num change, so the log follows
 * the kernel citation facts; a demoted number is retired, never re-issued);
 * everything else emits -D (maximal contiguous runs in PREV order) plus +I
 * in NEXT order with the preceding row as anchor. egressReplay(prev, diff)
 * always reproduces `next` exactly (including num).
 *
 * Moves (same msgid, new position) are deliberately expressed as D+I — there
 * is no M op; the msgid stays the identity through both ops, and the NEW
 * number the D+I assigns is the message's number from then on (the old
 * number stays retired — never re-issued). */
/**
 * `trackNums` = the `next` rows were stamped against a live refs ledger
 * (recordEgressTurn passes `refMap !== undefined`): a spine row whose
 * effective num changed is a REAL kernel citation-fact change (demote /
 * re-cite / re-homing) and emits a +U carrying the new num. Without a
 * ledger every next row carries 0 and the comparison would demote the whole
 * spine every turn — so num tracking is OFF and the diff keys on msgid +
 * bytes only, as before.
 */
export function diffEgressView(prev: EgressViewRow[], next: EgressViewRow[], trackNums = false, ridHighWater = 0): EgressOp[] {
    // RID ALLOCATION (2026-11-27): every row that ENTERS the log gets a
    // fresh rid — dense, strictly above max(the flow's rid frontier, the
    // max rid of prev), in `next` order. `ridHighWater` is the FLOW's
    // MAX(rid) (includes retired rows — rids are never re-issued); prev
    // rows keep their rids. Defensive: a prev row missing a rid (test
    // shims) gets one from the same counter before it can anchor anything.
    let rid = Math.max(ridHighWater, 0);
    for (const r of prev) {
        if (typeof r.rid !== "number" || r.rid < 1) {
            rid += 1;
            r.rid = rid;
        } else if (r.rid > rid) {
            rid = r.rid;
        }
    }
    // OCCURRENCE-AWARE SPINE (2026-11-27, #7851): a msgid can appear MORE
    // THAN ONCE in prev when the host minted a collision pair (same msgid,
    // distinct rids). Keying the spine on msgid (first-wins) made the two
    // rows indistinguishable — deleting one of the pair left the survivor
    // "spine" for BOTH, so the D-run never fired (ghost row) and the U wrote
    // to the first row's rid with the second's bytes (content mismatch).
    // Match each next row to a SPECIFIC prev occurrence instead: prefer the
    // occurrence whose bytes agree (the survivor keeps its own rid — a pure
    // -D, no spurious U), else the first occurrence after the pointer
    // (msgid-only, so a content edit still emits a U). No-collision views
    // have at most one occurrence per msgid, so this is a no-op there.
    const prevOcc = new Map<string, number[]>();
    prev.forEach((r, i) => {
        const occs = prevOcc.get(r.msgid);
        if (occs) occs.push(i);
        else prevOcc.set(r.msgid, [i]);
    });
    const spinePrev = new Map<number, number>();
    let p = -1;
    for (let j = 0; j < next.length; j++) {
        const r = next[j];
        const occs = prevOcc.get(r.msgid);
        if (!occs) continue;
        let match = -1;
        for (const i of occs) {
            if (i > p && prev[i].bytes === r.bytes) { match = i; break; }
        }
        if (match === -1) {
            for (const i of occs) {
                if (i > p) { match = i; break; }
            }
        }
        if (match !== -1) {
            spinePrev.set(j, match);
            p = match;
        }
    }
    const matchedPrev = new Set<number>();
    for (const i of spinePrev.values()) matchedPrev.add(i);
    const ops: EgressOp[] = [];
    let runStart: EgressViewRow | null = null;
    let runEnd: EgressViewRow | null = null;
    for (let i = 0; i < prev.length; i++) {
        const r = prev[i];
        if (!matchedPrev.has(i)) {
            if (runStart === null) runStart = r;
            runEnd = r;
        } else if (runStart !== null) {
            ops.push({ type: "D", start: runStart.rid!, end: runEnd!.rid! });
            runStart = runEnd = null;
        }
    }
    if (runStart !== null) ops.push({ type: "D", start: runStart.rid!, end: runEnd!.rid! });
    for (let j = 0; j < next.length; j++) {
        const r = next[j];
        const pi = spinePrev.get(j);
        if (pi !== undefined) {
            const old = prev[pi];
            const oldNum = trackNums && typeof old.num === "number" && old.num > 0 ? old.num : 0;
            const newNum = trackNums && typeof r.num === "number" && r.num > 0 ? r.num : 0;
            if (old.bytes !== r.bytes || oldNum !== newNum) {
                const u: UpdateOp = { type: "U", rid: old.rid!, msgid: r.msgid, bytes: r.bytes };
                if (r.role !== undefined) u.role = r.role;
                if (oldNum !== newNum) u.num = newNum;
                ops.push(u);
            }
        }
    }
    let last: number | null = null;
    for (let j = 0; j < next.length; j++) {
        const r = next[j];
        const pi = spinePrev.get(j);
        if (pi !== undefined) {
            last = prev[pi].rid!;
        } else {
            rid += 1;
            const ins: InsertOp = { type: "I", rid, msgid: r.msgid, after: last, ref: r.ref, tokens: r.tokens, typeTag: r.type, bytes: r.bytes };
            if (r.role !== undefined) ins.role = r.role;
            // Renumber (2026-11-25): a next-view row may already carry its
            // kernel citation number (recordEgressTurn stamps it from the
            // refs ledger); the I op preserves it.
            if (typeof r.num === "number" && r.num > 0) ins.num = r.num;
            ops.push(ins);
            last = rid;
        }
    }
    return ops;
}

/** Write one FLOW row (the record). The state table is applied separately
 * (materialized, 7773) — there is no twin-pair copy anymore. */
function writeFlowRow(db: SqliteDatabase, sessionId: string, opSeq: number, logSeq: number | null, rowType: EgressFlowRowType, rid: number | null, msgid: string | null, payload: string, bytes: string | null, gen: number, nowMs: number): void {
    db.prepare(INSERT_FLOW).run(sessionId, opSeq, logSeq, rowType, rid, msgid, payload, bytes, gen, nowMs);
}

/** Decode + validate a 'G' boundary row's payload into the full view it
 * snapshots. Throws EgressStateCorruptError on any malformation (a corrupt
 * boundary is a corrupt log — the caller's ladder decides the damage).
 * Rows are positional: the snapshot is the view at the boundary, in pos
 * order; every field the I-row validation requires is required here too
 * (the snapshot IS the materialized view). */
function decodeGenSnapshot(sessionId: string, row: FlowRow): EgressViewRow[] {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
        throw new EgressStateCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} is not an object`);
    }
    if (parsed.gen !== LEDGER_GENERATION) {
        throw new EgressStateCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} names an unknown generation ${String(parsed.gen)}`);
    }
    if (!Array.isArray(parsed.rows)) {
        throw new EgressStateCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} has no rows array`);
    }
    const view: EgressViewRow[] = [];
    const seenRids = new Set<number>();
    for (let i = 0; i < parsed.rows.length; i++) {
        const o = parsed.rows[i] as Record<string, unknown>;
        if (typeof o?.rid !== "number" || o.rid < 1 || typeof o.num !== "number" || o.num < 0
            || typeof o.msgid !== "string" || typeof o.ref !== "string" || typeof o.tokens !== "number"
            || typeof o.type !== "string" || typeof o.bytes !== "string") {
            throw new EgressStateCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} has a malformed snapshot row ${i}`);
        }
        if (seenRids.has(o.rid)) {
            throw new EgressStateCorruptError(sessionId, `G boundary at op_seq=${row.op_seq} has a duplicate row id ${o.rid}`);
        }
        seenRids.add(o.rid);
        const entry: EgressViewRow = { rid: o.rid, num: o.num, msgid: o.msgid, ref: o.ref, tokens: o.tokens, type: o.type, bytes: o.bytes };
        if (o.role !== undefined) entry.role = String(o.role);
        if (typeof o.ts === "number") entry.ts = o.ts;
        view.push(entry);
    }
    return view;
}

/** 7896: return the op_seq the NEW ops must start at. When the flow's last
 * row was written by an OLDER generation, close the old prefix with a 'G'
 * boundary row first — payload = the full live view read BEFORE any of the
 * new ops apply (the boundary is exactly "the view as the old generation
 * left it") — and the ops take the slot after it. A fresh log (no rows)
 * or a same-generation log needs no boundary. Runs inside the caller's
 * write transaction. */
function maybeWriteGenerationBoundary(db: SqliteDatabase, sessionId: string, firstOpSeq: number, nowMs: number): number {
    const last = db
        .prepare("SELECT gen FROM eg_flow WHERE session_id = ? ORDER BY op_seq DESC LIMIT 1")
        .get(sessionId) as { gen: number } | undefined;
    if (last === undefined || last.gen === LEDGER_GENERATION) return firstOpSeq;
    const snapshot = egressStateView(db, sessionId);
    writeFlowRow(db, sessionId, firstOpSeq, null, "G", null, null, JSON.stringify({ gen: LEDGER_GENERATION, rows: snapshot }), null, LEDGER_GENERATION, nowMs);
    return firstOpSeq + 1;
}

/** Write a batch of ops to the FLOW. Every op gets the next op_seq; each I
 * op ALSO gets its canonical number — the kernel citation number when the
 * op carries an explicit `num` (renumber 2026-11-25), the dense
 * high-water+1 fallback otherwise (the cursor starts past every number ever
 * issued, retired ones included) — D/U ops occupy op_seq slots but no
 * numbers. The system row (no citation) stores log_seq 0. The caller has
 * already validated the batch against the log as it is. */
function writeFlowOps(db: SqliteDatabase, sessionId: string, ops: EgressOp[], firstOpSeq: number, firstNum: number, nowMs: number): void {
    let num = firstNum - 1;
    // Mirror egressReplay exactly (it already validated the batch): the
    // dense fallback for an uncited row lands ABOVE every number the batch
    // cites, and a cited row below the cursor is legal when its slot is
    // retired (fold re-homing).
    let maxCited = 0;
    for (const op of ops) {
        if (op.type === "I" && op.msgid !== EGRESS_SYSTEM_MSGID && typeof op.num === "number" && op.num > 0) maxCited = Math.max(maxCited, op.num);
        if (op.type === "U" && typeof op.num === "number" && op.num > 0) maxCited = Math.max(maxCited, op.num);
    }
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const opSeq = firstOpSeq + i;
        if (op.type === "I") {
            const isSystem = op.msgid === EGRESS_SYSTEM_MSGID;
            // The system row stores 0 WITHOUT advancing the cursor — the
            // replay's system branch (egressReplay) does not advance either;
            // advancing here would retire number 1 on every session and
            // store/replay would disagree by one.
            if (!isSystem) {
                const cited = typeof op.num === "number" && op.num > 0 ? op.num : 0;
                if (cited > 0) {
                    // A cited row stores ITS citation even when it sits below
                    // the cursor (retired-slot re-homing); the cursor still
                    // tracks the max.
                    num = Math.max(num, cited);
                } else {
                    num = Math.max(num, maxCited) + 1;
                }
            }
            const payload: Record<string, unknown> = { after: op.after, ref: op.ref, tokens: op.tokens, type: op.typeTag, role: op.role, ts: op.ts };
            if (op.sysIn !== undefined) payload["sysIn"] = op.sysIn;
            const citedLog = !isSystem && typeof op.num === "number" && op.num > 0 ? op.num : 0;
            const logSeq = isSystem ? 0 : (citedLog > 0 ? citedLog : num);
            writeFlowRow(db, sessionId, opSeq, logSeq, "I", op.rid, op.msgid, JSON.stringify(payload), op.bytes, LEDGER_GENERATION, nowMs);
        } else if (op.type === "D") {
            // 2026-11-27: the range endpoints are RIDS (self-issued, never
            // re-issued) — the msgid never indexes the log again.
            writeFlowRow(db, sessionId, opSeq, null, "D", null, null, JSON.stringify({ start: op.start, end: op.end }), null, LEDGER_GENERATION, nowMs);
        } else {
            const payload: Record<string, unknown> = { role: op.role };
            if (op.sysIn !== undefined) payload["sysIn"] = op.sysIn;
            if (op.num !== undefined) {
                payload["num"] = op.num;
                num = Math.max(num, op.num);
            }
            writeFlowRow(db, sessionId, opSeq, null, "U", op.rid, op.msgid, JSON.stringify(payload), op.bytes, LEDGER_GENERATION, nowMs);
        }
    }
}

/** Replace the session's materialized state with the given view: DELETE
 * every row, INSERT the view at pos 0..n-1. The state row's log_seq is
 * its I-twin's anchor into the flow: the log_seq of the msgid's I row
 * (the LATEST one — a D+I move retires the earlier row, so the latest I
 * row is the anchor the twin check joins on). A demoted row (num 0) keeps
 * its I-time anchor — its number is retired, never re-issued, but the
 * state row still points at the flow row that recorded its birth. A view
 * row with no I row in the flow is a stray (the same condition the
 * serving read's twin check rejects) and throws. Runs inside the caller's
 * transaction. Returns the number of rows removed. */
export function egressMaterializeState(db: SqliteDatabase, sessionId: string, view: EgressViewRow[], nowMs: number): number {
    const anchors = new Map<number, number>();
    for (const r of db
        .prepare("SELECT rid, log_seq FROM eg_flow WHERE session_id = ? AND row_type = 'I' ORDER BY op_seq ASC")
        .all(sessionId) as { rid: number | null; log_seq: number | null }[]) {
        if (typeof r.rid !== "number") throw new EgressStateCorruptError(sessionId, `I row has no rid`);
        if (typeof r.log_seq !== "number") throw new EgressStateCorruptError(sessionId, `I row rid ${r.rid} has no log_seq`);
        if (anchors.has(r.rid)) throw new EgressStateCorruptError(sessionId, `duplicate I row for rid ${r.rid}`);
        anchors.set(r.rid, r.log_seq);
    }
    const removed = db
        .prepare("DELETE FROM eg_state WHERE session_id = ?")
        .run(sessionId) as { changes: number };
    for (let i = 0; i < view.length; i++) {
        const r = view[i];
        const isSystem = r.msgid === EGRESS_SYSTEM_MSGID;
        if (typeof r.rid !== "number" || r.rid < 1) {
            throw new EgressStateCorruptError(sessionId, `materialized entry ${r.msgid} has no row id`);
        }
        const anchor = anchors.get(r.rid);
        if (typeof r.num !== "number" || r.num < 0 || anchor === undefined || (isSystem ? r.num !== 0 || anchor !== 0 : anchor < 1)) {
            throw new EgressStateCorruptError(sessionId, `materialized entry ${r.msgid} has no canonical number`);
        }
        db.prepare(INSERT_STATE_ROW).run(
            sessionId, r.rid, r.msgid, i, anchor, r.num, r.ref, r.tokens, r.type,
            r.role ?? null, r.ts ?? null, null, r.bytes, nowMs,
        );
    }
    return Number(removed.changes);
}

/** The session's materialized state rows (the live view in pos order). */
function readStateRows(db: SqliteDatabase, sessionId: string): StateRow[] {
    return db
        .prepare(SELECT_STATE_ROWS)
        .all(sessionId) as unknown as StateRow[];
}

/** Direct read of the materialized live view (the serving fast path — no
 * replay). Throws EgressStateCorruptError on shape violations (a gap or
 * negative in the pos sequence, an unnumbered real row). */
export function egressStateView(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    const rows = readStateRows(db, sessionId);
    const view: EgressViewRow[] = [];
    for (const r of rows) {
        if (r.pos !== view.length) {
            throw new EgressStateCorruptError(sessionId, `state pos jumps from ${view.length} to ${r.pos} (msgid ${r.msgid})`);
        }
        if (r.msgid !== EGRESS_SYSTEM_MSGID && r.log_seq < 1) {
            throw new EgressStateCorruptError(sessionId, `state row ${r.msgid} has no canonical number (log_seq ${r.log_seq})`);
        }
        if (r.num < 0 || (r.msgid === EGRESS_SYSTEM_MSGID && r.num !== 0)) {
            throw new EgressStateCorruptError(sessionId, `state row ${r.msgid} has an invalid current number (num ${r.num})`);
        }
        const row: EgressViewRow = { rid: r.rid, num: r.num, msgid: r.msgid, ref: r.ref, tokens: r.tokens, type: r.type, bytes: r.bytes };
        if (r.role !== null) row.role = r.role;
        if (r.ts !== null) row.ts = r.ts;
        view.push(row);
    }
    return view;
}

/** The STRUCTURAL integrity check (7773): state and flow are no longer
 * byte twins row-for-row (a U edits the state in place), so the check is
 * (a) every state row has its I twin in the flow — same rid AND same
 * I-time log_seq; (b) no state row exists for a session whose flow has no
 * rows. Cheap (index join), runs inside the caller's read transaction.
 * Throws EgressStateCorruptError on any stray row. */
function assertStateTwinOfFlow(db: SqliteDatabase, sessionId: string): void {
    const stray = db
        .prepare(
            `SELECT COUNT(*) AS c FROM eg_state s
               LEFT JOIN eg_flow f ON f.session_id = s.session_id AND f.rid = s.rid AND f.log_seq = s.log_seq AND f.row_type = 'I'
              WHERE s.session_id = ? AND f.op_seq IS NULL`,
        )
        .get(sessionId) as { c: number };
    if (Number(stray.c) > 0) {
        throw new EgressStateCorruptError(sessionId, `${Number(stray.c)} state row(s) have no I twin in the flow`);
    }
    const counts = db
        .prepare(
            `SELECT (SELECT COUNT(*) FROM eg_state WHERE session_id = ?) AS s,
                    (SELECT COUNT(*) FROM eg_flow WHERE session_id = ?) AS f`,
        )
        .get(sessionId, sessionId) as { s: number; f: number };
    if (Number(counts.s) > 0 && Number(counts.f) === 0) {
        throw new EgressStateCorruptError(sessionId, "state has rows but the flow is empty");
    }
    if (Number(counts.s) === 0 && Number(counts.f) > 0) {
        // the inverse divergence: a session whose flow has rows but whose
        // state is empty would read as a fresh bootstrap while the flow's
        // numbers stay spent — the next turn would re-issue them
        throw new EgressStateCorruptError(sessionId, "the flow has rows but the state is empty");
    }
}

/** Replace the session's materialized state with a full-history REPLAY of
 * its flow (the rebuild, degrade ladder step 2). ONE transaction; the flow
 * is replayed FIRST, so a flow that does not replay throws
 * EgressStateCorruptError before anything is written (this repairs a
 * damaged COPY, it cannot repair the record). Returns the view. */
export function egressRebuildState(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    return db.transaction(() => {
        const view = egressStateAt(db, sessionId, Number.MAX_SAFE_INTEGER);
        egressMaterializeState(db, sessionId, view, Date.now());
        return view;
    });
}

/** The serving read (7773): the materialized state DIRECT (ORDER BY pos,
 * no replay) plus the cheap structural twin check, in one read
 * transaction. When the check fails — the COPY is damaged — it is rebuilt
 * from the flow's full history and the view is served normally: a derived
 * table can never cost a turn. Only a flow that does not replay throws
 * EgressStateCorruptError (the caller degrades per the degrade ladder). */
export function egressStateRead(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    let damage: EgressStateCorruptError | null = null;
    const view = db.readTransaction(() => {
        try {
            const v = egressStateView(db, sessionId);
            assertStateTwinOfFlow(db, sessionId);
            return v;
        } catch (err) {
            if (!(err instanceof EgressStateCorruptError)) throw err;
            damage = err;
            return null;
        }
    });
    if (view !== null) return view;
    const rebuilt = egressRebuildState(db, sessionId);
    loggerLog("warn", `[storage] egress session=${sessionId}: the live view did not match the log (${damage!.reason}) — rebuilt from the full flow history (${rebuilt.length} rows)`);
    return rebuilt;
}

/** rid → pos over the session's materialized rows (the batch apply's
 * working index; a direct read replaces it after every transaction). */
function posIndex(rows: StateRow[]): Map<number, number> {
    const posOf = new Map<number, number>();
    for (const r of rows) posOf.set(r.rid, r.pos);
    return posOf;
}

/** Apply a VALIDATED op batch to the materialized state (7773: the state
 * takes the same ops the flow just took, in place — I inserts at the
 * anchor's pos with a suffix shift, U edits the row in place, D physically
 * deletes the range with a suffix shift — "D 时后续行 shift，fold O(尾长)").
 * The batch has already replayed cleanly against egressStateView of exactly
 * these rows (same transaction, same snapshot), so every anchor/target
 * resolves; a failure here is a programming error and throws. Runs inside
 * the caller's write transaction. */
function applyOpsToState(db: SqliteDatabase, sessionId: string, ops: EgressOp[], stamped: EgressViewRow[], nowMs: number): void {
    const posOf = posIndex(readStateRows(db, sessionId));
    const numOf = new Map<number, number>();
    for (const r of stamped) if (typeof r.rid === "number") numOf.set(r.rid, r.num);
    for (const op of ops) {
        if (op.type === "I") {
            if (posOf.has(op.rid)) throw new EgressStateCorruptError(sessionId, `state apply: insert rid ${op.rid} already present`);
            const at = op.after === null ? -1 : posOf.get(op.after);
            if (at === undefined && op.after !== null) throw new EgressStateCorruptError(sessionId, `state apply: insert anchor rid ${op.after} missing`);
            const pos = (at ?? -1) + 1;
            const assign = numOf.get(op.rid) ?? 0;
            db.prepare("UPDATE eg_state SET pos = pos + 1 WHERE session_id = ? AND pos >= ?").run(sessionId, pos);
            db.prepare(INSERT_STATE_ROW).run(
                sessionId, op.rid, op.msgid, pos, assign, assign, op.ref, op.tokens, op.typeTag,
                op.role ?? null, op.ts ?? null, op.sysIn ?? null, op.bytes, nowMs,
            );
            for (const [k, p] of posOf) if (p >= pos) posOf.set(k, p + 1);
            posOf.set(op.rid, pos);
        } else if (op.type === "D") {
            const s = posOf.get(op.start);
            const e = posOf.get(op.end);
            if (s === undefined) throw new EgressStateCorruptError(sessionId, `state apply: delete start rid ${op.start} missing`);
            if (e === undefined) throw new EgressStateCorruptError(sessionId, `state apply: delete end rid ${op.end} missing`);
            if (s > e) throw new EgressStateCorruptError(sessionId, "state apply: delete range inverted");
            const span = e - s + 1;
            db.prepare("DELETE FROM eg_state WHERE session_id = ? AND pos BETWEEN ? AND ?").run(sessionId, s, e);
            db.prepare("UPDATE eg_state SET pos = pos - ? WHERE session_id = ? AND pos > ?").run(span, sessionId, e);
            for (const [k, p] of posOf) {
                if (p >= s && p <= e) posOf.delete(k);
                else if (p > e) posOf.set(k, p - span);
            }
        } else {
            const pos = posOf.get(op.rid);
            if (pos === undefined) throw new EgressStateCorruptError(sessionId, `state apply: update target rid ${op.rid} missing`);
            const sets = ["bytes = ?", "created_at = ?"];
            const params: unknown[] = [op.bytes, nowMs];
            if (op.role !== undefined) {
                sets.push("role = ?");
                params.push(op.role);
            }
            if (op.sysIn !== undefined) {
                sets.push("sys_in = ?");
                params.push(op.sysIn);
            }
            if (op.num !== undefined) {
                sets.push("num = ?");
                params.push(op.num);
            }
            db.prepare(`UPDATE eg_state SET ${sets.join(", ")} WHERE session_id = ? AND rid = ?`).run(...params, sessionId, op.rid);
        }
    }
}

/** Append a batch of ops to BOTH planes (flow append + state apply) in ONE
 * transaction. #7574: the batch is replayed against the live view as it is
 * inside that transaction BEFORE anything is written — an op whose anchor
 * or target is not there is refused (EgressStateCorruptError) instead of
 * being stored as the row that breaks every later read. After the apply,
 * the state's row count is asserted to equal the stamped view's length
 * (7773 §6 invariant 2, enforced at every write). Returns the assigned
 * op_seqs in input order. */
export function egressStateAppend(
    db: SqliteDatabase,
    sessionId: string,
    ops: EgressOp[],
    nowMs: number,
): number[] {
    if (ops.length === 0) return [];
    return db.transaction(() => {
        const seqs = nextSeqs(db, sessionId);
        const stamped = egressReplay(egressStateView(db, sessionId), ops, seqs.num - 1, sessionId);
        const firstOpSeq = maybeWriteGenerationBoundary(db, sessionId, seqs.opSeq, nowMs);
        writeFlowOps(db, sessionId, ops, firstOpSeq, seqs.num, nowMs);
        applyOpsToState(db, sessionId, ops, stamped, nowMs);
        const n = db
            .prepare("SELECT COUNT(*) AS c FROM eg_state WHERE session_id = ?")
            .get(sessionId) as { c: number };
        if (Number(n.c) !== stamped.length) {
            throw new EgressStateCorruptError(sessionId, `state apply diverged: ${Number(n.c)} rows but the stamped view has ${stamped.length}`);
        }
        return Array.from({ length: ops.length }, (_, i) => firstOpSeq + i);
    });
}

/** Record one turn: ONE transaction (BEGIN IMMEDIATE) that
 *   1. reads the log's cursors,
 *   2. refuses the batch when the log moved since the caller read its
 *      starting point (`guard.baseSeq` = the op_seq the caller's view was
 *      at) — EgressConcurrentWriteError, nothing written;
 *   3. replays the batch on the live view as it is now (refuses a broken
 *      batch),
 *   4. appends the batch to the flow AND applies it in place to the state
 *      (single source of truth, 7773 — there is no compaction step; a D
 *      deletes its range physically and the flow keeps every row forever).
 * `ops` must be non-empty (the caller returns its own view for an empty
 * diff). Returns the stamped view the tables now hold. */
export function egressAppendTurn(
    db: SqliteDatabase,
    sessionId: string,
    ops: EgressOp[],
    nowMs: number,
    guard: { baseSeq: number },
): EgressViewRow[] {
    return db.transaction(() => {
        const seqs = nextSeqs(db, sessionId);
        if (seqs.opSeq - 1 !== guard.baseSeq) {
            throw new EgressConcurrentWriteError(sessionId, guard.baseSeq, seqs.opSeq - 1);
        }
        const stamped = egressReplay(egressStateView(db, sessionId), ops, seqs.num - 1, sessionId);
        const firstOpSeq = maybeWriteGenerationBoundary(db, sessionId, seqs.opSeq, nowMs);
        writeFlowOps(db, sessionId, ops, firstOpSeq, seqs.num, nowMs);
        applyOpsToState(db, sessionId, ops, stamped, nowMs);
        const n = db
            .prepare("SELECT COUNT(*) AS c FROM eg_state WHERE session_id = ?")
            .get(sessionId) as { c: number };
        if (Number(n.c) !== stamped.length) {
            throw new EgressStateCorruptError(sessionId, `state apply diverged: ${Number(n.c)} rows but the stamped view has ${stamped.length}`);
        }
        return stamped;
    });
}

/** Replay the FLOW table up to (and including) op_seq x — the rollback /
 * reconstruction point read (7773: any flow prefix, full history from 0 —
 * there is no base row to start from). Throws like egressStateView. */
export function egressStateAt(db: SqliteDatabase, sessionId: string, x: number): EgressViewRow[] {
    const rows = db
        .prepare(
            "SELECT op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen FROM eg_flow WHERE session_id = ? AND op_seq <= ? ORDER BY op_seq ASC",
        )
        .all(sessionId, x) as unknown as FlowRow[];
    return applyOps(sessionId, rows);
}

/** Fork (ruling 7439 裁定 B, 7773 shape): copy the parent's ENTIRE flow —
 * every row (append-only, nothing is ever pruned) — AND its materialized
 * state (direct copy: both are already the parent's exact facts) to the
 * child session_id inside ONE transaction. op_seq/log_seq/pos are
 * preserved verbatim, so the child inherits the parent's full canonical
 * number space and retired marks: its next number continues where the
 * parent stopped, nothing is ever re-issued across the fork, and no other
 * logic changes. Pre-existing child rows are replaced (an idempotent
 * re-fork of the same parent pair). Returns the number of flow rows
 * copied. */
export function egressFork(db: SqliteDatabase, fromSessionId: string, toSessionId: string): number {
    if (fromSessionId === toSessionId) throw new Error("egressFork: conflicting fork lineage (child equals parent)");
    return db.transaction(() => {
        const n = db
            .prepare("SELECT COUNT(*) AS c FROM eg_flow WHERE session_id = ?")
            .get(fromSessionId) as { c: number };
        if (Number(n.c) === 0) return 0; // no egress rows — nothing to copy
        db.prepare("DELETE FROM eg_state WHERE session_id = ?").run(toSessionId);
        db.prepare("DELETE FROM eg_flow WHERE session_id = ?").run(toSessionId);
        db.prepare(
            `INSERT INTO eg_flow (session_id, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at)
             SELECT ?, op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen, created_at FROM eg_flow WHERE session_id = ?`,
        ).run(toSessionId, fromSessionId);
        db.prepare(
            `INSERT INTO eg_state (session_id, rid, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes, created_at)
             SELECT ?, rid, msgid, pos, log_seq, num, ref, tokens, type, role, ts, sys_in, bytes, created_at FROM eg_state WHERE session_id = ?`,
        ).run(toSessionId, fromSessionId);
        // The usage event stream rides with the whole copy (owner ruling:
        // one usage stream per session) — idempotent re-fork: replace.
        egressUsageForkCopy(db, fromSessionId, toSessionId);
        return Number(n.c);
    });
}

/** Apply ONE flow row to a view (pure; throws EgressStateCorruptError on
 * any violation). Shared by the bulk replay (applyOps) and the walk-back
 * scan (egressFlowWalkBack). The caller owns the density check for bulk
 * replays (it spans rows); here it is the caller's loop that passes
 * `prevSeq`. */
function applyRow(sessionId: string, view: EgressViewRow[], row: FlowRow): EgressViewRow[] {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
        throw new EgressStateCorruptError(sessionId, `payload at op_seq=${row.op_seq} is not an object`);
    }
    const p: Record<string, unknown> = parsed;
    const idxOf = (rid: number): number => view.findIndex((e) => e.rid === rid);
    if (row.row_type === "I") {
        if (typeof row.msgid !== "string") throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no msgid`);
        if (typeof row.rid !== "number" || row.rid < 1) throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no row id`);
        if (idxOf(row.rid) >= 0) throw new EgressStateCorruptError(sessionId, `duplicate row id ${row.rid} at op_seq=${row.op_seq}`);
        // Renumber (2026-11-25): 0 is the system row's number (outside the
        // citation space); every real message stores >= 1.
        const isSystem = row.msgid === EGRESS_SYSTEM_MSGID;
        if (typeof row.log_seq !== "number" || (isSystem ? row.log_seq !== 0 : row.log_seq < 1)) {
            throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no canonical number`);
        }
        if (typeof p.ref !== "string" || typeof p.tokens !== "number" || typeof p.type !== "string" || typeof row.bytes !== "string") {
            throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has a malformed payload or missing bytes`);
        }
        const entry: EgressViewRow = {
            rid: row.rid,
            num: row.log_seq,
            msgid: row.msgid,
            ref: p.ref as string,
            tokens: p.tokens as number,
            type: p.type as string,
            bytes: row.bytes,
        };
        if (p.role !== undefined) entry.role = p.role as string;
        if (typeof p.ts === "number") entry.ts = p.ts;
        // `after: null` = the row goes to the FRONT — it was the first
        // row of the view the diff described (a replaced system prompt).
        // 2026-11-27: the anchor is a rid (never a msgid).
        const at = p.after == null ? -1 : typeof p.after === "number" ? idxOf(p.after) : -2;
        if (at === -2) throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has a malformed anchor`);
        if (at < 0 && p.after != null) throw new EgressStateCorruptError(sessionId, `insert anchor rid ${String(p.after)} missing at op_seq=${row.op_seq}`);
        view.splice(at + 1, 0, entry);
    } else if (row.row_type === "D") {
        if (typeof p.start !== "number" || typeof p.end !== "number") {
            throw new EgressStateCorruptError(sessionId, `delete at op_seq=${row.op_seq} has a malformed payload`);
        }
        const s = idxOf(p.start);
        const e = idxOf(p.end);
        if (s < 0) throw new EgressStateCorruptError(sessionId, `delete start rid ${p.start} missing at op_seq=${row.op_seq}`);
        if (e < 0) throw new EgressStateCorruptError(sessionId, `delete end rid ${p.end} missing at op_seq=${row.op_seq}`);
        if (s > e) throw new EgressStateCorruptError(sessionId, `delete range inverted (start after end) at op_seq=${row.op_seq}`);
        view.splice(s, e - s + 1);
    } else if (row.row_type === "U") {
        if (typeof row.rid !== "number" || row.rid < 1) {
            throw new EgressStateCorruptError(sessionId, `update at op_seq=${row.op_seq} has no row id`);
        }
        if (typeof row.msgid !== "string" || typeof row.bytes !== "string") {
            throw new EgressStateCorruptError(sessionId, `update at op_seq=${row.op_seq} has a malformed payload or missing bytes`);
        }
        const i = idxOf(row.rid);
        if (i < 0) throw new EgressStateCorruptError(sessionId, `update target rid ${row.rid} missing at op_seq=${row.op_seq}`);
        if (view[i].msgid !== row.msgid) throw new EgressStateCorruptError(sessionId, `update at op_seq=${row.op_seq}: rid ${row.rid} points at msgid ${view[i].msgid}, not ${row.msgid}`);
        view[i] = {
            ...view[i],
            bytes: row.bytes,
            ...(p.role !== undefined ? { role: p.role as string } : {}),
            ...(typeof p.num === "number" ? { num: p.num as number } : {}),
        };
    } else {
        throw new EgressStateCorruptError(sessionId, `unknown row_type ${String(row.row_type)} at op_seq=${row.op_seq}`);
    }
    return view;
}

/** Full-history replay of the flow (op_seq dense from 1 — a jump means a
 * row was lost or removed between two survivors, and every later anchor
 * would refer to a view that never existed). 7896: the latest 'G' row in
 * the prefix is the trust boundary — rows BEFORE it were written by an
 * older generation and are never judged by this code (its numbering law
 * may differ); the G snapshot IS the starting view, and density counting
 * resumes at the G row itself. Throws EgressStateCorruptError on any
 * anchor/endpoint/id violation (and on a malformed G payload). */
function applyOps(sessionId: string, rows: FlowRow[]): EgressViewRow[] {
    let boundary = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].row_type === "G") { boundary = i; break; }
    }
    let view: EgressViewRow[] = [];
    if (boundary >= 0) view = decodeGenSnapshot(sessionId, rows[boundary]);
    let prevSeq: number | null = null;
    for (let i = boundary + 1; i < rows.length; i++) {
        const row = rows[i];
        if (typeof row.op_seq !== "number" || (prevSeq !== null && row.op_seq !== prevSeq + 1)) {
            throw new EgressStateCorruptError(sessionId, `op_seq jumps from ${String(prevSeq)} to ${String(row.op_seq)}`);
        }
        prevSeq = row.op_seq;
        view = applyRow(sessionId, view, row);
    }
    return view;
}

/** The walk-back reconstruction (7773 §2: "walk-back 恢复 = 全史单趟扫找
 * 最后健康前缀"): one pass over the flow's FULL history, row by row,
 * tracking the view — the FIRST row that does not apply is the answer:
 * the healthy prefix is everything before it (a prefix that includes a
 * bad row can never replay, so the healthy points are exactly 0..k-1 for
 * a failure at row k). Equivalent to replaying every candidate prefix
 * (O(n²)) in a single O(n) pass. Returns the newest healthy NON-EMPTY
 * prefix (seq + view), or null when no non-empty healthy prefix exists
 * (corruption reaching the floor — the caller hard-fails the turn; the
 * only legitimate empty flow is a row-less session, which the try path
 * never walks back from). Non-corruption errors are rethrown (this
 * ladder's consumer DELETES rows — it must never run on a guess). */
export function egressFlowWalkBack(db: SqliteDatabase, sessionId: string): { seq: number; view: EgressViewRow[] } | null {
    const rows = db
        .prepare(
            "SELECT op_seq, log_seq, row_type, rid, msgid, payload, bytes, gen FROM eg_flow WHERE session_id = ? ORDER BY op_seq ASC",
        )
        .all(sessionId) as unknown as FlowRow[];
    // 7896 trust boundary (same rule as applyOps): when a G row exists, the
    // walk starts AFTER it (its snapshot is the starting view; the pre-G rows
    // are an older generation's and are never applied). A malformed G
    // payload is a corrupt floor (return null) — the pre-G prefix cannot be
    // replayed under any law this code knows.
    let boundary = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].row_type === "G") { boundary = i; break; }
    }
    let view: EgressViewRow[] = [];
    let prevSeq: number | null = null;
    if (boundary >= 0) {
        try {
            view = decodeGenSnapshot(sessionId, rows[boundary]);
        } catch (err) {
            if (err instanceof EgressStateCorruptError) return null;
            throw err;
        }
        prevSeq = rows[boundary].op_seq;
    }
    for (let i = boundary + 1; i < rows.length; i++) {
        const row = rows[i];
        try {
            if (typeof row.op_seq !== "number" || (prevSeq !== null && row.op_seq !== prevSeq + 1)) {
                throw new EgressStateCorruptError(sessionId, `op_seq jumps from ${String(prevSeq)} to ${String(row.op_seq)}`);
            }
            prevSeq = row.op_seq;
            view = applyRow(sessionId, view, row);
        } catch (err) {
            if (!(err instanceof EgressStateCorruptError)) throw err;
            // Row i does not apply: the newest healthy prefix ends at i-1.
            if (i > boundary && view.length > 0) {
                return { seq: rows[i - 1].op_seq, view };
            }
            return null;
        }
    }
    return view.length > 0 ? { seq: rows[rows.length - 1].op_seq, view } : null;
}
