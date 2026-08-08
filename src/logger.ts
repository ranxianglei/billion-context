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
import { createWriteStream, mkdirSync, statSync, renameSync, type WriteStream } from "node:fs";
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
    // stderr (foreground terminal / shell redirect) — never throws.
    process.stderr.write(line);
    // file — durable record.
    if (stream && logPath) {
        // Runtime rotation: if we've crossed the threshold since last check,
        // reopen the file (rotates the old one out). This keeps a long-running
        // proxy's log bounded without needing a restart.
        if (bytesWritten >= MAX_BYTES) {
            stream.end();
            rotate(logPath);
            stream = open(logPath);
        }
        stream.write(line);
        bytesWritten += Buffer.byteLength(line);
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
