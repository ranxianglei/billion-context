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
// 2×2 (proposal §4.0) — the element-level WORLD ENVELOPE on the same row.
//
// The session-level path above (snapL1Record/snapL1Lookup) is the identity
// ANCHOR (sess_raw → ledger_id + one-round arming). The 2×2 stage 0 adds,
// on the same row, the per-element msgid envelope: an ordered [{id, pos}]
// canon binding every host msgid to its append-only ledger pos. The stage-0
// decision function (src/snapshot/identity.ts matchWorld) runs on this
// envelope; M2 delta inbound parses only the new spans it commits.
// ---------------------------------------------------------------------------

interface L1Envelope {
    /** The canon envelope JSON: an array of {id, pos} in host order.
     *  Null when the session is still on the session-level v1 path (the
     *  2×2 element world has not been issued for it yet). */
    envelopeJson: string | null;
    /** sha256 of the canonical envelope (fast mismatch before the walk). */
    envelopeChecksum: string | null;
}

/** Read the element-level envelope for a raw session id (null when the l1
 *  row is absent; envelopeJson null when present but not yet 2×2-issued). */
export function snapL1EnvelopeRead(db: DbLike, sessRaw: string): L1Envelope | null {
    const r = db
        .prepare("SELECT envelope_json, envelope_checksum FROM l1_world WHERE sess_raw = ?")
        .get(sessRaw) as { envelope_json: string | null; envelope_checksum: string | null } | undefined;
    if (!r) return null;
    return { envelopeJson: r.envelope_json, envelopeChecksum: r.envelope_checksum };
}

/** Persist the element-level envelope for a raw session id (UPDATE only —
 *  the l1 row itself is created by snapL1Record; a missing row is a
 *  programming error and is surfaced, not silently created). */
export function snapL1EnvelopeUpsert(db: DbLike, sessRaw: string, envelopeJson: string, envelopeChecksum: string): void {
    const res = db
        .prepare("UPDATE l1_world SET envelope_json = ?, envelope_checksum = ? WHERE sess_raw = ?")
        .run(envelopeJson, envelopeChecksum, sessRaw) as { changes: number };
    if (res.changes === 0) throw new Error(`snapL1EnvelopeUpsert: no l1_world row for sess_raw ${sessRaw.slice(0, 12)}… (record it first)`);
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
    coveredIds: string[];
    inputHash: string;
    createdAt: number;
}

/** Re-derive the fold input aggregate over the covered ids' rows — ALL
 *  generations (no retired filter: the fold's own ingest retires the
 *  covered rows in the same transaction, so the aggregate must survive
 *  retirement to verify against later). Order-stable (ORDER BY seq) and
 *  covers seq too, so any source movement changes the digest — a new
 *  generation row (edit/rewind re-issue), an in-place content swap, or row
 *  loss. null when the id set is empty or no rows exist at all. */
