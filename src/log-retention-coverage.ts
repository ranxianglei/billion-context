/**
 * Retention coverage: what the retained log set actually MEASURES, kept strictly
 * apart from what it cannot prove.
 *
 * Split out of log-retention.ts (which owns policy, naming, sealing and the byte
 * budget) so each file stays focused: this one only reads bounded spans of the
 * retained files and turns them into operator-facing text. It is imported lazily
 * by the reporting readers and by the budget result — never on the per-line log
 * path.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: an old first timestamp is a span, not
 * evidence of continuity. Nothing in a set of generation files proves that the
 * generations between them are all present, so `continuity` is always
 * `"unknown"`. Out-of-order timestamps are not treated as a gap either — clock
 * adjustments, overlapping writers and legacy migration all reorder stamps
 * without any history being lost, so inferring loss from an inverted stamp would
 * fabricate a defect. A quiet period writes nothing between two stamps: also
 * normal. `targetSpanMet` therefore means "the measured span reaches the target
 * length", never "the logs are complete", and every operator-facing string here
 * says so. Files that cannot be read are reported as unavailable or as a lower
 * bound, never folded into a span that then looks healthy.
 *
 * Free of config/knob imports, like its sibling: src/config.ts imports
 * src/logger.ts, so anything on that path must not read config back.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** The slice of a generation that coverage needs: where it is and how big it is.
 *  Declared structurally so this module never imports the retention module that
 *  imports it back — the two would otherwise form a runtime cycle. */
interface CoverageGeneration {
    path: string;
    sizeBytes: number;
}

/** The slice of the retention policy coverage needs. Same reason: structural. */
interface CoveragePolicy {
    targetMs: number;
    budgetBytes: number;
}

/** Bytes sampled from each end of a generation. Bounded so reporting stays cheap
 *  on a 10 MiB segment: line heads carry the local wall-clock stamp (#4535). */
const SAMPLE_BYTES = 64 * 1024;

const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})?)/;

/** Why a retention window is short of the target. `incomplete` is the read-time
 *  answer: a probe cannot tell whether history is young or the budget trimmed it. */
type CoverageShortfallReason = "budget" | "unknown-history" | "incomplete";

/** Which files the caller is describing: a budget trim it just ran, or a plain
 *  read. A failed trim passes `undefined` — deleted bytes then prove nothing. */
type CoverageCause = boolean | undefined;

export interface LogCoverage {
    /** Wall-clock stamp of the oldest retained line, or null when none parses. */
    oldestLineMs: number | null;
    /** MEASURED span: `now` − `oldestLineMs`. A span, not proof of continuity. */
    spanMs: number;
    /** Age of the oldest retained line — the same number as `spanMs`, named for
     *  the operator-facing reports that predate this module. */
    oldestAgeMs: number | null;
    totalBytes: number;
    /** How many on-disk files were enumerated (sealed + legacy + active). */
    generations: number;
    /** How many of those could not be READ while measuring. Non-zero means the
     *  span is a lower bound over the readable subset: availability of the
     *  history is unknown, which `available` states separately from the span. */
    unreadable: number;
    /** Whether every enumerated file could be read. Independent of the span: a
     *  long span over a partly unreadable set is still a measured span, but its
     *  completeness is unknown, so operators are told both facts. */
    available: boolean;
    /** Always `"unknown"`: generation files carry no lineage evidence, so nothing
     *  here can prove the window is unbroken. Out-of-order stamps are not
     *  missing-history evidence either (clock steps, overlapping writers and
     *  legacy migration all reorder stamps harmlessly). */
    continuity: "unknown";
    /** Whether the MEASURED span reaches the target — a statement about the span
     *  only, never about completeness and never about readability. */
    targetSpanMet: boolean;
    /** Why the window is short of the target; null when the span reaches it. */
    shortfall: CoverageShortfallReason | null;
    /** Operator-facing sentence — never claims completeness it lacks. */
    message: string;
}

function closeQuietly(fd: number | undefined): void {
    if (fd === undefined) return;
    try { closeSync(fd); } catch { /* already closed */ }
}

/** Outcome of sampling one line head: a stamp, "read but undated", or a read
 *  failure. The three are kept apart so an unreadable file never silently looks
 *  like a short history. */
type ReadStamp = { kind: "stamp"; ms: number } | { kind: "undated" } | { kind: "unreadable" };

/** First stamped line head in `file`, read from a bounded PREFIX. Line heads are
 *  LOCAL wall clock, so a zone-less stamp parses exactly as written. */
function firstStamp(file: string): ReadStamp {
    let fd: number | undefined;
    try {
        fd = openSync(file, "r");
        const buf = Buffer.alloc(Math.min(SAMPLE_BYTES, Math.max(1, fstatSync(fd).size)));
        const read = readSync(fd, buf, 0, buf.length, 0);
        const m = STAMP_RE.exec(buf.subarray(0, read).toString("utf8"));
        const ms = m ? Date.parse(m[1]!) : NaN;
        return Number.isFinite(ms) ? { kind: "stamp", ms } : { kind: "undated" };
    } catch {
        return { kind: "unreadable" };
    } finally {
        closeQuietly(fd);
    }
}

/** Oldest logged INSTANT across these generations, from line heads rather than
 *  mtime: a long-lived segment's mtime is its LAST append and would overstate it.
 *  `unreadable` counts the files that could not be sampled, so the caller can say
 *  the span is a lower bound instead of presenting it as the whole history. */
