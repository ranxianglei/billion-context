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
import { spawn } from "node:child_process";
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

test("malformed verdict records are cache misses", () => {
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath);
        store.close();
        const valid = readIntegrityCache(dbPath);
        assert.ok(valid !== null);
        const malformed: unknown[] = [
            null,
            [],
            { v: 1, ok: true },
            { ...valid, db: null },
            { ...valid, db: [] },
            { ...valid, db: { ...valid.db, s: -1 } },
            { ...valid, db: { ...valid.db, s: "0" } },
            { ...valid, db: { ...valid.db, m: null } },
            { ...valid, wal: {} },
            { ...valid, wal: { s: 1, m: "today" } },
            { ...valid, schema: "11" },
            { ...valid, at: null },
            { ...valid, detail: {} },
        ];
        for (const value of malformed) {
            writeFileSync(integrityCachePath(dbPath), JSON.stringify(value));
            assert.equal(readIntegrityCache(dbPath), null, JSON.stringify(value));
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a damaged verdict cache cannot prevent a healthy store from reopening", () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath);
        store.setKv("test", "kept", { message: "still here" });
        store.close();
        const before = integrityCheckRunsForTests();
        writeFileSync(integrityCachePath(dbPath), JSON.stringify({ v: 1, ok: true, db: null }));

        const again = UnifiedStore.open(dbPath);
        try {
            assert.deepEqual(again.getKv("test", "kept"), { message: "still here" });
            assert.equal(integrityCheckRunsForTests(), before + 1);
        } finally {
            again.close();
        }
        assert.equal(readIntegrityCache(dbPath)?.ok, true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// #7156: the close-time cache refresh used to be unconditional on
// lastIntegrityOk — a process that booted healthy (cache hit or sync ok) but
// whose file was then corrupted by a CONCURRENT second writer (the incident:
// a wedged predecessor still holding index.db when its replacement opened it)
// stamped a FRESH "ok" verdict onto the corrupted stats at close, so every
// later boot hit the poisoned cache, skipped the rescan, and died on the
// first write. The refresh is now gated on there being no live foreign
// writer: with one present, close() leaves the verdict untouched so the next
// boot re-scans fresh.
test("close skips the integrity-cache refresh while a live foreign writer holds the lock (#7156)", { timeout: 30_000 }, async (t) => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    // A live foreign process whose pid we plant in <db>.lock BEFORE open —
    // the #7156 shape (a predecessor still holding index.db when the
    // replacement boots). open() captures it as the foreign lock holder,
    // then overwrites the file with its own pid.
    const holder = spawn(process.execPath, ["--input-type=module", "-e", "setTimeout(() => {}, 30000);"], { stdio: "ignore" });
    t.after(() => { try { holder.kill("SIGKILL"); } catch { /* gone */ } });
    await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const tick = () => {
            if (holder.pid !== undefined) return resolve();
            if (Date.now() > deadline) return reject(new Error("holder pid never assigned"));
            setTimeout(tick, 10);
        };
        tick();
    });
    try {
        const dbPath = join(dir, "index.db");
        writeFileSync(dbPath + ".lock", JSON.stringify({ pid: holder.pid, boot: Date.now() }));
        let skipping = "";
        let bootCache: { at: number; ok: boolean } | null = null;
        setLogCapture((level, m) => { if (level === "info" && m.includes("skipping the close-time integrity-cache refresh")) skipping = m; });
        try {
            const store = UnifiedStore.open(dbPath);
            bootCache = readIntegrityCache(dbPath);
            assert.ok(bootCache !== null && bootCache.ok === true, "boot cached an ok verdict");
            store.setKv("test", "key", { x: 1 }); // a write — lands in the -wal
            await new Promise((r) => setTimeout(r, 30)); // separate the boot/close timestamps
            store.close();
        } finally {
            setLogCapture(null);
        }
        assert.ok(skipping.length > 0, "close() reported skipping the cache refresh for the live foreign writer");
        const afterClose = readIntegrityCache(dbPath);
        assert.ok(afterClose !== null, "the boot-time verdict is still present (not clobbered)");
        assert.equal(afterClose.at, bootCache!.at, "the verdict still carries the BOOT timestamp — close() did not refresh it onto post-checkpoint stats");
    } finally {
        setIntegritySyncThresholdForTests(null);
        rmSync(dir, { recursive: true, force: true });
    }
});

// Control: with NO foreign writer, close() still refreshes the cache onto the
// post-checkpoint stats (the #4609 fast path is preserved — the gate must not
// regress the normal single-writer case).
test("close still refreshes the integrity cache when no foreign writer is present (#7156 control)", { timeout: 30_000 }, async () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath);
        const bootCache = readIntegrityCache(dbPath);
        assert.ok(bootCache !== null && bootCache.ok === true, "boot cached an ok verdict");
        store.setKv("test", "key", { x: 1 });
        await new Promise((r) => setTimeout(r, 30));
        store.close();
        const afterClose = readIntegrityCache(dbPath);
        assert.ok(afterClose !== null, "the verdict is present after close");
        assert.ok(afterClose.at > bootCache!.at, "close() refreshed the verdict onto the post-checkpoint stats (fast path preserved)");
    } finally {
        setIntegritySyncThresholdForTests(null);
        rmSync(dir, { recursive: true, force: true });
    }
});
