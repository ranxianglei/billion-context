/**
 * Tee logger: writes every log line to BOTH a file (append, default
 * ~/.local/state/billion-context/bili.log) and stderr (so a foreground `bili`
 * still shows output in the terminal).
 *
 * A single WriteStream is held open for the life of the process (opening the
 * file once, not per line). The hazards this exposes are handled explicitly:
 *   - If the underlying file is renamed/replaced (our own 10MB rotation,
 *     logrotate, a manual rename), the held fd becomes an orphan inode and
 *     writes silently drift to the renamed file — no 'error' event fires
 *     because the fd is still valid. We detect this on every write by
 *     comparing the fd's inode (fstat) with the current path's inode (stat)
 *     and reopen against the current path when they diverge.
 *   - If a (re)open fails (disk full, perms, path clobbered), logging degrades
 *     to stderr-only with a single [warn] instead of crashing the proxy.
 *   - If stderr's reader is gone (broken pipe), the write fails — synchronously
 *     on Windows, but on Linux stderr over a pipe is an async stream and EPIPE
 *     arrives as an 'error' EVENT that a try/catch around write() can never see.
 *     A module-init listener flips logging to file-only on the first failure;
 *     without it the event rethrows as uncaughtException, the top-level handler
 *     logs it through this very writer, and the feedback loop spams the log
 *     file until rotation wipes the forensic window (#1233).
 */
import { createWriteStream, fstatSync, mkdirSync, statSync, renameSync, unlinkSync, type WriteStream } from "node:fs";
import path from "node:path";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB → rotate

export type Logger = (level: string, msg: string) => void;

let stream: WriteStream | undefined;
let streamFd: number | undefined;
let logPath: string | undefined;
let bytesWritten = 0;
let reopenWarned = false;

let capture: ((level: string, msg: string) => void) | null = null;

let stderrDead = false;

const STREAM_WRITE_ERROR_CODES = new Set(["EPIPE", "EIO", "EBADF", "ERR_STREAM_DESTROYED"]);

/** Stream-write failures (closed pipe, destroyed stream) — the errors that storm
 *  when a consumer exits while the process keeps writing (#1233). */
export function isStreamWriteError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" && STREAM_WRITE_ERROR_CODES.has(code);
}

/** Flip to file-only logging after stderr died. Idempotent; the [warn] goes
 *  through log(), which now skips stderr — the logger's error path never
 *  re-enters the writer that produced the error. */
function markStderrDead(err: unknown): void {
    if (stderrDead) return;
    stderrDead = true;
    const reason = err instanceof Error ? err.message : String(err);
    log("warn", `stderr unavailable (${reason}); continuing with file-only logging`);
}

// Async form of a dead stderr (Linux: stderr over a pipe is an async stream,
// EPIPE arrives as an 'error' event, see header). Attaching this listener also
// stops the stream error from rethrowing as uncaughtException.
process.stderr.on("error", (err) => markStderrDead(err));

export function setLogCapture(fn: ((level: string, msg: string) => void) | null): void {
    capture = fn;
}

