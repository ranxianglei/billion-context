// #991 single-writer: `bili plugin update` reports each lane through its own
// owner — reference lanes follow the global install, host-managed copies are
// pointed at their host's updater (never overwritten), dsh bundles refresh
// through dsh's plugin channel. These tests run fully offline: no globalCheck
// is injected, and the dsh lane short-circuits before any registry fetch
// (no profiles on a scratch DSH_HOME).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pluginUpdate, opencodeCacheCopyRoot, UPDATE_CHANNEL } from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

function scratchHome(): { home: string; cleanup(): void } {
    const home = mkdtempSync(path.join(tmpdir(), "bc-plugin-update-"));
    return { home, cleanup: () => rmrf(home) };
}

const OPTS = { packageName: "billion-context" };

test("pluginUpdate: reference lanes point at the global install", async () => {
    const lines = await pluginUpdate(["omp", "claude", "codex", "kimi"], OPTS);
    assert.equal(lines.length, 4);
    for (const line of lines) assert.match(line, /global bili install/);
});

test("pluginUpdate: global check runs once when injected", async () => {
    let ran = 0;
    const lines = await pluginUpdate(["omp"], { ...OPTS, globalCheck: async () => { ran += 1; } });
    assert.equal(ran, 1);
    assert.match(lines[0], /global bili copy: update check ran/);
    assert.match(lines[1], /omp: /);
});

test("pluginUpdate: pi lane reports its owner by entry form", async () => {
    const { home, cleanup } = scratchHome();
    process.env.PI_HOME = path.join(home, "agent");
    try {
        // no settings file → not installed
        let lines = await pluginUpdate(["pi"], OPTS);
        assert.match(lines[0], /pi: not installed/);

        // npm entry → host-managed, bili never overwrites
        const settings = path.join(home, "agent", "settings.json");
        mkdirSync(path.join(home, "agent"), { recursive: true });
        writeFileSync(settings, JSON.stringify({ packages: ["npm:billion-context"] }));
        lines = await pluginUpdate(["pi"], OPTS);
        assert.match(lines[0], /pi-managed/);
        assert.match(lines[0], /pi update/);
        assert.match(lines[0], /#991/);
    } finally {
        delete process.env.PI_HOME;
        cleanup();
    }
});

test("pluginUpdate: dsh lane short-circuits offline when dsh is not initialized", async () => {
    const { home, cleanup } = scratchHome();
    process.env.DSH_HOME = path.join(home, "dsh");
    try {
        const lines = await pluginUpdate(["dsh"], OPTS);
        assert.match(lines[0], /never initialized|nothing to update/);
    } finally {
        delete process.env.DSH_HOME;
        cleanup();
    }
});

// #2199/#1234: the opencode channel wording must describe the ACCEPTED behavior —
// the cache copy self-updates in place via its own proxy (not "opencode owns it /
// never overwrites"), OpenCode v2 `plugin update` is only an extra manual channel,
// and a disk update needs a host reload to activate. Pins acceptance criterion 2.
test("UPDATE_CHANNEL.opencode is consistent with #1234 (self-update in place, not 'never overwrites')", () => {
    assert.match(UPDATE_CHANNEL.opencode, /self-updates in place/);
    assert.match(UPDATE_CHANNEL.opencode, /#1234/);
    assert.match(UPDATE_CHANNEL.opencode, /reload\/restart OpenCode/);
    assert.doesNotMatch(UPDATE_CHANNEL.opencode, /never overwrites/i);
    assert.doesNotMatch(UPDATE_CHANNEL.opencode, /opencode owns the copy/i);
});

test("opencodeCacheCopyRoot: resolves newest spec slot / newest timestamp, undefined when absent", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-oc-cache-root-"));
    try {
        const cacheHome = path.join(base, "cache");
        // no cache dir at all → undefined
        assert.equal(opencodeCacheCopyRoot({ XDG_CACHE_HOME: cacheHome }), undefined);
        const latest = path.join(cacheHome, "opencode", "npm", "billion-context@latest");
        const older = path.join(latest, "1700000000000");
        const newer = path.join(latest, "1800000000000");
        mkdirSync(path.join(newer, "node_modules", "billion-context"), { recursive: true });
        writeFileSync(path.join(newer, "node_modules", "billion-context", "package.json"), JSON.stringify({ name: "billion-context", version: "2.0.0" }));
        mkdirSync(path.join(older, "node_modules", "billion-context"), { recursive: true });
        writeFileSync(path.join(older, "node_modules", "billion-context", "package.json"), JSON.stringify({ name: "billion-context", version: "1.0.0" }));
        const newerRoot = path.join(newer, "node_modules", "billion-context");
        assert.equal(opencodeCacheCopyRoot({ XDG_CACHE_HOME: cacheHome }), newerRoot, "newest timestamp wins");
        // a non-bili slot (even numerically newer) is ignored
        const otherSlot = path.join(cacheHome, "opencode", "npm", "zzz-pkg@latest", "9999999999999", "node_modules", "zzz-pkg");
        mkdirSync(otherSlot, { recursive: true });
        assert.equal(opencodeCacheCopyRoot({ XDG_CACHE_HOME: cacheHome }), newerRoot);
    } finally {
        rmrf(base);
    }
});

// #2260(F): spec slots must order by VERSION, not by string — lexicographic
// sort put @0.1.9 ahead of @0.1.186 ("9" > "1"), reporting the STALE copy.
test("opencodeCacheCopyRoot: version-ordered spec slots (0.1.186 beats 0.1.9); non-numeric specs keep string order", () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-oc-cache-ver-"));
    try {
        const cacheHome = path.join(base, "cache");
        const npm = path.join(cacheHome, "opencode", "npm");
        const make = (spec: string, version: string): string => {
            const root = path.join(npm, `billion-context@${spec}`, "1700000000000", "node_modules", "billion-context");
            mkdirSync(root, { recursive: true });
            writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "billion-context", version }));
            return root;
        };
        make("0.1.9", "0.1.9");
        const v186 = make("0.1.186", "0.1.186");
        assert.equal(opencodeCacheCopyRoot({ XDG_CACHE_HOME: cacheHome }), v186, "numeric version order, not lexicographic");
        // non-numeric specs keep their pre-existing relative position (string compare)
        const latest = make("latest", "9.9.9");
        assert.equal(opencodeCacheCopyRoot({ XDG_CACHE_HOME: cacheHome }), latest, "'latest' still sorts after digit-led specs");
    } finally {
        rmrf(base);
    }
});

