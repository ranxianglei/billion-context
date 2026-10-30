/**
 * Minimal SQLite driver seam for the unified storage layer (#2671).
 *
 * Engine resolution order (#2833, owner-approved 2026-10-12):
 *   1. builtin      — node:sqlite (DatabaseSync; unflagged on recent Node 22.x,
 *                     stable lineage since Node 23.4). Zero native dependency,
 *                     zero build scripts — preferred wherever it exists.
 *   2. host         — better-sqlite3 already installed by the HOST (opportunistic
 *                     require probe; #2825 kept this so hosts that ship/approve
 *                     the module keep using it). Never declared in bili's manifest
 *                     — declaring it is exactly what tripped pnpm >=10's strict
 *                     build-script gate (#2823).
 *   3. self-downloaded — bili's own runtime-fetched N-API prebuilt (see
 *                     engine-bootstrap.ts): pinned version + sha512, cached under
 *                     ~/.cache/billion-context/sqlite/. Registered via
 *                     registerSelfDownloadedBetterSqlite3().
 *   none             — no engine: openSqliteDatabase throws and the unified sidecar
 *                     degrades to legacy-only (contract pinned by #2825).
 *
 * The invariant: engine acquisition NEVER depends on host install-time build-script
 * approval, and every failure path lands in legacy JSON persistence.
 *
 * The interface is deliberately ~50 lines: everything above this file is
 * engine-agnostic SQL; nothing below it leaks into the store.
 */

interface SqliteRunResult {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
}

interface SqliteStatement {
    run(...args: unknown[]): SqliteRunResult;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
}

export interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
    /** Runs fn inside BEGIN/COMMIT; rolls back on throw (including nested calls via savepoints). */
    transaction<T>(fn: () => T): T;
    /** Deferred snapshot: readers do not reserve the writer lock. */
    readTransaction<T>(fn: () => T): T;
    close(): void;
    readonly open: boolean;
}

interface BetterSqlite3Database {
    exec(sql: string): unknown;
    prepare(sql: string): SqliteStatement & { readonly source?: string };
    /** better-sqlite3 wraps fn and returns the wrapped (callable) function,
     *  with immediate/deferred/exclusive lock-mode variants attached. */
    transaction<T>(fn: () => T): (() => T) & { immediate(): T; deferred(): T; exclusive(): T };
    pragma(cmd: string, value?: string | number): unknown;
    open: boolean;
    close(): void;
}

export type BetterSqlite3Ctor = new (path: string) => BetterSqlite3Database;

/** Errors from this module carry this marker so tests can pin the engine in use. */
class SqliteDriverError extends Error {
    constructor(message: string, readonly engine: SqliteEngineName) {
        super(`[storage:${engine}] ${message}`);
    }
}

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SqliteEngineName = "better-sqlite3" | "node:sqlite";

interface OpenedDatabase {
    readonly db: SqliteDatabase;
    readonly engine: SqliteEngineName;
    readonly source: SqliteEngineSource;
}

function wrapBetterSqlite3(db: BetterSqlite3Database): SqliteDatabase {
    return {
        exec: (sql) => void db.exec(sql),
        prepare: (sql) => db.prepare(sql),
        // BEGIN IMMEDIATE, not the default deferred: the multi-process
        // topology (two bili lanes sharing one sessions dir, #394) is
        // SUPPORTED, and a deferred read-then-write transaction upgrades to
        // a write lock mid-flight — SQLITE_BUSY_SNAPSHOT, which busy_timeout
        // cannot resolve. Taking the write lock up front makes concurrent
        // writers queue on busy_timeout instead (#2690 review blocking 5).
        transaction: (fn) => db.transaction(fn).immediate(),
        readTransaction: (fn) => db.transaction(fn).deferred(),
        close: () => void db.close(),
        get open() {
            return db.open;
        },
    };
}

