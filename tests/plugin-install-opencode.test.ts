import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    applyOpencodePluginEntry,
    isNpmInstallForm,
    OPENCODE_NPM_ENTRY,
    pluginInstall,
    pluginRemove,
    pluginStatusAll,
    selfPackageRoot,
} from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

const NPM_ROOT = "/usr/local/lib/node_modules/billion-context";

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function entryArgs(root: string, base: string): { data: Record<string, unknown>; root: string; shimDir: string; agentJs: string } {
    const shimDir = path.join(base, "opencode", "plugins", "billion-context");
    return { data: {}, root, shimDir, agentJs: path.join(root, "dist", "agent", "opencode-native.js") };
}

test("isNpmInstallForm: npm/pnpm/yarn roots are npm form, checkouts are not", () => {
    assert.equal(isNpmInstallForm("/usr/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/usr/local/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/.npm-global/lib/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/proj/node_modules/.pnpm/billion-context@0.1.118/node_modules/billion-context"), true);
    assert.equal(isNpmInstallForm("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\billion-context"), true);
    assert.equal(isNpmInstallForm("/home/u/checkouts/billion-context"), false);
    assert.equal(isNpmInstallForm("/opt/bili"), false);
    assert.equal(isNpmInstallForm("/srv/node_modules"), false);
});

test("applyOpencodePluginEntry: npm form writes the bare package name only", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-npm-"));
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [OPENCODE_NPM_ENTRY]);
    assert.deepEqual(notes, [`plugin -> ${OPENCODE_NPM_ENTRY}`]);
    assert.equal(fs.existsSync(args.shimDir), false);
});

test("applyOpencodePluginEntry: npm form migrates a legacy dev shim to the bare name and deletes the dir", () => {
    const base = tempDir("bili-oc-migrate-");
    const args = entryArgs(NPM_ROOT, base);
    fs.mkdirSync(args.shimDir, { recursive: true });
    fs.writeFileSync(path.join(args.shimDir, "index.js"), 'export { default } from "/opt/old/dist/agent/opencode-native.js";\n');
    args.data.plugin = ["other-pkg", args.shimDir];
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, ["other-pkg", OPENCODE_NPM_ENTRY]);
    assert.equal(notes[0], `plugin -> ${OPENCODE_NPM_ENTRY} (replaced ${args.shimDir})`);
    assert.equal(fs.existsSync(args.shimDir), false);
});

test("applyOpencodePluginEntry: npm form is idempotent", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-idem-"));
    args.data.plugin = [OPENCODE_NPM_ENTRY];
    assert.deepEqual(applyOpencodePluginEntry(args), ["plugin present"]);
    assert.deepEqual(args.data.plugin, [OPENCODE_NPM_ENTRY]);
});

test("applyOpencodePluginEntry: dev form writes a local shim and warns it is not portable", () => {
    const args = entryArgs("/opt/checkout-bili", tempDir("bili-oc-dev-"));
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [args.shimDir]);
    assert.equal(notes[0], `plugin -> ${args.shimDir}`);
    assert.match(notes[1], /not portable across machines/);
    const shim = fs.readFileSync(path.join(args.shimDir, "index.js"), "utf8");
    assert.equal(shim, `export { default } from ${JSON.stringify(args.agentJs)};\n`);
});

test("applyOpencodePluginEntry: dev form replaces an existing bare-name entry with the shim", () => {
    const args = entryArgs("/opt/checkout-bili", tempDir("bili-oc-dev-replace-"));
    args.data.plugin = [OPENCODE_NPM_ENTRY];
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [args.shimDir]);
    assert.equal(notes[0], `plugin -> ${args.shimDir} (replaced ${OPENCODE_NPM_ENTRY})`);
    assert.match(notes[1], /not portable across machines/);
});

test("applyOpencodePluginEntry: non-string plugin entries are preserved verbatim (#1002)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-nonstr-"));
    const objs = [{ package: "@org/x" }, { package: "y", options: { z: 1 } }];
    args.data.plugin = [42, null, ...objs, "other-pkg"];
    const notes = applyOpencodePluginEntry(args);
    assert.deepEqual(args.data.plugin, [42, null, ...objs, "other-pkg", OPENCODE_NPM_ENTRY]);
    assert.deepEqual(notes, [`plugin -> ${OPENCODE_NPM_ENTRY}`]);
});

