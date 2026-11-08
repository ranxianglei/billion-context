// #5683: unprompted-compression policy gates. Two opt-in knobs
// (compress.requireNudge / compress.requireRecommendation) refuse model-initiated
// compress calls that bili did not ask for. The per-round FACTS they judge on
// are stamped at prepare (src/server/handle.ts) onto session.transient —
// in-memory only, re-stamped every model round — and read here by applyRanges
// (src/stream.ts), the single execution point for every model-initiated compress
// across all lanes (proxy loop + POST /__bili/plugin/tool).
//
// #5943: the arm a nudge grants is a CREDIT, not a single-round flag. A
// delivered nudge opens a window of NUDGE_CREDIT_ROUNDS subsequent prepares
// during which the model may come back and fold (real cleanup work — reading
// ranges, writing a good summary — routinely spans several model rounds,
// especially under requireRecommendation where the first attempt is often
// refused and retried). A committed fold CONSUMES the credit: the arm holds
// for the rest of the current turn (loop re-requests within the same turn do
// not re-run prepare) and dies at the next round boundary. A newer nudge
// refreshes the window. In-memory only, like the rest of the gate.
import type { Session } from "./session.js";

/** How many subsequent prepares a delivered nudge keeps the arm live for
 *  (counting the injection round itself as round 1). */
export const NUDGE_CREDIT_ROUNDS = 20;

export interface UnpromptedGate {
    /** A compression nudge actually reached the model (post-gate delivery
     *  fact: nudgeOutcome === "injected" — advisory, decide-directive and
     *  emergency injections all count; "gated"/"vetoed"/"skipped" never
     *  arm), and the credit it opened has not expired or been consumed.
     *  #5943: this is a multi-round credit, not just "the latest round". */
    armed: boolean;
    /** #5943: last round index (t.nudgeCreditRound) for which the current
     *  credit stays live; 0/absent = no credit window (raw stamp via
     *  storeUnpromptedGate, e.g. unit tests). */
    armedUntilRound?: number;
    /** #5943: the model committed a fold under the current credit — the arm
     *  holds for the rest of this turn and expires at the next stamp. */
    consumed?: boolean;
    requireNudge: boolean;
    requireRecommendation: boolean;
}

const OFF: UnpromptedGate = { armed: false, armedUntilRound: 0, consumed: false, requireNudge: false, requireRecommendation: false };

export function storeUnpromptedGate(session: Session, gate: UnpromptedGate): void {
    const t = session.transient ?? (session.transient = {});
    t.unpromptedGate = { ...gate };
}

/** #5943: prepare-time credit stamp — the per-round entry point used by
 *  src/server/handle.ts. Advances the session's prepare counter and carries
 *  the previous credit forward (or refreshes it on a new injection) before
 *  storing this round's facts. Replaces the old one-round disarm-by-default
 *  stamp, which refused the model's delayed fulfillments of an already-
 *  delivered nudge. */
export function stampUnpromptedGate(session: Session, facts: {
    nudgeInjected: boolean;
    requireNudge: boolean;
    requireRecommendation: boolean;
}): void {
    const t = session.transient ?? (session.transient = {});
    const round = (typeof t.nudgeCreditRound === "number" ? t.nudgeCreditRound : 0) + 1;
    t.nudgeCreditRound = round;
    const prev = t.unpromptedGate;
    const prevUntil = prev && typeof prev.armedUntilRound === "number" ? prev.armedUntilRound : round;
    // The old credit carries forward only if it was live (armed, un-consumed)
    // and its window still covers this round; a fresh injection always wins.
    const creditLive = prev !== undefined
        && prev.armed === true
        && prev.consumed !== true
        && prevUntil >= round;
    storeUnpromptedGate(session, {
        armed: facts.nudgeInjected || creditLive,
        armedUntilRound: facts.nudgeInjected ? round + NUDGE_CREDIT_ROUNDS - 1 : prevUntil,
        consumed: facts.nudgeInjected ? false : prev?.consumed === true,
        requireNudge: facts.requireNudge,
        requireRecommendation: facts.requireRecommendation,
    });
}

/** #5943: spend the credit after a committed model-initiated fold (called
 *  from applyRanges when blocksCreated > 0). The arm persists through the
 *  rest of this turn and is dropped at the next prepare stamp. */
export function consumeNudgeCredit(session: Session): void {
    const g = session.transient?.unpromptedGate;
    if (g && g.armed) g.consumed = true;
}

/** All-off when nothing was stamped yet (fresh process, unit-test ctxs, lanes
 *  without a prepare) — the default configuration changes no behavior. */
export function unpromptedGateOf(session: Session): UnpromptedGate {
    const g = session.transient?.unpromptedGate;
    if (!g || typeof g !== "object") return OFF;
    return {
        armed: g.armed === true,
        armedUntilRound: typeof g.armedUntilRound === "number" ? g.armedUntilRound : 0,
        consumed: g.consumed === true,
        requireNudge: g.requireNudge === true,
        requireRecommendation: g.requireRecommendation === true,
    };
}
