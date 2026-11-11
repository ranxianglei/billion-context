/**
 * #5874 / 2×2 — snapshot-foundation stage-0 shared types.
 *
 * TYPE-ONLY surface. Depends on nothing but the kernel's public types so it
 * can be imported from any layer (storage, server, tests) without a cycle.
 *
 * Aligned to the reference implementation (#6155 `src/snapshot/`) — the stage-0
 * world-match / hydrate / lane decision vocabulary is shared verbatim. The
 * PLANE itself stays on the #5901 message-level model (one `snap_rows` row per
 * ledger element, `post_json` = the post-rewrite common-core BiliMessage JSON,
 * `pos` = the append-only ledger position), so the reconcile/egress event
 * types live in `src/storage/snap.ts` (unchanged) and are not re-declared here.
 */

/** One entry in the standing canon envelope: a host msgid bound to the
 *  append-only ledger pos it was first issued at (pos is never reused — the
 *  DDL invariant). The canon is stored as an ordered [{id, pos}] list so the
 *  L1 table is self-contained (world = id + pos, §4.0 ruling G). */
export interface WorldEnvelopeEntry {
    id: string;
    pos: number;
}

/** World-match verdicts for stage 0 (§4.0). Executed in order; first hit
 *  wins. `pos` is append-only: a middle insertion does NOT shift stored rows.
 *  - `echo`: the incoming id sequence matches the stored one positionally.
 *  - `probe`: the stored id sequence is a strict PREFIX of the incoming one
 *    (tail append — the common, v5-proven shape) or a canon shrink.
 *  - `scatter`: known ids keep their relative order but NEW ids are inserted
 *    in the middle / at any position (the span-parse case, T5 byte pin).
 *  - `issue`: no stored world for this sess_raw → fresh ledger identity + arm.
 *  - `diverge`: the live head changed, or a KNOWN id changed its relative
 *    order (history rewrite) → this turn runs legacy and re-stamps; the canon
 *    is NOT updated (the client converges in one turn).
 *  - `resync`: an explicit re-baseline (mode switch / ledger re-issue).
 *
 *  Deletions (a stored id absent from the incoming) are orthogonal to the mode
 *  and are reported via `goneIds` → the reconcile turns them into `delete`
 *  events (not a divergence while the head + survivor order are unchanged). */
type WorldMode = "echo" | "probe" | "scatter" | "issue" | "diverge" | "resync";

export interface WorldDecision {
    mode: WorldMode;
    /** The canon envelope to persist after this turn (host ids in host order,
     *  each bound to its append-only pos). For `diverge` this is the UNCHANGED
     *  stored canon. */
    envelope: WorldEnvelopeEntry[];
    /** sha256 of the id sequence (host order) — the fast mismatch before the
     *  positional walk. */
    envelopeChecksum: string;
    /** The NEW ids issued this turn (id → fresh pos), in incoming order.
     *  Empty for echo / diverge. */
    newIdPos: Array<{ id: string; pos: number }>;
    /** The stored ids ABSENT from the incoming (client deletions) — the
     *  reconcile turns these into `delete` events. Empty for issue / echo. */
    goneIds: string[];
    /** For `issue`: the freshly issued ledger identity (the existing sid
     *  keyspace, ruling D). Absent otherwise. */
    issuedLedgerId?: string;
    /** The world origin (issued_at) — carried so the caller can preserve it
     *  on a plain update (B1 trap: it never moves except on issue/resync). */
    issuedAt: number;
    /** The arming-turn marker set on `issue`/`resync`. */
    armedAt?: number;
    /** Diagnostic witness sample (echo spot-check) — warn stream only. */
    witness?: string;
}

