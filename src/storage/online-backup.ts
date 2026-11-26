/**
 * #7561: online store backup (VACUUM INTO) off the proxy's event loop.
 *
 * The admin route POST /__bili/storage/backup used to run VACUUM INTO
 * synchronously on the proxy's OWN event loop (persist.unifiedBackup →
 * shadow.backupInto → store.backupInto → db.exec). Every sqlite engine here is
 * synchronous, so a 1.5 GB index.db froze the whole proxy — including
 * /__bili/health — for the entire copy (~46 s measured), and a health-probing
 * supervisor killed bili mid-backup (target left half-written, in-flight
 * client requests cut off).
 *
 * Fix: run the VACUUM INTO in a worker thread (its own event loop, its own
 * read-only connection to the source). The proxy keeps serving — health probes
 * and in-flight requests flow for the whole copy. The HTTP response shape is
 * unchanged ({ ok, path, bytes }); the response just no longer stalls the
 * process. Same inline-eval-worker idiom as integrity-check.ts (#4609) and
 * event-loop-watchdog.ts (#4762).
 *
 * VACUUM INTO reads a consistent snapshot of the source and writes a NEW file;
 * it takes NO write lock on the source (verified: it runs from a read-only
 * connection while a peer keeps writing). So the worker opens the source
 * READ-ONLY — zero lock interaction with the proxy's own connection, and no
 * #4612 exclusive-lock concern. The destination is created fresh by sqlite.
 *
 * Engine: the worker re-resolves by the same ladder the main thread uses
 * (bun:sqlite → node:sqlite → better-sqlite3 by name) and opens with whichever
 * loads. The self-downloaded better-sqlite3 prebuilt (Node < 22.5, no builtin)
 * is only reachable through the main thread's registered loader closure, which
 * an inline worker cannot see — so on that narrow legacy machine the worker
 * reports a clear error directing the operator to `bili storage backup` (the
 * CLI: a separate process with the full engine ladder). Same engine coverage
 * as the integrity-check worker; a loud, actionable degradation, not a silent
 * break.
 */

import { Worker } from "node:worker_threads";
import { log as loggerLog } from "../logger.js";
import { isBunRuntime } from "./driver.js";
import { recordBackupOutcome } from "./runtime-status.js";
import { createIntegrityWorkerStderrFilter } from "./integrity-check.js";

export interface OnlineBackupResult {
    ok: boolean;
    path?: string;
    bytes?: number;
    error?: string;
}

/** Inline-eval worker: open the source read-only and run VACUUM INTO. Bundled
 *  VERBATIM into dist, so every non-builtin specifier goes through a constant
 *  (scripts/check-dist-external.mjs text-scans for quoted-require forms; node:
 *  sqlite is not in module.builtinModules and bun:sqlite / better-sqlite3 are
 *  not builtins at all — variable indirection is the gate's sanctioned
 *  invisible path, same class as #3511/#3516/#4008; integrity-check.ts and
 *  driver.ts use the same indirection). Do NOT inline a specifier back. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const pathMod = require("node:path");
const SQLITE_SPEC = "node:sqlite";
const BUN_SQLITE_SPEC = "bun:sqlite";
const BETTER_SQLITE3_SPEC = "better-sqlite3";
const isBun = typeof process !== "undefined" && process.versions != null && process.versions.bun != null;
// Open the source READ-ONLY: VACUUM INTO only reads the source and writes a
// new file, so a read-only connection takes no write lock (zero interaction
// with the proxy's own connection). Engine ladder mirrors driver.ts.
const openReadOnly = (p) => {
    if (isBun) return new (require(BUN_SQLITE_SPEC).Database)(p, { readonly: true });
    try {
        return new (require(SQLITE_SPEC).DatabaseSync)(p, { readOnly: true });
    } catch {
        // node:sqlite absent (Node < 22.5): a host-provided better-sqlite3, if
        // installed, still serves. A self-downloaded prebuilt is NOT reachable
        // from here (its loader closure lives in the main thread) — that require
        // throws and the caller reports the CLI fallback.
        return new (require(BETTER_SQLITE3_SPEC))(p, { readonly: true });
    }
};
const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
try {
    const { dbPath, dstPath } = workerData;
    if (fs.existsSync(dstPath)) throw new Error("backup destination already exists: " + dstPath);
    fs.mkdirSync(pathMod.dirname(dstPath), { recursive: true });
    const db = openReadOnly(dbPath);
    try {
        db.exec("VACUUM INTO " + quote(dstPath));
    } finally {
        db.close();
    }
    const bytes = fs.statSync(dstPath).size;
    parentPort.postMessage({ ok: true, path: dstPath, bytes });
} catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.message) || err) });
}
`;

/** Consume the captured worker stderr (#5940): line-buffer it, drop only the
 *  known SQLite experimental-notice block, route every kept line through
 *  loggerLog. Mirrors integrity-check.ts's attachWorkerStderr (kept local so
 *  the load-bearing integrity path is untouched and each worker labels its own
 *  stderr). Call right after construction. */
