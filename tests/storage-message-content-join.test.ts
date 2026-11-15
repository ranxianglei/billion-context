import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openSqliteDatabase, type SqliteDatabase } from "../src/storage/driver.ts";
import { splitMediaContent } from "../src/storage/identity.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";
import { UnifiedStore, sha256Hex, type IngestSessionInput } from "../src/storage/store.ts";

function input(count = 8, sessionId = "target"): IngestSessionInput {
    return {
        session: {
            sessionId, createdAt: 1, updatedAt: 2, nextBlockId: 1, nextRunId: 1,
            metaJson: "{}", statsJson: "{}", metadataJson: "{}", kstateJson: "{}",
            tailJson: JSON.stringify({ tailSeqs: Array.from({ length: count }, (_, i) => i) }), ccrJson: null,
        },
        messages: Array.from({ length: count }, (_, seq) => ({
            seq, msgId: `m${seq}`, ref: `m${String(seq + 1).padStart(5, "0")}`, refNum: seq + 1,
            role: seq % 2 ? "assistant" : "user", kind: "text", ts: 1000 + seq,
            content: JSON.stringify({ id: `m${seq}`, role: seq % 2 ? "assistant" : "user", contentType: "text", text: `${sessionId} ${seq} 日本語 😀\u0000` }),
        })),
        blocks: [], refs: [], deadRefs: [], ccrEntries: [],
    };
}

function expected(value = input()) {
    return value.messages.map((row) => ({ ...row, contentHash: sha256Hex(row.content), retiredAt: null }));
}

function withoutRetired<T extends { retiredAt: number | null }>(rows: T[]) {
    return rows.map(({ retiredAt: _retiredAt, ...row }) => row);
}

