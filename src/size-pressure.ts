import { displayContextBest } from "./session.js";

// #4959 option B: how far past its own judging window a session sits — the
// "this conversation can no longer fold back under itself" pressure signal.
// Pure diagnostic: drives one /acp line, a web-list badge, and a /__bili/sessions
// JSON field. No traffic, wire, cache, or config impact; the threshold is a
// built-in constant, not a knob (the owner-gated config surface stays untouched).

/** At or above this many times the session's judging window, warn that no
 *  single fold pass can bring it back inside the window on its own. */
export const SIZE_PRESSURE_WARN_RATIO = 3;

export interface SizePressure {
    /** honest-best current context reading (displayContextBest caliber). */
    tokens: number;
    /** the window nudge/preflight actually judge against (reserved, else declared wall). */
    target: number;
    ratio: number;
    warn: boolean;
}

// Reuse displayContextBest's own param shape so the two stay coupled if its
// required stats fields ever change. Both full Sessions and the bounded web
// summary rows satisfy it structurally.
type SizePressureInput = Parameters<typeof displayContextBest>[0];

export function sizePressureOf(session: SizePressureInput): SizePressure | null {
    const best = displayContextBest(session);
    const tokens = best?.tokens ?? 0;
    if (!(tokens > 0)) return null;
    const meta = session.metadata;
    const target = typeof meta?.reservedContextLimit === "number" && meta.reservedContextLimit > 0
        ? meta.reservedContextLimit
        : typeof meta?.effectiveContextLimit === "number" && meta.effectiveContextLimit > 0
            ? meta.effectiveContextLimit
            : 0;
    if (!(target > 0)) return null;
    const ratio = tokens / target;
    return { tokens, target, ratio, warn: ratio >= SIZE_PRESSURE_WARN_RATIO };
}
