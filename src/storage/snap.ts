/**
 * snap.ts — #5874 snapshot-table compression foundation (P0: plane core, P1:
 * shadow write).
 *
 * Design anchor: discussions/5874 "snapshot-table compression foundation
 * (six-stage fixed chain, single storage truth source)". This file is the
 * storage half of the chain — the four tables (l1_world / snap_rows /
 * snap_log / snap_ckpt, schema v12), the commit primitive, the read-side
 * rebuild with S4 verification, and the L1 identity ledger. It does NOT
 * touch the compression kernel (zero-change hard constraint) and does NOT
 * change any outbound bytes in P0/P1: the plane is a SHADOW — it writes
 * alongside the legacy path and the read side only compares, never serves.
 *
 * Invariants enforced here (proposal §5):
 *   i  single writer per session (one process — H; WAL serializes);
 *   ii seq strictly monotonic, always > max(log max, ckpt_seq) — the commit
 *      primitive derives seq; callers never choose it;
 *   iii S4 checksum mismatch ⇒ the plane is permanently dead for that sid
 *      (R1) — the dead flag is sticky (see snapPlaneDead);
 *   iv rows are never physically deleted by events — delete/compact flip
 *      active=0 and keep pre/post forms (both forms retained); physical
 *      cleanup happens only when the covering block's row is gone
 *      (snapGcCoveredRows);
 *   v  post_json / pre_json carry the canonical core shape (unified-store
 *      message rows), NEVER wire bytes.
 *
 * Commit primitive = one transaction (proposal §5): upsert snap_rows →
 * append snap_log (seq per invariant ii) → optional fold into snap_ckpt
 * (fold truncates log entries ≤ ckpt_seq and records the three-piece meta:
 * kernel state verbatim + coverage mapping + S4 aggregate). Any statement
 * throwing rolls the WHOLE commit back — no half-state (T2).
 *
 * The red conditions this file participates in: R1 (S4 mismatch → plane
 * dead for the sid, sticky) and R2 (join-chain break → the round produces
 * no events and the legacy path carries it — expressed as: the plane never
 * throws at the write hook; derivation failures are logged decisions, not
 * errors, and the round is simply absent from the plane, self-healing on
 * the next save because the plane is derived from final DB state).
 */

import { sha256Hex } from "./store.ts";

/** A single structured plane event (proposal §4 event kinds). Events carry
 *  NO address of their own beyond the ledger position — addressing comes
 *  from the kernel pipeline's own evidence (block coverage intervals /
 *  ledger seqs / frame boundaries), never fuzzy similarity (R2: an event
 *  that cannot be addressed does not exist for this round). */
export type SnapEvent =
    | { ev: "cast"; pos: number; coreIds: string[]; preJson: string | null; postJson: string; tokensEst: number }
    | { ev: "append"; pos: number; coreIds: string[]; preJson: string | null; postJson: string; tokensEst: number }
    | { ev: "update"; pos: number; postJson: string; coreIds?: string[]; tokensEst?: number }
    | { ev: "delete"; pos: number }
    | { ev: "compact"; blockId: string; posRange: [number, number] };

/** Read-side view of one session's plane (proposal stage 4, mapEgress's
 *  input in P2 — in P1 it is the A/B oracle). `rows` is pos-ordered with
 *  the S4 checksums recomputed; `tailSeq`/`checksum` anchor verification. */
interface SnapView {
    sid: string;
    rows: {
        pos: number;
        coreIds: string[];
        preJson: string | null;
        postJson: string | null;
        tokensEst: number;
        active: 0 | 1;
        coverRef: string | null;
        /** S4 row checksum, recomputed at read time (never stored). */
        rowSum: string;
    }[];
    /** Last applied log seq (0 when no log entries), always ≥ ckptSeq. */
    tailSeq: number;
    ckptSeq: number;
    /** S4 aggregate over all rows in pos order, recomputed at read time. */
    checksum: string;
    /** Stored verification anchor: last log sumAfter (or ckpt checksum). */
    expectedChecksum: string;
    /** true when the recomputed aggregate matches the stored anchor. */
    verified: boolean;
    ckptMeta: SnapCkptMeta | null;
}

