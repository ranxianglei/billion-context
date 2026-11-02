/**
 * #5418 — offset-only depth scan of a raw JSON body string.
 *
 * The plugin-lane full-resend OOM producer (#5403) is the per-round full
 * `JSON.parse` of an 81 MiB body: one pass that allocates a hundreds-of-MB AST
 * which then rides resident in `session.lastMessages`. The watermark design
 * (issue #5418) replaces the per-message re-reconciliation with a count
 * assertion and, on a match, parses ONLY the uncovered tail window. This module
 * is the primitive that makes "parse only the tail" possible WITHOUT first
 * parsing the whole body: it walks the raw string once, records where the
 * top-level `messages` array lives and where each of its elements starts and
 * ends, and allocates exactly ONE int offset table for the whole body.
 *
 * Contract (deliberately narrow — see the gate in server/handle.ts):
 *   - input is the RAW request body string (already buffered);
 *   - output is byte offsets into THAT string (UTF-16 index space), so a window
 *     can be re-wrapped as a JSON array literal and handed to JSON.parse as the
 *     only allocation-heavy step;
 *   - any shape the fastpath cannot reason about (not an object, no `messages`
 *     array, malformed anywhere) returns null → the caller takes the legacy
 *     full-parse path. The scanner never throws on bad input; it reports null.
 *
 * It does NOT decode or validate element contents — it only finds boundaries.
 * That keeps it a single linear pass (O(n) char steps, no per-element objects)
 * and keeps the correctness bar simple: the offsets must slice cleanly back to
 * the same values a full parse would produce (the tests assert that round-trip).
 */

export interface FastpathScan {
    /** Index (inclusive) of the top-level object's opening `{`. */
    objectStart: number;
    /** Index just past the top-level object's closing `}`. */
    objectEnd: number;
    /** Index (inclusive) of the `messages` array's opening `[`. */
    messagesStart: number;
    /** Index just past the `messages` array's closing `]`. */
    messagesEnd: number;
    /** Element count of the `messages` array. */
    count: number;
    /** Flat [start0,end0,start1,end1,…] byte offsets of each element, in order.
     *  One contiguous Int32Array — the scanner's entire heap footprint. */
    elementOffsets: Int32Array;
}

const WS = " \t\n\r";

function isWs(ch: string | undefined): boolean {
    return ch !== undefined && WS.includes(ch);
}

/** Skip whitespace from i; returns the next non-whitespace index (or n). */
function skipWs(s: string, i: number): number {
    const n = s.length;
    while (i < n && isWs(s[i])) i++;
    return i;
}

/**
 * Read a JSON string token whose opening quote sits at s[i]. Returns the DECODED
 * value plus the index just past the closing quote, or { value: null } on a
 * malformed escape/unclosed string. Only used for the top-level KEYS (we must
 * compare them against "messages"); values are skipped, not decoded.
 */
function readJsonString(s: string, i: number): { value: string | null; next: number } {
    const n = s.length;
    // s[i] === '"' guaranteed by caller.
    let out = "";
    let j = i + 1;
    while (j < n) {
        const c = s[j];
        if (c === '"') return { value: out, next: j + 1 };
        if (c === "\\") {
            const e = s[j + 1];
            if (e === undefined) return { value: null, next: -1 };
            switch (e) {
                case '"': out += '"'; break;
                case "\\": out += "\\"; break;
                case "/": out += "/"; break;
                case "b": out += "\b"; break;
                case "f": out += "\f"; break;
                case "n": out += "\n"; break;
                case "r": out += "\r"; break;
                case "t": out += "\t"; break;
                case "u": {
                    const hex = s.slice(j + 2, j + 6);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: null, next: -1 };
                    out += String.fromCharCode(parseInt(hex, 16));
                    j += 4;
                    break;
                }
                default:
                    return { value: null, next: -1 };
            }
            j += 2;
            continue;
        }
        out += c;
        j++;
    }
    return { value: null, next: -1 }; // unterminated
}

/**
 * Skip one complete JSON value whose first char sits at s[i]. Returns the index
 * just past the value, or -1 if the value is malformed/unterminated. Values are
 * consumed structurally (strings via their closing quote, containers by depth)
 * but NEVER decoded — so braces/brackets/quotes inside string leaves cannot
 * fool the depth tracking.
 */