test("applyOpencodePluginEntry: idempotent run with foreign objects leaves the key untouched (#1002)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-idem-obj-"));
    const objs = [{ package: "@org/x" }];
    args.data.plugin = [...objs, OPENCODE_NPM_ENTRY];
    const touched = new Set<string>();
    const before = args.data.plugin;
    assert.deepEqual(applyOpencodePluginEntry({ ...args, touched }), ["plugin present"]);
    assert.equal(touched.size, 0, "no key touched — no rewrite");
    assert.equal(args.data.plugin, before, "same array reference, untouched");
});

test("applyOpencodePluginEntry: map-form plugins keep foreign options and stay a map (#1002)", () => {
    const args = entryArgs(NPM_ROOT, tempDir("bili-oc-map-"));
    args.data.plugins = { "@org/x": { options: { z: 1 } }, "plain-y": true };
    applyOpencodePluginEntry({ ...args, key: "plugins" });
    assert.deepEqual(args.data.plugins, { "@org/x": { options: { z: 1 } }, "plain-y": true, [OPENCODE_NPM_ENTRY]: true });
    assert.ok(!Array.isArray(args.data.plugins), "map form preserved");
});

type OcCfg = { plugin?: unknown; compaction?: { auto?: boolean } & Record<string, unknown>; mcp?: unknown };

test("pluginInstall/remove/status opencode end-to-end (dev form under tsx)", (t) => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    const prevOpen = process.env.OPENCODE_CONFIG;
    const prevMcp = process.env.BILI_MCP_PROXY;
    const prevBin = process.env.BILI_CLIENT_BIN;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.BILI_MCP_PROXY;
    // Hermetic probe: an unresolvable bin fails soft to major 1, so the test
    // never depends on whatever `opencode` the host PATH (or an npm test
    // node_modules/.bin walk) happens to shadow in.
    process.env.BILI_CLIENT_BIN = "/nonexistent/bili-oc-probe-pin";
    const xdg = tempDir("bili-oc-xdg-");
    const state = tempDir("bili-oc-state-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.XDG_STATE_HOME = state;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevState;
        if (prevOpen === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOpen;
        if (prevMcp === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevMcp;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        rmrf(xdg);
        rmrf(state);
    });

    const file = path.join(xdg, "opencode", "opencode.json");
    const shimDir = path.join(xdg, "opencode", "plugins", "billion-context");
    const readCfg = (): OcCfg => JSON.parse(fs.readFileSync(file, "utf8")) as OcCfg;
    const ocStatus = () => pluginStatusAll().find((r) => r.agent === "opencode")?.status;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude", plugin: ["some-other"], compaction: { auto: true } }, null, 2));

    assert.equal(ocStatus(), "not installed");

    const out = pluginInstall("opencode");
    assert.ok(out.startsWith(`opencode: installed -> ${file}`), out);
    assert.match(out, /plugin -> .+plugins[\\/]billion-context/);
    assert.match(out, /machine-local shim, not portable across machines/);
    let cfg = readCfg();
    assert.deepEqual(cfg.plugin, ["some-other", shimDir]);
    assert.equal(cfg.compaction?.auto, false);
    assert.equal(cfg.mcp, undefined);
    const shim = fs.readFileSync(path.join(shimDir, "index.js"), "utf8");
    assert.equal(shim, `export { default } from ${JSON.stringify(path.join(selfPackageRoot(), "dist", "agent", "opencode-native.js"))};\n`);
    assert.equal(ocStatus(), "installed");

    const again = pluginInstall("opencode");
    assert.match(again, /plugin present/);
    assert.deepEqual(readCfg().plugin, ["some-other", shimDir]);

    const rem = pluginRemove("opencode");
    assert.match(rem, /^opencode: removed from /);
    assert.match(rem, /plugin removed \(/);
    cfg = readCfg();
    assert.deepEqual(cfg.plugin, ["some-other"]);
    assert.equal(cfg.compaction?.auto, true);
    assert.equal(fs.existsSync(shimDir), false);
    assert.equal(ocStatus(), "not installed");

    assert.match(pluginRemove("opencode"), /not installed/);
});

const MCP_PINNED = { type: "local", command: ["/usr/bin/node", "/opt/old/dist/mcp.js"], environment: { BILI_MCP_PROXY: "http://127.0.0.1:18787" }, enabled: true };

type OcMcpCfg = { plugin?: unknown; mcp?: { bili?: Record<string, unknown> } & Record<string, unknown> };

function withOcConfig(t: import("node:test").TestContext, initial: OcMcpCfg): { file: string; read: () => OcMcpCfg } {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevState = process.env.XDG_STATE_HOME;
    const prevOpen = process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG;
    const xdg = tempDir("bili-oc-mcp-");
    const state = tempDir("bili-oc-mcp-state-");
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.XDG_STATE_HOME = state;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevState;
        if (prevOpen === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOpen;
        rmrf(xdg);
        rmrf(state);
    });
    const file = path.join(xdg, "opencode", "opencode.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(initial, null, 2));
    return { file, read: () => JSON.parse(fs.readFileSync(file, "utf8")) as OcMcpCfg };
}

test("#926 default install never writes mcp.bili, even with BILI_MCP_PROXY set", (t) => {
    const prevEnv = process.env.BILI_MCP_PROXY;
    process.env.BILI_MCP_PROXY = "http://127.0.0.1:18787";
    t.after(() => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
    });
    const { read } = withOcConfig(t, {});
    const out = pluginInstall("opencode");
    assert.match(out, /mcp\.bili not written/);
    assert.equal(read().mcp, undefined);
});

