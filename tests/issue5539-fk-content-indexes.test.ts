import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #5539 — FK child columns of `content` are unindexed: every releaseContent
 * DELETE full-scans the child tables.
 *
 * With `foreign_keys = ON`, deleting a parent `content` row must prove no
 * child row still references it. SQLite proves that by scanning each child
 * table BY ITS REF COLUMN — an index lookup when the column is indexed, a
 * FULL TABLE SCAN when it is not. Six columns reference content(hash)
 * (messages.content_hash, blocks.one_hash, blocks.summary_hash,
 * ccr_entries.content_hash, message_media.media_hash, checkpoints.state_hash)
 * and none carried an index, so one parent delete cost six full scans.
 * releaseContent() removes one parent per released hash (~3K/turn on a busy
 * session): field report #5539 measured 20–35 s/turn at ~18K messages,
 * 4–5 s after adding these keys.
 *
 * Fix: schema v11 creates the six indexes (fresh DDL + idempotent migration
 * block), mirrored in the MySQL backend's DDL and probe-first ALTERs. These
 * tests pin: fresh installs carry them, v10-era libraries gain them on
 * reopen, the DELETE plan actually uses them (both directions: scans before,
 * indexed searches after), and FK enforcement itself is unchanged.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-5539-fk-")),
    "no-config.json",
);

const FK_CHILD_INDEXES = [
    "idx_messages_content_hash",
    "idx_blocks_one_hash",
    "idx_blocks_summary_hash",
    "idx_ccr_entries_content_hash",
    "idx_message_media_media_hash",
    "idx_checkpoints_state_hash",
] as const;

const CHILD_TABLES = ["messages", "blocks", "ccr_entries", "message_media", "checkpoints"] as const;

/** EXPLAIN QUERY PLAN for the exact parent-delete releaseContent issues.
 *  With foreign_keys=ON the plan carries one step per child table: a full
 *  `SCAN <table>` when the ref column is unindexed, `SEARCH <table> USING
 *  INDEX …` when it is not. */
const DELETE_PLAN_SQL = "EXPLAIN QUERY PLAN DELETE FROM content WHERE hash = ? AND refcount <= 0";

function rawDb(store: UnifiedStore): DatabaseSync {
    return (store as unknown as { db: DatabaseSync }).db;
}

function rmDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* Windows stray handles */ }
}

function planDetails(db: DatabaseSync): string[] {
    const rows = db.prepare(DELETE_PLAN_SQL).all("probe-hash") as Array<{ detail?: unknown }>;
    return rows.map((r) => String(r.detail ?? ""));
}

function assertPlanIndexed(details: string[], label: string): void {
    for (const name of FK_CHILD_INDEXES) {
        assert.ok(
            details.some((d) => d.includes(name)),
            `${label}: parent DELETE must check children via ${name}; got:\n${details.join("\n")}`,
        );
    }
    for (const table of CHILD_TABLES) {
        assert.ok(
            !details.some((d) => d.includes(`SCAN ${table}`)),
            `${label}: parent DELETE must not full-scan ${table}; got:\n${details.join("\n")}`,
        );
    }
}

test("#5539 v11: fresh install carries all six FK-child indexes and the DELETE plan uses them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5539-fresh-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            const ver = rawDb(store).prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 12);
            for (const name of FK_CHILD_INDEXES) {
                const idx = rawDb(store)
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
                    .get(name);
                assert.ok(idx, `${name} present on fresh install`);
            }
            assertPlanIndexed(planDetails(rawDb(store)), "fresh install");
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#5539 v11: a v10-era library (no FK-child indexes) gains them on reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5539-upgrade-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const first = UnifiedStore.open(dbPath);
        first.close();
        // Simulate the field shape: a stamped-v10 database whose parent
        // DELETE plan still full-scans every child table.
        const raw = new DatabaseSync(dbPath);
        raw.exec("PRAGMA foreign_keys = ON");
        for (const name of FK_CHILD_INDEXES) raw.exec(`DROP INDEX ${name}`);
        raw.exec("PRAGMA user_version = 10");
        const before = planDetails(raw);
        for (const table of CHILD_TABLES) {
            assert.ok(
                before.some((d) => d.includes(`SCAN ${table}`)),
                `precondition: unindexed v10 plan must full-scan ${table}; got:\n${before.join("\n")}`,
            );
        }
        raw.close();

        const store = UnifiedStore.open(dbPath);
        try {
            const ver = rawDb(store).prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 12, "v10 -> v12 migration ran");
            for (const name of FK_CHILD_INDEXES) {
                const idx = rawDb(store)
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
                    .get(name);
                assert.ok(idx, `${name} recreated by the v10 -> v11 migration`);
            }
            assertPlanIndexed(planDetails(rawDb(store)), "after v10 -> v11 migration");
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#5539 v11: FK enforcement is unchanged — a referenced parent still cannot be deleted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5539-enforce-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            const db = rawDb(store);
            db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, ?, 'sha256', ?)")
                .run("h-ref", 3, 1, Buffer.from("abc"));
            db.prepare(
                "INSERT INTO messages (session_id, seq, msg_id, role, kind, content_hash, identity) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ).run("s-enf", 0, "m0", "user", "message", "h-ref", "");
            // Decrement to zero like releaseContent, then attempt the delete:
            // the child reference must still veto it.
            db.prepare("UPDATE content SET refcount = refcount - 1 WHERE hash = ? AND refcount > 0").run("h-ref");
            assert.throws(
                () => db.prepare("DELETE FROM content WHERE hash = ? AND refcount <= 0").run("h-ref"),
                // node:sqlite surfaces it as ERR_SQLITE_ERROR; the message is
                // the stable contract here.
                /FOREIGN KEY constraint failed/,
                "parent delete while a child row references it must fail the FK check",
            );
            assert.equal(
                (db.prepare("SELECT COUNT(*) AS n FROM content WHERE hash = 'h-ref'").get() as { n: number }).n,
                1,
                "referenced parent row survives the rejected delete",
            );
            // Release the child first: the identical delete now succeeds —
            // the index changed HOW the check runs, not WHETHER it runs.
            db.prepare("DELETE FROM messages WHERE session_id = 's-enf' AND seq = 0").run();
            db.prepare("DELETE FROM content WHERE hash = ? AND refcount <= 0").run("h-ref");
            assert.equal(
                (db.prepare("SELECT COUNT(*) AS n FROM content WHERE hash = 'h-ref'").get() as { n: number }).n,
                0,
                "child-released parent deletes cleanly",
            );
            assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "no dangling references");
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});
