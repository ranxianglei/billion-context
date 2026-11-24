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
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync, utimesSync } from "node:fs";
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
import { DatabaseSync } from "node:sqlite";

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

// #7156 review: the poisoning window is WIDER than the close-time refresh —
// the boot-time scan itself races a live foreign writer (the incident's .chk
// ok at 19:19:23 was written by a scan that ran while the wedged predecessor
// was still writing). An ok verdict stamped in that window can describe a
// file state that was already corrupted, and if the foreign writer dies
// without another write, the stats never change and EVERY later boot hits
// the poisoned cache. So: while a live foreign holder is present, no ok
// verdict is cached AT ALL (not at the sync boot site, not in the
// background-completion path, not at close) — the next boot re-scans fresh.
test("a live foreign writer suppresses every ok-verdict cache write (boot, close, rescan on next boot) (#7156)", { timeout: 30_000 }, async (t) => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    // A live foreign process whose pid we plant in <db>.lock BEFORE open —
    // the #7156 shape (a predecessor still holding index.db when the
    // replacement boots).
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
        setLogCapture((level, m) => {
            if (level === "info" && m.includes("skipping the close-time integrity-cache refresh")) skipping = m;
        });
        try {
            const store = UnifiedStore.open(dbPath);
            assert.equal(readIntegrityCache(dbPath), null, "boot did NOT cache an ok verdict while a live foreign writer was present");
            store.setKv("test", "key", { x: 1 }); // a write — lands in the -wal
            store.close();
        } finally {
            setLogCapture(null);
        }
        assert.ok(skipping.length > 0, "close() reported skipping the cache refresh for the foreign writer seen in this lifetime");
        assert.equal(readIntegrityCache(dbPath), null, "no verdict was cached at all (neither at boot nor at close)");
        // The foreign writer is gone now — the next boot rescans fresh and
        // restores the fast path.
        holder.kill("SIGKILL");
        await new Promise((r) => setTimeout(r, 100)); // let the pid actually die before the liveness probe
        const before = integrityCheckRunsForTests();
        const again = UnifiedStore.open(dbPath);
        try {
            assert.equal(integrityCheckRunsForTests(), before + 1, "the next boot re-scanned instead of trusting a stale verdict");
            assert.equal(readIntegrityCache(dbPath)?.ok, true, "the healthy file set re-cached a PASS verdict once the foreign writer is gone");
        } finally {
            again.close();
        }
    } finally {
        setIntegritySyncThresholdForTests(null);
        rmSync(dir, { recursive: true, force: true });
    }
});

// #7156 review: the same suppression applies to the BACKGROUND completion
// path — the incident's actual cache write was a background quick_check
// (571.9 MiB store, over the sync threshold) finishing while the predecessor
// was still alive.
test("a background ok verdict is not cached while a live foreign writer is present (#7156)", { timeout: 30_000 }, async (t) => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(1); // every store is "large" → background lane
    const dir = tmpDir();
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
        const store = UnifiedStore.open(dbPath); // returns immediately; worker scans in the background
        const done = await waitFor(() => !backgroundIntegrityInflightForTests(dbPath), 15000);
        assert.ok(done, "background check completed within 15s");
        assert.equal(readIntegrityCache(dbPath), null, "the ok verdict was NOT cached — the foreign writer was still alive at completion");
        store.close();
        assert.equal(readIntegrityCache(dbPath), null, "close() also wrote nothing");
    } finally {
        setIntegritySyncThresholdForTests(null);
        rmSync(dir, { recursive: true, force: true });
    }
});

