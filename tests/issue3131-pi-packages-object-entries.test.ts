import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";

// Isolate ambient HOME so os.homedir() fallbacks never touch the real
// ~/.pi/agent/settings.json (same discipline as plugin-agent.test.ts).
const realHome = process.env.HOME;
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bc-issue3131-home-"));
process.on("exit", () => {
    try { fs.rmSync(process.env.HOME!, { recursive: true, force: true }); } catch { /* best effort */ }
    process.env.HOME = realHome;
});

import { inspectLanePresence, piEntryFor, pluginInstall, pluginRemove, pluginStatusAll, selfPackageRoot } from "../src/plugin-install.ts";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

// #3131: pi's packages[] legally mixes string specs with object entries
// ({source: "…"}). `bili plugin install|remove pi` used to run the whole
// array through String() before writing it back, rewriting every object as
// "[object Object]" and silently destroying users' local packages.
test("pi install/remove preserve object-form packages entries (#3131)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue3131-"));
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const file = path.join(agentDir, "settings.json");
    const entry = piEntryFor(selfPackageRoot());
    const localPkgs = [
        { source: "C:/pkgs/context-mode-pi" },
        { source: "/home/u/pkgs/ponytail-4.10.0" },
    ];
    try {
        // (a) install into a mixed array: objects pass through byte-exact
        fs.writeFileSync(file, JSON.stringify({ model: { name: "gpt-x" }, packages: [...localPkgs, "npm:some-other-pkg"] }, null, 2));
        await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
            assert.match(pluginInstall("pi"), /installed/);
            const data = JSON.parse(fs.readFileSync(file, "utf8")) as { model?: unknown; packages: unknown[] };
            const text = fs.readFileSync(file, "utf8");
            assert.ok(!text.includes("[object Object]"), `objects were stringified:\n${text}`);
            assert.deepEqual(data.packages, [...localPkgs, "npm:some-other-pkg", entry]);
            assert.equal(typeof data.packages[0], "object");
            assert.ok(data.model !== undefined, "unrelated top-level keys survive");
            assert.equal(pluginStatusAll().find((r) => r.agent === "pi")?.status, "installed");
        });

        // (b) re-install is idempotent — no duplicate entry, file untouched
        await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
            const before = fs.readFileSync(file, "utf8");
            assert.match(pluginInstall("pi"), /already installed/);
            assert.equal(fs.readFileSync(file, "utf8"), before);
        });

        // (c) doctor presence view sees the install without coercing objects
        await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
            const lane = inspectLanePresence("pi");
            assert.equal(lane.installed, true);
            assert.deepEqual(lane.pointers, [entry]);
        });

        // (d) remove strips ONLY bili's own string entry; everything else stays
        await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
            assert.match(pluginRemove("pi"), /removed/);
            const data = JSON.parse(fs.readFileSync(file, "utf8")) as { packages: unknown[] };
            assert.deepEqual(data.packages, [...localPkgs, "npm:some-other-pkg"]);
            assert.ok(!fs.readFileSync(file, "utf8").includes("[object Object]"));
            assert.equal(pluginStatusAll().find((r) => r.agent === "pi")?.status, "not installed");
        });

        // (e) second remove: nothing to do, file untouched
        await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
            const before = fs.readFileSync(file, "utf8");
            assert.match(pluginRemove("pi"), /not installed/);
            assert.equal(fs.readFileSync(file, "utf8"), before);
        });

        // (f) install replaces a pre-existing bili STRING entry while preserving
        //     neighboring objects (the #788 replace path on a mixed array)
        fs.writeFileSync(file, JSON.stringify({ packages: ["npm:billion-context", localPkgs[0]] }, null, 2));
        await withEnv({ PI_CODING_AGENT_DIR: agentDir }, async () => {
            const out = pluginInstall("pi");
            assert.match(out, /replaced existing entries: npm:billion-context/);
            const data = JSON.parse(fs.readFileSync(file, "utf8")) as { packages: unknown[] };
            assert.deepEqual(data.packages, [localPkgs[0], entry]);
        });
    } finally {
        rmrf(home);
    }
});
