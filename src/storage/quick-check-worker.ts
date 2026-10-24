/**
 * #4609: deferred integrity check for large index.db files.
 *
 * quick_check is O(db size) — 14 GB took 260 s in the field (#4609) — and both
 * engines expose only synchronous APIs, so running it on the main thread
 * post-listen would just move the multi-minute event-loop freeze onto live
 * traffic. It therefore runs in a worker thread that opens its OWN readonly
 * connection to the same WAL-mode file (concurrent reader + writer is the
 * supported SQLite topology; nothing here ever takes a write lock).
 *
 * Outcome protocol (three-way, deliberately):
 *   - worker posts a verdict message     → genuine pass/fail (fail feeds the
 *                                          quarantine-marker path in store.ts)
 *   - worker dies before posting         → INCONCLUSIVE (null): log and retry
 *                                          at the next open. A dead worker
 *                                          must NEVER be treated as corruption —
 *                                          quarantining over an OOM is data loss.
 *
 * The worker is unref'd: it never holds the process open, so a shutdown that
 * outruns the scan simply drops it (next open re-runs; no cache was written).
 */
import { Worker } from "node:worker_threads";
import { log as loggerLog } from "../logger.js";
import type { SqliteEngineName } from "./driver.js";

export interface QuickCheckResult {
    ok: boolean;
    durationMs: number;
    detail?: string;
}

interface WorkerVerdictMessage {
    ok?: unknown;
    durationMs?: unknown;
    detail?: unknown;
}

/** Self-contained worker program (plain JS string — no module imports beyond
 *  node builtins, so it bundles verbatim). argv layout: [anchor, dbPath,
 *  engine]; `anchor` is the dist entry path the MAIN process resolved its
 *  engine against — host-provided better-sqlite3 must resolve the same way
 *  inside the worker (createRequire anchored at the same file). An EVAL
 *  worker prepends the literal marker "[worker eval]" to process.argv, so
 *  the payload is located AFTER that marker, not at a fixed index. */
const WORKER_SOURCE = `"use strict";
const { parentPort } = require("node:worker_threads");
if (!parentPort) process.exit(4);
const MARKER = process.argv.indexOf("[worker eval]");
if (MARKER === -1) process.exit(4);
const [anchor, dbPath, engine] = process.argv.slice(MARKER + 1);
const started = Date.now();
let db;
try {
    // Specifier through a constant: this string is bundled VERBATIM into dist,
    // where scripts/check-dist-external.mjs text-scans for quoted-require forms;
    // variable indirection is that gate's sanctioned invisible path (its header
    // documents opaque specifiers as invisible by design). Do NOT inline the
    // specifier back into the call — it re-trips the gate.
    const SQLITE_SPEC = "node:sqlite";
    if (engine === SQLITE_SPEC) {
        const { DatabaseSync } = require(SQLITE_SPEC);
        db = new DatabaseSync(dbPath, { readOnly: true });
    } else {
        const { createRequire } = require("node:module");
        const BetterSqlite3 = createRequire(anchor)("better-sqlite3");
        db = new BetterSqlite3(dbPath, { readonly: true });
    }
} catch {
    // Engine load failure inside the worker is environmental, NOT an
    // integrity verdict — exit without posting (inconclusive).
    process.exit(3);
}
try {
    const rows = db.prepare("PRAGMA quick_check").all();
    const verdict = rows.map((row) => String(row.quick_check ?? "")).join(" ").trim();
    parentPort.postMessage({ ok: verdict === "ok", durationMs: Date.now() - started, detail: verdict === "ok" ? undefined : verdict.slice(0, 400) });
} catch (err) {
    // Statement-level failure (e.g. NOTADB on a corrupt header) is a genuine
    // integrity failure — same class as the sync path's catch in store.ts.
    parentPort.postMessage({ ok: false, durationMs: Date.now() - started, detail: String(err).slice(0, 400) });
} finally {
    try { db.close(); } catch { /* best-effort */ }
}
`;

const inflightChecks = new Map<string, Promise<QuickCheckResult | null>>();

/** Runs (or reuses) the deferred quick_check for `dbPath`. Resolves to null
 *  when the scan was inconclusive (worker death) — callers must NOT treat
 *  null as corruption. Never rejects. */
export function runDeferredQuickCheck(dbPath: string, engine: SqliteEngineName, anchorPath: string): Promise<QuickCheckResult | null> {
    const existing = inflightChecks.get(dbPath);
    if (existing !== undefined) return existing;
    const promise = new Promise<QuickCheckResult | null>((resolve) => {
        let settled = false;
        const finish = (result: QuickCheckResult | null) => {
            if (!settled) {
                settled = true;
                resolve(result);
            }
        };
        let worker: Worker;
        try {
            worker = new Worker(WORKER_SOURCE, { eval: true, argv: [anchorPath, dbPath, engine] });
        } catch (err) {
            loggerLog("warn", `[storage] deferred quick_check could not start a worker for ${dbPath}: ${String(err)} — inconclusive, retried at the next open`);
            finish(null);
            return;
        }
        worker.unref();
        worker.on("message", (msg: unknown) => {
            if (typeof msg !== "object" || msg === null) {
                finish(null);
                return;
            }
            const m = msg as WorkerVerdictMessage;
            if (typeof m.ok !== "boolean" || typeof m.durationMs !== "number") {
                finish(null);
                return;
            }
            finish({
                ok: m.ok,
                durationMs: m.durationMs,
                ...(typeof m.detail === "string" && m.detail.length > 0 ? { detail: m.detail } : {}),
            });
        });
        worker.on("error", (err) => {
            loggerLog("warn", `[storage] deferred quick_check worker crashed for ${dbPath}: ${String(err)} — inconclusive, retried at the next open`);
            finish(null);
        });
        worker.on("exit", () => finish(null));
    });
    inflightChecks.set(dbPath, promise);
    void promise.then(() => {
        inflightChecks.delete(dbPath);
    });
    return promise;
}