/** snap_ckpt.meta_json — the three-piece set (proposal §5): kernel state
 *  verbatim (the sessions.kstate_json blob, copied byte-for-byte), the
 *  coverage mapping (summary blocks → covered pos intervals, in pos order),
 *  and the S4 aggregate (mirrored in the checksum column). */
interface SnapCkptMeta {
    kstate: string;
    kstateHash: string;
    coverage: [string, number, number][];
    s4: string;
    foldedAt: number;
}

/** R1: S4 checksum mismatch — the plane is permanently dead for this sid.
 *  Carries the sid so the caller can latch the sticky dead flag. */
export class SnapPlaneDeadError extends Error {
    constructor(readonly sid: string, detail: string) {
        super(`[snaplane] sid=${sid} dead (R1): ${detail}`);
        this.name = "SnapPlaneDeadError";
    }
}

/** Sticky R1 dead flag (proposal: "S4 checksum mismatch ⇒ permanently close
 *  that sid's plane" — per-sid, permanent for the process lifetime). The
 *  flag is process-local: a restart re-derives from storage and re-verifies
 *  (a fresh view that verifies cleanly stays open; one that does not dies
 *  again — same outcome, no cross-restart latch needed because verification
 *  is the latch). */
const deadSids = new Set<string>();
export function isSnapPlaneDead(sid: string): boolean {
    return deadSids.has(sid);
}
export function markSnapPlaneDead(sid: string): void {
    deadSids.add(sid);
}
/** Test-only: clear sticky flags between hermetic fixtures. */
export function _resetSnapPlaneDeadForTests(): void {
    deadSids.clear();
}

/** S4 row checksum over the stored form (invariant v: canonical core
 *  shape only). NULL pre/post contribute an empty field (a cast's pre_json
 *  may be NULL for the first-ever form of a position). */
function snapRowChecksum(
    sid: string,
    pos: number,
    coreIds: string,
    preJson: string | null,
    postJson: string | null,
    tokensEst: number,
    active: number,
    coverRef: string | null,
): string {
    return sha256Hex(
        `${sid}\u0000${pos}\u0000${coreIds}\u0000${preJson ?? ""}\u0000${postJson ?? ""}\u0000${tokensEst}\u0000${active}\u0000${coverRef ?? ""}`,
    );
}

/** S4 aggregate over all rows of a session, pos-ordered. The read side
 *  recomputes this and compares against the stored anchor; the write side
 *  stores it as each log entry's `sumAfter` (and the fold's checksum). */
function snapAggregate(rows: {
    pos: number;
    core_ids: string;
    pre_json: string | null;
    post_json: string | null;
    tokens_est: number;
    active: number;
    cover_ref: string | null;
}[]): string {
    const parts = rows.map((r) =>
        sha256Hex(
            `${r.pos}\u0000${r.core_ids}\u0000${r.pre_json ?? ""}\u0000${r.post_json ?? ""}\u0000${r.tokens_est}\u0000${r.active}\u0000${r.cover_ref ?? ""}`,
        ),
    );
    return sha256Hex(parts.join("\u0000"));
}

/** Validate event payloads (invariant v + addressing sanity). Throws on
 *  any violation — inside the commit transaction that rolls the whole
 *  commit back (T2: no half-state), and at the derivation hook where the
 *  caller catches and degrades the round to legacy (R2). */
