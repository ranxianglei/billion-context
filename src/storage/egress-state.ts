/**
 * Egress state log — the op-log view of the outbound conversation
 * (proposal: discussions/7398, owner design 2026-11-20; #6785 perf work).
 *
 * The outbound view changes sparsely: tail appends, occasional content edits
 * (same msgid, new content), fold ranges replaced by one summary row. Instead
 * of recomputing the whole view every turn (render/convert/serialize over all
 * messages), the view is a TOTAL-ORDERED op log per session; replaying the
 * log yields exactly one deterministic view.
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
 *   I  insert          msgid required  {"after": msgid|null, ref, tokens,
 *                                       type, content_hash}
 *   D  delete-range    msgid NULL      {"start": msgid, "end": msgid}  inclusive
 *   U  update-content  msgid required  {"content_hash": …}  (ref/tokens/type/
 *                                       position untouched)
 *
 * Anchors are MSGIDS, never display positions — positions shift under other
 * ops, msgids do not (KDD#11: content may change, msgid does not). Any
 * anchor/endpoint violation, missing update target, or duplicate msgid is a
 * HARD ERROR: the session is corrupt and the caller degrades to the legacy
 * full path (no fuzzy guessing — same discipline as every other lane's
 * "any doubt, fall back whole-turn" rule).
 */

import type { SqliteDatabase } from "./driver.js";

export class EgressStateCorruptError extends Error {
    constructor(readonly sessionId: string, readonly reason: string) {
        super(`egress-state corrupt (session=${sessionId}): ${reason}`);
        this.name = "EgressStateCorruptError";
    }
}

/** One row of the current view. The tag triple (ref, tokens, type) is
 * permanent while the content hash is unchanged (ref is never re-issued by
 * the kernel contract; tokens are deterministic over content). Content BYTES
 * live in the content CAS — only the pointer lands here. */
export interface EgressViewRow {
    msgid: string;
    ref: string;
    tokens: number;
    type: string;
    contentHash: string;
}

export type EgressOpType = "B" | "I" | "D" | "U";

interface EgressStateRow {
    log_seq: number;
    row_type: EgressOpType;
    msgid: string | null;
    payload: string;
}

const INSERT_STATE = `INSERT INTO egress_state (session_id, log_seq, row_type, msgid, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`;
const INSERT_FLOW = `INSERT INTO egress_flow (session_id, log_seq, row_type, msgid, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`;

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
    contentHash: string;
}
interface DeleteOp {
    type: "D";
    start: string;
    end: string;
}
interface UpdateOp {
    type: "U";
    msgid: string;
    contentHash: string;
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
            view.splice(at + 1, 0, { msgid: op.msgid, ref: op.ref, tokens: op.tokens, type: op.typeTag, contentHash: op.contentHash });
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
            view[i] = { ...view[i], contentHash: op.contentHash };
        }
    }
    return view;
}

/** Deterministic diff between two consecutive views (owner design, 4 upper
 * cases: tail append / nudge appear+vanish / fold replace / content edit).
 *
 * Spine = the longest subsequence of `next` whose msgids appear in `prev` in
 * INCREASING prev order (pointer scan, O(n+m); exact for the sparse-change
 * regime this lane exists for). Spine rows with a changed content hash emit
 * +U; everything else emits -D (maximal contiguous runs in PREV order) plus
 * +I in NEXT order with the preceding row as anchor. egressReplay(prev, diff)
 * always reproduces `next` exactly.
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
            if (old.contentHash !== r.contentHash) ops.push({ type: "U", msgid: r.msgid, contentHash: r.contentHash });
        }
    }
    let last: string | null = null;
    for (const r of next) {
        if (!spine.has(r.msgid)) {
            ops.push({ type: "I", msgid: r.msgid, after: last, ref: r.ref, tokens: r.tokens, typeTag: r.type, contentHash: r.contentHash });
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
            if (op.type === "I") {
                rowType = "I";
                msgid = op.msgid;
                payload = JSON.stringify({
                    after: op.after,
                    ref: op.ref,
                    tokens: op.tokens,
                    type: op.typeTag,
                    content_hash: op.contentHash,
                });
            } else if (op.type === "D") {
                rowType = "D";
                msgid = null;
                payload = JSON.stringify({ start: op.start, end: op.end });
            } else {
                rowType = "U";
                msgid = op.msgid;
                payload = JSON.stringify({ content_hash: op.contentHash });
            }
            db.prepare(INSERT_STATE).run(sessionId, seq, rowType, msgid, payload, nowMs);
            db.prepare(INSERT_FLOW).run(sessionId, seq, rowType, msgid, payload, nowMs);
        }
    });
    return Array.from({ length: ops.length }, (_, i) => first + i);
}

/** Replay the STATE table into the current view. Throws
 * EgressStateCorruptError on any anchor/endpoint/id violation — the caller
 * degrades the whole session to the legacy path. */
