import fs from "node:fs";
import path from "node:path";
import { DUMP_PLAINTEXT_BANNER } from "./dump-banner.js";
import { dumpsDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { dump4xxEnabled as knobDump4xxEnabled, dump4xxMaxBytes as knobDump4xxMaxBytes } from "./knobs.js";
import { gcDumpDirIfConfigured } from "./state-gc.js";
import { safePrefix } from "./text-safe.js";

// #762: when the upstream rejects the forwarded body (4xx), persist the exact
// bytes that were sent so the rejection can be explained byte-for-byte. The
// standing body dump (ACP_DUMP_BODY=1) must be armed BEFORE the incident; this
// one fires on the failure itself. Still off by default — conversation bodies
// leak to disk (#276) — enable with BILI_DUMP_4XX=1 or diagnostics.dump4xx.
// #4482: like every plaintext-body dump, each file starts with the standing
// credentials warning banner (DUMP_PLAINTEXT_BANNER).

let failCount = 0;
let lastFailLog = 0;

// #4482 follow-up (#4297): the banner line is part of the file on disk, so it
// must count against the operator's byte cap — otherwise every dump exceeds
// the knob by exactly the banner and the "final UTF-8 bytes" contract breaks.
function cappedBudget(): number {
    const bannerOverhead = Buffer.byteLength(DUMP_PLAINTEXT_BANNER) + 1; // banner + "\n"
    return Math.max(knobDump4xxMaxBytes() - bannerOverhead, 0);
}

function warnDumpFailure(err: unknown): void {
    failCount++;
    const now = Date.now();
    if (failCount === 1 || now - lastFailLog >= 60_000) {
        lastFailLog = now;
        const msg = err instanceof Error ? err.message : String(err);
        loggerLog("warn", `[dump] rejected-body dump failed (total ${failCount}x): ${msg}`);
    }
}

function textBytes(text: string, escaped: boolean, limit = Infinity): number {
    if (text.length > limit) return Infinity;
    return Buffer.byteLength(escaped ? JSON.stringify(text) : text) - (escaped ? 2 : 0);
}

function capText(text: string, budget: number, escaped = false): string {
    if (textBytes(text, escaped, budget) <= budget) return text;
    const marker = (omitted: number): string => `\n[truncated: ${omitted} more character(s)]\n`;
    // Reserve the longest marker before searching so prefix cost is monotonic.
    const available = budget - textBytes(marker(text.length), escaped);
    let lo = 0;
    let hi = Math.min(text.length, Math.max(0, Math.floor(available)));
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (textBytes(safePrefix(text, mid), escaped) <= available) lo = mid;
        else hi = mid - 1;
    }
    const prefix = safePrefix(text, lo);
    return prefix + marker(text.length - prefix.length);
}

/** Write the rejected forwarded body to `<dumpDir>/err-<ts>-<sid>-<status>.json`
 *  when BILI_DUMP_4XX=1. Returns the file path, or null when disabled/skipped/failed. */
export function dumpRejectedBody(status: number, sessionId: string, body: string | Buffer): string | null {
    if (!knobDump4xxEnabled()) return null;
    const raw = typeof body === "string" ? body : body.toString("utf8");
    if (!raw) return null;
    try {
        const cap = cappedBudget();
        let text = raw;
        if (Buffer.byteLength(raw) <= cap) {
            try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep non-JSON bodies raw */ }
        }
        text = capText(text, cap);
        const dir = dumpsDir();
        fs.mkdirSync(dir, { recursive: true });
        const sid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const out = path.join(dir, `err-${Date.now()}-${sid}-${status}.json`);
        fs.writeFileSync(out, `${DUMP_PLAINTEXT_BANNER}\n${text}`);
        loggerLog("info", `[dump] upstream ${status} rejected body written to ${out}`);
        gcDumpDirIfConfigured(dir);
        return out;
    } catch (err) {
        warnDumpFailure(err);
        return null;
    }
}

// #1993: persist a rejected PREFLIGHT SUMMARY exchange — both sides of it, the
// request bytes bili sent and the response bytes the upstream answered — when
// BILI_DUMP_4XX=1. The summary call is built independently of the forwarded
// wire body, so dumpRejectedBody's two main-path call sites never see it;
// without this, "summarization failed: HTTP 400" could not be explained
// byte-for-byte after the fact. Separate `summary-err-` prefix so a main-path
// and a summary dump landing in the same millisecond cannot clobber each
// other. Sides are embedded as strings so the envelope stays valid JSON even
// when a side is not itself JSON.
export function dumpSummaryRejection(status: number, sessionId: string, request: string, response: string): string | null {
    if (!knobDump4xxEnabled()) return null;
    if (!request && !response) return null;
    try {
        const cap = cappedBudget();
        const side = (raw: string): string => {
            if (Buffer.byteLength(raw) > cap) return raw;
            try { return JSON.stringify(JSON.parse(raw)); } catch { return raw; }
        };
        const requestText = side(request);
        const responseText = side(response);
        const overhead = Buffer.byteLength(JSON.stringify({ status, request: "", response: "" }, null, 2));
        const budget = cap - overhead;
        const requestBytes = textBytes(requestText, true, budget);
        const responseBytes = textBytes(responseText, true, budget);
        const requestBudget = Math.min(requestBytes, Math.max(budget - responseBytes, Math.floor(budget / 2)));
        const envelope = {
            status,
            request: capText(requestText, requestBudget, true),
            response: capText(responseText, budget - requestBudget, true),
        };
        const dir = dumpsDir();
        fs.mkdirSync(dir, { recursive: true });
        const sid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const out = path.join(dir, `summary-err-${Date.now()}-${sid}-${status}.json`);
        fs.writeFileSync(out, `${DUMP_PLAINTEXT_BANNER}\n${JSON.stringify(envelope, null, 2)}`);
        loggerLog("info", `[dump] upstream ${status} rejected summary exchange written to ${out}`);
        gcDumpDirIfConfigured(dir);
        return out;
    } catch (err) {
        warnDumpFailure(err);
        return null;
    }
}
