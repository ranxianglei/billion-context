/**
 * #4609: the open-time integrity check must not be O(index.db) on the boot
 * critical path. PRAGMA quick_check walks every B-tree page of every table,
 * so a 14 GB store costs ~260 s of single-core scan — the native lane's
 * 60 s spawn budget kills the child mid-scan ("bootstrap failed"), the host
 * falls back to direct (no compression) for its whole lifetime, and every
 * restart repeats the scan because the verdict was never cached.
 *
 * Fix, two halves:
 *
 *   verdict cache — a sidecar (index.db.chk) records the last outcome
 *     keyed by (schema version, index.db stat, -wal stat). An unchanged
 *     file set skips the rescan entirely; any write invalidates the key
 *     (clean close refreshes it post-checkpoint — see UnifiedStore.close);
 *     a hot -wal left by a killed process changes the key by construction,
 *     which is exactly the risky boots that deserve a rescan.
 *
 *   background check — a cache MISS on a large store (sync threshold
 *     512 MiB) no longer blocks open: the check runs post-open on a second
 *     read-only connection in a worker thread (WAL allows concurrent
 *     readers, and the main handle has already run recovery, so the
 *     read-only open cannot hit WAL-recovery). Boot returns in
 *     milliseconds; a failure is recorded loudly as an ALARM ONLY — never
 *     persisted as a boot-blocker (2026-10-30 owner policy: a running
 *     store's background finding must not refuse future boots; each next
 *     boot re-scans fresh). No automatic file moves, #4175.
 *     synchronous pre-migration check — the #4175 premise (a corrupt file
 *     must never be migrated against) stays intact wherever it is cheap.
 *     The one concession: on a big store's first boot after upgrade,
 *     migrations may run against an unchecked file — V8's backfill is
 *     streamed and resumable, JSON envelopes remain the recovery source,
 *     and the window is observable (runtime-status + logs).
 *
 * BILI_STORAGE_QUICK_CHECK=0 keeps its meaning: no check, no cache IO.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { log as loggerLog } from "../logger.js";
import { isBunRuntime } from "./driver.js";
import { recordIntegrityOutcome } from "./runtime-status.js";
import { STORAGE_SCHEMA_VERSION } from "./schema.js";

/** Cache-miss stores at or below this size pay the synchronous check (a
 * 512 MiB quick_check is a couple of seconds on commodity disks — the
 * #4175 check-before-migrate premise is preserved wherever it is cheap).
 * Larger stores check in the background instead (#4609). */
/** Stores over this size check integrity in the background (open never
 * blocks); smaller ones check synchronously before migrations (#4609). */
const INTEGRITY_SYNC_THRESHOLD_BYTES = 512 * 1024 * 1024;

interface StatKeyPart {
    s: number;
    m: number;
}

interface IntegrityCache {
    v: 1;
    schema: number;
    db: StatKeyPart;
    wal: StatKeyPart | null;
    ok: boolean;
    detail?: string;
    at: number;
}

type IntegrityMode =
    | { kind: "skip" }
    | { kind: "cached-ok" }
    | { kind: "sync" }
    | { kind: "async"; sizeBytes: number };

export function integrityCachePath(dbPath: string): string {
    // NOTE: deliberately NOT ".chk.json" — sessions directories are walked by
    // consumers that treat every *.json as a session envelope (and abort on
    // non-envelope payloads); a non-.json sidecar name keeps the tree clean.
    return `${dbPath}.chk`;
}

function statPart(file: string): StatKeyPart | null {
    try {
        const st = statSync(file);
        return { s: st.size, m: st.mtimeMs };
    } catch {
        return null;
    }
}

function statKeyOf(dbPath: string): { db: StatKeyPart | null; wal: StatKeyPart | null } {
    return { db: statPart(dbPath), wal: statPart(`${dbPath}-wal`) };
}

function isStatKeyPart(value: unknown): value is StatKeyPart {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const part = value as Partial<StatKeyPart>;
    return typeof part.s === "number" && Number.isSafeInteger(part.s) && part.s >= 0
        && typeof part.m === "number" && Number.isFinite(part.m);
}

/** Read + validate the sidecar. Malformed/absent → null (a plain cache
 * miss — never a boot failure). */
