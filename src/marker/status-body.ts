// Inbound acp_status report-body stripping (#2789, #2811 marker spec class
// acp_status_body).
//
// buildVisibilityMarker (loop/core.ts) wraps reports in [acp-status] pairs.
// Consume complete pairs even if an earlier pass already stripped the head.
// Legacy reports have no wrapper, so the grammar below remains their contract
// with the renderers:
//   - kernel report:  kernel/src/report.ts (renderOverview / renderRanges /
//     renderMessages / block detail)
//   - host extras:    src/acp-status.ts (BILLED INPUT, breaker, STORE (CCR),
//     RETRIEVAL QUALITY, BLOCK SPANS, STORAGE, PRE-COMPACTION ARCHIVE,
//     CRITICAL ADVISORY / UPDATE, UNDECRYPTED TRAFFIC, UNRECOGNIZED PATHS)
//   - conflict view:  src/conflict-watch.ts (COMPRESSION CONFLICTS, Fix (…))
// tests/marker-render-contract.test.ts covers both emitted and legacy shapes.

import { STATUS_REPORT_OPEN, STATUS_REPORT_CLOSE } from "../acp-panel.js";

const STATUS_HEAD = /^\p{So}(?:[ \t])?\[ACP\][^\n]*acp_status[^\n]*\n?/gmu;

// Line-start prefixes that begin a report section. Keep them as narrow as
// the renderer makes them: a generic "capitalized + colon" rule would eat
// English prose that follows a pasted report.
const SECTION_HEADS: readonly string[] = [
    "ACTIVE SURFACE: ",
    "CONTEXT BREAKDOWN",
    "COMPRESSED BLOCKS",
    "COMPRESSED — ",
    "UNCOMPRESSED — ",
    "Sorted by size",
    "Sorted by time",
    "Sorted by tool",
    "Compressible ranges (",
    "BILLED INPUT ",
    "NOTE: the token figures",
    "FOLD BASE GENERATION MISMATCH — ",
    "FOLD SUBSTRATE INVALID — ",
    "STORE (CCR) — ",
    "RETRIEVAL QUALITY — ",
    "BLOCK SPANS — ",
    "STORAGE — ",
    "PRE-COMPACTION ARCHIVE — ",
    "COMPRESSION CONFLICTS — ",
    "CRITICAL ADVISORY (instance-level): ",
    "CRITICAL UPDATE READY (instance-level): ",
    "CRITICAL UPDATE AVAILABLE (instance-level): ",
    "UNDECRYPTED TRAFFIC (instance-level): ",
    "UNRECOGNIZED PATHS (instance-level): ",
    "Last failures were attributed to ",
    "The Compressible-ranges list above was re-derived",
    "Nudge: ",
    "Tip: ",
    "Breakdown: ",
    "Live state: GET /__bili/status",
    "Update with: npm install -g billion-context@",
];

// Lines that continue a section without starting one.
const CONTINUATION = [
    /^ {2,}\S/, // indented rows: block lines, tier usage, top tools, `  · …` bullets, `  … and N more`
    /^b\d+ \| /, // block detail rows (kernel/src/report.ts detail view)
    /^\d+ of \d+ shown\.$/,
    /^Fix \(/, // conflict remediation (src/conflict-watch.ts)
    /^Fix: /,
];

function isHeadLine(line: string): boolean {
    return SECTION_HEADS.some((h) => line.startsWith(h));
}

function isContinuationLine(line: string): boolean {
    return CONTINUATION.some((r) => r.test(line));
}

function isBodyLine(line: string): boolean {
    return isHeadLine(line) || isContinuationLine(line);
}

export interface StatusBodyResult {
    text: string;
    /** report bodies fully consumed (head + contiguous body) */
    bodies: number;
    /** body lines removed across all consumed reports */
    lines: number;
}

// Consume every `<icon> [ACP] … acp_status …` head together with its
// contiguous report body. Blank lines inside a report are eaten only when a
// recognizable section follows them, so trailing blank lines before the
// user's own prose survive. A head with NO recognizable body line after it
// is left in place — stripAcpTags owns plain marker lines.
export function consumeAcpStatusBody(text: string): StatusBodyResult {
    if (!text.includes(STATUS_REPORT_OPEN) && (!text.includes("[ACP]") || !text.includes("acp_status"))) return { text, bodies: 0, lines: 0 };
    const lines = text.split("\n");
    const out: string[] = [];
    let bodies = 0;
    let removed = 0;
    let i = 0;
    while (i < lines.length) {
        const hasHead = STATUS_HEAD.test(lines[i]);
        STATUS_HEAD.lastIndex = 0;
        const bodyStart = hasHead ? i + 1 : i;
        if (lines[bodyStart] === STATUS_REPORT_OPEN) {
            const end = lines.indexOf(STATUS_REPORT_CLOSE, bodyStart + 1);
            if (end !== -1) {
                bodies++;
                removed += end - bodyStart + 1;
                i = end + 1;
                continue;
            }
            // Without a terminator, keep the text rather than consume trailing prose.
        }
        if (!hasHead) {
            out.push(lines[i]);
            i++;
            continue;
        }
        let j = i + 1;
        let bodyLines = 0;
        while (j < lines.length) {
            const line = lines[j];
            if (line.length === 0) {
                // blank: part of the report only if another section follows
                let k = j + 1;
                while (k < lines.length && lines[k].length === 0) k++;
                if (k < lines.length && isBodyLine(lines[k])) {
                    j = k; // consume the blanks up to (not incl.) that section line
                    continue;
                }
                break;
            }
            if (!isBodyLine(line)) break;
            j++;
            bodyLines++;
        }
        if (bodyLines === 0) {
            // head with no body grammar behind it — not our shape
            out.push(lines[i]);
            i++;
            continue;
        }
        // drop trailing blank lines the body walk consumed but the report
        // does not own (j may sit past a blank run that bridged sections)
        bodies++;
        removed += bodyLines;
        i = j;
    }
    STATUS_HEAD.lastIndex = 0;
    if (bodies === 0) return { text, bodies: 0, lines: 0 };
    return { text: out.join("\n"), bodies, lines: removed };
}
