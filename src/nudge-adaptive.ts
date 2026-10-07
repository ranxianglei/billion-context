// #1997 — throughput-adaptive nudge cadence. Pure + deterministic: folds a
// bounded history of per-request input sizes (oldest→newest) into the effective
// nudge growth step S. No wall-clock, no randomness — the same history always
// yields the same S (§7.2 reproducible). The host records one sample per
// proxied request and feeds the ring here; the caller then pins
// `nudge.growthFloor == nudge.growthCap == S` on the per-request kernel Config.
//
// Rationale (owner #1997): the fixed step cannot serve both ends of a session's
// workload. Bulk file/log reads arrive as large per-call payloads and need a
// WIDE step (folding mid-burst interrupts the work); quiet interactive turns
// arrive small and want a NARROW step (lean context, no attention wasted). The
// per-call NEW-content delta — `max(0, input[i] - input[i-1])` averaged over a
// recent window — scales the step up or down with observed throughput while
// staying clamped to [min, max]. This deliberately references the CALL COUNT
// (the averaging window) as well as growth magnitude, per the owner's ask.

/** Samples retained in the per-session ring (bounded memory). */
export const ADAPTIVE_WINDOW = 8;
/** Minimum samples required before trusting the mean; below this the seeded
 *  `base` is used so a fresh session behaves like static mode until it has
 *  evidence. */
export const ADAPTIVE_MIN_SAMPLES = 3;
/** Proportionality: S ≈ PROPORTION × mean per-call delta. 1 ⇒ "fold roughly
 *  once per turn's worth of newly-arrived material". */
export const ADAPTIVE_PROPORTION = 1;

/** Seed / fallback step when too few samples exist yet (== kernel default). */
export const ADAPTIVE_DEFAULT_BASE = 50000;
/** Default lower clamp for the adaptive step. */
export const ADAPTIVE_DEFAULT_MIN = 10000;
/** Default upper clamp for the adaptive step (covers the owner's 15w/20w
 *  worst-case bulk-read scenario). */
export const ADAPTIVE_DEFAULT_MAX = 200000;

export interface AdaptiveBounds {
    /** Seed / fallback step when fewer than MIN_SAMPLES samples are present. */
    base: number;
    /** Lower clamp for the adaptive step. */
    min: number;
    /** Upper clamp for the adaptive step. */
    max: number;
}

function clampStep(v: number, lo: number, hi: number): number {
    const x = Number.isFinite(v) ? Math.round(v) : lo;
    return Math.max(lo, Math.min(hi, x));
}

/** Compute the effective nudge growth step from a ring of recent per-request
 *  input sizes (oldest→newest). The per-call NEW-content delta is
 *  `max(0, input[i] - input[i-1])`; its mean over the most recent
 *  {@link ADAPTIVE_WINDOW} samples scales the step proportionally within
 *  [min, max]. Fewer than {@link ADAPTIVE_MIN_SAMPLES} valid samples → the
 *  clamped `base` (so a fresh session matches static mode until it has enough
 *  evidence). Non-finite/negative entries are ignored. Deterministic. */
export function computeAdaptiveStep(history: readonly number[], b: AdaptiveBounds): number {
    const lo = Math.max(1, Math.floor(b.min));
    const hi = Math.max(lo, Math.floor(b.max));
    const win = history.filter((n) => Number.isFinite(n) && n >= 0).slice(-ADAPTIVE_WINDOW);
    if (win.length < ADAPTIVE_MIN_SAMPLES) return clampStep(b.base, lo, hi);
    let sum = 0;
    for (let i = 1; i < win.length; i++) sum += Math.max(0, win[i] - win[i - 1]);
    const avgDelta = sum / (win.length - 1);
    return clampStep(avgDelta * ADAPTIVE_PROPORTION, lo, hi);
}