// #7156 review: a boot whose ok verdict came from the CACHED cache (no fresh
// scan ran in this lifetime) must NOT re-stamp the verdict at close.
// Re-stamping an unverified verdict would perpetuate a poisoned .chk forever
// (cache hit → close re-stamp → cache hit ...). Without the re-stamp, the
// file set that was verified by a FRESH scan stays what is trusted; any
// change outside verified writes invalidates the stats and forces a rescan.
test("a cache-hit boot does not re-stamp the verdict cache at close (#7156)", () => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
    try {
        const dbPath = join(dir, "index.db");
        const store = UnifiedStore.open(dbPath); // fresh sync scan
        store.close(); // clean close of a FRESH-verdict store → re-stamp
        const afterFirstClose = readIntegrityCache(dbPath);
        assert.ok(afterFirstClose !== null && afterFirstClose.ok === true, "first close refreshed the verdict");
        // Second lifetime: boot is a cache hit (no fresh scan).
        const before = integrityCheckRunsForTests();
        const again = UnifiedStore.open(dbPath);
        assert.equal(integrityCheckRunsForTests(), before, "cache hit skipped the rescan");
        again.close();
        const afterSecondClose = readIntegrityCache(dbPath);
        assert.ok(afterSecondClose !== null, "the verdict is still present (not clobbered)");
        assert.equal(afterSecondClose.at, afterFirstClose.at, "the cache-hit close did NOT re-stamp the unverified verdict onto new stats");
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

// Seeds a real db whose WAL holds committed frames, and keeps the seeding
// connection OPEN — the last connection closing would auto-checkpoint and
// delete the -wal, destroying the very state under test. Returns the wal size.
function seedWal(dir: string): { seed: DatabaseSync; dbPath: string; walSize: number } {
    const dbPath = join(dir, "index.db");
    const seed = new DatabaseSync(dbPath);
    try {
        seed.exec("PRAGMA journal_mode=WAL;");
        seed.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT);");
        const ins = seed.prepare("INSERT INTO t (k, v) VALUES (?, ?);");
        for (let i = 0; i < 50; i++) ins.run("k" + i, "v".repeat(200));
    } catch (err) {
        seed.close();
        throw err;
    }
    const walSize = statSync(dbPath + "-wal").size;
    assert.ok(walSize > 0, "the seeded WAL holds committed frames");
    return { seed, dbPath, walSize };
}

// #7156 fix 2 (owner 2026-11-20): the corruption vector is not merely "two
// writers" — it is a TRUNCATE checkpoint reclaiming the WAL + its -shm index
// state out from under a peer that still holds a STALE view of it. The
// incident's old sidecar ran exactly this: its shutdown checkpoint while its
// replacement was already writing. So while a live foreign writer is proven
// present (the #4175 lockfile), NEITHER the open-time nor the close-time
// TRUNCATE checkpoint runs — the WAL simply stays until the peer exits and
// the next clean pass converges it. Nothing is lost by the skip: WAL frames
// are durable and are replayed/checkpointed by whoever closes cleanly later.
test("a live foreign writer suppresses the WAL checkpoint (TRUNCATE) on open and close (#7156 fix 2)", { timeout: 30_000 }, async (t) => {
    resetIntegrityCheckStateForTests();
    setIntegritySyncThresholdForTests(null);
    const dir = tmpDir();
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
    let seed: DatabaseSync | null = null;
    try {
        // ---- foreign writer present: both checkpoints must SKIP ----
        const seeded = seedWal(dir);
        seed = seeded.seed;
        const dbPath = join(dir, "index.db");
        writeFileSync(dbPath + ".lock", JSON.stringify({ pid: holder.pid, boot: Date.now() }));
        let skipOpen = "", skipClose = "";
        setLogCapture((level, m) => {
            const msg = String(m);
            if (level === "info" && msg.includes("live foreign writer pid")) {
                if (msg.includes("on open")) skipOpen = msg;
                if (msg.includes("on close")) skipClose = msg;
            }
        });
        try {
            const store = UnifiedStore.open(dbPath);
            // TRUNCATE would have reclaimed the seeded frames (wal → 0, then
            // small bootstrap writes); with the skip the seeded frames must
            // still be IN the wal, so its size can only have grown.
            assert.ok(walSizeOf(dbPath) >= seeded.walSize, `open() did NOT truncate the WAL out from under the live peer (now ${walSizeOf(dbPath)}, seeded ${seeded.walSize})`);
            assert.ok(skipOpen.length > 0, `open reported the checkpoint skip: ${skipOpen}`);
            store.setKv("test", "key", { x: 1 }); // a committed frame stays in the WAL
            store.close();
            assert.ok(statSync(dbPath + "-wal").size > 0, "close() did NOT run the final checkpoint under a live peer — the WAL stays for the peer's next clean pass");
            assert.ok(skipClose.length > 0, `close reported the checkpoint skip: ${skipClose}`);
            assert.ok(skipOpen.includes(String(holder.pid)), "the skip log names the peer pid");
        } finally {
            setLogCapture(null);
        }
        seed?.close();

        // ---- control: no foreign writer → both checkpoints run ----
        const dir2 = tmpDir();
        t.after(() => rmSync(dir2, { recursive: true, force: true }));
        seed = seedWal(dir2).seed;
        const db2 = join(dir2, "index.db");
        const store2 = UnifiedStore.open(db2);
        assert.equal(walSizeOf(db2), 0, "open() ran the TRUNCATE checkpoint (fast path preserved without a peer)");
        store2.setKv("test", "key", { x: 1 });
        assert.ok(walSizeOf(db2) > 0, "the committed frame is in the WAL before close");
        store2.close();
        assert.equal(walSizeOf(db2), 0, "close() converged the WAL (single-writer behavior unchanged)");
        // seed is closed by the outer finally.
    } finally {
        seed?.close();
        setIntegritySyncThresholdForTests(null);
        rmSync(dir, { recursive: true, force: true });
    }
});

function walSizeOf(dbPath: string): number {
    try { return statSync(dbPath + "-wal").size; } catch { return 0; }
}
