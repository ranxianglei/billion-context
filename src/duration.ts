/**
 * Human-readable duration parsing (#3619).
 *
 * The auto-update policy file and the local config-file stagger keys accept
 * durations as strings — "15m", "2h", "48h", "2d", "1d12h" — because raw
 * milliseconds are error-prone to hand-edit (`172800000` is unreadable as
 * 48 h). Plain numbers remain valid everywhere (interpreted as raw ms) for
 * programmatic/test compatibility; docs always show the string form.
 *
 * Rules (mirrors the #3619 issue amendment):
 *  - units: s, m, h, d, w (case-insensitive — no ambiguity exists in the set)
 *  - segments combine left to right: "1d12h" = 36 h
 *  - decimals allowed per segment: "1.5h" = 90 min
 *  - anything else (empty, bare digits, unknown unit, trailing garbage,
 *    negative sign) is rejected — callers ignore the field and fall back,
 *    never guess.
 *
 * This module is an import-free leaf by design: it is consumed by both
 * src/knobs.ts and src/update-policy.ts and must never cycle.
 */

const DURATION_UNITS_MS: Record<string, number> = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
};

const DURATION_SEGMENT_RE = /^(\d+(?:\.\d+)?)([smhdw])/;

/** Parse a duration string into whole milliseconds, or undefined when the
 *  text is not a well-formed duration. Never throws. */
export function parseDurationField(text: string): number | undefined {
    let rest = text.trim().toLowerCase();
    if (rest.length === 0) return undefined;
    let total = 0;
    while (rest.length > 0) {
        const m = rest.match(DURATION_SEGMENT_RE);
        if (!m) return undefined;
        total += Number(m[1]) * DURATION_UNITS_MS[m[2]];
        rest = rest.slice(m[0].length);
    }
    return Number.isFinite(total) ? Math.floor(total) : undefined;
}
