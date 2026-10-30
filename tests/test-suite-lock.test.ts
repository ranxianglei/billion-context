import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(ROOT, "scripts", "test-suite-lock.mjs");
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

// ---- #5107: production-sessions leak guard + hermetic preload wiring ----

test("resolveProductionSessionsDir mirrors paths.ts sessionsDir() (explicit > XDG > ~/.local/share)", () => {
    const explicit = join(tmpdir(), "x", "sessions-explicit");
    assert.equal(
        lck.resolveProductionSessionsDir({ BILI_SESSIONS_DIR: explicit } as NodeJS.ProcessEnv),
        resolve(explicit),
    );
    const xdg = join(tmpdir(), "x", "data-home");
    assert.equal(
        lck.resolveProductionSessionsDir({ BILI_SESSIONS_DIR: "", XDG_DATA_HOME: xdg } as NodeJS.ProcessEnv),
        join(resolve(xdg), "billion-context", "sessions"),
    );
    assert.ok(
        lck.resolveProductionSessionsDir({} as NodeJS.ProcessEnv).startsWith(join(homedir(), ".local", "share")),
    );
});

test("leakGuardEnabled defaults ON; 0/false/no/off disable (BILI_TEST_LEAK_GUARD)", () => {
    assert.equal(lck.leakGuardEnabled({}), true);
    assert.equal(lck.leakGuardEnabled({ BILI_TEST_LEAK_GUARD: "" }), true);
    assert.equal(lck.leakGuardEnabled({ BILI_TEST_LEAK_GUARD: "1" }), true);
    for (const v of ["0", "false", "no", "off"]) {
        assert.equal(lck.leakGuardEnabled({ BILI_TEST_LEAK_GUARD: v }), false, `v=${v}`);
    }
});

test("snapshotSessionsTree: absent dir → null; files → relpath→[mtimeMs,size]; symlinks skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-leak-snap-"));
    try {
        assert.equal(lck.snapshotSessionsTree(join(dir, "absent")), null);
        mkdirSync(join(dir, "anthropic"), { recursive: true });
        writeFileSync(join(dir, "index.db"), "x".repeat(4));
        writeFileSync(join(dir, "anthropic", "s.json"), "{}");
        const snap = lck.snapshotSessionsTree(dir)!;
        assert.ok(snap instanceof Map);
        assert.deepEqual([...snap.keys()].sort(), ["anthropic/s.json", "index.db"]);
        const [mt, size] = snap.get("index.db")!;
        assert.equal(size, 4);
        assert.ok(typeof mt === "number" && mt > 0);
    } finally {
        rmrf(dir);
    }
});

test("diffSnapshots: NEW files fail, mtime/size drift warns, untouched passes, absent→present fails everything", () => {
    const before = new Map<string, [number, number]>([["a.json", [100, 1]], ["b.json", [200, 2]]]);
    const afterClean = new Map<string, [number, number]>([["a.json", [100, 1]], ["b.json", [200, 2]]]);
    assert.deepEqual(lck.diffSnapshots(before, afterClean), { created: [], changed: [] });

    const afterNew = new Map<string, [number, number]>([...afterClean, ["c.json", [300, 3]]]);
    assert.deepEqual(lck.diffSnapshots(before, afterNew), { created: ["c.json"], changed: [] });

    const afterChanged = new Map<string, [number, number]>([
        ["a.json", [999, 1]], // mtime drift
        ["b.json", [200, 5]], // size drift
    ]);
    assert.deepEqual(lck.diffSnapshots(before, afterChanged), { created: [], changed: ["a.json", "b.json"] });

    assert.deepEqual(lck.diffSnapshots(null, afterClean), { created: ["a.json", "b.json"], changed: [] });
    assert.deepEqual(lck.diffSnapshots(before, null), { created: [], changed: [] });
});

test("leak messages name the tree, list files (capped), and point at the escape hatch", () => {
    const fail = lck.leakFailureMessage("/prod/sessions", ["a.json", "b.json", ...Array.from({ length: 20 }, (_, i) => `c${i}.json`)]);
    assert.match(fail, /NEW file\(s\)/);
    assert.ok(fail.includes("/prod/sessions"));
    assert.ok(fail.includes("a.json") && fail.includes("c0.json"));
    assert.match(fail, /…and 12 more/);
    assert.match(fail, /BILI_TEST_LEAK_GUARD=0 npm test/);
    const warn = lck.leakWarningMessage(["z.json"]);
    assert.match(warn, /modified during the run/);
    assert.ok(warn.includes("z.json"));
    assert.doesNotMatch(warn, /BILI_TEST_LEAK_GUARD=0/, "warn-only line must not advertise a bypass for itself");
});

