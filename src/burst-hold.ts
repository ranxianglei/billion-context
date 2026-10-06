import type { CoreMessage } from "acp-kernel";
import { EMERGENCY_NUDGE_ESCALATION_PCT } from "./server/budget.js";

// #1487: tool-burst nudge hold. Batch tool work (e.g. reading a directory of
// files in one turn) fills the trailing history with fresh, high-value results;
// the flat-50K growth nudge firing mid-burst makes the model compress exactly
// the content it is working on, which then gets re-read after the fold — the
// fold→re-read loop reported in #1198/#1277 and the dsh discussion #5795.
// While a burst is active AND context still has headroom, hold GROWTH-based
// nudge injections so the agent can finish its batch; pressure-band nudges
// (kernel force-inject at maxContextLimitPct) and the host emergency nudge
// (>= EMERGENCY_NUDGE_ESCALATION_PCT) are never held, so a context that runs
// out mid-burst still compresses immediately. Stateless per request; applies in
// both compression modes (the proxy-side nudge is the proactive trigger in both).

export interface BurstHoldSettings {
    /** Default true (#1487 owner decision: allow the agent to finish its batch
     *  first while context has headroom). Set false to restore the legacy
     *  always-nudge behavior. */
    enabled?: boolean;
    /** Minimum tool-result count in the lookback window to count as a burst. */
    minToolResults?: number;
    /** Size of the trailing-history window inspected (messages). */
    lookbackMessages?: number;
    /** Minimum share of the window that must be tool results (0..1]. Steady
     *  assistant/tool alternation sits near 0.5 and must NOT trip; parallel
     *  batches sit at 0.8+ and MUST trip. */
    minToolShare?: number;
}

export const DEFAULT_BURST_HOLD = {
    enabled: true,
    minToolResults: 5,
    lookbackMessages: 12,
    minToolShare: 0.55,
};

export interface BurstDetection {
    active: boolean;
    toolResults: number;
    windowSize: number;
    share: number;
}

/** Count tool-result entries in the trailing window of the inbound (normalized)
 *  history. CoreMessages are flat — one core per tool result on every wire —
 *  so counting cores counts results. Detection runs on the INCOMING messages
 *  (what the client just resent), i.e. before processTurn touches state. */
export function detectToolBurst(msgs: CoreMessage[], s?: BurstHoldSettings): BurstDetection {
    const enabled = s?.enabled ?? DEFAULT_BURST_HOLD.enabled;
    const minToolResults = s?.minToolResults ?? DEFAULT_BURST_HOLD.minToolResults;
    const lookback = Math.max(1, Math.floor(s?.lookbackMessages ?? DEFAULT_BURST_HOLD.lookbackMessages));
    const minShare = s?.minToolShare ?? DEFAULT_BURST_HOLD.minToolShare;
    if (!enabled) return { active: false, toolResults: 0, windowSize: 0, share: 0 };
    const win = msgs.slice(-lookback);
    let toolResults = 0;
    for (const m of win) if (m.contentType === "tool-result") toolResults++;
    const share = win.length > 0 ? toolResults / win.length : 0;
    return { active: toolResults >= minToolResults && share >= minShare, toolResults, windowSize: win.length, share };
}

/** Usage line below which growth nudges may be held during a burst: the lower
 *  of the host emergency-escalation line (0.7 — above it the #453 mitigation
 *  already treats every turn as urgent) and the effective kernel pressure line
 *  (nudge.maxContextLimitPct, user-configurable and possibly < 0.7). At or
 *  above this line nothing is ever held. Kernel default when unset/invalid:
 *  0.75 (acp-kernel built-in). */
export function burstHoldCeiling(maxContextLimitPct?: number): number {
    const maxPct = typeof maxContextLimitPct === "number" && Number.isFinite(maxContextLimitPct) && maxContextLimitPct > 0 ? maxContextLimitPct : 0.75;
    return Math.min(EMERGENCY_NUDGE_ESCALATION_PCT, maxPct);
}

/** True = suppress this turn's growth-based nudge injection. Only armed when a
 *  burst is active AND measured usage is strictly below the ceiling; pressure
 *  and emergency injections bypass this by construction (their usage lines are
 *  >= the ceiling). */
export function holdGrowthNudge(det: BurstDetection, contextUsage: number, maxContextLimitPct?: number): boolean {
    return det.active && Number.isFinite(contextUsage) && contextUsage >= 0 && contextUsage < burstHoldCeiling(maxContextLimitPct);
}