function openStream(file: string): WriteStream {
    mkdirSync(path.dirname(file), { recursive: true });
    // Rotate if oversized.
    let existingSize = 0;
    try {
        existingSize = statSync(file).size;
        if (existingSize >= MAX_BYTES) {
            try {
                // Drop the previous generation first: keep at most one .old,
                // and on Windows renameSync cannot overwrite an existing target.
                try { unlinkSync(file + ".old"); } catch { /* no previous generation */ }
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
    s.on("open", (fd: number) => {
        if (stream === s) streamFd = fd;
    });
    // If the stream errors (disk full, perms), drop it so the next write
    // triggers a reopen instead of piling onto a dead stream.
    s.on("error", () => {
        try { s.destroy(); } catch { /* best-effort */ }
        if (stream === s) {
            stream = undefined;
            streamFd = undefined;
        }
    });
    bytesWritten = existingSize;
    return s;
}

/** True when the stream's fd no longer points at the current log path — the
 *  file was renamed/replaced out from under us (orphan inode). A renamed fd
 *  never errors, so this inode compare is the only reliable detection. */
function isOrphaned(s: WriteStream): boolean {
    if (stream === s && streamFd === undefined) return false; // open still in flight
    try {
        const fdStat = fstatSync(streamFd!);
        const pathStat = statSync(logPath!);
        return fdStat.ino !== pathStat.ino || fdStat.dev !== pathStat.dev;
    } catch {
        // path gone (ENOENT) or fd invalid (EBADF) — treat as orphaned.
        return true;
    }
}

/** end() first so buffered lines drain to their file instead of being lost. */
function closeQuietly(s: WriteStream): void {
    try { s.end(); } catch { /* already closed/destroyed */ }
}

/** One [warn] per degradation episode (reset when a reopen succeeds). */
function warnReopenFailed(err: unknown): void {
    if (reopenWarned) return;
    reopenWarned = true;
    const reason = err instanceof Error ? err.message : String(err);
    const msg = `log file ${logPath ?? "?"} unavailable (${reason}); continuing with stderr-only logging`;
    if (capture) {
        try { capture("warn", msg); } catch { /* best-effort */ }
    }
    if (!stderrDead) {
        try {
            process.stderr.write(`${new Date().toISOString()} [warn] ${msg}\n`);
        } catch { /* stderr gone */ }
    }
}

/** Get a usable stream, opening one if needed (lazy reopen after error,
 *  rotation, or external rename). Never throws — file logging degrades to
 *  stderr-only if the file cannot be (re)opened. */
function getStream(): WriteStream | undefined {
    if (!logPath) return undefined;
    if (stream && stream.writable && !isOrphaned(stream)) return stream;
    if (stream) closeQuietly(stream);
    stream = undefined;
    streamFd = undefined;
    try {
        stream = openStream(logPath);
        reopenWarned = false;
        return stream;
    } catch (err) {
        stream = undefined;
        streamFd = undefined;
        warnReopenFailed(err);
        return undefined;
    }
}

/**
 * Configure the log file. Call once at startup. When `file` is undefined or
 * "off", file logging is disabled (stderr only). A failed open degrades to
 * stderr-only instead of crashing startup.
 */
export function configureLogger(file?: string): string | undefined {
    if (!file || file === "off") {
        logPath = undefined;
        stream = undefined;
        return undefined;
    }
    logPath = file;
    stream = getStream();
    return file;
}

/** Log a line to file + stderr. */
export const log: Logger = (level, msg) => {
    if (capture) {
        try {
            capture(level, msg);
        } catch {
            // best-effort: a broken test/probe sink must never crash logging
        }
    }
    const ts = new Date().toISOString();
    const line = `${ts} [${level}] ${msg}\n`;
    // stderr (foreground terminal / shell redirect). MUST NOT throw and must
    // never re-enter its own error path: a sync failure (Windows) or the async
    // 'error' event (Linux, module-init listener above) both flip us to
    // file-only once, after which this branch is skipped entirely.
    if (!stderrDead) {
        try {
            process.stderr.write(line);
        } catch (err) {
            markStderrDead(err);
        }
    }
    // file — durable record.
    let s = getStream();
    if (s) {
        // Runtime rotation: if we've crossed the threshold since last check,
        // close the old stream (end() drains its buffer) and reopen against
        // the current path (openStream renames the oversized file out).
        if (bytesWritten >= MAX_BYTES) {
            closeQuietly(s);
            stream = undefined;
            s = getStream();
        }
        if (s) {
            try {
                s.write(line);
                bytesWritten += Buffer.byteLength(line);
            } catch {
                // write failed (fd gone) — drop the stream; next line reopens.
                try { s.destroy(); } catch { /* best-effort */ }
                stream = undefined;
            }
        }
    }
};

/** Flush + close the log file. Call on shutdown; resolves once every buffered
 *  line has drained to disk, so awaiting it proves the durable record is complete. */
export function closeLogger(): Promise<void> {
    const s = stream;
    stream = undefined;
    streamFd = undefined;
    bytesWritten = 0;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
        let done = false;
        const finish = (): void => {
            if (done) return;
            done = true;
            resolve();
        };
        s.once("error", finish);
        try { s.end(finish); } catch { finish(); }
    });
}

export function getLogPath(): string | undefined {
    return logPath;
}
