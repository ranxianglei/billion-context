import { noteRequest } from "../attach-heartbeat.js";
import { perfRecordRequest } from "../perf-telemetry.js";
import { currentFetchTransport } from "../fetch-transport.js";

// #903: per-request local-cost line, logged at every point where bili finishes
// its own processing and hands the request off (upstream forward, forged local
// response, or fail-fast error) — see handle(). outbound is the final body value
// actually handed to fetch (string OR Buffer), measured inside forwardCaptured
// after compatibility rewriting, egress shedding, signing and V1 wrapping; wire
// bytes are counted with Buffer.byteLength since undici sends UTF-8 bytes even
// for string bodies (.length would count UTF-16 chars and undercount any
// non-ASCII injection). Omitted where no body is handed to fetch (local forge,
// fail fast).
export function formatBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MiB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GiB`;
}

// #5744: the advisory budget is WALL CLOCK, never message COUNT — one reporter
// session cost 0.8s and 14.5s at the same ~3k msgs, so the count cannot separate
// cost from size (the info line still carries the count for correlation).
// #4528/#5481: this line reports measured facts only (count, inbound bytes,
// measured local time). It does not attribute the cost to event-loop starvation
// and does not advise restarting the session or enabling compression — neither
// follows from elapsed time alone, and a restart is a lossy action.
const SLOW_SESSION_MS_WARN = 1000;
// #5907 follow-up: the warn fires ONCE per session per process — a 3k-msg
// session exceeds the wall budget on EVERY turn, so re-logging each turn
// floods the log while adding nothing; the first occurrence carries the full
// size picture (msgs + inbound + est tokens) plus the cleanup command. The
// map is bounded: past the cap the earliest-warned session is evicted so a
// long-lived proxy with many sessions cannot grow it without bound.
const SLOW_SESSION_WARNED = new Map<string, number>();
const MAX_SLOW_SESSION_WARNED = 512;
export function _resetSlowSessionWarnedForTest(): void {
    SLOW_SESSION_WARNED.clear();
}

export function logRequestCost(log: (level: string, msg: string) => void, sessionId: string, msgs: number | null, inboundBytes: number, t0: number, outbound?: string | Buffer): void {
    const ms = Math.max(0, Math.round(performance.now() - t0));
    // #5460 P1: structured mirror of this line into perf.sqlite (inert unless
    // a DB-backed storage mode armed the module; degrades, never throws).
    perfRecordRequest({ sessionId, msgs, inboundBytes, outboundBytes: outbound !== undefined ? Buffer.byteLength(outbound) : null, totalMs: ms });
    const outboundField = outbound !== undefined ? `, outbound=${formatBytes(Buffer.byteLength(outbound))}` : "";
    const view = currentFetchTransport() ? ", view=ws-expanded" : "";
    log("info", `[${sessionId}] request: ${msgs ?? "?"} msgs, inbound=${formatBytes(inboundBytes)}${outboundField}, local=${ms}ms${view}`);
    // #5408: this line is THE observation point — a hot-at-attach session that
    // never produces one is silent compression loss (the incident signature).
    noteRequest(sessionId);
    if (ms > SLOW_SESSION_MS_WARN && !SLOW_SESSION_WARNED.has(sessionId)) {
        SLOW_SESSION_WARNED.set(sessionId, ms);
        while (SLOW_SESSION_WARNED.size > MAX_SLOW_SESSION_WARNED) {
            const oldest = SLOW_SESSION_WARNED.keys().next().value;
            if (oldest === undefined) break;
            SLOW_SESSION_WARNED.delete(oldest);
        }
        // bytes/4 is the repo-wide optimistic token floor (same caliber as the
        // oversize gates) — labeled est because JSON overhead skews it high.
        const estTok = Math.round(inboundBytes / 4);
        log("warn", `[${sessionId}] slow-session: ${msgs ?? "?"} msgs / inbound=${formatBytes(inboundBytes)} (~${estTok} est tok) took local=${ms}ms — past the ${SLOW_SESSION_MS_WARN}ms wall-clock budget (#5744); measured facts only, cause not attributed — not evidence of event-loop starvation (#4528); the session has grown large — consider \`bili sessions rm ${sessionId}\` (#5907)`);
    }
}
