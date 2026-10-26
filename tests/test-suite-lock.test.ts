import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { rmrf } from "./tmp-rm.ts";
import * as lck from "../scripts/test-suite-lock.mjs";

// #3103: per-machine test-suite mutex + fail-fast. Two full `npm test` runs on
// one machine corrupted each other (cores-1 concurrency x2 → every 15s readiness
// watchdog false-red; shared ~/.local/state/billion-context port-zone drift) with
// ZERO detection of a sibling run. This pins the suite-level counterpart of #2106:
// the O_EXCL lock, age-bounded stale steal (#3406 item 10: dead pids AND
// pid-reuse ghosts past the 30-min bound, never a fresh live suite), fail-fast
// banner, force bypass, and release-on-exit — both the imported primitives and
// the real CLI entry point.

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "test-suite-lock.mjs");
const NODE = process.execPath;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const freshCacheDir = (): string => mkdtempSync(join(tmpdir(), "bili-testsuite-lock-"));
const lockFile = (cacheDir: string): string => join(cacheDir, "billion-context", "test-suite.lock");
const writeFile = (p: string, v: unknown): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(v));
};

/** A live foreign process (its pid is what kill(pid,0) reports as alive). */
function liveForeign(): { pid: number; kill: () => void } {
    const c = spawn(NODE, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    return { pid: c.pid!, kill: () => { try { c.kill("SIGKILL"); } catch { /* gone */ } } };
}
/** A pid we can rely on being dead by the time we return. */
async function deadPid(): Promise<number> {
    const c = spawn(NODE, ["-e", "setTimeout(()=>process.exit(7),40)"], { stdio: "ignore" });
    await once(c, "close");
    return c.pid!;
}
function cleanEnv(cacheDir: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, XDG_CACHE_HOME: cacheDir };
    delete env.BILI_TEST_FORCE;
    return env;
}

test("formatAge renders seconds/minutes/hours", () => {
    assert.equal(lck.formatAge(0), "0s");
    assert.equal(lck.formatAge(42_000), "42s");
    assert.equal(lck.formatAge(65_000), "1m 05s");
    assert.equal(lck.formatAge(3_720_000), "1h 02m");
    assert.equal(lck.formatAge(-5_000), "0s");
});

test("forceEnabled parses BILI_TEST_FORCE truthy/opt-out table", () => {
    assert.equal(lck.forceEnabled({}), false);
    assert.equal(lck.forceEnabled({ BILI_TEST_FORCE: "" }), false);
    assert.equal(lck.forceEnabled({ BILI_TEST_FORCE: "0" }), false);
    assert.equal(lck.forceEnabled({ BILI_TEST_FORCE: "false" }), false);
    assert.equal(lck.forceEnabled({ BILI_TEST_FORCE: "no" }), false);
    assert.equal(lck.forceEnabled({ BILI_TEST_FORCE: "1" }), true);
    assert.equal(lck.forceEnabled({ BILI_TEST_FORCE: "true" }), true);
    assert.equal(lck.forceEnabled({ BILI_TEST_FORCE: "yes" }), true);
});

test("resolveLockPath mirrors paths.ts cacheDir() under XDG_CACHE_HOME", () => {
    // #3170 ②: tmpdir()-rooted base is absolute on every OS; a POSIX "/tmp/…" literal resolves onto the cwd drive under path.resolve() on Windows.
    const dir = join(tmpdir(), "x", "cache-home");
    assert.equal(
        lck.resolveLockPath({ XDG_CACHE_HOME: dir } as NodeJS.ProcessEnv),
        join(dir, "billion-context", "test-suite.lock"),
    );
    assert.ok(
        lck.resolveLockPath({} as NodeJS.ProcessEnv).startsWith(join(homedir(), ".cache")),
    );
});

test("readLock: absent → null, corrupt → null, valid → parsed", async () => {
    const dir = freshCacheDir();
    try {
        const p = lockFile(dir);
        assert.equal(await lck.readLock(p), null);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, "{not json");
        assert.equal(await lck.readLock(p), null);
        writeFile(p, { pid: 123, ts: 1, cmdline: "x" });
        assert.deepEqual(await lck.readLock(p), { pid: 123, ts: 1, cmdline: "x" });
    } finally {
        rmrf(dir);
    }
});

test("acquireLock: free path claims the lock with our pid", async () => {
    const dir = freshCacheDir();
    try {
        const p = lockFile(dir);
        const res = await lck.acquireLock(p, { pid: process.pid, cmdline: "me" });
        assert.deepEqual(res, { acquired: true, holder: null });
        assert.equal((await lck.readLock(p))?.pid, process.pid);
    } finally {
        rmrf(dir);
    }
});

