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
 *
 * Line format: `<iso-ts> [level][ [sess=<session-id>]] [v=<version>] <msg>`
 * — one prefix per PHYSICAL line (multi-line payloads repeat ts+level+tags on
 * every row, which is what makes line-wise grep / time-window queries honest).
 * The [sess=...] token is request-scoped via AsyncLocalStorage — see
 * enterSessionContext() below; the [v=...] token is process-wide (the running
 * build's version), so any single line from a multi-instance shared log file
 * self-identifies its writer even when different versions coexist.
 *
 * Before hitting file/stderr every line passes redactSecretsInText() (#1718)
 * — a final scrub for credential-shaped tokens in free-form text (upstream
 * error bodies echoing API keys), complementing per-call-site structural
 * masking in log-mask.ts. The programmatic capture hook receives the raw
 * message: it is an in-process test/diagnostic seam, not a log surface.
 */
import { createWriteStream, fstatSync, mkdirSync, statSync, renameSync, unlinkSync, type WriteStream } from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { VERSION } from "./version.js";
import { maskIpsInText, redactSecretsInText } from "./log-mask.js";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB → rotate

export type Logger = (level: string, msg: string) => void;

// ── Request-scoped session attribution ─────────────────────────────────────
// enterSessionContext() is called once per inbound model request, at the point
// where identity resolves (server.ts main pipeline funnel). Because it rides
// AsyncLocalStorage, EVERY log() call in that request's async chain — adapters,
// kernel, persistence, plugin hooks — is tagged without touching a single
// call site. The web log view (/__bili/logs) and plain grep rely on the stable
// [sess=<id>] / [v=<ver>] tokens in the line head.
const sessionCtx = new AsyncLocalStorage<string>();

const SESSION_TAG_MAX = 160;

/** Keep only [A-Za-z0-9._:-], collapse every other run (whitespace, brackets,
 *  control chars) to a single underscore, cap length — the tag must never break
 *  the `[sess=...]` token grammar that filters match against. */
function sanitizeSessionTag(id: string): string | undefined {
    const s = id.replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, SESSION_TAG_MAX);
    return s.length > 0 ? s : undefined;
}

/** Bind the current request flow to a session id for log tagging. No-op when
 *  the id is empty or sanitizes away. Idempotent within one flow. */
export function enterSessionContext(sessionId: string | undefined | null): void {
    if (!sessionId) return;
    const tag = sanitizeSessionTag(sessionId);
    if (tag) sessionCtx.enterWith(tag);
}

/** Active session tag of the current async flow (diagnostics/tests). */
export function currentSessionContext(): string | undefined {
    return sessionCtx.getStore();
}

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

const BENIGN_SOCKET_RACE_MESSAGE = "Cannot read properties of undefined (reading '_writableState')";

/** Socket-teardown race on an already-closed socket (#1574): a Node-internal
 *  callback (socketOnTimeout / socketOnEnd / closeIdleConnections) reaches a
 *  socket whose writable side was already torn down. #1574 triage proved this
 *  signature unreachable via bili's own call paths or stock Node v22.23.2
 *  dispatch (all cited frames pass bound receivers; states are never nulled;
 *  every graceful close funnels through destroy(), which clears the keep-alive
 *  timer), and empirically verified that end()/destroy() on a fully closed
 *  socket are harmless no-ops — so an occurrence touches no live resource.
 *  Matched exactly (message + core frame provenance) so nothing else can be
 *  demoted by accident. */
export function isBenignSocketRaceError(err: unknown): boolean {
    if (!(err instanceof TypeError) || err.message !== BENIGN_SOCKET_RACE_MESSAGE) return false;
    const stack = err.stack;
    if (typeof stack !== "string") return false;
    return stack.includes("node:_http_server") || stack.includes("node:internal/streams/writable");
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
    const safe = maskIpsInText(redactSecretsInText(msg));
    const ts = new Date().toISOString();
    const sess = sessionCtx.getStore();
    const head = `${ts} [${level}]${sess ? ` [sess=${sess}]` : ""} [v=${VERSION}]`;
    // One prefix per PHYSICAL line (see header doc): multi-line payloads keep
    // timestamp + session + version attribution line by line. Fast path skips
    // the split for the common single-line message.
    const line = safe.indexOf("\n") < 0
        ? `${head} ${safe}\n`
        : safe.split("\n").map((p) => `${head} ${p}`).join("\n") + "\n";
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
