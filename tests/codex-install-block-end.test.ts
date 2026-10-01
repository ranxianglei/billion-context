import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginInstall, selfPackageRoot } from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

// #1064: codexInstall ended the [mcp_servers.bili] block at indexOf("\n["),
// which misses an indented next-table header — the block ran to EOF and a
// refresh deleted everything after it. End detection must match codexRemove
// (next table-header line, optional indent).
const FIXTURE = [
    'model = "gpt-test"',
    "",
    "[mcp_servers.bili]",
    'command = "stale-command"',
    'args = ["stale"]',
    "",
    "   [mcp_servers.other]",
    'command = "other-command"',
    "",
    "[sandbox]",
    'mode = "workspace-write"',
].join("\n") + "\n";

test("codex install refresh keeps content after an indented next table (#1064)", () => {
    const home = mkdtempSync(join(tmpdir(), "bili-codex-home-"));
    const file = join(home, "config.toml");
    writeFileSync(file, FIXTURE);
    const prevHome = process.env.CODEX_HOME;
    const prevProxy = process.env.BILI_MCP_PROXY;
    process.env.CODEX_HOME = home;
    process.env.BILI_MCP_PROXY = "http://127.0.0.1:9999";
    try {
        assert.match(pluginInstall("codex"), /^codex: refreshed /);
        const out = readFileSync(file, "utf8");
        assert.ok(out.includes('model = "gpt-test"'), "top-level key survives");
        assert.ok(out.includes("[mcp_servers.other]"), "indented next-table header survives");
        assert.ok(out.includes('command = "other-command"'), "next-table body survives");
        assert.ok(out.includes("[sandbox]") && out.includes('mode = "workspace-write"'), "trailing table survives");
        assert.ok(!out.includes("stale-command"), "stale bili block replaced");
        // codexBlock serializes the args via JSON.stringify, which escapes
        // Windows separators — match the exact serialized form, not a raw path.
        assert.ok(out.includes(JSON.stringify(join(selfPackageRoot(), "dist", "mcp.js"))), "canonical bili block installed");
        assert.match(pluginInstall("codex"), /already installed/, "second run is a no-op");
    } finally {
        if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
        if (prevProxy === undefined) delete process.env.BILI_MCP_PROXY; else process.env.BILI_MCP_PROXY = prevProxy;
        rmrf(home);
    }
});

test("codex install refresh keeps content after a column-0 next table", () => {
    const home = mkdtempSync(join(tmpdir(), "bili-codex-home-"));
    const file = join(home, "config.toml");
    writeFileSync(file, FIXTURE.replace("   [mcp_servers.other]", "[mcp_servers.other]"));
    const prevHome = process.env.CODEX_HOME;
    const prevProxy = process.env.BILI_MCP_PROXY;
    process.env.CODEX_HOME = home;
    process.env.BILI_MCP_PROXY = "http://127.0.0.1:9999";
    try {
        assert.match(pluginInstall("codex"), /^codex: refreshed /);
        const out = readFileSync(file, "utf8");
        assert.ok(out.includes('[mcp_servers.other]') && out.includes('command = "other-command"'), "next table survives");
        assert.ok(out.includes("[sandbox]") && out.includes('mode = "workspace-write"'), "trailing table survives");
    } finally {
        if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
        if (prevProxy === undefined) delete process.env.BILI_MCP_PROXY; else process.env.BILI_MCP_PROXY = prevProxy;
        rmrf(home);
    }
});
