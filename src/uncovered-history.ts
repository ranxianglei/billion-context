import { countMessageTokens, defaultCountTokens, type CompressionBlock, type CompressionState, type CoreMessage } from "acp-kernel";

/** A contiguous run of ref-bearing messages that no active block covers. */
interface UncoveredRun {
    startRef: string;
    endRef: string;
    count: number;
    tokens: number;
}

interface UncoveredHistoryReport {
    /** Largest runs, capped by `maxRuns`. */
    runs: UncoveredRun[];
    /** Total uncovered runs in the report window. */
    runCount: number;
    /** Total uncovered messages in the report window. */
    messageCount: number;
    /** Token estimate for every uncovered message (not just the listed runs). */
    tokens: number;
}

interface UncoveredHistoryOptions {
    /** Soft-protected tail size; the last N ref-bearing messages are excluded. */
    preserveRecentMessages?: number;
    /** How many runs to list (largest first). Default 3. */
    maxRuns?: number;
    /** Drop runs below this token estimate. Default 0. */
    minTokens?: number;
}

const REF_RE = /^m(\d+)$/i;
const DEFAULT_PRESERVE_RECENT = 3;

function refNumOf(ref: string | undefined | null): number | null {
    if (typeof ref !== "string") return null;
    const m = REF_RE.exec(ref.trim());
    return m ? Number(m[1]) : null;
}

function fmtRef(n: number): string {
    return `m${String(n).padStart(5, "0")}`;
}

/**
 * Every ref number covered by an active block. Blocks record coverage as raw
 * message ids (`effectiveMessageIds`); a tier-2/3 block additionally owns its
 * children, so the walk recurses through `directBlockIds` for the cases where
 * the expanded id list was not persisted.
 */
export function coveredRefNumbers(state: CompressionState): Set<number> {
    const covered = new Set<number>();
    const byId = new Map<string, CompressionBlock>();
    for (const b of state.blocks) byId.set(b.blockId, b);
    const seen = new Set<string>();
    const add = (block: CompressionBlock): void => {
        if (seen.has(block.blockId)) return;
        seen.add(block.blockId);
        for (const raw of block.effectiveMessageIds ?? []) {
            const num = refNumOf(state.messageRefs.byRaw[raw]);
            if (num !== null) covered.add(num);
        }
        for (const childId of block.directBlockIds ?? []) {
            const child = byId.get(childId);
            if (child) add(child);
        }
    };
    for (const block of state.blocks) {
        if (block.active) add(block);
    }
    return covered;
}

/**
 * Refs the fold scanner never offers: live messages older than the protected
 * tail that no active block covers. They stay raw on every request, yet
 * `compress` reports "no compressible ranges remain" because that verdict is
 * derived from the scanner's own view, not from a coverage audit.
 */
export function uncoveredHistory(
    state: CompressionState,
    messages: CoreMessage[],
    options: UncoveredHistoryOptions = {},
): UncoveredHistoryReport {
    const preserve = Math.max(0, options.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT);
    const maxRuns = Math.max(1, options.maxRuns ?? 3);
    const minTokens = Math.max(0, options.minTokens ?? 0);
    const covered = coveredRefNumbers(state);
    const dead = new Set<number>();
    for (const ref of state.deadRefs ?? []) {
        const num = refNumOf(ref);
        if (num !== null) dead.add(num);
    }
    const entries: Array<{ num: number; msg: CoreMessage }> = [];
    for (const msg of messages) {
        const num = refNumOf(state.messageRefs.byRaw[msg.id]);
        if (num === null) continue;
        entries.push({ num, msg });
    }
    if (entries.length === 0) return { runs: [], runCount: 0, messageCount: 0, tokens: 0 };
    // Same protection premise the fold scanner uses: the newest
    // preserveRecentMessages ref-bearing messages are intentionally visible.
    const cutoff = Math.max(0, entries.length - preserve);
    const runs: Array<{ start: number; end: number; count: number; tokens: number }> = [];
    let cur: { start: number; end: number; count: number; tokens: number } | null = null;
    let messageCount = 0;
    let tokens = 0;
    for (let i = 0; i < cutoff; i++) {
        const { num, msg } = entries[i]!;
        const eligible = !covered.has(num) && !dead.has(num);
        if (!eligible) {
            if (cur) runs.push(cur);
            cur = null;
            continue;
        }
        const cost = countMessageTokens(msg, defaultCountTokens);
        messageCount += 1;
        tokens += cost;
        // Duplicate refs (split cores sharing one base id) stay in the same run.
        if (cur && (num === cur.end + 1 || num === cur.end)) {
            cur.end = num;
            cur.count += 1;
            cur.tokens += cost;
        } else {
            if (cur) runs.push(cur);
            cur = { start: num, end: num, count: 1, tokens: cost };
        }
    }
    if (cur) runs.push(cur);
    const kept = runs.filter((r) => r.tokens >= minTokens);
    const listed = kept
        .slice()
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, maxRuns)
        .map((r) => ({ startRef: fmtRef(r.start), endRef: fmtRef(r.end), count: r.count, tokens: r.tokens }));
    return { runs: listed, runCount: kept.length, messageCount, tokens };
}

function fmtTokens(n: number): string {
    if (n < 1000) return `${Math.max(1, Math.round(n))} tok`;
    return `~${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K tok`;
}

export function formatUncoveredHistory(report: UncoveredHistoryReport, opts: { compact?: boolean } = {}): string[] {
    if (report.runs.length === 0 || report.messageCount === 0) return [];
    const spans = report.runs
        .map((r) => (r.startRef === r.endRef ? `${r.startRef} (1 msg, ${fmtTokens(r.tokens)})` : `${r.startRef}–${r.endRef} (${r.count} msgs, ${fmtTokens(r.tokens)})`))
        .join(" · ");
    const head = `UNCOVERED HISTORY — ${report.messageCount} message(s) in ${report.runCount} run(s) are in no active block and still ride the wire raw (${fmtTokens(report.tokens)}). Largest: ${spans}.`;
    if (opts.compact) {
        return [`${head} The fold scanner does not offer these; fold a span directly ({startId,endId}) if it is worth reclaiming, otherwise continue.`];
    }
    return [
        head,
        "  The Compressible-ranges table above comes from the fold scanner and does NOT include these refs. Fold any span directly with compress({startId,endId}); the protected recent tail is already excluded here.",
    ];
}