export function readIntegrityCache(dbPath: string): IntegrityCache | null {
    const file = integrityCachePath(dbPath);
    if (!existsSync(file)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
        const parsed = value as Partial<IntegrityCache>;
        if (parsed.v !== 1 || typeof parsed.ok !== "boolean"
            || typeof parsed.schema !== "number" || !Number.isSafeInteger(parsed.schema) || parsed.schema < 0
            || !isStatKeyPart(parsed.db) || (parsed.wal !== null && !isStatKeyPart(parsed.wal))
            || typeof parsed.at !== "number" || !Number.isFinite(parsed.at) || parsed.at < 0
            || (parsed.detail !== undefined && typeof parsed.detail !== "string")) return null;
        return parsed as IntegrityCache;
    } catch {
        return null;
    }
}

/** Persist the verdict keyed by the CURRENT stats of the file set. Never
 * throws — a cache write failure only costs a rescan next boot. */
export function writeIntegrityCache(dbPath: string, ok: boolean, detail?: string): void {
    try {
        const key = statKeyOf(dbPath);
        if (key.db === null) return;
        const cache: IntegrityCache = { v: 1, schema: STORAGE_SCHEMA_VERSION, db: key.db, wal: key.wal, ok, at: Date.now(), ...(ok ? {} : { detail: detail?.slice(0, 400) }) };
        writeFileSync(integrityCachePath(dbPath), JSON.stringify(cache));
    } catch (err) {
        loggerLog("warn", `[storage] integrity verdict cache write skipped for ${dbPath}: ${String(err)}`);
    }
}

/** Decide how open() treats the integrity check for this file set. */
export function integrityModeFor(dbPath: string, env: { BILI_STORAGE_QUICK_CHECK?: string } = process.env): IntegrityMode {
    if (env.BILI_STORAGE_QUICK_CHECK === "0") return { kind: "skip" };
    const cache = readIntegrityCache(dbPath);
    if (cache !== null) {
        const key = statKeyOf(dbPath);
        const matches =
            key.db !== null &&
            cache.db.s === key.db.s &&
            cache.db.m === key.db.m &&
            cache.wal?.s === key.wal?.s &&
            cache.wal?.m === key.wal?.m &&
            cache.schema === STORAGE_SCHEMA_VERSION;
        if (matches) {
            if (cache.ok) return { kind: "cached-ok" };
            // A stale FAIL verdict planted by an OLDER version (this one never
            // caches failures anymore) no longer refuses boots — owner policy
            // 2026-10-30: treat it as a cache miss and let a FRESH scan decide.
            loggerLog("warn", `[storage] previous quick_check verdict for ${dbPath} was FAIL (${cache.detail ?? "no detail"}) — stale verdicts no longer block boots; re-checking with a fresh scan (2026-10-30 owner policy)`);
        }
    }
    const size = statPart(dbPath)?.s ?? 0;
    return size > effectiveSyncThreshold() ? { kind: "async", sizeBytes: size } : { kind: "sync" };
}

// --- background check ------------------------------------------------------

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
// Specifier through a constant: this string is bundled VERBATIM into dist,
// where scripts/check-dist-external.mjs text-scans for quoted-require forms
// (node:sqlite is NOT in module.builtinModules, so it is not skipped as a
// builtin); variable indirection is that gate's sanctioned invisible path.
// Do NOT inline the specifier back into the call — it re-trips the gate
// (same class as #3511/#3516/#4008; driver.ts uses the same indirection for
// bun:sqlite).
// bun is not Node: it has no node:sqlite, and its own builtin speaks the
// better-sqlite3-shaped API (Database, the "readonly" option instead of node's
// "readOnly"), so the worker picks the engine by the runtime it actually runs
// on — the same process.versions.bun test driver.ts uses.
const SQLITE_SPEC = "node:sqlite";
const BUN_SQLITE_SPEC = "bun:sqlite";
const isBunRuntime = typeof process !== "undefined" && process.versions != null && process.versions.bun != null;
const openReadOnly = isBunRuntime
    ? (p) => new (require(BUN_SQLITE_SPEC).Database)(p, { readonly: true })
    : (p) => new (require(SQLITE_SPEC).DatabaseSync)(p, { readOnly: true });
