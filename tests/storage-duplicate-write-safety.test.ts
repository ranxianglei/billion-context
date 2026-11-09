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
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];
    return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
        .all().map((row) => JSON.stringify(row)).sort()]);
}

for (const corruption of ["missing content", "zero reference count"] as const) {
    test(`duplicate ingest refuses ${corruption} and rolls back every table`, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-duplicate-cas-safety-"));
        const store = UnifiedStore.open(path.join(dir, "index.db"));
        try {
            const source: LegacySessionLike = {
                id: "duplicate-cas-safety", createdAt: 1700000000000, lastSeen: 1700000000001,
                meta: { label: "synthetic", protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:1" },
                stats: { requests: 1 }, metadata: {}, state: { ...createInitialState() }, blockContents: new Map(),
                lastMessages: [{ id: "exact-message", role: "user", contentType: "text", text: "exact original bytes", ts: 1700000000000 }],
                lastMessagesFolded: false,
            };
            const plan = planIngest(source);
            assert.equal(store.ingestSession(structuredClone(plan), undefined, { completeLog: true }), true);
            const db = Reflect.get(store, "db") as SqliteDatabase;
            if (corruption === "missing content") {
                db.exec("PRAGMA foreign_keys = OFF");
                assert.equal(db.prepare("DELETE FROM content WHERE hash IN (SELECT content_hash FROM messages)").run().changes, 1);
                db.exec("PRAGMA foreign_keys = ON");
                assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 1);
            } else {
                assert.equal(db.prepare("UPDATE content SET refcount = 0 WHERE hash IN (SELECT content_hash FROM messages)").run().changes, 1);
                assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
            }
            const before = snapshot(db);
            assert.throws(() => store.ingestSession(structuredClone(plan), undefined, { completeLog: true }), /FOREIGN KEY constraint failed/);
            assert.deepEqual(snapshot(db), before, "failed duplicate ingest must leave all durable rows unchanged");
        } finally {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
}