test("acquireLock: NEVER steals a live FRESH holder (age-bounded liveness, #3103+#3406)", async () => {
    const dir = freshCacheDir();
    const f = liveForeign();
    try {
        const p = lockFile(dir);
        writeFile(p, { pid: f.pid, ts: Date.now(), cmdline: "sibling" });
        const res = await lck.acquireLock(p, { pid: process.pid });
        assert.equal(res.acquired, false);
        assert.equal(res.holder?.pid, f.pid);
        // Our claim did not clobber the sibling's lock.
        assert.equal((await lck.readLock(p))?.pid, f.pid);
    } finally {
        f.kill();
        rmrf(dir);
    }
});

test("holderIsStale: boundary at STALE_LOCK_MS (#3406 item 10)", () => {
    const now = Date.now();
    assert.equal(lck.holderIsStale({ pid: 1, ts: now - lck.STALE_LOCK_MS - 1 }, now), true, "1ms past the bound is stale");
    assert.equal(lck.holderIsStale({ pid: 1, ts: now - lck.STALE_LOCK_MS }, now), false, "exactly at the bound is still fresh");
    assert.equal(lck.holderIsStale({ pid: 1, ts: now - 60_000 }, now), false);
    assert.equal(lck.holderIsStale({ pid: 1, ts: now + 60_000 }, now), false, "clock-skewed future ts is never stale");
});

test("acquireLock: steals a STALE lock even when the pid looks alive — the pid-reuse ghost (#3406 item 10)", async () => {
    const dir = freshCacheDir();
    const f = liveForeign(); // a live unrelated process standing in for the reused pid
    try {
        const p = lockFile(dir);
        writeFile(p, { pid: f.pid, ts: Date.now() - lck.STALE_LOCK_MS - 60_000, cmdline: "ghost" });
        assert.equal(lck.isAlive(f.pid), true, "precondition: the ghost pid really looks alive");
        const res = await lck.acquireLock(p, { pid: process.pid });
        assert.equal(res.acquired, true, "stale lock must be stealable despite a live-looking pid");
        assert.equal((await lck.readLock(p))?.pid, process.pid);
    } finally {
        f.kill();
        rmrf(dir);
    }
});

test("acquireLock: steals a DEAD holder and rewrites with our pid", async () => {
    const dir = freshCacheDir();
    try {
        const p = lockFile(dir);
        const dead = await deadPid();
        assert.equal(lck.isAlive(dead), false);
        writeFile(p, { pid: dead, ts: Date.now() - 60_000, cmdline: "crashed" });
        const res = await lck.acquireLock(p, { pid: process.pid });
        assert.equal(res.acquired, true);
        assert.equal((await lck.readLock(p))?.pid, process.pid);
    } finally {
        rmrf(dir);
    }
});

test("acquireLock: reclaims a CORRUPT/truncated lock (SIGKILL mid-write), not a permanent wedge", async () => {
    const dir = freshCacheDir();
    try {
        const p = lockFile(dir);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, '{"pid":99999,"ts":123,"cmdline":"crash');
        assert.equal(await lck.readLock(p), null, "partial file parses to null");
        const res = await lck.acquireLock(p, { pid: process.pid });
        assert.equal(res.acquired, true, "corrupt lock must be reclaimable, never a permanent wedge");
        assert.equal((await lck.readLock(p))?.pid, process.pid);
    } finally {
        rmrf(dir);
    }
});

test("releaseLock only unlinks when we still own it", async () => {
    const dir = freshCacheDir();
    try {
        const p = lockFile(dir);
        await lck.acquireLock(p, { pid: process.pid });
        await lck.releaseLock(p, 999_999_999); // wrong pid → no-op
        assert.ok(existsSync(p), "foreign-pid release must not delete our lock");
        await lck.releaseLock(p, process.pid);
        assert.equal(existsSync(p), false, "owner release deletes the lock");
    } finally {
        rmrf(dir);
    }
});

test("listTestFiles matches the old shell glob (top-level tests/*.test.ts)", () => {
    const files = lck.listTestFiles();
    assert.ok(files.length > 100, `expected many suites, got ${files.length}`);
    for (const f of files) assert.match(f, /^tests\/.+\.test\.ts$/);
});

test("blockedMessage names pid + age + command + override + orphan hint", () => {
    const msg = lck.blockedMessage(
        { pid: 4242, ts: Date.now() - 90_000, cmdline: "npm test" },
        "/x/test-suite.lock",
    );
    assert.match(msg, /already running/);
    assert.match(msg, /pid=4242/);
    assert.match(msg, /started 1m 30s ago/);
    assert.match(msg, /npm test/);
    assert.match(msg, /BILI_TEST_FORCE=1 npm test/);
    assert.match(msg, /orphan/i);
});

