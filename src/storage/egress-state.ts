/**
 * Egress state log — the op-log view of the outbound conversation
 * (proposal: discussions/7398 + the revised design in discussions/7439,
 * owner rulings 2026-11-20/21; #6785 perf work).
 *
 * The outbound view changes sparsely: tail appends, occasional content edits
 * (same msgid, new content), fold ranges replaced by one summary row. Instead
 * of recomputing the whole view every turn (render/convert/serialize over all
 * messages), the view is a TOTAL-ORDERED op log per session; replaying the
 * log yields exactly one deterministic view.
 *
 * SELF-CONTAINED BYTES (owner ruling, discussion 7439 裁定 1): every I/U row
 * carries the message's FINAL core JSON in its own `bytes` column — no hash
 * references, no fingerprint fields, no global content table. Content
 * identity is judged by DIRECT BYTE EQUALITY; replay needs nothing but this
 * pair of tables. The two tables are not shipped in any release yet, so the
 * row/payload format is free (no migration burden).
 *
 * TWO SEPARATE SEQUENCES (ruling 7439 裁定, canonical message number):
 *   op_seq  — row-ordering key, assigned to EVERY row (B/I/D/U). Primary key
 *             (session_id, op_seq); all ordering / watermark / truncate
 *             semantics run on op_seq.
 *   log_seq — the CANONICAL MESSAGE NUMBER: set ONLY on I rows (one number
 *             per message, session-scoped, never re-issued — the high-water
 *             includes retired messages). U/D/B rows carry NULL: an update or
 *             a deletion occupies no new number. A fork copies BOTH tables
 *             wholesale to the new session_id (egressFork) — the child
 *             inherits the parent's full number space and its retired marks,
 *             so the child's next number continues where the parent stopped.
 *             **Renumber (2026-11-25, egress-plane.md §10): log_seq IS the
 *             kernel citation number** — the model-facing mNNNNN (kernel
 *             space) is m + log_seq, one number, not two. I ops may carry an
 *             explicit `num` (the kernel's ledger number for that msgid, read
 *             at record time); the dense high-water+1 counter survives only
 *             as the fallback for a row whose id has no ledger entry. The
 *             constant system row is number 0 — OUTSIDE the citation space
 *             (which starts at 1), so "the system prompt does not take a
 *             message ref" is true by construction; 0 is valid only on the
 *             egress-system msgid, every other row must carry >= 1.
 *
 * Two tables (dual-table, owner ruling):
 *   egress_state  — what serving reads; compaction PHYSICALLY deletes rows
 *                   below the watermark, so it stays bounded;
 *   egress_flow   — the record: rows are never rewritten. A compaction also
 *                   removes, here, the rows its new base row subsumes
 *                   (#7574: until then every compaction left one more full
 *                   copy of the view behind and this table grew without
 *                   bound), so it reconstructs every op_seq at or above the
 *                   newest base. Rollback below the newest base is gone —
 *                   nothing needs it (rollback is based on this table, not
 *                   on client resends).
 *
 * The flow is the record and the state is only its bounded serving copy
 * (#7574): every state row has an identical twin in the flow. A state table
 * that does not replay, or that disagrees with the flow, is rebuilt from the
 * flow (egressStateRead). Only a flow that does not replay is corruption.
 *
 * Row types (payload shapes are the contract — see the discussion post):
 *   B  base            msgid NULL      {"entries": viewRow[], watermark}
 *                                       (entries carry the bytes AND the
 *                                       canonical numbers inline)
 *   I  insert          msgid required  {"after": msgid|null, ref, tokens,
 *                                       type, role?} + bytes column;
 *                                       log_seq column = the canonical
 *                                       number
 *   D  delete-range    msgid NULL      {"start": msgid, "end": msgid}  inclusive
 *   U  update-content  msgid required  {"role"?} + bytes column (the new
 *                                       bytes; detected by byte inequality)
 *
 * Anchors are MSGIDS, never display positions — positions shift under other
 * ops, msgids do not (KDD#11: content may change, msgid does not). Any
 * anchor/endpoint violation, missing update target, or duplicate msgid is a
 * HARD ERROR: the session is corrupt and the caller degrades per the
 * degrade ladder (no fuzzy guessing — same discipline as every other lane's
 * "any doubt, fall back whole-turn" rule).
 */

