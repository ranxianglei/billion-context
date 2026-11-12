/**
 * #5788: persist a schema READER FLOOR so an older build refuses a store a
 * newer build migrated with a NON-ADDITIVE change.
 *
 * The schema stamp (user_version / bili_meta schema_version) only says "how
 * far a store has been migrated" — it carries no information about whether an
 * OLDER build can still read the result. Today an older build opening a
 * newer-migrated store either no-ops (sqlite: `from >= version`) or silently
 * re-runs additive DDL (mysql), and then WRITES rows it cannot read back —
 * a rolling-upgrade / rollback footgun.
 *
 * The fix persists, per store, the oldest schema version the writing build
 * can still read (STORAGE_MIN_READER_VERSION / MYSQL_MIN_READER_VERSION, both
 * 8 — v8 is the only non-additive migration, the identity backfill). The
 * floor and the stamp move in ONE transaction (a torn pair would under-report
 * the floor and let a too-old build in). On open, a build whose own schema
 * version is below the stored floor REFUSES TO START (same bucket as
 * CANTOPEN/readonly — the data is newer, not corrupt; degrading would
 * split-brain, #3923). A missing floor row is UNKNOWN (a pre-feature store),
 * not "too new" — it passes, so existing stores never false-refuse.
 *
 * The mysql hermetic arms stand in for the driver with a typed fake (the same
 * discipline as tests/issue4739-storage-read-snapshot.test.ts); the real
 * driver path is covered by the CI mysql-contract job.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";
import {
    STORAGE_SCHEMA_VERSION,
    STORAGE_MIN_READER_VERSION,
    StorageSchemaFloorError,
} from "../src/storage/schema.ts";

// Hermeticity pins (same as the other storage suites): a developer machine's
// real config must not leak a tier into these tests.
process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-reader-floor-hermetic-")),
    "no-config.json",
);
process.env.BILI_STORAGE_UNIFIED = "legacy";
for (const k of ["BILI_STORAGE_BACKEND", "BILI_MYSQL_DSN"]) delete process.env[k];

function tmpdir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmBestEffort(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
        /* leaked temp dir on a Windows runner is harmless */
    }
}

/** Open a fresh store (migrates v1 → current head, writing the floor row +
 *  stamp) and close it, leaving a fully-migrated index.db on disk. */
function freshMigratedDb(dir: string): string {
    const dbPath = path.join(dir, "index.db");
    const store = UnifiedStore.open(dbPath);
    store.close();
    return dbPath;
}

// --- sqlite (hermetic, node:sqlite) ---------------------------------------

test("#5788 invariant: the reader floor never exceeds the current schema version", () => {
    assert.ok(Number.isInteger(STORAGE_MIN_READER_VERSION) && STORAGE_MIN_READER_VERSION >= 1, "floor is a positive integer");
    assert.ok(STORAGE_MIN_READER_VERSION <= STORAGE_SCHEMA_VERSION, "floor must be ≤ the current version (a build can always read its own head)");
});

test("#5788 sqlite: the migration writes the floor row and the stamp atomically", async () => {
    const dir = tmpdir("bili-floor-migrate-");
    try {
        const dbPath = freshMigratedDb(dir);
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(dbPath);
        const ver = raw.prepare("PRAGMA user_version").get() as { user_version: number };
        assert.equal(ver.user_version, STORAGE_SCHEMA_VERSION, "user_version at the schema head after migration");
        const floorRow = raw
            .prepare("SELECT value_json FROM kv_store WHERE namespace = 'storage' AND key = 'schema_reader_floor'")
            .get() as { value_json: string } | undefined;
        assert.ok(floorRow, "the migration wrote the reader floor row");
        assert.equal(JSON.parse(floorRow!.value_json), STORAGE_MIN_READER_VERSION, "the floor row carries the min reader version");
        raw.close();
    } finally {
        rmBestEffort(dir);
    }
});

