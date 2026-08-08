/** SSE line-ending normalization.
 *
 *  The SSE spec allows `\r\n`, lone `\r`, and `\n` as line terminators; an
 *  event is delimited by a blank line (two terminators in a row). Many proxy
 *  implementations only split on `\n\n`, which silently drops every event
 *  from a CRLF-emitting upstream and forces the proxy to synthesize a bogus
 *  response. Normalizing line endings to `\n` after each chunk decode makes
 *  the simple `indexOf("\n\n")` split correct for all three terminator forms.
 *
 *  Returns the normalized buffer (same string if no CR was present). */
export function normalizeSseLineEndings(buf: string): string {
    if (buf.indexOf("\r") === -1) return buf;
    return buf.replace(/\r\n|\r/g, "\n");
}
