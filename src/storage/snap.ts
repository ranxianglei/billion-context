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
