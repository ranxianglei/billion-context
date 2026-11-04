import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";

/**
 * #4796 — zero-ref CAS collection: schema v9 index + batched gc sweep.
 *
 * Field report: 658K orphan content rows (14.4 GB, refcount <= 0) accumulated
 * because gc()'s single uncommitted `DELETE FROM content WHERE refcount <= 0`
 * never completes on a bloated store — no index (full scan), one giant
 * uncommitted tx (progress invisible to every connection, WAL frames can't
 * checkpoint, write lock held for hours). Fix: v9 adds idx_content_refcount
 * and gc collects in small autocommit batches that commit + checkpoint
 * independently, so a crashed run resumes where it died. The dominant orphan
 * producer is the v8 identity backfill dropping duplicate (msg_id, identity)
 * rows: its raw decRef may drive a CAS row to 0 and relies on the next gc run
 * to collect it — which is exactly what used to never happen.
 */

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_CONFIG_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-gc-")),
    "no-config.json",
);

interface CoreMsg { id: string; role: string; contentType: string; text: string }
const mkMsg = (id: string, text: string): CoreMsg => ({ id, role: "user", contentType: "text", text });

const mkSession = (id: string, msgs: CoreMsg[], lastSeen = 2_000): LegacySessionLike => ({
    id,
    createdAt: 1_000,
    lastSeen,
    meta: { protocol: "openai" },
    stats: {},
    metadata: { label: `label-${id}` },
    state: { blocks: [], nextBlockId: 1, nextRunId: 1, messageRefs: { byRaw: {}, byRef: {} } },
    blockContents: new Map(),
    lastMessages: msgs as unknown as LegacySessionLike["lastMessages"],
    lastMessagesFolded: false,
    pluginSnapshot: undefined,
    contentStore: undefined,
} as unknown as LegacySessionLike);

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

function rawDb(store: UnifiedStore): DatabaseSync {
    return (store as unknown as { db: DatabaseSync }).db;
}

function rmDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* Windows stray handles */ }
}

/** Unreferenced content rows at the given refcount — refcount 0 is the exact
 *  shape of the residue the v8 backfill leaves behind. bigAt names indices to
 *  bloat to 5 MiB each (the field orphans averaged ~22 KB; multi-MB blobs are
 *  what made the old single-tx sweep's WAL uncheckpointable). */
function seedContentRows(db: DatabaseSync, n: number, refcount: number, tag: string, bigAt: number[] = []): void {
    const ins = db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, ?, 'sha256', ?)");
    const big = new Set(bigAt);
    for (let i = 0; i < n; i++) {
        const body = big.has(i) ? `${tag}-${i}-${"x".repeat(5 * 1024 * 1024)}` : `${tag}-${i}-${Math.random().toString(36).slice(2)}`;
        ins.run(sha256Hex(body), Buffer.byteLength(body, "utf8"), refcount, body);
    }
}

