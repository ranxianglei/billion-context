// #2580 (#1518 stage 2): salvage ladder for compress tool-call arguments on
// the plugin verbatim lane. Hosts here (dsh desktop) run ONE strict
// JSON.parse per tool call; failure aborts the whole turn (MALFORMED_RESPONSE)
// before any lenient parsing sees the bytes, and this relay holds the complete
// argument string before the host parses it — the only layer where a rescue
// still saves the turn.
// #1039 boundary: VALID-JSON arguments are forwarded byte-identical; rewrites
// happen only after strict JSON.parse fails, and every rescue is
// acceptance-tested by re-parsing through parseCompressArgs.

import { parseCompressArgs } from "acp-kernel";

export type CompressArgSalvageAction =
    | "verbatim"        // strict JSON — untouched (#1039 invariant)
    | "canonicalized"   // kernel lenient ladder recovered ranges → strict JSON array form
    | "wrapped"         // bare line-form value after "content": → {"content":"…"}
    | "unrecoverable";  // forwarded as-is (host will reject; diagnostics logged upstream)

export interface CompressArgSalvage {
    out: string;
    action: CompressArgSalvageAction;
    kind?: string; // kernel diagnostics kind of the winning parse (rescues only)
    ranges: number;
}

// Bad shape A (#2580/#2579): `{"content": <bare line-form text …>` — the value
// has no opening quote and is not an array or object either.
const BARE_CONTENT_RE = /^\s*\{\s*["']content["']\s*:\s*(?!["\[{])([\s\S]*)$/;
const REF_TOKEN_RE = /\bm\d{1,7}\b/i;

interface CanonicalRange {
    startRef: string;
    endRef: string;
    summary: string;
    topic?: string;
    summaryMaxChars?: number;
}

function canonicalize(ranges: readonly CanonicalRange[]): string {
    return JSON.stringify({
        content: ranges.map((r) => ({
            startId: r.startRef,
            endId: r.endRef,
            summary: r.summary,
            ...(r.topic !== undefined ? { topic: r.topic } : {}),
            ...(r.summaryMaxChars !== undefined ? { summaryMaxChars: r.summaryMaxChars } : {}),
        })),
    });
}

export function salvageCompressArgs(raw: string, callId: string): CompressArgSalvage {
    try {
        JSON.parse(raw);
        return { out: raw, action: "verbatim", ranges: 0 };
    } catch { /* strict parse failed — enter the rescue ladders */ }

    const lenient = parseCompressArgs(raw, { callId });
    if (lenient.ranges.length > 0) {
        return { out: canonicalize(lenient.ranges), action: "canonicalized", kind: lenient.diagnostics.kind, ranges: lenient.ranges.length };
    }

    const m = BARE_CONTENT_RE.exec(raw);
    if (m && REF_TOKEN_RE.test(m[1])) {
        for (const candidate of [m[1], m[1].replace(/[\s"}\]]+$/, "")]) {
            const wrapped = JSON.stringify({ content: candidate });
            const reparsed = parseCompressArgs(wrapped, { callId });
            if (reparsed.ranges.length > 0) {
                return { out: wrapped, action: "wrapped", kind: reparsed.diagnostics.kind, ranges: reparsed.ranges.length };
            }
        }
    }

    return { out: raw, action: "unrecoverable", ranges: 0 };
}
