/**
 * Egress state log — the canonical history (flow) and the materialized live
 * view (state) of the outbound conversation.
 *
 * Proposal: discussions/7398, revised design discussions/7439, and the
 * 2026-11-26 RE-ADJUDICATION discussions/7773 (owner ruling — the row
 * alphabet is I/U/D; the B base row never existed in the ruling and is
 * removed everywhere: not written, not read, no letter, no DDL CHECK).
 *
 * THE ROW ALPHABET (7773 §2, addressing re-ruled 2026-11-27; numbering
 * re-ruled 2026-11-28 — the rid IS the message number, see RID BELOW):
 *   I  insert          msgid required  {"after": rid|null, tokens,
 *                                       type, role?} + bytes column;
 *                                       rid column = the self-issued row id
 *                                       — and since 2026-11-28 also THE
 *                                       session's message number (the model
 *                                       sees "m" + rid, derived at render
 *                                       time, never stored)
 *   U  update-after    msgid required  {"role"?} + bytes column (the NEW
 *                                       bytes; detected by byte inequality);
 *                                       rid column = the target row's rid.
 *                                       U NEVER carries a number — the rid
 *                                       is one-shot, nothing renumbers it.
 *   D  delete-range    msgid NULL      {"start": rid, "end": rid}
 *                                       inclusive view-order range
 * There is no -U letter: the flow is never pruned, so a before-image is
 * always derivable from the rid's earlier I/U rows.
 *
 * RID — THE SOLE MESSAGE NUMBER (owner ruling 2026-11-28, proposal
 * discussions/7903): every log address is the self-issued `rid`, NEVER the
 * msgid, and the rid IS the message's number. The msgid is the CLIENT-
 * facing identity (pin channel, kernel refs) — a content-hash mint on the
 * proxy side, collidable in principle, and ambiguous across D/I churn. The
 * rid is dense per session (1, 2, 3, …), issued at I from the flow's
 * MAX(rid) + 1 (the flow is append-only and physically never deleted, so
 * the frontier always sees every rid ever issued), and NEVER re-issued:
 * a D retires the rid forever, an I takes a fresh one. There is no second
 * number axis: the old `num` / `log_seq` citation machinery (a kernel
 * ledger could re-cite a row to a different number, which collided with a
 * live row's number and deadlocked the whole op log — the 2026-11-28
 * incident, two real sessions) is GONE. The model-visible tag is derived:
 * "m" + rid at render time, and the kernel's refs ledger is rebuilt from
 * the flow (rebuildEgressKstateOverlay), so every consumer lines up on
 * the rid by construction. `op_seq` survives ONLY as the flow's page
 * cursor (op ordering + the concurrent-write CAS) — it numbers operations,
 * never messages, and the model never sees it.
 *
 * THE TWO TABLES (7773 §2):
 *   egress_flow  — the record: EVERY I/U/D op in order, append-only,
 *                  physically NEVER deleted. Growth optimization is a
 *                  separate, deferred project (#7475 family) — nothing
 *                  here ever prunes it.
 *   egress_state — the MATERIALIZED live view: one row per live message
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
 * THE STATE ROW (2026-11-28): egress_state carries NO number columns at
 * all — the rid IS the number (its primary key, next to session_id), the
 * model-visible tag is "m" + rid derived at render, and the row's
 * position anchor (the "after" rid of its I op) lives in the flow's
 * payload, where the replay reads it from. What the state keeps: msgid
 * (client-facing identity, pin channel), pos (view order), and the row
 * content (tokens/type/role/ts/sys_in/bytes).
 *
 * NO MIGRATION (owner ruling 2026-11-28): the old columns (state.num /
 * state.ref / state.log_seq / flow.log_seq) and the old payload keys
 * (num, ref) simply stop being written or read — the tables are addressed
 * by explicit column lists only, and the state is a materialized view of
 * the flow anyway (a stale state rebuilds from the flow). Pre-existing
 * number space is retired: model-visible tags of old sessions re-derive
 * from their rids, conversation content is untouched.
 *
 * INTEGRITY (ruling 7439 裁定 5 ladder, re-pointed at 7773's data sources):
 * after materialization state and flow are no longer byte twins row-for-
 * row (a U edits the state in place), so the serving read checks
 * STRUCTURAL invariants, cheaply:
 *   - the state's pos sequence is dense 0..n-1;
 *   - every state row has its I twin in the flow (same rid — rids are
 *     one-shot, so rid alone identifies the I row; 2026-11-28);
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

/** One row of the current view. The rid IS the message number (2026-11-28
 * owner ruling — see module header): the model-visible tag is "m" + rid,
 * derived at render time and never stored. `bytes` is the message's FINAL
 * core JSON (post reasoning-drop / image-rescale, pre outbound convert);
 * for the system row it is the system text itself. The row is
 * self-contained: replay + serve need nothing beyond the flow table. */
