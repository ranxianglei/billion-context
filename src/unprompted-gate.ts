// #5683: unprompted-compression policy gates. Two opt-in knobs
// (compress.requireNudge / compress.requireRecommendation) refuse model-initiated
// compress calls that bili did not ask for. The per-round FACTS they judge on
// are stamped at prepare (src/server/handle.ts) onto session.transient —
// in-memory only, re-stamped every model round — and read here by applyRanges
// (src/stream.ts), the single execution point for every model-initiated compress
// across all lanes (proxy loop + POST /__bili/plugin/tool).
// #5943: the requireNudge fact is a CREDIT, not a single-round boolean. An
// actually injected nudge mints NUDGE_CREDIT_ROUNDS model rounds of eligibility;
// each new injection refreshes it, every un-nudged MODEL round decays it by one,
// and non-model shapes (countTokens/responsesCompact/local forges) hold it open —
// they are not model rounds, so they neither refresh nor decay. A successful fold
// does NOT consume it: finishing a nudge's recommended cleanup over several rounds
// is exactly what the nudge asked for (the single-round arm that preceded this
// refused every such continuation — the defect #5943 reports). Long-term strictness
// survives because nudges are growth-driven: quiet sessions lapse back to strict
// refusal after K un-nudged rounds; growing ones keep refreshing a window where
// folding is wanted.
import type { Session } from "./session.js";

/** Credit window in MODEL ROUNDS (#5943). A constant on purpose — no config
 *  surface for it: the knob pair already exists, only the window length is fixed. */
export const NUDGE_CREDIT_ROUNDS = 20;

/** Read-side view of the gate: what applyRanges judges on. */
interface UnpromptedGate {
    /** A nudge credit is LIVE right now: some compression nudge actually reached
     *  the model within the last NUDGE_CREDIT_ROUNDS model rounds (post-gate
     *  delivery fact: nudgeOutcome === "injected" — advisory, decide-directive
     *  and emergency injections all mint it; "gated"/"vetoed"/"skipped" never do). */
    armed: boolean;
    requireNudge: boolean;
    requireRecommendation: boolean;
}

/** Stamp-side facts, one per prepare. `nudgeInjected` is THIS ROUND'S delivery
 *  fact (true = a nudge reached the model in this very round); the module turns
 *  it into the credit transition below. `modelRound` (default true) marks genuine
 *  model rounds that decay the window; bypass shapes pass false to hold it. */
interface UnpromptedGateStamp {
    nudgeInjected: boolean;
    requireNudge: boolean;
    requireRecommendation: boolean;
    modelRound?: boolean;
}

/** Stored state (session.transient.unpromptedGate): the live credit counter plus
 *  the policy flags. In-memory only — a restart lapses any live credit back to
 *  the all-off default until the first round re-stamps. */
export interface UnpromptedGateState {
    credit: number;
    requireNudge: boolean;
    requireRecommendation: boolean;
}

const OFF: UnpromptedGate = { armed: false, requireNudge: false, requireRecommendation: false };

export function storeUnpromptedGate(session: Session, stamp: UnpromptedGateStamp): void {
    const t = session.transient ?? (session.transient = {});
    const prev = t.unpromptedGate as UnpromptedGateState | undefined;
    const prevCredit =
        prev && typeof prev === "object" && Number.isFinite(prev.credit) ? Math.max(0, Math.floor(prev.credit)) : 0;
    const isModelRound = stamp.modelRound !== false;
    // Credit transition: an injected round re-mints the full window; an un-nudged
    // model round decays it by one; non-model stamps hold it (lenient freeze — the
    // same persistence property loop re-requests within one turn always had, since
    // they do not re-run prepare either).
    const credit = stamp.nudgeInjected ? NUDGE_CREDIT_ROUNDS : isModelRound ? prevCredit - 1 : prevCredit;
    t.unpromptedGate = {
        credit: Math.max(0, credit),
        requireNudge: stamp.requireNudge === true,
        requireRecommendation: stamp.requireRecommendation === true,
    };
}

/** All-off when nothing was stamped yet (fresh process, unit-test ctxs, lanes
 *  without a prepare) — the default configuration changes no behavior. */
export function unpromptedGateOf(session: Session): UnpromptedGate {
    const g = session.transient?.unpromptedGate as UnpromptedGateState | undefined;
    if (!g || typeof g !== "object") return OFF;
    return {
        armed: Number.isFinite(g.credit) && g.credit > 0,
        requireNudge: g.requireNudge === true,
        requireRecommendation: g.requireRecommendation === true,
    };
}
