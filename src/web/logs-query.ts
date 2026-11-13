/**
 * Selection engine behind GET /__bili/logs (web log view): a pure selection
 * policy applied to a streamed source, not a pure function of an array.
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
 *
 * BOUNDED INPUT: retained history is a byte budget spanning many generations,
 * so the source is an async line stream (`readLogLines`) and this engine holds
 * only what its answer needs — the `n` newest selected rows plus the pending
 * context of recent hits. Exact and `ctx` modes run in ONE pass. The time
 * window cannot: it must know the best-matched endpoint timestamps before
 * deciding inclusion, so it takes a bounded second pass over the same files
 * (bytes re-read, never per-line arrays — no `all.map(toLowerCase)`, no
 * timestamps array, no index list over history).
 *
 * TIMESTAMPS INHERIT: a line without its own stamp takes the most recent
 * parsable one before it (multi-line events and bare continuations are
 * stamped by their head). The window walk requires a parsable inherited stamp
 * on adjacent rows. Both passes use the same ordering, but concurrent appends
 * and rotations mean this is not a stable snapshot of the retained set.
 */
import { readLogLines, type ReadLogLinesOptions } from "../log-file-lines.js";

interface LogQueryOptions {
    /** Per-hit context lines (0 disables). Clamp before calling. */
    ctx: number;
    /** Window seconds around [firstHit, lastHit] (0 disables). Clamp before calling. */
    winSec: number;
    /** Max physical lines returned (the NEWEST part of the selection). */
    n: number;
}

interface LogQueryResult {
    /** Match count for a filtered query, else the streamed line count. */
    total: number;
    /** lines.length */
    shown: number;
    /** Selection rows dropped by the `n` cap (older than what is shown). */
    omitted: number;
    lines: string[];
    /** Present iff filtered: parallel to lines — true on actual hits. */
    isMatch?: boolean[];
}

// Bare local-time stamps (current format) and the older `Z` / offset forms all
// must parse: one log file outlives a format change.
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/;

function parseTs(line: string): number {
    const m = TS_RE.exec(line);
    if (!m) return NaN;
    const v = Date.parse(m[1]!);
    return Number.isFinite(v) ? v : NaN;
}

/** Fixed-capacity ring of selected rows — memory is the answer size, however
 *  many lines stream past. */
class Tail {
    private readonly lines: string[];
    private readonly flags: boolean[];
    private seen = 0;
    constructor(readonly cap: number) {
        this.lines = new Array<string>(cap);
        this.flags = new Array<boolean>(cap);
    }

    push(line: string, isMatch: boolean): void {
        const at = this.seen % this.cap;
        this.lines[at] = line;
        this.flags[at] = isMatch;
        this.seen += 1;
    }

    /** Selected rows kept, and the number discarded by the cap. */
    counts(): { kept: number; omitted: number } {
        const kept = Math.min(this.seen, this.cap);
        return { kept, omitted: this.seen - kept };
    }

    /** The kept rows, oldest first. */
    take(): { lines: string[]; flags: boolean[] } {
        const { kept } = this.counts();
        const lines: string[] = new Array(kept);
        const flags: boolean[] = new Array(kept);
        const first = this.seen - kept;
        for (let i = 0; i < kept; i++) {
            const at = (first + i) % this.cap;
            lines[i] = this.lines[at]!;
            flags[i] = this.flags[at]!;
        }
        return { lines, flags };
    }
}

/** Streaming ±ctx selector: overlapping/touching [hit−ctx, hit+ctx] ranges
 *  merge exactly as the index sweep did, without index lists. The buffer is
 *  bounded by `2*ctx + 1` rows — a match-dense log cannot grow it. */
class ContextSelector {
    private readonly before: string[];
    private beforeSeen = 0;
    private after = 0;

    constructor(private readonly ctx: number) {
        this.before = new Array<string>(ctx);
    }