export interface EgressViewRow {
    /** Self-issued row id — and THE message number (dense per session,
     *  one-shot, never re-issued; the log's addressing key AND the kernel
     *  citation space, 2026-11-28 owner ruling). Absent only on
     *  client-built diff inputs (buildEgressViewRows) — diffEgressView
     *  allocates it for every row that enters the log. */
    rid?: number;
    msgid: string;
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

interface FlowRow {
    op_seq: number;
    row_type: EgressOpType;
    rid: number | null;
    msgid: string | null;
    payload: string;
    bytes: string | null;
}

/** One row of the materialized live view (egress_state). NO number
 * columns (2026-11-28): the rid IS the number, and the I-time anchor
 * ("after") lives in the flow payload, where the replay reads it from.
 * `sysIn` is the system row only: the CLIENT RAW system text (input form
 * A) — the flow row's bytes are the assembled outbound (A + server
 * blocks); A's home inside the egress tables (retires the session_ext
 * inc:system copy). */
interface StateRow {
    rid: number;
    msgid: string;
    pos: number;
    tokens: number;
    type: string;
    role: string | null;
    ts: number | null;
    sysIn: string | null;
    bytes: string;
}

const INSERT_FLOW = `INSERT INTO egress_flow (session_id, op_seq, row_type, rid, msgid, payload, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const INSERT_STATE_ROW = `INSERT INTO egress_state (session_id, rid, msgid, pos, tokens, type, role, ts, sys_in, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SELECT_STATE_ROWS = `SELECT rid, msgid, pos, tokens, type, role, ts, sys_in, bytes FROM egress_state WHERE session_id = ? ORDER BY pos ASC`;

/** The canonical message frontier: the highest message number ever ISSUED
 * (retired messages included — I rows only advance it, D/U never do).
 * Since 2026-11-28 the rid IS the message number, so this is the flow's
 * MAX(rid) — same shape as egressRowHighWater (kept as an alias: the flow
 * is append-only, so it always sees every rid ever issued). */
export function egressMessageHighWater(db: SqliteDatabase, sessionId: string): number {
    return egressRowHighWater(db, sessionId);
}

/** The row-id frontier (2026-11-27): the highest rid ever ISSUED (retired
 * rows included — rids are never re-issued, and the flow is append-only /
 * never deleted, so MAX(rid) always sees every rid the session has used).
 * U rows carry their target's rid (never a new one), D rows carry NULL, so
 * the plain MAX over the table is the MAX over the I rows. diffEgressView
 * allocates new rids strictly above it. */
export function egressRowHighWater(db: SqliteDatabase, sessionId: string): number {
    const row = db
        .prepare("SELECT COALESCE(MAX(rid), 0) AS n FROM egress_flow WHERE session_id = ?")
        .get(sessionId) as { n: number } | undefined;
    return Number(row?.n) || 0;
}

function nextSeqs(db: SqliteDatabase, sessionId: string): { opSeq: number } {
    // egress_flow is the record and a superset of egress_state after every
    // turn, so the flow's MAX(op_seq) IS the session's page cursor: op_seq
    // orders the operations (I/D/U each take a page) and feeds the
    // concurrent-write CAS. 2026-11-28: the message-number cursor is GONE
    // — the rid is issued by diffEgressView from the flow's MAX(rid)
    // frontier and no write path numbers messages any more.
    // #7577 (owner ruling 2026-11-24): DUAL CLOCKS — the block lifecycle log
    // numbers itself (egress_block_flow.op_seq dense within its own table,
    // see egress-block.ts); its rows carry flow_op_seq as a POINTER to this
    // clock (flow's MAX at write time) for cross-table alignment at point
    // forks. The flow table keeps its exclusive number pool: the op_seq
    // cursor is egress_flow-only, and its density invariant (#7574) stays
    // intact regardless of what the block table does.
    //
    // #7574: must be read INSIDE the append transaction, never before it.
    const row = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o FROM egress_flow WHERE session_id = ?")
        .get(sessionId) as { o: number } | undefined;
    const head = Number(row?.o) || 0;
    return { opSeq: head + 1 };
}

interface InsertOp {
    type: "I";
    msgid: string;
    /** The row's self-issued id — allocated by diffEgressView (dense, above
     *  the flow's rid frontier), REQUIRED (replay/apply hard-fail without
     *  it). 2026-11-27: the log's addressing key; 2026-11-28: AND the
     *  message's number (the model sees "m" + rid). */
    rid: number;
    /** Anchor: the rid of the preceding row of the new view (null = the
     *  row goes to the FRONT — a replaced system prompt). */
    after: number | null;
    tokens: number;
    typeTag: string;
    bytes: string;
    role?: string;
    /** First-observed wall clock (epoch ms) — stamped by recordEgressTurn
     *  (#7577 D3); the I row is the message's birth, so this is its ts. */
    ts?: number;
    /** System row only: the CLIENT RAW system text (input form A) — the
     *  flow row's bytes are the assembled outbound (A + server blocks);
     *  A gains its home inside the egress tables here (retires the
     *  session_ext inc:system copy). */
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
    /** 2026-11-28: U NEVER carries a number — the rid is one-shot. */
}
export type EgressOp = InsertOp | DeleteOp | UpdateOp;

/** Pure replay: apply ops (in op order) on top of an existing view.
 * Shared by the db-backed replays and the diff engine's own verification.
 * 2026-11-28: no number machinery — the rid IS the message number and is
 * one-shot (allocated by diffEgressView from the flow's MAX(rid) frontier
 * at I time); nothing here can renumber anything, which is exactly what
 * made the old cited-number collision (and its permanent record
 * deadlock) impossible.
 */
export function egressReplay(prev: EgressViewRow[], ops: EgressOp[], sessionId = "diff"): EgressViewRow[] {
    const view: EgressViewRow[] = prev.map((r) => ({ ...r }));
    const idxOf = (rid: number): number => view.findIndex((r) => r.rid === rid);
    // Row ids (2026-11-27; 2026-11-28: = the message numbers): unique among
    // LIVE rows — a D retires its rids forever (the flow keeps them spent),
    // an I reuses none of them.
    const liveRids = new Set<number>();
    for (const r of view) if (typeof r.rid === "number") liveRids.add(r.rid);
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
            liveRids.add(op.rid);
            const entry: EgressViewRow = { rid: op.rid, msgid: op.msgid, tokens: op.tokens, type: op.typeTag, bytes: op.bytes };
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
                if (r !== undefined && typeof r.rid === "number") liveRids.delete(r.rid);
            }
            view.splice(s, e - s + 1);
        } else {
            const i = idxOf(op.rid);
            if (i < 0) throw new EgressStateCorruptError(sessionId, `update target rid ${op.rid} missing`);
            const row = view[i];
            // Cross-check: the flow row's msgid column must name the same
            // row the rid resolves to — a stale column is corruption.
            if (row.msgid !== op.msgid) throw new EgressStateCorruptError(sessionId, `update rid ${op.rid} points at msgid ${row.msgid}, not ${op.msgid}`);
            view[i] = { ...row, bytes: op.bytes, ...(op.role !== undefined ? { role: op.role } : {}) };
        }
    }
    return view;
}

