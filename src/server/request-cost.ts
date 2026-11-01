import { noteRequest } from "../attach-heartbeat.js";
import { currentFetchTransport } from "../fetch-transport.js";

// #903: per-request local-cost line, logged at every point where bili finishes
// its own processing and hands the request off (upstream forward, forged local
// response, or fail-fast error) — see handle(). outbound is the exact body value
// handed to forward() (string OR Buffer — Prepared.body is string|Buffer); wire
// bytes are counted with Buffer.byteLength since undici sends UTF-8 bytes even
// for string bodies (.length would count UTF-16 chars and undercount any
// non-ASCII injection). Omitted on paths that fail fast without forwarding.
function formatBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MiB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GiB`;
}

// #4528: the existing count threshold is an advisory policy, not a measured
// event-loop stall. Report the count and measured local preparation time;
// neither the count nor this diagnostic attributes historical slow requests.
const LARGE_HISTORY_MSG_WARN = 1000;

export function logRequestCost(log: (level: string, msg: string) => void, sessionId: string, msgs: number | null, inboundBytes: number, t0: number, outbound?: string | Buffer): void {
    const ms = Math.max(0, Math.round(performance.now() - t0));
    const outboundField = outbound !== undefined ? `, outbound=${formatBytes(Buffer.byteLength(outbound))}` : "";
    const view = currentFetchTransport() ? ", view=ws-expanded" : "";
    log("info", `[${sessionId}] request: ${msgs ?? "?"} msgs, inbound=${formatBytes(inboundBytes)}${outboundField}, local=${ms}ms${view}`);
    // #5408: this line is THE observation point — a hot-at-attach session that
    // never produces one is silent compression loss (the incident signature).
    noteRequest(sessionId);
    if (msgs !== null && msgs > LARGE_HISTORY_MSG_WARN) {
        log("warn", `[${sessionId}] large-history: ${msgs} msgs / inbound=${formatBytes(inboundBytes)}, local=${ms}ms — count-triggered advisory (#4528), not evidence of event-loop starvation; use measured request timings to investigate slow requests`);
    }
}