try {
    const db = openReadOnly(workerData.path);
    const rows = db.prepare("PRAGMA quick_check").all();
    db.close();
    const verdict = rows.map((row) => String(row.quick_check ?? "")).join(" ").trim();
    parentPort.postMessage({ ok: true, verdict });
} catch (err) {
    // #5108/#4816: a corruption-shaped THROW out of quick_check (truncated file,
    // garbage header, broken overflow chain) is a FAIL VERDICT, not "could not
    // run" — classify it exactly like src/storage/sqlite-errors.ts does (inlined
    // here because this string is bundled verbatim and cannot import modules;
    // keep the two in sync, the worker-facet regression test pins both).
    const m = String((err && err.message) || err);
    const c = String((err && err.code) || "").toUpperCase();
    const corrupt = c === "SQLITE_CORRUPT" || c === "SQLITE_NOTADB" || m.includes("database disk image is malformed") || m.includes("file is not a database");
    parentPort.postMessage(corrupt ? { ok: false, corrupt: true, error: m } : { ok: false, error: m });
}
`;

// --- worker stderr hygiene (#5940) ------------------------------------------

const KNOWN_SQLITE_EXPERIMENTAL_NOTICE = "ExperimentalWarning: SQLite is an experimental feature";

/** One filter instance per captured worker-stderr stream. Returns true when
 * a line must be KEPT (routed to diagnostics), false when dropped.
 *
 * Node prints its built-in module notices as a block: the header line (with a
 * "(node:<pid>)" prefix in current releases), then either the
 * "(Use `node --trace-warnings ...`)" hint or indented stack frames when
 * --trace-warnings is enabled. After recognizing the header we swallow the
 * whole block trailer so no fragment of the notice leaks; any other content
 * ends the block and is kept. Only the SQLite notice is recognized — every
 * other warning/error passes through untouched (both directions pinned by
 * tests/integrity-worker-stderr.test.ts). If Node ever rewords the notice,
 * the filter stops matching and the notice becomes visible again — graceful
 * degradation, never a silent drop of unrelated output. */
export function createIntegrityWorkerStderrFilter(): (line: string) => boolean {
    let inNoticeBlock = false;
    return (line: string): boolean => {
        if (line.includes(KNOWN_SQLITE_EXPERIMENTAL_NOTICE)) {
            inNoticeBlock = true;
            return false;
        }
        if (inNoticeBlock && (line === "" || /^\s/.test(line) || /^\(Use `node /.test(line))) {
            return false;
        }
        inNoticeBlock = false;
        return true;
    };
}

/** Consume the captured worker stderr (#5940): line-buffer it, drop only the
 * known SQLite experimental-notice block, route every kept line through
 * loggerLog. In the inline lane the logger's stderr leg is muted against the
 * TUI (src/inline-engine.ts), so kept lines land in the durable bili.log
 * file; standalone bili keeps its usual file+stderr surface. Call right
 * after construction — the stream flows immediately and can deliver data
 * even after the verdict message arrives. */
