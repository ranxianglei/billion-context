/**
 * Minimal SQLite driver seam for the unified storage layer (#2671).
 *
 * Engine resolution order (#2833, owner-approved 2026-10-12):
 *   0. bun builtin  — bun:sqlite (bun's own built-in synchronous SQLite). Only
 *                     ever available when the host runtime IS bun, where
 *                     node:sqlite does NOT exist; without this step a bun-run
 *                     bili falls through to the N-API better-sqlite3 path, whose
 *                     prebuilt binding cannot be loaded by bun ("Could not load
 *                     the default exports from better-sqlite3"), so the unified
 *                     store cannot open at all. Same zero-native-dependency
 *                     invariant as step 1.
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
 *   none             — no engine: openSqliteDatabase throws and a unified/full
 *                     ask REFUSES TO START loudly (2026-10-30: no degradation in
 *                     any case; JSON-only serve = explicit BILI_STORAGE_UNIFIED=
 *                     legacy). Pre-policy contract was #2825 legacy-only degrade.
 *
 * The invariant: engine acquisition NEVER depends on host install-time build-script
 * approval; every failure path stays durable (JSON persistence) — either by an
 * explicit JSON-only opt-out or by refusing to start at all (never a silent
 * half-mode).
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

// Specifier through a constant: `bun:sqlite` is bun's own builtin and is NOT in
// module.builtinModules, so a quoted-literal require reads as an external npm
// package to scripts/check-dist-external.mjs (the same indirection that
// SQLITE_SPEC in src/storage/integrity-check.ts uses for node:sqlite). It is
// required lazily, and only when isBunRuntime() says this process IS bun, so a
// thin Node install never evaluates it.
const BUN_SQLITE_SPEC = "bun:sqlite";

export type SqliteEngineName = "better-sqlite3" | "node:sqlite" | "bun:sqlite";

/** True when the host runtime is bun (aliased `node` installs included). bun
 *  implements `bun:sqlite` and NOT `node:sqlite`, so the ladder must tell them
 *  apart; on real Node this is false and the ladder below is unchanged. */
export function isBunRuntime(): boolean {
    return typeof process !== "undefined" && process.versions?.bun !== undefined;
}

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
        transaction: (fn) => {
            try {
                return db.transaction(fn).immediate();
            } catch (err) {
                // #4949: better-sqlite3's own wrapper runs ROLLBACK after ANY
                // inner failure; when BEGIN or COMMIT itself failed there was
                // nothing left to roll back, and its "cannot rollback - no
                // transaction is active" REPLACES the real error (commonly
                // disk full / SQLITE_FULL) before it reaches us. Name the
                // masking at our seam so operators see the likely cause.
                const msg = String(err);
                if (/cannot rollback|no transaction is active/i.test(msg)) {
                    throw new SqliteDriverError(`${msg} — masked by better-sqlite3's automatic rollback after a failed BEGIN/COMMIT; the original error no longer survives (disk full / SQLITE_FULL is the common cause)`, "better-sqlite3");
                }
                throw err;
            }
        },
        readTransaction: (fn) => db.transaction(fn).deferred(),
        close: () => void db.close(),
        get open() {
            return db.open;
        },
    };
}

let databaseSyncFactoryForTests: ((path: string) => NodeSqliteDatabase) | null = null;

/** Test seam: substitute how the node:sqlite emulation obtains its database
 *  handle (e.g. an adapter injecting engine-level I/O failures, #4949).
 *  Null = the real builtin node:sqlite module. */
export function setDatabaseSyncFactoryForTests(factory: ((path: string) => NodeSqliteDatabase) | null): void {
    databaseSyncFactoryForTests = factory;
}

