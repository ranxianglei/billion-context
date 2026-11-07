/**
 * #5874 (P0): snapshot-table compression foundation — schema + commit
 * primitive + red doors, zero behavior change.
 *
 * Pins the P0 acceptance tests from the proposal:
 *  T1 — the v12 upgrade is PURELY ADDITIVE: a v11 database opened by the
 *       new code gets the four tables (l1_world/snap_rows/snap_log/
 *       snap_ckpt) and user_version 12, with every pre-existing table
 *       byte-identical; rollback (DROP the four + user_version 11) leaves
 *       the legacy dump byte-identical to the pre-upgrade one.
 *  T2 — the commit primitive is atomic: a batch with one invalid event
 *       leaves NO half-state (rows + log exactly as before); seq is
 *       strictly monotonic across folds (invariant ii); S4 mismatch on
 *       read kills the plane for the sid (R1, sticky); delete/compact
 *       never physically delete (invariant iv); post_json must be
 *       canonical core shape (invariant v).
 *  T6 — deleteSession cascades the four plane tables (no orphans).
 *  Plus: the two-level flag nesting (master ⊃ lane) as resolved by the
 *       store and by the config-file knob.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { STORAGE_SCHEMA_VERSION, migrateSchema } from "../src/storage/schema.ts";
import { UnifiedStore, sha256Hex } from "../src/storage/store.ts";
import {
    applySnapCommit,
    readSnapView,
    snapL1Record,
    _resetSnapPlaneDeadForTests,
    SnapPlaneDeadError,
    type SnapEvent,
} from "../src/storage/snap.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";

process.env.BILI_PERSIST_ZSTD = "0";
// Hermeticity pin (same discipline as the other storage suites): a
// developer machine with storage settings in its real config must not
// leak into these tests.
const hermetic = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5874-hermetic-"));
process.env.BILI_CONFIG_FILE = path.join(hermetic, "no-config.json");

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rawDb(path: string) {
    return openSqliteDatabase(path).db;
}

/** Legacy dump of every PRE-#5874 table, byte-stable for one content:
 *  every row of every table, ordered, one sha256 over the whole thing.
 *  The upgrade and the rollback must both preserve it exactly. */
const LEGACY_TABLES = [
    "sessions",
    "content",
    "messages",
    "blocks",
    "dead_refs",
    "refs",
    "checkpoints",
    "ccr_entries",
    "conversations",
    "session_ext",
    "message_media",
] as const;

function legacyDumpHash(db: ReturnType<typeof openSqliteDatabase>["db"]): string {
    const parts: string[] = [];
    for (const t of LEGACY_TABLES) {
        const rows = db.prepare(`SELECT * FROM ${t}`).all() as unknown[];
        rows.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
        parts.push(`${t}:${sha256Hex(JSON.stringify(rows))}`);
    }
    return sha256Hex(parts.join("\u0000"));
}