import type { SqliteDatabase } from "./driver.js";
import { log as loggerLog } from "../logger.js";

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
 * the content; a system change is a +U carrying the new bytes). Renumber
 * (2026-11-25): the system row is canonical number 0 — outside the citation
 * space, so it can never claim m00001. Defined HERE (the low layer) so the
 * replay validation can name it without importing egress-record (which
 * imports this module). */
export const EGRESS_SYSTEM_MSGID = "egress-system";

/** One row of the current view. The ref (mNNNNN) is the kernel-space
 * display identity, never hash and never re-issued (kernel contract).
 * `num` is the canonical session-scoped message number (ruling 7439): real
 * rows always carry num >= 1 — EXCEPT the system row, which carries 0 by
 * construction (renumber 2026-11-25: the citation space starts at 1; the
 * system row is bookkeeping, not a message). An in-process row built before
 * its I row is appended may carry 0 (unnumbered) for a REAL message and is
 * stamped by the replay at record time — a real message must never STORE a
 * 0. `bytes` is the message's FINAL core JSON (post reasoning-drop /
 * image-rescale, pre outbound convert); for the system row it is the
 * system text itself. The row is self-contained: replay + serve need
 * nothing beyond this pair of tables. */
export interface EgressViewRow {
    /** Canonical session-scoped message number (0 = not numbered yet). */
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
     *  so the I row IS the first observation; spine rows inherit it. Optional:
     *  pre-#7577 dev rows (the tables never shipped) lack it. */
    ts?: number;
}

type EgressOpType = "B" | "I" | "D" | "U";

interface EgressStateRow {
    op_seq: number;
    log_seq: number | null;
    row_type: EgressOpType;
    msgid: string | null;
    payload: string;
    bytes: string | null;
}