    /** Feed directly into the bounded answer without allocating per-line rows. */
    feed(line: string, hit: boolean, tail: Tail): void {
        if (hit) {
            const count = Math.min(this.beforeSeen, this.ctx);
            for (let i = this.beforeSeen - count; i < this.beforeSeen; i++) {
                tail.push(this.before[i % this.ctx]!, false);
            }
            this.beforeSeen = 0;
            this.after = this.ctx;
            tail.push(line, true);
        } else if (this.after > 0) {
            tail.push(line, false);
            this.after -= 1;
        } else {
            this.before[this.beforeSeen % this.ctx] = line;
            this.beforeSeen += 1;
        }
    }
}

/** Query the retained log set. `files` is the generation list, oldest first —
 *  the same order the previous materialized array held. */
export async function queryLogFiles(
    files: readonly string[],
    q: string,
    opts: LogQueryOptions,
    readOpts: ReadLogLinesOptions = {},
): Promise<LogQueryResult> {
    const n = Math.max(1, Math.floor(opts.n));
    const qLower = q.toLowerCase();
    const hitOf = (line: string): boolean => qLower.length > 0 && line.toLowerCase().includes(qLower);
    if (readOpts.onError) {
        const onError = readOpts.onError;
        let failedFiles: Set<string> | undefined;
        readOpts = {
            ...readOpts,
            onError(file, error) {
                failedFiles ??= new Set();
                if (failedFiles.has(file)) return;
                failedFiles.add(file);
                onError(file, error);
            },
        };
    }

    if (!qLower) {
        // Raw tail: no filter, no isMatch, no cap-related survivors beyond n.
        const tail = new Tail(n);
        let total = 0;
        for await (const line of readLogLines(files, readOpts)) {
            total += 1;
            tail.push(line, false);
        }
        const { lines } = tail.take();
        const { omitted } = tail.counts();
        return { total, shown: lines.length, omitted, lines };
    }

    if (opts.winSec > 0) {
        const endpoints = await windowEndpoints(files, hitOf, opts.winSec, readOpts);
        // No hits at all: empty result, as the index version returned.
        if (endpoints && endpoints.total === 0) {
            return { total: 0, shown: 0, omitted: 0, lines: [], isMatch: [] };
        }
        // Degrades to exact hits when either endpoint has no parsable stamp,
        // exactly as the index version did.
        return endpoints
            ? await windowSelection(files, hitOf, endpoints, n, readOpts)
            : await exactSelection(files, hitOf, n, readOpts);
    }

    if (opts.ctx > 0) return await contextSelection(files, hitOf, opts.ctx, n, readOpts);
    return await exactSelection(files, hitOf, n, readOpts);
}

interface WindowEndpoints {
    /** Hit count over the whole stream. */
    total: number;
    loT: number;
    hiT: number;
    /** Zero-based row index of the LAST hit, so pass 2 knows where the
     *  forward walk starts. Rows before it are inside the range. */
    lastHitIndex: number;
}

/** Pass 1 of window mode: hit count, the boundary timestamps and the last
 *  hit's row index.
 *  Endpoints use the INHERITED stamp of the first and last hit — a hit with no
 *  stamp of its own takes the last stamp seen before it.
 *  `null` means neither endpoint is parsable → caller degrades to exact. */
async function windowEndpoints(
    files: readonly string[],
    hitOf: (line: string) => boolean,
    winSec: number,
    readOpts: ReadLogLinesOptions,
): Promise<WindowEndpoints | null> {
    let total = 0;
    let index = 0;
    let inherited = NaN;
    let firstHitTs = NaN;
    let lastHitTs = NaN;
    let lastHitIndex = -1;
    for await (const line of readLogLines(files, readOpts)) {
        const own = parseTs(line);
        if (Number.isFinite(own)) inherited = own;
        if (hitOf(line)) {
            if (total === 0) firstHitTs = inherited;
            lastHitTs = inherited;
            lastHitIndex = index;
            total += 1;
        }
        index += 1;
    }
    if (total === 0) return { total, loT: NaN, hiT: NaN, lastHitIndex };
    if (!Number.isFinite(firstHitTs) || !Number.isFinite(lastHitTs)) return null;
    return { total, loT: firstHitTs - winSec * 1000, hiT: lastHitTs + winSec * 1000, lastHitIndex };
}

