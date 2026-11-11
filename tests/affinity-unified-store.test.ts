import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5753: prefix-affinity chains ride the unified storage (kv_store, namespace
// "prefix-affinity", row "v1") instead of prefix-affinity.json. Carrier rules
// identical to the session-order migration; the sync file hydrate at boot
// stays untouched for all modes.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-aff-"));
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, unifiedKvActive } = await import("../src/persist.js");
const { scheduleAffinityPersist, flushPrefixAffinity, hydrateAffinityUnified, _resetAffinityPersistForTest } = await import("../src/affinity-persist.js");
const { prefixAffinity } = await import("../src/prefix-affinity.js");

test("environment resolves to a unified (non-legacy) store", () => {
    getStore();
    assert.equal(unifiedKvActive(), true);
});

async function kvEntries(): Promise<Array<{ sessionId: string }>> {
    const doc = await getStore().getKvAsync("prefix-affinity", "v1");
    if (!doc || typeof doc !== "object" || !Array.isArray((doc as { entries?: unknown }).entries)) return [];
    return (doc as { entries: Array<{ sessionId: string }> }).entries;
}

test("legacy file chains migrate into the kv snapshot on first hydration", async () => {
    const t0 = Date.now();
    const legacyFile = path.join(root, "state", "billion-context", "prefix-affinity.json");
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, entries: [{ sessionId: "legacy-chain", depth: 3, tailHash: "aa".repeat(8), itemHashes: ["bb".repeat(8)], lastSeen: t0 }] }));
    _resetAffinityPersistForTest();
    await hydrateAffinityUnified();

    const entries = await kvEntries();
    assert.ok(entries.some((e) => e.sessionId === "legacy-chain"), "chain migrated into kv");
    assert.ok(prefixAffinity.exportSnapshot().some((e) => e.sessionId === "legacy-chain"), "hydrated into memory");
});

test("post-hydration writes land in kv and outlive the legacy file", async () => {
    const t1 = Date.now() + 1;
    const { prefixAffinity: pa } = await import("../src/prefix-affinity.js");
    pa.importSnapshot([{ sessionId: "fresh-chain", depth: 1, tailHash: "cc".repeat(8), itemHashes: ["dd".repeat(8)], lastSeen: t1 }]);
    await flushPrefixAffinity();

    let entries = await kvEntries();
    assert.ok(entries.some((e) => e.sessionId === "fresh-chain"), "flush wrote to kv_store");

    // simulated restart: caches gone, legacy file deleted — row must hold
    _resetAffinityPersistForTest();
    fs.rmSync(path.join(root, "state", "billion-context", "prefix-affinity.json"), { force: true });
    await hydrateAffinityUnified();
    entries = await kvEntries();
    assert.ok(entries.some((e) => e.sessionId === "fresh-chain"), "new chain present after restart hydration");
    assert.ok(entries.some((e) => e.sessionId === "legacy-chain"), "migrated chain survived the union");

    // idempotent re-hydration: no churn of the row
    const before = JSON.stringify(await getStore().getKvAsync("prefix-affinity", "v1"));
    _resetAffinityPersistForTest();
    await hydrateAffinityUnified();
    assert.equal(JSON.stringify(await getStore().getKvAsync("prefix-affinity", "v1")), before, "idempotent hydration");
});

test("pre-hydration mutations fall back to the file, which hydration then imports", async () => {
    _resetAffinityPersistForTest();
    fs.rmSync(path.join(root, "state", "billion-context", "prefix-affinity.json"), { force: true });
    const { prefixAffinity: pa } = await import("../src/prefix-affinity.js");
    pa.importSnapshot([{ sessionId: "early-chain", depth: 2, tailHash: "ee".repeat(8), itemHashes: ["ff".repeat(8)], lastSeen: Date.now() + 2 }]);
    scheduleAffinityPersist();
    await new Promise((r) => setTimeout(r, 700)); // debounce window → file write (no kv yet)
    assert.ok(fs.existsSync(path.join(root, "state", "billion-context", "prefix-affinity.json")), "pre-hydration window used the legacy file");

    await hydrateAffinityUnified();
    const entries = await kvEntries();
    assert.ok(entries.some((e) => e.sessionId === "early-chain"), "late import covered the early file write");
});
