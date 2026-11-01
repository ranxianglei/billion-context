/**
 * bun:sqlite as bili's unified-store engine (this fork's bun support).
 *
 * Upstream bili only knows better-sqlite3 and node:sqlite. Under bun neither
 * exists: there is no `node:sqlite` module, and a better-sqlite3 N-API
 * prebuild cannot be loaded by bun at all. The only engine bun has is its
 * builtin `bun:sqlite`, which is synchronous like better-sqlite3 but differs
 * in three ways src/storage/driver.ts's adapter has to absorb:
 *
 *   1. NAMED PARAMETERS bind by the exact sigil written in the SQL (`:a`, `@b`,
 *      `$c`); the store's SQL is better-sqlite3 style and passes plain
 *      `{ a: 1 }` bags.
 *   2. BLOB columns come back as a bare `Uint8Array`, not a Buffer.
 *   3. `run()` reports `changes` / `lastInsertRowid` as BigInt, and the
 *      database has no `.open` flag.
 *
 * Tests 1-6 pin that contract against a fake bun Database so they run on the
 * Node CI runner too (the seam `setBunDatabaseFactoryForTests` bypasses the
 * unloadable module). The last group runs only under bun and drives the real
 * builtin, including the write-lock mode the #2690 multi-process topology
 * depends on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    isBunRuntime,
    openSqliteDatabase,
    resolvedSqliteEngineInfo,
    setBunDatabaseFactoryForTests,
    setPreferredSqliteEngineForTests,
    setSqliteProbeOverridesForTests,
    type BunSqliteDatabase,
} from "../src/storage/driver.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import type { CoreMessage } from "acp-kernel";

process.env.BILI_PERSIST_ZSTD = "0";

type Call = { kind: "exec" | "run" | "get" | "all"; sql: string; args: unknown[] };

/** Minimal stand-in for bun's Database: records every call, returns the shapes
 *  bun really returns (BigInt counters, Uint8Array BLOB, null for no row). */
class FakeBun implements BunSqliteDatabase {
    readonly calls: Call[] = [];
    readonly txModes: string[] = [];
    closeCount = 0;
    /** What get() hands back; bun returns null where better-sqlite3 says undefined. */
    row: unknown = { n: 5, blob: new Uint8Array([1, 2, 3]) };
    exec(sql: string): unknown {
        this.calls.push({ kind: "exec", sql, args: [] });
        return undefined;
    }
    prepare(sql: string) {
        const rec = (kind: Call["kind"], args: unknown[]) => this.calls.push({ kind, sql, args });
        return {
            run: (...args: unknown[]) => (rec("run", args), { changes: 2n, lastInsertRowid: 7n }),
            get: (...args: unknown[]) => (rec("get", args), this.row),
            all: (...args: unknown[]) => (rec("all", args), []),
        };
    }
    transaction<T>(fn: () => T): (() => T) & { immediate(): T; deferred(): T; exclusive(): T } {
        const wrap = (mode: string) => () => {
            this.txModes.push(mode);
            return fn();
        };
        return Object.assign(wrap("default"), { immediate: wrap("immediate"), deferred: wrap("deferred"), exclusive: wrap("exclusive") });
    }
    close(): void {
        this.closeCount++;
    }
}

function openFake(): { db: ReturnType<typeof openSqliteDatabase>["db"]; fake: FakeBun } {
    const fake = new FakeBun();
    setBunDatabaseFactoryForTests(() => fake);
    const { db } = openSqliteDatabase("/unused/index.db", "bun:sqlite");
    return { db, fake };
}

function reset(): void {
    setBunDatabaseFactoryForTests(null);
    setPreferredSqliteEngineForTests(null);
    setSqliteProbeOverridesForTests(null);
}

test("bun named params: every sigil the SQL writes is offered to bun", () => {
    try {
        const { db, fake } = openFake();
        db.prepare("INSERT INTO t (a, b, c) VALUES (:a, @b, $c)").run({ a: 1, b: "x", c: true });
        const bag = fake.calls[0].args[0] as Record<string, unknown>;
        assert.deepEqual(bag, { a: 1, ":a": 1, b: "x", "@b": "x", c: true, "$c": true });
        // A literal that merely LOOKS like a sigil must not invent a binding.
        db.prepare("SELECT ':nope' AS s, x::int AS i FROM t WHERE y = :y").run({ y: 2 });
        const second = fake.calls[1].args[0] as Record<string, unknown>;
        assert.deepEqual(Object.keys(second).sort(), [":y", "y"]);
    } finally {
        reset();
    }
});