function tableCount(db: ReturnType<typeof openSqliteDatabase>["db"], table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function hasTable(db: ReturnType<typeof openSqliteDatabase>["db"], table: string): boolean {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
        | { name: string }
        | undefined;
    return !!row;
}

/** A minimal single-message legacy session (enough for T1/T6 to carry
 *  real rows through the ingest path). */
function oneMsgSession(id: string, text: string): LegacySessionLike {
    return {
        id,
        createdAt: 1_000,
        lastSeen: 2_000,
        meta: { protocol: "openai" },
        stats: { requests: 1 },
        metadata: {},
        state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(),
        lastMessages: [{ id: "m1", role: "user", contentType: "text", text }],
        lastMessagesFolded: true,
        pluginSnapshot: undefined,
        contentStore: undefined,
    };
}

// ---------------------------------------------------------------------------
// T1 — upgrade is additive; rollback is byte-reversible.
// ---------------------------------------------------------------------------

test("#5874 T1: v11 → v12 upgrade is purely additive (legacy tables byte-identical)", () => {
    const dir = tmpDir("bili-5874-t1-");
    try {
        const p = path.join(dir, "index.db");
        // 1. Build a database the NEW code considers v11: create it, seed
        //    real legacy rows, then drop the four plane tables and rewind
        //    the stamp to 11 (exactly the pre-upgrade on-disk state).
        {
            const s1 = UnifiedStore.open(p);
            s1.ingestSession(planIngest(oneMsgSession("sess-t1", "hello t1")));
            s1.close();
        }
        {
            const db = rawDb(p);
            db.exec("DROP TABLE IF EXISTS l1_world");
            db.exec("DROP TABLE IF EXISTS snap_rows");
            db.exec("DROP TABLE IF EXISTS snap_log");
            db.exec("DROP TABLE IF EXISTS snap_ckpt");
            db.exec("DROP INDEX IF EXISTS idx_l1_ledger");
            db.exec("PRAGMA user_version = 11");
            db.close();
        }
        // 2. Reopen with the new code: the migration must bring the four
        //    tables and the stamp — and change NOTHING else.
        const before = (() => {
            const db = rawDb(p);
            const h = legacyDumpHash(db);
            db.close();
            return h;
        })();
        const store = UnifiedStore.open(p);
        {
            const st = rawDb(p);
            assert.equal((st.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 12);
            for (const t of ["l1_world", "snap_rows", "snap_log", "snap_ckpt"]) assert.ok(hasTable(st, t), `missing table ${t}`);
            st.close();
        }
        const after = (() => {
            const db = rawDb(p);
            const h = legacyDumpHash(db);
            db.close();
            return h;
        })();
        assert.equal(after, before, "legacy tables must be byte-identical across the upgrade");
        {
            const db = rawDb(p);
            for (const t of ["snap_rows", "snap_log", "snap_ckpt"]) {
                assert.equal(tableCount(db, t), 0, `plane table ${t} must start empty`);
            }
            db.close();
        }
        store.close();
        // 3. Rollback: drop the four tables + rewind the stamp. The legacy
        //    dump must come back byte-identical.
        {
            const db = rawDb(p);
            db.exec("DROP TABLE IF EXISTS l1_world");
            db.exec("DROP TABLE IF EXISTS snap_rows");
            db.exec("DROP TABLE IF EXISTS snap_log");
            db.exec("DROP TABLE IF EXISTS snap_ckpt");
            db.exec("DROP INDEX IF EXISTS idx_l1_ledger");
            db.exec("PRAGMA user_version = 11");
            db.close();
        }
        const rolled = (() => {
            const db = rawDb(p);
            const h = legacyDumpHash(db);
            db.close();
            return h;
        })();
        assert.equal(rolled, before, "rollback must restore the pre-upgrade legacy dump exactly");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("#5874 T1b: a fresh install lands at v12 with the four tables", () => {
    const dir = tmpDir("bili-5874-t1b-");
    try {
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const db = rawDb(path.join(dir, "index.db"));
            assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, STORAGE_SCHEMA_VERSION);
            assert.equal(STORAGE_SCHEMA_VERSION, 12);
            for (const t of ["l1_world", "snap_rows", "snap_log", "snap_ckpt"]) assert.ok(hasTable(db, t));
            db.close();
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// T2 — commit primitive: atomicity, seq monotonicity, red doors.
// ---------------------------------------------------------------------------

function postJson(text: string): string {
    return JSON.stringify({ role: "user", content: text });
}

test("#5874 T2: the commit primitive is atomic (invalid event ⇒ no half-state)", () => {
    const dir = tmpDir("bili-5874-t2-");
    try {
        const p = path.join(dir, "index.db");
        const db = rawDb(p);
        db.exec("PRAGMA foreign_keys = ON");
        migrateSchema(db);
        // A valid first commit: two positions.
        const ev1: SnapEvent[] = [
            { ev: "append", pos: 1, coreIds: ["m1"], preJson: null, postJson: postJson("a"), tokensEst: 3 },
            { ev: "append", pos: 2, coreIds: ["m2"], preJson: null, postJson: postJson("b"), tokensEst: 3 },
        ];
        const out1 = applySnapCommit(db, "s1", ev1);
        assert.equal(tableCount(db, "snap_rows"), 2);
        assert.equal(tableCount(db, "snap_log"), 2);
        assert.equal(out1.tailSeq, 2);
        // A batch with a good event followed by an invalid one (invariant v:
        // post_json must be canonical core shape — this is wire bytes).
        const bad: SnapEvent[] = [
            { ev: "append", pos: 3, coreIds: ["m3"], preJson: null, postJson: postJson("c"), tokensEst: 3 },
            { ev: "append", pos: 4, coreIds: ["m4"], preJson: null, postJson: "<wire-bytes>", tokensEst: 3 },
        ];
        assert.throws(() => applySnapCommit(db, "s1", bad), /not canonical core shape/);
        assert.equal(tableCount(db, "snap_rows"), 2, "the good event in a failed batch must not land");
        assert.equal(tableCount(db, "snap_log"), 2, "the log must have no partial entry");
        // A structurally bad batch (duplicate pos) rolls back too.
        const dup: SnapEvent[] = [
            { ev: "append", pos: 1, coreIds: ["x"], preJson: null, postJson: postJson("x"), tokensEst: 1 },
            { ev: "append", pos: 1, coreIds: ["y"], preJson: null, postJson: postJson("y"), tokensEst: 1 },
        ];
        assert.throws(() => applySnapCommit(db, "s1", dup), /duplicate pos/);
        assert.equal(tableCount(db, "snap_rows"), 2);
        assert.equal(tableCount(db, "snap_log"), 2);
        // An update that cannot be addressed is a throw too (R2).
        assert.throws(
            () => applySnapCommit(db, "s1", [{ ev: "update", pos: 99, postJson: postJson("z") }]),
            /no row to update \(R2\)/,
        );
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("#5874 T2b: seq is strictly monotonic across folds (invariant ii)", () => {
    const dir = tmpDir("bili-5874-t2b-");
    try {
        const p = path.join(dir, "index.db");
        const db = rawDb(p);
        migrateSchema(db);
        const c1 = applySnapCommit(db, "s1", [
            { ev: "append", pos: 1, coreIds: ["m1"], preJson: null, postJson: postJson("a"), tokensEst: 1 },
        ], { fold: true });
        assert.equal(c1.folded, true);
        assert.equal(c1.tailSeq, 1);
        // After the fold the log is truncated; the next seq must still be
        // strictly greater than the ckpt_seq.
        assert.equal(tableCount(db, "snap_log"), 0, "the fold truncates the log up to the ckpt");
        const c2 = applySnapCommit(db, "s1", [
            { ev: "append", pos: 2, coreIds: ["m2"], preJson: null, postJson: postJson("b"), tokensEst: 1 },
            { ev: "append", pos: 3, coreIds: ["m3"], preJson: null, postJson: postJson("c"), tokensEst: 1 },
        ]);
        assert.equal(c2.tailSeq, 3, "seq continues past the ckpt_seq");
        const view = readSnapView(db, "s1");
        assert.ok(view);
        assert.equal(view.ckptSeq, 1);
        assert.equal(view.tailSeq, 3);
        assert.ok(view.verified, "the folded view verifies against the log tail anchor");
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("#5874 T2c: S4 mismatch kills the plane for the sid (R1, sticky)", () => {
    _resetSnapPlaneDeadForTests();
    const dir = tmpDir("bili-5874-t2c-");
    try {
        const p = path.join(dir, "index.db");
        const db = rawDb(p);
        migrateSchema(db);
        applySnapCommit(db, "s1", [
            { ev: "append", pos: 1, coreIds: ["m1"], preJson: null, postJson: postJson("a"), tokensEst: 1 },
        ]);
        // Tamper with a stored row: the recomputed aggregate can no longer
        // match the log anchor.
        db.prepare("UPDATE snap_rows SET post_json = ? WHERE sid = ? AND pos = 1").run(
            JSON.stringify({ role: "user", content: "TAMPERED" }),
            "s1",
        );
        assert.throws(() => readSnapView(db, "s1"), (e: unknown) => e instanceof SnapPlaneDeadError);
        // Sticky: a subsequent read fails fast even after the row is
        // "repaired" — the plane stays closed for the process lifetime.
        db.prepare("UPDATE snap_rows SET post_json = ? WHERE sid = ? AND pos = 1").run(postJson("a"), "s1");
        assert.throws(() => readSnapView(db, "s1"), (e: unknown) => e instanceof SnapPlaneDeadError);
        // A different sid is unaffected.
        applySnapCommit(db, "s2", [
            { ev: "append", pos: 1, coreIds: ["m1"], preJson: null, postJson: postJson("a"), tokensEst: 1 },
        ]);
        assert.ok(readSnapView(db, "s2"), "R1 is per-sid, never global");
        db.close();
    } finally {
        _resetSnapPlaneDeadForTests();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("#5874 T2d: delete/compact flip active, never physically delete (invariant iv)", () => {
    const dir = tmpDir("bili-5874-t2d-");
    try {
        const p = path.join(dir, "index.db");
        const db = rawDb(p);
        migrateSchema(db);
        applySnapCommit(db, "s1", [
            { ev: "append", pos: 1, coreIds: ["m1"], preJson: null, postJson: postJson("a"), tokensEst: 1 },
            { ev: "append", pos: 2, coreIds: ["m2"], preJson: null, postJson: postJson("b"), tokensEst: 1 },
            { ev: "append", pos: 3, coreIds: ["m3"], preJson: null, postJson: postJson("c"), tokensEst: 1 },
        ]);
        applySnapCommit(db, "s1", [
            { ev: "delete", pos: 1 },
            { ev: "compact", blockId: "blk-1", posRange: [2, 3] },
        ]);
        assert.equal(tableCount(db, "snap_rows"), 3, "all three rows survive (both forms retained)");
        const rows = db.prepare("SELECT pos, active, cover_ref FROM snap_rows WHERE sid = ? ORDER BY pos").all("s1") as {
            pos: number;
            active: number;
            cover_ref: string | null;
        }[];
        assert.deepEqual(
            rows.map((r) => [r.pos, r.active, r.cover_ref]),
            [
                [1, 0, "deleted"],
                [2, 0, "blk-1"],
                [3, 0, "blk-1"],
            ],
        );
        // pre/post both survive the flip:
        const r1 = db.prepare("SELECT pre_json, post_json FROM snap_rows WHERE sid = ? AND pos = 1").get("s1") as {
            pre_json: string | null;
            post_json: string | null;
        };
        assert.equal(r1.pre_json, null);
        assert.equal(r1.post_json, postJson("a"));
        db.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// T6 — deleteSession cascades the four plane tables (no orphans).
// ---------------------------------------------------------------------------

test("#5874 T6: deleteSession cascades the plane tables", () => {
    const dir = tmpDir("bili-5874-t6-");
    try {
        const p = path.join(dir, "index.db");
        const store = UnifiedStore.open(p);
        try {
            store.ingestSession(planIngest(oneMsgSession("sess-t6", "hello t6")));
            const db = rawDb(p);
            // Populate the plane for this sid the same way the shadow
            // write hook does (outside the store's own transaction).
            applySnapCommit(db, "sess-t6", [
                { ev: "append", pos: 1, coreIds: ["m1"], preJson: null, postJson: postJson("hello t6"), tokensEst: 2 },
            ]);
            // L1 entry under the session's ledger id.
            snapL1Record(db, "sess-t6", "sess-t6", "probe", Date.now());
            assert.equal(tableCount(db, "snap_rows"), 1);
            assert.equal(tableCount(db, "snap_log"), 1);
            assert.equal(tableCount(db, "l1_world"), 1);
            db.close();
            store.deleteSession("sess-t6");
            const db2 = rawDb(p);
            assert.equal(tableCount(db2, "snap_rows"), 0);
            assert.equal(tableCount(db2, "snap_log"), 0);
            assert.equal(tableCount(db2, "snap_ckpt"), 0);
            assert.equal(tableCount(db2, "l1_world"), 0);
            db2.close();
        } finally {
            store.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Flags — the two-level nesting (master ⊃ lane).
// ---------------------------------------------------------------------------

test("#5874 flags: master ⊃ lane, resolved at the store", () => {
    const dir = tmpDir("bili-5874-flags-");
    const stores: UnifiedStore[] = [];
    try {
        const mk = (p: string, snapBase: { enabled?: boolean; shadowWrite?: boolean } | undefined) => {
            const s = UnifiedStore.open(p, undefined, { snapBase });
            stores.push(s);
            return s["snapPlane"] as { enabled: boolean; shadowWrite: boolean };
        };
        assert.deepEqual(mk(path.join(dir, "a.db"), { enabled: true, shadowWrite: true }), {
            enabled: true,
            shadowWrite: true,
        });
        assert.deepEqual(mk(path.join(dir, "b.db"), { enabled: true, shadowWrite: false }), {
            enabled: true,
            shadowWrite: false,
        });
        // Lane without master: the plane must NOT turn on by itself.
        assert.deepEqual(mk(path.join(dir, "c.db"), { enabled: false, shadowWrite: true }), {
            enabled: false,
            shadowWrite: false,
        });
        assert.deepEqual(mk(path.join(dir, "d.db"), { enabled: true }), { enabled: true, shadowWrite: false });
        assert.deepEqual(mk(path.join(dir, "e.db"), undefined), { enabled: false, shadowWrite: false });
    } finally {
        // Close before rmSync: Windows refuses to unlink open sqlite files (EBUSY).
        for (const s of stores) s.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("#5874 flags: the config-file knob (fileSnapBase) enforces the same nesting", async () => {
    const { fileSnapBase } = await import("../src/knobs.ts");
    const cfg = path.join(hermetic, "snapbase-config.json");
    const prev = process.env.BILI_CONFIG_FILE;
    try {
        fs.writeFileSync(cfg, JSON.stringify({ storage: { snapBase: { enabled: true, shadowWrite: true } } }));
        process.env.BILI_CONFIG_FILE = cfg;
        assert.deepEqual(fileSnapBase(), { enabled: true, shadowWrite: true });
        fs.writeFileSync(cfg, JSON.stringify({ storage: { snapBase: { enabled: false, shadowWrite: true } } }));
        assert.deepEqual(fileSnapBase(), { enabled: false, shadowWrite: false }, "lane alone must not arm the plane");
        fs.writeFileSync(cfg, JSON.stringify({ storage: { snapBase: { enabled: true } } }));
        assert.deepEqual(fileSnapBase(), { enabled: true, shadowWrite: false });
        fs.writeFileSync(cfg, JSON.stringify({}));
        assert.equal(fileSnapBase(), undefined, "absent section ⇒ undefined (defaults apply)");
    } finally {
        process.env.BILI_CONFIG_FILE = prev;
    }
});