export function foldInputHash(
    db: DbLike,
    sessionId: string,
    coveredIds: readonly string[],
): string | null {
    if (coveredIds.length === 0) return null;
    const rows = db
        .prepare(`SELECT seq, msg_id, content_hash FROM messages
                  WHERE session_id = ? AND msg_id IN (${coveredIds.map(() => "?").join(", ")})
                  ORDER BY seq`)
        .all(sessionId, ...coveredIds) as Array<{ seq: number; msg_id: string; content_hash: string }>;
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
    coveredIds: readonly string[],
    inputHash: string | null,
    nowMs: number,
): void {
    db.prepare(
        `INSERT OR IGNORE INTO fold_journal (session_id, jseq, kind, block_id, start_seq, end_seq, covered_ids, input_hash, created_at)
         VALUES (?, (SELECT COALESCE(MAX(jseq), 0) + 1 FROM fold_journal WHERE session_id = ?), 'fold', ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, sessionId, blockId, startSeq, endSeq, JSON.stringify(coveredIds), inputHash ?? "", nowMs);
}

/** All fold rows for a session, jseq order (the journal IS the order). */
export function foldJournalRows(db: DbLike, sessionId: string): FoldJournalRow[] {
    const rows = db
        .prepare("SELECT session_id, jseq, block_id, start_seq, end_seq, covered_ids, input_hash, created_at FROM fold_journal WHERE session_id = ? ORDER BY jseq")
        .all(sessionId) as Array<{ session_id: string; jseq: number; block_id: string; start_seq: number; end_seq: number; covered_ids: string; input_hash: string; created_at: number }>;
    return rows.map((r) => ({
        sessionId: r.session_id,
        jseq: r.jseq,
        blockId: r.block_id,
        startSeq: r.start_seq,
        endSeq: r.end_seq,
        coveredIds: JSON.parse(r.covered_ids) as string[],
        inputHash: r.input_hash,
        createdAt: r.created_at,
    }));
}

/** The unpin predicate — the single place a fold is judged dead. A fold is
 *  UNPINNED iff any of:
 *   1. its block is not currently active (deactivated, superseded, or the
 *      row is gone — compaction cleanup, session prune);
 *   2. a covered id has a LIVE row at ANY seq — the steady state of an
 *      ACTIVE fold is that every covered row is RETIRED (the fold's own
 *      ingest retires them: the presented history carries the summary, not
 *      the originals), so any covered row live again means the fold's
 *      summary anchor no longer exclusively owns that id's history — either
 *      a RE-EMERGENCE past end_seq (new generation: the old one was
 *      tombstoned and the id re-issued further down the log — an edit or a
 *      rewind re-covering the id beyond the fold) or an IN-INTERVAL live
 *      row (a #4390 in-place reactivation: a rewind unwound the fold and
 *      the D-lane's tail authority now carries those messages, not the
 *      summary). A host shape that legitimately keeps a covered row live
 *      after the fold degrades such sessions to the derive path (safe
 *      direction, no byte risk — it is exactly today's flag-off behavior).
 *  Pure: no db, no writes — callers feed it the live rows (session-wide is
 *  fine; the predicate intersects with the covered ids) and the active
 *  block ids they already loaded. Returns the set of UNPINNED block ids
 *  (empty = everything still pinned). */
export function foldUnpins(
    journal: readonly FoldJournalRow[],
    liveRows: readonly { msgId: string; seq: number }[],
    activeBlocks: ReadonlySet<string>,
): Set<string> {
    const unpinned = new Set<string>();
    const liveMsgIds = new Set<string>();
    for (const r of liveRows) liveMsgIds.add(r.msgId);
    for (const f of journal) {
        if (!activeBlocks.has(f.blockId)) {
            unpinned.add(f.blockId);
            continue;
        }
        for (const id of f.coveredIds) {
            if (liveMsgIds.has(id)) {
                unpinned.add(f.blockId);
                break;
            }
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
// Aggregate semantics (egressInputHash): with a NON-EMPTY id set it covers
// ALL generations of exactly those ids (no retired filter, no seq bound) —
// a content rewrite or a new-generation row (edit/rewind re-issue) moves it,
// while a pure retirement (the fold's own sweep) or TAIL growth beyond the
// prefix does not. With an EMPTY id set it covers the live rows at
// seq <= watermark (the "whole prefix window" probe). The fold-CROSSING gate
// (a fold that lands after the cut covering a prefix id re-renders the
// bytes) is applied by the lane, which alone knows fold timing relative to
// the cut — the store primitive here verifies bytes only.
// ---------------------------------------------------------------------------

export interface EgressSnapshotRow {
    sessionId: string;
    snapSeq: number;
    watermark: number;
    inputHash: string;
    ids: string[];
    prefixRef: string | null;
    lastStableId: string;
    createdAt: number;
}

/** A verified egress read hit: the materialized stable-prefix bytes (CAS
 *  content, derived view — NOT client wire bytes) plus the seam id and the
 *  input aggregate they were derived from. */
export interface EgressReadHit {
    prefix: string;
    lastStableId: string;
    inputHash: string;
}

/** The egress input aggregate over the pinned id set (all generations, seq
 *  order) — or, with an empty id set, over the live rows at seq <= watermark.
 *  null when no rows exist at all. */
export function egressInputHash(
    db: DbLike,
    sessionId: string,
    watermark: number,
    ids: readonly string[],
): string | null {
    const rows: Array<{ seq: number; msg_id: string; content_hash: string }> = ids.length === 0
        ? (db.prepare(
            `SELECT seq, msg_id, content_hash FROM messages
             WHERE session_id = ? AND retired_at IS NULL AND seq <= ?
             ORDER BY seq`,
        ).all(sessionId, watermark) as Array<{ seq: number; msg_id: string; content_hash: string }>)
        : (db.prepare(
            `SELECT seq, msg_id, content_hash FROM messages
             WHERE session_id = ? AND msg_id IN (${ids.map(() => "?").join(",")})
             ORDER BY seq`,
        ).all(sessionId, ...ids) as Array<{ seq: number; msg_id: string; content_hash: string }>);
    if (rows.length === 0) return null;
    const h = createHash("sha256");
    for (const r of rows) h.update(`${r.seq}\u0000${r.msg_id}\u0000${r.content_hash}\n`);
    return h.digest("hex");
}

/** Append one egress cut row (snap_seq is per-session, max+1). Returns the
 *  new snap_seq. */
export function appendEgressSnapshot(
    db: DbLike,
    sessionId: string,
    watermark: number,
    inputHash: string,
    ids: readonly string[],
    prefixRef: string | null,
    lastStableId: string,
    createdAt: number,
): number {
    const row = db.prepare("SELECT COALESCE(MAX(snap_seq), 0) AS m FROM egress_snapshot WHERE session_id = ?")
        .get(sessionId) as { m: number };
    const snapSeq = row.m + 1;
    db.prepare(
        `INSERT INTO egress_snapshot (session_id, snap_seq, watermark, input_hash, ids_json, prefix_ref, last_stable_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, snapSeq, watermark, inputHash, JSON.stringify(ids), prefixRef, lastStableId, createdAt);
    return snapSeq;
}

/** The newest egress cut row for a session (the only one a read can serve),
 *  or null. */
export function egressLatestRow(db: DbLike, sessionId: string): EgressSnapshotRow | null {
    const row = db.prepare(
        `SELECT session_id, snap_seq, watermark, input_hash, ids_json, prefix_ref, last_stable_id, created_at
         FROM egress_snapshot WHERE session_id = ? ORDER BY snap_seq DESC LIMIT 1`,
    ).get(sessionId) as { session_id: string; snap_seq: number; watermark: number; input_hash: string; ids_json: string; prefix_ref: string | null; last_stable_id: string; created_at: number } | undefined;
    if (!row) return null;
    return {
        sessionId: row.session_id,
        snapSeq: row.snap_seq,
        watermark: row.watermark,
        inputHash: row.input_hash,
        ids: JSON.parse(row.ids_json) as string[],
        prefixRef: row.prefix_ref,
        lastStableId: row.last_stable_id,
        createdAt: row.created_at,
    };
}