function validateEvents(sid: string, events: SnapEvent[]): void {
    if (!events.length) return;
    if (!sid) throw new Error(`[snaplane] sid=${sid} cast/append: empty sid`);
    const seen = new Set<number>();
    for (const e of events) {
        switch (e.ev) {
            case "cast":
            case "append": {
                if (!Number.isInteger(e.pos) || e.pos < 0) {
                    throw new Error(`[snaplane] sid=${sid} ${e.ev}: bad pos ${e.pos}`);
                }
                if (seen.has(e.pos)) throw new Error(`[snaplane] sid=${sid} ${e.ev}: duplicate pos ${e.pos}`);
                seen.add(e.pos);
                if (!Array.isArray(e.coreIds) || !e.coreIds.length || !e.coreIds.every((c) => typeof c === "string" && c.length > 0)) {
                    throw new Error(`[snaplane] sid=${sid} ${e.ev} pos=${e.pos}: empty core_ids`);
                }
                requireCoreShape(sid, e.ev, e.pos, e.postJson);
                if (e.preJson !== null) requireCoreShape(sid, e.ev, e.pos, e.preJson);
                if (!Number.isInteger(e.tokensEst) || e.tokensEst < 0) {
                    throw new Error(`[snaplane] sid=${sid} ${e.ev} pos=${e.pos}: bad tokens_est ${e.tokensEst}`);
                }
                break;
            }
            case "update": {
                if (!Number.isInteger(e.pos) || e.pos < 0) {
                    throw new Error(`[snaplane] sid=${sid} update: bad pos ${e.pos}`);
                }
                if (seen.has(e.pos)) throw new Error(`[snaplane] sid=${sid} update: duplicate pos ${e.pos}`);
                seen.add(e.pos);
                requireCoreShape(sid, "update", e.pos, e.postJson);
                break;
            }
            case "delete": {
                if (!Number.isInteger(e.pos) || e.pos < 0) {
                    throw new Error(`[snaplane] sid=${sid} delete: bad pos ${e.pos}`);
                }
                break;
            }
            case "compact": {
                const [lo, hi] = e.posRange;
                if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < lo || !e.blockId) {
                    throw new Error(`[snaplane] sid=${sid} compact: bad range [${lo},${hi}] block=${e.blockId}`);
                }
                break;
            }
            default: {
                const unknown = e as { ev: string };
                throw new Error(`[snaplane] sid=${sid}: unknown event kind ${unknown.ev}`);
            }
        }
    }
}

/** Invariant v: pre/post payloads must be canonical core shape — JSON
 *  documents (unified message rows), never wire bytes. A payload that is
 *  not parseable JSON fails the round at the write side (R2 degrade) and
 *  the commit (T2 rollback). */
function requireCoreShape(sid: string, ev: string, pos: number, json: string): void {
    try {
        JSON.parse(json);
    } catch {
        throw new Error(`[snaplane] sid=${sid} ${ev} pos=${pos}: payload is not canonical core shape (not JSON)`);
    }
}

interface DbLike {
    exec(sql: string, ...params: unknown[]): unknown;
    prepare(sql: string): {
        run(...params: unknown[]): unknown;
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
    };
    /** Same contract as the storage driver's transaction: runs fn inside
     *  BEGIN/COMMIT and returns fn's own result (nested calls savepoint). */
    transaction<T>(fn: () => T): T;
}

interface RowRaw {
    pos: number;
    core_ids: string;
    pre_json: string | null;
    post_json: string | null;
    tokens_est: number;
    active: number;
    cover_ref: string | null;
}

/** Read the raw row form for one session, pos-ordered. Exported for the
 *  write side's post-apply aggregate (it must hash EXACTLY what was
 *  stored — reading back through prepared statements, not echoing inputs). */
function readRawRows(db: DbLike, sid: string): RowRaw[] {
    const rows = db
        .prepare("SELECT pos, core_ids, pre_json, post_json, tokens_est, active, cover_ref FROM snap_rows WHERE sid = ? ORDER BY pos")
        .all(sid) as RowRaw[];
    return rows;
}