test("#926 default install heals a stale pinned mcp.bili from an older install", (t) => {
    const { read } = withOcConfig(t, { mcp: { bili: MCP_PINNED } });
    const out = pluginInstall("opencode");
    assert.match(out, /mcp\.bili removed \(stale second tool face/);
    assert.equal(read().mcp, undefined);
});

test("#926 --with-mcp writes mcp.bili without an origin pin (live discovery)", (t) => {
    const prevEnv = process.env.BILI_MCP_PROXY;
    delete process.env.BILI_MCP_PROXY;
    t.after(() => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
    });
    const { read } = withOcConfig(t, {});
    const out = pluginInstall("opencode", { withMcp: true });
    assert.match(out, /mcp\.bili written \(no origin pin/);
    const bili = read().mcp?.bili;
    assert.ok(bili, "mcp.bili written");
    assert.equal(bili!.environment, undefined);
    assert.equal(bili!.enabled, true);
});

test("#926 --with-mcp pins the origin only when BILI_MCP_PROXY is explicit", (t) => {
    const prevEnv = process.env.BILI_MCP_PROXY;
    process.env.BILI_MCP_PROXY = "http://127.0.0.1:8787";
    t.after(() => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
    });
    const { read } = withOcConfig(t, {});
    const out = pluginInstall("opencode", { withMcp: true });
    assert.match(out, /mcp\.bili written \(BILI_MCP_PROXY=http:\/\/127\.0\.0\.1:8787\)/);
    const bili = read().mcp?.bili;
    assert.deepEqual(bili!.environment, { BILI_MCP_PROXY: "http://127.0.0.1:8787" });
});

test("#926 --with-mcp strips a stale pin from an existing entry but keeps the entry", (t) => {
    const prevEnv = process.env.BILI_MCP_PROXY;
    delete process.env.BILI_MCP_PROXY;
    t.after(() => {
        if (prevEnv === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevEnv;
    });
    const { read } = withOcConfig(t, { mcp: { bili: MCP_PINNED } });
    const out = pluginInstall("opencode", { withMcp: true });
    assert.match(out, /mcp\.bili present \(stale BILI_MCP_PROXY pin removed/);
    const bili = read().mcp?.bili;
    assert.ok(bili, "entry kept");
    assert.equal(bili!.environment, undefined);
    assert.deepEqual(bili!.command, ["/usr/bin/node", "/opt/old/dist/mcp.js"]);
    assert.equal(bili!.enabled, true);
});
