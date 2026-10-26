/** Streaming SSE line-ending normalization.
 *
 *  The SSE spec allows `\r\n`, lone `\r`, and `\n` as line terminators; an
 *  event is delimited by a blank line (two terminators in a row). Many proxy
 *  implementations only split on `\n\n`, which silently drops every event from
 *  a CRLF-emitting upstream. Normalizing terminators to `\n` before the
 *  `indexOf("\n\n")` split makes that split correct for all three forms.
 *
 *  Streaming invariant (#2323): a lone `\r` at the VERY END of the buffer is
 *  held back un-normalized. Its partner byte may arrive in the next chunk — if
 *  it is `\n` the pair is one CRLF terminator; if anything else the `\r` is
 *  itself a terminator. Normalizing it eagerly turns a CRLF split across two
 *  chunks into a spurious blank line, tearing one event into two fragments
 *  that no longer parse. Callers feed the ACCUMULATING buffer each chunk, so
 *  the held `\r` resolves on the next call; use finalizeSseLineEndings at true
 *  EOF, where no partner can still arrive.
 *
 *  Returns the normalized buffer (same string if no CR was present). */
export function normalizeSseLineEndings(buf: string): string {
    if (buf.indexOf("\r") === -1) return buf;
    const trailingCr = buf.endsWith("\r");
    const head = trailingCr ? buf.slice(0, -1) : buf;
    return head.replace(/\r\n|\r/g, "\n") + (trailingCr ? "\r" : "");
}

/** Terminal (whole-string) SSE line-ending normalization: converts every
 *  terminator including a trailing lone `\r`. Use only when no further input
 *  will arrive (EOF residual), where the hold-back ambiguity has resolved. */
export function finalizeSseLineEndings(buf: string): string {
    if (buf.indexOf("\r") === -1) return buf;
    return buf.replace(/\r\n|\r/g, "\n");
}