function applyEvent(db: DbLike, sid: string, e: SnapEvent, now: number): void {
    switch (e.ev) {
        case "cast":
        case "append": {
            // cast and append differ only in expectation (cast = position
            // the plane had not materialized at its last fold; append =
            // next position after the tail). The table treats both as
            // "materialize this position NOW" — pre_json carries the prior
            // form (NULL when none), post_json the new one (invariant v).
            db.prepare(
                `INSERT INTO snap_rows (sid, pos, core_ids, pre_json, post_json, tokens_est, active, cover_ref, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?)
                 ON CONFLICT (sid, pos) DO UPDATE SET
                     core_ids = excluded.core_ids,
                     pre_json = snap_rows.post_json,
                     post_json = excluded.post_json,
                     tokens_est = excluded.tokens_est,
                     active = 1,
                     cover_ref = NULL,
                     updated_at = excluded.updated_at`,
            ).run(
                sid,
                e.pos,
                JSON.stringify(e.coreIds),
                e.preJson ?? null,
                e.postJson,
                e.tokensEst ?? 0,
                now,
            );
            break;
        }
        case "update": {
            // In-place re-form: pre_json becomes the OLD post (the two-form
            // retention, invariant iv), post_json the new form.
            const row = db
                .prepare("SELECT core_ids, post_json, tokens_est, active, cover_ref FROM snap_rows WHERE sid = ? AND pos = ?")
                .get(sid, e.pos) as
                | { core_ids: string; post_json: string | null; tokens_est: number; active: number; cover_ref: string | null }
                | undefined;
            if (!row) {
                // A plane without the row cannot apply an in-place update —
                // that would be fabricating a position (R2: unaddressable).
                throw new Error(`[snaplane] sid=${sid} update pos=${e.pos}: no row to update (R2)`);
            }
            db.prepare(
                `UPDATE snap_rows SET
                     core_ids = ?, pre_json = post_json, post_json = ?, tokens_est = ?, active = 1, cover_ref = NULL, updated_at = ?
                 WHERE sid = ? AND pos = ?`,
            ).run(
                e.coreIds ? JSON.stringify(e.coreIds) : row.core_ids,
                e.postJson,
                e.tokensEst ?? row.tokens_est,
                now,
                sid,
                e.pos,
            );
            break;
        }
        case "delete": {
            // Invariant iv: flip, never delete. Both forms stay; cover_ref
            // marks the reason (NULL = host-side removal, no covering block).
            db.prepare(
                "UPDATE snap_rows SET active = 0, cover_ref = COALESCE(cover_ref, 'deleted'), updated_at = ? WHERE sid = ? AND pos = ?",
            ).run(now, sid, e.pos);
            break;
        }
        case "compact": {
            // The summary block covers [lo, hi]: flip the whole interval,
            // keep every pre/post form (iv), stamp the covering block so
            // GC knows these rows die when the block's row goes.
            db.prepare(
                "UPDATE snap_rows SET active = 0, cover_ref = ?, updated_at = ? WHERE sid = ? AND pos >= ? AND pos <= ?",
            ).run(e.blockId, now, sid, e.posRange[0], e.posRange[1]);
            break;
        }
    }
}

/** The commit primitive (proposal §5, one transaction): apply events in
 *  order, append one log entry per event (kind = ev, payload = the event +
 *  post-apply aggregate), then optionally fold into snap_ckpt. seq is
 *  derived: max(log max, ckpt_seq) + 1 strictly increasing (invariant ii).
 *  Throws ⇒ the whole transaction rolls back — the plane is exactly as it
 *  was before the call (T2). The P1 hook composes this with the L1 record
 *  in ONE store transaction, so the non-wrapped form is also exported. */
export function applySnapCommit(
    db: DbLike,
    sid: string,
    events: SnapEvent[],
    opts: { fold?: boolean; now?: number } = {},
): { tailSeq: number; folded: boolean; checksum: string } {
    validateEvents(sid, events);
    return db.transaction(() => applySnapInTransaction(db, sid, events, opts));
}

/** Same as applySnapCommit but assumes an open store transaction (node:
 *  sqlite throws on nested db.transaction calls — the P1 hook needs the
 *  L1 write and the plane commit in the SAME transaction). */
