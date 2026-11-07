/**
 * #4609: verdict cache + background quick_check.
 *
 *   1. sync path (small store, cache miss): open() checks before migrations,
 *      writes index.db.chk, and close() refreshes the key — the second
 *      open must NOT recheck (counter stays put).
 *   2. any stat change (mtime bump) invalidates the cache → recheck.
 *   3. cached failure → open throws StorageIntegrityError (the #4175
 *      loud-degrade trigger: files stay where they are, next open fails fast)
 *      without rescanning.
 *   4. large store (threshold overridden to 1 byte): open returns without
 *      blocking; a worker-thread check completes in the background, writes
 *      the cache, and the counter reaches 1.
 *   5. BILI_STORAGE_QUICK_CHECK=0: no check, no cache IO.
 *   6. corrupt small store still throws synchronously (cache or no cache).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnifiedStore, StorageIntegrityError } from "../src/storage/store.js";
import { setLogCapture } from "../src/logger.ts";
import {
    integrityCachePath,
    readIntegrityCache,
    resetIntegrityCheckStateForTests,
    integrityCheckRunsForTests,
    setIntegritySyncThresholdForTests,
    backgroundIntegrityInflightForTests,
} from "../src/storage/integrity-check.js";

function tmpDir(): string {
    return mkdtempSync(join(tmpdir(), "bili-integrity-"));
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return predicate();
}

test("sync check writes the verdict cache; a reopen on an unchanged file set skips the rescan", () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath);
        assert.equal(integrityCheckRunsForTests(), 1, "first open ran the sync check");
        assert.ok(existsSync(integrityCachePath(dbPath)), "verdict cache written");
        const cache = readIntegrityCache(dbPath);
        assert.ok(cache !== null && cache.ok === true, "cache holds the ok verdict");
        store.close();
        // close() refreshed the cache onto post-close stats — the second
        // open is a cache hit and must not recheck.
        const again = UnifiedStore.open(dbPath);
        assert.equal(integrityCheckRunsForTests(), 1, "cache hit skipped the rescan");
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("touching the db file invalidates the cache and forces a recheck", () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath);
        store.close();
        const before = integrityCheckRunsForTests();
        utimesSync(dbPath, new Date(), new Date(Date.now() + 5000));
        const again = UnifiedStore.open(dbPath);
        assert.equal(integrityCheckRunsForTests(), before + 1, "changed mtime forced a recheck");
        again.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a STALE cached FAIL (older-version leftover) no longer blocks boots — fresh rescan decides (#4609/#5123)", () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath);
        store.close(); // cache now holds ok for the closed file set
        const cache = readIntegrityCache(dbPath);
        assert.ok(cache !== null);
        writeFileSync(integrityCachePath(dbPath), JSON.stringify({ ...cache, ok: false, detail: "simulated older-version failure" }));
        // Owner policy 2026-10-30: runtime/background findings are alarms, never
        // boot-blockers. A FAIL verdict left by an OLDER build is treated as a
        // plain cache miss: loud warn, then a FRESH scan decides.
        const before = integrityCheckRunsForTests();
        let warned = "";
        setLogCapture((_level, m) => { if (m.includes("stale verdicts no longer block boots")) warned = m; });
        try {
            const again = UnifiedStore.open(dbPath);
            again.close();
        } finally {
            setLogCapture(null);
        }
        assert.ok(warned.length > 0, "the stale FAIL must be called out loudly in the log");
        assert.equal(integrityCheckRunsForTests(), before + 1, "a fresh scan ran instead of trusting the old verdict");
        const after = readIntegrityCache(dbPath);
        assert.equal(after?.ok, true, "the healthy file set re-cached a PASS verdict (fast path restored)");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a large store (threshold overridden) checks in the background without blocking open", async () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(1); // every store is "large"
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath); // must return immediately — an empty store's worker may already be done
        const done = await waitFor(() => !backgroundIntegrityInflightForTests(dbPath) && existsSync(integrityCachePath(dbPath)), 15000);
        assert.ok(done, "background check completed within 15s");
        assert.equal(integrityCheckRunsForTests(), 1, "exactly one background check ran");
        const cache = readIntegrityCache(dbPath);
        assert.ok(cache !== null && cache.ok === true, "background verdict cached as ok");
        store.close();
    } finally {
        setIntegritySyncThresholdForTests(null);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("BILI_STORAGE_QUICK_CHECK=0 skips the check and all cache IO", () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    const prev = process.env.BILI_STORAGE_QUICK_CHECK;
    process.env.BILI_STORAGE_QUICK_CHECK = "0";
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath);
        assert.equal(integrityCheckRunsForTests(), 0, "env opt-out ran no check");
        assert.ok(!existsSync(integrityCachePath(dbPath)), "no cache written");
        store.close();
        assert.ok(!existsSync(integrityCachePath(dbPath)), "close wrote no cache under the opt-out");
    } finally {
        if (prev === undefined) delete process.env.BILI_STORAGE_QUICK_CHECK;
        else process.env.BILI_STORAGE_QUICK_CHECK = prev;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a corrupt small store still fails open synchronously and writes no ok-cache", () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        writeFileSync(dbPath, Buffer.from("this is definitely not a sqlite database file, not even close"));
        assert.throws(() => UnifiedStore.open(dbPath), /quick_check|integrity|not a database|SQLite/i);
        const cache = readIntegrityCache(dbPath);
        assert.ok(cache === null || cache.ok === false, "no ok verdict cached for a corrupt store");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
