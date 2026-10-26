import { log as loggerLog } from "../logger.js";
import { maskUrlsInText } from "../log-mask.js";
import { bodyDumpEnabled as knobBodyDumpEnabled } from "../knobs.js";

// Body dumps (dumps/req-*.json, raw/*-REQ.txt, raw/*-RES.txt, raw/*-INCOMING.txt,
// req-*-REREQUEST.json) write the full plaintext request body and are off by
// default. They are decoupled from --debug (verbose logging) and enabled only
// with ACP_DUMP_BODY=1 / diagnostics.dumpBody so `bili <client>` users don't
// leak conversation bodies to disk by default (#276).
export function bodyDumpEnabled(): boolean {
    return knobBodyDumpEnabled();
}

// Raw dumps are best-effort: a failure (disk full, locked dir, EPERM) must not
// break the request, but a silently-stopped dump hides real problems (#362).
// Rate-limited so a stuck dir doesn't spam the log.
let dumpFailCount = 0;
let lastDumpFailLog = 0;
export function logDumpFailure(where: string, err: unknown): void {
    dumpFailCount++;
    const now = Date.now();
    if (dumpFailCount === 1 || now - lastDumpFailLog >= 60_000) {
        lastDumpFailLog = now;
        const msg = err instanceof Error ? err.message : String(err);
        loggerLog("warn", `[dump] ${where} failed (total ${dumpFailCount}x): ${msg}`);
    }
}

// Non-protocol paths (client telemetry like /api/v1/event/report, ...) are
// forwarded unchanged — expected, not an error. Logging every hit spammed the
// log (~20k lines in one user's capture, #362). Per-path: first 3 at warn, one
// "suppressed" notice, then silent.
const unrecognizedPathCounts = new Map<string, number>();
export function logUnrecognizedPath(log: (level: string, msg: string) => void, url: string): void {
    // Strip the query before masking: a varying query (?ts=…) would otherwise
    // split one endpoint into unbounded keys and defeat the rate limit.
    const key = maskUrlsInText(url.split("?")[0]);
    const n = (unrecognizedPathCounts.get(key) ?? 0) + 1;
    unrecognizedPathCounts.set(key, n);
    if (n <= 3) {
        log("warn", `unrecognized path ${key} — not a known protocol (/chat/completions, /llm_raw_chat, /v1/messages, /responses, /responses/compact); forwarding unchanged`);
    } else if (n === 4) {
        log("info", `unrecognized path ${key}: forwarding unchanged; further occurrences suppressed`);
    }
}

// #1290: instance-level view of the map above — surfaced at /__bili/stats
// (unrecognizedPaths) and in the /acp status report so "this path never got
// compressed" is visible in a status face, not just 3 transient stderr warns.
type UnrecognizedPathStats = { total: number; paths: Record<string, number> };
export function getUnrecognizedPathStats(): UnrecognizedPathStats {
    const paths: Record<string, number> = {};
    let total = 0;
    for (const [path, n] of unrecognizedPathCounts) {
        paths[path] = n;
        total += n;
    }
    return { total, paths };
}

// Model-enumeration endpoints clients probe at startup (omp's openai-models-list
// discovery). Expected passthroughs, not unknown protocols — #393: exempt from
// the warn-level "unrecognized path" log.
export function isModelDiscoveryPath(path: string): boolean {
    return path.replace(/\/+$/, "").endsWith("/models");
}

// #3129: Antigravity fires seven non-model /v1internal:* control-plane POSTs
// (loadCodeAssist, fetchUserInfo, retrieveUserQuotaSummary, listExperiments,
// fetchAdminControls, fetchAvailableModels, writeTrajectoryAcls) at startup and
// during a session. Expected passthroughs — exempt from the "unrecognized path"
// warn/stats like isModelDiscoveryPath. The three model endpoints are matched by
// googlePathKind and never reach this path, so they are excluded by the lookahead.
export function isV1InternalControlPlanePath(path: string): boolean {
    // The proxy sees these as `/bili/<origin>/v1internal:<ep>` — match the
    // endpoint by suffix so the routing prefix doesn't defeat the exemption.
    const p = path.split("?", 2)[0];
    return /\/v1internal:(?!streamGenerateContent$|generateContent$|countTokens$)/.test(p);
}
