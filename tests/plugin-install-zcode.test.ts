// #6891: `bili plugin install zcode` must pin the ABSOLUTE node path into the
// managed hook/MCP entries — the ZCode binary spawns the JSON config's
// `command` directly (no shell), so a bare `node` only resolves through the
// client process's own PATH, which need not include node. The doctor probe
// must surface pre-fix bare-`node` entries as an advisory (the lane still
// works when node IS on the client PATH) and existence-check absolute ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectLanePresence, pluginInstall, selfPackageRoot } from "../src/plugin-install.ts";
import { renderDoctorReport, runDoctor } from "../src/doctor.ts";
import { rmrf } from "./tmp-rm.ts";

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withHome(t: import("node:test").TestContext, home: string): void {
    const prevHome = process.env.HOME;
    const prevUp = process.env.USERPROFILE;
    process.env.HOME = home;
    // Windows os.homedir() resolves through USERPROFILE, not HOME — mirror the
    // sandboxed HOME there or real-machine config (~/.zcode) leaks in.
    if (process.platform === "win32") process.env.USERPROFILE = home;
    t.after(() => {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUp === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUp;
        rmrf(home);
    });
}

type ZcodeCfg = {
    hooks?: { enabled?: boolean; events?: { SessionStart?: unknown[] } };
    mcp?: { servers?: Record<string, { type?: string; command?: string; args?: string[] }> };
};

const hookEntry = (): string => path.join(selfPackageRoot(), "dist", "zcode", "bootstrap-hook.js");
const mcpEntry = (): string => path.join(selfPackageRoot(), "dist", "zcode", "mcp-entry.js");

function ourHookCommand(doc: ZcodeCfg): string | undefined {
    const entries = doc.hooks?.events?.SessionStart ?? [];
    for (const e of entries) {
        const hooks = (e as { hooks?: Array<{ command?: string; args?: string[] }> })?.hooks;
        if (Array.isArray(hooks) && hooks.some((h) => (h.args ?? []).some((a) => /zcode[\\/]bootstrap-hook\.(js|ts)$/.test(a)))) {
            return hooks[0]?.command as string | undefined;
        }
    }
    return undefined;
}

test("#6891: plugin install zcode pins the absolute node path in hook + MCP entries", (t) => {
    const home = tempDir("bili-zcode-inst-");
    withHome(t, home);
    const out = pluginInstall("zcode");
    assert.match(out, /wrote the billion-context hook\+MCP into/);
    const doc = JSON.parse(fs.readFileSync(path.join(home, ".zcode", "cli", "config.json"), "utf8")) as ZcodeCfg;
    assert.equal(doc.hooks?.enabled, true);
    assert.equal(ourHookCommand(doc), process.execPath);
    assert.ok(path.isAbsolute(ourHookCommand(doc)!), "hook command must be absolute");
    assert.deepEqual(doc.mcp?.servers?.bili, { type: "stdio", command: process.execPath, args: [mcpEntry()] });
});

test("#6891: reinstall upgrades a pre-fix bare-`node` entry to the absolute node path", (t) => {
    const home = tempDir("bili-zcode-heal-");
    withHome(t, home);
    const file = path.join(home, ".zcode", "cli", "config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
        hooks: { enabled: true, events: { SessionStart: [{ hooks: [{ type: "process", command: "node", args: [hookEntry()] }] }] } },
        mcp: { servers: { bili: { type: "stdio", command: "node", args: [mcpEntry()] } } },
    }, null, 2));
    const out = pluginInstall("zcode");
    assert.match(out, /replaced a previous bili SessionStart entry/);
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as ZcodeCfg;
    assert.equal(ourHookCommand(doc), process.execPath);
    assert.equal(doc.mcp?.servers?.bili?.command, process.execPath);
});

test("#6891: a foreign mcp.servers.bili is still refused (§7.3)", (t) => {
    const home = tempDir("bili-zcode-foreign-");
    withHome(t, home);
    const file = path.join(home, ".zcode", "cli", "config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ mcp: { servers: { bili: { type: "stdio", command: "node", args: ["/opt/user-mcp/bili.js"] } } } }, null, 2));
    assert.throws(() => pluginInstall("zcode"), /already defines mcp\.servers\.bili owned by something else/);
});

// Hermetic dist stand-ins: the probe's targets point at sandbox files, so the
// tests never depend on whether the repo's dist/ is built.
function sandboxZcodeConfig(home: string, command: string): { hookEntry: string; mcpEntry: string } {
    const root = path.join(home, "bili-root");
    const hook = path.join(root, "dist", "zcode", "bootstrap-hook.js");
    const mcp = path.join(root, "dist", "zcode", "mcp-entry.js");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "");
    fs.writeFileSync(mcp, "");
    fs.mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    fs.writeFileSync(path.join(home, ".zcode", "cli", "config.json"), JSON.stringify({
        hooks: { enabled: true, events: { SessionStart: [{ hooks: [{ type: "process", command, args: [hook] }] }] } },
        mcp: { servers: { bili: { type: "stdio", command, args: [mcp] } } },
    }, null, 2));
    return { hookEntry: hook, mcpEntry: mcp };
}

