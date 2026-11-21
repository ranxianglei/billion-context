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
 *             The model-facing mNNNNN (kernel-space) stays a display id; the
 *             join between the two spaces is the I row itself.
 *
 * Two tables (dual-table, owner ruling):
 *   egress_state  — what serving reads; compaction PHYSICALLY deletes rows
 *                   below the watermark, so it stays bounded;
 *   egress_flow   — append-only, NEVER deleted; reconstructs ANY historical
 *                   op_seq (rollback is based on this table, not on client
 *                   resends).
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

export class EgressStateCorruptError extends Error {
    constructor(readonly sessionId: string, readonly reason: string) {
        super(`egress-state corrupt (session=${sessionId}): ${reason}`);
        this.name = "EgressStateCorruptError";
    }
}

/** One row of the current view. The ref (mNNNNN) is the kernel-space
 * display identity, never hash and never re-issued (kernel contract).
 * `num` is the canonical session-scoped message number (ruling 7439): real
 * rows always carry num >= 1; an in-process row built before its I row is
 * appended carries 0 (unnumbered) and is stamped by the replay at record
 * time — 0 must never reach a stored row. `bytes` is the message's FINAL
 * core JSON (post reasoning-drop / image-rescale, pre outbound convert);
 * for the system row it is the system text itself. The row is
 * self-contained: replay + serve need nothing beyond this pair of tables. */
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

function nextSeqs(db: SqliteDatabase, sessionId: string): { opSeq: number; num: number } {
    // egress_flow is append-only and superset of egress_state after every
    // compaction, so the flow maxima ARE the session's high-waters: the
    // op_seq ordering cursor and the canonical message-number cursor (I
    // rows only — B/D/U carry NULL and never advance it).
    const row = db
        .prepare("SELECT COALESCE(MAX(op_seq), 0) AS o, COALESCE(MAX(log_seq), 0) AS n FROM egress_flow WHERE session_id = ?")
        .get(sessionId) as { o: number; n: number } | undefined;
    return { opSeq: (row?.o ?? 0) + 1, num: (row?.n ?? 0) + 1 };
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
 * Insert ops receive the next canonical numbers in op order
 * (high-water(prev) + 1, + 2, …) — the SAME rule the append uses, so the
 * replayed view is exactly the stamped view the tables would produce. */
export function egressReplay(prev: EgressViewRow[], ops: EgressOp[]): EgressViewRow[] {
    const view: EgressViewRow[] = prev.map((r) => ({ ...r }));
    const idxOf = (msgid: string): number => view.findIndex((r) => r.msgid === msgid);
    let num = egressViewHighWater(view);
    for (const op of ops) {
        if (op.type === "I") {
            if (idxOf(op.msgid) >= 0) throw new EgressStateCorruptError("diff", `duplicate msgid ${op.msgid}`);
            const at = op.after === null ? -1 : idxOf(op.after);
            if (at < -1) throw new EgressStateCorruptError("diff", `insert anchor ${op.after} missing`);
            num += 1;
            const entry: EgressViewRow = { num, msgid: op.msgid, ref: op.ref, tokens: op.tokens, type: op.typeTag, bytes: op.bytes };
            if (op.role !== undefined) entry.role = op.role;
            view.splice(at + 1, 0, entry);
        } else if (op.type === "D") {
            const s = idxOf(op.start);
            const e = idxOf(op.end);
            if (s < 0) throw new EgressStateCorruptError("diff", `delete start ${op.start} missing`);
            if (e < 0) throw new EgressStateCorruptError("diff", `delete end ${op.end} missing`);
            if (s > e) throw new EgressStateCorruptError("diff", "delete range inverted");
            view.splice(s, e - s + 1);
        } else {
            const i = idxOf(op.msgid);
            if (i < 0) throw new EgressStateCorruptError("diff", `update target ${op.msgid} missing`);
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
            ops.push(ins);
        }
        last = r.msgid;
    }
    return ops;
}

/** Append a batch of ops to BOTH tables (state + flow) in ONE transaction.
 * Every row gets the next op_seq; each I row ALSO gets the next canonical
 * number (log_seq, dense, high-water includes retired messages) — D/U rows
 * occupy op_seq slots but no numbers. Returns the assigned op_seqs in input
 * order. */
export function egressStateAppend(
    db: SqliteDatabase,
    sessionId: string,
    ops: EgressOp[],
    nowMs: number,
): number[] {
    if (ops.length === 0) return [];
    const { opSeq: firstOpSeq, num: firstNum } = nextSeqs(db, sessionId);
    let num = firstNum - 1;
    db.transaction(() => {
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            const opSeq = firstOpSeq + i;
            let rowType: EgressOpType;
            let msgid: string | null;
            let payload: string;
            let bytes: string | null = null;
            let logSeq: number | null = null;
            if (op.type === "I") {
                rowType = "I";
                msgid = op.msgid;
                payload = JSON.stringify({ after: op.after, ref: op.ref, tokens: op.tokens, type: op.typeTag, role: op.role });
                bytes = op.bytes;
                num += 1;
                logSeq = num;
            } else if (op.type === "D") {
                rowType = "D";
                msgid = null;
                payload = JSON.stringify({ start: op.start, end: op.end });
            } else {
                rowType = "U";
                msgid = op.msgid;
                payload = JSON.stringify({ role: op.role });
                bytes = op.bytes;
            }
            db.prepare(INSERT_STATE).run(sessionId, opSeq, logSeq, rowType, msgid, payload, bytes, nowMs);
            db.prepare(INSERT_FLOW).run(sessionId, opSeq, logSeq, rowType, msgid, payload, bytes, nowMs);
        }
    });
    return Array.from({ length: ops.length }, (_, i) => firstOpSeq + i);
}