test("bun args that are not a named bag pass through untouched", () => {
    try {
        const { db, fake } = openFake();
        const blob = new Uint8Array([9, 9]);
        const when = new Date(0);
        db.prepare("INSERT INTO media VALUES (?, ?, ?)").run(blob, when, 3);
        assert.deepEqual(fake.calls[0].args, [blob, when, 3]);
        assert.equal(fake.calls[0].args[0], blob, "the caller's own binary argument must reach bun as-is");
        // Named SQL driven positionally: no rewriting, no crash.
        db.prepare("SELECT * FROM t WHERE a = :a").run(4);
        assert.deepEqual(fake.calls[1].args, [4]);
    } finally {
        reset();
    }
});

test("bun rows: BLOB becomes Buffer, no row becomes undefined", () => {
    try {
        const { db, fake } = openFake();
        const row = db.prepare("SELECT n, blob FROM t WHERE a = :a").get({ a: 1 }) as { n: number; blob: unknown };
        assert.equal(row.n, 5);
        assert.ok(Buffer.isBuffer(row.blob), "the store's media readers expect a Buffer, not a bare Uint8Array");
        assert.deepEqual([...(row.blob as Buffer)], [1, 2, 3]);
        fake.row = null;
        assert.equal(db.prepare("SELECT n FROM t WHERE a = :a").get({ a: 404 }), undefined, "bun hands back null where better-sqlite3 hands back undefined");
    } finally {
        reset();
    }
});

test("bun run() reports numeric changes/lastInsertRowid", () => {
    try {
        const { db } = openFake();
        const res = db.prepare("UPDATE t SET a = :a WHERE b = :b").run({ a: 1, b: 2 });
        assert.equal(typeof res.changes, "number");
        assert.deepEqual(res, { changes: 2, lastInsertRowid: 7 });
    } finally {
        reset();
    }
});

test("bun transactions: writes take the write lock up front, reads defer", () => {
    try {
        const { db, fake } = openFake();
        assert.equal(db.transaction(() => "written"), "written");
        assert.equal(db.readTransaction(() => "read"), "read");
        assert.deepEqual(fake.txModes, ["immediate", "deferred"]);
        assert.equal(db.open, true);
        db.close();
        assert.equal(db.open, false);
        db.close();
        assert.equal(fake.closeCount, 1, "close() must be idempotent — the store closes on both the happy and the failing path");
    } finally {
        reset();
    }
});

test("bun probe is false on real Node, so the #2833 ladder stays authoritative there", () => {
    try {
        setSqliteProbeOverridesForTests(null);
        if (isBunRuntime()) {
            assert.equal(resolvedSqliteEngineInfo() === null || resolvedSqliteEngineInfo()?.name === "bun:sqlite", true);
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-bun-engine-"));
            const { db, engine, source } = openSqliteDatabase(path.join(dir, "index.db"));
            assert.equal(engine, "bun:sqlite");
            assert.equal(source, "builtin");
            assert.deepEqual(resolvedSqliteEngineInfo(), { name: "bun:sqlite", source: "builtin" });
            db.close();
        } else {
            // On Node there is no bun:sqlite to load: an engine chosen there could
            // never open, so step 0 of the ladder must decline.
            assert.throws(() => require("bun:sqlite"), () => true);
            assert.equal(openSqliteDatabase("/unused/index.db").engine === "bun:sqlite", false);
        }
    } finally {
        reset();
    }
});

// --- the real builtin, bun only ----------------------------------------------

const notBun = !isBunRuntime() && "bun:sqlite exists only under bun";

test("real bun:sqlite round-trips the store's SQL shapes", { skip: notBun }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-bun-real-"));
    const { db, engine } = openSqliteDatabase(path.join(dir, "index.db"), "bun:sqlite");
    assert.equal(engine, "bun:sqlite");
    try {
        // The PRAGMAs the store issues at open, including the ones whose result
        // row bun must still hand back (journal_mode).
        db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
        assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
        db.exec("CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT, c BLOB)");
        db.transaction(() => {
            db.prepare("INSERT INTO t (a, b, c) VALUES (:a, :b, :c)").run({ a: 1, b: "hello", c: new Uint8Array([1, 2, 3]) });
            db.prepare("INSERT INTO t (a, b, c) VALUES (:a, :b, :c)").run({ a: 2, b: "world", c: new Uint8Array([4]) });
        });
        const row = db.prepare("SELECT a, b, c FROM t WHERE a = :a").get({ a: 1 }) as { a: number; b: string; c: unknown };
        assert.deepEqual({ a: row.a, b: row.b }, { a: 1, b: "hello" });
        assert.ok(Buffer.isBuffer(row.c));
        assert.deepEqual([...(row.c as Buffer)], [1, 2, 3]);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n, 2);
    } finally {
        db.close();
    }
});