test("#6891: doctor probe — bare-`node` entries warn (advisory), absolute node path is an existence-checked target", (t) => {
    const home = tempDir("bili-zcode-probe-");
    withHome(t, home);

    const { hookEntry: hook, mcpEntry: mcp } = sandboxZcodeConfig(home, "node");
    let p = inspectLanePresence("zcode");
    assert.equal(p.installed, true);
    assert.equal(p.spawnWarnings?.length, 2, `expected 2 spawn warnings, got ${JSON.stringify(p.spawnWarnings)}`);
    assert.match(p.spawnWarnings![0], /SessionStart hook command "node" is a bare PATH-resolved token/);
    assert.match(p.spawnWarnings![0], /#6891/);
    assert.match(p.spawnWarnings![1], /MCP server command "node" is a bare PATH-resolved token/);
    // dist entries stay the targets; the bare node command is NOT one
    assert.deepEqual(p.targets, [hook, mcp]);

    sandboxZcodeConfig(home, process.execPath);
    p = inspectLanePresence("zcode");
    assert.equal(p.installed, true);
    assert.equal(p.spawnWarnings, undefined, "absolute node path must not warn");
    assert.deepEqual(p.targets, [hook, mcp, process.execPath]);
});



function mockFetch(handler: (url: string) => Response | Promise<Response>): (fn: () => Promise<void>) => Promise<void> {
    const original = globalThis.fetch;
    return (fn) => {
        globalThis.fetch = ((url: unknown) => Promise.resolve(handler(String(url)))) as unknown as typeof fetch;
        return fn().finally(() => {
            globalThis.fetch = original;
        });
    };
}

function doctorSandboxEnv(base: string): Record<string, string | undefined> {
    return {
        HOME: path.join(base, "home"),
        XDG_CONFIG_HOME: path.join(base, "xdg-config"),
        XDG_DATA_HOME: path.join(base, "xdg-data"),
        XDG_CACHE_HOME: path.join(base, "xdg-cache"),
        XDG_STATE_HOME: path.join(base, "xdg-state"),
        PI_CODING_AGENT_DIR: undefined, PI_HOME: undefined, DSH_HOME: undefined, HERMES_HOME: undefined,
        KIMI_CODE_HOME: undefined, CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, OPENCODE_CONFIG: undefined,
    };
}

test("#6891: runDoctor — bare-`node` zcode lane keeps its verdict and gains an advisory warning", async (t) => {
    const base = tempDir("bili-zcode-doctor-");
    const runWithFetch = mockFetch(() => new Response(JSON.stringify({ name: "billion-context", version: "999.0.0" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    try {
        await runWithFetch(async () => {
            const prev = process.env;
            const saved: Record<string, string | undefined> = {};
            for (const [k, v] of Object.entries(doctorSandboxEnv(base))) {
                saved[k] = prev[k];
                if (v === undefined) delete prev[k];
                else prev[k] = v;
            }
            if (process.platform === "win32") prev.USERPROFILE = prev.HOME;
            t.after(() => {
                for (const [k, v] of Object.entries(saved)) {
                    if (v === undefined) delete prev[k];
                    else prev[k] = v;
                }
            });
            const home = path.join(base, "home");

            sandboxZcodeConfig(home, "node");
            const bare = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
            const zc = bare.lanes.find((l) => l.agent === "zcode");
            assert.ok(zc, "zcode lane present");
            // the warning must NOT change the verdict: targets exist, so ok
            assert.equal(zc?.verdict, "ok", `bare-node is advisory, got ${JSON.stringify(zc)}`);
            assert.ok(zc?.warnings?.some((w) => w.includes('command "node"') && w.includes("#6891")), `expected bare-node warning, got ${JSON.stringify(zc?.warnings)}`);
            assert.match(renderDoctorReport(bare), /⚠️ .*command "node" is a bare PATH-resolved token/);

            sandboxZcodeConfig(home, process.execPath);
            const fixed = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
            const zf = fixed.lanes.find((l) => l.agent === "zcode");
            assert.equal(zf?.verdict, "ok");
            assert.equal(zf?.warnings, undefined, "fixed install must not warn");

            // an absolute node command that is gone on disk IS a real defect
            const ghost = path.join(home, "gone-node");
            sandboxZcodeConfig(home, ghost);
            const gone = await runDoctor({ packageName: "billion-context", runningVersion: "0.1.143" });
            const zg = gone.lanes.find((l) => l.agent === "zcode");
            assert.equal(zg?.verdict, "broken", `missing node binary must break the lane, got ${JSON.stringify(zg)}`);
            assert.match(zg?.reason ?? "", new RegExp(`target missing: .*gone-node`));
        });
    } finally {
        rmrf(base);
    }
});