function attachBackupWorkerStderr(worker: Worker, dbPath: string): void {
    const stream = worker.stderr;
    if (!stream) return; // runtime without a capturable worker stderr: nothing to route
    const keep = createIntegrityWorkerStderrFilter();
    let pending = "";
    const emitLine = (line: string): void => {
        if (line === "") return;
        if (keep(line)) loggerLog("warn", `[storage] backup worker stderr for ${dbPath}: ${line}`);
    };
    stream.on("data", (chunk: Buffer | string) => {
        pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
            emitLine(pending.slice(0, nl));
            pending = pending.slice(nl + 1);
        }
    });
    stream.on("close", () => {
        if (pending.length > 0) emitLine(pending);
    });
}

/** Run an online VACUUM INTO backup of `dbPath` to `dstPath` in a worker
 *  thread, resolving when the copy lands (or fails). The proxy's event loop is
 *  free for the whole duration — health and in-flight requests keep flowing.
 *  Resolves (never rejects): every failure is a `{ ok: false, error }` result
 *  the caller turns into an HTTP 409. */
export function runOnlineBackup(dbPath: string, dstPath: string): Promise<OnlineBackupResult> {
    return new Promise<OnlineBackupResult>((resolve) => {
        let worker: Worker;
        try {
            // stderr: true — capture the worker's own stderr instead of
            // inheriting the host terminal (#5940): Node emits
            // "ExperimentalWarning: SQLite is an experimental feature" once per
            // thread on first node:sqlite use, and with default stdio that
            // printed straight into the agent's TUI mid-session. Node-only: bun
            // workers expose no capturable stderr (and bun:sqlite emits no such
            // notice), so nothing is routed there.
            worker = new Worker(WORKER_SOURCE, {
                eval: true,
                workerData: { dbPath, dstPath },
                ...(isBunRuntime() ? {} : { stderr: true }),
            });
        } catch (err) {
            loggerLog("warn", `[storage] online backup worker could not start for ${dbPath}: ${String(err)} — use 'bili storage backup' (separate process)`);
            resolve({ ok: false, error: `backup worker could not start: ${String(err)} — use 'bili storage backup' (separate process)` });
            return;
        }
        attachBackupWorkerStderr(worker, dbPath);
        let settled = false;
        const settle = (result: OnlineBackupResult): void => {
            if (settled) return;
            settled = true;
            worker.unref();
            resolve(result);
        };
        worker.on("message", (msg: { ok?: boolean; path?: string; bytes?: number; error?: string }) => {
            if (msg.ok === true && typeof msg.path === "string" && typeof msg.bytes === "number") {
                try {
                    recordBackupOutcome(msg.path, msg.bytes);
                } catch {
                    // status recording is best-effort — a failure here must not
                    // fail a backup that already landed on disk
                }
                loggerLog("info", `[storage] online backup written: ${msg.path} (${msg.bytes} bytes) — off the event loop (#7561)`);
                settle({ ok: true, path: msg.path, bytes: msg.bytes });
            } else {
                settle({ ok: false, error: String(msg.error ?? "unknown backup error") });
            }
        });
        worker.on("error", (err) => {
            settle({ ok: false, error: `backup worker error: ${String(err)}` });
        });
        worker.on("exit", (code) => {
            settle({ ok: false, error: `backup worker exited early (code ${code})` });
        });
    });
}
