/**
 * snap.ts — #5874 snapshot foundation v2 (pure-incremental, 2026-11-15
 * owner ruling): the stage-0 IDENTITY ledger only.
 *
 * The original four-table plane (l1_world / snap_rows / snap_log /
 * snap_ckpt) was retired before merge: the per-position materialized state
 * (snap_rows), the message-level event stream (snap_log) and the fold
 * checkpoint (snap_ckpt) are replaced by the append-only substrate
 * (messages × blocks × refs) plus two small additive tables — fold_journal
 * (fold/unpin decisions with an input aggregate hash) and egress_snapshot
 * (a cut-point materialized prefix, CAS-referenced). The only plane piece
 * that survives verbatim is the L1 world table above: the stage-0 identity
 * gate (echo/probe/issue, the witness probe, the R3 breaker latch, the
 * element-level msgid envelope for M2 delta inbound) is independent of how
 * the compressed state is stored, and it is what makes M2 parse only new
 * spans in the first place.
 *
 * Zero kernel changes remain a hard constraint; this file does no
 * compression work and never serves bytes — it decides identity only.
 */

import { createHash } from "node:crypto";
import type { WorldWindow } from "../snapshot/types.js";

/** Minimal db surface so the identity ledger stays type-coupled to the
 *  storage driver without importing it (same contract as the driver's
 *  prepared-statement API). */
