// Single-pass structural scan of chat-completions request bodies for the
// #5403 watermark fastpath. Locates the raw-text spans of every element of
// the top-level "messages" array (plus optional sibling field values)
// WITHOUT decoding any string payload: the walker tracks bracket nesting
// and JSON string state only. On a fastpath hit the caller slices ONLY the
// spans it needs (head elements, tail elements [k..), scalar values) from
// the same buffer and parses those tiny fragments — the untouched middle of
// a multi-hundred-MiB resent body is never decoded at all.
//
// Contract (fail-soft, never guess):
//  - Returns null whenever the body is malformed, truncated, outside the
//    supported shape, or exceeds the nesting cap — callers MUST fall back
//    to the legacy full-parse path; a null scan is never an error signal
//    in itself (the legacy path re-parses and produces its own diagnostics).
//  - Offsets are UTF-16 code-unit positions: valid for String.slice on the
//    original body text.
//  - Duplicate top-level keys follow JSON.parse semantics (last one wins).
//  - Allocates only the result arrays (one span object per element).

export interface RawSpan { readonly start: number; readonly end: number }

export interface FastpathScanResult {
    /** Element count T of the top-level "messages" array. */
    readonly total: number;
    /** Raw span of each messages element, in wire order. */
    readonly messageSpans: readonly RawSpan[];
    /** Raw value spans of extra top-level keys requested by the caller
     *  ("all" keeps every top-level key). */
    readonly fieldSpans: ReadonlyMap<string, RawSpan>;
}

const DEPTH_CAP = 1024;

export function scanMessagesSpans(
    bodyText: string,
    extraKeys: readonly string[] | "all" = [],
): FastpathScanResult | null {
    const s = bodyText;
    const n = s.length;
    let i = 0;
    let depth = 0;
    const messageSpans: RawSpan[] = [];
    const fieldSpans = new Map<string, RawSpan>();
    try {
        const isWs = (j: number): boolean => {
            const c = s.charCodeAt(j);
            return c === 32 || c === 9 || c === 10 || c === 13;
        };
        const skipWs = (): void => { while (i < n && isWs(i)) i++; };
        // s[i] must be '"'. Advances i just past the closing quote, or
        // throws on any violation (raw control char, bad escape, EOF).
        const readString = (): void => {
            i++;
            for (;;) {
                if (i >= n) throw new Error("e");
                const c = s.charCodeAt(i);
                if (c === 34) { i++; return; }
                if (c < 32) throw new Error("e");
                if (c !== 92) { i++; continue; }
                i++;
                const e = s.charCodeAt(i);
                if (e === 34 || e === 92 || e === 47 || e === 98 || e === 102 || e === 110 || e === 114 || e === 116) { i++; continue; }
                if (e === 117) {
                    for (let h = 0; h < 4; h++) {
                        i++;
                        const d = s.charCodeAt(i);
                        const hex = (d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102);
                        if (!hex) throw new Error("e");
                    }
                    continue;
                }
                throw new Error("e");
            }
        };
        // Walks one complete JSON value starting at i (leading ws skipped by
        // the caller). On return i sits just past the value.
        const walkValue = (): void => {
            if (i >= n) throw new Error("e");
            const c = s.charCodeAt(i);
            if (c === 34) { readString(); return; }
            if (c === 123 || c === 91) {
                depth++;
                if (depth > DEPTH_CAP) throw new Error("e");
                i++;
                const close = c === 123 ? 125 : 93;
                skipWs();
                if (i >= n) throw new Error("e");
                if (s.charCodeAt(i) === close) { i++; depth--; return; }
                for (;;) {
                    if (c === 91) {
                        walkValue();
                    } else {
                        skipWs();
                        if (i >= n || s.charCodeAt(i) !== 34) throw new Error("e");
                        readString();
                        skipWs();
                        if (i >= n || s.charCodeAt(i) !== 58) throw new Error("e");
                        i++;
                        skipWs();
                        walkValue();
                    }
                    skipWs();
                    if (i >= n) throw new Error("e");
                    const sep = s.charCodeAt(i);
                    if (sep === 44) { i++; continue; }
                    if (sep === close) { i++; break; }
                    throw new Error("e");
                }
                depth--;
                return;
            }
            const startTok = i;
            while (i < n) {
                const t = s.charCodeAt(i);
                if (t === 45 || t === 46 || (t >= 48 && t <= 57) || t === 101 || t === 69
                    || t === 102 || t === 116 || t === 114 || t === 117 || t === 97 || t === 108 || t === 115 || t === 110) {
                    i++;
                    continue;
                }
                break;
            }
            const tok = s.slice(startTok, i);
            if (tok === "true" || tok === "false" || tok === "null") return;
            if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(tok)) throw new Error("e");
        };

        skipWs();
        if (i >= n || s.charCodeAt(i) !== 123) throw new Error("e");
        i++;
        let messagesSeen = false;
        for (;;) {
            skipWs();
            if (i >= n) throw new Error("e");
            const c0 = s.charCodeAt(i);
            if (c0 === 125) { i++; break; }
            if (c0 !== 34) throw new Error("e");
            const keyStart = i;
            readString();
            const key = JSON.parse(s.slice(keyStart, i)) as string;
            skipWs();
            if (i >= n || s.charCodeAt(i) !== 58) throw new Error("e");
            i++;
            skipWs();
            if (key === "messages") {
                // Last-wins on duplicates, matching JSON.parse.
                if (messagesSeen) messageSpans.length = 0;
                else messagesSeen = true;
                const arrStart = i;
                if (i >= n || s.charCodeAt(i) !== 91) throw new Error("e");
                i++;
                skipWs();
                if (i >= n) throw new Error("e");
                if (s.charCodeAt(i) !== 93) {
                    for (;;) {
                        skipWs();
                        const es = i;
                        walkValue();
                        messageSpans.push({ start: es, end: i });
                        skipWs();
                        if (i >= n) throw new Error("e");
                        const sep = s.charCodeAt(i);
                        if (sep === 44) { i++; continue; }
                        if (sep === 93) { i++; break; }
                        throw new Error("e");
                    }
                } else {
                    i++;
                }
                // Position-only entry (the value is never re-parsed): consumers rebuild the
                // top-level object in WIRE KEY ORDER — the key sequence is part of the byte
                // contract, appending "messages" late would reorder its siblings (#5418).
                if (extraKeys === "all" || extraKeys.includes("messages")) fieldSpans.set("messages", { start: arrStart, end: i });
            } else {
                const fs = i;
                walkValue();
                const want = extraKeys === "all" || extraKeys.includes(key);
                if (!want) fieldSpans.delete(key);
                else fieldSpans.set(key, { start: fs, end: i });
            }
            skipWs();
            if (i >= n) throw new Error("e");
            const sep = s.charCodeAt(i);
            if (sep === 44) { i++; continue; }
            if (sep === 125) { i++; break; }
            throw new Error("e");
        }
        skipWs();
        if (i !== n || !messagesSeen) throw new Error("e");
        return { total: messageSpans.length, messageSpans, fieldSpans };
    } catch {
        return null;
    }
}