export function egressStateView(db: SqliteDatabase, sessionId: string): EgressViewRow[] {
    const rows = db
        .prepare(
            "SELECT log_seq, row_type, msgid, payload FROM egress_state WHERE session_id = ? ORDER BY log_seq ASC",
        )
        .all(sessionId) as unknown as EgressStateRow[];
    return applyOps(sessionId, rows);
}

/** Replay the FLOW table up to (and including) log_seq x — the rollback
 * reconstruction. The latest B row with log_seq <= x is the starting point;
 * ops after it up to x are applied. Throws like egressStateView. */
export function egressStateAt(db: SqliteDatabase, sessionId: string, x: number): EgressViewRow[] {
    const rows = db
        .prepare(
            "SELECT log_seq, row_type, msgid, payload FROM egress_flow WHERE session_id = ? AND log_seq <= ? ORDER BY log_seq ASC",
        )
        .all(sessionId, x) as unknown as EgressStateRow[];
    return applyOps(sessionId, rows);
}

/** Compaction: persist the replayed view as a new base row, then physically
 * delete every STATE row below it (flow untouched — rollback stays total).
 * The base carries the entries themselves; base + later ops must reproduce
 * the current view WITHOUT any deleted row (that is the only constraint the
 * base form has). One transaction. */
export function egressStateCompact(
    db: SqliteDatabase,
    sessionId: string,
    view: EgressViewRow[],
    nowMs: number,
): number {
    const seq = nextLogSeq(db, sessionId);
    const payload = JSON.stringify({ entries: view, watermark: seq });
    db.transaction(() => {
        db.prepare(INSERT_STATE).run(sessionId, seq, "B", null, payload, nowMs);
        db.prepare(INSERT_FLOW).run(sessionId, seq, "B", null, payload, nowMs);
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
            if (view.some((e) => typeof e.msgid !== "string" || typeof e.ref !== "string")) {
                throw new EgressStateCorruptError(sessionId, `base at log_seq=${row.log_seq} has malformed entries`);
            }
            continue;
        }
        const idxOf = (msgid: string): number => view.findIndex((e) => e.msgid === msgid);
        if (row.row_type === "I") {
            if (typeof row.msgid !== "string") throw new EgressStateCorruptError(sessionId, `insert at log_seq=${row.log_seq} has no msgid`);
            if (idxOf(row.msgid) >= 0) throw new EgressStateCorruptError(sessionId, `duplicate msgid ${row.msgid} at log_seq=${row.log_seq}`);
            if (typeof p.ref !== "string" || typeof p.tokens !== "number" || typeof p.type !== "string" || typeof p.content_hash !== "string") {
                throw new EgressStateCorruptError(sessionId, `insert at log_seq=${row.log_seq} has a malformed payload`);
            }
            const entry: EgressViewRow = {
                msgid: row.msgid,
                ref: p.ref as string,
                tokens: p.tokens as number,
                type: p.type as string,
                contentHash: p.content_hash as string,
            };
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
            if (typeof row.msgid !== "string" || typeof p.content_hash !== "string") {
                throw new EgressStateCorruptError(sessionId, `update at log_seq=${row.log_seq} has a malformed payload`);
            }
            const i = idxOf(row.msgid);
            if (i < 0) throw new EgressStateCorruptError(sessionId, `update target ${row.msgid} missing at log_seq=${row.log_seq}`);
            view[i] = { ...view[i], contentHash: p.content_hash };
        } else {
            throw new EgressStateCorruptError(sessionId, `unknown row_type ${String(row.row_type)} at log_seq=${row.log_seq}`);
        }
    }
    return view;
}