// ---- CLI end-to-end (the real entry point users hit) ----

function gateCli(cacheDir: string, extraEnv: Record<string, string> = {}) {
    return spawnSync(NODE, [SCRIPT, "gate"], {
        env: { ...cleanEnv(cacheDir), ...extraEnv },
        encoding: "utf8",
    });
}

test("CLI gate: no lock → exit 0", () => {
    const dir = freshCacheDir();
    try {
        assert.equal(gateCli(dir).status, 0);
    } finally {
        rmrf(dir);
    }
});

test("CLI gate: live holder → exit 1 with the fail-fast banner", async () => {
    const dir = freshCacheDir();
    const f = liveForeign();
    try {
        writeFile(lockFile(dir), { pid: f.pid, ts: Date.now(), cmdline: "npm test" });
        const r = gateCli(dir);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /already running/);
        assert.ok(r.stderr.includes(`pid=${f.pid}`));
        assert.match(r.stderr, /BILI_TEST_FORCE=1 npm test/);
    } finally {
        f.kill();
        rmrf(dir);
    }
});

test("CLI gate: dead holder → exit 0 (stealable, do not block)", async () => {
    const dir = freshCacheDir();
    try {
        const dead = await deadPid();
        writeFile(lockFile(dir), { pid: dead, ts: Date.now() - 60_000, cmdline: "crashed" });
        assert.equal(gateCli(dir).status, 0);
    } finally {
        rmrf(dir);
    }
});

test("CLI gate: BILI_TEST_FORCE=1 bypasses a live holder", async () => {
    const dir = freshCacheDir();
    const f = liveForeign();
    try {
        writeFile(lockFile(dir), { pid: f.pid, ts: Date.now(), cmdline: "npm test" });
        assert.equal(gateCli(dir, { BILI_TEST_FORCE: "1" }).status, 0);
    } finally {
        f.kill();
        rmrf(dir);
    }
});

test("CLI gate: stale live-looking holder → exit 0 with the stale-reclaim warning (#3406 item 10)", async () => {
    const dir = freshCacheDir();
    const f = liveForeign();
    try {
        writeFile(lockFile(dir), { pid: f.pid, ts: Date.now() - lck.STALE_LOCK_MS - 5_000, cmdline: "ghost" });
        const r = gateCli(dir);
        assert.equal(r.status, 0, "a stale lock must not fail the pretest gate");
        assert.match(r.stderr, /stale test-suite lock/i);
        assert.ok(r.stderr.includes(`pid=${f.pid}`), "warning must name the ghost pid");
        assert.match(r.stderr, /reclaiming the lock/i);
    } finally {
        f.kill();
        rmrf(dir);
    }
});

// The flagship acceptance criterion (#3103): while one `npm test` (here a stubbed
// suite) holds the lock, a second one refuses within 2s with holder info, the exit
// code propagates, and the lock is released on normal exit.
test("CLI run: holds the lock while the suite runs, second run fails fast <2s, releases after", async () => {
    const dir = freshCacheDir();
    const stub = JSON.stringify([NODE, "-e", "setTimeout(()=>{process.exit(3)},1500)"]);
    const runProc = spawn(NODE, [SCRIPT, "run"], {
        env: { ...cleanEnv(dir), BILI_TEST_SUITE_CMD: stub },
        stdio: "ignore",
    });
    try {
        await once(runProc, "spawn");
        // Poll until the wrapper has claimed the lock (spawn ≠ acquired yet).
        for (let i = 0; i < 100 && !existsSync(lockFile(dir)); i++) await sleep(40);
        assert.ok(existsSync(lockFile(dir)), "lock must be held during the run");

        const t0 = Date.now();
        const g = gateCli(dir);
        const elapsedMs = Date.now() - t0;
        assert.equal(g.status, 1, "concurrent gate must refuse");
        assert.match(g.stderr, /already running/);
        assert.ok(elapsedMs < 2000, `fail-fast took ${elapsedMs}ms (must be <2s)`);

        const code = await once(runProc, "close").then(([c]) => c as number);
        assert.equal(code, 3, "suite exit code must propagate through the wrapper");
        assert.equal(existsSync(lockFile(dir)), false, "lock released on normal exit");
    } finally {
        try { runProc.kill("SIGKILL"); } catch { /* gone */ }
        rmrf(dir);
    }
});
