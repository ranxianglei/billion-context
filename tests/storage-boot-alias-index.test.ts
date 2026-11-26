import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInitialState } from "acp-kernel";
import { SessionStore, relPathFor } from "../src/persist.ts";
import { planIngest, type LegacySessionLike } from "../src/storage/ingest.ts";
import { UnifiedShadow } from "../src/storage/shadow.ts";
import { UnifiedStore } from "../src/storage/store.ts";
import type { SqliteDatabase } from "../src/storage/driver.ts";

function source(id: string, label?: string): LegacySessionLike {
    return {
        id, createdAt: 1700000000000, lastSeen: 1700000000001,
        meta: { label, protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:1" },
        stats: { requests: 1 }, metadata: {}, state: { ...createInitialState() }, blockContents: new Map(),
        lastMessages: [], lastMessagesFolded: false,
    };
}

function snapshot(db: SqliteDatabase): unknown {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    return tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all().map(row => JSON.stringify(row)).sort()]);
}

test("boot alias rows preserve the summary identity projection without changing SQL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-alias-projection-"));
    const store = UnifiedStore.open(path.join(dir, "index.db"));
    try {
        const db = Reflect.get(store, "db") as SqliteDatabase;
        for (const item of [source("old-id", "ses_alias"), source("canonical", "canonical"), source("unlabelled"), source("empty-label", ""), source("archived", "ses_alias")]) {
            assert.equal(store.ingestSession(planIngest(item)), true);
        }
        db.prepare("UPDATE sessions SET status='archived', stats_json='not-json' WHERE session_id=?").run("archived");
        db.prepare("UPDATE sessions SET label=NULL, protocol=NULL, origin=NULL WHERE session_id=?").run("unlabelled");
        // A fixture-only index would reorder the narrow projection and change
        // equal-time alias winners if it stopped following the table scan.
        db.exec("CREATE INDEX alias_fixture_cover ON sessions(label, session_id, protocol, origin, updated_at)");
        const before = snapshot(db);
        const expected = store.sessionSummaries().map(({ sessionId, label, protocol, origin, updatedAt }) => ({ sessionId, label, protocol, origin, updatedAt }));
        assert.deepEqual(store.sessionAliasRows(), expected);
        assert.deepEqual(snapshot(db), before);
    } finally {
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("bounded boot seeds file aliases without the web summary query", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-boot-alias-"));
    const shadow = UnifiedShadow.maybeOpen(dir, { BILI_STORAGE_UNIFIED: "full" });
    assert.ok(shadow);
    const sql = Reflect.get(shadow, "sync") as UnifiedStore;
    const original = source("legacy-id", "ses_alias_target");
    assert.equal(sql.ingestSession(planIngest(original)), true);
    const file = path.join(dir, relPathFor(original.id, "anthropic", "http://127.0.0.1:1"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 3, id: original.id, savedAt: 1700000000001, payload: original }));
    let summaryCalls = 0;
    const summaries = shadow.sessionSummaries.bind(shadow);
    shadow.sessionSummaries = () => { summaryCalls++; return summaries(); };
    const persist = new SessionStore({ dir, shadow });
    try {
        await persist.boot({ maxSessions: 0, maxBytes: 0 });
        const aliases = Reflect.get(persist, "legacyAliases") as Map<string, { id: string; file: string; savedAt: number }>;
        assert.deepEqual(aliases.get("ses_alias_target"), { id: original.id, file, savedAt: 1700000000001 });
        assert.equal(summaryCalls, 0, "alias boot must not scan block aggregates or parse web stats");
    } finally {
        await (Reflect.get(persist, "remainderScan") as Promise<void> | undefined);
        persist.closeQuietly();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
