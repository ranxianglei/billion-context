// #7049 (per-range fold taint): once a span has been REFUSED by the
// no-net-shrink / coverage-regression gate, the nudge menu stops advertising
// that span (and sub-spans of it) — the system must not keep recommending the
// exact action that just failed while the refusal receipt says "do not re-issue"
// (the contradictory-instruction leg of the refusal loop; see #7049: 57
// identical refusals because every fresh nudge re-offered the same doomed
// fragment).
//
// The GATE itself is untouched: model/user-initiated compress calls on a
// tainted span are still evaluated normally and get the same receipt (#847:
// a too-long summary is recoverable, so recoverable failures must not ban
// compress — the taint only removes the system's standing INVITATION).
//
// Arming: the 2nd refusal of the same spec (the 1st refusal's receipt already
// said "write a much shorter summary / target a larger span"; a 2nd refusal of
// the identical spec shows the model is not changing strategy).
//
// Clearing: ANY successful commit (global — mirrors the kernel baseline reset
// at kernel/src/compress.ts:927, where a proven fold re-arms every channel),
// or a 10-minute TTL (aligned with COMPRESS_LOOP_DECAY_MS, stream.ts:232).
//
// Containment, not equality: a menu range is dropped only when it sits FULLY
// INSIDE an armed tainted span. A menu span that grew AROUND the failed
// fragment stays advertised — "fold a larger span so the summary shrinks it"
// is still the receipt's named escape hatch, and the taint must not block it.
import type { NudgeDecision } from "acp-kernel";
import { type Session, markDirty } from "./session.js";

const TAINT_KEY = "foldTaint";
const TAINT_TTL_MS = 10 * 60 * 1000;
const TAINT_ARM_COUNT = 2;
const TAINT_CAP = 64;

interface TaintEntry {
    /** refusal count for this spec */
    c: number;
    /** epoch ms of the latest refusal */
    at: number;
}
type TaintMap = Record<string, TaintEntry>;
interface TaintSpan {
    lo: number;
    hi: number;
}

const refNum = (ref: string): number => {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
};

/** Parse a normalizedSpecKey ("m00351..m00373[,m00400..m00410]") into spans. */
function specSpans(specKey: string): TaintSpan[] {
    const out: TaintSpan[] = [];
    for (const part of specKey.split(",")) {
        const [a, b] = part.split("..");
        const lo = refNum(a ?? "");
        const hi = refNum(b ?? "");
        if (lo > 0 && hi > 0) out.push({ lo: Math.min(lo, hi), hi: Math.max(lo, hi) });
    }
    return out;
}

function readTaint(session: Session, now: number): TaintMap {
    const raw = session.metadata[TAINT_KEY];
    const out: TaintMap = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            const e = v as TaintEntry | undefined;
            if (e && typeof e.c === "number" && typeof e.at === "number" && now - e.at < TAINT_TTL_MS) {
                out[k] = e;
            }
        }
    }
    return out;
}

function armedSpans(session: Session, now: number): TaintSpan[] {
    const spans: TaintSpan[] = [];
    for (const [spec, e] of Object.entries(readTaint(session, now))) {
        if (e.c >= TAINT_ARM_COUNT) spans.push(...specSpans(spec));
    }
    return spans;
}

/** Exported for tests: armed spans at an explicit clock (TTL arithmetic). */
export function armedTaintSpansAt(session: Session, now: number): TaintSpan[] {
    return armedSpans(session, now);
}

/**
 * Record one gate refusal (no-net-shrink / coverage-regression) for a spec.
 * Returns a short note for the refusal receipt once the taint ARMS (so the
 * model learns the system-side state change, not just another "stop"), else "".
 */
