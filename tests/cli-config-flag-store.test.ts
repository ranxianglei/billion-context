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
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = mkdtempSync(path.join(tmpdir(), "bili-cli-cflag-"));
const CONFIG_DIR = path.join(ROOT, "config", "billion-context"); // configDir() appends "billion-context"
const DATA_DIR = path.join(ROOT, "data"); // default store: <XDG_DATA_HOME>/billion-context/sessions
const RELOCATED = path.join(ROOT, "relocated");
const REPO = path.resolve(import.meta.dirname, "..");

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
    return new Promise((resolve) => {
        const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
            cwd: REPO,
            env: { ...process.env },
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
    assert.equal(r.code, 0, `sessions ls exit 0 (got ${r.code}): ${r.out.slice(-400)}`);
    // fingerprint: the store the command served got its index.db in the relocated dir…
    assert.ok(existsSync(relocatedDb()), `index.db created in the relocated dir ${RELOCATED}`);
    // …and the default store was NOT opened (no index.db appeared there).
    assert.ok(!existsSync(defaultStoreDb()), "default store index.db must NOT have been created");
    const parsed = JSON.parse(r.out); // sessions ls --json prints a bare array
    assert.deepEqual(parsed, [], "the relocated store is empty — nothing from the default dir leaked in");
});

test("control: without -c the same command DOES open the default store (harness sanity)", async () => {
    assert.ok(!existsSync(defaultStoreDb()), "precondition: default store untouched by the -c run");
    const r = await cli(["sessions", "ls", "--json"]);
    assert.equal(r.code, 0, `sessions ls exit 0 (got ${r.code}): ${r.out.slice(-400)}`);
    assert.ok(existsSync(defaultStoreDb()), "default store index.db created when no -c / no sessions.dir");
    // and the relocated dir must stay empty (no leak the other way)
    assert.deepEqual(readdirSync(RELOCATED).filter((f) => f === "index.db"), ["index.db"], "relocated dir untouched by the default run");
});
