// #7574 items 10 + small — two storage-schema follow-ups from the PR #6785
// review.
//
// 1. The egress op-log group is two tables plus two indexes. It used to be
//    executed bare, so a crash after the first CREATE left a library with
//    egress_state and no egress_flow — and because the next open probed
//    only egress_state, the half-built pair never completed. The group is
//    now applied in one transaction and the probe asks for both tables, so
//    a library that was interrupted by the old code converges on its next
//    open.
//
// 2. idx_conversations_session lives in the v1 DDL, so only a database born
//    on a current build ever had it; a library that upgraded from an
//    earlier release never got the index and every conversations(session_id)
//    lookup stayed a full scan. The migration now probes the index itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { migrateSchema, STORAGE_SCHEMA_VERSION } from "../src/storage/schema.ts";

process.env.BILI_PERSIST_ZSTD = "0";
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-7574-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");

type Db = ReturnType<typeof openSqliteDatabase>["db"];

function tables(db: Db): string[] {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as unknown as { name: string }[])
        .map((r) => r.name);
}

function plan(db: Db, sql: string): string {
    const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as unknown as { detail: string }[];
    return rows.map((r) => r.detail).join(" | ");
}

test("#7574 a library interrupted between the two egress tables completes on its next open", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bili-7574-egress-")), "index.db");
    const { db } = openSqliteDatabase(file);
    try {
        // The state a mid-PR dev build left behind: the first CREATE of the
        // batch committed, the process died before the second one.
        db.exec(`CREATE TABLE egress_state (
            session_id TEXT NOT NULL,
            op_seq INTEGER NOT NULL,
            log_seq INTEGER,
            row_type TEXT NOT NULL CHECK (row_type IN ('B','I','D','U')),
            msgid TEXT,
            payload TEXT NOT NULL,
            bytes TEXT,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, op_seq)
        )`);
        db.prepare("INSERT INTO egress_state VALUES ('s1', 1, 1, 'B', 'm1', '{}', NULL, 0)").run();
        assert.ok(!tables(db).includes("egress_flow"), "precondition: the pair is half-built");

        migrateSchema(db);

        const names = tables(db);
        assert.ok(names.includes("egress_state"), "egress_state is still there");
        assert.ok(names.includes("egress_flow"), "the missing egress_flow is created");
        const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_egress_state_msgid', 'idx_egress_flow_msgid') ORDER BY name").all() as unknown as { name: string }[])
            .map((r) => r.name);
        assert.deepEqual(idx, ["idx_egress_flow_msgid", "idx_egress_state_msgid"], "both msgid lookup indexes exist (PK is now (session_id, rid) — 2026-11-27 owner ruling)");
        assert.ok(
            (db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('egress_state') WHERE name = 'pos'").get() as { n: number }).n === 1,
            "the rebuilt state table carries the 7773 materialized shape (pos column)",
        );
        assert.equal(
            (db.prepare("SELECT COUNT(*) AS n FROM egress_state").get() as { n: number }).n,
            0,
            "7773 §7: the tables were never released — the interim rows are dropped, not migrated",
        );
        // Idempotent: the next open is a no-op for the group.
        migrateSchema(db);
        assert.ok(tables(db).includes("egress_flow"));
    } finally {
        db.close();
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
});

test("#7574 a library that upgraded from an earlier release gets the conversations(session_id) index", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bili-7574-conv-")), "index.db");
    const { db } = openSqliteDatabase(file);
    try {
        // Start from a complete library, then take it back to the state an
        // upgraded installation is in: every table of an earlier release,
        // no idx_conversations_session (that index rides the v1 DDL, which
        // only a database born on a current build runs), version stamped
        // below the current one.
        migrateSchema(db);
        db.exec("DROP INDEX idx_conversations_session");
        const ins = db.prepare("INSERT OR IGNORE INTO conversations VALUES ('proxy', ?, ?, 0)");
        for (let i = 0; i < 200; i++) ins.run(`c${i}`, `s${i}`);
        db.exec("PRAGMA user_version = 11");
        assert.ok(!/idx_conversations_session/.test(plan(db, "SELECT conversation_id FROM conversations WHERE session_id = 's7'")));

        const res = migrateSchema(db);

        assert.equal(res.from, 11);
        assert.equal(res.to, STORAGE_SCHEMA_VERSION);
        assert.match(
            plan(db, "SELECT conversation_id FROM conversations WHERE session_id = 's7'"),
            /idx_conversations_session/,
            "the lookup is answered by the index",
        );
        assert.equal(
            (db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n,
            200,
            "no row was touched",
        );
        // A fresh database keeps exactly one copy of the index.
        migrateSchema(db);
        const copies = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_conversations_session'").get() as { n: number }).n;
        assert.equal(copies, 1);
    } finally {
        db.close();
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
});

test("#7574 a database born on this build is unchanged by the two probes", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bili-7574-fresh-")), "index.db");
    const { db } = openSqliteDatabase(file);
    try {
        const res = migrateSchema(db);
        assert.equal(res.from, 0);
        const names = tables(db);
        for (const t of ["egress_state", "egress_flow", "conversations", "state_fields", "orphan_blocks", "l1_world"]) {
            assert.ok(names.includes(t), `fresh library has ${t}`);
        }
        assert.match(plan(db, "SELECT conversation_id FROM conversations WHERE session_id = 's7'"), /idx_conversations_session/);
        assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, STORAGE_SCHEMA_VERSION);
    } finally {
        db.close();
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
});
