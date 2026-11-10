/**
 * Bounded line reading over the retained log set.
 *
 * Retained history became a 256 MiB BYTE BUDGET (#P12) — tens of generations,
 * not one `.old` pair. Every reader that used to do
 * `readFileSync(file).split("\n")` per generation therefore materialized the
 * whole budget (a fresh JS string per file, plus an array of every line) to
 * answer a question about at most a few thousand lines, and did it on the
 * event loop. This module is the one place that turns files into LINES: it
 * streams, never concatenates generations, and every consumer above it keeps
 * at most its own OUTPUT bound (a tail of N rows, a query's selection).
 *
 * What is deliberately NOT here: a snapshot. Files can be sealed, migrated or
 * deleted while an answer is being computed, and the active file keeps growing.
 * The reader states that honestly instead of passing off a short read as a
 * complete history:
 *   - `readLogLines` takes an `onError` hook and reports every file it could
 *     not open (missing, rotated away, unreadable), so a caller that cares can
 *     say "history is incomplete"; it never silently shortens the answer.
 *   - A row count is only the count of rows actually delivered; nothing here
 *     claims more.
 *
 * Memory: O(longest line in the stream) for the decoder plus whatever the
 * caller retains. There is no fixed per-line cap: a legitimately long line
 * (a serialized payload, a stack trace) is delivered whole, because truncating
 * it would make the answer wrong rather than merely short.
 */
import { createReadStream, type ReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** Bytes pulled from the file per read. Small enough that `break`ing early
 *  leaves little unread work, large enough that a 10 MiB generation is ~160
 *  reads instead of thousands. */
const READ_CHUNK_BYTES = 64 * 1024;

export interface ReadLogLinesOptions {
    /** Drop empty lines (the historical `filter(l => l.length > 0)`). Default true. */
    skipEmpty?: boolean;
    /** Invoked when a file could not be read (missing, rotated away,
     *  unreadable). Reading continues with the next file so one dead generation
     *  never blanks a report; the callback is how a caller stays honest.
     *  Default: rethrow. A reader with no error channel must not pretend a dead
     *  generation was an empty one — an absent file is only expected where the
     *  caller's own enumeration already saw it. */
    onError?: (file: string, error: NodeJS.ErrnoException) => void;
}

/** Stream one file as complete lines.
 *
 *  Chunk boundaries are decoded with `StringDecoder`, so a multibyte character
 *  split across two reads is assembled instead of becoming U+FFFD (a raw
 *  `buffer.toString()` per chunk corrupts every CJK log line that straddles a
 *  64 KiB boundary — sessions carry CJK prompts, so this is the common case,
 *  not the exotic one). A trailing fragment with no newline is yielded as the
 *  final line: the active file is being appended to right now, and dropping a
 *  half-written line would silently lose the newest evidence.
 *
 *  Breaking out of the loop closes the stream immediately (the generator's
 *  `finally`), so an early `break` — the normal way every tail reader stops —
 *  cannot leak an fd. `destroy()` also aborts the in-flight read. */
export async function* readLogFileLines(
    file: string,
    opts: ReadLogLinesOptions = {},
): AsyncGenerator<string> {
    const skipEmpty = opts.skipEmpty !== false;
    const decoder = new StringDecoder("utf8");
    let stream: ReadStream | null = null;
    let opened = false;
    try {
        stream = createReadStream(file, { highWaterMark: READ_CHUNK_BYTES });
        // Touching the stream surfaces a missing/unreadable path before any
        // chunk work, so the catch below stays about the FILE, not about a
        // consumer exception thrown into this generator by `yield`.
        stream.once("open", () => { opened = true; });
        let rest = "";
        for await (const chunk of stream) {
            const text = decoder.write(chunk as Buffer);
            let start = 0;
            for (;;) {
                const nl = text.indexOf("\n", start);
                if (nl === -1) break;
                const line = rest + text.slice(start, nl);
                rest = "";
                if (!(skipEmpty && line.length === 0)) yield line;
                start = nl + 1;
            }
            if (start < text.length) rest += text.slice(start);
        }
        const last = rest + decoder.end();
        if (last.length > 0) yield last;
    } catch (error) {
        // Only a failure to OPEN the file is a per-file condition the caller
        // can absorb. Anything after the stream opened (a mid-read I/O error, a
        // consumer exception thrown back through `yield`) is NOT a missing
        // generation: rethrowing keeps a truncated answer from looking complete.
        if (opened) throw error;
        if (!opts.onError) throw error;
        opts.onError(file, error as NodeJS.ErrnoException);
    } finally {
        // An early `break` (or an error) must not leave the fd open: an
        // abandoned generator is the normal way every tail reader stops.
        stream?.destroy();
    }
}

/** Stream several files in the given order (oldest first), one file's lines
 *  after another. No generation is concatenated in memory; a consumer that
 *  breaks out of the loop stops all remaining I/O. */
export async function* readLogLines(
    files: readonly string[],
    opts: ReadLogLinesOptions = {},
): AsyncGenerator<string> {
    for (const file of files) yield* readLogFileLines(file, opts);
}

/** Bounded tail selection: keep only the NEWEST `limit` lines accepted by
 *  `select`, using a fixed-size ring (memory = the answer, never the input).
 *  This is what makes a diagnostic tail a single streaming pass over the whole
 *  retention set — the previous `lines.filter(...).slice(-N)` held every line
 *  of every generation just to discard all but N. */
export async function readLogTail(
    files: readonly string[],
    limit: number,
    select: (line: string) => boolean = () => true,
    opts: ReadLogLinesOptions = {},
): Promise<string[]> {
    const cap = Math.max(0, Math.floor(limit));
    if (cap === 0) return [];
    const ring: string[] = new Array(cap);
    let seen = 0;
    for await (const line of readLogLines(files, opts)) {
        if (!select(line)) continue;
        ring[seen % cap] = line;
        seen += 1;
    }
    if (seen === 0) return [];
    const count = Math.min(seen, cap);
    const out: string[] = new Array(count);
    const first = seen - count;
    for (let i = 0; i < count; i++) out[i] = ring[(first + i) % cap]!;
    return out;
}
