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
