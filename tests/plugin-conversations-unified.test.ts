import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5753: plugin conversation routes ride the unified storage (kv_store,
// namespace "plugin-conversations", row "table") instead of
// plugin-conversations.json. Boot wiring: server.ts calls
// hydratePluginConversationsUnified() right after loadConversations() so the
// memory Map ends with the kv ∪ file merge already applied.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-plugc-"));
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, unifiedKvActive } = await import("../src/persist.js");
const { loadConversations, flushConversations, recordPluginSession, resolveConversation, _resetPluginStateForTest, hydratePluginConversationsUnified, _resetPluginConversationsUnifiedForTest } = await import("../src/plugin.js");

const legacyFile = path.join(root, "state", "billion-context", "plugin-conversations.json");

async function kvTable(): Promise<Record<string, { sessionId: string; lastSeen: number }>> {
    const doc = await getStore().getKvAsync("plugin-conversations", "table");
    return (doc ?? {}) as Record<string, { sessionId: string; lastSeen: number }>;
}

test("environment resolves to a unified (non-legacy) store", () => {
    getStore();
    assert.equal(unifiedKvActive(), true);
});

test("legacy file routes migrate into the kv table on boot hydration", async () => {
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ conv: { sessionId: "sess-1", lastSeen: Date.now() } }));
    _resetPluginStateForTest();
    _resetPluginConversationsUnifiedForTest();
    loadConversations(); // sync boot read (unchanged behavior)
    await hydratePluginConversationsUnified();

    const table = await kvTable();
    assert.deepEqual(table.conv, { sessionId: "sess-1", lastSeen: table.conv.lastSeen });
    assert.ok(table.conv, "route migrated into kv_store");
});

test("post-hydration routing survives restart via kv (memory + file both gone)", async () => {
    recordPluginSession("new-conv", "sess-new");
    await flushConversations();
    let table = await kvTable();
    assert.equal(table["new-conv"]?.sessionId, "sess-new", "flush wrote the kv table");

    // simulated restart: memory cleared, legacy file deleted
    _resetPluginStateForTest();
    _resetPluginConversationsUnifiedForTest();
    fs.rmSync(legacyFile, { force: true });
    await hydratePluginConversationsUnified();

    const r = resolveConversation("new-conv");
    assert.equal(r.entry?.sessionId, "sess-new", "route restored from kv with empty memory");
    table = await kvTable();
    assert.equal(Object.keys(table).length, 2, "both routes held in one row");

    // idempotent re-hydration does not churn the row
    const before = JSON.stringify(await getStore().getKvAsync("plugin-conversations", "table"));
    _resetPluginConversationsUnifiedForTest();
    _resetPluginStateForTest();
    await hydratePluginConversationsUnified();
    assert.equal(JSON.stringify(await getKvRow()), before, "idempotent hydration");
});

test("pre-hydrate recording falls back to the file, which hydration imports", async () => {
    _resetPluginStateForTest();
    _resetPluginConversationsUnifiedForTest();
    fs.rmSync(legacyFile, { force: true });
    recordPluginSession("early-conv", "sess-early");
    await new Promise((r) => setTimeout(r, 400)); // > 300ms debounce → file write
    assert.ok(fs.existsSync(legacyFile), "pre-hydration window used the legacy file");

    await hydratePluginConversationsUnified();
    const table = await kvTable();
    assert.equal(table["early-conv"]?.sessionId, "sess-early", "late import covered the early file write");
});

test("boot hydration enforces the LRU cap when merging an oversized file", async () => {
    const t0 = 1_000_000;
    const bulk: Record<string, { sessionId: string; lastSeen: number }> = {};
    for (let i = 0; i < 1030; i++) {
        const id = `bulk-${String(i).padStart(3, "0")}`;
        bulk[id] = { sessionId: id, lastSeen: t0 + i };
    }
    fs.writeFileSync(legacyFile, JSON.stringify(bulk));
    _resetPluginStateForTest();
    _resetPluginConversationsUnifiedForTest();
    loadConversations();
    await hydratePluginConversationsUnified();

    const table = await kvTable();
    assert.equal(Object.keys(table).length, 1024, "merged view capped at MAX_PLUGIN_CONVERSATIONS");
    assert.equal(table["bulk-000"], undefined, "oldest routes evicted from the front");
    assert.ok(table["bulk-1029"], "newest route (largest lastSeen) always survives the cap");
});

// helper placed after use for readability of the flow above
async function getKvRow(): Promise<unknown> {
    return getStore().getKvAsync("plugin-conversations", "table");
}