const INSERT_STATE = `INSERT INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_FLOW = `INSERT INTO egress_flow (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/** The canonical message frontier: the highest number ever ISSUED
 * (retired messages included — I rows only advance it, B/D/U never do).
 * MAX(log_seq) over the flow rows is the fast answer, but a compaction
 * physically removes the I rows its newest base subsumes (#7574), so the
 * moment right after a fold the flow can hold a base row ONLY — the
 * high-water then lives in the base payload (entries' inline numbers and
 * the explicit highWater field). Callers reading the frontier OUTSIDE the
 * append transaction must go through this fallback; the next append's
 * validation replay reports an unreadable base. */
export function egressMessageHighWater(db: SqliteDatabase, sessionId: string): number {
    const row = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o, COALESCE(MAX(log_seq), 0) AS n FROM egress_flow WHERE session_id = ?")
        .get(sessionId) as { o: number; n: number } | undefined;
    const head = Number(row?.o) || 0;
    let high = Number(row?.n) || 0;
    if (high === 0 && head > 0) {
        // No I row is left above the newest base (a compaction removes the
        // rows it subsumes, retired ones included), so MAX(log_seq) no
        // longer sees the highest number ever issued. The base carries it.
        const base = db
            .prepare("SELECT payload FROM egress_flow WHERE session_id = ? AND row_type = 'B' ORDER BY op_seq DESC LIMIT 1")
            .get(sessionId) as { payload: string } | undefined;
        if (base !== undefined) {
            try {
                const parsed = JSON.parse(base.payload) as { entries?: unknown; highWater?: unknown };
                const entries = Array.isArray(parsed.entries) ? (parsed.entries as EgressViewRow[]) : [];
                high = Math.max(
                    typeof parsed.highWater === "number" ? parsed.highWater : 0,
                    egressViewHighWater(entries),
                );
            } catch {
                // An unreadable base is reported by the validation replay of
                // the append that got here.
            }
        }
    }
    return high;
}

function nextSeqs(db: SqliteDatabase, sessionId: string): { opSeq: number; num: number } {
    // egress_flow is the record and a superset of egress_state after every
    // compaction, so the flow maxima ARE the session's high-waters: the
    // op_seq ordering cursor and the canonical message-number cursor (I
    // rows only — B/D/U carry NULL and never advance it).
    // #7577 (owner ruling 2026-11-24): DUAL CLOCKS — the block lifecycle log
    // numbers itself (egress_block_flow.op_seq dense within its own table,
    // see egress-block.ts); its rows carry flow_op_seq as a POINTER to this
    // clock (flow's MAX at write time) for cross-table alignment at point
    // forks. The flow table keeps its exclusive number pool: the op_seq and
    // log_seq cursors are egress_flow-only, and its density invariant
    // (#7574) stays intact regardless of what the block table does.
    //
    // #7574: must be read INSIDE the append transaction, never before it.
    const row = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o FROM egress_flow WHERE session_id = ?")
        .get(sessionId) as { o: number } | undefined;
    const head = Number(row?.o) || 0;
    return { opSeq: head + 1, num: egressMessageHighWater(db, sessionId) + 1 };
}

interface InsertOp {
    type: "I";
    msgid: string;
    after: string | null;
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
    start: string;
    end: string;
}
interface UpdateOp {
    type: "U";
    msgid: string;
    bytes: string;
    role?: string;
    /** System row only: the new client raw system text (see InsertOp). */
    sysIn?: string;
}
export type EgressOp = InsertOp | DeleteOp | UpdateOp;

/** Highest canonical number used by the view (retired rows are gone from
 * the view but their numbers live on — the append advances past the stored
 * high-water, which includes them). */
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
 * read from the flow, which includes numbers of rows a compaction retired
 * from the view. */
export function egressReplay(prev: EgressViewRow[], ops: EgressOp[], startHigh?: number, sessionId = "diff"): EgressViewRow[] {
    const view: EgressViewRow[] = prev.map((r) => ({ ...r }));
    const idxOf = (msgid: string): number => view.findIndex((r) => r.msgid === msgid);
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
    let maxCited = 0;
    for (const op of ops) if (op.type === "I" && op.msgid !== EGRESS_SYSTEM_MSGID && typeof op.num === "number" && op.num > 0) maxCited = Math.max(maxCited, op.num);
    for (const op of ops) {
        if (op.type === "I") {
            if (idxOf(op.msgid) >= 0) throw new EgressStateCorruptError(sessionId, `duplicate msgid ${op.msgid}`);
            // `after: null` = the first row of the new view → the front.
            // #7574: idxOf answers -1 for a missing anchor, so the old
            // `at < -1` test could never fire and a missing anchor inserted
            // the row at index 0 in silence.
            const at = op.after === null ? -1 : idxOf(op.after);
            if (at === -1 && op.after !== null) throw new EgressStateCorruptError(sessionId, `insert anchor ${op.after} missing`);
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
            const entry: EgressViewRow = { num: assign, msgid: op.msgid, ref: op.ref, tokens: op.tokens, type: op.typeTag, bytes: op.bytes };
            if (op.role !== undefined) entry.role = op.role;
            if (op.ts !== undefined) entry.ts = op.ts;
            view.splice(at + 1, 0, entry);
        } else if (op.type === "D") {
            const s = idxOf(op.start);
            const e = idxOf(op.end);
            if (s < 0) throw new EgressStateCorruptError(sessionId, `delete start ${op.start} missing`);
            if (e < 0) throw new EgressStateCorruptError(sessionId, `delete end ${op.end} missing`);
            if (s > e) throw new EgressStateCorruptError(sessionId, "delete range inverted");
            for (let i = s; i <= e; i++) {
                const r = view[i];
                if (r !== undefined && r.num > 0) liveNums.delete(r.num);
            }
            view.splice(s, e - s + 1);
        } else {
            const i = idxOf(op.msgid);
            if (i < 0) throw new EgressStateCorruptError(sessionId, `update target ${op.msgid} missing`);
            view[i] = { ...view[i], bytes: op.bytes, ...(op.role !== undefined ? { role: op.role } : {}) };
        }
    }
    return view;
}

/** Deterministic diff between two consecutive views (owner design, 4 upper
 * cases: tail append / nudge appear+vanish / fold replace / content edit).
 * The diff keys on msgid + bytes only — `num` is never an input (it is
 * assigned at append/replay time; an in-process `next` may carry 0s).
 *
 * Spine = a monotonically increasing subsequence of `next` whose msgids
 * appear in `prev` (greedy pointer scan, O(n+m); any monotone sub-spine
 * replays equivalently, the greedy one is what this implementation picks).
 * Spine rows with CHANGED BYTES (direct inequality — no hash) emit +U;
 * everything else emits -D (maximal contiguous runs in PREV order) plus +I
 * in NEXT order with the preceding row as anchor. egressReplay(prev, diff)
 * always reproduces `next` exactly (modulo the stamp-only num field).
 *
 * Moves (same msgid, new position) are deliberately expressed as D+I — there
 * is no M op; the msgid stays the identity through both ops, and the NEW
 * number the D+I assigns is the message's number from then on (the old
 * number stays retired — never re-issued). */
export function diffEgressView(prev: EgressViewRow[], next: EgressViewRow[]): EgressOp[] {
    const prevIdx = new Map<string, number>();
    prev.forEach((r, i) => { if (!prevIdx.has(r.msgid)) prevIdx.set(r.msgid, i); });
    const prevByMsg = new Map<string, EgressViewRow>();
    prev.forEach((r) => { if (!prevByMsg.has(r.msgid)) prevByMsg.set(r.msgid, r); });
    const spine = new Set<string>();
    let p = -1;
    for (const r of next) {
        const i = prevIdx.get(r.msgid);
        if (i !== undefined && i > p) {
            spine.add(r.msgid);
            p = i;
        }
    }
    const ops: EgressOp[] = [];
    let runStart: string | null = null;
    let runEnd: string | null = null;
    for (const r of prev) {
        if (!spine.has(r.msgid)) {
            if (runStart === null) runStart = r.msgid;
            runEnd = r.msgid;
        } else if (runStart !== null) {
            ops.push({ type: "D", start: runStart, end: runEnd! });
            runStart = runEnd = null;
        }
    }
    if (runStart !== null) ops.push({ type: "D", start: runStart, end: runEnd! });
    for (const r of next) {
        if (spine.has(r.msgid)) {
            const old = prevByMsg.get(r.msgid)!;
            if (old.bytes !== r.bytes) {
                const u: UpdateOp = { type: "U", msgid: r.msgid, bytes: r.bytes };
                if (r.role !== undefined) u.role = r.role;
                ops.push(u);
            }
        }
    }
    let last: string | null = null;
    for (const r of next) {
        if (!spine.has(r.msgid)) {
            const ins: InsertOp = { type: "I", msgid: r.msgid, after: last, ref: r.ref, tokens: r.tokens, typeTag: r.type, bytes: r.bytes };
            if (r.role !== undefined) ins.role = r.role;
            // Renumber (2026-11-25): a next-view row may already carry its
            // kernel citation number (recordEgressTurn stamps it from the
            // refs ledger); the I op preserves it.
            if (typeof r.num === "number" && r.num > 0) ins.num = r.num;
            ops.push(ins);
        }
        last = r.msgid;
    }
    return ops;
}

/** Write one op as a twin pair (state row + flow row). */
function writeOp(db: SqliteDatabase, sessionId: string, opSeq: number, logSeq: number | null, rowType: EgressOpType, msgid: string | null, payload: string, bytes: string | null, nowMs: number): void {
    db.prepare(INSERT_STATE).run(sessionId, opSeq, logSeq, rowType, msgid, payload, bytes, nowMs);
    db.prepare(INSERT_FLOW).run(sessionId, opSeq, logSeq, rowType, msgid, payload, bytes, nowMs);
}

/** Write a batch of ops as twin pairs. Every op gets the next op_seq; each I
 * op ALSO gets its canonical number — the kernel citation number when the op
 * carries an explicit `num` (renumber 2026-11-25), the dense high-water+1
 * fallback otherwise (the cursor starts past every number ever issued,
 * retired ones included) — D/U ops occupy op_seq slots but no numbers.
 * The system row (no citation) stores log_seq 0. The caller has already
 * validated the batch against the log as it is. */
function writeOps(db: SqliteDatabase, sessionId: string, ops: EgressOp[], firstOpSeq: number, firstNum: number, nowMs: number): void {
    let num = firstNum - 1;
    // Mirror egressReplay exactly (it already validated the batch): the
    // dense fallback for an uncited row lands ABOVE every number the batch
    // cites, and a cited row below the cursor is legal when its slot is
    // retired (fold re-homing).
    let maxCited = 0;
    for (const op of ops) if (op.type === "I" && op.msgid !== EGRESS_SYSTEM_MSGID && typeof op.num === "number" && op.num > 0) maxCited = Math.max(maxCited, op.num);
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
            writeOp(db, sessionId, opSeq, logSeq, "I", op.msgid, JSON.stringify(payload), op.bytes, nowMs);
        } else if (op.type === "D") {
            writeOp(db, sessionId, opSeq, null, "D", null, JSON.stringify({ start: op.start, end: op.end }), null, nowMs);
        } else {
            const payload: Record<string, unknown> = { role: op.role };
            if (op.sysIn !== undefined) payload["sysIn"] = op.sysIn;
            writeOp(db, sessionId, opSeq, null, "U", op.msgid, JSON.stringify(payload), op.bytes, nowMs);
        }
    }
}