export function recordFoldTaintRefusal(session: Session, specKey: string): string {
    if (!specKey) return "";
    const now = Date.now();
    const taint = readTaint(session, now);
    const prev = taint[specKey];
    const entry: TaintEntry = { c: (prev?.c ?? 0) + 1, at: now };
    taint[specKey] = entry;
    // Bound the map: keep the freshest entries, drop the rest (a spec-space
    // walker must not be able to grow unbounded taint state).
    const keys = Object.keys(taint);
    if (keys.length > TAINT_CAP) {
        keys
            .sort((a, b) => (taint[b]?.at ?? 0) - (taint[a]?.at ?? 0))
            .slice(TAINT_CAP)
            .forEach((k) => delete taint[k]);
    }
    session.metadata[TAINT_KEY] = taint;
    markDirty(session);
    return entry.c === TAINT_ARM_COUNT
        ? ` [Fold-taint: this range now fails the shrink gate twice in a row and has been REMOVED from the nudge recommendation list until your next successful compression (or 10 minutes). Do not target it again; fold a LARGER span so a short summary still wins, or continue the task.]`
        : "";
}

/** Drop all taint (any successful commit). Mirrors clearCompressFailures. */
export function clearFoldTaint(session: Session): void {
    if (session.metadata[TAINT_KEY] !== undefined) {
        delete session.metadata[TAINT_KEY];
        markDirty(session);
    }
}

/** Ranges fully contained in an armed tainted span. Containment only — a
 *  superset span (the "larger span" escape hatch) survives. */
export function filterTaintedRanges<T extends { startRef: string; endRef: string }>(
    ranges: T[],
    session: Session,
    now = Date.now(),
): T[] {
    const spans = armedSpans(session, now);
    if (spans.length === 0) return ranges;
    return ranges.filter((r) => {
        const lo = refNum(r.startRef);
        const hi = refNum(r.endRef);
        if (lo <= 0 || hi <= 0) return true; // unparseable → keep (fail-open)
        return !spans.some((s) => s.lo <= Math.min(lo, hi) && Math.max(lo, hi) <= s.hi);
    });
}

/** Same as filterTaintedRanges with an explicit clock (TTL arithmetic, tests). */
export function filterTaintedRangesAt<T extends { startRef: string; endRef: string }>(
    ranges: T[],
    session: Session,
    now: number,
): T[] {
    return filterTaintedRanges(ranges, session, now);
}

/**
 * Apply the taint to a fresh processTurn result BEFORE any lane reads the
 * nudge (injection render, decide prompt, acp_status). Gentle T1 only:
 * EMERGENCY nudges carry no range list (renderNudgeText), T2/T3 distill by
 * block id — neither is affected by a range taint.
 * Returns the number of advertised ranges removed (0 = untouched turn).
 * All-ranges-tainted → the nudge is dropped for this round (tier cleared,
 * shouldInject false): nothing to offer is nothing to nudge about, and a
 * rangeless T1 nudge would just re-invite the loop with a generic list.
 */
export function applyFoldTaintToTurn(
    turn: { nudge?: NudgeDecision | null },
    session: Session,
    log?: (level: "info" | "debug", msg: string) => void,
    sessionId?: string,
): number {
    const n = turn.nudge;
    if (!n || n.tier !== 1 || n.breakdown?.emergencyOverride === 1) return 0;
    const advertised = n.compressibleRanges ?? [];
    if (advertised.length === 0) return 0;
    const filtered = filterTaintedRanges(advertised, session);
    const excluded = advertised.length - filtered.length;
    if (excluded === 0) return 0;
    if (filtered.length === 0) {
        turn.nudge = { ...n, compressibleRanges: [], tier: null, shouldInject: false };
        log?.("info", `[${sessionId ?? session.id}] fold-taint: T1 nudge suppressed this round — all ${advertised.length} advertised range(s) sit inside armed refusal taint(s); re-arms on the next commit or after 10 min`);
    } else {
        turn.nudge = { ...n, compressibleRanges: filtered };
        log?.("debug", `[${sessionId ?? session.id}] fold-taint: ${excluded} advertised range(s) inside armed refusal taint(s) removed from the nudge menu`);
    }
    return excluded;
}
