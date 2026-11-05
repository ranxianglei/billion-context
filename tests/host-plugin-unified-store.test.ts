import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5753: host-plugin dismissal receipts ride the unified storage (kv_store,
// namespace "host-plugins") instead of host-plugin-notices.json — twin of
// #5548's upgrade-notice migration, same carrier rules. Hermetic like the
// notice suite: sessions dir relocated to a temp tree, full mode pinned.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-hpnotice-"));
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, unifiedKvActive } = await import("../src/persist.js");
const { hydrateHostPluginDismissals, dismissHostPlugin, dismissedHostPlugins, _resetHostPluginDismissalsForTest } = await import("../src/host-plugin-notice.js");

const stateBili = path.join(root, "state", "billion-context");
const legacyFile = path.join(stateBili, "host-plugin-notices.json");

test("environment resolves to a unified (non-legacy) store", () => {
    getStore();
    assert.equal(unifiedKvActive(), true);
});

test("hydrate imports known legacy ids into kv exactly once", async () => {
    fs.mkdirSync(stateBili, { recursive: true });
    // one known id + one junk string that is NOT a host-plugin id
    fs.writeFileSync(legacyFile, JSON.stringify({ dismissed: ["dsh-context", "junk-string"] }, null, 2));
    _resetHostPluginDismissalsForTest();
    await hydrateHostPluginDismissals();

    const rows = await getStore().listKvAsync("host-plugins");
    assert.deepEqual(rows.map((r) => r.key), ["dsh-context"], "known id migrated; junk stays file-only");

    const seen = dismissedHostPlugins();
    assert.ok(seen.has("dsh-context"), "migrated id visible");
    assert.ok(seen.has("junk-string"), "file-only junk still honored by the view");

    // re-hydrate is a no-op — no duplicate work
    _resetHostPluginDismissalsForTest();
    await hydrateHostPluginDismissals();
    const again = await getStore().listKvAsync("host-plugins");
    assert.equal(again.length, rows.length, "idempotent — no re-import churn");
});

test("dismissal persists across a simulated process restart (cache drop + re-hydrate)", async () => {
    assert.equal(dismissHostPlugin("dsh-context"), true);
    // let the fire-and-forget kv write settle
    await new Promise((r) => setTimeout(r, 50));
    // next process: fresh caches, same volume; the legacy file is inert here
    _resetHostPluginDismissalsForTest();
    await hydrateHostPluginDismissals();
    assert.ok(dismissedHostPlugins().has("dsh-context"), "receipt survived the restart via kv");
});

test("a unified instance never writes the legacy file after hydration", async () => {
    const before = fs.existsSync(legacyFile) ? fs.statSync(legacyFile).mtimeMs : 0;
    assert.equal(dismissHostPlugin("dsh-context"), true);
    await new Promise((r) => setTimeout(r, 50));
    const after = fs.existsSync(legacyFile) ? fs.statSync(legacyFile).mtimeMs : 0;
    assert.equal(after, before, "no new file write post-hydration");
    const rows = await getStore().listKvAsync("host-plugins");
    assert.ok(rows.some((r) => r.key === "dsh-context"), "receipt landed in kv_store");
});

test("unknown ids stay rejected on every carrier", () => {
    assert.equal(dismissHostPlugin("foreign-id"), false);
    _resetHostPluginDismissalsForTest();
    assert.ok(!dismissedHostPlugins().has("foreign-id"));
});

// #5757 review fix: a dismissal landing BEFORE the boot hydration used to
// lazily create the cache, which made the hydrate bail — blocking the
// one-time file→kv migration (and hiding sibling rows) for the process
// lifetime. The hydrate must run and union instead.
test("a pre-hydration dismissal no longer blocks the migration", async () => {
    try { fs.rmSync(legacyFile); } catch { /* fresh volume */ }
    await getStore().deleteKvAsync("host-plugins", "dsh-context");
    _resetHostPluginDismissalsForTest();

    // the admin action lands before cli-start hydration has run:
    assert.equal(dismissHostPlugin("dsh-context"), true);
    // meanwhile the file carries known + file-only content: hydrate must fold
    // it in (and the kv row from the dismiss above must survive the union)
    fs.mkdirSync(stateBili, { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({ dismissed: ["dsh-context", "junk-pre-hydration"] }, null, 2));
    await new Promise((r) => setTimeout(r, 50)); // let the queued receipt land in kv
    await hydrateHostPluginDismissals();

    const seen = dismissedHostPlugins();
    assert.ok(seen.has("dsh-context"), "the dismissed id is still visible");
    assert.ok(seen.has("junk-pre-hydration"), "hydration ran despite the pre-existing lazy cache");
    const rows = await getStore().listKvAsync("host-plugins");
    assert.ok(rows.some((r) => r.key === "dsh-context"), "receipt landed in kv_store");
});