/** Persist a replayed view as the new base row in BOTH tables, then delete
 * in BOTH tables every row below it. The base carries the entries themselves
 * (bytes AND canonical numbers inline in the payload) and `highWater`, the
 * highest canonical number ever issued in this session: once the rows below
 * the base are gone it is the only place that number survives, and without
 * it the next insert would re-issue it. Base + later ops must reproduce the
 * current view WITHOUT any deleted row (that is the only constraint the
 * base form has). Runs inside the caller's transaction. */
function writeBase(db: SqliteDatabase, sessionId: string, view: EgressViewRow[], highWater: number, nowMs: number): number {
    for (const e of view) {
        // Renumber (2026-11-25): the system row carries 0; every real row >= 1.
        if (typeof e.num !== "number" || (e.msgid === EGRESS_SYSTEM_MSGID ? e.num !== 0 : e.num < 1)) {
            throw new EgressStateCorruptError(sessionId, `compact base entry ${e.msgid} has no canonical number`);
        }
    }
    const seq = nextSeqs(db, sessionId).opSeq;
    const payload = JSON.stringify({ entries: view, watermark: seq, highWater });
    writeOp(db, sessionId, seq, null, "B", null, payload, null, nowMs);
    db.prepare("DELETE FROM egress_state WHERE session_id = ? AND op_seq < ?").run(sessionId, seq);
    db.prepare("DELETE FROM egress_flow WHERE session_id = ? AND op_seq < ?").run(sessionId, seq);
    return seq;
}