export function oldestLogLineMs(generations: CoverageGeneration[]): { oldest: number | null; unreadable: number } {
    let oldest: number | null = null;
    let unreadable = 0;
    for (const g of generations) {
        const r = firstStamp(g.path);
        if (r.kind === "unreadable") unreadable++;
        else if (r.kind === "stamp" && (oldest === null || r.ms < oldest)) oldest = r.ms;
    }
    return { oldest, unreadable };
}

/** Continuity of the retained set, from the only evidence available.
 *
 *  There is NO evidence of continuity in a set of generation files, so this
 *  always reports `"unknown"`. Out-of-order timestamps or names are NOT treated
 *  as a missing-history signal either: clock adjustments, overlapping writers
 *  and legacy migration all reorder stamps without any history being lost, so
 *  inferring a gap from an inverted head timestamp would be a fabrication in the
 *  other direction. Only real lineage evidence (which this logger does not
 *  write) could justify a stronger answer, and none is claimed. */
export function continuityOf(_generations: CoverageGeneration[]): "unknown" {
    return "unknown";
}

/** Binary units for operator-facing text ("256 MiB"). */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${i === 0 || v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Human window ("2d 3h") for operator-facing text. */
export function formatWindow(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "0m";
    const minutes = Math.floor(ms / 60_000);
    const d = Math.floor(minutes / (60 * 24));
    const h = Math.floor((minutes % (60 * 24)) / 60);
    const m = minutes % 60;
    if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
}

/** Describe the retained set. `cause` is `true`/`false` when the caller just ran
 *  the budget to completion, `undefined` for a read or a part-failed trim.
 *  `enumerationFailed` says the archive could not be listed, which makes the
 *  whole set unknown — never an empty or young history. */
export function computeCoverage(
    gens: CoverageGeneration[],
    policy: CoveragePolicy,
    now: number,
    cause: CoverageCause,
    enumerationFailed = false,
): LogCoverage {
    const totalBytes = gens.reduce((n, g) => n + g.sizeBytes, 0);
    const { oldest, unreadable } = oldestLogLineMs(gens);
    const target = formatWindow(policy.targetMs);
    const base = {
        totalBytes, generations: gens.length, unreadable, available: unreadable === 0 && !enumerationFailed,
        continuity: continuityOf(gens),
    } as const;
    if (enumerationFailed) {
        return {
            ...base, oldestLineMs: oldest, spanMs: oldest === null ? 0 : Math.max(0, now - oldest),
            oldestAgeMs: oldest === null ? null : Math.max(0, now - oldest), targetSpanMet: false, shortfall: "incomplete",
            message: `log retention: retained history unavailable — the archive could not be listed (target ${target}), so ${formatBytes(totalBytes)} of ${formatBytes(policy.budgetBytes)} is only what was visible`,
        };
    }
    // No lineage evidence exists, so this sentence accompanies every span that
    // could be mistaken for proof.
    const caveat = "continuity unknown: generation files carry no lineage evidence, so this is a measured span, not an unbroken history";
    const size = `${formatBytes(totalBytes)} of ${formatBytes(policy.budgetBytes)}`;
    // Availability is reported on its own line: a partly unreadable set can still
    // have a long measured span, and saying so is not the same as saying the
    // history is complete or even fully present.
    const lossy = unreadable > 0 ? `; ${unreadable} file(s) unreadable, so the span is a lower bound` : "";
    if (oldest === null) {
        return {
            ...base, oldestLineMs: null, spanMs: 0, oldestAgeMs: null, targetSpanMet: false, shortfall: "unknown-history",
            message: unreadable > 0
                ? `log retention: retained history unavailable — ${unreadable} file(s) could not be read (target ${target})`
                : `log retention: no dated log history retained yet (target ${target})`,
        };
    }
    const spanMs = Math.max(0, now - oldest);
    // Span and availability are separate facts. `targetSpanMet` states only what
    // was measured over the readable subset; `available` states whether that
    // subset was the whole set.
    const covered = `measures ${formatWindow(spanMs)} of history (target ${target}), ${size}${lossy}`;
    if (spanMs >= policy.targetMs) {
        return {
            ...base, oldestLineMs: oldest, spanMs, oldestAgeMs: spanMs, targetSpanMet: true, shortfall: null,
            message: `log retention: ${covered}; ${caveat}`,
        };
    }
    // Two causes worth separating: the budget cut the window (operator-actionable
    // — raise it), or nothing has been trimmed yet so the install is simply
    // younger than the target (fills in by itself; never blamed on the budget).
    // A read-time probe cannot know which happened, so the caller passes it.
    const why = cause === undefined
        ? `history may be younger, or the byte budget ${formatBytes(policy.budgetBytes)} may have cut it; raise the budget only if it caused the shortfall`
        : cause
            ? `byte budget ${formatBytes(policy.budgetBytes)} reached — raising it can retain more future history, not restore deleted evidence`
            : `history is younger than the target`;
    const shortfall: CoverageShortfallReason = cause === undefined ? "incomplete" : cause ? "budget" : "unknown-history";
    return {
        ...base, oldestLineMs: oldest, spanMs, oldestAgeMs: spanMs, targetSpanMet: false, shortfall,
        message: `log retention: incomplete window — ${covered}; ${why}; ${caveat}`,
    };
}
