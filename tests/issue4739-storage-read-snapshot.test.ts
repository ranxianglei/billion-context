import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UnifiedStore, type IngestSessionInput } from "../src/storage/store.ts";
import { SqliteBackend } from "../src/storage/backend.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";

function fixture(requests = 1): IngestSessionInput {
    return {
        session: {
            sessionId: "snapshot", createdAt: 1, updatedAt: requests, nextBlockId: 4, nextRunId: 1,
            metaJson: "{}", statsJson: JSON.stringify({ requests }), metadataJson: JSON.stringify({ requests }),
            kstateJson: "{}", tailJson: "{}", ccrJson: null,
            orphansJson: JSON.stringify({ orphan: { one: null, full: { text: "orphan", count: 1 } } }),
        },
        messages: [0, 1, 2].map((seq) => ({
            seq, msgId: `m${seq}`, ref: null, refNum: null, role: "user", kind: "message",
            content: JSON.stringify({ id: `m${seq}`, role: "user", text: `text${seq}` }),
        })),
        blocks: [0, 1, 2].map((ord) => ({
            blockId: `b${ord}`, ord, startSeq: ord, endSeq: ord, startRef: null, endRef: null, tier: 0,
            summary: JSON.stringify({ text: `full${ord}`, count: 1 }),
            one: JSON.stringify({ text: `one${ord}`, count: 1 }), supersedesBlockId: null,
            active: ord !== 1, createdAt: 1, coveredHash: "[]", payloadJson: JSON.stringify({ blockId: `b${ord}` }),
        })),
        refs: [
            { ord: 0, rawId: "a", ref: "m00001", refNum: 1 },
            { ord: 1, rawId: "b", ref: "m00001", refNum: 1 },
            { ord: 2, rawId: "c", ref: "BLOCKED", refNum: null },
        ],
        deadRefs: [], ccrEntries: [],
        orphansJson: JSON.stringify({ orphan: { one: null, full: { text: "orphan", count: 1 } } }),
    };
}