function hasDelete(ops: EgressOp[]): boolean {
    for (const op of ops) if (op.type === "D") return true;
    return false;
}

/** Append a batch of ops to BOTH tables (state + flow) in ONE transaction.
 * #7574: the batch is replayed against the log as it is inside that
 * transaction BEFORE anything is written — an op whose anchor or target is
 * not there is refused (EgressStateCorruptError) instead of being stored as
 * the row that breaks every later read. Returns the assigned op_seqs in
 * input order. `egressAppendTurn` is the turn-taking append the lanes use. */
export function egressStateAppend(
    db: SqliteDatabase,
    sessionId: string,
    ops: EgressOp[],
    nowMs: number,
): number[] {
    if (ops.length === 0) return [];
    return db.transaction(() => {
        const seqs = nextSeqs(db, sessionId);
        egressReplay(applyOps(sessionId, readStateRows(db, sessionId)), ops, seqs.num - 1, sessionId);
        writeOps(db, sessionId, ops, seqs.opSeq, seqs.num, nowMs);
        return Array.from({ length: ops.length }, (_, i) => seqs.opSeq + i);
    });
}

/** Record one turn: ONE transaction (BEGIN IMMEDIATE) that
 *   1. reads the log's cursors,
 *   2. refuses the batch when the log moved since the caller read its
 *      starting point (`guard.baseSeq` = the op_seq the caller's view was at)
 *      — EgressConcurrentWriteError, nothing written;
 *   3. replays the batch on the log as it is now (refuses a broken batch),
 *   4. writes it to both tables,
 *   5. and, for a batch that deletes rows, compacts in the SAME step
 *      (the base is the view this batch produced — never a view another
 *      turn has moved on from).
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
        const stamped = egressReplay(applyOps(sessionId, readStateRows(db, sessionId)), ops, seqs.num - 1, sessionId);
        writeOps(db, sessionId, ops, seqs.opSeq, seqs.num, nowMs);
        if (hasDelete(ops)) {
            writeBase(db, sessionId, stamped, Math.max(seqs.num - 1, egressViewHighWater(stamped)), nowMs);
        }
        return stamped;
    });
}

/** Replay the STATE table into the current view (ordered by op_seq) —
 * the raw read, with no flow comparison (tests use it to prove that a
 * damaged table really is reported). Serving goes through
 * `egressStateRead`. An I
 * row's view num IS its log_seq column (validated); B entries carry their
 * numbers in the payload. Throws EgressStateCorruptError on any
 * anchor/endpoint/id violation — the caller degrades per the degrade ladder. */
