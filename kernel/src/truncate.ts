// UTF-16-safe truncation. A plain slice can land between the two code units
// of an astral character (emoji, CJK ext-B+), stranding a lone surrogate:
// JSON.stringify escapes it (\ud83e), and gateways that re-encode request
// bodies to strict UTF-8 then throw UnicodeEncodeError on every retry
// (ranxianglei/billion-context#816) — a deterministic poison that never heals.

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** At most maxUnits code units; never ends on a stranded high surrogate. */
export function clampPrefix(text: string, maxUnits: number): string {
  const cut = Math.min(maxUnits, text.length);
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1)))
    return text.slice(0, cut - 1);
  return text.slice(0, cut);
}

/** A [start, end) window with both edges snapped off surrogate pairs. */
export function clampWindow(text: string, start: number, end: number): string {
  let s = Math.max(0, Math.min(start, text.length));
  let e = Math.min(text.length, Math.max(s, end));
  if (s > 0 && isLowSurrogate(text.charCodeAt(s))) s += 1;
  if (e > s && isHighSurrogate(text.charCodeAt(e - 1))) e -= 1;
  return text.slice(s, Math.max(s, e));
}

/** Belt-and-braces: replace any unpaired surrogate half (whatever its source —
 *  model-authored compress summaries, hand-built strings, upstream payload)
 *  with U+FFFD so it can never reach JSON.stringify as an unpaired escape.
 *  Valid pairs pass through verbatim; non-surrogate text is untouched. */
export function scrubLoneSurrogates(text: string): string {
  return text
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])/g, "\ufffd")
    .replace(/(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}