function openNodeSqlite(path: string): SqliteDatabase {
    // node:sqlite is synchronous like better-sqlite3, but has no
    // .transaction() helper — emulate with BEGIN/COMMIT + savepoints for
    // nesting, which is the only behavioral difference the store relies on.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require("node:sqlite") as {
        DatabaseSync: new (path: string) => NodeSqliteDatabase;
    };
    const db = new DatabaseSync(path);
    let depth = 0;
    const begin = (readOnly: boolean) => db.exec(depth === 0 ? (readOnly ? "BEGIN DEFERRED" : "BEGIN IMMEDIATE") : `SAVEPOINT sp${depth}`);
    const commit = () => db.exec(depth === 1 ? "COMMIT" : `RELEASE sp${depth - 1}`);
    const rollback = () => db.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO sp${depth - 1}`);
    const transaction = <T>(fn: () => T, readOnly: boolean): T => {
        if (db.getAutoCommit?.() === false && depth === 0) {
            // Already inside an outer transaction driven directly by
            // DatabaseSync — just run inline; the outer COMMIT covers us.
            return fn();
        }
        begin(readOnly);
        depth++;
        try {
            const out = fn();
            commit();
            return out;
        } catch (err) {
            rollback();
            throw err;
        } finally {
            depth--;
        }
    };
    return {
        exec: (sql) => void db.exec(sql),
        prepare: (sql) => adaptNodeSqliteStatement(db.prepare(sql)),
        transaction: (fn) => transaction(fn, false),
        readTransaction: (fn) => transaction(fn, true),
        close: () => void db.close(),
        get open() {
            return db.open;
        },
    };
}

interface NodeSqliteStatement {
    run(...args: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint } | undefined;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
}
interface NodeSqliteDatabase {
    exec(sql: string): unknown;
    prepare(sql: string): NodeSqliteStatement;
    getAutoCommit(): boolean;
    open: boolean;
    close(): void;
}

function adaptNodeSqliteStatement(stmt: NodeSqliteStatement): SqliteStatement {
    return {
        run: (...args: unknown[]) => {
            const res = stmt.run(...args);
            return {
                changes: Number(res?.changes ?? 0),
                lastInsertRowid: Number(res?.lastInsertRowid ?? 0),
            };
        },
        get: (...args: unknown[]) => stmt.get(...args),
        all: (...args: unknown[]) => stmt.all(...args),
    };
}

export type SqliteEngineSource = "builtin" | "host" | "self-downloaded";

interface ResolvedEngine {
    readonly name: SqliteEngineName;
    readonly source: SqliteEngineSource;
}

let probeOverridesForTests: { builtin?: boolean; host?: boolean } | null = null;

/** Test seam: override engine availability probes (null = real probes). Lets
 *  resolution-order tests run deterministically on any CI Node version. */
export function setSqliteProbeOverridesForTests(o: { builtin?: boolean; host?: boolean } | null): void {
    probeOverridesForTests = o;
}

/** node:sqlite presence probe (#2833 step 1). Absent on Node <= 21 and early
 *  22.x minors that still gate it behind --experimental-sqlite. */
export function probeBuiltinSqlite(): boolean {
    if (probeOverridesForTests?.builtin !== undefined) return probeOverridesForTests.builtin;
    try {
        require("node:sqlite");
        return true;
    } catch {
        return false;
    }
}

/** Host-installed better-sqlite3 probe (#2833 step 2): opportunistic by design —
 *  bili never declares it in its manifest, so this only finds modules the HOST
 *  installed/approved (e.g. a dsh profile whose user allowed the build scripts). */
export function probeHostBetterSqlite3(): boolean {
    if (probeOverridesForTests?.host !== undefined) return probeOverridesForTests.host;
    try {
        require("better-sqlite3");
        return true;
    } catch {
        return false;
    }
}

let selfDownloadedLoader: (() => BetterSqlite3Ctor) | null = null;

/** Production seam (#2833 step 3): engine-bootstrap registers the loader for its
 *  cached self-downloaded better-sqlite3 after extraction + sha verification. */
export function registerSelfDownloadedBetterSqlite3(loader: () => BetterSqlite3Ctor): void {
    selfDownloadedLoader = loader;
}

/** Test seam: drop a previously registered self-downloaded loader (tests only). */
export function clearSelfDownloadedEngineForTests(): void {
    selfDownloadedLoader = null;
}

let cachedEngine: ResolvedEngine | null = null;

function detectEngine(): ResolvedEngine {
    if (cachedEngine) return cachedEngine;
    if (probeBuiltinSqlite()) cachedEngine = { name: "node:sqlite", source: "builtin" };
    else if (probeHostBetterSqlite3()) cachedEngine = { name: "better-sqlite3", source: "host" };
    else if (selfDownloadedLoader) cachedEngine = { name: "better-sqlite3", source: "self-downloaded" };
    else throw new SqliteDriverError("no SQLite engine available", "node:sqlite");
    return cachedEngine;
}

/** Test seam: forces the engine for the next open (does not affect open handles). */
export function setPreferredSqliteEngineForTests(engine: SqliteEngineName | null): void {
    cachedEngine = engine ? { name: engine, source: engine === "node:sqlite" ? "builtin" : "host" } : null;
}

let enginesUnavailableForTests = false;

/** Test seam: makes every open fail as if NO SQLite engine were installed — pins
 *  the no-engine degrade contract regardless of the host Node's own node:sqlite
 *  availability (#2823). Default off; only tests flip it, and always reset it. */
export function setSqliteEnginesUnavailableForTests(unavailable: boolean): void {
    enginesUnavailableForTests = unavailable;
}

function loadHostBetterSqlite3(): BetterSqlite3Ctor {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("better-sqlite3") as unknown as BetterSqlite3Ctor;
}

export function openSqliteDatabase(path: string, engine?: SqliteEngineName): OpenedDatabase {
    if (enginesUnavailableForTests) {
        throw new SqliteDriverError("no SQLite engine available", "node:sqlite");
    }
    const resolved = engine ? { name: engine, source: (engine === "node:sqlite" ? "builtin" : "host") as SqliteEngineSource } : detectEngine();
    if (resolved.name === "better-sqlite3") {
        try {
            const ctor = resolved.source === "self-downloaded" ? selfDownloadedLoader!() : loadHostBetterSqlite3();
            return { db: wrapBetterSqlite3(new ctor(path)), engine: resolved.name, source: resolved.source };
        } catch (err) {
            throw new SqliteDriverError(String(err), resolved.name);
        }
    }
    try {
        return { db: openNodeSqlite(path), engine: "node:sqlite", source: "builtin" };
    } catch (err) {
        throw new SqliteDriverError(String(err), "node:sqlite");
    }
}
