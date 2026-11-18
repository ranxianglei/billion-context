/**
 * #5874 / 2×2 — snapshot-foundation stage-0 shared types.
 *
 * TYPE-ONLY surface. Depends on nothing but the kernel's public types so it
 * can be imported from any layer (storage, server, tests) without a cycle.
 *
 * #7064 msgid-storage slimming (owner ruling 2026-11-17): the stage-0 world
 * state is a BOOKKEEPING CURSOR, not an identity gate — the server keeps only
 * the head and tail of the last seen host-id array plus the count. The
 * middle is deliberately invisible (client compression removes ids freely —
 * D1: an id verdict NEVER diverges; a middle rewrite surfaces via the ledger
 * probes, not here). Every verdict is bookkeeping: the worst outcome is
 * `reanchor` (re-issue the cursor), never a reject.
 */

/** The stored world anchor: the head + tail id windows of the last seen host
 *  array (host order) plus its length and the append-only pos frontier. */
export interface WorldWindow {
    /** The last min(TAIL, count) ids, host order. */
    tailIds: string[];
    /** The first min(HEAD, count) ids, host order. */
    headIds: string[];
    /** The full array length this window was cut from. */
    count: number;
    /** The largest append-only pos issued so far (never reused). */
    maxPos: number;
}

/** Stage-0 verdicts (post-slimming). Executed in order; first hit wins.
 *  - `echo`:     head + count + tail all agree — nothing moved.
 *  - `extend`:   the stored anchor is contained in the incoming tail — new
 *                ids appended (the common shape).
 *  - `shrink`:   the incoming is a suffix of the stored tail — the client
 *                dropped head elements (a fold; D1: legal, never divergent).
 *  - `reanchor`: no anchor relation (head swap / middle rewrite / re-mint) —
 *                the cursor is RE-ISSUED (D1: bookkeeping, never a reject).
 *  - `issue`:    no stored world for this sess_raw → fresh ledger identity +
 *                arm.
 *  - `resync`:   an explicit re-baseline (mode switch).
 *  - `anchor`:   D2 — the session carries a host conversation identity, the
 *                id verdict is skipped entirely; the cursor follows the
 *                incoming unconditionally.
 *
 *  Deletions of windowed ids are reported via `goneIds` (the reconcile turns
 *  them into `delete` events) — orthogonal to the mode. */
export type WorldMode = "echo" | "extend" | "shrink" | "reanchor" | "issue" | "resync" | "anchor";

export interface WorldDecision {
    mode: WorldMode;
    /** The world anchor to persist after this turn. */
    window: WorldWindow;
    /** The NEW ids issued this turn (id → fresh append-only pos), in
 *  incoming order. Empty for echo / reanchor-class verdicts. */
    newIdPos: Array<{ id: string; pos: number }>;
    /** The STORED windowed ids ABSENT from the incoming (client deletions) —
 *  the reconcile turns these into `delete` events. Empty for issue/echo. */
    goneIds: string[];
    /** For `issue`: the freshly issued ledger identity (the existing sid
 *  keyspace, ruling D). Absent otherwise. */
    issuedLedgerId?: string;
    /** The world origin (issued_at) — carried so the caller can preserve it
 *  on a plain update (B1 trap: it never moves except on issue/resync). */
    issuedAt: number;
    /** Diagnostic witness sample — warn stream only. */
    witness?: string;
    /** Review-round-2 Residual 1b: the host re-sent a body this proxy ALREADY
 *  processed (every id known, carrier seqs at/below the frontier) — an
 *  upstream-200 retry. Zero side effects: the cursor is kept as-is. */
    replay?: boolean;
}
