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

test("watermark reset preserves every table and avoids rewriting absent watermarks", () => {
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
        db.exec("SAVEPOINT expected_reset");
        db.prepare("UPDATE sessions SET last_ingested_seq=NULL").run();
        const expected = snapshot(db);
        db.exec("ROLLBACK TO expected_reset; RELEASE expected_reset");
        const changes = () => Number((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n);
        const before = changes();
        store.resetAllIngestWatermarks();
        assert.deepEqual(snapshot(db), expected, "reset must preserve the exact existing SQL contract");
        assert.equal(changes() - before, 2, "only non-null watermarks should be updated");
        const repeated = changes();
        store.resetAllIngestWatermarks();
        assert.equal(changes() - repeated, 0, "repeated reset must not rewrite already absent watermarks");
        assert.deepEqual(snapshot(db), expected);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
