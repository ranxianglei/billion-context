/**
 * Tee logger: writes every log line to BOTH a file (append, default
 * ~/.local/state/billion-context/bili.log) and stderr (so a foreground `bili`
 * still shows output in the terminal).
 *
 * The file is the durable record — it persists across restarts and survives a
 * backgrounded process with no tty. Simple size-based rotation on open keeps
 * it from growing without bound: when the existing file exceeds MAX_BYTES it
 * is renamed to <file>.old and a fresh file is started.
 */
import { createWriteStream, mkdirSync, statSync, existsSync, renameSync, type WriteStream } from "node:fs";
import path from "node:path";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB → rotate

export type Logger = (level: string, msg: string) => void;

let stream: WriteStream | undefined;
let logPath: string | undefined;
let bytesWritten = 0; // tracked so we can rotate at runtime, not just at startup

function open(pathStr: string): WriteStream {
    mkdirSync(path.dirname(pathStr), { recursive: true });
    // Rotate if oversized.
    let existingSize = 0;
    try {
        existingSize = statSync(pathStr).size;
        if (existingSize >= MAX_BYTES) {
            rotate(pathStr);
            existingSize = 0;
        }
    } catch {
        // file doesn't exist yet — fine
    }
    const s = createWriteStream(pathStr, { flags: "a" });
    bytesWritten = existingSize;
    return s;
}

function rotate(pathStr: string): void {
    try {
        renameSync(pathStr, pathStr + ".old");
    } catch {
        // rename can fail on Windows if .old is held open; best-effort,
        // we keep writing to the same file and retry next rotation.
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
    stream = open(file);
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
    if (stream && logPath) {
        try {
            // The underlying file can vanish under us without the stream
            // noticing: another process deletes it (rebuild, logrotate, `rm`,
            // a restart that clobbers it). Once the inode is unlinked, writes
            // still "succeed" but go to a now-private inode that no path
            // points to — the log vanishes into a black hole while the proxy
            // keeps running. Reopen if the path no longer resolves to an
            // existing file.
            if (!existsSync(logPath)) {
                stream.end();
                stream = open(logPath);
            }
            // Runtime rotation: if we've crossed the threshold since last
            // check, reopen the file (rotates the old one out). This keeps a
            // long-running proxy's log bounded without needing a restart.
            if (bytesWritten >= MAX_BYTES) {
                stream.end();
                rotate(logPath);
                stream = open(logPath);
            }
            stream.write(line);
            bytesWritten += Buffer.byteLength(line);
        } catch {
            // file logging must never crash the proxy either (disk full, perms)
        }
    }
};

/** Flush + close the log file. Call on shutdown. */
export function closeLogger(): void {
    stream?.end();
    stream = undefined;
    bytesWritten = 0;
}

export function getLogPath(): string | undefined {
    return logPath;
}