test("realSuiteArgs wires BOTH preloads before tsx (#5107 + #2815)", () => {
    const args = lck.realSuiteArgs();
    const iBase = args.indexOf("./tests/preload-storage-baseline.mjs");
    const iEnv = args.indexOf("./tests/preload-test-env.mjs");
    const iTsx = args.indexOf("tsx");
    assert.ok(iBase >= 0, `storage-baseline preload missing: ${JSON.stringify(args.slice(0, 6))}`);
    assert.ok(iEnv >= 0, `hermetic data-root preload missing: ${JSON.stringify(args.slice(0, 6))}`);
    assert.ok(iTsx > iEnv && iTsx > iBase, "preloads must load before tsx");
    assert.ok(args.includes("--test") && args[args.length - 1].endsWith(".test.ts"));
});

test("preload-test-env.mjs isolates src/paths.ts defaults before any user code runs (#5107)", () => {
    // Pure-JS probe (tsx does not transform -e strings): the preload must have
    // already rewritten the ambient env before this user code resolves paths.
    const probe = `
import { sessionsDir, dataDir, stateDir, configFile } from ${JSON.stringify(pathToFileURL(resolve(ROOT, "src", "paths.ts")).href)};
const env = process.env;
const s = sessionsDir();
const d = dataDir();
const st = stateDir();
const cf = configFile();
if (s !== env.BILI_SESSIONS_DIR) { console.error("sessionsDir escaped isolation:", s); process.exit(9); }
if (!env.XDG_DATA_HOME || !d.startsWith(env.XDG_DATA_HOME)) { console.error("dataDir escaped isolation:", d); process.exit(9); }
if (!env.XDG_STATE_HOME || !st.startsWith(env.XDG_STATE_HOME)) { console.error("stateDir escaped isolation:", st); process.exit(9); }
if (!env.XDG_CONFIG_HOME || !cf.startsWith(env.XDG_CONFIG_HOME)) { console.error("configFile escaped isolation:", cf); process.exit(9); }
console.log(JSON.stringify({ s, d, st }));
`;
    // Scrub the ambient path vars so the ONLY thing isolating this child is the
    // explicit --import below: the suite's own parent process already runs under
    // the preload (wrapper wiring), and an inheriting child would pass even with
    // a broken/renamed preload file — the gate must actually gate (#3617).
    const scrubbed = { ...process.env } as NodeJS.ProcessEnv;
    for (const k of ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
        delete scrubbed[k];
    }
    const r = spawnSync(NODE, ["--import", "tsx", "--input-type=module", "--import", "./tests/preload-test-env.mjs", "-e", probe], {
        cwd: ROOT,
        encoding: "utf8",
        env: scrubbed,
    });
    assert.equal(r.status, 0, `probe failed: ${r.stderr ?? r.stdout}`);
    const parsed = JSON.parse(r.stdout.trim().split("\n").pop()!) as { s: string; d: string; st: string };
    for (const v of [parsed.s, parsed.d, parsed.st]) {
        assert.ok(v.startsWith(tmpdir()), `isolated root must live under the system tmp: ${v}`);
    }
});

