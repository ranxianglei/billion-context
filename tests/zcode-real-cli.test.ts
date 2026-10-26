// Real zcode client canary (#1892 hardening). The rest of the suite proves
// our mcp-entry speaks a correct MCP handshake; this file proves the entry
// still plugs into the REAL zcode client binary:
//
//   1. the pinned CLI still boots (`--version`),
//   2. the config-path + store-schema assumptions bili's json-edit makes
//      still hold in the binary (upstream renames fail LOUDLY here, not as a
//      silent "no route" in production),
//   3. the real client still discovers + spawns our entry from
//      ~/.zcode/cli/config.json `mcp.servers` and our entry survives the
//      spawn (degraded idle serving) instead of dying pre-initialize.
//
// Gated behind ACP_TEST_ZCODE_CLI=<path to the real zcode.cjs> — exported by
// .github/workflows/ci-zcode-real.yml (pinned AppImage, cached by checksum).
// Headless note: a real zcode turn needs an OAuth-logged-in model, so the
// client tears the MCP stack down before the handshake completes; the
// spawn+survive assertions below are the deepest checks possible headless.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const ZCODE_CLI = process.env.ACP_TEST_ZCODE_CLI ?? "";
const ENTRY = path.join(ROOT, "dist", "zcode", "mcp-entry.js");

function sandboxEnv(sandbox: string, home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
        "BILLION_CONTEXT_PROXY",
        "BILLION_CONTEXT_ATTACH",
        "BILLION_CONTEXT_PLUGIN",
        "BILI_MCP_PROXY",
        "BILI_PROVIDER_REWRITES",
        "BILI_MITM_HOSTS",
        "BILI_ZCODE_ROUTE",
        "NODE_TEST_CONTEXT",
    ]) {
        delete env[key];
    }
    env.HOME = home;
    env.XDG_STATE_HOME = sandbox;
    env.XDG_CACHE_HOME = path.join(sandbox, "cache");
    env.XDG_DATA_HOME = path.join(sandbox, "data");
    env.XDG_CONFIG_HOME = path.join(sandbox, "config");
    return { ...env, ...extra };
}

async function waitForFile(file: string, timeoutMs: number, what: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (existsSync(file)) {
            const text = readFileSync(file, "utf8");
            if (text.trim().length > 0) return text;
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${file}: ${what}`);
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

test("real zcode cli: boots and reports a version", { skip: ZCODE_CLI === "" }, async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "zcode-real-"));
    const home = mkdtempSync(path.join(tmpdir(), "zcode-home-"));
    const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [ZCODE_CLI, "--version"], {
            env: sandboxEnv(sandbox, home),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
        child.on("exit", (code) => resolve({ code, out }));
        child.on("error", (err) => resolve({ code: -1, out: String(err) }));
    });
    assert.equal(res.code, 0, `zcode --version failed:\n${res.out}`);
    assert.match(res.out, /\d+\.\d+\.\d+/, "expected a semver in --version output");
    await rmrf(sandbox);
    await rmrf(home);
});

test("real zcode cli: bili's config-path and store-schema assumptions still hold", { skip: ZCODE_CLI === "" }, () => {
    const src = readFileSync(ZCODE_CLI, "utf8");
    // json-edit.ts writes ~/.zcode/cli/config.json and v2/provider_config.json
    // (nested providerConfigRules.providerRules for the desktop host shape).
    // The CLI additionally reads a flat config.providerRules array. If upstream
    // renames any of these, our routing silently degrades to "no route" —
    // fail here so the next zcode release gets a loud heads-up instead.
    const expectations: Array<[string, string]> = [
        [".zcode/cli", "settings directory (~/.zcode/cli/config.json)"],
        ["provider_config.json", "personal provider store file name"],
        ["mcp.servers", "MCP server discovery key in cli/config.json"],
        ["providerRules", "provider rule array key (flat CLI shape + nested host shape)"],
    ];
    for (const [needle, why] of expectations) {
        assert.ok(src.includes(needle), `zcode.cjs no longer mentions ${JSON.stringify(needle)} (${why}) — json-edit.ts assumptions are stale; re-audit src/zcode/json-edit.ts against this release`);
    }
});

test("real zcode cli: discovers and spawns our mcp-entry from cli/config.json", { skip: ZCODE_CLI === "" || !existsSync(ENTRY) ? "set ACP_TEST_ZCODE_CLI and run npm run build first" : false }, async (t) => {
    const sandbox = mkdtempSync(path.join(tmpdir(), "zcode-real-"));
    const home = mkdtempSync(path.join(tmpdir(), "zcode-home-"));
    t.after(() => { void rmrf(sandbox); void rmrf(home); });

    const markerLog = path.join(sandbox, "spawned.log");
    const markerErr = path.join(sandbox, "spawned.stderr");
    const wrapper = path.join(sandbox, "bili-entry.sh");
    writeFileSync(
        wrapper,
        `#!/bin/bash\n{ echo "spawned $(date)"; } >> ${JSON.stringify(markerLog)}\nnode ${ENTRY} 2>> ${JSON.stringify(markerErr)}\n{ echo "exit $?"; } >> ${JSON.stringify(markerLog)}\n`,
        { mode: 0o755 },
    );
    mkdirSync(path.join(home, ".zcode", "cli"), { recursive: true });
    writeFileSync(
        path.join(home, ".zcode", "cli", "config.json"),
        JSON.stringify({ mcp: { servers: { bili: { type: "stdio", command: wrapper } } } }),
    );

    // Empty personal store = the #1892 trigger: entry must stay a server.
    mkdirSync(path.join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(
        path.join(home, ".zcode", "v2", "provider_config.json"),
        JSON.stringify({
            schemaVersion: 1,
            config: {
                providerConfigRules: { templateRules: [], providerRules: [] },
                modelConfigRules: { modelRules: [], modelApiRules: [], providerSiteRules: [], templateModelRules: [], builtinProviderModelRules: [] },
            },
        }),
    );

    const child = spawn(process.execPath, [ZCODE_CLI, "--prompt", "hi"], {
        env: sandboxEnv(sandbox, home, { ZCODE_LOG_DIR: path.join(sandbox, "zcode-logs") }),
        stdio: ["ignore", "ignore", "pipe"],
    });
    t.after(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } });

    // The turn fails headless (no model) and the client SIGKILLs the MCP
    // child at teardown — buffered entry logs die with it, so the log-level
    // proof (degraded idle serving, initialize handshake) stays in the
    // normal matrix (tests/zcode-mcp-degraded.test.ts). Here we assert the
    // real-client contract that CAN be observed headlessly: discovery +
    // spawn of our entry from mcp.servers in cli/config.json.
    const spawnLog = await waitForFile(markerLog, 45_000, "real zcode cli never spawned the configured bili MCP server");
    assert.ok(spawnLog.includes("spawned"), "marker log must record the spawn");
    await new Promise((r) => setTimeout(r, 1_000));
    // Best-effort: when the entry survived long enough to flush, it must be
    // in degraded idle mode (never a pre-initialize death).
    const errText = existsSync(markerErr) ? readFileSync(markerErr, "utf8") : "";
    if (errText.includes("[bili-zcode]")) {
        assert.ok(
            errText.includes("degraded: serving an idle MCP endpoint"),
            `entry stderr shows bili-zcode output without the degraded idle line:\n${errText.slice(-600)}`,
        );
    }
});
