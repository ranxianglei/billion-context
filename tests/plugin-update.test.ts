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
import { pluginUpdate } from "../src/plugin-install.ts";
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
