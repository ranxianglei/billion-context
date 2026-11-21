// #7478: carrier-arg parsing shared by the two carrier-recognition sites —
// stripKernelSummaries (src/server.ts, the strip verdict) and
// reconcilePluginFoldCallIds (src/plugin.ts, the post-hoc adoption). Both must
// recognize the SAME set of range entries, or a fold's carrier is double-billed
// (anchor + call) on one path and stripped on the other. The two sites live in
// modules with a one-way dependency (server → plugin), so the shared parser
// lives here, imported by both.
//
// The CURRENT compress args shape is `content` as a PLAIN STRING of line blocks
// ("m00150–m0220 topic\n<summary>…") per the kernel COMPRESS_TOOL contract — the
// two JSON shapes (flat {startId,endId} / {content:[{startId,endId}]}) were the
// plugin-era formats and are still accepted for drift.

export interface CarrierEntry {
    startRef: string;
    endRef: string;
    /** Whether the args still carry the FULL summary text for this range (a
     *  call stubbed by the kernel's consumed-call compaction no longer does;
     *  see #5866). */
    carryingFull: boolean;
}

// Stub signature of hideConsumedCompressCalls (kernel/src/hide-consumed.ts:
// `clampPrefix(summary, 200 - 1) + "…"` → exactly 200 chars ending in "…").
// A genuine 200-char summary ending in "…" reads as a stub here → anchor kept
// → the safe direction (never zero carriers). Mirrored, not imported: the
// kernel constant is not exported and the host already mirrors kernel rules
// at their seams (#17 discipline).
const CARRIER_STUB_SIGNATURE = 200;
function summaryIsFull(s: unknown): boolean {
    return typeof s === "string" && !(s.length === CARRIER_STUB_SIGNATURE && s.endsWith("…"));
}

// #7478: the header of one line-format range block in a `content` string.
// Acceptance mirrors the kernel's parseLineEntry EXACTLY (kernel/src/
// parse-compress-input.ts REF_PAIR_IN_LINE / SINGLE_REF_IN_LINE /
// UNRECOGNIZED_REF_SEP_RE): a ref pair with a known separator, or a single ref
// (startRef == endRef); a pair with an unrecognized separator is REJECTED by
// the kernel (no block is created), so it must never register here either.
// Refs normalize like the kernel's normalizeLineRef: m-refs pad to 5 digits,
// b-refs pass through — b-refs are BLOCK ids, the header form the nudge's
// tier condensation/distillation instructs (kernel compress.ts tierActionHint),
// and merged blocks keep them as startRef/endRef verbatim.
const LINE_CARRIER_PAIR = /^([mb])(\d{1,7})\s*(?:[-\u2013\u2014\u2026~\u2212\uFF0D]|\.{2,3}|to)\s*([mb])(\d{1,7})\b/i;
const LINE_CARRIER_SINGLE = /^([mb])(\d{1,7})\b/i;
const LINE_CARRIER_BAD_SEP = /^\s*[^\p{L}\p{N}\s]{1,3}\s*[mb]\d{1,7}\b/iu;
function normalizeCarrierRef(prefix: string, digits: string): string {
    return prefix.toLowerCase() === "b" ? `b${digits}` : `m${digits.padStart(5, "0")}`;
}
function lineCarrierHeader(head: string): { startRef: string; endRef: string; matchEnd: number } | null {
    const pair = LINE_CARRIER_PAIR.exec(head);
    if (pair) {
        return {
            startRef: normalizeCarrierRef(pair[1]!, pair[2]!),
            endRef: normalizeCarrierRef(pair[3]!, pair[4]!),
            matchEnd: pair[0].length,
        };
    }
    const single = LINE_CARRIER_SINGLE.exec(head);
    if (single && !LINE_CARRIER_BAD_SEP.test(head.slice(single[0].length))) {
        const ref = normalizeCarrierRef(single[1]!, single[2]!);
        return { startRef: ref, endRef: ref, matchEnd: single[0].length };
    }
    return null;
}

