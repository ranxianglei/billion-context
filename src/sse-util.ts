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

/** Data fields of one already-framed, LF-normalized SSE event form ONE
 * payload, joined by LF. Remove only the optional first space after `:`;
 * indentation and empty fields are part of the payload. */
export function sseEventData(frame: string): string | null {
    const parts: string[] = [];
    for (const line of frame.split("\n")) {
        if (line === "data") parts.push("");
        else if (line.startsWith("data:")) parts.push(line.slice(5).replace(/^ /, ""));
    }
    return parts.length > 0 ? parts.join("\n") : null;
}

/** Replace the complete payload while preserving event/id/retry/comments.
 * Call only when an event needs rewriting; unedited frames stay verbatim. */
export function replaceSseEventData(frame: string, data: string): string {
    const out: string[] = [];
    let replaced = false;
    for (const line of frame.split("\n")) {
        if (line === "data" || line.startsWith("data:")) {
            if (!replaced) for (const part of data.split("\n")) out.push(`data: ${part}`);
            replaced = true;
        } else out.push(line);
    }
    return out.join("\n");
}

/** Read buffered SSE event payloads. Multiple data fields belong to ONE
 *  event and are joined with LF before a consumer parses JSON. Keep the final
 *  residual available: callers retain their own framing/terminal validity
 *  checks (Responses may trust a completed terminal without a blank line). */
export function* bufferedSseEvents(text: string): Generator<{ event: string; data: string }> {
    let event = "";
    let data: string[] = [];
    for (const line of finalizeSseLineEndings(text).split("\n")) {
        if (line.trim() === "") {
            if (data.length) yield { event, data: data.join("\n") };
            event = "";
            data = [];
        } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
            data.push(line.slice(5).replace(/^ /, ""));
        }
    }
    if (data.length) yield { event, data: data.join("\n") };
}
