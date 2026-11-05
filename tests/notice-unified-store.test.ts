import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5548: notice dismissal receipts ride the unified storage (kv_store,
// namespace "notices") instead of upgrade-notices.json — owner ruling 2026-11-03.
// Hermetic: BILI_SESSIONS_DIR relocates the sidecar index.db into a temp tree,
// XDG_STATE_HOME isolates the legacy JSON fallback. Every gate asserts both
// directions (triggers when it should, NOT when it should not — #3617).

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-noticestore-"));
// CI's storage-baseline preload forces BILI_STORAGE_UNIFIED=legacy for the
// broad corpus; this suite pins its own carrier like the storage family does
// (tests/bounded-storage.test.ts precedent) — it asserts kv_store semantics,
// which require full mode.
process.env.BILI_STORAGE_UNIFIED = "full";
process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
process.env.XDG_STATE_HOME = path.join(root, "state");
process.env.XDG_CACHE_HOME = path.join(root, "cache");

const { getStore, unifiedKvActive } = await import("../src/persist.js");
const { hydrateNoticeReceipts, _resetNoticeReceiptsForTest, addDismissedKeyInMemory, dismissedCache, isValidDismissKey, MAX_DISMISSED_KEYS } = await import("../src/notice-store.js");
const { PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, dismissUpgradeNotice, dismissedUpgradeNotices } = await import("../src/pck-notice.js");

const stateBili = path.join(root, "state", "billion-context");

test("environment resolves to a unified (non-legacy) store", () => {
    getStore(); // force singleton creation at the relocated dir
    assert.equal(unifiedKvActive(), true);
});

test("hydrate imports legacy file keys into kv exactly once", async () => {
    fs.mkdirSync(stateBili, { recursive: true });
    const legacyKey = "old-local@0123456789abcdef";
    fs.writeFileSync(path.join(stateBili, "upgrade-notices.json"), JSON.stringify({ dismissed: [WM_FASTPATH_INTRO_ID, legacyKey] }, null, 2));
    _resetNoticeReceiptsForTest();
    await hydrateNoticeReceipts();

    const rows = await getStore().listKvAsync("notices");
    assert.deepEqual(rows.map((r) => r.key).sort(), [legacyKey, WM_FASTPATH_INTRO_ID].sort());

    const seen = dismissedUpgradeNotices();
    assert.ok(seen.has(WM_FASTPATH_INTRO_ID), "migrated built-in intro id visible");
    assert.ok(seen.has(legacyKey), "migrated hashed key visible");

    // re-hydrate is a no-op (no duplicate work, cache survives)
    await hydrateNoticeReceipts();
    const again = await getStore().listKvAsync("notices");
    assert.equal(again.length, rows.length, "idempotent — no re-import churn");
});

test("dismissal persists across a simulated process restart (cache drop + re-hydrate)", async () => {
    assert.equal(dismissUpgradeNotice(PCK_NOTICE_ID), true);
    assert.ok(dismissedUpgradeNotices().has(PCK_NOTICE_ID));
    // next process: fresh caches, same volume
    _resetNoticeReceiptsForTest();
    assert.equal(dismissedCache(), null);
    await hydrateNoticeReceipts();
    assert.ok(dismissedUpgradeNotices().has(PCK_NOTICE_ID), "receipt survived the restart via kv");
});

test("unknown ids stay rejected on every carrier", async () => {
    assert.equal(dismissUpgradeNotice("foreign-id"), false);
    assert.equal(dismissUpgradeNotice("FOREIGN@0123456789abcdef"), false, "hash shape is case-locked");
    assert.ok(!dismissedUpgradeNotices().has("foreign-id"));
});

test("cap trims oldest non-builtin keys only; built-ins survive", async () => {
    for (let i = 0; i < MAX_DISMISSED_KEYS - 1; i++) {
        assert.equal(isValidDismissKey(`pad-${i}@${"f".repeat(16)}`), true);
        dismissUpgradeNotice(`pad-${i}@${"f".repeat(16)}`);
    }
    // one more push goes over the cap → synchronous eviction must hold the bound
    assert.equal(dismissUpgradeNotice(`overflow@${"e".repeat(16)}`), true);
    const set = dismissedUpgradeNotices();
    assert.ok(set.size <= MAX_DISMISSED_KEYS, `size ${set.size} within cap`);
    assert.ok(set.has(PCK_NOTICE_ID), "built-in protected from trim");
    assert.ok(set.has(`overflow@${"e".repeat(16)}`), "newest key kept");
    assert.ok(!set.has(WM_FASTPATH_INTRO_ID) || !set.has("old-local@0123456789abcdef"), "oldest hashed key evicted first");
    // NOT when under the cap: nothing trims
    _resetNoticeReceiptsForTest();
    const two: string[] = [];
    for (let i = 0; i < 2; i++) {
        const k = `small-${i}@${"a".repeat(16)}`;
        two.push(k);
        addDismissedKeyInMemory(k);
    }
    const small = dismissedCache()!;
    for (const k of two) assert.ok(small.has(k), "under-cap keys all retained");
});

// #5761: a dismissal landing BEFORE the boot hydration lazily created the
// cache, which made the hydrate bail — blocking the one-time file→kv
// migration (and hiding sibling lanes' rows) for the process lifetime.
// Twin of the #5757 host-plugin regression case.
test("a pre-hydration dismissal no longer blocks the migration", async () => {
    try { fs.rmSync(path.join(stateBili, "upgrade-notices.json")); } catch { /* fresh volume */ }
    _resetNoticeReceiptsForTest();

    // the admin action lands before cli-start hydration has run — the lazy
    // adoption sees an EMPTY file, so nothing below can come from it:
    assert.equal(dismissUpgradeNotice(WM_FASTPATH_INTRO_ID), true);
    const lateKey = `late-file@${"b".repeat(16)}`;
    fs.mkdirSync(stateBili, { recursive: true });
    fs.writeFileSync(path.join(stateBili, "upgrade-notices.json"), JSON.stringify({ dismissed: [WM_FASTPATH_INTRO_ID, lateKey] }, null, 2));
    await new Promise((r) => setTimeout(r, 50)); // let the queued receipt land in kv
    await hydrateNoticeReceipts();

    const seen = dismissedUpgradeNotices();
    assert.ok(seen.has(WM_FASTPATH_INTRO_ID), "the pre-dismissed id stays visible");
    assert.ok(seen.has(lateKey), "hydration ran despite the pre-existing lazy cache");
    const rows = await getStore().listKvAsync("notices");
    assert.ok(rows.some((r) => r.key === WM_FASTPATH_INTRO_ID), "receipt landed in kv_store");
    assert.ok(rows.some((r) => r.key === lateKey), "one-time migration ran despite the pre-existing lazy cache");
});

// #5761 variant: a dismissal landing inside the hydrate's await gap used to
// be clobbered by the final cache assignment until restart. The publish must
// fold in everything added up to it. Both KV directions are gated so the
// dismissal's own durable write cannot land before the list resolves —
// otherwise the old code would re-derive the key from kv and mask the loss.
test("a dismissal landing during hydration survives the final publish", async () => {
    try { fs.rmSync(path.join(stateBili, "upgrade-notices.json")); } catch { /* fresh volume */ }
    _resetNoticeReceiptsForTest();
    const store = getStore();
    const origList = store.listKvAsync.bind(store);
    const origSet = store.setKvAsync.bind(store);
    let releaseList: () => void = () => undefined;
    let releaseSet: () => void = () => undefined;
    const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
    const setGate = new Promise<void>((resolve) => { releaseSet = resolve; });
    store.listKvAsync = async (ns?: string, prefix?: string) => {
        await listGate;
        return origList(ns, prefix);
    };
    store.setKvAsync = async (ns: string, key: string, value: unknown) => {
        await setGate;
        return origSet(ns, key, value);
    };
    const hydr = hydrateNoticeReceipts();
    await new Promise((r) => setTimeout(r, 20)); // park the hydrate inside the gated list
    const midKey = `mid-hydrate@${"c".repeat(16)}`;
    assert.equal(dismissUpgradeNotice(midKey), true); // memory now, durable write parked on setGate
    releaseList(); // list resolves WITHOUT midKey — only the live-cache union can save it
    await hydr;
    store.listKvAsync = origList;
    store.setKvAsync = origSet;
    releaseSet();
    const seen = dismissedUpgradeNotices();
    assert.ok(seen.has(midKey), "mid-hydration dismissal survived the final publish");
});
