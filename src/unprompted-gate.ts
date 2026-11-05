// #5683: unprompted-compression policy gates. Two opt-in knobs
// (compress.requireNudge / compress.requireRecommendation) refuse model-initiated
// compress calls that bili did not ask for. The per-round FACTS they judge on
// are stamped at prepare (src/server/handle.ts) onto session.transient —
// in-memory only, re-stamped every model round — and read here by applyRanges
// (src/stream.ts), the single execution point for every model-initiated compress
// across all lanes (proxy loop + POST /__bili/plugin/tool).
import type { Session } from "./session.js";

export interface UnpromptedGate {
    /** A compression nudge actually reached the model in the latest round
     *  (post-gate delivery fact: nudgeOutcome === "injected" — advisory,
     *  decide-directive and emergency injections all count; "gated"/"vetoed"/
     *  "skipped" never arm). */
    armed: boolean;
    requireNudge: boolean;
    requireRecommendation: boolean;
}

const OFF: UnpromptedGate = { armed: false, requireNudge: false, requireRecommendation: false };

export function storeUnpromptedGate(session: Session, gate: UnpromptedGate): void {
    const t = session.transient ?? (session.transient = {});
    t.unpromptedGate = { ...gate };
}

/** All-off when nothing was stamped yet (fresh process, unit-test ctxs, lanes
 *  without a prepare) — the default configuration changes no behavior. */
export function unpromptedGateOf(session: Session): UnpromptedGate {
    const g = session.transient?.unpromptedGate;
    if (!g || typeof g !== "object") return OFF;
    return {
        armed: g.armed === true,
        requireNudge: g.requireNudge === true,
        requireRecommendation: g.requireRecommendation === true,
    };
}