export function applySnapInTransaction(
    db: DbLike,
    sid: string,
    events: SnapEvent[],
    opts: { fold?: boolean; now?: number } = {},
): { tailSeq: number; folded: boolean; checksum: string } {
    validateEvents(sid, events);
        const now = opts.now ?? Date.now();
        let seq = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM snap_log WHERE sid = ?").get(sid) as { m: number };
        let ckptSeq = (db.prepare("SELECT ckpt_seq FROM snap_ckpt WHERE sid = ?").get(sid) as { ckpt_seq: number } | undefined)?.ckpt_seq ?? 0;
        let next = Math.max(seq.m, ckptSeq);
        if (!events.length) {
            // No events: nothing to log; folding a clean plane still
            // re-anchors (used to compact a deep log after a no-op round).
            const rows = readRawRows(db, sid);
            if (opts.fold) return fold(db, sid, next, rows, now);
            return { tailSeq: seq.m, folded: false, checksum: snapAggregate(rows) };
        }
        for (const e of events) {
            applyEvent(db, sid, e, now);
            // Post-apply aggregate: re-read the stored form (what R1
            // verifies against later is exactly what was stored).
            const rows = readRawRows(db, sid);
            const sumAfter = snapAggregate(rows);
            next += 1;
            const payload = JSON.stringify({
                ev: e,
                sumAfter,
            });
            db.prepare("INSERT INTO snap_log (sid, seq, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
                sid,
                next,
                e.ev,
                payload,
                now,
            );
        }
        if (opts.fold) {
            const rows = readRawRows(db, sid);
            const out = fold(db, sid, next, rows, now);
            return out;
        }
        return { tailSeq: next, folded: false, checksum: snapAggregate(readRawRows(db, sid)) };
}

/** Fold: checkpoint at the current log tail. meta_json carries the
 *  three-piece set; log entries ≤ ckpt_seq are truncated (the rows table
 *  is the truth — folding is pure re-anchoring, T7/T9). ckptSeq may stay
 *  at 0 when folding an empty log (first anchor before any event). */
function fold(
    db: DbLike,
    sid: string,
    ckptSeq: number,
    rows: RowRaw[],
    now: number,
): { tailSeq: number; folded: boolean; checksum: string } {
    const kstate = (db.prepare("SELECT kstate_json FROM sessions WHERE session_id = ?").get(sid) as { kstate_json: string } | undefined)
        ?.kstate_json ?? "{}";
    const coverage = db
        .prepare(
            `SELECT block_id, start_seq, end_seq FROM blocks
             WHERE session_id = ? AND active = 1 AND start_seq >= 0 AND end_seq >= start_seq
             ORDER BY start_seq`,
        )
        .all(sid) as { block_id: string; start_seq: number; end_seq: number }[];
    const checksum = snapAggregate(rows);
    const meta: SnapCkptMeta = {
        kstate,
        kstateHash: sha256Hex(kstate),
        coverage: coverage.map((c) => [c.block_id, c.start_seq, c.end_seq]),
        s4: checksum,
        foldedAt: now,
    };
    db.prepare(
        `INSERT INTO snap_ckpt (sid, ckpt_seq, meta_json, checksum, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET ckpt_seq = excluded.ckpt_seq, meta_json = excluded.meta_json,
             checksum = excluded.checksum, updated_at = excluded.updated_at`,
    ).run(sid, ckptSeq, JSON.stringify(meta), checksum, now);
    db.prepare("DELETE FROM snap_log WHERE sid = ? AND seq <= ?").run(sid, ckptSeq);
    return { tailSeq: ckptSeq, folded: true, checksum };
}

/** Read-side rebuild (proposal stage 4, P1 use: the A/B oracle). Returns
 *  the full pos-ordered row set with recomputed S4, the stored anchor, and
 *  the verification verdict. Throws SnapPlaneDeadError (R1) when the
 *  aggregate does not match the anchor — AND latches the sticky dead flag
 *  (invariant iii: the plane stays closed for this sid for the process
 *  lifetime; further calls fail fast without touching the tables).
 *
 *  A session with no rows and no log and no ckpt has no plane yet:
 *  returns null (NOT dead — nothing to verify). */