test("#4796 v9: fresh install carries idx_content_refcount and candidate selection uses it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-fresh-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            // Rare orphans among many live rows: the index range scan must win
            // over a full table scan in the query plan.
            seedContentRows(rawDb(store), 20_000, 1, "live");
            seedContentRows(rawDb(store), 50, 0, "orphan");
            const ver = rawDb(store).prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 10);
            const idx = rawDb(store)
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_content_refcount'")
                .get();
            assert.ok(idx, "idx_content_refcount present on fresh install");
            const plan = rawDb(store)
                .prepare("EXPLAIN QUERY PLAN SELECT hash FROM content WHERE refcount <= 0 LIMIT 10")
                .all() as Array<{ detail?: unknown }>;
            assert.ok(
                plan.some((r) => String(r.detail ?? "").includes("idx_content_refcount")),
                `candidate query must use the index, got: ${JSON.stringify(plan)}`,
            );
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#4796 v9: reopening a v8-era db gains the index", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-upgrade-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const first = UnifiedStore.open(dbPath);
        first.close();
        // Simulate a v8-era db: everything except the v9 index.
        const raw = new DatabaseSync(dbPath);
        raw.exec("DROP INDEX idx_content_refcount");
        raw.exec("PRAGMA user_version = 8");
        raw.close();
        const store = UnifiedStore.open(dbPath);
        try {
            const ver = rawDb(store).prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 10);
            const idx = rawDb(store)
                .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_content_refcount'")
                .get();
            assert.ok(idx, "idx_content_refcount recreated on the v8 -> v9 migration");
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#4796 gc: batched sweep collects more than one batch size (multi-MB blobs included)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-batch-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            store.ingestSession(planIngest(mkSession("sess-live", [mkMsg("m1", "hello-live-alpha"), mkMsg("m2", "hello-live-beta")])));
            // 2100 orphans = 1 full batch of 2000 + a partial second one; three
            // of them are 5 MiB each to exercise the between-batch checkpoints.
            seedContentRows(rawDb(store), 2100, 0, "orphan", [0, 1000, 2099]);
            const res = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "arch"), now: 9_000_000_000_000 });
            assert.equal(res.archived, 0);
            assert.equal(res.contentRowsDeleted, 2100);
            assert.equal(store.contentZeroRefReport().rows, 0);
            assert.equal(store.contentRefCountOfBody("hello-live-alpha"), 1, "live content untouched");
            assert.equal(store.contentRefCountOfBody("hello-live-beta"), 1, "live content untouched");
            assert.deepEqual(rawDb(store).prepare("PRAGMA foreign_key_check").all(), [], "no dangling references");
            const walSize = fs.statSync(`${dbPath}-wal`).size;
            assert.ok(walSize <= 8 * 1024 * 1024, `WAL stayed bounded after the batched sweep (${walSize} bytes)`);
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#4796 gc: an exact multiple of the batch size is fully collected", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-exact-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            seedContentRows(rawDb(store), 4000, 0, "orphan");
            const res = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "arch"), now: 9_000_000_000_000 });
            assert.equal(res.contentRowsDeleted, 4000);
            assert.equal(store.contentZeroRefReport().rows, 0);
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#4796 gc: sweep converges when a prior run died mid-sweep", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-resume-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            seedContentRows(rawDb(store), 3000, 0, "orphan");
            // Simulate a previous gc process that committed half its batches
            // and then died: those rows are simply gone.
            const done = rawDb(store)
                .prepare("SELECT hash FROM content WHERE refcount <= 0 ORDER BY hash LIMIT 1500")
                .all() as Array<{ hash: string }>;
            const ph = done.map(() => "?").join(", ");
            rawDb(store).prepare(`DELETE FROM content WHERE hash IN (${ph})`).run(...done.map((r) => r.hash));
            const res = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "arch"), now: 9_000_000_000_000 });
            assert.equal(res.contentRowsDeleted, 1500, "only the survivors remain to collect");
            assert.equal(store.contentZeroRefReport().rows, 0);
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#4796 e2e: v8 identity backfill releases wireIndex twins -> gc collects them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-backfill-"));
    const dbPath = path.join(dir, "index.db");
    const sessId = "sess-old";
    let twinSeq = 0;
    let twinHash = "";
    let keeperHash = "";
    try {
        const store = UnifiedStore.open(dbPath);
        store.ingestSession(planIngest(mkSession(sessId, [mkMsg("m-dup", "hello there")])));
        const db = rawDb(store);
        const row = db
            .prepare("SELECT seq, msg_id, content_hash FROM messages WHERE session_id = ? AND msg_id = 'm-dup'")
            .get(sessId) as { seq: number; msg_id: string; content_hash: string };
        keeperHash = row.content_hash;
        // Synthetic twin: identical stored-bytes serialization except
        // wireIndex — same stripped identity, different CAS hash. This is the
        // exact duplicate shape the polluted formula minted (#4390).
        const keptRow = db.prepare("SELECT bytes FROM content WHERE hash = ?").get(keeperHash) as { bytes: string | Uint8Array };
        const keptStr = typeof keptRow.bytes === "string" ? keptRow.bytes : Buffer.from(keptRow.bytes).toString("utf8");
        const twinObj = JSON.parse(keptStr) as Record<string, unknown>;
        twinObj.wireIndex = (typeof twinObj.wireIndex === "number" ? twinObj.wireIndex : 0) + 7;
        const twinStr = JSON.stringify(twinObj);
        twinHash = sha256Hex(twinStr);
        assert.notEqual(twinHash, keeperHash, "twin must be a distinct CAS row");
        db.prepare("INSERT INTO content (hash, byte_len, refcount, algo, bytes) VALUES (?, ?, 1, 'sha256', ?)")
            .run(twinHash, Buffer.byteLength(twinStr, "utf8"), twinStr);
        twinSeq = row.seq + 1;
        db.prepare(
            "INSERT INTO messages (session_id, seq, msg_id, ref, ref_num, role, kind, content_hash, identity, retired_at) " +
                "VALUES (?, ?, ?, NULL, NULL, 'user', 'message', ?, '', NULL)",
        ).run(sessId, twinSeq, row.msg_id, twinHash);
        // Present the whole session as pre-v8 (empty identities) and stamp the
        // pre-v8 version so the next open re-runs the v8 block + backfill.
        db.exec(`UPDATE messages SET identity = '' WHERE session_id = '${sessId}'`);
        db.exec("PRAGMA user_version = 7");
        store.close();

        const reopened = UnifiedStore.open(dbPath);
        try {
            const db2 = rawDb(reopened);
            const ver = db2.prepare("PRAGMA user_version").get() as { user_version: number };
            assert.equal(ver.user_version, 10);
            const twinLeft = db2
                .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND seq = ?")
                .get(sessId, twinSeq) as { n: number };
            assert.equal(twinLeft.n, 0, "backfill dropped the later duplicate message row");
            const keeper = db2
                .prepare("SELECT identity FROM messages WHERE session_id = ? AND seq = ?")
                .get(sessId, row.seq) as { identity: string };
            assert.ok(keeper.identity.length > 0, "keeper row got its backfilled identity");
            assert.ok(reopened.contentZeroRefReport().rows >= 1, "the released twin content row is zero-ref residue");
            const res = reopened.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "arch"), now: 9_000_000_000_000 });
            assert.ok(res.contentRowsDeleted >= 1);
            assert.equal(
                (db2.prepare("SELECT COUNT(*) AS n FROM content WHERE hash = ?").get(twinHash) as { n: number }).n,
                0,
                "gc collected the released twin",
            );
            assert.equal(
                (db2.prepare("SELECT COUNT(*) AS n FROM content WHERE hash = ?").get(keeperHash) as { n: number }).n,
                1,
                "keeper content survives",
            );
            assert.deepEqual(db2.prepare("PRAGMA foreign_key_check").all(), [], "no dangling references");
        } finally {
            reopened.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#4796 follow-up: lifecycle ops collect only within their own released hashes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-scope-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            store.ingestSession(planIngest(mkSession("sess-a", [mkMsg("a1", "alpha-body-one"), mkMsg("a2", "alpha-body-two")])));
            store.ingestSession(planIngest(mkSession("sess-b", [mkMsg("b1", "beta-body-one")])));
            // Pre-existing orphans from OTHER sources: the old whole-table
            // sweep inside these ops wiped them incidentally — that is the
            // unbounded pathology this pins closed.
            seedContentRows(rawDb(store), 3, 0, "preexisting");
            const preCount = (): number =>
                (rawDb(store).prepare("SELECT COUNT(*) AS n FROM content WHERE CAST(bytes AS TEXT) LIKE 'preexisting-%'").get() as { n: number }).n;
            assert.equal(preCount(), 3);

            store.deleteSession("sess-a");
            assert.equal(store.contentRefCountOfBody("alpha-body-one"), 0, "sess-a content released");
            assert.equal(store.contentRefCountOfBody("alpha-body-two"), 0, "sess-a content released");
            assert.equal(preCount(), 3, "pre-existing orphans survive deleteSession");

            const res = store.gc({ archiveAfterDays: 0, archiveDir: path.join(dir, "arch"), now: 9_000_000_000_000 });
            assert.equal(res.contentRowsDeleted, 3, "gc remains the collector of record for other orphans");
            assert.equal(store.contentZeroRefReport().rows, 0);

            // Fresh orphans present AT the archiveSession call: these are the
            // ones the old whole-table sweep would have wiped incidentally.
            seedContentRows(rawDb(store), 3, 0, "preexisting2");
            const preCount2 = (): number =>
                (rawDb(store).prepare("SELECT COUNT(*) AS n FROM content WHERE CAST(bytes AS TEXT) LIKE 'preexisting2-%'").get() as { n: number }).n;
            assert.equal(preCount2(), 3);

            const arch = store.archiveSession("sess-b", { archiveDir: path.join(dir, "arch") });
            assert.ok(arch.ok, `archive should succeed, got: ${JSON.stringify(arch)}`);
            // Scoped semantics: the report covers THIS op's own deletions
            // only (0: releaseContent already deleted them inline; 1 if that
            // ever stops being true). The old whole-table census reported >= 3.
            assert.ok(
                (arch.contentRowsDeleted ?? 0) <= 1,
                `archiveSession reports only its own scoped deletions (${String(arch.contentRowsDeleted)})`,
            );
            assert.equal(preCount2(), 3, "orphans present at call time survive archiveSession");
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});