// CLI end-to-end for the guard: the stub "suite" writes into the wrapper's
// BILI_SESSIONS_DIR (its resolved production dir), mirroring a leaking test.
function runCliWithStub(cacheDir: string, prodDir: string, stubScript: string, extraEnv: Record<string, string> = {}) {
    return spawn(NODE, [SCRIPT, "run"], {
        env: {
            ...cleanEnv(cacheDir),
            BILI_SESSIONS_DIR: prodDir,
            BILI_TEST_SUITE_CMD: JSON.stringify([NODE, "-e", stubScript]),
            ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

test("CLI run: suite that creates a file in the production sessions dir FAILS the guard (#5107)", async () => {
    const cache = freshCacheDir();
    const prod = freshCacheDir();
    try {
        const p = runCliWithStub(cache, prod, `
            require("fs").mkdirSync(require("path").join(process.env.BILI_SESSIONS_DIR, "anthropic"), { recursive: true });
            require("fs").writeFileSync(require("path").join(process.env.BILI_SESSIONS_DIR, "anthropic", "leak.json"), "{}");
            process.exit(0);
        `);
        let err = "";
        p.stderr!.on("data", (d) => { err += d; });
        const code = await once(p, "close").then(([c]) => c as number);
        assert.equal(code, 1, "guard must turn a green leaking suite red");
        assert.match(err, /NEW file\(s\)/);
        assert.ok(err.includes("anthropic/leak.json"), `banner must name the leaked file:\n${err}`);
        assert.match(err, /BILI_TEST_LEAK_GUARD=0 npm test/);
    } finally {
        rmrf(cache);
        rmrf(prod);
    }
});

test("CLI run: clean suite leaves the production dir untouched → guard silent, exit 0 (negative direction)", async () => {
    const cache = freshCacheDir();
    const prod = freshCacheDir();
    writeFileSync(join(prod, "index.db"), "pre-existing");
    try {
        const p = runCliWithStub(cache, prod, `process.exit(0);`);
        let err = "";
        p.stderr!.on("data", (d) => { err += d; });
        const code = await once(p, "close").then(([c]) => c as number);
        assert.equal(code, 0);
        assert.doesNotMatch(err, /leak guard/i, `no guard output expected:\n${err}`);
    } finally {
        rmrf(cache);
        rmrf(prod);
    }
});

test("CLI run: modifying a PRE-EXISTING session file warns but does not fail (live-instance tolerance)", async () => {
    const cache = freshCacheDir();
    const prod = freshCacheDir();
    const pre = join(prod, "openai", "pre.json");
    mkdirSync(dirname(pre), { recursive: true });
    writeFileSync(pre, "old");
    try {
        const p = runCliWithStub(cache, prod, `
            require("fs").writeFileSync(require("path").join(process.env.BILI_SESSIONS_DIR, "openai", "pre.json"), "rewritten-by-live-instance");
            process.exit(0);
        `);
        let err = "";
        p.stderr!.on("data", (d) => { err += d; });
        const code = await once(p, "close").then(([c]) => c as number);
        assert.equal(code, 0, "mtime drift on pre-existing files is warn-only");
        assert.match(err, /modified during the run/);
        assert.ok(err.includes("openai/pre.json"));
        assert.doesNotMatch(err, /NEW file\(s\)/);
    } finally {
        rmrf(cache);
        rmrf(prod);
    }
});

test("CLI run: BILI_TEST_LEAK_GUARD=0 disables the guard even when the suite leaks (escape hatch)", async () => {
    const cache = freshCacheDir();
    const prod = freshCacheDir();
    try {
        const p = runCliWithStub(cache, prod, `
            require("fs").mkdirSync(process.env.BILI_SESSIONS_DIR, { recursive: true });
            require("fs").writeFileSync(require("path").join(process.env.BILI_SESSIONS_DIR, "leak.json"), "{}");
            process.exit(0);
        `, { BILI_TEST_LEAK_GUARD: "0" });
        let err = "";
        p.stderr!.on("data", (d) => { err += d; });
        const code = await once(p, "close").then(([c]) => c as number);
        assert.equal(code, 0, "disabled guard must not fail the run");
        assert.doesNotMatch(err, /NEW file\(s\)/);
    } finally {
        rmrf(cache);
        rmrf(prod);
    }
});

test("CLI run: absent production dir that the suite MATERIALIZES counts as a leak", async () => {
    const cache = freshCacheDir();
    const prod = join(freshCacheDir(), "never-created");
    assert.equal(existsSync(prod), false);
    try {
        const p = runCliWithStub(cache, prod, `
            require("fs").mkdirSync(require("path").join(process.env.BILI_SESSIONS_DIR, "_unknown"), { recursive: true });
            require("fs").writeFileSync(require("path").join(process.env.BILI_SESSIONS_DIR, "_unknown", "new.json"), "{}");
            process.exit(0);
        `);
        let err = "";
        p.stderr!.on("data", (d) => { err += d; });
        const code = await once(p, "close").then(([c]) => c as number);
        assert.equal(code, 1, "materializing the production tree is already a violation");
        assert.ok(err.includes("_unknown/new.json"));
    } finally {
        rmrf(dirname(prod));
        rmrf(cache);
    }
});