export function egressStateView(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    return applyOps(sessionId, readStateRows(db, sessionId));
}

/** Replay the FLOW table up to (and including) op_seq x — the rollback
 * reconstruction (degrade ladder step 2). The latest B row with
 * op_seq <= x is the starting point; ops after it up to x are applied.
 * Throws like egressStateView. */
export function egressStateAt(db: SqliteDatabase, sessionId: string, x: number): EgressViewRow[] {
    const rows = db
        .prepare(
            "SELECT op_seq, log_seq, row_type, msgid, payload, bytes FROM egress_flow WHERE session_id = ? AND op_seq <= ? ORDER BY op_seq ASC",
        )
        .all(sessionId, x) as unknown as EgressStateRow[];
    return applyOps(sessionId, rows);
}

function readStateRows(db: SqliteDatabase, sessionId: string): EgressStateRow[] {
    return db
        .prepare(
            "SELECT op_seq, log_seq, row_type, msgid, payload, bytes FROM egress_state WHERE session_id = ? ORDER BY op_seq ASC",
        )
        .all(sessionId) as unknown as EgressStateRow[];
}

/** Standalone compaction (kept for tests and tools; a recorded turn
 * compacts inside `egressAppendTurn`). One transaction. Throws if any
 * entry is unnumbered (a programming error — the stamped replay view is
 * the only input that may reach here). Returns the base row's op_seq. */
export function egressStateCompact(
    db: SqliteDatabase,
    sessionId: string,
    view: EgressViewRow[],
    nowMs: number,
): number {
    return db.transaction(() => {
        const { num } = nextSeqs(db, sessionId);
        return writeBase(db, sessionId, view, Math.max(num - 1, egressViewHighWater(view)), nowMs);
    });
}

/** op_seq of the newest base row in the flow (0 = the session has none). */
export function egressStateBaseSeq(db: SqliteDatabase, sessionId: string): number {
    const row = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS m FROM egress_flow WHERE session_id = ? AND row_type = 'B'")
        .get(sessionId) as { m: number } | undefined;
    return Number(row?.m) || 0;
}

/** #7574: the state table is only the bounded serving copy of the flow, so
 * the two must agree: same head op_seq, and every row of the state has an
 * identical twin in the flow. Runs inside the caller's read transaction (one
 * snapshot — otherwise a writer committing between the statements would look
 * like a disagreement). Throws EgressStateCorruptError. */
function assertStateTwinOfFlow(db: SqliteDatabase, sessionId: string): void {
    const headOf = (table: "egress_state" | "egress_flow"): number => {
        const row = db.prepare(`SELECT COALESCE(MAX(op_seq), 0) AS m FROM ${table} WHERE session_id = ?`).get(sessionId) as { m: number };
        return Number(row.m);
    };
    const stateHead = headOf("egress_state");
    const flowHead = headOf("egress_flow");
    if (stateHead !== flowHead) {
        throw new EgressStateCorruptError(sessionId, `state ends at op_seq ${stateHead} but the log ends at op_seq ${flowHead}`);
    }
    const stray = db
        .prepare(
            `SELECT COUNT(*) AS c FROM egress_state s
               LEFT JOIN egress_flow f ON f.session_id = s.session_id AND f.op_seq = s.op_seq
              WHERE s.session_id = ?
                AND (f.op_seq IS NULL OR f.row_type <> s.row_type OR f.msgid IS NOT s.msgid OR f.log_seq IS NOT s.log_seq
                     OR f.payload <> s.payload OR f.bytes IS NOT s.bytes)`,
        )
        .get(sessionId) as { c: number };
    if (Number(stray.c) > 0) {
        throw new EgressStateCorruptError(sessionId, `${Number(stray.c)} state row(s) differ from their twin in the log`);
    }
}