for (const engine of ["node:sqlite", "better-sqlite3"] as const) {
    test(`${engine}: selected rows, page boundaries and narrow reads preserve their contracts`, (t) => {
        const dir = mkdtempSync(join(tmpdir(), "bili-read-snapshot-"));
        const file = join(dir, "index.db");
        let store: UnifiedStore | undefined;
        try {
            try { store = UnifiedStore.open(file, engine); } catch (err) {
                if (engine === "better-sqlite3" && String(err).includes("[storage:better-sqlite3]")) return t.skip(String(err));
                throw err;
            }
            store.ingestSession(fixture());
            const db = openSqliteDatabase(file, engine).db;
            try {
                db.prepare("UPDATE messages SET retired_at = 1 WHERE session_id = ? AND seq = 1").run("snapshot");
                assert.deepEqual(store.getMessages("snapshot").map((row) => row.seq), [0, 2]);
                assert.deepEqual(store.getMessages("snapshot", { seqs: [2, 1, 0, 2, 99] }).map((row) => row.seq), [0, 2]);
                assert.deepEqual(store.getMessages("snapshot", { seqs: [1], includeRetired: true }).map((row) => row.seq), [1]);
                assert.deepEqual(store.getMessages("snapshot", { seqs: [] }), []);
                assert.deepEqual(store.getBlocks("snapshot", { limit: 1, offset: 1 }).map((row) => row.blockId), ["b1"]);
                assert.deepEqual(store.getBlocks("snapshot", { limit: 2, offset: 3 }), []);
                assert.equal(store.getBlocks("snapshot").length, 3);

                // Invalid unrelated payloads must not be decoded by the lazy field readers.
                db.prepare("UPDATE sessions SET tail_json = 'bad', kstate_json = 'bad', ccr_json = 'bad' WHERE session_id = ?").run("snapshot");
                db.prepare("UPDATE blocks SET payload_json = 'bad' WHERE session_id = ?").run("snapshot");
                assert.deepEqual(store.getLoadHeader("snapshot"), { requests: 1, nextBlockId: 4, activeBlockCount: 2, mappedRefCount: 1 });
                db.prepare("UPDATE sessions SET stats_json = ? WHERE session_id = ?").run('{"requests":"2"}', "snapshot");
                assert.equal(store.getLoadHeader("snapshot")!.requests, 2, "old numeric-string counter matches full-load arbitration");
                assert.equal(store.getMetadataJson("snapshot"), '{"requests":1}');
                assert.deepEqual(JSON.parse(store.getOrphansJson("snapshot")!), JSON.parse(fixture().orphansJson!));
                const contents = store.getBlockContents("snapshot", { limit: 2, offset: 1 });
                assert.deepEqual(contents.map((row) => row.blockId), ["b1", "b2"]);
                assert.deepEqual(JSON.parse(contents[0]!.summary), { text: "full1", count: 1 });
                assert.deepEqual(JSON.parse(contents[0]!.one!), { text: "one1", count: 1 });
                assert.equal(store.getLoadHeader("missing"), null);
                assert.equal(store.getMetadataJson("missing"), null);
                db.prepare("UPDATE blocks SET ord = 0 WHERE session_id = ?").run("snapshot");
                assert.equal(store.getBlocks("snapshot", { limit: 1, offset: 1 })[0]!.blockId, "b1", "equal ord uses a stable page boundary");
            } finally { db.close(); }
        } finally {
            store?.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test(`${engine}: sync snapshot permits another writer and keeps the earlier generation`, (t) => {
        const dir = mkdtempSync(join(tmpdir(), "bili-read-snapshot-"));
        const file = join(dir, "index.db");
        let store: UnifiedStore | undefined;
        try {
            try { store = UnifiedStore.open(file, engine); } catch (err) {
                if (engine === "better-sqlite3" && String(err).includes("[storage:better-sqlite3]")) return t.skip(String(err));
                throw err;
            }
            store.ingestSession(fixture());
            const writer = openSqliteDatabase(file, engine).db;
            const reader = store;
            try {
                reader.readSnapshot(() => {
                    assert.equal(reader.getLoadHeader("snapshot")!.requests, 1);
                    writer.prepare("UPDATE sessions SET stats_json = ? WHERE session_id = ?").run('{"requests":2}', "snapshot");
                    writer.prepare("UPDATE blocks SET active = 0 WHERE session_id = ?").run("snapshot");
                    assert.equal(reader.getLoadHeader("snapshot")!.requests, 1);
                    assert.equal(reader.getBlocks("snapshot", { limit: 1, offset: 2 })[0]!.active, true);
                });
                assert.equal(reader.getLoadHeader("snapshot")!.requests, 2);
                assert.throws(() => reader.readSnapshot(() => { throw new Error("reader failed"); }), /reader failed/);
                writer.prepare("UPDATE sessions SET stats_json = ? WHERE session_id = ?").run('{"requests":3}', "snapshot");
                assert.equal(reader.readSnapshot(() => reader.getLoadHeader("snapshot")!.requests), 3);
            } finally { writer.close(); }
        } finally {
            store?.close();
            rmSync(dir, { recursive: true, force: true });
        }
    });
}

test("async sqlite snapshot isolates normal writes across await and closes on callback failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-read-snapshot-"));
    const backend = SqliteBackend.open(join(dir, "index.db"));
    try {
        await backend.ingestSession(fixture());
        await backend.readSnapshot(async (reader) => {
            assert.equal(JSON.parse((await reader.getSessionRow("snapshot"))!.statsJson).requests, 1);
            await backend.ingestSession(fixture(2));
            assert.equal(JSON.parse((await reader.getSessionRow("snapshot"))!.statsJson).requests, 1);
            assert.deepEqual((await reader.getMessages("snapshot", { seqs: [2] })).map((row) => row.seq), [2]);
        });
        assert.equal(JSON.parse((await backend.getSessionRow("snapshot"))!.statsJson).requests, 2);
        await assert.rejects(backend.readSnapshot(async (reader) => {
            await reader.getSessionRow("snapshot");
            throw new Error("async reader failed");
        }), /async reader failed/);
        await backend.ingestSession(fixture(3));
        await backend.readSnapshot(async (reader) => {
            assert.equal(JSON.parse((await reader.getSessionRow("snapshot"))!.statsJson).requests, 3);
        });
    } finally {
        await backend.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("mysql snapshot pins SQL, CAS and media hydration to its read-only connection and releases on error", async () => {
    const queries: { sql: string; values?: unknown[] }[] = [];
    let releases = 0;
    let rollbacks = 0;
    const mediaHash = "a".repeat(64);
    const conn = {
        async query(sql: string, values?: unknown[]) {
            queries.push({ sql, values });
            if (sql.includes("FROM messages")) return [[{ seq: 2, msg_id: "m2", role: "user", kind: "message", content_hash: "msg" }]];
            if (sql.includes("FROM blocks")) return [[{ block_id: "b1", summary_hash: "summary", one_hash: "one", active: 1 }]];
            if (sql.includes("FROM content")) {
                const bytes = values?.[0] === "msg" ? JSON.stringify({ imageBase64: { $media: mediaHash } })
                    : values?.[0] === mediaHash ? "image-bytes" : '{"text":"summary","count":1}';
                return [[{ bytes }]];
            }
            return [[]];
        },
        async rollback() { rollbacks++; },
        release() { releases++; },
    };
    const driver = { createPool: () => ({
        getConnection: async () => conn,
        query: async () => { throw new Error("snapshot escaped to pool"); },
        end: async () => {},
    }) } as unknown as Mysql2Module;
    const backend = new MysqlBackend("mysql://snapshot-test", driver);
    await backend.readSnapshot(async (reader) => {
        const before = queries.length;
        assert.deepEqual(await reader.getMessages("snapshot", { seqs: [] }), []);
        assert.equal(queries.length, before);
        const rows = await reader.getMessages("snapshot", { seqs: [2] });
        assert.equal(JSON.parse(rows[0]!.content).imageBase64, "image-bytes");
        assert.equal((await reader.getBlocks("snapshot", { limit: 1, offset: 2 }))[0]!.blockId, "b1");
        await reader.getSessionRow("snapshot");
        await reader.getRefs("snapshot");
        await reader.getDeadRefs("snapshot");
    });
    assert.equal(queries[0]!.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    assert.equal(queries[1]!.sql, "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    const selected = queries.find((query) => query.sql.includes("FROM messages"))!;
    assert.match(selected.sql, /retired_at IS NULL AND seq IN \(\?\)/);
    assert.deepEqual(selected.values, ["snapshot", 2]);
    const paged = queries.find((query) => query.sql.includes("FROM blocks"))!;
    assert.match(paged.sql, /ORDER BY ord, block_id LIMIT \? OFFSET \?/);
    assert.deepEqual(paged.values, ["snapshot", 1, 2]);
    await assert.rejects(backend.readSnapshot(async () => { throw new Error("mysql reader failed"); }), /mysql reader failed/);
    assert.equal(rollbacks, 2);
    assert.equal(releases, 2);
    await backend.close();
});
