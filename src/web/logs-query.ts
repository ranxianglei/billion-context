/**
 * Pure selection engine behind GET /__bili/logs (web log view).
 *
 * History: the view used to be a bare substring filter — every line not
 * literally containing the query vanished, along with surrounding context,
 * other sessions' interleaved activity, and continuation lines of multi-line
 * events. Per-session diagnosis was nearly impossible because most
 * process-level warn/error lines carry no session id at all (measured on a
 * real install: ~96% of warn/error lines). Three progressively looser
 * inclusion modes replace it (first match wins):
 *   winSec > 0 — time window: everything between [firstHit − winSec,
 *                lastHit + winSec], chronological, interleaved lines kept
 *                (the diagnosis view).
 *   ctx > 0    — per-hit context: ±ctx physical lines around every hit,
 *                overlapping/touching ranges merged.
 *   neither    — exact hits only (historical behaviour, kept for parity).
 * An empty query returns the raw tail, unchanged from before.
 */
export interface LogQueryOptions {
    /** Per-hit context lines (0 disables). Clamp before calling. */
    ctx: number;
    /** Window seconds around [firstHit, lastHit] (0 disables). Clamp before calling. */
    winSec: number;
    /** Max physical lines returned (the NEWEST part of the selection). */
    n: number;
}

export interface LogQueryResult {
    /** Match count for a filtered query, else the whole-file line count. */
    total: number;
    /** lines.length */
    shown: number;
    /** Selection rows dropped by the `n` cap (older than what is shown). */
    omitted: number;
    lines: string[];
    /** Present iff filtered: parallel to lines — true on actual hits. */
    isMatch?: boolean[];
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

function parseTs(line: string): number {
    const m = TS_RE.exec(line);
    if (!m) return NaN;
    const v = Date.parse(m[1]);
    return Number.isFinite(v) ? v : NaN;
}

/** Timestamp per line; a line without a leading ISO ts inherits the previous
 *  one (continuation lines from pre-tagging builds, stray wrappers). NaN up
 *  to the first parsable line; monotone non-decreasing afterwards. */
function timestampsOf(all: string[]): number[] {
    const out = new Array<number>(all.length);
    let last = NaN;
    for (let i = 0; i < all.length; i++) {
        const p = parseTs(all[i]);
        if (Number.isFinite(p)) last = p;
        out[i] = last;
    }
    return out;
}

export function queryLogLines(all: string[], q: string, opts: LogQueryOptions): LogQueryResult {
    const n = Math.max(1, Math.floor(opts.n));
    const qLower = q.toLowerCase();
    const lower = qLower ? all.map((l) => l.toLowerCase()) : null;
    const matches: number[] = [];
    if (qLower) {
        for (let i = 0; i < all.length; i++) if (lower![i].includes(qLower)) matches.push(i);
    }
    const total = qLower ? matches.length : all.length;
    if (total === 0 || all.length === 0) {
        return { total, shown: 0, omitted: 0, lines: [], ...(qLower ? { isMatch: [] as boolean[] } : {}) };
    }

    let included: number[];
    if (!qLower) {
        included = [];
        for (let i = 0; i < all.length; i++) included.push(i);
    } else if (opts.winSec > 0) {
        // Time window around [firstHit, lastHit]; degrades to exact hits when
        // either endpoint lacks a parsable timestamp.
        const ts = timestampsOf(all);
        const tF = ts[matches[0]];
        const tL = ts[matches[matches.length - 1]];
        if (Number.isFinite(tF) && Number.isFinite(tL)) {
            const loT = tF - opts.winSec * 1000;
            const hiT = tL + opts.winSec * 1000;
            let loIdx = matches[0];
            while (loIdx > 0 && Number.isFinite(ts[loIdx - 1]) && ts[loIdx - 1] >= loT) loIdx--;
            let hiIdx = matches[matches.length - 1];
            while (hiIdx < all.length - 1 && Number.isFinite(ts[hiIdx + 1]) && ts[hiIdx + 1] <= hiT) hiIdx++;
            included = [];
            for (let i = loIdx; i <= hiIdx; i++) included.push(i);
        } else {
            included = matches.slice();
        }
    } else if (opts.ctx > 0) {
        // Merge [hit−ctx, hit+ctx] intervals (hit indices ascend ⇒ sweep works).
        const ranges: Array<[number, number]> = [];
        for (const m of matches) {
            const lo = Math.max(0, m - opts.ctx);
            const hi = Math.min(all.length - 1, m + opts.ctx);
            const lastR = ranges[ranges.length - 1];
            if (lastR && lo <= lastR[1] + 1) lastR[1] = Math.max(lastR[1], hi);
            else ranges.push([lo, hi]);
        }
        included = [];
        for (const [lo, hi] of ranges) for (let i = lo; i <= hi; i++) included.push(i);
    } else {
        included = matches.slice();
    }

    let omitted = 0;
    if (included.length > n) {
        omitted = included.length - n;
        included = included.slice(-n);
    }
    return {
        total,
        shown: included.length,
        omitted,
        lines: included.map((i) => all[i]),
        ...(qLower ? { isMatch: included.map((i) => lower![i].includes(qLower)) } : {}),
    };
}
