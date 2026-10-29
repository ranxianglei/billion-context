// #5116: the test runner sandboxes the XDG base dirs so no suite ever writes
// into the developer's real $HOME (index.db / session envelopes / state files
// / live config — the production pollution found while investigating #5082).
// Pins both sides: the resolver semantics of tests/test-sandbox-env.mjs
// (unset and empty-string → per-process temp dirs, explicit values win) and
// the live-process contract (under the suite preload, bili's default path
// resolutions never land in the real home tree, and the sandbox root is
// reported as BILI_TEST_XDG_ROOT).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cacheDir, configDir, dataDir, defaultLogFile, sessionsDir, stateDir } from "../src/paths.ts";
import { SANDBOXED_XDG_KEYS, sandboxXdgEnv } from "./test-sandbox-env.mjs";
import { rmrf } from "./tmp-rm.ts";

function blankEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const k of SANDBOXED_XDG_KEYS) delete env[k];
    return env;
}

function subName(key: string): string {
    return key.toLowerCase().replace(/^xdg_/, "").replace(/_home$/, "");
}

test("sandbox matrix: unset and empty-string keys get fresh dirs under one shared root", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "bili-xdg-matrix-"));
    try {
        const env = blankEnv();
        env.XDG_STATE_HOME = ""; // empty string counts as unset
        const { root, applied } = sandboxXdgEnv(env, { baseDir: scratch });
        assert.ok(root && root.startsWith(scratch + path.sep), `root ${root} under the given baseDir`);
        assert.equal(env.BILI_TEST_XDG_ROOT, root, "root reported via BILI_TEST_XDG_ROOT");
        for (const key of SANDBOXED_XDG_KEYS) {
            assert.equal(applied[key], path.join(root, subName(key)), `${key} → <root>/<name>`);
            assert.equal(env[key], applied[key]);
        }
    } finally {
        rmrf(scratch);
    }
});

test("sandbox matrix: explicitly set values always win and are left untouched", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "bili-xdg-matrix-"));
    try {
        const env = blankEnv();
        env.XDG_DATA_HOME = "/explicitly/pinned/data";
        env.XDG_CONFIG_HOME = "/explicitly/pinned/config";
        const { root, applied } = sandboxXdgEnv(env, { baseDir: scratch });
        assert.equal(env.XDG_DATA_HOME, "/explicitly/pinned/data");
        assert.equal(env.XDG_CONFIG_HOME, "/explicitly/pinned/config");
        assert.equal(applied.XDG_DATA_HOME, undefined, "pinned DATA untouched");
        assert.equal(applied.XDG_CONFIG_HOME, undefined, "pinned CONFIG untouched");
        assert.ok(root, "a root was created for the two unpinned keys");
        assert.equal(applied.XDG_STATE_HOME, path.join(root, "state"));
        assert.equal(applied.XDG_CACHE_HOME, path.join(root, "cache"));
    } finally {
        rmrf(scratch);
    }
});

test("sandbox matrix: all keys pinned → no root, BILI_TEST_XDG_ROOT unset", () => {
    const env = blankEnv();
    for (const key of SANDBOXED_XDG_KEYS) env[key] = `/pinned/${subName(key)}`;
    const { root, applied } = sandboxXdgEnv(env, { baseDir: tmpdir() });
    assert.equal(root, undefined);
    assert.deepEqual(applied, {});
    assert.equal(env.BILI_TEST_XDG_ROOT, undefined);
});

test("sandbox matrix: successive calls get independent roots (per-process isolation)", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "bili-xdg-matrix-"));
    try {
        const a = sandboxXdgEnv(blankEnv(), { baseDir: scratch });
        const b = sandboxXdgEnv(blankEnv(), { baseDir: scratch });
        assert.ok(a.root && b.root);
        assert.notEqual(a.root, b.root);
    } finally {
        rmrf(scratch);
    }
});

test("contract: live process never resolves bili defaults into the real home tree (#5116)", () => {
    const home = homedir();
    assert.notEqual(dataDir(), path.join(home, ".local", "share", "billion-context"), "dataDir must not be the real-home default");
    assert.notEqual(stateDir(), path.join(home, ".local", "state", "billion-context"), "stateDir must not be the real-home default");
    assert.notEqual(cacheDir(), path.join(home, ".cache", "billion-context"), "cacheDir must not be the real-home default");
    assert.ok(!sessionsDir().startsWith(path.join(home, ".local", "share", "billion-context")), "session envelopes must not land in the real data dir");
    assert.ok(!defaultLogFile().startsWith(path.join(home, ".local", "state", "billion-context")), "bili.log must not land in the real state dir");
    assert.notEqual(configDir(), path.join(home, ".config", "billion-context"), "the live user config dir must not be read by default");
});

test("contract: the suite preload applied the XDG sandbox in this process (#5116)", () => {
    const root = process.env.BILI_TEST_XDG_ROOT;
    assert.ok(
        typeof root === "string" && root.length > 0,
        "BILI_TEST_XDG_ROOT missing — run the suite through tests/preload-storage-baseline.mjs (reference/testing.md)",
    );
    assert.ok(root.startsWith(tmpdir()), `sandbox root ${root} under os.tmpdir()`);
    for (const key of SANDBOXED_XDG_KEYS) {
        assert.ok(typeof process.env[key] === "string" && process.env[key].length > 0, `${key} set by the preload`);
    }
});
