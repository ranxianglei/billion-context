import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UnifiedStore } from "../src/storage/store.ts";
import { STORAGE_DDL_V1_FOR_TESTS } from "../src/storage/schema.ts";
import { probeBuiltinSqlite } from "../src/storage/driver.ts";
import { DatabaseSync } from "node:sqlite";

/**
 * #5874 snapshot-table compression foundation — Part A storage pins.
 *
 *  T1 (upgrade pin): a v11 database (today's exact DDL, user_version=11)
 *     upgrades in place: the four foundation tables + two indexes appear,
 *     the version stamps to 12, and every pre-existing row/query survives
 *     untouched. Idempotent re-open. DROP-rollback drill: dropping the new
 *     tables and restamping 11 must re-migrate cleanly (the additive
 *     contract is the whole point — no backfill, no ALTER on existing
 *     tables).
 *  T2 (commit primitive): one transaction per commit — a mid-transaction
 *     throw leaves NO half-state (no rows, no log, no ckpt, no CAS refs);
 *     log seqs stay strictly monotonic across commits AND across the
 *     checkpoint-absorption frontier (invariant ii); the ckpt fold absorbs
 *     the log up to ckpt_seq and physically cleans inactive rows that have
 *     no covering block (ruling B: block-covered rows ride the block's
 *     lifecycle; the ckpt cadence is the only bounded lifetime — no global
 *     TTL, #3752 red line); pre-form CAS refs (ruling A) are put in-tx and
 *     released exactly when the referencing rows physically die.
 *  T6 (lifecycle cascade): deleteSession removes every foundation row for
 *     the session (snap_rows/snap_log/snap_ckpt by sid, l1_world by the
 *     reverse pointer) and releases the pre-form refs — no orphans.
 *  L1 world (ruling G + the §4.0.1 envelope): fresh issue stamps
 *     issued_at; a later upsert RE-ACTS the envelope (host ids are the
 *     server canon) but the world origin issued_at NEVER moves on a plain
 *     update (the B1 trap) — it moves only with a fresh identity (a new
 *     sess_raw), which is how the caller re-issues after an explicit
 *     resync.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-snapfound-hermetic-")),
    "no-config.json",
);

function scratch(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-snapfound-"));
}

const SKIP = !probeBuiltinSqlite() ? "node:sqlite not available on this runtime (bun ships bun:sqlite)" : false;

/** The v11-shaped DDL: today's V1 DDL minus the #5874 v12 section (the
 *  foundation tables are the LAST block appended to STORAGE_DDL_V1, so
 *  splitting on the section comment recovers the exact pre-#5874 shape). */
function v11Ddl(): string {
    return STORAGE_DDL_V1_FOR_TESTS.split("-- #5874 snapshot-table compression foundation")[0].trim();
}

function rawDb(store: UnifiedStore): DatabaseSync {
    return (store as unknown as { db: DatabaseSync }).db;
}