test("#5788 sqlite: a store whose floor is above this build's version is refused", async () => {
    const dir = tmpdir("bili-floor-refuse-");
    try {
        const dbPath = freshMigratedDb(dir);
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(dbPath);
        // Simulate a FUTURE build that migrated with a non-additive change:
        // it stamped user_version higher AND raised the reader floor above
        // this build's schema version.
        raw.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION + 1}`);
        raw
            .prepare("INSERT INTO kv_store (namespace, key, value_json, updated_at) VALUES ('storage', 'schema_reader_floor', ?, 0) ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json")
            .run(String(STORAGE_SCHEMA_VERSION + 1));
        raw.close();
        await assert.rejects(
            async () => UnifiedStore.open(dbPath),
            (err: unknown) =>
                err instanceof StorageSchemaFloorError &&
                err.storedFloor === STORAGE_SCHEMA_VERSION + 1 &&
                err.runningVersion === STORAGE_SCHEMA_VERSION,
        );
    } finally {
        rmBestEffort(dir);
    }
});

test("#5788 sqlite: a store at the current version with the known floor opens (no false refuse)", async () => {
    const dir = tmpdir("bili-floor-pass-current-");
    try {
        const dbPath = freshMigratedDb(dir);
        const store = UnifiedStore.open(dbPath);
        try {
            const { DatabaseSync } = await import("node:sqlite");
            const raw = new DatabaseSync(dbPath);
            const ver = raw.prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, STORAGE_SCHEMA_VERSION, "user_version left untouched");
            raw.close();
        } finally {
            store.close();
        }
    } finally {
        rmBestEffort(dir);
    }
});

test("#5788 sqlite: a pre-feature store (no floor row) opens — unknown passes, never false-refuses", async () => {
    const dir = tmpdir("bili-floor-pass-nofloor-");
    try {
        const dbPath = freshMigratedDb(dir);
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(dbPath);
        raw.prepare("DELETE FROM kv_store WHERE namespace = 'storage' AND key = 'schema_reader_floor'").run();
        raw.close();
        const store = UnifiedStore.open(dbPath); // must not throw
        store.close();
    } finally {
        rmBestEffort(dir);
    }
});

test("#5788 sqlite: an additive future bump (higher user_version, same floor) opens", async () => {
    const dir = tmpdir("bili-floor-pass-additive-");
    try {
        const dbPath = freshMigratedDb(dir);
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(dbPath);
        // A future ADDITIVE migration raises user_version but NOT the floor.
        raw.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION + 1}`);
        raw.close();
        const store = UnifiedStore.open(dbPath); // must not throw (floor 8 ≤ 11)
        store.close();
    } finally {
        rmBestEffort(dir);
    }
});

// --- mysql (hermetic, typed driver fake) -----------------------------------

interface MysqlFake {
    driver: Mysql2Module;
    ops: string[];
}

/** A typed stand-in for the mysql2/promise driver: answers the meta reads
 *  with the given stamp/floor (null = the row is absent) and records every
 *  operation in order so the stamp+floor transaction can be inspected. The
 *  v8 data step is a no-op (the session list comes back empty) and the
 *  probe-first DDL sees every column/index as already present, so a
 *  migration arm exercises the stamp+floor write without the backfill. */
function makeMysqlFake(stamp: string | null, floor: string | null): MysqlFake {
    const ops: string[] = [];
    const conn = {
        async query(sql: string): Promise<unknown> {
            ops.push(sql);
            if (sql.includes("FROM bili_meta") && sql.includes("'schema_version'")) {
                return stamp === null ? [[]] : [[{ meta_value: stamp }]];
            }
            if (sql.includes("FROM bili_meta") && sql.includes("'schema_reader_floor'")) {
                return floor === null ? [[]] : [[{ meta_value: floor }]];
            }
            if (sql.includes("GET_LOCK")) return [[{ ok: 1 }]];
            if (sql.includes("SELECT DISTINCT session_id FROM messages")) return [[]];
            if (sql.includes("information_schema.COLUMNS") && sql.includes("TABLE_NAME = 'messages'")) {
                return [[{ col: "identity" }, { col: "retired_at" }, { col: "ts" }]];
            }
            if (sql.includes("information_schema.COLUMNS") && sql.includes("TABLE_NAME = 'sessions'")) {
                return [[{ col: "meta_json", dflt: "{}" }, { col: "stats_json", dflt: "{}" }, { col: "metadata_json", dflt: "{}" }, { col: "kstate_json", dflt: "{}" }, { col: "tail_json", dflt: "{}" }]];
            }
            if (sql.includes("information_schema.STATISTICS")) {
                return [
                    [{ tbl: "content", idx: "idx_content_refcount" }],
                    [{ tbl: "messages", idx: "idx_messages_content_hash" }],
                    [{ tbl: "blocks", idx: "idx_blocks_one_hash" }],
                    [{ tbl: "blocks", idx: "idx_blocks_summary_hash" }],
                    [{ tbl: "ccr_entries", idx: "idx_ccr_entries_content_hash" }],
                    [{ tbl: "message_media", idx: "idx_message_media_media_hash" }],
                    [{ tbl: "checkpoints", idx: "idx_checkpoints_state_hash" }],
                ];
            }
            return [[]];
        },
        async beginTransaction() { ops.push("__begin__"); },
        async commit() { ops.push("__commit__"); },
        async rollback() { ops.push("__rollback__"); },
        release() { ops.push("__release__"); },
    };
    const driver = {
        createPool: () => ({
            getConnection: async () => conn,
            query: async () => { throw new Error("query escaped to the pool"); },
            end: async () => {},
        }),
    } as unknown as Mysql2Module;
    return { driver, ops };
}