function setup(t: TestContext, engine: "node:sqlite" | "better-sqlite3" = "node:sqlite", count = 8) {
    const dir = mkdtempSync(join(tmpdir(), "bili-message-join-"));
    const file = join(dir, "index.db");
    let store: UnifiedStore;
    try { store = UnifiedStore.open(file, engine); }
    catch (error) {
        rmSync(dir, { recursive: true, force: true });
        if (engine === "better-sqlite3" && String(error).includes("[storage:better-sqlite3]")) {
            t.skip(String(error));
            return;
        }
        throw error;
    }
    const writer = openSqliteDatabase(file, engine).db;
    t.after(() => { writer.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
    store.ingestSession(input(count));
    return { store, writer };
}

function countSelects(t: TestContext, store: UnifiedStore) {
    const db = (store as unknown as { db: SqliteDatabase }).db;
    const prepare = db.prepare.bind(db);
    let count = 0;
    let maxPayloadRows = 0;
    t.mock.method(db, "prepare", (sql: string) => {
        if (/^SELECT\b/.test(sql.trim())) count++;
        const statement = prepare(sql);
        return {
            get: statement.get.bind(statement), run: statement.run.bind(statement),
            all(...args: unknown[]) {
                const rows = statement.all(...args);
                const payloadRows = rows.filter((row) => row !== null && typeof row === "object" && ("bytes" in row || "content_bytes" in row)).length;
                maxPayloadRows = Math.max(maxPayloadRows, payloadRows);
                return rows;
            },
        };
    });
    return () => ({ count, maxPayloadRows });
}

for (const engine of ["node:sqlite", "better-sqlite3"] as const) {
    for (const read of ["all", "pointers", "uncovered", "uncovered-full"] as const) {
        test(`${engine}: ${read} message reads fetch base content in bounded statements`, (t) => {
            const fixture = setup(t, engine, 1003);
            if (!fixture) return;
            const { store } = fixture;
            const count = countSelects(t, store);
            const rows = read === "all" ? store.getMessages("target")
                : read === "pointers" ? store.getMessagesAt("target", Array.from({ length: 1003 }, (_, i) => 1002 - i))
                : store.uncoveredRows("target", read === "uncovered-full" ? [] : Array.from({ length: 502 }, (_, i) => [i * 2, i * 2] as [number, number]));
            assert.equal(rows.length, read === "uncovered" ? 501 : 1003);
            assert.equal(count().count, read === "pointers" ? 3 : read === "uncovered" ? 5 : 4);
            assert.ok(count().maxPayloadRows <= 500, "body batches must not grow with the whole history");
        });
    }

    test(`${engine}: filters, ordering, timestamps and full message fields stay intact`, (t) => {
        const fixture = setup(t, engine);
        if (!fixture) return;
        const { store, writer } = fixture;
        const rows = expected();
        assert.deepEqual(store.getMessages("target"), rows);
        store.ingestSession(input(8, "other"));
        writer.prepare("UPDATE messages SET retired_at = 5000 WHERE session_id = ? AND seq = 2").run("target");
        const live = rows.filter((row) => row.seq !== 2);
        assert.deepEqual(store.getMessages("target"), live);
        assert.deepEqual(store.getMessages("target", { includeRetired: true }), rows.map((row) => row.seq === 2 ? { ...row, retiredAt: 5000 } : row));
        assert.deepEqual(store.getMessages("target", { seqs: [7, 2, 1, 7, 99], fromSeqExclusive: 6 }), [rows[1], rows[7]]);
        assert.deepEqual(store.getMessages("target", { fromSeqExclusive: 4 }), rows.slice(5));
        assert.deepEqual(store.getMessagesAt("target", [7, 2, 1, 7, 99]), withoutRetired([rows[1]!, rows[7]!]));
        assert.deepEqual(store.uncoveredRows("target", [[5, 7], [2, 0], [0, 1], [1, 2]]), withoutRetired(rows.slice(3, 5)));
        assert.deepEqual(store.sessionViewRows("target")!.messages, withoutRetired(live));
        assert.deepEqual(store.getMessages("missing"), []);
        assert.deepEqual(store.getMessages("target", { seqs: [] }), []);
        assert.deepEqual(store.getMessagesAt("target", []), []);
        assert.deepEqual(store.getMessages("other"), expected(input(8, "other")));
    });

    test(`${engine}: missing, empty and invalid UTF-8 content retain the old decoding`, (t) => {
        const fixture = setup(t, engine);
        if (!fixture) return;
        const { store, writer } = fixture;
        const hashes = input().messages.map((row) => sha256Hex(row.content));
        writer.exec("PRAGMA foreign_keys=OFF");
        writer.prepare("DELETE FROM content WHERE hash = ?").run(hashes[0]);
        writer.prepare("UPDATE content SET bytes = ?, byte_len = 0 WHERE hash = ?").run(Buffer.alloc(0), hashes[1]);
        const invalid = Buffer.from([0x66, 0x80, 0x00, 0x6f]);
        writer.prepare("UPDATE content SET bytes = ?, byte_len = ? WHERE hash = ?").run(invalid, invalid.length, hashes[2]);
        const wanted = ["", "", invalid.toString("utf8")];
        assert.deepEqual(store.getMessages("target").slice(0, 3).map((row) => row.content), wanted);
        assert.deepEqual(store.getMessagesAt("target", [0, 1, 2]).map((row) => row.content), wanted);
        assert.deepEqual(store.uncoveredRows("target", [[3, 7]]).map((row) => row.content), wanted);
    });

    test(`${engine}: joined message bytes still hydrate both media representations`, (t) => {
        const fixture = setup(t, engine, 0);
        if (!fixture) return;
        const { store, writer } = fixture;
        const value = input(2);
        const payload = "YWJj".repeat(600);
        const originals = value.messages.map((row) => JSON.stringify({ id: row.msgId, imageBase64: payload,
            rawOpenaiContent: { image_url: { url: `data:image/png;base64,${payload}` } } }));
        value.messages = value.messages.map((row, i) => {
            const split = splitMediaContent(originals[i]!);
            return { ...row, content: split.content, contentHash: split.hash, media: split.media };
        });
        store.ingestSession(value);
        assert.deepEqual(store.getMessages("target").map((row) => row.content), originals);
        assert.deepEqual(store.getMessagesAt("target", [0, 1]).map((row) => row.content), originals);
        assert.deepEqual(store.uncoveredRows("target", []).map((row) => row.content), originals);
        writer.exec("PRAGMA foreign_keys=OFF");
        writer.prepare("DELETE FROM content WHERE hash = ?").run(sha256Hex(payload));
        assert.deepEqual(store.getMessages("target").map((row) => row.content), value.messages.map((row) => row.content));
    });
}

function mysqlWithSqlite(t: TestContext, count = 8) {
    const fixture = setup(t, "node:sqlite", count)!;
    const calls: { source: string; sql: string; payloadRows?: number }[] = [];
    const query = (source: string) => async (sql: string, params: unknown[] = []) => {
        calls.push({ source, sql });
        if (sql.startsWith("SET TRANSACTION") || sql.startsWith("START TRANSACTION")) return [[]];
        const rows = fixture.writer.prepare(sql).all(...params) as Record<string, unknown>[];
        calls.at(-1)!.payloadRows = rows.filter((row) => "bytes" in row || "content_bytes" in row).length;
        return [rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? Buffer.from(value) : value])))];
    };
    const conn = { query: query("connection"), rollback: async () => {}, release: () => {} };
    const driver = { createPool: () => ({ query: query("pool"), getConnection: async () => conn, end: async () => {} }) } as unknown as Mysql2Module;
    const backend = new MysqlBackend("mysql://query-contract", driver);
    t.after(() => backend.close());
    return { ...fixture, backend, calls };
}