test("real bun:sqlite: BEGIN really opens, rollback reverts nested writes, lock releases", { skip: notBun }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-bun-tx-"));
    const file = path.join(dir, "index.db");
    // bun ships no ambient types here (tsc runs on Node), and the dist external
    // gate only tolerates the specifier as an opaque variable — same shape the
    // driver itself loads it through.
    const spec = "bun:" + "sqlite";
    const { Database } = (await import(spec)) as { Database: new (p: string) => BunSqliteDatabase & { inTransaction: boolean } };
    const raws: (BunSqliteDatabase & { inTransaction: boolean })[] = [];
    setBunDatabaseFactoryForTests((p) => {
        const d = new Database(p);
        raws.push(d);
        return d;
    });
    const db = openSqliteDatabase(file, "bun:sqlite").db;
    const other = openSqliteDatabase(file, "bun:sqlite").db;
    try {
        db.exec("PRAGMA busy_timeout = 5000; CREATE TABLE t (a INTEGER PRIMARY KEY)");
        other.exec("PRAGMA busy_timeout = 5000");
        let lockHeld: boolean | null = null;
        let nestedRan = false;
        assert.throws(
            () =>
                db.transaction(() => {
                    lockHeld = raws[0]!.inTransaction;
                    db.prepare("INSERT INTO t VALUES (?)").run(1);
                    // Nested through the adapter: bun ignores the inner BEGIN —
                    // the same contract better-sqlite3 gives the store, so this
                    // must neither throw nor commit early.
                    nestedRan = db.transaction(() => (db.prepare("INSERT INTO t VALUES (?)").run(2), true)) === true;
                    throw new Error("boom");
                }),
            /boom/,
        );
        assert.equal(lockHeld, true, "the engine must be inside BEGIN while the callback runs");
        assert.equal(nestedRan, true);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n, 0, "the outer rollback must revert the nested write as well");
        // An aborted IMMEDIATE transaction must hand the write lock back: a second
        // connection writes immediately instead of queueing on busy_timeout (#2690).
        other.transaction(() => void other.prepare("INSERT INTO t VALUES (?)").run(3));
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n, 1);
        assert.equal(db.readTransaction(() => (db.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n), 1);
    } finally {
        db.close();
        other.close();
        reset();
    }
});

// ── 5. the real store on bun:sqlite ─────────────────────────────────────────
// The fakes above pin the adapter; this drives the actual UnifiedStore the proxy
// runs on: open (PRAGMA ladder, foreign_keys, verbatim migrations, PRAGMA
// quick_check), ingest (named-param inserts inside BEGIN IMMEDIATE), reads,
// close (WAL checkpoint) and a reopen through a fresh driver instance.
function storeMsg(id: string): CoreMessage {
    return { id, role: "user", contentType: "text", text: `body ${id}` } as unknown as CoreMessage;
}

/** The minimal legacy session the storage suites feed the store. */
function storeSession(id: string, tail: CoreMessage[]): LegacySessionLike {
    const byRaw: Record<string, string> = {};
    const byRef: Record<string, string> = {};
    tail.forEach((m, i) => {
        const ref = `m${String(i + 1).padStart(5, "0")}`;
        byRaw[m.id] = ref;
        byRef[ref] = m.id;
    });
    const blk = {
        blockId: "blk1", runId: 1, createdAt: 1_000, tier: 1, active: true,
        summary: "summary body", kind: "fold", reason: "test",
        effectiveMessageIds: tail.map((m) => m.id), directMessageIds: [] as string[],
    };
    return {
        id, createdAt: 1_000, lastSeen: 2_000,
        meta: { protocol: "openai" }, stats: {}, metadata: {},
        state: { blocks: [blk as never], nextBlockId: 2, nextRunId: 2, messageRefs: { byRaw, byRef } },
        blockContents: new Map(), lastMessages: tail, lastMessagesFolded: false,
        pluginSnapshot: undefined, contentStore: undefined,
    };
}

test("the real UnifiedStore round-trips a session on bun:sqlite", { skip: notBun }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-bun-store-"));
    const dbPath = path.join(dir, "index.db");
    const tail = ["a", "b", "c"].map(storeMsg);
    let store: UnifiedStore | undefined;
    try {
        store = UnifiedStore.open(dbPath);
        assert.equal(store.engine, "bun:sqlite", "auto-detect must resolve the builtin engine under bun");
        assert.equal(store.engineSource, "builtin");
        store.ingestSession(planIngest(storeSession("sess-bun", tail)));
        assert.ok(store.sessionCounters("sess-bun"), "the counter row landed");
        const rows = store.messagesForIds("sess-bun", ["a", "b", "c"], false);
        assert.deepEqual(rows.map((r) => r.msgId), ["a", "b", "c"]);
        assert.ok(rows.every((r) => r.content.length > 0), "content rows were written and read back");
        store.close();
        store = undefined;
        const again = UnifiedStore.open(dbPath);
        try {
            assert.deepEqual(again.messagesForIds("sess-bun", ["b", "c"], false).map((r) => r.msgId), ["b", "c"],
                "the data survives close (WAL checkpoint) and a reopen through a fresh driver instance");
        } finally {
            again.close();
        }
    } finally {
        try { store?.close(); } catch { /* already closed */ }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