test("#5788 mysql: a library whose floor is above this build's version is refused", async () => {
    const { driver } = makeMysqlFake(String(STORAGE_SCHEMA_VERSION + 1), String(STORAGE_SCHEMA_VERSION + 1));
    const backend = new MysqlBackend("mysql://floor-refuse", driver);
    try {
        await assert.rejects(
            async () => backend.init(),
            (err: unknown) =>
                err instanceof StorageSchemaFloorError &&
                err.storedFloor === STORAGE_SCHEMA_VERSION + 1 &&
                err.runningVersion === STORAGE_SCHEMA_VERSION,
        );
    } finally {
        await backend.close();
    }
});

test("#5788 mysql: a library at the current version with the known floor opens", async () => {
    const { driver, ops } = makeMysqlFake(String(STORAGE_SCHEMA_VERSION), String(STORAGE_MIN_READER_VERSION));
    const backend = new MysqlBackend("mysql://floor-pass-current", driver);
    try {
        await backend.init(); // must not throw
        // No migration ran (stamp already at the head) → the stamp is
        // re-stamped (GREATEST no-op) but the floor is NOT re-written: a
        // pre-feature library keeps "unknown" and passes the gate.
        const stampInsert = ops.find((o) => o.includes("INSERT INTO bili_meta") && o.includes("'schema_version'"));
        assert.ok(stampInsert, "the stamp INSERT is issued");
        const floorInsert = ops.find((o) => o.includes("INSERT INTO bili_meta") && o.includes("'schema_reader_floor'"));
        assert.equal(floorInsert, undefined, "the floor is NOT re-written when no migration ran");
    } finally {
        await backend.close();
    }
});

test("#5788 mysql: a pre-feature library (no floor row) opens — unknown passes", async () => {
    const { driver } = makeMysqlFake(String(STORAGE_SCHEMA_VERSION), null);
    const backend = new MysqlBackend("mysql://floor-pass-nofloor", driver);
    try {
        await backend.init(); // must not throw
    } finally {
        await backend.close();
    }
});

test("#5788 mysql: an additive future bump (higher stamp, same floor) opens", async () => {
    const { driver } = makeMysqlFake(String(STORAGE_SCHEMA_VERSION + 1), String(STORAGE_MIN_READER_VERSION));
    const backend = new MysqlBackend("mysql://floor-pass-additive", driver);
    try {
        await backend.init(); // must not throw (floor 8 ≤ 11)
    } finally {
        await backend.close();
    }
});

test("#5788 mysql: a migration writes the stamp and the floor in ONE transaction", async () => {
    const { driver, ops } = makeMysqlFake(String(STORAGE_SCHEMA_VERSION - 1), String(STORAGE_MIN_READER_VERSION));
    const backend = new MysqlBackend("mysql://floor-migrate", driver);
    try {
        await backend.init(); // migrated = true (stamp below the head)
        const lastBegin = ops.lastIndexOf("__begin__");
        const lastCommit = ops.lastIndexOf("__commit__");
        assert.ok(lastBegin !== -1 && lastCommit !== -1, "a final stamp+floor transaction ran");
        assert.ok(lastBegin < lastCommit, "begin precedes commit");
        const window = ops.slice(lastBegin, lastCommit);
        assert.ok(window.some((o) => o.includes("INSERT INTO bili_meta") && o.includes("'schema_version'")), "the stamp INSERT is inside the final transaction");
        assert.ok(window.some((o) => o.includes("INSERT INTO bili_meta") && o.includes("'schema_reader_floor'")), "the floor INSERT is in the SAME transaction as the stamp");
        assert.equal(window.filter((o) => o === "__begin__").length, 1, "exactly one begin in the window");
        assert.equal(window.filter((o) => o === "__commit__").length, 0, "no commit until the very end (atomicity)");
    } finally {
        await backend.close();
    }
});
