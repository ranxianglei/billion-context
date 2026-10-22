import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

// zcodeUserConfigFile() resolves os.homedir() on every call; isolate it BEFORE
// this module graph loads so a developer's real ~/.zcode/cli/config.json is
// never read or written by the suite.
const home = mkdtempSync(path.join(tmpdir(), "bc-zcode-legacy-"));
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home;
process.env.USERPROFILE = home;
process.on("exit", () => {
    rmrf(home);
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

const { pluginInstall, pluginRemove, pluginStatusAll } = await import("../src/plugin-install.ts");

const configFile = path.join(home, ".zcode", "cli", "config.json");
const HOOK = "/opt/bc/dist/zcode/bootstrap-hook.js";

function seed(doc: unknown): void {
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify(doc, null, 2));
}
function read(): Record<string, any> {
    return JSON.parse(readFileSync(configFile, "utf8")) as Record<string, any>;
}
function managedDoc(mcp?: unknown): Record<string, unknown> {
    const doc: Record<string, any> = {
        hooks: { enabled: true, events: { SessionStart: [{ hooks: [{ type: "process", command: "node", args: [HOOK] }] }] } },
    };
    if (mcp !== undefined) doc.mcp = { servers: { bili: mcp } };
    return doc;
}

// #1145 follow-up: pre-#1145 installs wrote a `bili mcp` shim. It is ours, so
// an upgrade must replace it in place — not classify it as foreign.
test("a legacy managed bili mcp shim is upgraded in place instead of blocking install", () => {
    seed(managedDoc({
        type: "stdio",
        command: "C:\\Users\\me\\.local\\bin\\bili.exe",
        args: ["mcp"],
        env: { BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" },
    }));
    const msg = pluginInstall("zcode");
    assert.match(msg, /replaced the legacy bili mcp shim/);
    const server = read().mcp.servers.bili;
    assert.equal(server.type, "stdio");
    assert.equal(server.command, "node");
    assert.match(String(server.args[0]), /zcode[\\/]mcp-entry\.js$/);
    assert.equal(server.env, undefined);
});

test("the legacy shim is reported as a stale face, not as a missing one", () => {
    seed(managedDoc({ type: "stdio", command: "/usr/local/bin/bili", args: ["mcp"] }));
    const row = pluginStatusAll().find((r) => r.agent === "zcode");
    assert.ok(row);
    assert.match(row.status, /legacy bili mcp shim/);
});

test("plugin remove strips a legacy shim this installer wrote", () => {
    seed({ mcp: { servers: { bili: { type: "stdio", command: "bili.exe", args: ["mcp"] } } } });
    pluginRemove("zcode");
    assert.equal(read().mcp?.servers?.bili, undefined);
});

test("a user-authored bili server still refuses to be overwritten", () => {
    seed(managedDoc({ type: "stdio", command: "python", args: ["-m", "my_bili_mcp"] }));
    assert.throws(() => pluginInstall("zcode"), /owned by something else/);
});

test("lookalike commands with extra args are not claimed as ours", () => {
    seed(managedDoc({ type: "stdio", command: "bili", args: ["mcp", "--serve"] }));
    assert.throws(() => pluginInstall("zcode"), /owned by something else/);
});
