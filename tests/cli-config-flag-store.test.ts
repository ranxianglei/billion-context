/**
 * #7858: `-c <name>` must reach the store-accessing CLI lanes (sessions /
 * storage / export).
 *
 * The store lives where `sessionsDir()` points, which resolves
 * `sessions.dir` (or the BILI_SESSIONS_DIR env) from the config file named
 * by BILI_CONFIG_FILE. `bili sessions ls` used to return from its main()
 * branch BEFORE the generic override loop wrote `-c` into process.env, so
 * the flag silently had no effect and the DEFAULT store was listed.
 *
 * Fingerprint used here (no session rows need to be forged): opening a
 * store creates index.db in the directory it serves. After
 * `bili -c alt sessions ls`, the RELOCATED dir must contain index.db and
 * the default XDG data dir must NOT — and a control run WITHOUT `-c` must
 * create the default one (proves the harness really writes somewhere).
 *
 * Two CI-sharp edges, both bitten on windows (run 46022712184):
 *  - the child pins BILI_STORAGE_UNIFIED="full" itself: the CI suite-wide
 *    preload (tests/preload-storage-baseline.mjs) sets the corpus baseline
 *    to legacy, where opening a store writes JSON envelopes and NO index.db
 *    — the fingerprint above can never appear under inherited env. Any
 *    suite asserting a mode-specific artifact MUST pin the mode itself
 *    (#4011 lesson, written in that preload's header).
 *  - the child runs the BUILT dist/index.js, self-built on demand
 *    (ensureDistBuilt, port-zone-live / claude-native pattern): the CI test
 *    job does not pre-build root dist, and argv[1] IS the entry file, so
 *    invokedAsScript() matches trivially on every platform. A silent no-op
 *    child (exit 0, store never opened) would look exactly like the bug
 *    this test guards against, so the entry must be unambiguous.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const ROOT = mkdtempSync(path.join(tmpdir(), "bili-cli-cflag-"));
const CONFIG_DIR = path.join(ROOT, "config", "billion-context"); // configDir() appends "billion-context"
const DATA_DIR = path.join(ROOT, "data"); // default store: <XDG_DATA_HOME>/billion-context/sessions
const RELOCATED = path.join(ROOT, "relocated");
const REPO = path.resolve(import.meta.dirname, "..");
const ENTRY = path.join(REPO, "dist", "index.js");

// The CI test job does not pre-build root dist (only kernel/ + pi-subagents/
// pretest parity); build on demand like port-zone-live / claude-native.
let distBuiltOnce = false;
function ensureDistBuilt(): void {
    if (distBuiltOnce || existsSync(ENTRY)) return;
    distBuiltOnce = true;
    execFileSync(process.execPath, [path.join(REPO, "node_modules", "tsup", "dist", "cli-default.js")], {
        cwd: REPO,
        stdio: "pipe",
        timeout: 300_000,
    });
    assert.ok(existsSync(ENTRY), `build did not produce ${ENTRY}`);
}

const SAVED: Record<string, string | undefined> = {};
for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "BILI_CONFIG_FILE", "BILI_SESSIONS_DIR"]) {
    SAVED[k] = process.env[k];
    if (k.startsWith("BILI_")) delete process.env[k];
}
process.env.XDG_CONFIG_HOME = path.join(ROOT, "config");
process.env.XDG_DATA_HOME = DATA_DIR;
process.env.XDG_CACHE_HOME = path.join(ROOT, "cache");
process.env.XDG_STATE_HOME = path.join(ROOT, "state");

after(() => {
    for (const [k, v] of Object.entries(SAVED)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    rmSync(ROOT, { recursive: true, force: true });
});

function cli(args: string[], timeoutMs = 120_000): Promise<{ code: number | null; out: string; err: string }> {
    ensureDistBuilt();
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [ENTRY, ...args], {
            cwd: REPO,
            // BILI_STORAGE_UNIFIED: this suite's fingerprint IS the SQLite
            // index.db, so it must run "full" no matter what the suite-wide
            // legacy baseline (tests/preload-storage-baseline.mjs) put in the
            // inherited env — #4011 lesson.
            env: { ...process.env, BILI_STORAGE_UNIFIED: "full" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        p.stdout.on("data", (d) => (out += String(d)));
        p.stderr.on("data", (d) => (err += String(d)));
        const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
        p.on("close", (code) => {
            clearTimeout(t);
            resolve({ code, out, err });
        });
    });
}

const defaultStoreDb = () => path.join(DATA_DIR, "billion-context", "sessions", "index.db");
const relocatedDb = () => path.join(RELOCATED, "index.db");

test("-c <name> sessions ls serves the config's sessions.dir, not the default store (#7858)", async () => {
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(RELOCATED, { recursive: true });
    writeFileSync(path.join(CONFIG_DIR, "alt.json"), JSON.stringify({ sessions: { dir: RELOCATED } }));

    const r = await cli(["-c", "alt", "sessions", "ls", "--json"]);
    assert.equal(r.code, 0, `sessions ls exit 0 (got ${r.code}): ${r.out.slice(-400)} ${r.err.slice(-400)}`);
    // fingerprint: the store the command served got its index.db in the relocated dir…
    assert.ok(existsSync(relocatedDb()), `index.db created in the relocated dir ${RELOCATED}: out=${r.out.slice(-200)} err=${r.err.slice(-400)}`);
    // …and the default store was NOT opened (no index.db appeared there).
    assert.ok(!existsSync(defaultStoreDb()), "default store index.db must NOT have been created");
    const parsed = JSON.parse(r.out); // sessions ls --json prints a bare array
    assert.deepEqual(parsed, [], "the relocated store is empty — nothing from the default dir leaked in");
});

test("control: without -c the same command DOES open the default store (harness sanity)", async () => {
    assert.ok(!existsSync(defaultStoreDb()), "precondition: default store untouched by the -c run");
    const r = await cli(["sessions", "ls", "--json"]);
    assert.equal(r.code, 0, `sessions ls exit 0 (got ${r.code}): ${r.out.slice(-400)} ${r.err.slice(-400)}`);
    assert.ok(existsSync(defaultStoreDb()), `default store index.db created when no -c / no sessions.dir: out=${r.out.slice(-200)} err=${r.err.slice(-400)}`);
    // and the relocated dir must stay empty (no leak the other way)
    assert.deepEqual(readdirSync(RELOCATED).filter((f) => f === "index.db"), ["index.db"], "relocated dir untouched by the default run");
});
