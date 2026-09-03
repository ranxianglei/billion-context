import type { Session } from "./session.js";
import { log } from "./logger.js";

/**
 * #499 P1b: upstream prompt-cache collapse warning. A warm session normally
 * rides the provider's prefix cache (90%+ hit). When a restart or a session
 * fork makes every request cold, the raw resend is expensive but INVISIBLE:
 * requests succeed, so no error path fires — the only trace is a hit ratio
 * that fell off a cliff. This watches each usage sample; once a session has
 * demonstrated a healthy cache (≥HIGH_HIT on a large input) and then logs
 * LOW_RUN consecutive large inputs with ~zero hits, it warns ONCE with the
 * numbers and the likely causes. Diagnostics only — no state is changed.
 */

const MIN_INPUT = 8000;
const HIGH_HIT = 0.5;
const LOW_HIT = 0.1;
const LOW_RUN = 5;
const MAX_TRACKED_SESSIONS = 1024;

interface CacheWatch {
    sawHigh: boolean;
    lowRun: number;
    warned: boolean;
}

const watches = new Map<string, CacheWatch>();

/** Feed one usage sample (per successful upstream turn). */
export function warnCacheCollapse(session: Session, input: number, cached: number): void {
    if (input < MIN_INPUT) return;
    if (watches.size > MAX_TRACKED_SESSIONS) {
        const oldest = watches.keys().next().value;
        if (oldest !== undefined) watches.delete(oldest);
    }
    const watch = watches.get(session.id) ?? { sawHigh: false, lowRun: 0, warned: false };
    watches.set(session.id, watch);
    const hit = cached / input;
    if (hit >= HIGH_HIT) {
        watch.sawHigh = true;
        watch.lowRun = 0;
        return;
    }
    if (!watch.sawHigh || watch.warned) return;
    if (hit > LOW_HIT) {
        watch.lowRun = 0;
        return;
    }
    watch.lowRun++;
    if (watch.lowRun < LOW_RUN) return;
    watch.warned = true;
    log(
        "warn",
        `[${session.id}] upstream prompt-cache collapse: ${LOW_RUN} consecutive large requests at ~0% hit (last: input=${input}, cached=${cached}) after earlier ≥${Math.round(HIGH_HIT * 100)}% hits — the context is being resent cold every turn. Likely causes: proxy/session restart re-forked the session (#499), or the upstream KV cache was dropped (window/deployment change). Check the session id upstream sees and compress.modelContextLimit.`,
    );
}
