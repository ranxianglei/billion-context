// #2580 (#1518 stage 2): salvage ladder for compress tool-call arguments on
// the plugin verbatim lane. Hosts here (dsh desktop) run ONE strict
// JSON.parse per tool call; failure aborts the whole turn (MALFORMED_RESPONSE)
// before any lenient parsing sees the bytes, and this relay holds the complete
// argument string before the host parses it — the only layer where a rescue
// still saves the turn.
// #1039 boundary: VALID-JSON arguments are forwarded byte-identical; rewrites
// happen only after strict JSON.parse fails, and every rescue is
// acceptance-tested by re-parsing through parseCompressArgs.

import { parseCompressArgs, type ParsedCompressInput } from "acp-kernel";

type CompressArgSalvageAction =
    | "verbatim"        // strict JSON — untouched (#1039 invariant)
    | "canonicalized"   // kernel lenient ladder recovered ranges → strict JSON array form
    | "wrapped"         // bare line-form value after "content": → {"content":"…"}
    | "unrecoverable";  // forwarded as-is (host will reject; diagnostics logged upstream)

interface CompressArgSalvage {
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

// #4889: bad-shape A wrap step extracted so this wire rewrite AND the shared
// execution-layer parser (parseCompressInput) run ONE implementation instead of
// two regex copies. Undefined when the shape doesn't match or no candidate
// survives the acceptance re-parse — callers keep their own result.
interface BareContentWrap {
    wrapped: string; // strict JSON: {"content":"…"}
    parsed: ParsedCompressInput;
}
export function tryBareContentWrap(raw: string, callId?: string): BareContentWrap | undefined {
    const m = BARE_CONTENT_RE.exec(raw);
    if (!m || !REF_TOKEN_RE.test(m[1])) return undefined;
    for (const candidate of [m[1], m[1].replace(/[\s"}\]]+$/, "")]) {
        const wrapped = JSON.stringify({ content: candidate });
        const parsed = parseCompressArgs(wrapped, callId !== undefined ? { callId } : undefined);
        if (parsed.ranges.length > 0) return { wrapped, parsed };
    }
    return undefined;
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

    const bare = tryBareContentWrap(raw, callId);
    if (bare !== undefined) {
        return { out: bare.wrapped, action: "wrapped", kind: bare.parsed.diagnostics.kind, ranges: bare.parsed.ranges.length };
    }

    return { out: raw, action: "unrecoverable", ranges: 0 };
}