/** Deterministic diff between two consecutive views (owner design, 4 upper
 * cases: tail append / nudge appear+vanish / fold replace / content edit).
 * The diff keys on msgid OCCURRENCE + bytes.
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
 * Spine rows with CHANGED BYTES (direct inequality — no hash) emit +U;
 * everything else emits -D (maximal contiguous runs in PREV order) plus +I
 * in NEXT order with the preceding row as anchor. egressReplay(prev, diff)
 * always reproduces `next` exactly.
 *
 * Moves (same msgid, new position) are deliberately expressed as D+I — there
 * is no M op; the msgid stays the identity through both ops, and the NEW
 * rid the D+I takes is the message's number from then on (the old rid stays
 * retired — never re-issued).
 */
export function diffEgressView(prev: EgressViewRow[], next: EgressViewRow[], ridHighWater = 0): EgressOp[] {
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
            if (old.bytes !== r.bytes) {
                const u: UpdateOp = { type: "U", rid: old.rid!, msgid: r.msgid, bytes: r.bytes };
                if (r.role !== undefined) u.role = r.role;
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
            const ins: InsertOp = { type: "I", rid, msgid: r.msgid, after: last, tokens: r.tokens, typeTag: r.type, bytes: r.bytes };
            if (r.role !== undefined) ins.role = r.role;
            ops.push(ins);
            last = rid;
        }
    }
    return ops;
}

