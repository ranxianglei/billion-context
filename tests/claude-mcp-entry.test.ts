// #1821: claude native MCP entry — watchdog state machine (proxy death →
// respawn with SessionStart-hook-equivalent semantics; origin drift → repin +
// follow), posture gating (attach/passthrough never respawn), and the
// installer's MCP face migration (legacy dist/mcp.js swap, current skip,
// foreign registration untouched).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, startWatchdog, watchdogTick, type MutableWatchdogState, type WatchdogDeps } from "../src/claude-mcp-entry.ts";
import { pluginInstall, readClaudeManagedBaseUrl, selfPackageRoot } from "../src/plugin-install.ts";
import { LAUNCHER_DEFAULT_HOST, type LaunchOptions, type ProxyHandle } from "../src/launcher.ts";
import { ZONE_PORT_BASE } from "../src/config.ts";
import { rmrf } from "./tmp-rm.ts";

const ORIGIN = `http://127.0.0.1:${ZONE_PORT_BASE}`;
const DRIFTED = `http://127.0.0.1:${ZONE_PORT_BASE + 1}`;

function sandbox(): { dir: string; settings: string; mcpJson: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-mcp-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    process.env.XDG_STATE_HOME = path.join(dir, "state");
    return { dir, settings: path.join(dir, "settings.json"), mcpJson: path.join(dir, ".claude.json") };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): void | Promise<void> {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
        prev[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    const restore = () => {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    };
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
}

function tickFixture(origin: string = ORIGIN): {
    state: MutableWatchdogState;
    deps: WatchdogDeps;
    logs: string[];
    ensureCalls: Array<{ opts: LaunchOptions; deps: Record<string, unknown> }>;
    repinCalls: string[];
    setProbe: (ok: boolean) => void;
    setHandle: (h: Partial<ProxyHandle>) => void;
} {
    let probeOk = false;
    let handle: Partial<ProxyHandle> = { origin, attached: false };
    const logs: string[] = [];
    const ensureCalls: Array<{ opts: LaunchOptions; deps: Record<string, unknown> }> = [];
    const repinCalls: string[] = [];
    const deps: WatchdogDeps = {
        probe: async () => probeOk,
        ensure: async (opts, d) => { ensureCalls.push({ opts, deps: d }); return { port: 0, ...handle }; },
        repin: (o) => { repinCalls.push(o); return ["repinned"]; },
        failureLimit: 3,
    };
    return { state: { origin, failures: 0 }, deps, logs, ensureCalls, repinCalls, setProbe: (v) => { probeOk = v; }, setHandle: (h) => { handle = h; } };
}

test("readClaudeManagedBaseUrl: extracts the repinned origin; foreign/absent → undefined", () => {
    const box = sandbox();
    try {
        delete process.env.BILI_MCP_PROXY;
        assert.equal(readClaudeManagedBaseUrl(), undefined);
        fs.writeFileSync(box.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:19999/bili/https://api.anthropic.com" } }));
        assert.equal(readClaudeManagedBaseUrl(), "http://127.0.0.1:19999");
        fs.writeFileSync(box.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://some-relay.example/v1" } }));
        assert.equal(readClaudeManagedBaseUrl(), undefined);
    } finally {
        rmrf(box.dir);
        delete process.env.CLAUDE_CONFIG_DIR;
        delete process.env.XDG_STATE_HOME;
    }
});

test("watchdogTick: healthy probe resets failures without touching bring-up", async () => {
    const f = tickFixture();
    f.setProbe(true);
    f.state.failures = 2;
    await watchdogTick(f.state, { port: ZONE_PORT_BASE, strict: false }, f.deps, (m) => f.logs.push(m));
    assert.equal(f.state.failures, 0);
    assert.equal(f.ensureCalls.length, 0);
});

test("watchdogTick: below the failure limit nothing happens", async () => {
    const f = tickFixture();
    await watchdogTick(f.state, { port: ZONE_PORT_BASE, strict: false }, f.deps, (m) => f.logs.push(m));
    await watchdogTick(f.state, { port: ZONE_PORT_BASE, strict: false }, f.deps, (m) => f.logs.push(m));
    assert.equal(f.state.failures, 2);
    assert.equal(f.ensureCalls.length, 0);
});

test("watchdogTick: third consecutive death respawns with hook-equivalent zone semantics", async () => {
    const f = tickFixture();
    const plan = { port: ZONE_PORT_BASE, strict: false };
    const log = (m: string) => f.logs.push(m);
    await watchdogTick(f.state, plan, f.deps, log);
    await watchdogTick(f.state, plan, f.deps, log);
    await watchdogTick(f.state, plan, f.deps, log);
    assert.equal(f.ensureCalls.length, 1);
    const { opts, deps } = f.ensureCalls[0];
    assert.equal(opts.host, LAUNCHER_DEFAULT_HOST);
    assert.equal(opts.port, 0, "zone mode passes port 0 so the launcher settles the sticky record");
    assert.equal(opts.strictPort, false);
    assert.equal(opts.passthrough, false);
    assert.equal(opts.lane, "claude");
    assert.ok(opts.parentPid > 1, "watches a real parent pid");
    assert.equal(path.basename(String(deps.scriptPath)), "index.js", "spawns the package bin, not this entry");
    assert.equal(f.state.failures, 0, "counter resets after a bring-up attempt");
    assert.equal(f.repinCalls.length, 0, "same-origin respawn needs no repin");
    assert.match(f.logs.join("\n"), /respawned at http:\/\/127\.0\.0\.1:\d+/);
});

test("watchdogTick: explicit pin stays strict-port with the exact port", async () => {
    const f = tickFixture();
    const plan = { port: 18801, strict: true };
    const log = (m: string) => f.logs.push(m);
    for (let i = 0; i < 3; i++) await watchdogTick(f.state, plan, f.deps, log);
    assert.equal(f.ensureCalls[0].opts.port, 18801);
    assert.equal(f.ensureCalls[0].opts.strictPort, true);
});

test("watchdogTick: drifted respawn repins settings and follows in BILI_MCP_PROXY", async () => {
    const prevPin = process.env.BILI_MCP_PROXY;
    try {
        delete process.env.BILI_MCP_PROXY;
        const f = tickFixture();
        f.setHandle({ origin: DRIFTED, attached: false });
        const log = (m: string) => f.logs.push(m);
        for (let i = 0; i < 3; i++) await watchdogTick(f.state, { port: ZONE_PORT_BASE, strict: false }, f.deps, log);
        assert.deepEqual(f.repinCalls, [DRIFTED]);
        assert.equal(process.env.BILI_MCP_PROXY, DRIFTED);
        assert.equal(f.state.origin, DRIFTED);
    } finally {
        if (prevPin === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevPin;
    }
});

test("watchdogTick: attached same-origin is a no-op beyond logging", async () => {
    const f = tickFixture();
    f.setHandle({ origin: ORIGIN, attached: true });
    const log = (m: string) => f.logs.push(m);
    for (let i = 0; i < 3; i++) await watchdogTick(f.state, { port: ZONE_PORT_BASE, strict: false }, f.deps, log);
    assert.equal(f.repinCalls.length, 0);
    assert.match(f.logs.join("\n"), /attached at/);
});

test("watchdogTick: refusedWatcher surfaces the #1322 warning", async () => {
    const f = tickFixture();
    f.setHandle({ origin: ORIGIN, attached: true, refusedWatcher: true });
    const log = (m: string) => f.logs.push(m);
    for (let i = 0; i < 3; i++) await watchdogTick(f.state, { port: ZONE_PORT_BASE, strict: false }, f.deps, log);
    assert.match(f.logs.join("\n"), /NO session-lifecycle watchdog \(#1322\)/);
});

test("watchdogTick: a failing repin is non-fatal — state still follows the new origin", async () => {
    const prevPin = process.env.BILI_MCP_PROXY;
    try {
        delete process.env.BILI_MCP_PROXY;
        const f = tickFixture();
        f.setHandle({ origin: DRIFTED, attached: false });
        f.deps.repin = () => { throw new Error("settings unreadable"); };
        const log = (m: string) => f.logs.push(m);
        for (let i = 0; i < 3; i++) await watchdogTick(f.state, { port: ZONE_PORT_BASE, strict: false }, f.deps, log);
        assert.equal(f.state.origin, DRIFTED);
        assert.equal(process.env.BILI_MCP_PROXY, DRIFTED);
        assert.match(f.logs.join("\n"), /repin failed \(non-fatal\)/);
    } finally {
        if (prevPin === undefined) delete process.env.BILI_MCP_PROXY;
        else process.env.BILI_MCP_PROXY = prevPin;
    }
});

test("watchdogTick: a failed bring-up keeps the counter hot — immediate retry on the next tick (zcode parity)", async () => {
    const f = tickFixture();
    let failEnsure = true;
    const ensureAttempts: number[] = [];
    f.deps.ensure = async () => {
        ensureAttempts.push(1);
        if (failEnsure) throw new Error("spawn failed");
        return { port: 0, origin: ORIGIN, attached: false };
    };
    const plan = { port: ZONE_PORT_BASE, strict: false };
    const log = (m: string) => f.logs.push(m);
    for (let i = 0; i < 3; i++) await watchdogTick(f.state, plan, f.deps, log).catch(() => {});
    assert.equal(ensureAttempts.length, 1);
    assert.equal(f.state.failures, 3, "counter stays hot when the bring-up throws");
    failEnsure = false;
    await watchdogTick(f.state, plan, f.deps, log);
    assert.equal(ensureAttempts.length, 2, "no second failure cycle — retries on the very next tick");
    assert.equal(f.state.failures, 0);
});

test("startWatchdog: fires on repeated death and survives via unref'd timer", async () => {
    const f = tickFixture();
    const state: MutableWatchdogState = { origin: ORIGIN, failures: 0 };
    const timer = startWatchdog(state, { port: ZONE_PORT_BASE, strict: false }, (m) => f.logs.push(m), { ...f.deps, intervalMs: 5 });
    try {
        const deadline = Date.now() + 5000;
        while (f.ensureCalls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        assert.ok(f.ensureCalls.length >= 1, "watchdog brought the proxy back");
    } finally {
        clearInterval(timer);
    }
});

test("main: NODE_TEST_CONTEXT short-circuits before anything runs", async () => {
    let stdio = 0;
    await withEnv({ NODE_TEST_CONTEXT: "1" }, async () => {
        await main({ runStdio: () => { stdio += 1; } });
    });
    assert.equal(stdio, 0);
});

test("main: attach posture serves tools only, never arms the watchdog", async () => {
    const box = sandbox();
    let stdio = 0;
    const ensureCalls: unknown[] = [];
    try {
        await withEnv(
            { NODE_TEST_CONTEXT: undefined, BILLION_CONTEXT_PROXY: "http://127.0.0.1:9999/v1", BILI_NATIVE_CLAUDE: undefined, BILLION_CONTEXT_PLUGIN: undefined, BILI_PROVIDER_REWRITES: undefined, BILI_MCP_PROXY: undefined },
            async () => {
                await main({
                    runStdio: () => { stdio += 1; },
                    ensure: async () => { ensureCalls.push(1); return { origin: ORIGIN, port: 0 }; },
                    intervalMs: 10,
                    failureLimit: 1,
                });
            },
        );
        assert.equal(stdio, 1);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(ensureCalls.length, 0, "attach posture must never respawn beside the user's own proxy");
    } finally {
        rmrf(box.dir);
    }
});

test("main: passthrough posture (opt-out) serves tools only", async () => {
    const box = sandbox();
    let stdio = 0;
    try {
        await withEnv(
            { NODE_TEST_CONTEXT: undefined, BILI_NATIVE_CLAUDE: "0", BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined, BILI_PROVIDER_REWRITES: undefined, BILI_MCP_PROXY: undefined },
            async () => {
                await main({ runStdio: () => { stdio += 1; }, intervalMs: 10_000 });
            },
        );
        assert.equal(stdio, 1);
    } finally {
        rmrf(box.dir);
    }
});

test("main: native posture arms the watchdog on the managed-block origin", async () => {
    const box = sandbox();
    fs.writeFileSync(box.settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${ORIGIN}/bili/https://api.anthropic.com` } }));
    let stdio = 0;
    const probes: string[] = [];
    try {
        await withEnv(
            { NODE_TEST_CONTEXT: undefined, BILI_NATIVE_CLAUDE: undefined, BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined, BILI_PROVIDER_REWRITES: undefined, BILI_MCP_PROXY: undefined },
            async () => {
                await main({
                    runStdio: () => { stdio += 1; },
                    probe: async (o) => { probes.push(o); return true; },
                    intervalMs: 5,
                });
                const deadline = Date.now() + 5000;
                while (probes.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
                assert.ok(probes.length >= 1, "watchdog armed and probing");
                assert.equal(probes[0], ORIGIN, "tracks the origin the running session dialed");
            },
        );
    } finally {
        rmrf(box.dir);
    }
});

// — installer MCP face migration (fake claude CLI that logs its invocations) —

function fakeClaudeLog(dir: string): { cli: string; logFile: string } {
    const isWin = process.platform === "win32";
    const logFile = path.join(dir, "claude-cli.log");
    const script = path.join(dir, isWin ? "claude-fake.cmd" : "claude-fake");
    fs.writeFileSync(script, isWin ? `@echo %* >> ${logFile}\r\n@exit /b 0\r\n` : `#!/bin/sh\necho "$@" >> ${JSON.stringify(logFile)}\nexit 0\n`);
    if (!isWin) fs.chmodSync(script, 0o755);
    return { cli: script, logFile };
}

// Log lines are platform-shaped: on Windows the fake runs through cmd.exe
// (%* comes back per-token-quoted with CRLF — runClaudeCli's .cmd shim path),
// so normalize quotes + line endings before asserting.
function cliLog(logFile: string): string[] {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, "utf8")
        .replace(/"/g, "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

function mcpFaceSandbox(): { box: ReturnType<typeof sandbox>; cli: string; logFile: string; cleanup: () => void } {
    const box = sandbox();
    const { cli, logFile } = fakeClaudeLog(box.dir);
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    process.env.CLAUDE = cli;
    delete process.env.BILI_NATIVE_CLAUDE;
    return {
        box, cli, logFile,
        cleanup: () => {
            rmrf(box.dir);
            if (prevClaude === undefined) delete process.env.CLAUDE;
            else process.env.CLAUDE = prevClaude;
            if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
            else process.env.BILI_NATIVE_CLAUDE = prevOpt;
        },
    };
}

function writeMcpBili(box: { mcpJson: string }, entry: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(box.mcpJson), { recursive: true });
    fs.writeFileSync(box.mcpJson, JSON.stringify({ mcpServers: { bili: entry } }, null, 2));
}

test("installer: fresh machine registers the watchdog entry", () => {
    const { box, logFile, cleanup } = mcpFaceSandbox();
    try {
        const note = pluginInstall("claude");
        assert.match(note, /MCP face -> .*pinned http:\/\/127\.0\.0\.1:\d+/);
        const calls = cliLog(logFile);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].startsWith("mcp add bili --scope user"), calls[0]);
        const expected = path.join(selfPackageRoot(), "dist", "claude-mcp-entry.js").replace(/\\/g, "/");
        assert.ok(calls[0].replace(/\\/g, "/").includes(expected), calls[0]);
    } finally {
        cleanup();
    }
});

test("installer: legacy dist/mcp.js registration is migrated (remove + add)", () => {
    const { box, logFile, cleanup } = mcpFaceSandbox();
    try {
        writeMcpBili(box, {
            type: "stdio",
            command: "node",
            args: [path.join(selfPackageRoot(), "dist", "mcp.js")],
            env: { BILI_MCP_PROXY: ORIGIN },
        });
        const note = pluginInstall("claude");
        assert.match(note, /migrated from dist\/mcp\.js/);
        const calls = cliLog(logFile);
        assert.equal(calls.length, 2);
        assert.ok(calls[0].startsWith("mcp remove bili --scope user"), calls[0]);
        assert.ok(calls[1].startsWith("mcp add bili --scope user"), calls[1]);
    } finally {
        cleanup();
    }
});

test("installer: current registration with matching pin is left alone", () => {
    const { box, logFile, cleanup } = mcpFaceSandbox();
    try {
        writeMcpBili(box, {
            type: "stdio",
            command: "node",
            args: [path.join(selfPackageRoot(), "dist", "claude-mcp-entry.js")],
            env: { BILI_MCP_PROXY: `http://127.0.0.1:${ZONE_PORT_BASE}` },
        });
        const note = pluginInstall("claude");
        assert.match(note, /MCP face current/);
        assert.equal(cliLog(logFile).length, 0);
    } finally {
        cleanup();
    }
});

test("installer: our entry with a stale port pin gets re-pinned", () => {
    const { box, logFile, cleanup } = mcpFaceSandbox();
    try {
        writeMcpBili(box, {
            type: "stdio",
            command: "node",
            args: [path.join(selfPackageRoot(), "dist", "claude-mcp-entry.js")],
            env: { BILI_MCP_PROXY: "http://127.0.0.1:1" },
        });
        const note = pluginInstall("claude");
        assert.match(note, /re-pinned/);
        const calls = cliLog(logFile);
        assert.equal(calls.length, 2);
        assert.ok(calls[0].startsWith("mcp remove bili --scope user"), calls[0]);
        assert.ok(calls[1].startsWith("mcp add bili --scope user"), calls[1]);
    } finally {
        cleanup();
    }
});

test("installer: a foreign bili server keeps its registration untouched", () => {
    const { box, logFile, cleanup } = mcpFaceSandbox();
    try {
        writeMcpBili(box, { type: "stdio", command: "/usr/bin/python3", args: ["my-bili.py"] });
        const before = fs.readFileSync(box.mcpJson, "utf8");
        const note = pluginInstall("claude");
        assert.match(note, /foreign bili server/);
        assert.equal(cliLog(logFile).length, 0);
        assert.equal(fs.readFileSync(box.mcpJson, "utf8"), before);
    } finally {
        cleanup();
    }
});

test("installer: unreadable .claude.json falls back to plain add", () => {
    const { box, logFile, cleanup } = mcpFaceSandbox();
    try {
        fs.mkdirSync(path.dirname(box.mcpJson), { recursive: true });
        fs.writeFileSync(box.mcpJson, "{ not json");
        const note = pluginInstall("claude");
        assert.match(note, /MCP face -> .*pinned/);
        const calls = cliLog(logFile);
        assert.equal(calls.length, 1);
        assert.ok(calls[0].startsWith("mcp add bili --scope user"), calls[0]);
    } finally {
        cleanup();
    }
});
