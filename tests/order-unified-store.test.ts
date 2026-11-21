import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5753: session-order skeletons ride the unified storage (kv_store, namespace
// "session-order", row "v1") instead of session-order.json. The sync boot
// hydrate (file warm-up, pre-routing by raw key) stays; this suite covers the
// async kv overlay: one-time migration, kv-primary survival, both directions
// of the gate (the file direction is pinned-legacy under the CI corpus).

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-order-"));
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, unifiedKvActive } = await import("../src/persist.js");
const { scheduleOrderPersist, flushOrderSkeletons, hydrateOrderUnified, _resetOrderPersistForTest } = await import("../src/order-persist.js");
const { orderSnapshot, resetSessionOrderForTest } = await import("../src/session-resolve.js");

const legacyFile = path.join(root, "state", "billion-context", "session-order.json");

async function kvRow(): Promise<{ version: number; entries: Array<Record<string, unknown>> }> {
    const doc = await getStore().getKvAsync("session-order", "v1");
    return doc as { version: number; entries: Array<Record<string, unknown>> };
}

test("environment resolves to a unified (non-legacy) store", () => {
    getStore();
    assert.equal(unifiedKvActive(), true);
});

test("legacy file rows migrate into the kv snapshot on first hydration", async () => {
    const t0 = Date.now();
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, entries: [{ id: "legacy-skel", kinds: ["acp"], frags: ["f0"], tagHash: "th0", lastSeen: t0 }] }));
    _resetOrderPersistForTest();
    await hydrateOrderUnified();

    const row = await kvRow();
    assert.ok(row?.entries.some((e) => e.id === "legacy-skel"), "skeleton migrated into kv");
    assert.ok(orderSnapshot().some((e) => e.id === "legacy-skel"), "hydrated into memory");
});

test("post-hydration writes land in kv and survive the legacy file's deletion", async () => {
    const t1 = Date.now() + 1;
    // record a new skeleton in memory, then flush through the unified path
    const { applyOrderSnapshot } = await import("../src/session-resolve.js");
    applyOrderSnapshot([{ id: "fresh-skel", kinds: ["acp"], frags: ["g0"], tagHash: "th1", lastSeen: t1 }]);
    await flushOrderSkeletons();

    let row = await kvRow();
    assert.ok(row.entries.some((e) => e.id === "fresh-skel"), "flush wrote to kv_store");

    // simulated restart: caches gone, bootstrap file gone, MEMORY WIPED —
    // the skeletons can only come back through the kv row.
    _resetOrderPersistForTest();
    fs.rmSync(legacyFile, { force: true });
    resetSessionOrderForTest();
    await hydrateOrderUnified();
    const ids = new Set(orderSnapshot().map((e) => e.id));
    assert.ok(ids.has("fresh-skel"), "new skeleton survived via kv");
    assert.ok(ids.has("legacy-skel"), "migrated skeleton still present after union");

    // no re-import churn: hydrating again does not grow or rewrite the row
    const before = JSON.stringify(await kvRow());
    _resetOrderPersistForTest();
    await hydrateOrderUnified();
    assert.equal(JSON.stringify(await kvRow()), before, "idempotent hydration");
});

test("pre-hydration mutations fall back to the file, which hydration then imports", async () => {
    _resetOrderPersistForTest();
    fs.rmSync(legacyFile, { force: true });
    const { applyOrderSnapshot } = await import("../src/session-resolve.js");
    applyOrderSnapshot([{ id: "early-bird", kinds: ["api"], frags: ["h0"], tagHash: "th2", lastSeen: Date.now() + 2 }]);
    scheduleOrderPersist();
    await new Promise((r) => setTimeout(r, 700)); // debounce window → file write (no kv yet)
    assert.ok(fs.existsSync(legacyFile), "pre-hydration window used the legacy file");

    await hydrateOrderUnified();
    const row = await kvRow();
    assert.ok(row.entries.some((e) => e.id === "early-bird"), "late import covered the early file write");
    assert.ok(orderSnapshot().some((e) => e.id === "early-bird"));
});

// #6255: the KV carrier rejects extension values over 4 MiB, but the producer
// used its 8 MiB legacy-file budget for KV writes — so a large snapshot made
// the one-time migration throw, demoted the process to the legacy file path
// forever, and the byte budget (unsorted) dropped the newest conversations.
// Pin both directions: migration AND steady-state writes stay within the KV
// ceiling and keep the newest skeletons.
test("unified order migration and writes keep newest skeletons within the KV byte budget", async (t) => {
    _resetOrderPersistForTest();
    resetSessionOrderForTest();
    const kinds = Array.from({ length: 4_000 }, (_, i) => i % 2 === 0 ? "user" : "assistant");
    const frags = Array.from({ length: 4_000 }, () => "a".repeat(64));
    const entries = Array.from({ length: 40 }, (_, i) => ({
        id: `unified-byte-budget-${i}`, kinds, frags, tagHash: "b".repeat(64), lastSeen: 1_000 + i,
    }));
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, entries }));
    await getStore().setKvAsync("session-order", "v1", { version: 1, entries: [] });
    await hydrateOrderUnified();
    const row = await kvRow();
    assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 4 * 1024 * 1024, "migrated KV row respects the store ceiling");
    assert.ok(row.entries.length > 0 && row.entries.length < entries.length);
    const expected = [...entries].reverse().slice(0, row.entries.length).map((e) => e.id);
    assert.deepEqual(row.entries.map((e) => e.id), expected);
    _resetOrderPersistForTest();
    resetSessionOrderForTest();
    fs.rmSync(legacyFile, { force: true });
    await hydrateOrderUnified();
    assert.deepEqual(orderSnapshot().map((e) => e.id), expected, "newest chains survive with only the KV carrier remaining");

    const { applyOrderSnapshot } = await import("../src/session-resolve.js");
    applyOrderSnapshot([{ ...entries[0], id: "newest-after-migration", lastSeen: 2_000 }]);
    const store = getStore();
    const write = store.setKvAsync.bind(store);
    let written!: () => void;
    const completed = new Promise<void>((resolve) => { written = resolve; });
    t.mock.method(store, "setKvAsync", async (namespace: string, key: string, value: unknown) => {
        await write(namespace, key, value);
        if (namespace === "session-order" && key === "v1") written();
    });
    await flushOrderSkeletons();
    await completed;
    const updated = await kvRow();
    assert.equal(updated.entries[0]?.id, "newest-after-migration");
    assert.ok(Buffer.byteLength(JSON.stringify(updated)) <= 4 * 1024 * 1024, "steady-state KV write stays under the ceiling");
});