export function parseCarrierEntries(text: string): CarrierEntry[] {
    const out: CarrierEntry[] = [];
    // Adapters may persist rendered tag text in front of the args JSON — start
    // at the first "{" like the kernel's parseCallText (hide-consumed.ts).
    const start = text.indexOf("{");
    if (start < 0) return out;
    let parsed: unknown;
    try {
        parsed = JSON.parse(text.slice(start));
    } catch {
        return out;
    }
    if (!parsed || typeof parsed !== "object") return out;
    type CarrierArgEntry = { startRef?: unknown; startId?: unknown; endRef?: unknown; endId?: unknown; messageId?: unknown; summary?: unknown };
    const obj = parsed as CarrierArgEntry & { content?: unknown };
    // Field-name priority mirrors the kernel's validateEntry (startRef/endRef
    // canonical, startId/endId model drift, messageId fallback).
    const register = (r: CarrierArgEntry, fullOverride?: boolean): void => {
        const s = typeof r.startRef === "string" ? r.startRef : typeof r.startId === "string" ? r.startId : typeof r.messageId === "string" ? r.messageId : "";
        const e = typeof r.endRef === "string" ? r.endRef : typeof r.endId === "string" ? r.endId : typeof r.messageId === "string" ? r.messageId : "";
        if (!s || !e) return;
        out.push({ startRef: s, endRef: e, carryingFull: fullOverride ?? summaryIsFull(r.summary) });
    };
    if (Array.isArray(obj.content)) {
        for (const r of obj.content) {
            if (r && typeof r === "object") register(r as CarrierArgEntry);
        }
    } else if (typeof obj.content === "string") {
        // Stringified JSON array inside the args (#230, non-strict providers):
        // same entries, same fullness rule.
        let inner: unknown;
        try {
            inner = JSON.parse(obj.content);
        } catch {
            inner = undefined;
        }
        if (Array.isArray(inner)) {
            for (const r of inner) {
                if (r && typeof r === "object") register(r as CarrierArgEntry);
            }
        } else {
            // #7478 line format: "m00150–m0220 topic\n<summary>…\nm00300–…".
            // Header detection per line mirrors the kernel's entry split
            // (splitLineEntries: a line starting with a ref pair or single ref
            // starts a new entry); a range block's segment runs from its
            // header line to the next header line. Fullness = the summary part
            // (after the header line) clears the stub-length floor AND is not
            // the kernel's 200-char stub signature (clampPrefix(summary,199)+
            // "…", see summaryIsFull — the same rule the JSON shape applies).
            // The bare `segment.trim().length >= 200` floor alone misread a
            // stubbed line-form entry (exactly 200 chars + topic) as FULL →
            // stripped the anchor → zero full carriers on the wire once the
            // kernel's line-form stubbing (#4032 serializeLineCompacted) lands;
            // the stub-signature half of the check closes that. The summary
            // part is taken verbatim after the first newline (no leading trim —
            // a stub whose first char is a space must keep its 200-char length)
            // with only trailing whitespace dropped (the newline before the
            // next header line).
            const content = obj.content;
            const headers: Array<{ startRef: string; endRef: string; index: number; matchEnd: number }> = [];
            let lineStart = 0;
            for (let i = 0; ; i++) {
                const ch = content[i];
                if (ch !== "\n" && i !== content.length) continue;
                const head = content.slice(lineStart, i).trim();
                const h = lineCarrierHeader(head);
                if (h) headers.push({ ...h, index: lineStart, matchEnd: lineStart + h.matchEnd });
                if (i === content.length) break;
                lineStart = i + 1;
            }
            headers.forEach((h, i) => {
                const segStart = h.matchEnd;
                const segEnd = i + 1 < headers.length ? headers[i + 1]!.index : content.length;
                const rawSeg = content.slice(segStart, segEnd);
                const nl = rawSeg.indexOf("\n");
                const summaryRaw = (nl === -1 ? "" : rawSeg.slice(nl + 1)).replace(/\s+$/, "");
                out.push({ startRef: h.startRef, endRef: h.endRef, carryingFull: summaryRaw.length >= CARRIER_STUB_SIGNATURE && summaryIsFull(summaryRaw) });
            });
        }
    } else {
        register(obj);
    }
    return out;
}
