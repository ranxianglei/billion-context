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

function open(pathStr: string): WriteStream {
    mkdirSync(path.dirname(pathStr), { recursive: true });
    // Rotate if oversized.
    try {
        if (statSync(pathStr).size >= MAX_BYTES) {
            renameSync(pathStr, pathStr + ".old");
        }
    } catch {
        // file doesn't exist yet — fine
    }
    return createWriteStream(pathStr, { flags: "a" });
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
    if (stream) {
        stream.write(line);
    }
};

/** Flush + close the log file. Call on shutdown. */
export function closeLogger(): void {
    stream?.end();
    stream = undefined;
}

export function getLogPath(): string | undefined {
    return logPath;
}