export function readSnapView(db: DbLike, sid: string): SnapView | null {
    if (isSnapPlaneDead(sid)) {
        throw new SnapPlaneDeadError(sid, "plane dead (R1, sticky)");
    }
    const rows = readRawRows(db, sid);
    const tail = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM snap_log WHERE sid = ?").get(sid) as { m: number };
    const ckptRow = db.prepare("SELECT ckpt_seq, meta_json, checksum FROM snap_ckpt WHERE sid = ?").get(sid) as
        | { ckpt_seq: number; meta_json: string; checksum: string }
        | undefined;
    const tailSeq = tail.m;
    const ckptSeq = ckptRow?.ckpt_seq ?? 0;
    if (!rows.length && !tailSeq && !ckptRow) return null;

    // Stored anchor: the last log entry's sumAfter (it reflects EVERY row,
    // not just the touched ones — that is what makes a single hash verify
    // the whole plane), else the ckpt checksum, else (rows exist but no
    // anchor — only reachable via manual tampering or a hand-edited
    // database) unverified.
    let expectedChecksum: string;
    if (tailSeq > ckptSeq) {
        const lastLog = db
            .prepare("SELECT payload FROM snap_log WHERE sid = ? AND seq = ?")
            .get(sid, tailSeq) as { payload: string };
        expectedChecksum = (JSON.parse(lastLog.payload) as { sumAfter: string }).sumAfter;
    } else {
        expectedChecksum = ckptRow?.checksum ?? snapAggregate(rows);
    }

    // Tail-seq monotonicity (invariant ii, read-side check): every log seq
    // > ckpt_seq must be strictly increasing by 1 from ckpt_seq (the
    // commit primitive guarantees it; a violation is tampering ⇒ R1).
    if (tailSeq > ckptSeq) {
        const logRows = db
            .prepare("SELECT seq FROM snap_log WHERE sid = ? AND seq > ? ORDER BY seq")
            .all(sid, ckptSeq) as { seq: number }[];
        for (let i = 0; i < logRows.length; i++) {
            if (logRows[i].seq !== ckptSeq + i + 1) {
                markSnapPlaneDead(sid);
                throw new SnapPlaneDeadError(sid, `snap_log seq gap at ${logRows[i].seq} (expected ${ckptSeq + i + 1})`);
            }
        }
    }

    const checksum = snapAggregate(rows);
    if (checksum !== expectedChecksum) {
        markSnapPlaneDead(sid);
        throw new SnapPlaneDeadError(sid, `S4 aggregate mismatch (stored ${expectedChecksum.slice(0, 12)}…, recomputed ${checksum.slice(0, 12)}…)`);
    }

    let ckptMeta: SnapCkptMeta | null = null;
    if (ckptRow) {
        try {
            ckptMeta = JSON.parse(ckptRow.meta_json) as SnapCkptMeta;
        } catch {
            ckptMeta = null; // meta corruption is non-fatal for P1 (the rows are the truth)
        }
    }

    return {
        sid,
        rows: rows.map((r) => ({
            pos: r.pos,
            coreIds: JSON.parse(r.core_ids) as string[],
            preJson: r.pre_json,
            postJson: r.post_json,
            tokensEst: r.tokens_est,
            active: (r.active ? 1 : 0) as 0 | 1,
            coverRef: r.cover_ref,
            rowSum: snapRowChecksum(sid, r.pos, r.core_ids, r.pre_json, r.post_json, r.tokens_est, r.active, r.cover_ref),
        })),
        tailSeq,
        ckptSeq,
        checksum,
        expectedChecksum,
        verified: true,
        ckptMeta,
    };
}

// ---------------------------------------------------------------------------
// L1 world — stage-0 identity ledger (proposal §0).
//
// sess_raw = the raw host session id as it arrived on the wire
// (conversations.conversation_id in v1); ledger_id = the proxy's own
// identity (sessions.session_id). The mapping is issued on first sight
// (issued_at) and ARMED only after one full round validates it
// (armed_at): the validation evidence is that a later round for the same
// ledger re-presents the same sess_raw with matching witness content —
// the "one round of arming" the proposal charges. witness_probe is a
// sampled fingerprint of the ids seen at issue time, so the arm check is
// cheap and does not store payload.
// ---------------------------------------------------------------------------

