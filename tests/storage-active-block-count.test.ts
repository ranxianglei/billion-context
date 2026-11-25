import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { StorageBackend } from "../src/storage/backend.ts";
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";

function seed(id: string): LegacySessionLike {
    const messages = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, role: "user" as const, contentType: "text" as const, text: `original ${i}`, ts: 1000 + i }));
    const blocks: LegacySessionLike["state"]["blocks"] = messages.map((message, i) => ({
        blockId: `b${i}`, runId: "r1", tier: 1, summary: `summary ${i}`, directMessageIds: [message.id],
        effectiveMessageIds: [message.id], directBlockIds: [], compressedTokens: 1, createdAt: 1,
        survivedCount: 0, generation: "young", active: i % 2 === 0,
    }));
    return {
        id, createdAt: 1, lastSeen: 2, meta: {}, stats: {}, metadata: {},
        state: { blocks, nextBlockId: 5, nextRunId: 2, messageRefs: { byRaw: {}, byRef: {} } },
        blockContents: new Map(blocks.map((block, i) => [block.blockId, {
            full: { text: `full 海🌊 ${i}`, count: 1 }, one: { text: `one ${i}`, count: 1 },
        }])), lastMessages: messages, lastMessagesFolded: false,
    };
}

function fixture(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), "bili-active-block-count-"));
    process.env.BILI_CONFIG_FILE = join(dir, "no-config.json");
    const store = UnifiedStore.open(join(dir, "index.db"));
    store.ingestSession(planIngest(seed("target")), undefined, { completeLog: true });
    const db = openSqliteDatabase(join(dir, "index.db"), "node:sqlite").db;
    const shadow = UnifiedShadow.maybeOpen(dir, { ...process.env, BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    let closed = false;
    const close = () => { if (!closed) { shadow.close(); closed = true; } };
    t.after(() => { close(); db.close(); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
    return { store, db, shadow, close };
}

test("active count is scoped to the session, exact active flag, and missing-session zero", (t) => {
    const { store, db, shadow } = fixture(t);
    store.ingestSession(planIngest(seed("other")), undefined, { completeLog: true });
    assert.equal(shadow.activeBlockCount("target"), 2);
    db.prepare("UPDATE blocks SET active = 2 WHERE session_id = ? AND block_id = ?").run("target", "b0");
    assert.equal(shadow.activeBlockCount("target"), 1);
    assert.equal(shadow.activeBlockCount("other"), 2);
    assert.equal(shadow.activeBlockCount("missing"), 0);
});

test("block rows without a session header still count", (t) => {
    const { db, shadow } = fixture(t);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run("target");
    assert.equal(shadow.activeBlockCount("target"), 2);
});

test("missing or invalid content does not change row membership", (t) => {
    const { db, shadow } = fixture(t);
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM content WHERE hash IN (SELECT summary_hash FROM blocks WHERE session_id = ?)").run("target");
    db.prepare("UPDATE content SET bytes = ?, byte_len = 3").run(Buffer.from([0xff, 0, 0x80]));
    db.prepare("UPDATE blocks SET payload_json = ? WHERE session_id = ?").run("not JSON", "target");
    assert.equal(shadow.activeBlockCount("target"), 2);
});

test("counting leaves persisted rows and CAS reference ownership unchanged", (t) => {
    const { db, shadow } = fixture(t);
    const snapshot = () => ["sessions", "blocks", "content"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    for (let i = 0; i < 3; i++) assert.equal(shadow.activeBlockCount("target"), 2);
    assert.deepEqual(snapshot(), before);
});

test("an unavailable SQLite handle remains unknown rather than zero", (t) => {
    const { shadow, close } = fixture(t);
    close();
    assert.equal(shadow.activeBlockCount("target"), null);
});

test("an async backend remains unknown without invoking backend methods", () => {
    const backend = new Proxy({}, { get() { throw new Error("sync count must not use an async backend"); } }) as StorageBackend;
    const shadow = UnifiedShadow.fromBackend("full", backend);
    assert.equal(shadow.activeBlockCount("target"), null);
});
