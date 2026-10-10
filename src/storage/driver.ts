/**
 * Minimal SQLite driver seam for the unified storage layer (#2671).
 *
 * Primary engine: better-sqlite3 (synchronous, prebuilt binaries for the
 * platforms the proxy ships to — chosen in the #2671 design thread because
 * native builds must never become an install-time failure mode).
 * Fallback engine: node:sqlite (DatabaseSync, stable since Node 23.4) so
 * environments that cannot compile/download native modules still run.
 *
 * The interface is deliberately ~50 lines: everything above this file is
 * engine-agnostic SQL; nothing below it leaks into the store.
 */

export interface SqliteRunResult {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
    run(...args: unknown[]): SqliteRunResult;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
}

export interface SqliteDatabase {
    exec(sql: string): void;
    prepare(sql: string): SqliteStatement;
    /** Runs fn inside BEGIN/COMMIT; rolls back on throw (including nested calls via savepoints). */
    transaction<T>(fn: () => T): T;
    close(): void;
    readonly open: boolean;
}

interface BetterSqlite3Database {
    exec(sql: string): unknown;
    prepare(sql: string): SqliteStatement & { readonly source?: string };
    /** better-sqlite3 wraps fn and returns the wrapped (callable) function. */
    transaction<T>(fn: () => T): () => T;
    pragma(cmd: string, value?: string | number): unknown;
    open: boolean;
    close(): void;
}

/** Errors from this module carry this marker so tests can pin the engine in use. */
export class SqliteDriverError extends Error {
    constructor(message: string, readonly engine: SqliteEngineName) {
        super(`[storage:${engine}] ${message}`);
    }
}

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SqliteEngineName = "better-sqlite3" | "node:sqlite";

export interface OpenedDatabase {
    readonly db: SqliteDatabase;
    readonly engine: SqliteEngineName;
}

function openBetterSqlite3(path: string): SqliteDatabase {
    // Node require from ESM/tsx context.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("better-sqlite3") as unknown as {
        new (path: string): BetterSqlite3Database;
    };
    const db = new mod(path);
    return {
        exec: (sql) => void db.exec(sql),
        prepare: (sql) => db.prepare(sql),
        transaction: (fn) => db.transaction(fn)(),
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
    const begin = () => db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT sp${depth}`);
    const commit = () => db.exec(depth === 1 ? "COMMIT" : `RELEASE sp${depth - 1}`);
    const rollback = () => db.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO sp${depth - 1}`);
    return {
        exec: (sql) => void db.exec(sql),
        prepare: (sql) => adaptNodeSqliteStatement(db.prepare(sql)),
        transaction: <T>(fn: () => T): T => {
            if (db.getAutoCommit?.() === false && depth === 0) {
                // Already inside an outer transaction driven directly by
                // DatabaseSync — just run inline; the outer COMMIT covers us.
                return fn();
            }
            begin();
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
        },
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

let cachedEngine: SqliteEngineName | null = null;

function detectEngine(): SqliteEngineName {
    if (cachedEngine) return cachedEngine;
    cachedEngine = "node:sqlite";
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("better-sqlite3");
        cachedEngine = "better-sqlite3";
    } catch {
        // stay on node:sqlite
    }
    return cachedEngine;
}

/** Test seam: forces the engine for the next open (does not affect open handles). */
export function setPreferredSqliteEngineForTests(engine: SqliteEngineName | null): void {
    cachedEngine = engine;
}

export function openSqliteDatabase(path: string, engine?: SqliteEngineName): OpenedDatabase {
    const chosen = engine ?? detectEngine();
    if (chosen === "better-sqlite3") {
        try {
            return { db: openBetterSqlite3(path), engine: chosen };
        } catch (err) {
            throw new SqliteDriverError(String(err), chosen);
        }
    }
    try {
        return { db: openNodeSqlite(path), engine: chosen };
    } catch (err) {
        throw new SqliteDriverError(String(err), chosen);
    }
}