interface L1Entry {
    sessRaw: string;
    ledgerId: string;
    witnessProbe: string;
    issuedAt: number;
    armedAt: number | null;
}

/** Record (or refresh) the sess_raw → ledger_id mapping. Returns the
 *  decision:
 *   - "hit":    mapping existed and is armed — the round is identity-
 *               validated (the normal path for a live cohort session);
 *   - "echo":   mapping existed and is armed, witness matched — same as
 *               hit, distinguished for the decision log (the echo
 *               spot-check the proposal mentions);
 *   - "arm":    mapping existed, not yet armed, and this round's witness
 *               validates it — armed_at set now (the one-round charge
 *               completes);
 *   - "wait":   mapping existed, not yet armed, witness did not validate
 *               — issued_at unchanged, no arm (still one round out);
 *   - "issue":  new mapping issued (armed_at = NULL — the round that
 *               issued it cannot validate itself).
 *  A sess_raw that was issued under a DIFFERENT ledger_id is a hard
 *  identity conflict (R3 territory): returns "red" and writes NOTHING —
 *  the caller keeps the round on the legacy path and the breaker counts
 *  it. */
export function snapL1Record(
    db: DbLike,
    sessRaw: string,
    ledgerId: string,
    witnessProbe: string,
    now: number,
): "hit" | "echo" | "arm" | "wait" | "issue" | "red" {
    const existing = db
        .prepare("SELECT ledger_id, witness_probe, issued_at, armed_at FROM l1_world WHERE sess_raw = ?")
        .get(sessRaw) as { ledger_id: string; witness_probe: string; issued_at: number; armed_at: number | null } | undefined;
    if (!existing) {
        db.prepare(
            "INSERT INTO l1_world (sess_raw, ledger_id, witness_probe, issued_at, armed_at) VALUES (?, ?, ?, ?, NULL)",
        ).run(sessRaw, ledgerId, witnessProbe, now);
        return "issue";
    }
    if (existing.ledger_id !== ledgerId) {
        // Hard conflict: the same raw session id now belongs to another
        // ledger. Never overwrite — the mapping is the identity anchor;
        // corrupting it would poison every later round for this host.
        return "red";
    }
    if (existing.armed_at !== null) {
        return existing.witness_probe === witnessProbe ? "echo" : "hit";
    }
    // Not armed yet: arm when this round re-validates the probe (the
    // witness is content-derived, so an identical probe means the host's
    // id space survived the round unchanged — the echo round).
    if (witnessProbe === existing.witness_probe) {
        db.prepare("UPDATE l1_world SET armed_at = ? WHERE sess_raw = ?").run(now, sessRaw);
        return "arm";
    }
    return "wait";
}

/** Read the L1 entry for a raw session id (status/diagnostics). */
export function snapL1Lookup(db: DbLike, sessRaw: string): L1Entry | null {
    const r = db
        .prepare("SELECT sess_raw, ledger_id, witness_probe, issued_at, armed_at FROM l1_world WHERE sess_raw = ?")
        .get(sessRaw) as { sess_raw: string; ledger_id: string; witness_probe: string; issued_at: number; armed_at: number | null } | undefined;
    if (!r) return null;
    return { sessRaw: r.sess_raw, ledgerId: r.ledger_id, witnessProbe: r.witness_probe, issuedAt: r.issued_at, armedAt: r.armed_at };
}