/** Replay the STATE table into the current view (ordered by op_seq). An I
 * row's view num IS its log_seq column (validated); B entries carry their
 * numbers in the payload. Throws EgressStateCorruptError on any
 * anchor/endpoint/id violation — the caller degrades per the degrade ladder. */
export function egressStateView(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    const rows = db
        .prepare(
            "SELECT op_seq, log_seq, row_type, msgid, payload, bytes FROM egress_state WHERE session_id = ? ORDER BY op_seq ASC",
        )
        .all(sessionId) as unknown as EgressStateRow[];
    return applyOps(sessionId, rows);
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

/** Compaction: persist the replayed view as a new base row, then physically
 * delete every STATE row below it (flow untouched — rollback stays total).
 * The base carries the entries themselves (bytes AND canonical numbers
 * inline in the payload); base + later ops must reproduce the current view
 * WITHOUT any deleted row (that is the only constraint the base form has).
 * One transaction. Throws if any entry is unnumbered (a programming error —
 * the stamped replay view is the only input that may reach here). */
export function egressStateCompact(
    db: SqliteDatabase,
    sessionId: string,
    view: EgressViewRow[],
    nowMs: number,
): number {
    for (const e of view) {
        if (typeof e.num !== "number" || e.num < 1) {
            throw new EgressStateCorruptError(sessionId, `compact base entry ${e.msgid} has no canonical number`);
        }
    }
    const { opSeq: seq } = nextSeqs(db, sessionId);
    const payload = JSON.stringify({ entries: view, watermark: seq });
    db.transaction(() => {
        db.prepare(INSERT_STATE).run(sessionId, seq, null, "B", null, payload, null, nowMs);
        db.prepare(INSERT_FLOW).run(sessionId, seq, null, "B", null, payload, null, nowMs);
        db.prepare("DELETE FROM egress_state WHERE session_id = ? AND op_seq < ?").run(sessionId, seq);
    });
    return seq;
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
    for (const row of rows) {
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
            if (view.some((e) => typeof e.num !== "number" || e.num < 1 || typeof e.msgid !== "string" || typeof e.ref !== "string" || typeof e.bytes !== "string")) {
                throw new EgressStateCorruptError(sessionId, `base at op_seq=${row.op_seq} has malformed entries`);
            }
            continue;
        }
        const idxOf = (msgid: string): number => view.findIndex((e) => e.msgid === msgid);
        if (row.row_type === "I") {
            if (typeof row.msgid !== "string") throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no msgid`);
            if (typeof row.log_seq !== "number" || row.log_seq < 1) throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has no canonical number`);
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
            if (p.after == null) {
                view.push(entry);
            } else if (typeof p.after !== "string") {
                throw new EgressStateCorruptError(sessionId, `insert at op_seq=${row.op_seq} has a malformed anchor`);
            } else {
                const at = idxOf(p.after);
                if (at < 0) throw new EgressStateCorruptError(sessionId, `insert anchor ${p.after} missing at op_seq=${row.op_seq}`);
                view.splice(at + 1, 0, entry);
            }
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