/** Pass 2 of window mode: stream again and emit the contiguous row range
 *  [loIdx, hiIdx]. loIdx is found by walking BACK from the first hit while
 *  each preceding row's inherited stamp is >= loT; hiIdx by walking FORWARD
 *  from the last hit while each following row's inherited stamp is <= hiT.
 *  A row with no parsable stamp never extends either walk, exactly as the
 *  index version's `Number.isFinite(ts[i])` guards did.
 *
 *  Rows strictly between the two hits are always inside the range, so they are
 *  emitted unconditionally once the first hit arrives — including a row whose
 *  own stamp is missing, which is why the walk is only needed at the edges. */
async function windowSelection(
    files: readonly string[],
    hitOf: (line: string) => boolean,
    { total, loT, hiT, lastHitIndex }: WindowEndpoints,
    n: number,
    readOpts: ReadLogLinesOptions,
): Promise<LogQueryResult> {
    const tail = new Tail(n);
    // Lead-in rows accepted by the backward walk, oldest first, discarded the
    // moment a row fails the walk (an accepted lead-in is contiguous).
    let leadIn: string[] = [];
    let inherited = NaN;
    let inRange = false;
    let index = 0;

    for await (const line of readLogLines(files, readOpts)) {
        const own = parseTs(line);
        const ts = Number.isFinite(own) ? own : inherited;
        const hit = hitOf(line);

        if (!inRange) {
            if (hit) {
                inRange = true;
                // Accepted lead-in rows are non-hits by construction: the hit
                // branch would have consumed them otherwise.
                for (const row of leadIn) tail.push(row, false);
                leadIn = [];
                tail.push(line, true);
            } else if (Number.isFinite(ts) && ts >= loT) {
                leadIn.push(line);
            } else {
                // The backward walk stops before this row: nothing held is
                // contiguous with the upcoming hit any more.
                leadIn = [];
            }
        } else if (index <= lastHitIndex) {
            // Span between the hits: unconditionally inside the range.
            tail.push(line, hit);
        } else if (Number.isFinite(ts) && ts <= hiT) {
            // Forward walk past the last hit.
            tail.push(line, hit);
        } else {
            // Forward edge closed. Only the `n` newest rows survive anyway, so
            // the remaining files still have to be streamed only to keep the
            // total hit count; nothing else is retained.
            break;
        }

        if (Number.isFinite(own)) inherited = own;
        index += 1;
    }

    const { lines, flags } = tail.take();
    const { omitted } = tail.counts();
    return { total, shown: lines.length, omitted, lines, isMatch: flags };
}

/** Exact hits only: one pass, newest `n` hits. */
async function exactSelection(
    files: readonly string[],
    hitOf: (line: string) => boolean,
    n: number,
    readOpts: ReadLogLinesOptions,
): Promise<LogQueryResult> {
    const tail = new Tail(n);
    let total = 0;
    for await (const line of readLogLines(files, readOpts)) {
        if (!hitOf(line)) continue;
        total += 1;
        tail.push(line, true);
    }
    const { lines } = tail.take();
    const { omitted } = tail.counts();
    return { total, shown: lines.length, omitted, lines, isMatch: lines.map(() => true) };
}

/** Per-hit ±ctx with range merging: one pass, bounded pending buffer. */
async function contextSelection(
    files: readonly string[],
    hitOf: (line: string) => boolean,
    ctx: number,
    n: number,
    readOpts: ReadLogLinesOptions,
): Promise<LogQueryResult> {
    const selector = new ContextSelector(ctx);
    const tail = new Tail(n);
    let total = 0;
    for await (const line of readLogLines(files, readOpts)) {
        const hit = hitOf(line);
        if (hit) total += 1;
        selector.feed(line, hit, tail);
    }
    const { lines, flags } = tail.take();
    const { omitted } = tail.counts();
    return { total, shown: lines.length, omitted, lines, isMatch: flags };
}
