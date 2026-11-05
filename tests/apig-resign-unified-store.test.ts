import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5753: the apig-resign pending-refusal map rides the unified storage
// (kv_store, namespace "resign-pending", single row "pending" holding the
// whole map) instead of resign-pending.json. Hermetic like the notice suite.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-resign-"));
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, unifiedKvActive } = await import("../src/persist.js");
const { hydrateResignPending, recordSignedRefusal, clearSignedRefusal, readPendingRefusals, flushResignPending, _resetResignPendingForTest } = await import("../src/apig-resign.js");

const stateBili = path.join(root, "state", "billion-context");
const legacyFile = path.join(stateBili, "resign-pending.json");

async function kvPending(): Promise<Record<string, { count: number; lastSeen: string }>> {
    const doc = await getStore().getKvAsync("resign-pending", "pending");
    return doc && typeof doc === "object" ? (doc as Record<string, { count: number; lastSeen: string }>) : {};
}

test("environment resolves to a unified (non-legacy) store", () => {
    getStore();
    assert.equal(unifiedKvActive(), true);
});

test("hydrate imports the legacy file into the kv row exactly once", async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString();
    fs.mkdirSync(stateBili, { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({
        "old-scheme": { origin: "https://up.example", firstSeen: t0, lastSeen: t0, count: 3 },
    }, null, 2));
    _resetResignPendingForTest();
    await hydrateResignPending();

    const kv = await kvPending();
    assert.equal(kv["old-scheme"]?.count, 3, "legacy entry migrated into kv");
    assert.ok(readPendingRefusals()["old-scheme"], "hydrated view serves it");

    // idempotent: re-hydrate does not churn the row
    _resetResignPendingForTest();
    await hydrateResignPending();
    const again = await kvPending();
    assert.equal(again["old-scheme"]?.count, 3, "no re-import drift");
});

test("record + clear persist across a simulated process restart", async () => {
    // let time move so lastSeen ordering is unambiguous
    await new Promise((r) => setTimeout(r, 5));
    recordSignedRefusal("new-scheme", "https://api.example/v1/chat");
    recordSignedRefusal("UPPER-Scheme", "https://other.example/x");
    await flushResignPending(); // settle the chained kv RMWs
    assert.equal(readPendingRefusals()["upper-scheme"]?.origin, "https://other.example", "scheme normalized lowercase");

    clearSignedRefusal("new-scheme");
    await flushResignPending();

    // next process: caches gone, same volume; the legacy file stays inert
    _resetResignPendingForTest();
    await hydrateResignPending();
    const seen = readPendingRefusals();
    assert.ok(seen["upper-scheme"], "recorded refusal survived via kv");
    assert.ok(!seen["new-scheme"], "cleared scheme stayed cleared");
    assert.ok(seen["old-scheme"], "earlier migrated entry still present");
});

test("cap trims oldest-first-seen schemes once over budget", async () => {
    // budget is 32 entries; push 34 fresh schemes through the unified path
    const base = Date.now();
    for (let i = 0; i < 34; i++) {
        recordSignedRefusal(`cap-${String(i).padStart(2, "0")}`, "https://cap.example/i");
        await new Promise((r) => setTimeout(r, 1));
    }
    const p = readPendingRefusals();
    assert.ok(Object.keys(p).length <= 32, `size ${Object.keys(p).length} within cap`);
    assert.ok(p["cap-33"], "newest kept");
    assert.ok(!p["cap-00"], "oldest evicted");
});

test("late file schemes still migrate when the kv row already holds other schemes", async () => {
    // models the cross-lane drift window: a legacy-only sibling keeps writing
    // the file while this instance's kv row is non-empty.
    recordSignedRefusal("kv-resident", "https://resident.example/r");
    await flushResignPending();
    const t1 = new Date().toISOString();
    fs.writeFileSync(legacyFile, JSON.stringify({
        "late-scheme": { origin: "https://late.example", firstSeen: t1, lastSeen: t1, count: 1 },
    }, null, 2));
    _resetResignPendingForTest();
    await hydrateResignPending();

    const kv = await kvPending();
    assert.ok(kv["late-scheme"], "file-only scheme migrated despite a non-empty kv row");
    assert.ok(kv["kv-resident"], "existing kv entries untouched by the late import");
    assert.ok(readPendingRefusals()["late-scheme"], "hydrated view serves the late entry");
});