function attachWorkerStderr(worker: Worker, dbPath: string): void {
    const stream = worker.stderr;
    if (!stream) return; // runtime without a capturable worker stderr: nothing to route
    const keep = createIntegrityWorkerStderrFilter();
    let pending = "";
    const emitLine = (line: string): void => {
        if (line === "") return;
        if (keep(line)) loggerLog("warn", `[storage] integrity worker stderr for ${dbPath}: ${line}`);
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

/** Paths with a background check still running (close-time cache refresh
 * defers to the worker's own completion write). */
const inflight = new Set<string>();

/** Fire-and-forget background quick_check on a second read-only connection
 * (#4609). Records the outcome for the operator's alarms (ok or fail —
 * 2026-10-30 owner policy: background findings are ALARMS ONLY, never
 * boot-blockers — no cache write on failure), and tells the caller's store
 * instance so a clean close can refresh the PASS cache key. */
export function scheduleBackgroundIntegrityCheck(dbPath: string, onVerdict?: (ok: boolean) => void): void {
    const size = statPart(dbPath)?.s ?? 0;
    loggerLog("info", `[storage] background quick_check started for ${dbPath} (${(size / (1024 * 1024)).toFixed(1)} MiB over the ${Math.round(effectiveSyncThreshold() / (1024 * 1024))} MiB sync threshold) — serving continues; the verdict lands in /__bili/status (#4609)`);
    inflight.add(dbPath);
    noteCheckRun();
    let worker: Worker;
    try {
        // stderr: true — capture the worker's own stderr instead of inheriting
        // the host terminal (#5940): Node emits "ExperimentalWarning: SQLite is
        // an experimental feature" once per thread on first node:sqlite use,
        // and with default stdio that printed straight into the agent's TUI
        // mid-session. attachWorkerStderr drops only that known notice block;
        // every other line still reaches loggerLog diagnostics. Node-only:
        // bun workers expose no capturable stderr (and bun:sqlite emits no
        // such notice), so nothing is routed there.
        worker = new Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { path: dbPath },
            ...(isBunRuntime() ? {} : { stderr: true }),
        });
        attachWorkerStderr(worker, dbPath);
    } catch (err) {
        inflight.delete(dbPath);
        loggerLog("warn", `[storage] background quick_check could not start for ${dbPath}: ${String(err)} — the store serves unverified; the next boot rechecks`);
        return;
    }
    const finish = (fn: () => void): void => {
        inflight.delete(dbPath);
        try {
            fn();
        } finally {
            worker.unref();
        }
    };
    worker.on("message", (msg: { ok?: boolean; corrupt?: boolean; verdict?: string; error?: string }) => {
        finish(() => {
            if (msg.ok === true) {
                const verdict = String(msg.verdict ?? "");
                if (verdict === "ok") {
                    recordIntegrityOutcome(dbPath, true, 0);
                    writeIntegrityCache(dbPath, true);
                    onVerdict?.(true);
                } else {
                    // A real integrity failure found post-open: record loudly as an
                    // ALARM (owner policy 2026-10-30). It is NOT cached as a
                    // boot-blocker — the NEXT boot re-scans and decides from fresh
                    // evidence; files stay exactly where they are (no automatic
                    // rename, #4175); keep serving now (writes into a provably-
                    // corrupt store surface as ingest errors that are retried on
                    // every subsequent save; envelopes are the recovery source).
                    recordIntegrityOutcome(dbPath, false, 0, verdict.slice(0, 400));
                    loggerLog("error", `[storage] background quick_check FAILED for ${dbPath}: ${verdict.slice(0, 400)} — ALARM ONLY, no boot-blocking verdict written (owner policy 2026-10-30: runtime findings never refuse future boots — each boot re-scans fresh); files left UNTOUCHED (back up ${dbPath}{,-wal,-shm} and move them aside only if you want to force a rebuild); JSON envelopes remain the recovery source (#4175/#4609)`);
                    onVerdict?.(false);
                }
            } else if (msg.corrupt === true) {
                // #5108/#4816: the scan itself threw a corruption-shaped error
                // (the throwing shapes of CORRUPT/NOTADB). Same ALARM-ONLY
                // consequences as a bad verdict row (owner policy 2026-10-30:
                // loud alarm, no cache write, next boot re-scans fresh).
                const detail = String(msg.error ?? "").slice(0, 400);
                recordIntegrityOutcome(dbPath, false, 0, detail);
                loggerLog("error", `[storage] background quick_check threw a corruption-shaped error for ${dbPath}: ${detail} — ALARM ONLY, no boot-blocking verdict written (owner policy 2026-10-30); files left UNTOUCHED`);
                onVerdict?.(false);
            } else {
                loggerLog("warn", `[storage] background quick_check could not run for ${dbPath}: ${String(msg.error)} — the store serves unverified; the next boot rechecks`);
            }
        });
    });
    worker.on("error", (err) => {
        finish(() => loggerLog("warn", `[storage] background quick_check worker error for ${dbPath}: ${String(err)} — the store serves unverified; the next boot rechecks`));
    });
    worker.on("exit", (code) => {
        if (inflight.has(dbPath)) {
            finish(() => loggerLog("warn", `[storage] background quick_check worker exited early (code ${code}) for ${dbPath} — the store serves unverified; the next boot rechecks`));
        }
    });
}

/** Test seam: true when a background check for dbPath is still running. */
export function backgroundIntegrityInflightForTests(dbPath: string): boolean {
    return inflight.has(dbPath);
}

// --- test seams ------------------------------------------------------------

let checkRuns = 0;

/** Called by the store whenever a real check executes (the sync scan) —
 * observable by tests via integrityCheckRunsForTests(); cache hits never
 * count. The background path notes its own run at schedule time. */
export function noteIntegrityCheckRun(): void {
    checkRuns += 1;
}

function noteCheckRun(): void {
    checkRuns += 1;
}

/** Test seam: how many real checks executed (sync scan or background
 * verdict) since the last reset. Cache hits do not count. */
export function integrityCheckRunsForTests(): number {
    return checkRuns;
}

export function resetIntegrityCheckStateForTests(): void {
    checkRuns = 0;
    inflight.clear();
}

let syncThresholdOverride: number | null = null;

/** Test seam: shrink the sync/async threshold to exercise both paths on
 * tiny stores. */
export function setIntegritySyncThresholdForTests(bytes: number | null): void {
    syncThresholdOverride = bytes;
}

/** The sync/async threshold in force — the constant unless a test overrode it. */
function effectiveSyncThreshold(): number {
    return syncThresholdOverride ?? INTEGRITY_SYNC_THRESHOLD_BYTES;
}
