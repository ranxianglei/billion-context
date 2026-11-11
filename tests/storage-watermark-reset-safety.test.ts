import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInitialState } from "acp-kernel";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { SqliteDatabase } from "../src/storage/driver.ts";

function snapshot(db: SqliteDatabase): unknown {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all().map(row => JSON.stringify(row)).sort()]);
}

test("writer handoff invalidates watermark trust without rewriting any SQL row", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watermark-reset-"));
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        const db = Reflect.get(store, "db") as SqliteDatabase;
        for (let i = 0; i < 3; i++) {
            const source: LegacySessionLike = {
                id: `reset-${i}`, createdAt: 1700000000000, lastSeen: 1700000000001,
                meta: { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:1" },
                stats: { requests: 1 }, metadata: {}, state: { ...createInitialState() }, blockContents: new Map(),
                lastMessages: [{ id: `message-${i}`, role: "user", contentType: "text", text: "exact original", ts: 1700000000000 }], lastMessagesFolded: false,
            };
            assert.equal(store.ingestSession(planIngest(source), undefined, { completeLog: true }), true);
            db.prepare("UPDATE sessions SET last_ingested_seq=? WHERE session_id=?").run([null, 0, 7][i], source.id);
        }
        const expected = snapshot(db);
        const changes = () => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
        const before = changes();
        store.resetAllIngestWatermarks();
        assert.deepEqual(snapshot(db), expected, "writer initialization must leave every stored value exact");
        assert.equal(changes() - before, 0, "initialization must not rewrite giant session rows");
        for (let i = 0; i < 3; i++) assert.equal(store.ingestWatermark(`reset-${i}`), null);
        const repeated = changes();
        store.resetAllIngestWatermarks();
        assert.equal(changes() - repeated, 0, "repeated reset must not rewrite already absent watermarks");
        assert.deepEqual(snapshot(db), expected);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("watermark trust requires an outer commit, survives neither rollback nor failed COMMIT", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watermark-commit-"));
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        const db = Reflect.get(store, "db") as SqliteDatabase;
        const source: LegacySessionLike = {
            id: "commit-owner", createdAt: 1700000000000, lastSeen: 1700000000001,
            meta: { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:1" },
            stats: { requests: 1 }, metadata: {}, state: { ...createInitialState() }, blockContents: new Map(),
            lastMessages: [{ id: "owned-message", role: "user", contentType: "text", text: "exact", ts: 1700000000000 }], lastMessagesFolded: false,
        };
        store.ingestSession(planIngest(source));
        store.resetAllIngestWatermarks();
        const before = snapshot(db);
        assert.throws(() => db.transaction(() => {
            store.ingestSession(planIngest(source));
            store.trustCommittedIngestWatermark(source.id);
            assert.equal(store.ingestWatermark(source.id), null, "savepoint release cannot publish trust");
            throw new Error("force outer rollback");
        }), /force outer rollback/);
        assert.deepEqual(snapshot(db), before);
        assert.equal(store.ingestWatermark(source.id), null);
        assert.throws(() => db.transaction(() => {
            db.exec("PRAGMA defer_foreign_keys=ON");
            store.ingestSession(planIngest(source));
            db.prepare("INSERT INTO ccr_entries(session_id, ord, ccr_key, content_hash) VALUES (?, ?, ?, ?)").run(source.id, 1000, "commit-fault", "missing-content-hash");
        }), /FOREIGN KEY constraint failed/);
        assert.deepEqual(snapshot(db), before);
        assert.equal(store.ingestWatermark(source.id), null, "failed COMMIT cannot publish trust");
        const transactionState = db.inTransaction;
        db.inTransaction = () => undefined;
        store.ingestSession(planIngest(source));
        assert.equal(store.ingestWatermark(source.id), null, "unknown transaction state fails closed");
        db.inTransaction = transactionState;
        assert.equal(store.ingestSession(planIngest(source)), true);
        assert.ok(store.ingestWatermark(source.id), "a successful owned outer commit restores delta eligibility");
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