test("#4796 follow-up: deleteCheckpoint scopes collection to the checkpoint's own state hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4796-cp-"));
    const dbPath = path.join(dir, "index.db");
    try {
        const store = UnifiedStore.open(dbPath);
        try {
            store.ingestSession(planIngest(mkSession("sess-cp", [mkMsg("c1", "checkpoint-session-body")])));
            const stateJson = JSON.stringify({ frozen: true, marker: "cp-state-body-unique" });
            store.insertCheckpoint({
                cpId: "cp-1",
                sessionId: "sess-cp",
                seqAt: 1,
                blockSetHash: "blocks-none",
                kind: "manual",
                pinned: false,
                createdAt: 5_000,
                stateJson,
            });
            seedContentRows(rawDb(store), 1, 0, "unrelated-orphan");
            assert.ok(store.deleteCheckpoint("cp-1"), "checkpoint deleted");
            assert.equal(store.contentRefCountOfBody("cp-state-body-unique"), 0, "checkpoint state blob collected");
            assert.equal(
                (rawDb(store).prepare("SELECT COUNT(*) AS n FROM content WHERE CAST(bytes AS TEXT) LIKE 'unrelated-orphan-%'").get() as { n: number }).n,
                1,
                "unrelated orphan survives deleteCheckpoint",
            );
            assert.deepEqual(rawDb(store).prepare("PRAGMA foreign_key_check").all(), [], "no dangling references");
        } finally {
            store.close();
        }
    } finally {
        rmDir(dir);
    }
});