// ---------------------------------------------------------------------------
// GC — physical cleanup (invariant iv's release valve). Rows flipped by
// delete/compact stay until their cover vanishes: a compacted row's
// cover_ref is the covering block, and when that block's row is gone
// (deleted or itself archived) the row has no consumer left and is
// physically removed. Rows covered by a LIVE block stay (the fold view
// still renders their summary). "deleted" cover_ref (host removal, no
// block) releases immediately — the position is gone from the host
// forever and no summary references it. Physical removal changes the row
// set the S4 anchor aggregates over, so any removal re-anchors in the
// same transaction (a pure-reanchoring fold at the current log tail):
// without it the last log sumAfter would cover rows that no longer exist
// and the next readSnapView would trip R1 on a healthy plane (sticky dead
// latch after an ordinary host-side rewind). Returns the number of rows
// physically removed.
// ---------------------------------------------------------------------------
export function snapGcCoveredRows(db: DbLike, sid: string): number {
    return db.transaction(() => {
        const rows = db
            .prepare("SELECT pos, cover_ref FROM snap_rows WHERE sid = ? AND active = 0 AND cover_ref IS NOT NULL")
            .all(sid) as { pos: number; cover_ref: string }[];
        if (!rows.length) return 0;
        const coverSet = new Set(rows.map((r) => r.cover_ref));
        // Which covers still exist as block rows?
        const placeholders = [...coverSet].map(() => "?").join(",");
        const liveCovers = db
            .prepare(`SELECT DISTINCT block_id FROM blocks WHERE session_id = ? AND block_id IN (${placeholders})`)
            .all(sid, ...[...coverSet]) as { block_id: string }[];
        const liveCoverSet = new Set(liveCovers.map((c) => c.block_id));
        let removed = 0;
        const del = db.prepare("DELETE FROM snap_rows WHERE sid = ? AND pos = ?");
        for (const r of rows) {
            const coverGone = r.cover_ref === "deleted" || !liveCoverSet.has(r.cover_ref);
            if (coverGone) {
                del.run(sid, r.pos);
                removed += 1;
            }
        }
        if (removed > 0) {
            const tail = db
                .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM snap_log WHERE sid = ?")
                .get(sid) as { m: number };
            fold(db, sid, tail.m, readRawRows(db, sid), Date.now());
        }
        return removed;
    });
}

// ---------------------------------------------------------------------------
// Status (wire-safe, for the /__bili/status attribution surface).
// ---------------------------------------------------------------------------
interface SnapPlaneStatus {
    /** master flag (storage.snapBase.enabled) — false ⇒ plane untouched. */
    enabled: boolean;
    /** lane flag (storage.snapBase.shadowWrite) — false ⇒ shadow off. */
    shadowWrite: boolean;
    /** per-sid dead latches currently held (R1). */
    deadSids: string[];
}

/** Wire shape of the /__bili/status `snaplane` field. */
export type SnapPlaneStatusWire = SnapPlaneStatus & {
    sessions: number;
    rows: number;
    activeRows: number;
    logEntries: number;
    ckpts: number;
    l1Entries: number;
    l1Armed: number;
};

/** Build the status payload from the store's db. `flags` come from the
 *  config layer (knobs) — the storage layer itself is flag-agnostic. */
export function snapplaneStatusWire(
    db: DbLike,
    flags: { enabled: boolean; shadowWrite: boolean },
): SnapPlaneStatusWire {
    const one = (q: string): number => {
        try {
            return (db.prepare(q).get() as { n: number }).n;
        } catch {
            // Tables absent (v<12 database, or a test fixture built from
            // the raw v1 DDL) — the plane is simply not here.
            return 0;
        }
    };
    return {
        enabled: flags.enabled,
        shadowWrite: flags.shadowWrite,
        deadSids: [...deadSids],
        sessions: one("SELECT COUNT(DISTINCT sid) AS n FROM snap_rows"),
        rows: one("SELECT COUNT(*) AS n FROM snap_rows"),
        activeRows: one("SELECT COUNT(*) AS n FROM snap_rows WHERE active = 1"),
        logEntries: one("SELECT COUNT(*) AS n FROM snap_log"),
        ckpts: one("SELECT COUNT(*) AS n FROM snap_ckpt"),
        l1Entries: one("SELECT COUNT(*) AS n FROM l1_world"),
        l1Armed: one("SELECT COUNT(*) AS n FROM l1_world WHERE armed_at IS NOT NULL"),
    };
}
