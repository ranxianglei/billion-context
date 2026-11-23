/**
 * snap.ts — #5874 snapshot foundation v2 (pure-incremental, 2026-11-15
 * owner ruling): the stage-0 IDENTITY ledger only.
 *
 * The original four-table plane (l1_world / snap_rows / snap_log /
 * snap_ckpt) was retired before merge: the per-position materialized state
 * (snap_rows), the message-level event stream (snap_log) and the fold
 * checkpoint (snap_ckpt) are replaced by the append-only substrate
 * (messages × blocks × refs). The only plane piece that survives verbatim
 * is the L1 world table below: the stage-0 identity
 * gate (echo/probe/issue, the witness probe, the R3 breaker latch, the
 * element-level msgid envelope for M2 delta inbound) is independent of how.
 * (fold_journal / egress_snapshot / egress_scope_rev once shipped below
 * were retired before merge, discussions/7439 — the egress op-log is now
 * self-contained and the flow tables are the only egress state.)
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

/** #6181 M3: persist the R3 breaker latch onto the l1_world row.
 *  @deprecated discussions/7591 — no live caller. The latch now lands on the
 *  SESSIONS row ({@link snapR3LatchWriteOnSession}); this l1 writer survives
 *  only to document the legacy placeholder-row shape that the egress-off
 *  "red" rebind branch of `snapStage0` still repairs (pre-migration rows).
 *  Kept (not deleted) so that history stays grep-able; drop it with the l1
 *  table in the later release. */
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

// --- identity consolidation (discussions/7591, #7439 follow-up) ------------
// The R3 breaker latch's Durable home is now the SESSIONS row itself (the
// session table is the single identity table; the l1_world row is a legacy
// fallback READ carrier until that table is dropped in a later release).
// The sessions column is INTEGER, NULL/0 = not latched, else epoch-ms — the
// "not latched" sentinel is 0, never NULL semantics games (fresh installs
// probe the column in, pre-existing rows read NULL which is falsy like 0).

/** Read the persisted R3 latch from the sessions row. Missing row or
 *  NULL/0 → false. (The column exists on every store — schema.ts probes it
 *  in first.) */
export function snapR3LatchedReadOnSession(db: DbLike, sessionId: string): boolean {
    const r = db
        .prepare("SELECT r3_latched_at FROM sessions WHERE session_id = ?")
        .get(sessionId) as { r3_latched_at: number | null } | undefined;
    return !!r && !!r.r3_latched_at;
}

/** Persist the R3 latch onto the sessions row. UPSERT of a MINIMAL row when
 *  the session is not recorded yet (the first fault of a fresh session
 *  happens before its first ingest upsert) — the minimal row carries only
 *  the NOT-NULL-without-default columns plus the latch; every later ingest
 *  upsert fills the rest via ON CONFLICT DO UPDATE without touching it.
 *  (The legacy l1 placeholder-row ceremony is gone with this: v1 identity is
 *  the identity map, the row's PK IS the ledger id.) */
export function snapR3LatchWriteOnSession(db: DbLike, sessionId: string, nowMs: number): void {
    db.prepare("INSERT INTO sessions (session_id, created_at, updated_at, r3_latched_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET r3_latched_at = excluded.r3_latched_at").run(sessionId, nowMs, nowMs, nowMs);
}

/** Clear the persisted R3 latch on the sessions row. Returns the session id
 *  when the row WAS latched (callers use the return to clear the in-memory
 *  breaker for the resolvable sid), null when it was not. */
export function snapR3LatchClearOnSession(db: DbLike, sessionId: string): string | null {
    const was = snapR3LatchedReadOnSession(db, sessionId);
    db.prepare("UPDATE sessions SET r3_latched_at = NULL WHERE session_id = ?").run(sessionId);
    return was ? sessionId : null;
}

/** The persisted-latch roster from the sessions row (empty when none). */
export function snapR3LatchedListOnSessions(db: DbLike): Array<{ sessRaw: string; ledgerId: string; latchedAt: number }> {
    return (db
        .prepare("SELECT session_id, r3_latched_at FROM sessions WHERE r3_latched_at IS NOT NULL AND r3_latched_at <> 0 ORDER BY r3_latched_at DESC")
        .all() as Array<{ session_id: string; r3_latched_at: number }>)
        .map((r) => ({ sessRaw: r.session_id, ledgerId: r.session_id, latchedAt: r.r3_latched_at }));
}

// ---------------------------------------------------------------------------