function skipJsonValue(s: string, i: number): number {
    const n = s.length;
    const c = s[i];
    if (c === '"') {
        const r = readJsonString(s, i);
        return r.next;
    }
    if (c === "{") {
        let j = i + 1;
        j = skipWs(s, j);
        if (s[j] === "}") return j + 1;
        while (true) {
            j = skipWs(s, j);
            if (s[j] !== '"') return -1;
            const key = readJsonString(s, j);
            if (key.value === null) return -1;
            j = key.next;
            j = skipWs(s, j);
            if (s[j] !== ":") return -1;
            j = skipWs(s, j + 1);
            j = skipJsonValue(s, j);
            if (j < 0) return -1;
            j = skipWs(s, j);
            if (s[j] === ",") { j++; continue; }
            if (s[j] === "}") return j + 1;
            return -1;
        }
    }
    if (c === "[") {
        let j = i + 1;
        j = skipWs(s, j);
        if (s[j] === "]") return j + 1;
        while (true) {
            j = skipWs(s, j);
            j = skipJsonValue(s, j);
            if (j < 0) return -1;
            j = skipWs(s, j);
            if (s[j] === ",") { j++; continue; }
            if (s[j] === "]") return j + 1;
            return -1;
        }
    }
    // Number / true / false / null: consume the run of value characters. A JSON
    // value leaf ends at whitespace or a container closer, so stop at the first
    // char that is none of [digit, ., e, E, +, -, t, r, u, l, s, a, f, n].
    let j = i;
    while (j < n) {
        const ch = s[j];
        if (ch >= "0" && ch <= "9" || ch === "." || ch === "e" || ch === "E" || ch === "+" || ch === "-" || ch === "t" || ch === "r" || ch === "u" || ch === "l" || ch === "s" || ch === "a" || ch === "f" || ch === "n") {
            j++;
        } else {
            break;
        }
    }
    if (j === i) return -1; // no leading value char at all
    return j;
}

/**
 * Scan a raw OpenAI/chat-completions-style body for its top-level `messages`
 * array and each element's [start,end) offsets. Returns null when the body is
 * not a single JSON object with a `messages` array value, or is malformed.
 */
export function scanFastpath(raw: string): FastpathScan | null {
    const n = raw.length;
    if (n === 0) return null;
    let i = skipWs(raw, 0);
    if (raw[i] !== "{") return null;
    const objectStart = i;
    i++;

    let hasMessages = false;
    let messagesStart = -1;
    let messagesEnd = -1;
    // Growable int table: start with a small buffer, double on overflow. The
    // final result is trimmed to exactly 2*count entries.
    let offsets: Int32Array = new Int32Array(256);
    let count = 0;
    const setOffset = (slot: number, start: number, end: number): boolean => {
        if (slot + 1 >= offsets.length) {
            const grown = new Int32Array(offsets.length * 2);
            grown.set(offsets.subarray(0, slot));
            offsets = grown;
        }
        offsets[slot] = start;
        offsets[slot + 1] = end;
        return true;
    };

    let objectEnd = -1;
    while (true) {
        i = skipWs(raw, i);
        if (raw[i] === "}") { objectEnd = i + 1; break; }
        if (raw[i] !== '"') return null;
        const key = readJsonString(raw, i);
        if (key.value === null) return null;
        i = key.next;
        i = skipWs(raw, i);
        if (raw[i] !== ":") return null;
        i = skipWs(raw, i + 1);
        const vch = raw[i];

        if (key.value === "messages") {
            if (vch !== "[") return null; // messages must be an array
            hasMessages = true;
            messagesStart = i;
            i++;
            i = skipWs(raw, i);
            if (raw[i] === "]") {
                messagesEnd = i + 1;
                i++;
            } else {
                while (true) {
                    i = skipWs(raw, i);
                    const es = i;
                    i = skipJsonValue(raw, i);
                    if (i < 0) return null;
                    if (!setOffset(2 * count, es, i)) return null;
                    count++;
                    i = skipWs(raw, i);
                    if (raw[i] === ",") { i++; continue; }
                    if (raw[i] === "]") { messagesEnd = i + 1; i++; break; }
                    return null;
                }
            }
        } else {
            i = skipJsonValue(raw, i);
            if (i < 0) return null;
        }

        i = skipWs(raw, i);
        if (raw[i] === ",") { i++; continue; }
        if (raw[i] === "}") { objectEnd = i + 1; break; }
        return null;
    }

    if (!hasMessages) return null;
    return {
        objectStart,
        objectEnd,
        messagesStart,
        messagesEnd,
        count,
        elementOffsets: offsets.length === 2 * count ? offsets : offsets.slice(0, 2 * count),
    };
}

/**
 * Re-wrap a CONTIGUOUS run of elements `[lo, hi)` as a standalone JSON array
 * literal, as a single substring view of `raw` (one slice, no per-element copy
 * and no re-serialization). Valid because adjacent elements are comma-separated
 * in the source, so the slice between the first start and last end already
 * carries the separators. An empty range yields "[]".
 */
export function sliceElementWindow(raw: string, scan: FastpathScan, lo: number, hi: number): string {
    const a = Math.max(0, lo);
    const b = Math.min(scan.count, hi);
    if (a >= b) return "[]";
    const start = scan.elementOffsets[2 * a];
    const end = scan.elementOffsets[2 * b - 1];
    return "[" + raw.slice(start, end) + "]";
}

/** Parse a sliced element window back into core-ready wire messages. */
export function parseElementWindow<T = unknown>(raw: string, scan: FastpathScan, lo: number, hi: number): T[] | null {
    try {
        const parsed: unknown = JSON.parse(sliceElementWindow(raw, scan, lo, hi));
        return Array.isArray(parsed) ? parsed as T[] : null;
    } catch {
        return null;
    }
}
