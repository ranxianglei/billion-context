import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5753: the rollout install id rides the unified storage (kv_store,
// namespace "rollout", key "install-id"); the legacy file remains ONLY as
// cross-process bootstrap for brand-new installs and as sole carrier on
// legacy-only instances. Hermetic like the notice suite.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-rollout-"));
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, unifiedKvActive } = await import("../src/persist.js");
const { rolloutInstallId, hydrateRolloutIdentity, _resetRolloutIdentityForTest } = await import("../src/rollout.js");

const idFile = path.join(root, "state", "billion-context", "rollout-id.json");

async function kvId(): Promise<string | null> {
    const doc = await getStore().getKvAsync("rollout", "install-id");
    const v = doc && typeof doc === "object" ? (doc as { id?: unknown }).id : undefined;
    return typeof v === "string" ? v : null;
}

test("environment resolves to a unified (non-legacy) store", () => {
    getStore();
    assert.equal(unifiedKvActive(), true);
});

test("first boot imports a pre-existing legacy file into kv once", async () => {
    // seed the legacy file BEFORE any in-process generation happens
    assert.ok(!fs.existsSync(idFile), "clean temp tree");
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    fs.writeFileSync(idFile, JSON.stringify({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, null, 2) + "\n");
    await hydrateRolloutIdentity();
    assert.equal(await kvId(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "file row migrated into kv");
    assert.equal(rolloutInstallId(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("the id survives legacy-file deletion (kv is primary after migration)", async () => {
    // simulated restart: drop process caches, then the bootstrap artifact
    _resetRolloutIdentityForTest();
    await hydrateRolloutIdentity();
    fs.rmSync(idFile);
    assert.equal(rolloutInstallId(), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "adopted from kv without the file");
});

test("brand-new install bootstraps via wx file race, then mirrors to kv", async () => {
    // wipe both carriers — this models a truly fresh install
    fs.rmSync(idFile, { force: true });
    await getStore().deleteKvAsync("rollout", "install-id");
    _resetRolloutIdentityForTest();
    await hydrateRolloutIdentity();

    const fresh = rolloutInstallId();
    assert.match(fresh, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "fresh UUID generated");
    assert.notEqual(fresh, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "new identity, not the old row");
    assert.ok(fs.existsSync(idFile), "bootstrap file written for the cross-process race");
    // the mirror write is fire-and-forget — give it a moment
    for (let i = 0; i < 40 && (await kvId()) !== fresh; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(await kvId(), fresh, "settled id mirrored into kv");

    // restart: kv alone answers now
    _resetRolloutIdentityForTest();
    fs.rmSync(idFile);
    await hydrateRolloutIdentity();
    assert.equal(rolloutInstallId(), fresh, "stable across restarts via kv");
});

// #5757: tests/snapshot-render-chain.test.ts installs a PARTIAL store stub
// (tail-view methods only, no unified KV) and drives the hot path through
// featureEnabled → rolloutInstallId. Before the kvStore() gate, any
// unified-mode caller crashed with "setKvAsync is not a function" — exactly
// what killed both windows CI shards.
test("partial store stubs degrade to the file path instead of crashing", async () => {
    const { _setStoreForTest, _resetStoreForTest } = await import("../src/persist.js");
    const partialStub = { unifiedTailSeqs: () => [], closeQuietly: () => {} };
    _setStoreForTest(partialStub as unknown as ReturnType<typeof getStore>);
    let got = "";
    try {
        got = rolloutInstallId(); // must NOT throw against a KV-less store
    } finally {
        _resetStoreForTest(); // restore the env-pinned singleton for later runs
    }
    assert.match(got, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "id still served from the legacy carrier");
});