/** Write one FLOW row (the record). The state table is applied separately
 * (materialized, 7773) — there is no twin-pair copy anymore. */
function writeFlowRow(db: SqliteDatabase, sessionId: string, opSeq: number, rowType: EgressOpType, rid: number | null, msgid: string | null, payload: string, bytes: string | null, nowMs: number): void {
    db.prepare(INSERT_FLOW).run(sessionId, opSeq, rowType, rid, msgid, payload, bytes, nowMs);
}

/** Write a batch of ops to the FLOW. Every op gets the next op_seq (the
 * flow's page number — operation order + the concurrent-write CAS;
 * messages are never numbered here any more, 2026-11-28). The caller has
 * already validated the batch against the log as it is. */
function writeFlowOps(db: SqliteDatabase, sessionId: string, ops: EgressOp[], firstOpSeq: number, nowMs: number): void {
    for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        const opSeq = firstOpSeq + i;
        if (op.type === "I") {
            const payload: Record<string, unknown> = { after: op.after, tokens: op.tokens, type: op.typeTag, role: op.role, ts: op.ts };
            if (op.sysIn !== undefined) payload["sysIn"] = op.sysIn;
            writeFlowRow(db, sessionId, opSeq, "I", op.rid, op.msgid, JSON.stringify(payload), op.bytes, nowMs);
        } else if (op.type === "D") {
            // 2026-11-27: the range endpoints are RIDS (self-issued, never
            // re-issued) — the msgid never indexes the log again.
            writeFlowRow(db, sessionId, opSeq, "D", null, null, JSON.stringify({ start: op.start, end: op.end }), null, nowMs);
        } else {
            const payload: Record<string, unknown> = { role: op.role };
            if (op.sysIn !== undefined) payload["sysIn"] = op.sysIn;
            writeFlowRow(db, sessionId, opSeq, "U", op.rid, op.msgid, JSON.stringify(payload), op.bytes, nowMs);
        }
    }
}

/** Replace the session's materialized state with the given view: DELETE
 * every row, INSERT the view at pos 0..n-1. A view row with no I row in
 * the flow is a stray (the same condition the serving read's twin check
 * rejects) and throws. Runs inside the caller's transaction. Returns the
 * number of rows removed. */
