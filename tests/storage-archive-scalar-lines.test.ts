import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UnifiedStore } from "../src/storage/store.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { MysqlBackend, type Mysql2Module } from "../src/storage/mysql.ts";

process.env.BILI_PERSIST_ZSTD = "0";
process.env.BILI_STORAGE_UNIFIED = "full";

function session(id: string): LegacySessionLike {
    return {
        id, createdAt: 1000, lastSeen: 2000, meta: { protocol: "openai" }, stats: {}, metadata: {},
        state: {
            blocks: [{ blockId: "b1", runId: 1, active: true, createdAt: 1000, tier: 1,
                summary: "retained summary", kind: "fold", reason: "test",
                effectiveMessageIds: [`${id}-message`], directMessageIds: [] }],
            nextBlockId: 2, nextRunId: 2, messageRefs: { byRaw: {}, byRef: {} },
        },
        blockContents: new Map(),
        lastMessages: [{ id: `${id}-message`, role: "user", contentType: "text", text: "original message" }],
        lastMessagesFolded: false,
    } as unknown as LegacySessionLike;
}

const unrelated = 'null\n42\nfalse\n"text"\n[]\n{"truncated":\n';

test("SQLite session restore skips non-object JSONL before a valid archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-scalar-session-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        const archiveDir = join(dir, "archive");
        store.ingestSession(planIngest(session("wanted")));
        store.ingestSession(planIngest(session("other")));
        const before = store.getMessages("wanted");
        const blocks = store.getBlocks("wanted");
        assert.ok(store.archiveSession("wanted", { archiveDir }).ok);
        assert.ok(store.archiveSession("other", { archiveDir }).ok);
        const file = join(archiveDir, UnifiedStore.ARCHIVE_LOG_NAME);
        const valid = readFileSync(file, "utf8");
        const otherLine = valid.split("\n").find((line) => line.includes('"sessionId":"other"'))!;
        writeFileSync(file, unrelated + valid);
        assert.deepEqual(store.restoreArchived("wanted", { archiveDir }), { ok: true });
        assert.deepEqual(store.getMessages("wanted"), before);
        assert.deepEqual(store.getBlocks("wanted"), blocks);
        assert.ok(readFileSync(file, "utf8").split("\n").includes(otherLine));
        assert.deepEqual(store.restoreArchived("other", { archiveDir }), { ok: true });
        assert.deepEqual(store.restoreArchived("absent", { archiveDir }), { ok: false, reason: "export-missing" });
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("SQLite block restore skips null before the requested block without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-scalar-block-"));
    const store = UnifiedStore.open(join(dir, "index.db"));
    try {
        const archiveDir = join(dir, "archive");
        store.ingestSession(planIngest(session("wanted")));
        const before = store.getBlocks("wanted");
        assert.ok(store.archiveBlock("wanted", "b1", { archiveDir }).ok);
        const file = join(archiveDir, UnifiedStore.BLOCK_ARCHIVE_LOG_NAME);
        writeFileSync(file, unrelated + readFileSync(file, "utf8"));
        assert.deepEqual(store.restoreBlock("wanted", "b1", { archiveDir }), { ok: true });
        assert.deepEqual(store.getBlocks("wanted"), before);
        writeFileSync(file, unrelated);
        assert.deepEqual(store.restoreBlock("absent", "b1", { archiveDir }), { ok: false, reason: "not-found" });
    } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("MySQL archive scanner reaches a valid later record and commits through the driver contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-scalar-mysql-"));
    const source = UnifiedStore.open(join(dir, "source.db"));
    try {
        const archiveDir = join(dir, "archive");
        source.ingestSession(planIngest(session("wanted")));
        assert.ok(source.archiveSession("wanted", { archiveDir }).ok);
        const file = join(archiveDir, MysqlBackend.ARCHIVE_LOG_NAME);
        writeFileSync(file, unrelated + readFileSync(file, "utf8"));
        const calls: string[] = [];
        const conn = {
            async beginTransaction() { calls.push("begin"); },
            async commit() { calls.push("commit"); },
            async rollback() { calls.push("rollback"); },
            release() { calls.push("release"); },
            async query(sql: string) { calls.push(sql); return [{ affectedRows: 1 }]; },
        };
        const driver = { createPool: () => ({ getConnection: async () => conn }) } as unknown as Mysql2Module;
        const backend = new MysqlBackend("unused", driver);
        assert.deepEqual(await backend.restoreArchived("wanted", { archiveDir }), { ok: true });
        assert.equal(calls[0], "begin");
        assert.ok(calls.some((sql) => sql.startsWith("INSERT INTO messages")));
        assert.deepEqual(calls.slice(-2), ["commit", "release"]);
        assert.ok(!readFileSync(file, "utf8").includes('"sessionId":"wanted"'));
        writeFileSync(file, unrelated);
        const count = calls.length;
        assert.deepEqual(await backend.restoreArchived("absent", { archiveDir }), { ok: false, reason: "export-missing" });
        assert.equal(calls.length, count);
    } finally {
        source.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