function openNodeSqlite(path: string): SqliteDatabase {
    // node:sqlite is synchronous like better-sqlite3, but has no
    // .transaction() helper — emulate with BEGIN/COMMIT + savepoints for
    // nesting, which is the only behavioral difference the store relies on.
    const db = databaseSyncFactoryForTests
        ? databaseSyncFactoryForTests(path)
        : (() => {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { DatabaseSync } = require("node:sqlite") as {
                  DatabaseSync: new (path: string) => NodeSqliteDatabase;
              };
              return new DatabaseSync(path);
          })();
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
            // #4949: a failed BEGIN/COMMIT can leave NO transaction active
            // (SQLite auto-aborts on I/O-class failures such as disk full);
            // the follow-up ROLLBACK then throws "cannot rollback - no
            // transaction is active" and would MASK the original failure.
            // The original error below is always authoritative.
            try {
                rollback();
            } catch {
                /* secondary rollback failure — original error wins (#4949) */
            }
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
export interface NodeSqliteDatabase {
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

interface BunSqliteStatement {
    run(...args: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint } | undefined;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
}

export interface BunSqliteDatabase {
    exec(sql: string): unknown;
    prepare(sql: string): BunSqliteStatement;
    /** bun mirrors better-sqlite3's shape: wraps fn and returns the callable
     *  wrapper with immediate/deferred/exclusive lock-mode variants attached. */
    transaction<T>(fn: () => T): (() => T) & { immediate(): T; deferred(): T; exclusive(): T };
    close(): void;
}

export type BunSqliteCtor = new (path: string) => BunSqliteDatabase;

let bunDatabaseFactoryForTests: ((path: string) => BunSqliteDatabase) | null = null;

/** Test seam: substitute how the bun:sqlite emulation obtains its database
 *  handle, so the bun adapter can be pinned on a Node CI runner where
 *  `bun:sqlite` cannot load. Null = the real builtin bun:sqlite module. */
export function setBunDatabaseFactoryForTests(factory: ((path: string) => BunSqliteDatabase) | null): void {
    bunDatabaseFactoryForTests = factory;
}

/** bun binds named parameters by the exact sigil written in the SQL (`:a`, `@a`,
 *  `$a`), while the store's SQL is better-sqlite3 style and passes plain
 *  `{ name: value }` objects. Collect the sigil forms a statement actually uses
 *  (literals blanked first) so the adapter can offer bun both spellings. */
type BunNamedParamForms = Map<string, string[]>;

function bunNamedParamForms(sql: string): BunNamedParamForms | undefined {
    const forms: BunNamedParamForms = new Map();
    for (const m of sql.replace(/'[^']*'/g, "''").matchAll(/(?:^|[^:@$])([:@$])([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const bare = m[2];
        const full = m[1] + bare;
        const list = forms.get(bare) ?? [];
        if (!list.includes(full)) list.push(full);
        forms.set(bare, list);
    }
    return forms.size > 0 ? forms : undefined;
}

/** Duplicate each named key into the sigil form(s) the statement uses, keeping
 *  the bare key too (bun accepts it). A positional / array / binary / Date first
 *  argument is not a named-parameter bag and passes through untouched. */
function bunParamArgs(args: unknown[], forms: BunNamedParamForms | undefined): unknown[] {
    if (forms === undefined || args.length === 0) return args;
    const first = args[0];
    if (first === null || typeof first !== "object" || Array.isArray(first) || ArrayBuffer.isView(first) || first instanceof Date) return args;
    const src = first as Record<string, unknown>;
    const out = Object.assign({}, src) as Record<string, unknown>;
    for (const key of Object.keys(src)) {
        for (const form of forms.get(key) ?? []) out[form] = src[key];
    }
    return [out, ...args.slice(1)];
}

/** bun hands back a bare `Uint8Array` for BLOB columns where better-sqlite3 and
 *  node:sqlite hand back a Buffer; the store's media/payload readers expect a
 *  Buffer, so normalize on the way out. `null` rows collapse to `undefined`,
 *  matching the node:sqlite adapter's no-row contract. */
function bunRow(row: unknown): unknown {
    if (row === null) return undefined;
    if (row === undefined || typeof row !== "object") return row;
    const src = row as Record<string, unknown>;
    let mapped: Record<string, unknown> | undefined;
    for (const key of Object.keys(src)) {
        const v = src[key];
        if (v instanceof Uint8Array && !Buffer.isBuffer(v)) {
            if (mapped === undefined) mapped = Object.assign({}, src);
            mapped[key] = Buffer.from(v);
        }
    }
    return mapped ?? row;
}

function adaptBunSqliteStatement(stmt: BunSqliteStatement, forms: BunNamedParamForms | undefined): SqliteStatement {
    return {
        run: (...args: unknown[]) => {
            const res = stmt.run(...bunParamArgs(args, forms));
            return {
                changes: Number(res?.changes ?? 0),
                lastInsertRowid: Number(res?.lastInsertRowid ?? 0),
            };
        },
        get: (...args: unknown[]) => bunRow(stmt.get(...bunParamArgs(args, forms))),
        all: (...args: unknown[]) => stmt.all(...bunParamArgs(args, forms)).map((row) => bunRow(row)),
    };
}

function openBunSqlite(path: string): SqliteDatabase {
    // bun:sqlite is synchronous like better-sqlite3, and already carries a
    // .transaction() helper — only the parameter spelling, the BLOB type and
    // the missing `.open` flag differ from what the store expects.
    const db = bunDatabaseFactoryForTests
        ? bunDatabaseFactoryForTests(path)
        : (() => {
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              const { Database } = require(BUN_SQLITE_SPEC) as { Database: BunSqliteCtor };
              return new Database(path);
          })();
    let closed = false;
    const mode = <T>(fn: () => T, variant: "immediate" | "deferred"): T => {
        const t = db.transaction(fn);
        // BEGIN IMMEDIATE for writes, deferred for reads — the same #2690
        // reasoning as wrapBetterSqlite3: a deferred read-then-write
        // transaction upgrades mid-flight to a write lock (SQLITE_BUSY_SNAPSHOT,
        // which busy_timeout cannot resolve), so writers take the lock up front.
        return t[variant] ? t[variant]() : t();
    };
    return {
        exec: (sql) => void db.exec(sql),
        prepare: (sql) => adaptBunSqliteStatement(db.prepare(sql), bunNamedParamForms(sql)),
        transaction: (fn) => mode(fn, "immediate"),
        readTransaction: (fn) => mode(fn, "deferred"),
        close: () => {
            if (closed) return;
            closed = true;
            db.close();
        },
        get open() {
            return !closed;
        },
    };
}

export type SqliteEngineSource = "builtin" | "host" | "self-downloaded";

interface ResolvedEngine {
    readonly name: SqliteEngineName;
    readonly source: SqliteEngineSource;
}

let probeOverridesForTests: { bun?: boolean; builtin?: boolean; host?: boolean } | null = null;

/** Test seam: override engine availability probes (null = real probes). Lets
 *  resolution-order tests run deterministically on any CI Node version. A bag
 *  that names only `builtin`/`host` simulates a NODE host: bun stays off unless
 *  the caller opts in with `bun: true`, so the #2833 ladder remains testable on
 *  a machine whose runtime happens to be bun (where `node` is aliased to bun). */
export function setSqliteProbeOverridesForTests(o: { bun?: boolean; builtin?: boolean; host?: boolean } | null): void {
    probeOverridesForTests = o;
}

/** bun:sqlite presence probe: bun's builtin synchronous SQLite. False on real
 *  Node (there is no `bun:sqlite` module to require) and false whenever a test
 *  pins a Node-host bag, so the #2833 ladder below stays authoritative there. */
export function probeBunSqlite(): boolean {
    if (probeOverridesForTests?.bun !== undefined) return probeOverridesForTests.bun;
    if (probeOverridesForTests) return false; // a pinned bag = simulated Node host
    if (!isBunRuntime()) return false;
    try {
        return (require(BUN_SQLITE_SPEC) as { Database?: unknown }).Database !== undefined;
    } catch {
        return false;
    }
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

/** #5108: the last successfully resolved engine (null until resolution
 * succeeds). Diagnostics surfaces use it to say WHICH engine resolved when a
 * store open later failed with a real error — reporting "engine: none" for a
 * corrupt-index failure misdirected triage toward an engine problem. */
export function resolvedSqliteEngineInfo(): ResolvedEngine | null {
    return cachedEngine;
}

function detectEngine(): ResolvedEngine {
    if (cachedEngine) return cachedEngine;
    if (probeBunSqlite()) cachedEngine = { name: "bun:sqlite", source: "builtin" };
    else if (probeBuiltinSqlite()) cachedEngine = { name: "node:sqlite", source: "builtin" };
    else if (probeHostBetterSqlite3()) cachedEngine = { name: "better-sqlite3", source: "host" };
    else if (selfDownloadedLoader) cachedEngine = { name: "better-sqlite3", source: "self-downloaded" };
    else throw new SqliteDriverError("no SQLite engine available", "node:sqlite");
    return cachedEngine;
}

/** Test seam: forces the engine for the next open (does not affect open handles). */
export function setPreferredSqliteEngineForTests(engine: SqliteEngineName | null): void {
    cachedEngine = engine ? { name: engine, source: engine === "node:sqlite" || engine === "bun:sqlite" ? "builtin" : "host" } : null;
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
    const resolved = engine ? { name: engine, source: (engine === "node:sqlite" || engine === "bun:sqlite" ? "builtin" : "host") as SqliteEngineSource } : detectEngine();
    if (resolved.name === "bun:sqlite") {
        try {
            return { db: openBunSqlite(path), engine: resolved.name, source: resolved.source };
        } catch (err) {
            throw new SqliteDriverError(String(err), resolved.name);
        }
    }
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