export interface DbLike {
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
// 2×2 (proposal §4.0) — the element-level WORLD CURSOR on the same row.
//
// The session-level path above (snapL1Record/snapL1Lookup) is the identity
// ANCHOR (sess_raw → ledger_id + one-round arming). The 2×2 stage 0 adds,
// on the same row, the per-element world cursor: the head + tail id windows
// of the previous turn's host array plus its length and the append-only pos
// frontier (#7064 slimming — the full {id,pos} envelope is gone). The
// stage-0 decision function (src/snapshot/identity.ts matchWindow) runs on
// this cursor; M2 delta inbound appends onto it.
// ---------------------------------------------------------------------------

/** Read the element-level world cursor for a raw session id (null when the
 *  l1 row is absent; window null when present but not yet issued). */
export function snapL1WindowRead(db: DbLike, sessRaw: string): { window: WorldWindow | null, issuedAt: number } | null {
    const r = db
        .prepare("SELECT tail_json, head_json, count, max_pos, issued_at FROM l1_world WHERE sess_raw = ?")
        .get(sessRaw) as { tail_json: string | null; head_json: string | null; count: number | null; max_pos: number | null; issued_at: number } | undefined;
    if (!r) return null;
    if (r.tail_json === null || r.count === null) return { window: null, issuedAt: r.issued_at };
    return {
        window: {
            tailIds: JSON.parse(r.tail_json) as string[],
            headIds: JSON.parse(r.head_json ?? "[]") as string[],
            count: r.count,
            maxPos: r.max_pos ?? r.count,
        },
        issuedAt: r.issued_at,
    };
}

/** Persist the element-level world cursor for a raw session id (UPDATE only
 *  — the l1 row itself is created by snapL1Record; a missing row is a
 *  programming error and is surfaced, not silently created). */
export function snapL1WindowUpsert(db: DbLike, sessRaw: string, window: WorldWindow): void {
    const res = db
        .prepare("UPDATE l1_world SET tail_json = ?, head_json = ?, count = ?, max_pos = ? WHERE sess_raw = ?")
        .run(JSON.stringify(window.tailIds), JSON.stringify(window.headIds), window.count, window.maxPos, sessRaw) as { changes: number };
    if (res.changes === 0) throw new Error(`snapL1WindowUpsert: no l1_world row for sess_raw ${sessRaw.slice(0, 12)}… (record it first)`);
}

/** #6181 M3: read the persisted R3 breaker latch (true when the sid's
 *  breaker latched in a PREVIOUS process — a restart must not re-arm a
 *  misbehaving host). Missing row or NULL → false. */
export function snapR3LatchedRead(db: DbLike, sessRaw: string): boolean {
    const r = db
        .prepare("SELECT r3_latched_at FROM l1_world WHERE sess_raw = ?")
        .get(sessRaw) as { r3_latched_at: number | null } | undefined;
    return !!r && !!r.r3_latched_at;
}

/** #6181 M3: persist the R3 breaker latch. UPSERT (not UPDATE-only) — the
 *  first fault of a fresh session happens BEFORE its stage-0 snapL1Record
 *  call (the R3 check runs at pin validation), so an UPDATE-only latch
 *  would silently no-op for sessions with no l1 row yet. */
export function snapR3LatchWrite(db: DbLike, sessRaw: string, nowMs: number): void {
    // Upsert — the first fault of a fresh session happens BEFORE its stage-0
    // snapL1Record call (the R3 check runs at pin validation), so an
    // UPDATE-only latch would silently no-op for sessions with no l1 row yet.
    // ledger_id takes the placeholder sessRaw and witness_probe/issued_at the
    // sentinel values: the latch row's envelope stays NULL until a later
    // (repaired) stage-0 snapL1Record upsert carries the real ledger id and
    // witness. A latched session never re-arms (runStage0 checks the persisted
    // latch before any store call), so the placeholder can never hit the
    // "red" ledger-conflict path of snapL1Record.
    db.prepare("INSERT INTO l1_world (sess_raw, ledger_id, witness_probe, issued_at, r3_latched_at) VALUES (?, ?, '', ?, ?) ON CONFLICT(sess_raw) DO UPDATE SET r3_latched_at = excluded.r3_latched_at, ledger_id = COALESCE(l1_world.ledger_id, excluded.ledger_id), witness_probe = COALESCE(NULLIF(l1_world.witness_probe, ''), excluded.witness_probe)").run(sessRaw, sessRaw, nowMs, nowMs);
}

/** #6785 review: operator escape hatch — clear the persisted R3 latch.
 *  Returns the ledger id the row binds (the placeholder `sessRaw` until a
 *  later stage-0 snapL1Record upsert carries the real id) so the caller can
 *  also clear the in-memory breaker for every resolvable sid; null when no
 *  l1 row exists for the raw id. */
export function snapR3LatchClear(db: DbLike, sessRaw: string): string | null {
    const r = db.prepare("SELECT ledger_id FROM l1_world WHERE sess_raw = ?").get(sessRaw) as { ledger_id: string } | undefined;
    if (!r) return null;
    db.prepare("UPDATE l1_world SET r3_latched_at = NULL WHERE sess_raw = ?").run(sessRaw);
    return r.ledger_id;
}

/** #6785 review: the persisted-latch roster — operators must be able to SEE
 *  which raw session ids are stuck (and since when) before they can unstick
 *  one. Empty (not null) when none are latched. */
export function snapR3LatchedList(db: DbLike): Array<{ sessRaw: string; ledgerId: string; latchedAt: number }> {
    return (db
        .prepare("SELECT sess_raw, ledger_id, r3_latched_at FROM l1_world WHERE r3_latched_at IS NOT NULL ORDER BY r3_latched_at DESC")
        .all() as Array<{ sess_raw: string; ledger_id: string; r3_latched_at: number }>)
        .map((r) => ({ sessRaw: r.sess_raw, ledgerId: r.ledger_id, latchedAt: r.r3_latched_at }));
}

// ---------------------------------------------------------------------------
// Fold journal — append-only fold decisions with an input aggregate hash.
//
// One row per compression fold (a block that first lands in the ledger).
// The row pins: the seq interval the fold covers, the id set it was
// computed over, and input_hash — sha256 over the covered message rows
// (seq, msg_id, content_hash), ALL generations (live AND retired — the
// fold's own ingest retires its covered rows in the same transaction, so a
// live-only aggregate would be empty at fold time), in seq order. The
// egress read re-derives the same aggregate from the current rows; a
// mismatch means the fold's source moved (content rewrite, a new-generation
// row, row loss) and the round degrades to the legacy derive path — 降级不猜.
//
// UNPIN is not a row kind, it is DERIVED state: foldUnpins below is the
// single pure predicate. Derived, not stored — the journal stays
// append-only and there is no second write to drift from the first.
// ---------------------------------------------------------------------------

export interface FoldJournalRow {
    sessionId: string;
    jseq: number;
    blockId: string;
    startSeq: number;
    endSeq: number;
    inputHash: string;
    createdAt: number;
}

/** Re-derive the fold input aggregate over the fold's ROW RANGE — all
 *  generations in [startSeq, endSeq] (no retired filter: the fold's own
 *  ingest retires the covered rows in the same transaction, so the
 *  aggregate must survive retirement to verify against later; tombstones
 *  hold their seq, in-place swaps change content_hash at the same seq —
 *  any source movement in the range changes the digest). #7064 slimming:
 *  the scope is the RANGE itself — the id list (covered_ids) is gone; an
 *  id re-emerging live PAST end_seq moves the fold to the derive path via
 *  the foldUnpins predicate instead (same safe direction). Order-stable
 *  (ORDER BY seq) and covers seq too. null when the range is empty. */
export function foldInputHash(
    db: DbLike,
    sessionId: string,
    startSeq: number,
    endSeq: number,
): string | null {
    if (endSeq < startSeq) return null;
    const rows = db
        .prepare(`SELECT seq, msg_id, content_hash FROM messages
                  WHERE session_id = ? AND seq BETWEEN ? AND ?
                  ORDER BY seq`)
        .all(sessionId, startSeq, endSeq) as Array<{ seq: number; msg_id: string; content_hash: string }>;
    if (rows.length === 0) return null;
    const h = createHash("sha256");
    for (const r of rows) h.update(`${r.seq}\u0000${r.msg_id}\u0000${r.content_hash}\n`);
    return h.digest("hex");
}

/** Append a fold row for a block that first landed (idempotent on
 *  (session_id, block_id) — a re-ingest of the same block is a no-op, and
 *  a replaced block keeps its FIRST fold row: the journal records the
 *  decision point, not the latest bytes, and the hash check is what
 *  notices a replacement). inputHash null is stored as the empty string —
 *  the column is NOT NULL and empty is the "unverifiable" sentinel the
 *  read side treats as a mismatch. */
export function appendFoldJournal(
    db: DbLike,
    sessionId: string,
    blockId: string,
    startSeq: number,
    endSeq: number,
    inputHash: string | null,
    nowMs: number,
): void {
    db.prepare(
        `INSERT OR IGNORE INTO fold_journal (session_id, jseq, kind, block_id, start_seq, end_seq, input_hash, created_at)
         VALUES (?, (SELECT COALESCE(MAX(jseq), 0) + 1 FROM fold_journal WHERE session_id = ?), 'fold', ?, ?, ?, ?, ?)`,
    ).run(sessionId, sessionId, blockId, startSeq, endSeq, inputHash ?? "", nowMs);
}

/** All fold rows for a session, jseq order (the journal IS the order). */
export function foldJournalRows(db: DbLike, sessionId: string): FoldJournalRow[] {
    const rows = db
        .prepare("SELECT session_id, jseq, block_id, start_seq, end_seq, input_hash, created_at FROM fold_journal WHERE session_id = ? ORDER BY jseq")
        .all(sessionId) as Array<{ session_id: string; jseq: number; block_id: string; start_seq: number; end_seq: number; input_hash: string; created_at: number }>;
    return rows.map((r) => ({
        sessionId: r.session_id,
        jseq: r.jseq,
        blockId: r.block_id,
        startSeq: r.start_seq,
        endSeq: r.end_seq,
        inputHash: r.input_hash,
        createdAt: r.created_at,
    }));
}

/** The unpin predicate — the single place a fold is judged dead. A fold is
 *  UNPINNED iff any of:
 *   1. its block is not currently active (deactivated, superseded, or the
 *      row is gone — compaction cleanup, session prune);
 *   2. a covered id has a LIVE row again — the steady state of an
 *      ACTIVE fold is that every covered row is RETIRED (the fold's own
 *      ingest retires them: the presented history carries the summary, not
 *      the originals). #7064 slimming re-expresses the check without the
 *      covered-id list, by RANGE: (a) any row LIVE in [startSeq, endSeq]
 *      (a #4390 in-place reactivation — a rewind unwound the fold and the
 *      D-lane's tail authority now carries those messages, not the
 *      summary); (b) any id that had a row in the range holding a LIVE row
 *      PAST end_seq (re-emergence: the old generation was tombstoned and
 *      the id re-issued further down the log — an edit or a rewind
 *      re-covering the id beyond the fold). Both are the same safe
 *      direction as before: degrade to the derive path, no byte risk.
 *  Takes the db directly (two small range probes per fold). Returns the set
 *  of UNPINNED block ids (empty = everything still pinned). */
export function foldUnpins(
    db: DbLike,
    journal: readonly FoldJournalRow[],
    activeBlocks: ReadonlySet<string>,
): Set<string> {
    const unpinned = new Set<string>();
    const liveIn = db.prepare(
        "SELECT 1 FROM messages WHERE session_id = ? AND retired_at IS NULL AND seq BETWEEN ? AND ? LIMIT 1",
    );
    const reEmerged = db.prepare(
        `SELECT 1 FROM messages m
         WHERE m.session_id = ? AND m.retired_at IS NULL AND m.seq > ?
           AND m.msg_id IN (SELECT msg_id FROM messages k
                            WHERE k.session_id = ? AND k.seq BETWEEN ? AND ?)
         LIMIT 1`,
    );
    for (const f of journal) {
        if (!activeBlocks.has(f.blockId)) {
            unpinned.add(f.blockId);
            continue;
        }
        if (liveIn.get(f.sessionId, f.startSeq, f.endSeq) !== undefined) {
            unpinned.add(f.blockId);
            continue;
        }
        if (reEmerged.get(f.sessionId, f.endSeq, f.sessionId, f.startSeq, f.endSeq) !== undefined) {
            unpinned.add(f.blockId);
        }
    }
    return unpinned;
}

// ---------------------------------------------------------------------------
// Egress snapshot — the cut-point materialized prefix (#5874 v2, step 3).
//
// One append-only row per CUT (fold boundary / every-K / user-message
// boundary). A row pins the DERIVED stable prefix (D-lane buildView output
// up to the seam, anchors included) as a content-CAS reference plus the input
// aggregate the prefix was derived from. The egress read re-derives the
// aggregate BEFORE trusting the bytes; a mismatch degrades the round to the
// live derive (never sticky, never partial).
//
// Aggregate semantics (egressInputHash, #7064 slimming): the scope is the
// WATERMARK itself — the LIVE rows with seq <= watermark, order-stable. At
// cut time the watermark is the max live seq of the pinned set, so the hash
// covers exactly the prefix rows; on re-read any change relevant to the
// prefix moves the digest (an edit retires the old in-range row and mints
// the new one past the watermark; an in-place swap changes content_hash at
// the same seq; a rewind crossing the prefix retires/reactivates in-range
// rows), while pure TAIL growth beyond the watermark does not. A
// fold-CROSSING re-render (a fold landing after the cut over the prefix)
// is applied by the lane via foldUnpins/foldJournalRows, which alone knows
// fold timing relative to the cut — the store primitive here verifies
// bytes only.
// ---------------------------------------------------------------------------

export interface EgressSnapshotRow {
    sessionId: string;
    snapSeq: number;
    watermark: number;
    inputHash: string;
    prefixRef: string | null;
    lastStableId: string;
    createdAt: number;
    /** #6785 review (owner): the session's message-mutation revision this
     *  row was cut at (egress_scope_rev). NULL = pre-upgrade row (the read
     *  side verifies once, as before). */
    scopeRev: number | null;
}

/** A verified egress read hit: the materialized stable-prefix bytes (CAS
 *  content, derived view — NOT client wire bytes) plus the seam id and the
 *  input aggregate they were derived from. */
export interface EgressReadHit {
    prefix: string;
    lastStableId: string;
    inputHash: string;
}

/** The egress input aggregate over the live rows at seq <= watermark
 *  (order-stable, seq + msg_id + content_hash). null when no rows exist. */
export function egressInputHash(
    db: DbLike,
    sessionId: string,
    watermark: number,
): string | null {
    const rows = db.prepare(
        `SELECT seq, msg_id, content_hash FROM messages
         WHERE session_id = ? AND retired_at IS NULL AND seq <= ?
         ORDER BY seq`,
    ).all(sessionId, watermark) as Array<{ seq: number; msg_id: string; content_hash: string }>;
    if (rows.length === 0) return null;
    const h = createHash("sha256");
    for (const r of rows) h.update(`${r.seq}\u0000${r.msg_id}\u0000${r.content_hash}\n`);
    return h.digest("hex");
}

/** #6785 review (owner): per-session revision of the message table —
 *  bumped on every write that can change the egress input aggregate
 *  (retire / unretire / content_hash edit / hard delete / archive restore).
 *  Plain appends never bump: seq is monotonic, so a new row always lands
 *  BEYOND every existing watermark and cannot enter any stored scope.
 *  0 = no such mutation has been recorded. One indexed row per session;
 *  both ops are O(1) regardless of history size. */
export function egressScopeRev(db: DbLike, sessionId: string): number {
    try {
        const row = db.prepare("SELECT rev FROM egress_scope_rev WHERE session_id = ?")
            .get(sessionId) as { rev: number } | undefined;
        return row?.rev ?? 0;
    } catch {
        return 0; // table missing (pre-upgrade open mid-migration) ⇒ verify normally
    }
}

/** Bump the session's egress mutation revision (called beside each
 *  hash-input-mutating write; see egressScopeRev for the set). */
export function bumpEgressScopeRev(db: DbLike, sessionId: string): void {
    try {
        db.prepare(
            `INSERT INTO egress_scope_rev (session_id, rev) VALUES (?, 1)
             ON CONFLICT(session_id) DO UPDATE SET rev = rev + 1`,
        ).run(sessionId);
    } catch {
        /* rev unavailable ⇒ the read side re-verifies the full aggregate anyway */
    }
}

/** Append one egress cut row (snap_seq is per-session, max+1). Returns the
 *  new snap_seq. */
export function appendEgressSnapshot(
    db: DbLike,
    sessionId: string,
    watermark: number,
    inputHash: string,
    prefixRef: string | null,
    lastStableId: string,
    createdAt: number,
    scopeRev: number,
): number {
    const row = db.prepare("SELECT COALESCE(MAX(snap_seq), 0) AS m FROM egress_snapshot WHERE session_id = ?")
        .get(sessionId) as { m: number };
    const snapSeq = row.m + 1;
    db.prepare(
        `INSERT INTO egress_snapshot (session_id, snap_seq, watermark, input_hash, prefix_ref, last_stable_id, created_at, scope_rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, snapSeq, watermark, inputHash, prefixRef, lastStableId, createdAt, scopeRev);
    return snapSeq;
}

/** The newest egress cut row for a session (the only one a read can serve),
 *  or null. */
export function egressLatestRow(db: DbLike, sessionId: string): EgressSnapshotRow | null {
    const row = db.prepare(
        `SELECT session_id, snap_seq, watermark, input_hash, prefix_ref, last_stable_id, created_at, scope_rev
         FROM egress_snapshot WHERE session_id = ? ORDER BY snap_seq DESC LIMIT 1`,
    ).get(sessionId) as { session_id: string; snap_seq: number; watermark: number; input_hash: string; prefix_ref: string | null; last_stable_id: string; created_at: number; scope_rev: number | null } | undefined;
    if (!row) return null;
    return {
        sessionId: row.session_id,
        snapSeq: row.snap_seq,
        watermark: row.watermark,
        inputHash: row.input_hash,
        prefixRef: row.prefix_ref,
        lastStableId: row.last_stable_id,
        createdAt: row.created_at,
        scopeRev: row.scope_rev,
    };
}
