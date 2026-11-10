/**
 * #5874 — snapshot-table compression foundation: lane decision.
 *
 * The per-turn decision between the SNAPSHOT FOUNDATION lane and the LEGACY
 * path. Every non-red condition is a pure predicate (the #3617 discipline:
 * the lane-decisions matrix test pins positive AND negative pairs), and the
 * four red gates are the hard exits:
 *
 *   R1 — S4 aggregate or kernel-state checksum bad → the sid plane is
 *        PERMANENTLY dead (the base material is unrecoverable).
 *   R2 — egress join chain broken (core↔row mismatch, chain walk fails) →
 *        NO events committed this turn, the whole turn runs legacy.
 *   R3 — cohort identity gate fault (the per-element msgid list is not all
 *        collected) → HARD REJECT the request, zero side effects, feed the
 *        fastpath-style breaker.
 *   R4 — a structural-pending marker was persisted and then lost (restart)
 *        → conservatively dead (the fail-safe direction).
 *
 * The decision vocabulary is grep-able in the decision log:
 *   hit / miss / red:R1 / red:R2 / red:R3 / red:R4 / degrade / resync / arm
 */
import type { DecisionToken, PlaneState, RedGate } from "./types.ts";

export interface SnapshotLaneDecision {
    /** "snapshot" = the foundation lane owns this turn's egress; "legacy" =
     *  the existing prepare path runs unchanged. */
    lane: "snapshot" | "legacy";
    reason: string;
    token: DecisionToken;
    /** Red gates that fired this turn (drives the alert log + breaker). */
    redGate?: RedGate;
    /** The plane to hand to the egress (green) — absent when legacy. */
    plane?: PlaneState;
    /** A R2 desync: the whole turn runs legacy AND the client re-stamp
     *  converges it one turn later (the plane itself survives — R2 is
     *  per-turn, not permanent, unlike R1/R4). */
    resyncNextTurn?: boolean;
}

/** Decide the lane for one model request.
 *
 *  @param on          the session is in the rollout cohort (master⊃lane).
 *  @param plane       the hydrated plane (hydrate.ts) — null when nothing is
 *                     readable yet (fresh session → the first turn is
 *                     "arm": legacy write, plane issues next turn).
 *  @param redGate     a red gate that fired THIS turn upstream (R3 identity
 *                     fault, R2 join fault) — takes precedence.
 */
export function decideSnapshotLane(
    on: boolean,
    plane: PlaneState | null,
    redGate?: RedGate,
): SnapshotLaneDecision {
    // A red gate firing upstream always wins. R3 is the only one that
    // hard-rejects the REQUEST (the caller does that before egress); R1/R4
    // are permanent plane deaths; R2 is a per-turn desync.
    if (redGate !== undefined) {
        if (redGate === "R3") {
            return { lane: "legacy", reason: "cohort identity fault", token: "red:R3", redGate };
        }
        return {
            lane: "legacy",
            reason: redGate === "R2" ? "egress join chain broken" : `plane dead (${redGate})`,
            token: `red:${redGate}`,
            redGate,
            // R2 degrades THIS turn only; the plane survives and the client's
            // re-stamp converges it next turn.
            resyncNextTurn: redGate === "R2",
        };
    }
    if (!on) {
        return { lane: "legacy", reason: "not in cohort", token: "miss" };
    }
    if (plane === null) {
        // Nothing readable yet: a fresh cohort session issues its world on
        // the first turn and writes the plane (the legacy path carries the
        // bytes, the snapshot commit mirrors them). The decision is "arm".
        return { lane: "legacy", reason: "plane not armed", token: "arm" };
    }
    if (plane.health === "red") {
        const gate: RedGate | undefined =
            plane.reason === "R1" ? "R1" : plane.reason === "R4" ? "R4" : undefined;
        if (gate !== undefined) {
            return { lane: "legacy", reason: `plane dead (${gate})`, token: `red:${gate}`, redGate: gate };
        }
        // off / no-tables / unreadable are not red gates — a transient
        // degrade (the plane is simply not ready for this session yet).
        return { lane: "legacy", reason: `plane ${plane.reason}`, token: "degrade" };
    }
    // Green plane → the foundation lane owns egress.
    return { lane: "snapshot", reason: "green plane", token: "hit", plane };
}