test("pluginUpdate: opencode lane reports self-update-in-place (#1234), surfaces disk version, never claims 'never overwrites'", async () => {
    const base = mkdtempSync(path.join(tmpdir(), "bc-plugin-update-"));
    try {
        const cfgDir = path.join(base, "cfg");
        mkdirSync(cfgDir, { recursive: true });
        const cfgFile = path.join(cfgDir, "opencode.json");
        writeFileSync(cfgFile, JSON.stringify({ plugins: ["billion-context"] }));
        const cacheHome = path.join(base, "cache");
        const copy = path.join(cacheHome, "opencode", "npm", "billion-context@latest", "1700000000000", "node_modules", "billion-context");
        mkdirSync(copy, { recursive: true });
        writeFileSync(path.join(copy, "package.json"), JSON.stringify({ name: "billion-context", version: "9.9.9" }));
        process.env.OPENCODE_CONFIG = cfgFile;
        process.env.XDG_CACHE_HOME = cacheHome;
        try {
            const lines = await pluginUpdate(["opencode"], OPTS);
            assert.equal(lines.length, 1);
            assert.match(lines[0], /self-updates in place/);
            assert.match(lines[0], /#1234/);
            assert.match(lines[0], /v9\.9\.9/);
            assert.match(lines[0], /does NOT run opencode's upgrade/);
            assert.doesNotMatch(lines[0], /never overwrites/i);
        } finally {
            delete process.env.OPENCODE_CONFIG;
            delete process.env.XDG_CACHE_HOME;
        }
    } finally {
        rmrf(base);
    }
});
