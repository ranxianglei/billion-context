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
 * Two tables (dual-table, owner ruling):
 *   egress_state  — what serving reads; compaction PHYSICALLY deletes rows
 *                   below the watermark, so it stays bounded;
 *   egress_flow   — append-only, NEVER deleted; reconstructs ANY historical
 *                   log_seq (rollback is based on this table, not on client
 *                   resends).
 *
 * Row types (payload shapes are the contract — see the discussion post):
 *   B  base            msgid NULL      {"entries": viewRow[], watermark}
 *                                       (entries carry the bytes inline)
 *   I  insert          msgid required  {"after": msgid|null, ref, tokens,
 *                                       type, role?} + bytes column
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

/** One row of the current view. The ref (mNNNNN) is identity, never hash
 * and never re-issued (kernel contract). `bytes` is the message's FINAL core
 * JSON (post reasoning-drop / image-rescale, pre outbound convert); for the
 * system row it is the system text itself. The row is self-contained:
 * replay + serve need nothing beyond this pair of tables. */
export interface EgressViewRow {
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
    log_seq: number;
    row_type: EgressOpType;
    msgid: string | null;
    payload: string;
    bytes: string | null;
}

const INSERT_STATE = `INSERT INTO egress_state (session_id, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const INSERT_FLOW = `INSERT INTO egress_flow (session_id, log_seq, row_type, msgid, payload, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`;

function nextLogSeq(db: SqliteDatabase, sessionId: string): number {
    // egress_flow is append-only and superset of egress_state after every
    // compaction, so the flow max IS the session's sequence high-water.
    const row = db
        .prepare("SELECT MAX(log_seq) AS m FROM egress_flow WHERE session_id = ?")
        .get(sessionId) as { m: number | null } | undefined;
    return (row?.m ?? 0) + 1;
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

/** Pure replay: apply ops (in log_seq order) on top of an existing view.
 * Shared by the db-backed replays and the diff engine's own verification. */
export function egressReplay(prev: EgressViewRow[], ops: EgressOp[]): EgressViewRow[] {
    const view: EgressViewRow[] = prev.map((r) => ({ ...r }));
    const idxOf = (msgid: string): number => view.findIndex((r) => r.msgid === msgid);
    for (const op of ops) {
        if (op.type === "I") {
            if (idxOf(op.msgid) >= 0) throw new EgressStateCorruptError("diff", `duplicate msgid ${op.msgid}`);
            const at = op.after === null ? -1 : idxOf(op.after);
            if (at < -1) throw new EgressStateCorruptError("diff", `insert anchor ${op.after} missing`);
            const entry: EgressViewRow = { msgid: op.msgid, ref: op.ref, tokens: op.tokens, type: op.typeTag, bytes: op.bytes };
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
 *
 * Spine = the longest subsequence of `next` whose msgids appear in `prev` in
 * INCREASING prev order (pointer scan, O(n+m); exact for the sparse-change
 * regime this lane exists for). Spine rows with CHANGED BYTES (direct
 * inequality — no hash) emit +U; everything else emits -D (maximal
 * contiguous runs in PREV order) plus +I in NEXT order with the preceding
 * row as anchor. egressReplay(prev, diff) always reproduces `next` exactly.
 *
 * Moves (same msgid, new position) are deliberately expressed as D+I — there
 * is no M op; the msgid stays the identity through both ops. */
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
 * Returns the assigned log_seqs in input order. */
export function egressStateAppend(
    db: SqliteDatabase,
    sessionId: string,
    ops: EgressOp[],
    nowMs: number,
): number[] {
    if (ops.length === 0) return [];
    const first = nextLogSeq(db, sessionId);
    db.transaction(() => {
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            const seq = first + i;
            let rowType: EgressOpType;
            let msgid: string | null;
            let payload: string;
            let bytes: string | null = null;
            if (op.type === "I") {
                rowType = "I";
                msgid = op.msgid;
                payload = JSON.stringify({ after: op.after, ref: op.ref, tokens: op.tokens, type: op.typeTag, role: op.role });
                bytes = op.bytes;
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
            db.prepare(INSERT_STATE).run(sessionId, seq, rowType, msgid, payload, bytes, nowMs);
            db.prepare(INSERT_FLOW).run(sessionId, seq, rowType, msgid, payload, bytes, nowMs);
        }
    });
    return Array.from({ length: ops.length }, (_, i) => first + i);
}

/** Replay the STATE table into the current view. Throws
 * EgressStateCorruptError on any anchor/endpoint/id violation — the caller
 * degrades per the degrade ladder. */
export function egressStateView(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    const rows = db
        .prepare(
            "SELECT log_seq, row_type, msgid, payload, bytes FROM egress_state WHERE session_id = ? ORDER BY log_seq ASC",
        )
        .all(sessionId) as unknown as EgressStateRow[];
    return applyOps(sessionId, rows);
}

/** Replay the FLOW table up to (and including) log_seq x — the rollback
 * reconstruction (degrade ladder step 2). The latest B row with
 * log_seq <= x is the starting point; ops after it up to x are applied.
 * Throws like egressStateView. */
export function egressStateAt(db: SqliteDatabase, sessionId: string, x: number): EgressViewRow[] {
    const rows = db
        .prepare(
            "SELECT log_seq, row_type, msgid, payload, bytes FROM egress_flow WHERE session_id = ? AND log_seq <= ? ORDER BY log_seq ASC",
        )
        .all(sessionId, x) as unknown as EgressStateRow[];
    return applyOps(sessionId, rows);
}

/** Compaction: persist the replayed view as a new base row, then physically
 * delete every STATE row below it (flow untouched — rollback stays total).
 * The base carries the entries themselves (bytes inline in the payload);
 * base + later ops must reproduce the current view WITHOUT any deleted row
 * (that is the only constraint the base form has). One transaction. */
export function egressStateCompact(
    db: SqliteDatabase,
    sessionId: string,
    view: EgressViewRow[],
    nowMs: number,
): number {
    const seq = nextLogSeq(db, sessionId);
    const payload = JSON.stringify({ entries: view, watermark: seq });
    db.transaction(() => {
        db.prepare(INSERT_STATE).run(sessionId, seq, "B", null, payload, null, nowMs);
        db.prepare(INSERT_FLOW).run(sessionId, seq, "B", null, payload, null, nowMs);
        db.prepare("DELETE FROM egress_state WHERE session_id = ? AND log_seq < ?").run(sessionId, seq);
    });
    return seq;
}

function applyOps(sessionId: string, rows: EgressStateRow[]): EgressViewRow[] {
    let view: EgressViewRow[] = [];
    for (const row of rows) {
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(row.payload) as Record<string, unknown>;
        } catch {
            throw new EgressStateCorruptError(sessionId, `payload at log_seq=${row.log_seq} is not an object`);
        }
        const p: Record<string, unknown> = parsed;
        if (row.row_type === "B") {
            const entries = Array.isArray(p.entries) ? (p.entries as EgressViewRow[]) : null;
            if (!entries) throw new EgressStateCorruptError(sessionId, `base at log_seq=${row.log_seq} has no entries`);
            view = entries.map((e) => ({ ...e }));
            if (view.some((e) => typeof e.msgid !== "string" || typeof e.ref !== "string" || typeof e.bytes !== "string")) {
                throw new EgressStateCorruptError(sessionId, `base at log_seq=${row.log_seq} has malformed entries`);
            }
            continue;
        }
        const idxOf = (msgid: string): number => view.findIndex((e) => e.msgid === msgid);
        if (row.row_type === "I") {
            if (typeof row.msgid !== "string") throw new EgressStateCorruptError(sessionId, `insert at log_seq=${row.log_seq} has no msgid`);
            if (idxOf(row.msgid) >= 0) throw new EgressStateCorruptError(sessionId, `duplicate msgid ${row.msgid} at log_seq=${row.log_seq}`);
            if (typeof p.ref !== "string" || typeof p.tokens !== "number" || typeof p.type !== "string" || typeof row.bytes !== "string") {
                throw new EgressStateCorruptError(sessionId, `insert at log_seq=${row.log_seq} has a malformed payload or missing bytes`);
            }
            const entry: EgressViewRow = {
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
                throw new EgressStateCorruptError(sessionId, `insert at log_seq=${row.log_seq} has a malformed anchor`);
            } else {
                const at = idxOf(p.after);
                if (at < 0) throw new EgressStateCorruptError(sessionId, `insert anchor ${p.after} missing at log_seq=${row.log_seq}`);
                view.splice(at + 1, 0, entry);
            }
        } else if (row.row_type === "D") {
            if (typeof p.start !== "string" || typeof p.end !== "string") {
                throw new EgressStateCorruptError(sessionId, `delete at log_seq=${row.log_seq} has a malformed payload`);
            }
            const s = idxOf(p.start);
            const e = idxOf(p.end);
            if (s < 0) throw new EgressStateCorruptError(sessionId, `delete start ${p.start} missing at log_seq=${row.log_seq}`);
            if (e < 0) throw new EgressStateCorruptError(sessionId, `delete end ${p.end} missing at log_seq=${row.log_seq}`);
            if (s > e) throw new EgressStateCorruptError(sessionId, `delete range inverted (start after end) at log_seq=${row.log_seq}`);
            view.splice(s, e - s + 1);
        } else if (row.row_type === "U") {
            if (typeof row.msgid !== "string" || typeof row.bytes !== "string") {
                throw new EgressStateCorruptError(sessionId, `update at log_seq=${row.log_seq} has a malformed payload or missing bytes`);
            }
            const i = idxOf(row.msgid);
            if (i < 0) throw new EgressStateCorruptError(sessionId, `update target ${row.msgid} missing at log_seq=${row.log_seq}`);
            view[i] = {
                ...view[i],
                bytes: row.bytes,
                ...(p.role !== undefined ? { role: p.role as string } : {}),
            };
        } else {
            throw new EgressStateCorruptError(sessionId, `unknown row_type ${String(row.row_type)} at log_seq=${row.log_seq}`);
        }
    }
    return view;
}
