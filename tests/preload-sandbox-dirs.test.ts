// Pins the default-dir sandbox contract of tests/preload-storage-baseline.mjs:
// the suite's default-path persistence (envelopes, index.db, state/caches)
// must resolve into a per-run temp tree, never the developer's real
// ~/.local/{share,state,cache} — while an explicit environment stays
// authoritative (??= semantics). Found while triaging #5082.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const PRELOAD = path.resolve(import.meta.dirname, "preload-storage-baseline.mjs");

function evalWithPreload(env: NodeJS.ProcessEnv) {
    const res = spawnSync(
        process.execPath,
        [
            "--import",
            `file://${PRELOAD}`,
            "-e",
            "console.log(JSON.stringify([process.env.XDG_DATA_HOME, process.env.XDG_STATE_HOME, process.env.XDG_CACHE_HOME, process.env.BILI_STORAGE_UNIFIED]))",
        ],
        { env, encoding: "utf8" },
    );
    assert.equal(res.status, 0, `preload child failed: ${res.stderr}`);
    const lastLine = res.stdout.trim().split("\n").at(-1) ?? "";
    return JSON.parse(lastLine);
}

test("preload redirects default XDG dirs into a per-run temp tree", () => {
    const [data, state, cache, mode] = evalWithPreload({
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
    });
    assert.equal(mode, "legacy");
    for (const dir of [data, state, cache]) {
        assert.ok(dir, "XDG dir must be set");
        assert.ok(
            path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep),
            `expected under tmpdir, got ${dir}`,
        );
        assert.ok(dir.includes(path.join("bili-test-dirs-")), `expected sandbox root, got ${dir}`);
    }
    assert.notEqual(data, state);
    assert.notEqual(state, cache);
});

test("preload never clobbers an explicit environment", () => {
    const explicitData = path.join(tmpdir(), "keep-me-data");
    const [data, state, cache, mode] = evalWithPreload({
        PATH: process.env.PATH ?? "",
        TMPDIR: process.env.TMPDIR ?? "",
        XDG_DATA_HOME: explicitData,
        XDG_STATE_HOME: "",
        BILI_STORAGE_UNIFIED: "shadow",
    });
    assert.equal(data, explicitData);
    assert.equal(mode, "shadow");
    assert.notEqual(state, "");
    assert.notEqual(cache, "");
});
