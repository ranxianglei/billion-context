/**
 * Tee logger: writes every log line to BOTH a file (append, default
 * ~/.local/state/billion-context/bili.log) and stderr (so a foreground `bili`
 * still shows output in the terminal).
 *
 * A single WriteStream is held open for the life of the process (opening the
 * file once, not per line). The hazards this exposes are handled explicitly:
 *   - If the underlying file is unlinked/replaced (rebuild, logrotate, a
 *     restart that clobbers it), the held fd becomes an orphan inode and
 *     writes silently vanish. We detect this via the stream's 'error' event
 *     and the `writable` flag, and reopen on demand.
 *   - If stderr's reader is gone (broken pipe), process.stderr.write throws
 *     EPIPE — swallowed so logging can never crash the server.
 */
import { createWriteStream, mkdirSync, statSync, renameSync, type WriteStream } from "node:fs";
import path from "node:path";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB → rotate

export type Logger = (level: string, msg: string) => void;

let stream: WriteStream | undefined;
let logPath: string | undefined;
let bytesWritten = 0;

function openStream(file: string): WriteStream {
    mkdirSync(path.dirname(file), { recursive: true });
    // Rotate if oversized.
    let existingSize = 0;
    try {
        existingSize = statSync(file).size;
        if (existingSize >= MAX_BYTES) {
            try {
                renameSync(file, file + ".old");
                existingSize = 0;
            } catch {
                // rename can fail if .old is held open; best-effort.
            }
        }
    } catch {
        // file doesn't exist yet — fine
    }
    const s = createWriteStream(file, { flags: "a" });
    // If the stream errors (fd orphaned, disk full, perms), drop it so the
    // next write triggers a reopen instead of piling onto a dead stream.
    s.on("error", () => {
        try { s.destroy(); } catch { /* best-effort */ }
        if (stream === s) stream = undefined;
    });
    bytesWritten = existingSize;
    return s;
}

/** Get a usable stream, opening one if needed (lazy reopen after error). */
function getStream(): WriteStream | undefined {
    if (!logPath) return undefined;
    if (stream && stream.writable) return stream;
    // Stream is dead/orphaned — reopen.
    try {
        stream = openStream(logPath);
        return stream;
    } catch {
        return undefined;
    }
}

/**
 * Configure the log file. Call once at startup. When `file` is undefined or
 * "off", file logging is disabled (stderr only).
 */
export function configureLogger(file?: string): string | undefined {
    if (!file || file === "off") {
        logPath = undefined;
        stream = undefined;
        return undefined;
    }
    logPath = file;
    stream = openStream(file);
    return file;
}

/** Log a line to file + stderr. */
export const log: Logger = (level, msg) => {
    const ts = new Date().toISOString();
    const line = `${ts} [${level}] ${msg}\n`;
    // stderr (foreground terminal / shell redirect). MUST NOT throw — if the
    // reader has gone (terminal closed, piped process exited, broken pipe)
    // write() throws EPIPE and, as an uncaughtException in a hot path, kills
    // the whole proxy. Swallow so logging can never crash the server.
    try {
        process.stderr.write(line);
    } catch {
        // best-effort: stderr is gone (EPIPE), nothing we can do
    }
    // file — durable record.
    let s = getStream();
    if (s) {
        // Runtime rotation: if we've crossed the threshold since last check,
        // reopen the file (rotates the old one out). This keeps a long-running
        // proxy's log bounded without needing a restart.
        if (bytesWritten >= MAX_BYTES) {
            try {
                s.end();
            } catch { /* best-effort */ }
            stream = openStream(logPath!);
            s = stream;
        }
        try {
            s.write(line);
            bytesWritten += Buffer.byteLength(line);
        } catch {
            // write failed (fd gone) — drop the stream; next line reopens.
            try { s.destroy(); } catch { /* best-effort */ }
            stream = undefined;
        }
    }
};

/** Flush + close the log file. Call on shutdown. */
export function closeLogger(): void {
    if (stream) {
        try { stream.end(); } catch { /* best-effort */ }
    }
    stream = undefined;
    bytesWritten = 0;
}

export function getLogPath(): string | undefined {
    return logPath;
}