/** Replace the session's state rows with an exact copy of its flow rows.
 * ONE transaction; the flow is replayed FIRST, so a flow that does not
 * replay throws EgressStateCorruptError before anything is written (this
 * repairs a damaged COPY, it cannot repair the record). Returns the view. */
export function egressRebuildState(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    return db.transaction(() => {
        const view = applyOps(
            sessionId,
            db
                .prepare(
                    "SELECT op_seq, log_seq, row_type, msgid, payload, bytes FROM egress_flow WHERE session_id = ? ORDER BY op_seq ASC",
                )
                .all(sessionId) as unknown as EgressStateRow[],
        );
        db.prepare("DELETE FROM egress_state WHERE session_id = ?").run(sessionId);
        db.prepare(
            `INSERT INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at)
             SELECT session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at FROM egress_flow WHERE session_id = ?`,
        ).run(sessionId);
        return view;
    });
}

/** The serving read (#7574). Replays the state table and checks that it is
 * still the flow's twin, in one read transaction. When only the COPY is
 * damaged — it does not replay, or it disagrees with the log — it is rebuilt
 * from the flow and the view is served normally: a derived table can never
 * cost a turn. Only a flow that does not replay throws
 * EgressStateCorruptError (the caller degrades per the degrade ladder). */
export function egressStateRead(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    let damage: EgressStateCorruptError | null = null;
    const view = db.readTransaction(() => {
        try {
            const v = applyOps(sessionId, readStateRows(db, sessionId));
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
    loggerLog("warn", `[storage] egress session=${sessionId}: the serving copy did not match the log (${damage!.reason}) — copied again from the log (${rebuilt.length} rows)`);
    return rebuilt;
}

/** Fork (ruling 7439 裁定 B): copy the parent's ENTIRE op log — BOTH
 * tables, every row (including retired-history in the flow) — to the child
 * session_id inside ONE transaction. op_seq/log_seq are preserved verbatim,
 * so the child inherits the parent's full canonical number space and retired
 * marks: its next number continues where the parent stopped, nothing is
 * ever re-issued across the fork, and no other logic changes. Pre-existing
 * child rows are replaced (an idempotent re-fork of the same parent pair).
 * Returns the number of rows copied. */
export function egressFork(db: SqliteDatabase, fromSessionId: string, toSessionId: string): number {
    if (fromSessionId === toSessionId) throw new Error("egressFork: conflicting fork lineage (child equals parent)");
    return db.transaction(() => {
        const n = db
            .prepare("SELECT COUNT(*) AS c FROM egress_flow WHERE session_id = ?")
            .get(fromSessionId) as { c: number };
        if (Number(n.c) === 0) return 0; // no egress rows — nothing to copy
        db.prepare("DELETE FROM egress_state WHERE session_id = ?").run(toSessionId);
        db.prepare("DELETE FROM egress_flow WHERE session_id = ?").run(toSessionId);
        db.prepare(
            `INSERT INTO egress_state (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at)
             SELECT ?, op_seq, log_seq, row_type, msgid, payload, bytes, created_at FROM egress_state WHERE session_id = ?`,
        ).run(toSessionId, fromSessionId);
        db.prepare(
            `INSERT INTO egress_flow (session_id, op_seq, log_seq, row_type, msgid, payload, bytes, created_at)
             SELECT ?, op_seq, log_seq, row_type, msgid, payload, bytes, created_at FROM egress_flow WHERE session_id = ?`,
        ).run(toSessionId, fromSessionId);
        return Number(n.c);
    });
}

function applyOps(sessionId: string, rows: EgressStateRow[]): EgressViewRow[] {
    let view: EgressViewRow[] = [];
    let prevSeq: number | null = null;
    for (const row of rows) {
        if (typeof row.op_seq !== "number" || (prevSeq !== null && row.op_seq !== prevSeq + 1)) {
            // #7574: op_seq is dense. A jump means a row was lost or removed
            // between two survivors — every later anchor then refers to a
            // view that never existed.
            throw new EgressStateCorruptError(sessionId, `op_seq jumps from ${String(prevSeq)} to ${String(row.op_seq)}`);
        }
        prevSeq = row.op_seq;
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(row.payload) as Record<string, unknown>;
        } catch {
            throw new EgressStateCorruptError(sessionId, `payload at op_seq=${row.op_seq} is not an object`);
        }
        const p: Record<string, unknown> = parsed;
        if (row.row_type === "B") {
            const entries = Array.isArray(p.entries) ? (p.entries as EgressViewRow[]) : null;
            if (!entries) throw new EgressStateCorruptError(sessionId, `base at op_seq=${row.op_seq} has no entries`);
            view = entries.map((e) => ({ ...e }));
            const seen = new Set<string>();
            for (const e of view) {
                if (seen.has(e.msgid)) throw new EgressStateCorruptError(sessionId, `duplicate msgid ${e.msgid} in base at op_seq=${row.op_seq}`);
                seen.add(e.msgid);
            }
            for (const e of view) {
                const shapeOk = typeof e.msgid === "string" && typeof e.ref === "string" && typeof e.bytes === "string" && typeof e.num === "number";
                const numOk = e.msgid === EGRESS_SYSTEM_MSGID ? e.num === 0 : e.num >= 1;
                if (!shapeOk || !numOk) throw new EgressStateCorruptError(sessionId, `base at op_seq=${row.op_seq} has malformed entries`);
            }
            continue;
        }
        const idxOf = (msgid: string): number => view.findIndex((e) => e.msgid === msgid);
        if (row.row_type === "I") {
            if (typeof row.msgid !== "string") throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no msgid`);
            // Renumber (2026-11-25): 0 is the system row's number (outside
            // the citation space); every real message stores >= 1.
            const isSystem = row.msgid === EGRESS_SYSTEM_MSGID;
            if (typeof row.log_seq !== "number" || (row.log_seq < (isSystem ? 0 : 1) || (isSystem && row.log_seq !== 0))) throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no canonical number`);
            if (idxOf(row.msgid) >= 0) throw new EgressStateCorruptError(sessionId, `duplicate msgid ${row.msgid} at op_seq=${row.op_seq}`);
            if (typeof p.ref !== "string" || typeof p.tokens !== "number" || typeof p.type !== "string" || typeof row.bytes !== "string") {
                throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has a malformed payload or missing bytes`);
            }
            const entry: EgressViewRow = {
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
            // #7574: this replay used to append it at the end, so the stored
            // view disagreed with the diff replay that validated the batch.
            const at = p.after == null ? -1 : typeof p.after === "string" ? idxOf(p.after) : -2;
            if (at === -2) throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has a malformed anchor`);
            if (at < 0 && p.after != null) throw new EgressStateCorruptError(sessionId, `insert anchor ${String(p.after)} missing at op_seq=${row.op_seq}`);
            view.splice(at + 1, 0, entry);
        } else if (row.row_type === "D") {
            if (typeof p.start !== "string" || typeof p.end !== "string") {
                throw new EgressStateCorruptError(sessionId, `delete at op_seq=${row.op_seq} has a malformed payload`);
            }
            const s = idxOf(p.start);
            const e = idxOf(p.end);
            if (s < 0) throw new EgressStateCorruptError(sessionId, `delete start ${p.start} missing at op_seq=${row.op_seq}`);
            if (e < 0) throw new EgressStateCorruptError(sessionId, `delete end ${p.end} missing at op_seq=${row.op_seq}`);
            if (s > e) throw new EgressStateCorruptError(sessionId, `delete range inverted (start after end) at op_seq=${row.op_seq}`);
            view.splice(s, e - s + 1);
        } else if (row.row_type === "U") {
            if (typeof row.msgid !== "string" || typeof row.bytes !== "string") {
                throw new EgressStateCorruptError(sessionId, `update at op_seq=${row.op_seq} has a malformed payload or missing bytes`);
            }
            const i = idxOf(row.msgid);
            if (i < 0) throw new EgressStateCorruptError(sessionId, `update target ${row.msgid} missing at op_seq=${row.op_seq}`);
            view[i] = {
                ...view[i],
                bytes: row.bytes,
                ...(p.role !== undefined ? { role: p.role as string } : {}),
            };
        } else {
            throw new EgressStateCorruptError(sessionId, `unknown row_type ${String(row.row_type)} at op_seq=${row.op_seq}`);
        }
    }
    return view;
}
