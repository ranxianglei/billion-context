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

/** Read + validate the sidecar. Malformed/absent → null (a plain cache
 * miss — never a boot failure). */
export function readIntegrityCache(dbPath: string): IntegrityCache | null {
    const file = integrityCachePath(dbPath);
    if (!existsSync(file)) return null;
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<IntegrityCache>;
        if (parsed.v !== 1 || typeof parsed.ok !== "boolean") return null;
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
// (same class as #3511/#3516/#4008; see 8b70e913 for the same fix in
// src/storage/quick-check-worker.ts).
const SQLITE_SPEC = "node:sqlite";
try {
    const { DatabaseSync } = require(SQLITE_SPEC);
    const db = new DatabaseSync(workerData.path, { readOnly: true });
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
        worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { path: dbPath } });
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