for (const read of ["all", "pointers"] as const) {
    test(`mysql ${read} readers execute SQL against SQLite without per-message CAS queries`, async (t) => {
        const { backend, calls } = mysqlWithSqlite(t, 1003);
        const rows = read === "all" ? await backend.getMessages("target") : (await backend.sessionViewRows("target"))!.messages;
        assert.equal(rows.length, 1003);
        assert.equal(calls.filter((call) => /FROM messages\b|FROM content\b/.test(call.sql)).length, read === "all" ? 4 : 3);
        assert.ok(calls.every((call) => (call.payloadRows ?? 0) <= 500), "body batches must stay bounded on the SQL backend");
    });
}

test("mysql joined reads preserve row shapes, filters, media and the snapshot connection", async (t) => {
    const { store, writer, backend, calls } = mysqlWithSqlite(t);
    writer.prepare("UPDATE messages SET retired_at = 5000 WHERE session_id = ? AND seq = 2").run("target");
    for (const opts of [undefined, { includeRetired: true }, { seqs: [7, 2, 1, 99, 7] }, { seqs: [] }]) {
        assert.deepEqual(await backend.getMessages("target", opts), store.getMessages("target", opts));
    }
    assert.deepEqual((await backend.sessionViewRows("target"))!.messages, store.sessionViewRows("target")!.messages);
    const value = input(1, "media");
    const payload = "YWJj".repeat(600);
    const original = JSON.stringify({ imageBase64: payload, text: "kept", rawOpenaiContent: { url: `data:image/png;base64,${payload}` } });
    const split = splitMediaContent(original);
    value.messages[0] = { ...value.messages[0]!, content: split.content, contentHash: split.hash, media: split.media };
    store.ingestSession(value);
    calls.length = 0;
    await backend.readSnapshot(async (reader) => {
        assert.equal((await reader.getMessages("media"))[0]!.content, original);
    });
    assert.ok(calls.length > 2);
    assert.ok(calls.every((call) => call.source === "connection"));
    assert.deepEqual(await backend.getMessages("missing"), []);
});

test("mysql message reads keep missing/empty CAS fallbacks and Buffer decoding", async (t) => {
    const { store, writer, backend } = mysqlWithSqlite(t);
    const hashes = input().messages.map((row) => sha256Hex(row.content));
    writer.exec("PRAGMA foreign_keys=OFF");
    writer.prepare("DELETE FROM content WHERE hash = ?").run(hashes[0]);
    writer.prepare("UPDATE content SET bytes = ?, byte_len = 0 WHERE hash = ?").run(Buffer.alloc(0), hashes[1]);
    const invalid = Buffer.from([0x66, 0x80, 0x00, 0x6f]);
    writer.prepare("UPDATE content SET bytes = ?, byte_len = ? WHERE hash = ?").run(invalid, invalid.length, hashes[2]);
    assert.deepEqual(await backend.getMessages("target"), store.getMessages("target"));
    assert.deepEqual((await backend.sessionViewRows("target"))!.messages, store.sessionViewRows("target")!.messages);
});