test("T1: v11 database upgrades to v12 additively; old rows survive", { skip: SKIP }, () => {
    const dir = scratch();
    const dbPath = path.join(dir, "index.db");
    try {
        const raw = new DatabaseSync(dbPath);
        raw.exec(v11Ddl());
        raw.prepare("INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?, ?, ?)").run("sess-v11", 111, 222);
        raw.exec("PRAGMA user_version = 11");
        raw.close();

        const store = UnifiedStore.open(dbPath);
        try {
            const ver = rawDb(store).prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 12, "stamped to v12");
            // All four foundation tables + both indexes exist.
            const objs = rawDb(store)
                .prepare("SELECT name, type FROM sqlite_master WHERE name IN ('l1_world','snap_rows','snap_log','snap_ckpt','idx_l1_ledger','idx_snap_rows_cover')")
                .all() as { name: string; type: string }[];
            const byType = new Map(objs.map((o) => [o.name, o.type]));
            assert.equal(byType.get("l1_world"), "table");
            assert.equal(byType.get("snap_rows"), "table");
            assert.equal(byType.get("snap_log"), "table");
            assert.equal(byType.get("snap_ckpt"), "table");
            assert.equal(byType.get("idx_l1_ledger"), "index");
            assert.equal(byType.get("idx_snap_rows_cover"), "index");
            // Column shape (the #5874 DDL as landed).
            const l1Cols = rawDb(store).prepare("PRAGMA table_info(l1_world)").all() as { name: string }[];
            assert.deepEqual(
                l1Cols.map((c) => c.name),
                ["sess_raw", "session_id", "ledger_id", "envelope_json", "envelope_checksum", "witness_probe", "issued_at", "armed_at"],
            );
            const rowCols = rawDb(store).prepare("PRAGMA table_info(snap_rows)").all() as { name: string }[];
            assert.deepEqual(
                rowCols.map((c) => c.name),
                ["sid", "pos", "core_ids", "pre_json", "post_json", "tokens_est", "active", "cover_ref", "updated_at"],
            );
            // Pre-existing data survives untouched (the additive contract).
            const old = store.getSessionRow("sess-v11");
            assert.ok(old, "pre-existing session row survives");
            assert.equal(old!.sessionId, "sess-v11");
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("T1: fresh install and idempotent re-open land at v12 without error", { skip: SKIP }, () => {
    const dir = scratch();
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        store.close();
        const again = UnifiedStore.open(dbPath);
        try {
            const ver = rawDb(again).prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 12, "idempotent re-open stays v12");
        } finally {
            again.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("T1: DROP-rollback drill — dropping the foundation tables and restamping v11 re-migrates cleanly", { skip: SKIP }, () => {
    const dir = scratch();
    const dbPath = path.join(dir, "index.db");
    try {
        // A v12 database with live foundation rows…
        const store = UnifiedStore.open(dbPath);
        store.upsertL1World({
            sessRaw: "sess-raw-1",
            sessionId: "sess-1",
            ledgerId: "led-1",
            envelopeJson: '["a","b"]',
            envelopeChecksum: "c1",
            issuedAt: 1000,
        });
        store.commitSnapshot({
            sessionId: "sess-1",
            rows: [{ pos: 1, coreIds: '["h1"]', postJson: '{"id":"h1","role":"user","contentType":"text","text":"one"}', tokensEst: 4, active: true }],
            logEntries: [{ kind: "append", payload: '{"pos":1}', createdAt: 1000 }],
            now: 1000,
        });
        const preRows = store.getSnapRows("sess-1").length;
        assert.equal(preRows, 1, "foundation rows live before the drill");
        store.close();

        // …that an operator rolls back: drop the new objects, restamp v11.
        const raw = new DatabaseSync(dbPath);
        raw.exec("DROP INDEX idx_l1_ledger");
        raw.exec("DROP INDEX idx_snap_rows_cover");
        raw.exec("DROP TABLE l1_world");
        raw.exec("DROP TABLE snap_rows");
        raw.exec("DROP TABLE snap_log");
        raw.exec("DROP TABLE snap_ckpt");
        raw.exec("PRAGMA user_version = 11");
        raw.close();

        // The next open must re-migrate WITHOUT error (IF NOT EXISTS
        // re-lands the shape; no backfill, no ALTER on existing tables).
        const store2 = UnifiedStore.open(dbPath);
        try {
            const ver = rawDb(store2).prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 12, "re-migrated to v12");
            assert.equal(store2.getSnapRows("sess-1").length, 0, "dropped data stays dropped (additive = no backfill)");
            assert.equal(store2.getL1World("sess-raw-1"), null, "l1_world is empty after the rollback");
        } finally {
            store2.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("T2: commit primitive — one transaction, no half-state on mid-tx throw", { skip: SKIP }, () => {
    const dir = scratch();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            // Mid-transaction abort: the SECOND row's NaN pos cannot bind in
            // node:sqlite — the throw lands inside the open transaction, so
            // the FIRST row, the log entry, the ckpt and the pre-form CAS
            // ref must ALL roll back (invariant i).
            const preRef = "pre-" + "x".repeat(64);
            const refBefore = store.contentRefCountOfBody(preRef);
            assert.throws(
                () =>
                    store.commitSnapshot({
                        sessionId: "sess-t2",
                        preContents: [{ hash: "h" + "0".repeat(63) + "1", content: preRef }],
                        rows: [
                            { pos: 1, coreIds: '["h1"]', postJson: '{"id":"h1"}', tokensEst: 3, active: true },
                            { pos: Number.NaN, coreIds: "[]", postJson: "{}", tokensEst: 0, active: true },
                        ],
                        logEntries: [{ kind: "append", payload: "{}", createdAt: 5 }],
                        ckpt: { ckptSeq: 1, metaJson: "{}", checksum: "s", updatedAt: 5 },
                        now: 5,
                    }),
                /bind|NaN|NOT NULL constraint|not.*number|not.*integer/i,
            );
            assert.equal(store.getSnapRows("sess-t2").length, 0, "no row survived the aborted tx");
            assert.equal(store.snapLogMaxSeq("sess-t2"), 0, "no log entry survived");
            assert.equal(store.getSnapCkpt("sess-t2"), null, "no ckpt survived");
            assert.equal(store.contentRefCountOfBody(preRef), refBefore, "the pre-form CAS ref rolled back too");

            // Clean commits: seqs strictly monotonic (invariant ii).
            const r1 = store.commitSnapshot({
                sessionId: "sess-t2",
                rows: [{ pos: 1, coreIds: '["h1"]', postJson: '{"id":"h1"}', tokensEst: 3, active: true }],
                logEntries: [{ kind: "cast", payload: "{}", createdAt: 10 }, { kind: "append", payload: "{}", createdAt: 10 }],
                now: 10,
            });
            assert.deepEqual(r1.logSeqs, [1, 2], "first commit assigns 1,2");
            const r2 = store.commitSnapshot({
                sessionId: "sess-t2",
                rows: [{ pos: 2, coreIds: '["h2"]', postJson: '{"id":"h2"}', tokensEst: 3, active: true }],
                logEntries: [{ kind: "append", payload: "{}", createdAt: 20 }],
                now: 20,
            });
            assert.deepEqual(r2.logSeqs, [3], "second commit continues at 3");
            assert.equal(store.snapLogMaxSeq("sess-t2"), 3);
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("T2: checkpoint fold absorbs the log and cleans unanchored inactive rows (ruling B lifetime)", { skip: SKIP }, () => {
    const dir = scratch();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const preDrop = "droppable-" + "z".repeat(48);
            const preCovered = "covered-" + "y".repeat(52);
            // pos 1: will be client-dropped (inactive, NO cover_ref).
            // pos 2: will be fold-covered (inactive, cover_ref = a block).
            const r1 = store.commitSnapshot({
                sessionId: "sess-ckpt",
                preContents: [
                    { hash: "h" + "1".repeat(63), content: preDrop },
                    { hash: "h" + "2".repeat(63), content: preCovered },
                ],
                rows: [
                    { pos: 1, coreIds: '["h1"]', preJson: "h" + "1".repeat(63), postJson: '{"id":"h1"}', tokensEst: 3, active: true },
                    { pos: 2, coreIds: '["h2"]', preJson: "h" + "2".repeat(63), postJson: '{"id":"h2"}', tokensEst: 3, active: true },
                ],
                logEntries: [
                    { kind: "append", payload: "{}", createdAt: 100 },
                    { kind: "delete", payload: '{"pos":1}', createdAt: 110 },
                    { kind: "compact", payload: '{"cover":"blk-1"}', createdAt: 120 },
                ],
                now: 120,
            });
            assert.deepEqual(r1.logSeqs, [1, 2, 3]);
            assert.equal(store.contentRefCountOfBody(preDrop), 1, "pre-forms are refcounted");
            assert.equal(store.contentRefCountOfBody(preCovered), 1);

            // Deactivate both rows (the delete + the compact evidence),
            // then the ckpt fold: log seqs <= ckpt_seq are absorbed into the
            // meta triple; the inactive UNANCHORED row (pos 1) is physically
            // cleaned and its CAS ref released; the BLOCK-COVERED row (pos 2)
            // survives until its block dies (ruling B — no global TTL).
            store.commitSnapshot({
                sessionId: "sess-ckpt",
                rows: [
                    { pos: 1, coreIds: '["h1"]', preJson: "h" + "1".repeat(63), postJson: '{"id":"h1"}', tokensEst: 3, active: false },
                    { pos: 2, coreIds: '["h2"]', preJson: "h" + "2".repeat(63), postJson: '{"id":"h2"}', tokensEst: 3, active: false, coverRef: "blk-1" },
                ],
                logEntries: [],
                ckpt: { ckptSeq: 3, metaJson: '{"v":1}', checksum: "s4", updatedAt: 200 },
                now: 200,
            });
            assert.equal(store.getSnapCkpt("sess-ckpt")!.ckptSeq, 3);
            assert.equal(store.snapLogMaxSeq("sess-ckpt"), 3, "absorbed log is gone; the frontier holds");
            const all = store.getSnapRows("sess-ckpt", { includeInactive: true });
            assert.equal(all.length, 1, "only the block-covered row remains");
            assert.equal(all[0]!.pos, 2, "pos 2 rides the block lifecycle");
            assert.equal(all[0]!.coverRef, "blk-1");
            assert.equal(store.contentRefCountOfBody(preDrop), 0, "unanchored row's pre ref released");
            assert.equal(store.contentRefCountOfBody(preCovered), 1, "covered row keeps its pre ref");
            // The seq frontier continues past the ckpt (invariant ii).
            const r3 = store.commitSnapshot({
                sessionId: "sess-ckpt",
                rows: [],
                logEntries: [{ kind: "append", payload: "{}", createdAt: 300 }],
                now: 300,
            });
            assert.deepEqual(r3.logSeqs, [4], "next seq = ckpt frontier + 1");
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("T2: sweepSnapRowsByDeadCovers releases the pre refs of physically-deleted rows", { skip: SKIP }, () => {
    const dir = scratch();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const preA = "sweep-a-" + "a".repeat(44);
            const preB = "sweep-b-" + "b".repeat(44);
            store.commitSnapshot({
                sessionId: "sess-sweep",
                preContents: [
                    { hash: "h" + "3".repeat(63), content: preA },
                    { hash: "h" + "4".repeat(63), content: preB },
                ],
                rows: [
                    { pos: 1, coreIds: "[]", preJson: "h" + "3".repeat(63), postJson: "{}", tokensEst: 1, active: false, coverRef: "blk-dead" },
                    { pos: 2, coreIds: "[]", preJson: "h" + "4".repeat(63), postJson: "{}", tokensEst: 1, active: false, coverRef: "blk-alive" },
                ],
                logEntries: [],
                now: 1,
            });
            const swept = store.sweepSnapRowsByDeadCovers("sess-sweep", ["blk-dead", "blk-missing"]);
            assert.equal(swept, 1, "only the row whose cover died is swept");
            assert.equal(store.contentRefCountOfBody(preA), 0, "dead-cover row's pre ref released");
            assert.equal(store.contentRefCountOfBody(preB), 1, "alive-cover row untouched");
            assert.equal(store.getSnapRows("sess-sweep", { includeInactive: true }).length, 1);
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("L1 world: envelope re-acts on update, world origin never moves (B1 trap)", { skip: SKIP }, () => {
    const dir = scratch();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            store.upsertL1World({
                sessRaw: "sess-raw-1",
                sessionId: "sess-1",
                ledgerId: "led-1",
                envelopeJson: '["h1","h2"]',
                envelopeChecksum: "e1",
                witnessProbe: "probe-1",
                issuedAt: 1000,
                armedAt: 1500,
            });
            let row = store.getL1World("sess-raw-1");
            assert.ok(row);
            assert.equal(row!.sessionId, "sess-1");
            assert.equal(row!.envelopeJson, '["h1","h2"]');
            assert.equal(row!.envelopeChecksum, "e1");
            assert.equal(row!.issuedAt, 1000);
            assert.equal(row!.armedAt, 1500);

            // The tail extended: the ENVELOPE re-acts (it is the server
            // canon), but the world origin (issued_at) must NOT move — the
            // B1 trap that would otherwise let a restart reset the arming
            // frontier.
            store.upsertL1World({
                sessRaw: "sess-raw-1",
                sessionId: "sess-1",
                ledgerId: "led-1",
                envelopeJson: '["h1","h2","h3"]',
                envelopeChecksum: "e2",
                witnessProbe: "probe-2",
                issuedAt: 999999,
                armedAt: null,
            });
            row = store.getL1World("sess-raw-1");
            assert.equal(row!.envelopeJson, '["h1","h2","h3"]', "envelope extended");
            assert.equal(row!.envelopeChecksum, "e2");
            assert.equal(row!.issuedAt, 1000, "world origin never moves on a plain update");
            assert.equal(row!.armedAt, 1500, "armed_at survives a null update (COALESCE)");

            // A FRESH identity (new sess_raw) is a new world: the origin is
            // this issue's — the only legal way the frontier moves.
            store.upsertL1World({
                sessRaw: "sess-raw-2",
                sessionId: "sess-2",
                ledgerId: "led-2",
                envelopeJson: '["g1"]',
                envelopeChecksum: "g1",
                issuedAt: 2000,
            });
            assert.equal(store.getL1World("sess-raw-2")!.issuedAt, 2000);
            const byLedger = store.listL1WorldByLedger("led-2");
            assert.equal(byLedger.length, 1);
            assert.equal(byLedger[0]!.sessRaw, "sess-raw-2");
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("T6: deleteSession cascades the whole foundation (no orphans) and releases pre refs", { skip: SKIP }, () => {
    const dir = scratch();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const pre = "cascade-" + "q".repeat(48);
            store.upsertL1World({
                sessRaw: "sess-raw-del",
                sessionId: "sess-del",
                ledgerId: "led-del",
                envelopeJson: '["h1"]',
                envelopeChecksum: "c",
                issuedAt: 1,
            });
            store.commitSnapshot({
                sessionId: "sess-del",
                preContents: [{ hash: "h" + "9".repeat(63), content: pre }],
                rows: [
                    { pos: 1, coreIds: '["h1"]', preJson: "h" + "9".repeat(63), postJson: '{"id":"h1"}', tokensEst: 3, active: true },
                    { pos: 2, coreIds: '["h2"]', postJson: '{"id":"h2"}', tokensEst: 3, active: false, coverRef: "blk-1" },
                ],
                logEntries: [{ kind: "cast", payload: "{}", createdAt: 1 }],
                ckpt: { ckptSeq: 1, metaJson: "{}", checksum: "s", updatedAt: 1 },
                now: 1,
            });
            assert.equal(store.contentRefCountOfBody(pre), 1, "pre ref live before delete");

            store.deleteSession("sess-del");

            assert.equal(store.getSnapRows("sess-del", { includeInactive: true }).length, 0, "snap_rows cascaded");
            assert.equal(store.snapLogMaxSeq("sess-del"), 0, "snap_log cascaded");
            assert.equal(store.getSnapCkpt("sess-del"), null, "snap_ckpt cascaded");
            assert.equal(store.getL1World("sess-raw-del"), null, "l1_world cascaded via the reverse pointer");
            assert.equal(store.contentRefCountOfBody(pre), 0, "pre-form CAS ref released");
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

test("CAS refs: put/get/release discipline + missing body → null (T8 diagnostic exit)", { skip: SKIP }, () => {
    const dir = scratch();
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const hash = store.putContentRef("the pre-form body", "h" + "a".repeat(63));
            assert.equal(hash, "h" + "a".repeat(63), "putContentRef honors the precomputed hash");
            assert.equal(store.getContentRef(hash), "the pre-form body", "round-trip");
            assert.equal(store.getContentRef("h" + "f".repeat(63)), null, "missing body → null (NEVER a silent empty)");
            // Two puts of the same body: the CAS is content-addressed — the
            // second put is a refcount bump, not a duplicate row.
            store.putContentRef("the pre-form body", "h" + "a".repeat(63));
            assert.equal(store.contentRefCountOfBody("the pre-form body"), 2);
            store.releaseContentRef(hash);
            assert.equal(store.contentRefCountOfBody("the pre-form body"), 1);
            store.releaseContentRef(null); // no-op
            assert.equal(store.contentRefCountOfBody("the pre-form body"), 1, "null release is a no-op");
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});
