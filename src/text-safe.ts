// Code-unit-safe text truncation. Raw String.prototype.slice cuts on UTF-16
// code units, so a cut landing between the two halves of a surrogate pair
// leaves a lone half; JSON.stringify turns that into an unpaired escape and
// strict upstream JSON parsers reject the ENTIRE request body for it
// (#816/#828, #1615: third site of this family — every recurrence came from
// new code slicing model-visible text by hand instead of reusing the shared
// clamp). Head/tail excerpts of model-visible text must go through these.

/** Prefix of at most n code units, never ending on a lone high surrogate. */
export function safePrefix(text: string, n: number): string {
    let cut = Math.min(n, text.length);
    if (cut > 0 && cut < text.length) {
        const c = text.charCodeAt(cut - 1);
        if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
    }
    return text.slice(0, cut);
}

/** Suffix of at most n code units, never starting on a lone low surrogate. */
export function safeSuffix(text: string, n: number): string {
    const cut0 = Math.max(0, text.length - n);
    let cut = cut0;
    if (cut > 0 && cut < text.length) {
        const c = text.charCodeAt(cut);
        if (c >= 0xdc00 && c <= 0xdfff) cut += 1;
    }
    return text.slice(cut);
}

/** Belt-and-braces: replace any lone surrogate (whatever its source — slicing
 *  elsewhere, hand-built strings, upstream payload) with U+FFFD so it can
 *  never reach JSON.stringify as an unpaired escape. */
export function scrubLoneSurrogates(text: string): string {
    return text
        .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "\ufffd")
        .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/** Variant for input that is PROVABLY the output of JSON.stringify: the
 *  well-formed stringify spec (ES2019, Node \u226512) renders every lone
 *  surrogate half as `\\uXXXX` escape text, so the serialized string cannot
 *  carry a real lone-half code unit and the character-level pass above scans
 *  the full body twice by construction without ever replacing anything.
 *  Serialized-body call sites use this escape-only form — keep the full
 *  OnWire scrub for strings of unproven provenance. */
export function scrubLoneSurrogateEscapesOnJson(text: string): string {
    return scrubLoneSurrogateEscapes(text);
}

/** Escape-text counterpart for ALREADY-SERIALIZED JSON bodies. JSON.stringify
 *  renders a lone half as the six-character escape `\uXXXX`, so by the time a
 *  body is on the wire the half is ASCII escape text and scrubLoneSurrogates
 *  above sees no code unit to fix. This walks backslash runs — an escape only
 *  starts on an ODD-length run, so doubled `\\uXXXX` (literal prose, e.g. a
 *  model quoting an encoded glyph out of tool output) stays untouched — keeps a
 *  well-formed high+low pair intact, and rewrites an unpaired half to the
 *  U+FFFD escape. Strict upstream parsers reject the ENTIRE body for one
 *  unpaired escape (#1615 family: an ACP-status report re-decoded into a real
 *  half, which then re-serialized unpaired on every later request). */
export function scrubLoneSurrogateEscapes(text: string): string {
    if (text.indexOf("\\u") === -1) return text;
    const n = text.length;
    // Copy each unchanged span whole (slice) and hop between backslashes via
    // indexOf instead of walking char-by-char: per-char `out +=` builds a
    // quadratic chain, so one stray `\u` forced the ENTIRE body through
    // per-character allocation and blew a 2 GiB heap (#2957).
    const parts: string[] = [];
    let pos = 0; // last emitted index — start of the pending unchanged span
    let i = 0;
    while ((i = text.indexOf("\\", i)) !== -1) {
        if (i > pos) parts.push(text.slice(pos, i));
        let j = i;
        while (j < n && text.charCodeAt(j) === 0x5c) j += 1;
        const run = j - i;
        parts.push(text.slice(i, j));
        pos = j;
        if (run % 2 === 0) { i = j; continue; } // even run: no escape starts here
        if (text.charCodeAt(j) !== 0x75) { i = j; continue; } // \n, \t, \" ...
        const hex = text.slice(j + 1, j + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) { i = j; continue; }
        const cp = parseInt(hex, 16);
        if (cp >= 0xdc00 && cp <= 0xdfff) {
            parts.push("ufffd"); // lone low (the backslash is already emitted)
            pos = j + 5; i = j + 5;
            continue;
        }
        if (cp >= 0xd800 && cp <= 0xdbff) {
            const nextHex = text.slice(j + 7, j + 11);
            if (text.charCodeAt(j + 5) === 0x5c && text.charCodeAt(j + 6) === 0x75 && /^[0-9a-fA-F]{4}$/.test(nextHex)) {
                const lo = parseInt(nextHex, 16);
                if (lo >= 0xdc00 && lo <= 0xdfff) {
                    parts.push(text.slice(j, j + 11)); // valid pair — keep verbatim
                    pos = j + 11; i = j + 11;
                    continue;
                }
            }
            parts.push("ufffd"); // lone high
            pos = j + 5; i = j + 5;
            continue;
        }
        parts.push(text.slice(j, j + 5)); // non-surrogate escape — keep
        pos = j + 5; i = j + 5;
    }
    if (pos < n) parts.push(text.slice(pos)); // trailing unchanged span
    return parts.join("");
}

/** Wire-level scrub for a serialized request body: real lone halves AND
 *  unpaired escape text both become U+FFFD. Use this at every upstream send
 *  seam; use scrubLoneSurrogates alone when the text is not yet JSON-encoded. */
export function scrubLoneSurrogatesOnWire(text: string): string {
    return scrubLoneSurrogateEscapes(scrubLoneSurrogates(text));
}