export function egressMaterializeState(db: SqliteDatabase, sessionId: string, view: EgressViewRow[], nowMs: number): number {
    const iRids = new Set<number>();
    for (const r of db
        .prepare("SELECT rid FROM egress_flow WHERE session_id = ? AND row_type = 'I' ORDER BY op_seq ASC")
        .all(sessionId) as { rid: number | null }[]) {
        if (typeof r.rid !== "number") throw new EgressStateCorruptError(sessionId, `I row has no rid`);
        if (iRids.has(r.rid)) throw new EgressStateCorruptError(sessionId, `duplicate I row for rid ${r.rid}`);
        iRids.add(r.rid);
    }
    const removed = db
        .prepare("DELETE FROM egress_state WHERE session_id = ?")
        .run(sessionId) as { changes: number };
    for (let i = 0; i < view.length; i++) {
        const r = view[i];
        if (typeof r.rid !== "number" || r.rid < 1) {
            throw new EgressStateCorruptError(sessionId, `materialized entry ${r.msgid} has no row id`);
        }
        if (!iRids.has(r.rid)) {
            throw new EgressStateCorruptError(sessionId, `materialized entry ${r.msgid} has no I twin in the flow (rid ${r.rid})`);
        }
        db.prepare(INSERT_STATE_ROW).run(
            sessionId, r.rid, r.msgid, i, r.tokens, r.type,
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
 * negative in the pos sequence). */
export function egressStateView(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    const rows = readStateRows(db, sessionId);
    const view: EgressViewRow[] = [];
    for (const r of rows) {
        if (r.pos !== view.length) {
            throw new EgressStateCorruptError(sessionId, `state pos jumps from ${view.length} to ${r.pos} (msgid ${r.msgid})`);
        }
        const row: EgressViewRow = { rid: r.rid, msgid: r.msgid, tokens: r.tokens, type: r.type, bytes: r.bytes };
        if (r.role !== null) row.role = r.role;
        if (r.ts !== null) row.ts = r.ts;
        view.push(row);
    }
    return view;
}

/** The STRUCTURAL integrity check (7773): state and flow are no longer
 * byte twins row-for-row (a U edits the state in place), so the check is
 * (a) every state row has its I twin in the flow — same rid (rids are
 * one-shot, 2026-11-27/28, so rid alone identifies the I row); (b) no
 * state row exists for a session whose flow has no rows. Cheap (index
 * join), runs inside the caller's read transaction. Throws
 * EgressStateCorruptError on any stray row. */
function assertStateTwinOfFlow(db: SqliteDatabase, sessionId: string): void {
    const stray = db
        .prepare(
            `SELECT COUNT(*) AS c FROM egress_state s
               LEFT JOIN egress_flow f ON f.session_id = s.session_id AND f.rid = s.rid AND f.row_type = 'I'
              WHERE s.session_id = ? AND f.op_seq IS NULL`,
        )
        .get(sessionId) as { c: number };
    if (Number(stray.c) > 0) {
        throw new EgressStateCorruptError(sessionId, `${Number(stray.c)} state row(s) have no I twin in the flow`);
    }
    const counts = db
        .prepare(
            `SELECT (SELECT COUNT(*) FROM egress_state WHERE session_id = ?) AS s,
                    (SELECT COUNT(*) FROM egress_flow WHERE session_id = ?) AS f`,
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
    for (const op of ops) {
        if (op.type === "I") {
            if (posOf.has(op.rid)) throw new EgressStateCorruptError(sessionId, `state apply: insert rid ${op.rid} already present`);
            const at = op.after === null ? -1 : posOf.get(op.after);
            if (at === undefined && op.after !== null) throw new EgressStateCorruptError(sessionId, `state apply: insert anchor rid ${op.after} missing`);
            const pos = (at ?? -1) + 1;
            db.prepare("UPDATE egress_state SET pos = pos + 1 WHERE session_id = ? AND pos >= ?").run(sessionId, pos);
            db.prepare(INSERT_STATE_ROW).run(
                sessionId, op.rid, op.msgid, pos, op.tokens, op.typeTag,
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
            db.prepare("DELETE FROM egress_state WHERE session_id = ? AND pos BETWEEN ? AND ?").run(sessionId, s, e);
            db.prepare("UPDATE egress_state SET pos = pos - ? WHERE session_id = ? AND pos > ?").run(span, sessionId, e);
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
            db.prepare(`UPDATE egress_state SET ${sets.join(", ")} WHERE session_id = ? AND rid = ?`).run(...params, sessionId, op.rid);
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
 * op_seqs in input order.
 *
 * 2026-11-28 owner ruling (discussions/7903): rids are ONE-SHOT. Besides
 * the replay's live-duplicate check, this boundary refuses an I whose rid
 * sits at or below the flow's rid frontier — the flow is append-only and
 * never deletes, so MAX(rid) over it sees every rid the session has ever
 * issued, retired rows included. Re-using a spent number (the 2026-11-28
 * incident class) is a hard error here, nothing written. */
export function egressStateAppend(
    db: SqliteDatabase,
    sessionId: string,
    ops: EgressOp[],
    nowMs: number,
): number[] {
    if (ops.length === 0) return [];
    return db.transaction(() => {
        const seqs = nextSeqs(db, sessionId);
        const frontier = egressRowHighWater(db, sessionId);
        for (const op of ops) {
            if (op.type === "I" && op.rid <= frontier) {
                throw new EgressStateCorruptError(
                    sessionId,
                    `duplicate row id ${op.rid} (msgid ${op.msgid}) — rids are one-shot; the flow has already issued up to ${frontier}`,
                );
            }
        }
        const stamped = egressReplay(egressStateView(db, sessionId), ops, sessionId);
        writeFlowOps(db, sessionId, ops, seqs.opSeq, nowMs);
        applyOpsToState(db, sessionId, ops, stamped, nowMs);
        const n = db
            .prepare("SELECT COUNT(*) AS c FROM egress_state WHERE session_id = ?")
            .get(sessionId) as { c: number };
        if (Number(n.c) !== stamped.length) {
            throw new EgressStateCorruptError(sessionId, `state apply diverged: ${Number(n.c)} rows but the stamped view has ${stamped.length}`);
        }
        return Array.from({ length: ops.length }, (_, i) => seqs.opSeq + i);
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
        const frontier = egressRowHighWater(db, sessionId);
        for (const op of ops) {
            if (op.type === "I" && op.rid <= frontier) {
                throw new EgressStateCorruptError(
                    sessionId,
                    `duplicate row id ${op.rid} (msgid ${op.msgid}) — rids are one-shot; the flow has already issued up to ${frontier}`,
                );
            }
        }
        const stamped = egressReplay(egressStateView(db, sessionId), ops, sessionId);
        writeFlowOps(db, sessionId, ops, seqs.opSeq, nowMs);
        applyOpsToState(db, sessionId, ops, stamped, nowMs);
        const n = db
            .prepare("SELECT COUNT(*) AS c FROM egress_state WHERE session_id = ?")
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
            "SELECT op_seq, row_type, rid, msgid, payload, bytes FROM egress_flow WHERE session_id = ? AND op_seq <= ? ORDER BY op_seq ASC",
        )
        .all(sessionId, x) as unknown as FlowRow[];
    return applyOps(sessionId, rows);
}

/** Fork (ruling 7439 裁定 B, 7773 shape): copy the parent's ENTIRE flow —
 * every row (append-only, nothing is ever pruned) — AND its materialized
 * state (direct copy: both are already the parent's exact facts) to the
 * child session_id inside ONE transaction. op_seq/pos are
 * preserved verbatim, so the child inherits the parent's full rid space
 * (message numbers, 2026-11-28): its next rid continues where the
 * parent stopped, nothing is ever re-issued across the fork, and no other
 * logic changes. Pre-existing child rows are replaced (an idempotent
 * re-fork of the same parent pair). Returns the number of flow rows
 * copied. */
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
            `INSERT INTO egress_flow (session_id, op_seq, row_type, rid, msgid, payload, bytes, created_at)
             SELECT ?, op_seq, row_type, rid, msgid, payload, bytes, created_at FROM egress_flow WHERE session_id = ?`,
        ).run(toSessionId, fromSessionId);
        db.prepare(
            `INSERT INTO egress_state (session_id, rid, msgid, pos, tokens, type, role, ts, sys_in, bytes, created_at)
             SELECT ?, rid, msgid, pos, tokens, type, role, ts, sys_in, bytes, created_at FROM egress_state WHERE session_id = ?`,
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
        // 2026-11-28: the rid IS the message number (one-shot); the old
        // log_seq/ref/num machinery is gone from the flow rows. `after` is
        // the I-time anchor (the preceding row's rid) — kept in the
        // payload, never duplicated into a state column.
        if (typeof p.tokens !== "number" || typeof p.type !== "string" || typeof row.bytes !== "string") {
            throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has a malformed payload or missing bytes`);
        }
        const entry: EgressViewRow = {
            rid: row.rid,
            msgid: row.msgid,
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
            // 2026-11-28: U never renumbers — legacy rows' `num` key is
            // simply ignored (the number was retired with the old scheme).
        };
    } else {
        throw new EgressStateCorruptError(sessionId, `unknown row_type ${String(row.row_type)} at op_seq=${row.op_seq}`);
    }
    return view;
}

/** Full-history replay of the flow (op_seq dense from 1 — a jump means a
 * row was lost or removed between two survivors, and every later anchor
 * would refer to a view that never existed). Throws
 * EgressStateCorruptError on any anchor/endpoint/id violation. */
function applyOps(sessionId: string, rows: FlowRow[]): EgressViewRow[] {
    let view: EgressViewRow[] = [];
    let prevSeq: number | null = null;
    for (const row of rows) {
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
            "SELECT op_seq, row_type, rid, msgid, payload, bytes FROM egress_flow WHERE session_id = ? ORDER BY op_seq ASC",
        )
        .all(sessionId) as unknown as FlowRow[];
    let view: EgressViewRow[] = [];
    let prevSeq: number | null = null;
    for (let i = 0; i < rows.length; i++) {
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
            if (i > 0 && view.length > 0) {
                return { seq: rows[i - 1].op_seq, view };
            }
            return null;
        }
    }
    return view.length > 0 ? { seq: rows[rows.length - 1].op_seq, view } : null;
}
