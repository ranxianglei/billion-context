// #964 claude native posture: managed settings block (pure merge/strip),
// port resolution, installer round-trip against a fake `claude` CLI in a
// sandboxed CLAUDE_CONFIG_DIR, and the SessionStart hook's pure planner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import {
    applyClaudeManagedBlock,
    CLAUDE_ACP_CACHE_COMMAND,
    claudeAcpCacheCommandFile,
    claudeNativeBaseUrl,
    claudeNativeInstalled,
    claudeSettingsFile,
    isBiliClaudeBaseUrl,
    pluginInstall,
    pluginRemove,
    resolveClaudeCli,
    stripClaudeManagedBlock,
} from "../src/plugin-install.ts";
import { CLAUDE_NATIVE_DEFAULT_PORT, clearClaudeNativePort, resolveClaudeNativePort, resolveNativeAttachExternal, saveClaudeNativePort } from "../src/config.ts";
import { chooseWatchdogParentPid, isClaudeHostArgv, isTransientShArgv, planClaudeNativeBootstrap, readPsProcInfo, readWinProcInfo, resolveClaudeHostPid } from "../src/claude-native-bootstrap.ts";

// #1248: the live tests below spawn real proxies/processes and observe real
// /proc, ps output and network ports. On loaded shared machines (multi-agent
// sandboxes running several suites concurrently) they hang or fail
// non-deterministically — Run C's failing set {24,37-42} is exactly this set —
// while every pure test in this file stays green. So they are opt-in, like
// ACP_TEST_E2E for the codex suite: CI sets ACP_TEST_CLAUDE_NATIVE=1
// (ci.yml); a local `npm test` skips them by default to keep a fast,
// deterministic signal.
const LIVE_E2E = process.env.ACP_TEST_CLAUDE_NATIVE === "1";
const liveSkip = LIVE_E2E ? undefined : "set ACP_TEST_CLAUDE_NATIVE=1 (live proxy/process e2e; flaky under concurrent load, #1248)";

const HOOK_COMMAND = "/opt/bili/dist/claude-native-bootstrap.js";

function baseUrlForPort(port: number): string {
    return `http://127.0.0.1:${port}/bili/https://api.anthropic.com`;
}

// — pure merge/strip ————————————————————————————————————————————

test("applyClaudeManagedBlock: writes env + hook into empty settings", () => {
    const { data, notes } = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, baseUrlForPort(48787));
    assert.equal((data.env as Record<string, string>).DISABLE_AUTO_COMPACT, "1");
    const entries = (data.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(entries.length, 1);
    assert.deepEqual((entries[0] as { hooks: Array<{ type: string; command: string }> }).hooks, [{ type: "command", command: HOOK_COMMAND }]);
    assert.equal(notes.length, 3);
});

test("applyClaudeManagedBlock: idempotent — a second apply changes nothing", () => {
    const first = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const second = applyClaudeManagedBlock(first.data, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.deepEqual(second.data, first.data);
    assert.equal(second.notes.length, 0);
});

test("applyClaudeManagedBlock: rewrites an older bili URL to the current port", () => {
    const settings = { env: { ANTHROPIC_BASE_URL: baseUrlForPort(40000) } };
    const { data, notes } = applyClaudeManagedBlock(settings, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, baseUrlForPort(48787));
    assert.ok(notes.some((n) => n.includes("ANTHROPIC_BASE_URL")));
});

test("applyClaudeManagedBlock: never clobbers foreign keys", () => {
    const settings = { env: { ANTHROPIC_BASE_URL: "https://relay.example", DISABLE_AUTO_COMPACT: "0" }, other: true };
    const { data, notes } = applyClaudeManagedBlock(settings, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    assert.equal((data.env as Record<string, string>).ANTHROPIC_BASE_URL, "https://relay.example");
    assert.equal((data.env as Record<string, string>).DISABLE_AUTO_COMPACT, "0");
    assert.equal((data.other as boolean), true);
    assert.ok(notes.some((n) => n.includes("foreign value") || n.includes("left untouched")));
});

test("applyClaudeManagedBlock: preserves user SessionStart entries", () => {
    const userEntry = { matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] };
    const first = applyClaudeManagedBlock({ hooks: { SessionStart: [userEntry] } }, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const entries = (first.data.hooks as Record<string, unknown[]>).SessionStart;
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], userEntry);
    const again = applyClaudeManagedBlock(first.data, { baseUrl: baseUrlForPort(48787), hookCommand: "/moved/dist/claude-native-bootstrap.js" });
    assert.equal((again.data.hooks as Record<string, unknown[]>).SessionStart.length, 2, "old-path entry still counts as ours");
    assert.equal(again.notes.length, 0);
});

test("stripClaudeManagedBlock: round-trip removes ours, keeps user keys", () => {
    const userEnv = { CUSTOM: "x" };
    const userEntry = { hooks: [{ type: "command", command: "echo hi" }] };
    const applied = applyClaudeManagedBlock(
        { env: { ...userEnv }, hooks: { SessionStart: [userEntry], PreCompact: [userEntry] } },
        { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND },
    );
    const { data, removed } = stripClaudeManagedBlock(applied.data);
    assert.deepEqual(removed.sort(), ["env.DISABLE_AUTO_COMPACT", "env.ANTHROPIC_BASE_URL", "hooks.SessionStart entry"].sort());
    assert.deepEqual(data.env, userEnv);
    assert.deepEqual((data.hooks as Record<string, unknown[]>).SessionStart, [userEntry]);
    assert.ok((data.hooks as Record<string, unknown>).PreCompact);
});

test("stripClaudeManagedBlock: empty containers are dropped, foreign values survive", () => {
    const applied = applyClaudeManagedBlock({}, { baseUrl: baseUrlForPort(48787), hookCommand: HOOK_COMMAND });
    const { data, removed } = stripClaudeManagedBlock(applied.data);
    assert.equal(removed.length, 3);
    assert.equal("env" in data, false);
    assert.equal("hooks" in data, false);
    const foreign = stripClaudeManagedBlock({ env: { ANTHROPIC_BASE_URL: "https://relay.example" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo" }] }] } });
    assert.equal(foreign.removed.length, 0);
    assert.deepEqual(foreign.data.env, { ANTHROPIC_BASE_URL: "https://relay.example" });
});

// — URL/port helpers ————————————————————————————————————————————

test("isBiliClaudeBaseUrl: only loopback /bili/ wraps match", () => {
    assert.equal(isBiliClaudeBaseUrl(baseUrlForPort(48787)), true);
    assert.equal(isBiliClaudeBaseUrl("http://127.0.0.1:8787/bili/https://relay.example"), true);
    assert.equal(isBiliClaudeBaseUrl("https://api.anthropic.com"), false);
    assert.equal(isBiliClaudeBaseUrl("http://127.0.0.1:8787/v1"), false);
    assert.equal(isBiliClaudeBaseUrl(undefined), false);
});

test("claudeNativeBaseUrl: default wraps api.anthropic.com; BILI_CLAUDE_UPSTREAM wraps the relay", () => {
    const prev = process.env.BILI_CLAUDE_UPSTREAM;
    const prevPort = process.env.BILI_CLAUDE_NATIVE_PORT;
    try {
        delete process.env.BILI_CLAUDE_UPSTREAM;
        delete process.env.BILI_CLAUDE_NATIVE_PORT;
        assert.equal(claudeNativeBaseUrl().includes(`/bili/https://api.anthropic.com`), true);
        process.env.BILI_CLAUDE_UPSTREAM = "https://relay.example/";
        assert.equal(claudeNativeBaseUrl(), `http://127.0.0.1:${CLAUDE_NATIVE_DEFAULT_PORT}/bili/https://relay.example`);
    } finally {
        if (prev === undefined) delete process.env.BILI_CLAUDE_UPSTREAM;
        else process.env.BILI_CLAUDE_UPSTREAM = prev;
        if (prevPort === undefined) delete process.env.BILI_CLAUDE_NATIVE_PORT;
        else process.env.BILI_CLAUDE_NATIVE_PORT = prevPort;
    }
});

test("resolveClaudeNativePort: env > default; rejects junk", () => {
    assert.equal(resolveClaudeNativePort({}), CLAUDE_NATIVE_DEFAULT_PORT);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "49999" }), 49999);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "0" }), CLAUDE_NATIVE_DEFAULT_PORT);
    assert.equal(resolveClaudeNativePort({ BILI_CLAUDE_NATIVE_PORT: "not-a-number" }), CLAUDE_NATIVE_DEFAULT_PORT);
});

// #1335: the attach-gate escape hatch — env BILI_NATIVE_ATTACH_EXTERNAL wins
// over the config file's native.attachExternal; the file value must be exactly
// true (garbage leaves the gate closed); default false.
test("resolveNativeAttachExternal: env parsing (1/true open, 0/false close, junk falls through)", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-attachext-"));
    process.env.XDG_CONFIG_HOME = dir;
    try {
        assert.equal(resolveNativeAttachExternal({}), false, "no env, no file → gate closed");
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "" }), false, "blank env falls through to file");
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "1" }), true);
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "true" }), true);
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: " TRUE " }), true, "case-insensitive and trimmed");
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "0" }), false);
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "false" }), false);
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "yes" }), false, "junk env is not a truthy answer");
    } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("resolveNativeAttachExternal: file native.attachExternal requires exact true; env still wins", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-attachext-"));
    const cfgDir = path.join(dir, "billion-context");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, "billion-context.json");
    process.env.XDG_CONFIG_HOME = dir;
    try {
        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachExternal: true } }));
        assert.equal(resolveNativeAttachExternal({}), true, "file opens the gate");
        assert.equal(resolveNativeAttachExternal({ BILI_NATIVE_ATTACH_EXTERNAL: "0" }), false, "env 0 overrides a permissive file");

        fs.writeFileSync(cfgFile, JSON.stringify({ native: { attachExternal: "true" } }));
        assert.equal(resolveNativeAttachExternal({}), false, "string 'true' in the file is not a boolean true");

        fs.writeFileSync(cfgFile, "{ not json");
        assert.equal(resolveNativeAttachExternal({}), false, "malformed file degrades to gate-closed, never throws");

        fs.rmSync(cfgFile);
        assert.equal(resolveNativeAttachExternal({}), false, "absent file → default false");
    } finally {
        if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prev;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// — hook planner ————————————————————————————————————————————

test("planClaudeNativeBootstrap: launcher-owned / opt-out / start", () => {
    assert.deepEqual(planClaudeNativeBootstrap({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:39000" }).action, "exit");
    assert.deepEqual(planClaudeNativeBootstrap({ BILI_PROVIDER_REWRITES: "x" }).action, "exit");
    assert.deepEqual(planClaudeNativeBootstrap({ BILI_NATIVE_CLAUDE: "0" }).action, "passthrough");
    assert.deepEqual(planClaudeNativeBootstrap({ BILLION_CONTEXT_PLUGIN: "0" }).action, "passthrough");
    const start = planClaudeNativeBootstrap({});
    assert.deepEqual(start, { action: "start", port: CLAUDE_NATIVE_DEFAULT_PORT });
    assert.equal(planClaudeNativeBootstrap({ BILI_CLAUDE_NATIVE_PORT: "49999" }).port, 49999);
});

// — claude host pid resolution (parent-gone regression) —————————————————

// Live shape (claude 2.1.278, SessionStart): the hook's direct parent is a
// TRANSIENT `/bin/sh -c` wrapper; the claude session sits one level above it.
function procTable(table: Record<number, { argv?: string[]; ppid?: number }>): (pid: number) => { argv: string[] | null; ppid: number | null } | null {
    return (pid) => {
        const entry = table[pid];
        if (entry === undefined) return null;
        return { argv: entry.argv ?? null, ppid: entry.ppid ?? null };
    };
}

test("resolveClaudeHostPid: walks past the transient sh wrapper to claude", () => {
    const read = procTable({
        100: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 200 },
        200: { argv: ["/bin/sh", "-c", "node /pkg/dist/claude-native-bootstrap.js"], ppid: 300 },
        300: { argv: ["/usr/local/bin/claude", "-p", "hi"], ppid: 400 },
        400: { argv: ["/bin/bash"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read, startPid: 100 }), 300);
});

test("resolveClaudeHostPid: matches npm/node installs and skips zombie wrappers", () => {
    // node-form install: node .../@anthropic-ai/claude-code/cli.js
    const npmInstall = procTable({
        100: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 110 },
        110: { argv: ["/bin/sh", "-c", "node hook"], ppid: 120 },
        120: { argv: [process.execPath, "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read: npmInstall, startPid: 100 }), 120);

    // The wrapper may linger as a zombie (empty cmdline) — the walk must
    // continue through it instead of giving up.
    const zombieSh = procTable({
        100: { ppid: 110 },
        110: { argv: [], ppid: 120 },
        120: { argv: ["claude"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read: zombieSh, startPid: 100 }), 120);
});

test("resolveClaudeHostPid: no claude host in range → undefined (caller keeps legacy parent)", () => {
    // `timeout 40 claude ...` runs claude, but a bare timeout tree WITHOUT a
    // claude entry must not match, and neither must the wrapper chain itself.
    const noClaude = procTable({
        100: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 200 },
        200: { argv: ["/bin/sh", "-c", "node /pkg/dist/claude-native-bootstrap.js"], ppid: 300 },
        300: { argv: ["timeout", "40", "claude", "-p", "hi"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read: noClaude, startPid: 100 }), undefined);

    // Dead parent mid-walk, and a chain deeper than the walk budget.
    assert.equal(resolveClaudeHostPid({ read: procTable({ 100: { argv: ["node"], ppid: 200 } }), startPid: 100 }), undefined);
    const deep: Record<number, { argv: string[]; ppid: number }> = {};
    for (let i = 0; i < 30; i++) deep[100 + i] = { argv: ["proc", String(i)], ppid: 101 + i };
    deep[999] = { argv: ["claude"], ppid: 1 };
    assert.equal(resolveClaudeHostPid({ read: procTable(deep), startPid: 100 }), undefined);
});

test("resolveClaudeHostPid: the closer REAL claude beats a lookalike farther up", () => {
    // `node /opt/claude` is not claude-code, but the walk is bottom-up and
    // the real claude is always nearer the hook in a live session — a
    // lookalike above it must never hijack the watchdog.
    const read = procTable({
        100: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 200 },
        200: { argv: ["/bin/sh", "-c", "node hook"], ppid: 300 },
        300: { argv: ["/usr/local/bin/claude"], ppid: 400 },
        400: { argv: [process.execPath, "/opt/claude"], ppid: 1 },
    });
    assert.equal(resolveClaudeHostPid({ read, startPid: 100 }), 300);
});

// — watchdog parent choice (no-host fallback) ——————————————————————————

test("isTransientShArgv: sh-like one-shots only", () => {
    assert.equal(isTransientShArgv(["sh", "-c", "node hook"]), true);
    assert.equal(isTransientShArgv(["/bin/bash", "-lc", "cmd"]), true);
    assert.equal(isTransientShArgv(["zsh", "-i"]), false);
    assert.equal(isTransientShArgv(["node", "-c", "x"]), false);
    assert.equal(isTransientShArgv(["sh", "--check", "x"]), false);
    // Windows wrapper shapes (claude runs hooks via cmd /c there).
    assert.equal(isTransientShArgv(["C:\\Windows\\System32\\cmd.exe", "/c", "node hook"]), true);
    assert.equal(isTransientShArgv(["cmd.exe", "/C", "node hook"]), true);
    assert.equal(isTransientShArgv(["cmd.exe", "/k", "node hook"]), false); // /k stays open
    assert.equal(isTransientShArgv(["powershell.exe", "-NoProfile", "-Command", "node hook"]), true);
    assert.equal(isTransientShArgv(["pwsh", "-Command", "node hook"]), true);
    assert.equal(isTransientShArgv(["powershell.exe", "-NoProfile"]), false); // interactive
});

test("chooseWatchdogParentPid: host found → the host", () => {
    const read = procTable({
        [process.pid]: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 500 },
        500: { argv: ["/bin/sh", "-c", "node hook"], ppid: 700 },
        700: { argv: ["claude"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read, parentPid: 500 }), 700);
});

test("chooseWatchdogParentPid: no host + transient sh parent → the wrapper's parent (unrecognized claude)", () => {
    // Exotic install form the matcher missed: the grandparent IS claude —
    // watching it keeps the session alive with the correct lifetime, instead
    // of re-arming the 2s self-kill on the transient wrapper.
    const read = procTable({
        [process.pid]: { argv: [process.execPath, "/pkg/dist/claude-native-bootstrap.js"], ppid: 500 },
        500: { argv: ["/bin/sh", "-c", "node hook"], ppid: 600 },
        600: { argv: ["/opt/weird-claude-launcher"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read, parentPid: 500 }), 600);
});

test("chooseWatchdogParentPid: no host + non-transient/unreadable parent → legacy direct parent", () => {
    // Interactive shell (manual run) — old behavior is the right behavior.
    const interactive = procTable({
        [process.pid]: { argv: ["node", "hook"], ppid: 500 },
        500: { argv: ["/bin/zsh", "-i"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read: interactive, parentPid: 500 }), 500);
    // Wrapper parent whose own parent is init (no grandparent to watch).
    const orphanSh = procTable({
        [process.pid]: { argv: ["node", "hook"], ppid: 500 },
        500: { argv: ["sh", "-c", "node hook"], ppid: 1 },
    });
    assert.equal(chooseWatchdogParentPid({ read: orphanSh, parentPid: 500 }), 500);
    // Process table unreadable (hidepid / missing ps) — strictly no worse.
    const blind = procTable({ [process.pid]: { argv: ["node", "hook"], ppid: 800 } });
    assert.equal(chooseWatchdogParentPid({ read: blind, parentPid: 800 }), 800);
});

test("isClaudeHostArgv: exact matches only — never the hook itself or lookalikes", () => {
    assert.equal(isClaudeHostArgv(["claude"]), true);
    assert.equal(isClaudeHostArgv(["claude", "-p", "hi"]), true);
    assert.equal(isClaudeHostArgv(["claude.exe", "--resume"]), true);
    assert.equal(isClaudeHostArgv([process.execPath, "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]), true);
    assert.equal(isClaudeHostArgv([process.execPath, "--import", "tsx", "/src/claude"]), true);
    // The hook's own script must never match (basename differs from `claude`).
    assert.equal(isClaudeHostArgv([process.execPath, "/pkg/dist/claude-native-bootstrap.js"]), false);
    assert.equal(isClaudeHostArgv([process.execPath, "/pkg/src/claude-native-bootstrap.ts"]), false);
    // Wrappers and lookalikes: argv[0] is not claude.
    assert.equal(isClaudeHostArgv(["timeout", "40", "claude", "-p", "hi"]), false);
    assert.equal(isClaudeHostArgv(["/bin/sh", "-c", "claude"]), false);
    assert.equal(isClaudeHostArgv(["claude-doctor"]), false);
    assert.equal(isClaudeHostArgv(["claudeworkflow"]), false);
    // node with unrelated args must not match just because `claude` appears
    // inside a longer path/argument.
    assert.equal(isClaudeHostArgv([process.execPath, "/home/x/claude-notes/server.js"]), false);
});

// — ps / powershell process readers (non-linux fallback) ———————————————————

// ps prints "<ppid> <joined args>"; whitespace-splitting can only LOSE a
// match (paths with spaces), never invent one.
test("readPsProcInfo: parses '<ppid> <args>' lines, degrades to null", () => {
    const fakePs = (table: Record<number, string | null>) => (cmd: string, args: string[]): string | null => {
        assert.equal(cmd, "ps");
        assert.deepEqual(args.slice(0, -1), ["-ww", "-o", "ppid=", "-o", "args=", "-p"]);
        return table[Number(args[args.length - 1])] ?? null;
    };
    const ps = fakePs({
        300: "  7654 /usr/local/bin/claude -p hi\n",
        310: "5678 \n",
        320: "",
    });
    assert.deepEqual(readPsProcInfo(300, ps), { argv: ["/usr/local/bin/claude", "-p", "hi"], ppid: 7654 });
    // No visible args (zombie/protected) — argv null, ppid chain still walks.
    assert.deepEqual(readPsProcInfo(310, ps), { argv: null, ppid: 5678 });
    // Empty output or a failed ps run both mean "pid gone".
    assert.equal(readPsProcInfo(320, ps), null);
    assert.equal(readPsProcInfo(999, ps), null);
    // A garbage ppid column must not crash the walk (ppid null, argv kept).
    assert.deepEqual(readPsProcInfo(330, fakePs({ 330: "NaN claude\n" })), { argv: ["claude"], ppid: null });
});

// PowerShell emits "<ppid>\t<CommandLine>" in one Get-CimInstance call
// (ps/wmic are deprecated or absent on windows).
test("readWinProcInfo: parses '<ppid>\\t<commandline>', degrades to null", () => {
    const fakePs1 = (out: string | null) => (_cmd: string, _args: string[]): string | null => out;
    assert.deepEqual(
        readWinProcInfo(300, fakePs1("300\tC:\\n.exe C:\\x\\claude.exe\r\n")),
        { argv: ["C:\\n.exe", "C:\\x\\claude.exe"], ppid: 300 },
    );
    // Protected process: empty CommandLine — argv null, ppid kept.
    assert.deepEqual(readWinProcInfo(300, fakePs1("300\t\n")), { argv: null, ppid: 300 });
    // Empty output, or error text without a tab, both degrade to null.
    assert.equal(readWinProcInfo(300, fakePs1("")), null);
    assert.equal(readWinProcInfo(300, fakePs1("Get-CimInstance : object not found\n")), null);
    assert.equal(readWinProcInfo(300, fakePs1(null)), null);
});

test("resolveClaudeHostPid: full walk over a ps-backed table", () => {
    // Same tree as the /proc test, but reached through readPsProcInfo's
    // parsing instead of an injected ProcReader.
    const lines: Record<number, string | null> = {
        100: "200 node /pkg/dist/claude-native-bootstrap.js",
        200: "300 /bin/sh -c node /pkg/dist/claude-native-bootstrap.js",
        300: "400 /usr/local/bin/claude -p hi",
    };
    const psRead = (pid: number) => readPsProcInfo(pid, (_cmd, _args) => lines[pid] ?? null);
    assert.equal(resolveClaudeHostPid({ read: psRead, startPid: 100 }), 300);
});

// Live mechanism check for the fallback path: a real `ps` subprocess, real
// ppid chain, real match — everything except /proc itself.
test("resolveClaudeHostPid: live ps walk finds a spawned claude host", { timeout: 30_000, skip: LIVE_E2E ? process.platform === "win32" : liveSkip }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ps-live-"));
    const claudeBin = path.join(dir, "claude");
    const pidFile = path.join(dir, "child.pid");
    // Node-shebang fake claude (argv[0] is `node`, script basename `claude`)
    // spawning a leaf through the same sh -c wrapper shape as SessionStart.
    fs.writeFileSync(claudeBin, [
        "#!/usr/bin/env node",
        `const { spawn } = require("node:child_process");`,
        `const fs = require("node:fs");`,
        `const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        `setInterval(() => {}, 1 << 30);`,
        "",
    ].join("\n"));
    fs.chmodSync(claudeBin, 0o755);
    let leafPid = 0;
    let claude: ReturnType<typeof spawn> | null = null;
    try {
        claude = spawn(claudeBin, [], { stdio: "ignore" });
        for (let waited = 0; !fs.existsSync(pidFile); waited += 100) {
            if (waited > 10_000) assert.fail("leaf pid file never appeared");
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        leafPid = Number(fs.readFileSync(pidFile, "utf8"));
        // One hop up from the leaf must reach the fake claude via REAL ps.
        assert.equal(resolveClaudeHostPid({ read: (pid) => readPsProcInfo(pid), startPid: leafPid }), claude.pid);
        // A pid that cannot exist must read as gone, not crash.
        assert.equal(readPsProcInfo(999_999_999), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        if (claude !== null && claude.pid !== undefined && claude.pid > 1) {
            try {
                process.kill(claude.pid, "SIGKILL");
            } catch {
                // already gone (e.g. OOM-killed mid-test on a loaded box)
            }
        }
        if (leafPid > 1) {
            try {
                process.kill(leafPid, "SIGKILL");
            } catch {
                // already gone
            }
        }
    }
});

// — installer round-trip (fake claude CLI + sandboxed config dir) ———————

function fakeClaude(dir: string): string {
    const isWin = process.platform === "win32";
    const script = path.join(dir, isWin ? "claude-fake.cmd" : "claude-fake");
    fs.writeFileSync(script, isWin ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (!isWin) fs.chmodSync(script, 0o755);
    return script;
}

function sandbox(): { dir: string; settings: string; mcpJson: string; biliConfig: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-"));
    process.env.CLAUDE_CONFIG_DIR = dir;
    // #964: pluginInstall persists claude.nativePort into the bili config —
    // sandbox that too so tests never touch the real user config.
    const biliConfig = path.join(dir, "billion-context.json");
    process.env.BILI_CONFIG_FILE = biliConfig;
    return { dir, settings: path.join(dir, "settings.json"), mcpJson: path.join(dir, ".claude.json"), biliConfig };
}

function unsandbox(prev: string | undefined, prevCfg: string | undefined = process.env.BILI_CONFIG_FILE): void {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    if (prevCfg === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = prevCfg;
}

test("claudeSettingsFile: CLAUDE_CONFIG_DIR replaces the whole .claude dir", () => {
    assert.equal(claudeSettingsFile({ CLAUDE_CONFIG_DIR: "/tmp/cc" }), path.join("/tmp/cc", "settings.json"));
});

test("resolveClaudeCli: bare names resolve via where.exe on Windows, untouched elsewhere", () => {
    if (process.platform === "win32") {
        // 'where' always exists on Windows PATH; the resolution must return
        // an absolute path to a real executable file.
        const resolved = resolveClaudeCli("where");
        assert.match(resolved, /where\.exe$/i);
    } else {
        // Paths, names with extensions, and everything on posix pass through.
        assert.equal(resolveClaudeCli("claude"), "claude");
        assert.equal(resolveClaudeCli("C:\\x\\claude.cmd"), "C:\\x\\claude.cmd");
        assert.equal(resolveClaudeCli("/usr/local/bin/claude"), "/usr/local/bin/claude");
    }
});

test("installer round-trip: managed block + MCP face, then removal restores", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        assert.equal(claudeNativeInstalled(), false);

        const note = pluginInstall("claude");
        assert.ok(note.includes("managed block"), note);
        assert.ok(fs.existsSync(box.settings));
        const after = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: Record<string, string>; hooks?: unknown };
        assert.equal(after.env?.ANTHROPIC_BASE_URL, baseUrlForPort(CLAUDE_NATIVE_DEFAULT_PORT));
        assert.equal(after.env?.DISABLE_AUTO_COMPACT, "1");
        assert.equal(claudeNativeInstalled(), true);
        // #964: the resolved port is persisted so the SessionStart hook (which
        // does NOT inherit claude's settings.env) resolves the SAME port.
        assert.deepEqual(JSON.parse(fs.readFileSync(box.biliConfig, "utf8")), { claude: { nativePort: CLAUDE_NATIVE_DEFAULT_PORT } });

        const removeNote = pluginRemove("claude");
        assert.ok(removeNote.includes("managed block removed"), removeNote);
        const restored = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: unknown; hooks?: unknown };
        assert.equal(restored.env, undefined);
        assert.equal(restored.hooks, undefined);
        assert.equal(claudeNativeInstalled(), false);
        assert.deepEqual(JSON.parse(fs.readFileSync(box.biliConfig, "utf8")), {}, "nativePort cleared on remove");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("claudeAcpCacheCommandFile: CLAUDE_CONFIG_DIR replaces the whole .claude dir (#1146)", () => {
    assert.equal(claudeAcpCacheCommandFile({ CLAUDE_CONFIG_DIR: "/tmp/cc" }), path.join("/tmp/cc", "commands", "acp-cache.md"));
});

test("installer writes and removes the model-mediated /acp-cache command file (#1146)", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        const note = pluginInstall("claude");
        const cmdFile = claudeAcpCacheCommandFile(process.env);
        assert.equal(cmdFile, path.join(box.dir, "commands", "acp-cache.md"));
        assert.ok(note.includes(`/acp-cache command -> ${cmdFile} (written)`), note);
        assert.equal(fs.readFileSync(cmdFile, "utf8"), CLAUDE_ACP_CACHE_COMMAND);

        const removeNote = pluginRemove("claude");
        assert.ok(removeNote.includes("/acp-cache command removed"), removeNote);
        assert.equal(fs.existsSync(cmdFile), false);
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer leaves a foreign acp-cache.md untouched on install and removal (#1146)", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        const cmdFile = claudeAcpCacheCommandFile(process.env);
        fs.mkdirSync(path.dirname(cmdFile), { recursive: true });
        fs.writeFileSync(cmdFile, "foreign content");
        const note = pluginInstall("claude");
        assert.ok(note.includes("(left untouched (foreign content))"), note);
        assert.equal(fs.readFileSync(cmdFile, "utf8"), "foreign content");
        const removeNote = pluginRemove("claude");
        assert.ok(removeNote.includes("/acp-cache command left untouched"), removeNote);
        assert.equal(fs.readFileSync(cmdFile, "utf8"), "foreign content");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer preserves foreign settings.json keys end-to-end", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        fs.writeFileSync(box.settings, JSON.stringify({ permissions: { allow: ["Bash"] }, env: { THEME: "dark" } }, null, 2));
        pluginInstall("claude");
        assert.ok(fs.existsSync(`${box.settings}.bili-bak`), "pre-install snapshot of an existing settings file");
        const after = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { permissions?: unknown; env?: Record<string, string> };
        assert.deepEqual(after.permissions, { allow: ["Bash"] });
        assert.equal(after.env?.THEME, "dark");
        pluginRemove("claude");
        const restored = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { permissions?: unknown; env?: Record<string, string> };
        assert.deepEqual(restored.permissions, { allow: ["Bash"] });
        assert.deepEqual(restored.env, { THEME: "dark" });
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer persists an env-driven port so the hook resolves the SAME port", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const prevPortEnv = process.env.BILI_CLAUDE_NATIVE_PORT;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        // Live failure shape: install with an explicit port, then claude
        // later runs the hook WITHOUT that env (claude does not inject its
        // settings.env into hook children) — the persisted config keeps
        // hook and settings.json on the same port.
        process.env.BILI_CLAUDE_NATIVE_PORT = "49999";
        pluginInstall("claude");
        const settings = JSON.parse(fs.readFileSync(box.settings, "utf8")) as { env?: Record<string, string> };
        assert.equal(settings.env?.ANTHROPIC_BASE_URL, baseUrlForPort(49999));
        assert.deepEqual(JSON.parse(fs.readFileSync(box.biliConfig, "utf8")), { claude: { nativePort: 49999 } });
        delete process.env.BILI_CLAUDE_NATIVE_PORT;
        assert.equal(resolveClaudeNativePort(), 49999, "hook (no env) resolves the persisted port");
        assert.equal(planClaudeNativeBootstrap(process.env).port, 49999);
        pluginRemove("claude");
        assert.equal(resolveClaudeNativePort(), CLAUDE_NATIVE_DEFAULT_PORT, "remove restores the default");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
        if (prevPortEnv === undefined) delete process.env.BILI_CLAUDE_NATIVE_PORT;
        else process.env.BILI_CLAUDE_NATIVE_PORT = prevPortEnv;
    }
});

test("persist/clear refuse to clobber a malformed bili config", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const box = sandbox();
    try {
        const corrupt = "{ this is not json";
        fs.writeFileSync(box.biliConfig, corrupt, "utf8");
        assert.doesNotThrow(() => saveClaudeNativePort(49999));
        assert.equal(fs.readFileSync(box.biliConfig, "utf8"), corrupt, "save leaves the corrupt file byte-identical");
        assert.doesNotThrow(() => clearClaudeNativePort());
        assert.equal(fs.readFileSync(box.biliConfig, "utf8"), corrupt, "clear leaves the corrupt file byte-identical");
    } finally {
        unsandbox(prevDir, prevCfg);
    }
});

test("persist preserves foreign config keys; clear drops only the persisted key", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const box = sandbox();
    try {
        fs.writeFileSync(box.biliConfig, JSON.stringify({ port: 9999, claude: { nativePort: 1234 } }), "utf8");
        saveClaudeNativePort(49999);
        assert.deepEqual(JSON.parse(fs.readFileSync(box.biliConfig, "utf8")), { port: 9999, claude: { nativePort: 49999 } });
        clearClaudeNativePort();
        assert.deepEqual(JSON.parse(fs.readFileSync(box.biliConfig, "utf8")), { port: 9999 }, "clear drops only nativePort");
    } finally {
        unsandbox(prevDir, prevCfg);
    }
});

test("installer refuses under BILI_NATIVE_CLAUDE=0", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        process.env.BILI_NATIVE_CLAUDE = "0";
        assert.throws(() => pluginInstall("claude"), /refused/);
        assert.equal(fs.existsSync(box.settings), false);
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

test("installer refuses malformed settings.json instead of overwriting", () => {
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    const prevClaude = process.env.CLAUDE;
    const prevOpt = process.env.BILI_NATIVE_CLAUDE;
    const box = sandbox();
    try {
        delete process.env.BILI_NATIVE_CLAUDE;
        process.env.CLAUDE = fakeClaude(box.dir);
        fs.writeFileSync(box.settings, "{ not json");
        assert.throws(() => pluginInstall("claude"), /not valid JSON/);
        assert.equal(fs.readFileSync(box.settings, "utf8"), "{ not json", "file untouched");
    } finally {
        unsandbox(prevDir, prevCfg);
        if (prevClaude === undefined) delete process.env.CLAUDE;
        else process.env.CLAUDE = prevClaude;
        if (prevOpt === undefined) delete process.env.BILI_NATIVE_CLAUDE;
        else process.env.BILI_NATIVE_CLAUDE = prevOpt;
    }
});

// — hook e2e (real dist script brings up a real proxy) ——————————————————

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

function canConnect(port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const sock = net.connect({ port, host: "127.0.0.1" });
        const done = (ok: boolean) => {
            sock.destroy();
            resolve(ok);
        };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
    });
}

async function waitForPort(port: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (await canConnect(port)) return true;
        await new Promise((r) => setTimeout(r, 250));
    }
    return false;
}

// The proxy writes <state>/billion-context/proxy-origin synchronously inside
// its 'listening' callback — AFTER the kernel already accepts TCP connects on
// the port. A reader that just saw the port come up can hit a real window
// where the file is not on disk yet (#1031); poll briefly instead of one
// immediate read. Still absent past the deadline = hard failure.
async function waitForInstanceFile(file: string, ms: number): Promise<string> {
    const deadline = Date.now() + ms;
    for (;;) {
        try {
            return fs.readFileSync(file, "utf8");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            if (Date.now() >= deadline) throw new Error(`instance file did not appear within ${ms}ms: ${file}`);
            await new Promise((r) => setTimeout(r, 50));
        }
    }
}

function runHook(distScript: string, port: number, xdg: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
    // Hermetic tmp: the hook's spawned proxy logs to
    // <tmpdir>/bili-proxy-<port>.log. The minimal child env has no platform
    // tmp vars, so pin every one of them to the sandbox (Node reads TMPDIR on
    // POSIX, TMP/TEMP on Windows — with none set it falls back to an
    // unwritable root, e.g. C:\). Derived here from home so EVERY caller is
    // covered without each one remembering to pass a tmp dir.
    const tmp = path.join(xdg.home, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [distScript], {
            env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                HOME: xdg.home,
                XDG_CONFIG_HOME: xdg.config,
                XDG_STATE_HOME: xdg.state,
                XDG_CACHE_HOME: xdg.cache,
                XDG_DATA_HOME: xdg.data,
                BILI_CLAUDE_NATIVE_PORT: String(port),
                NO_COLOR: "1",
                TMPDIR: tmp,
                TEMP: tmp,
                TMP: tmp,
            },
            stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (c: Buffer) => {
            stderr += c.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stderr }));
    });
}

test("hook e2e: an occupied stable port fails loud — never port-hops", { timeout: 120_000, skip: liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = {
        home,
        config: path.join(home, "cfg"),
        state: path.join(home, "state"),
        cache: path.join(home, "cache"),
        data: path.join(home, "data"),
    };
    // A foreign listener squats the stable port (a relay, another test
    // stub, anything non-bili). Without strict-port the spawned proxy
    // would EADDRINUSE-hop to port+1 and "succeed" — stranding every
    // claude model call on the dead original port (found live on the
    // host of issue #964: two test listeners on 48787/48788).
    const squatter = net.createServer();
    squatter.listen(0, "127.0.0.1");
    await once(squatter, "listening");
    const port = (squatter.address() as net.AddressInfo).port;
    try {
        const r = await runHook(distScript, port, xdg);
        assert.equal(r.code, 0, "the hook never fails claude");
        assert.match(r.stderr, /bring-up failed/);
        assert.doesNotMatch(r.stderr, /started at/);
        await new Promise((r2) => setTimeout(r2, 500));
        assert.equal(await canConnect(port + 1), false, "no port-hop proxy on port+1");
    } finally {
        squatter.close();
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("hook e2e: a healthy proxy on ANOTHER port is never attached (static URL)", { timeout: 120_000, skip: liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    const portA = await freePort();
    const portB = await freePort();
    const instFile = path.join(xdg.state, "billion-context", "proxy-origin");
    let pidA = 0;
    let pidB = 0;
    try {
        // Bring up a healthy proxy on portA first — its instance file is
        // exactly what a probe would attach to (this mirrors the live host:
        // another bili proxy already running when claude's hook fires).
        const rA = await runHook(distScript, portA, xdg);
        assert.equal(rA.code, 0);
        assert.ok(await waitForPort(portA, 60_000), "proxy A up");
        pidA = (JSON.parse(await waitForInstanceFile(instFile, 30_000)) as { pid: number }).pid;

        // SAME state dir, DIFFERENT port: claude dials a STATIC url pinned to
        // portB — attaching to A's origin would strand every request. The
        // hook must spawn its own instance on portB instead.
        const rB = await runHook(distScript, portB, xdg);
        assert.equal(rB.code, 0);
        assert.match(rB.stderr, /started at/, "spawned — not attached to A");
        assert.ok(await waitForPort(portB, 60_000), "proxy B up on its own port");
        pidB = (JSON.parse(await waitForInstanceFile(instFile, 30_000)) as { pid: number }).pid;
        assert.notEqual(pidB, pidA, "separate instance, not an attach");
    } finally {
        if (pidA > 0) killPid(pidA);
        if (pidB > 0) killPid(pidB);
        await rmHome(home);
    }
});

function killPid(pid: number): void {
    try {
        process.kill(pid, "SIGTERM");
    } catch {}
}

// SIGTERM triggers the proxy's graceful session flush into <home>/state — a
// single rmSync races the dying writer (ENOTEMPTY mid-rimraf). Retry inside
// a bounded window instead of racing it.
async function rmHome(home: string): Promise<void> {
    for (let i = 0; ; i++) {
        try {
            fs.rmSync(home, { recursive: true, force: true });
            return;
        } catch {
            if (i >= 50) throw new Error(`cleanup: could not remove ${home} after 5s`);
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}

// CI runs `npm test` BEFORE `npm run build` (ci.yml step order) — this test
// exercises the BUILT artifact (the hook command claude actually runs), so
// build on demand when dist/ is absent (tsup ~1s; dev checkouts usually
// already have dist/ from a prior build).
function ensureDistBuilt(distScript: string): void {
    if (!fs.existsSync(distScript)) {
        const root = path.resolve(import.meta.dirname, "..");
        execFileSync(process.execPath, [path.join(root, "node_modules", "tsup", "dist", "cli-default.js")], { cwd: root, stdio: "pipe", timeout: 300_000 });
    }
    assert.ok(fs.existsSync(distScript), `build did not produce ${distScript}`);
}

test("hook e2e: dist script spawns a proxy on the stable port, second run attaches", { timeout: 120_000, skip: liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = {
        home,
        config: path.join(home, "cfg"),
        state: path.join(home, "state"),
        cache: path.join(home, "cache"),
        data: path.join(home, "data"),
    };
    const port = await freePort();
    const instanceFile = path.join(xdg.state, "billion-context", "proxy-origin");
    let proxyPid = 0;
    try {
        const r1 = await runHook(distScript, port, xdg);
        assert.equal(r1.code, 0);
        assert.match(r1.stderr, /proxy started|proxy attached/);
        assert.ok(await waitForPort(port, 60_000), "proxy listening on the stable port");
        const inst = JSON.parse(await waitForInstanceFile(instanceFile, 30_000)) as { pid: number; origin: string };
        assert.equal(inst.origin, `http://127.0.0.1:${port}`);
        assert.equal(typeof inst.pid, "number");
        proxyPid = inst.pid;

        // Second hook run (claude restart): the healthy proxy is shared.
        const r2 = await runHook(distScript, port, xdg);
        assert.equal(r2.code, 0);
        assert.match(r2.stderr, /attached/);
        const inst2 = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
        assert.equal(inst2.pid, proxyPid, "same proxy instance, no double spawn");
    } finally {
        if (proxyPid > 0) killPid(proxyPid);
        // Belt and braces: sweep any leftover listener the attach assertions
        // lost track of (spawned detached, watchdog = test-runner pid).
        if (await canConnect(port)) {
            try {
                const inst = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
                if (typeof inst.pid === "number") killPid(inst.pid);
            } catch {}
        }
        await rmHome(home);
    }
});

// The live parent-gone incident (claude 2.1.278 + hook 0.1.139): claude runs
// SessionStart hooks as `/bin/sh -c <cmd>`, the hook exits right after proxy
// bring-up, the transient sh dies with it — and the proxy's watchdog, pointed
// at that sh, killed a healthy proxy ~2s into EVERY session while claude kept
// running. The fake claude below reproduces the exact tree; the assertions
// pin both sides of the intended lifetime. Linux-only: the resolver walks
// /proc and the fake claude needs /bin/sh + shebang exec (CI runs windows too).
test("hook e2e: watchdog tracks the claude host, not the transient sh wrapper", { timeout: 120_000, skip: LIVE_E2E ? process.platform !== "linux" : liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-hook-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    const tmp = path.join(xdg.home, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const port = await freePort();
    // Fake claude binary reproducing the live SessionStart shape: it launches
    // the hook as a `/bin/sh -c` child (a transient sh sits between hook and
    // session), then OUTLIVES the hook like a real interactive session.
    const binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const claudeBin = path.join(binDir, "claude");
    // A shebang'ed SHELL script would show argv[0]=/bin/sh in /proc and never
    // match; a node shebang mirrors the npm install shape: argv becomes
    // [node, <path>/claude] — the exact form the resolver must accept.
    fs.writeFileSync(
        claudeBin,
        '#!/usr/bin/env node\nconst { spawn } = require("node:child_process");\n' +
            'spawn("/bin/sh", ["-c", process.env.BILI_FAKE_HOOK_CMD], { stdio: "ignore" });\n' +
            "setInterval(() => {}, 60000);\n",
    );
    fs.chmodSync(claudeBin, 0o755);
    const claudeProc = spawn(claudeBin, [], {
        env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: xdg.home,
            XDG_CONFIG_HOME: xdg.config,
            XDG_STATE_HOME: xdg.state,
            XDG_CACHE_HOME: xdg.cache,
            XDG_DATA_HOME: xdg.data,
            BILI_CLAUDE_NATIVE_PORT: String(port),
            NO_COLOR: "1",
            TMPDIR: tmp,
            TEMP: tmp,
            TMP: tmp,
            BILI_FAKE_HOOK_CMD: `"${process.execPath}" '${distScript}'`,
        },
        stdio: "ignore",
        detached: true,
    });
    const claudePid = claudeProc.pid ?? 0;
    const instanceFile = path.join(xdg.state, "billion-context", "proxy-origin");
    let proxyPid = 0;
    try {
        assert.ok(await waitForPort(port, 60_000), "proxy up behind the fake claude session");
        const inst = JSON.parse(await waitForInstanceFile(instanceFile, 30_000)) as { pid: number; origin: string };
        proxyPid = inst.pid;
        assert.equal(inst.origin, `http://127.0.0.1:${port}`);

        // The hook exits after bring-up and its transient sh parent dies with
        // it. Old code watched that sh: parent-gone killed the proxy within
        // one 2s watchdog tick. Several ticks later the proxy must STILL be
        // serving — the session is alive.
        await new Promise((r) => setTimeout(r, 6000));
        assert.ok(await canConnect(port), "proxy survives the transient sh wrapper's death");

        // Session end: claude dies, the proxy must follow within a few ticks.
        if (claudePid > 1) killPid(claudePid);
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && (await canConnect(port))) await new Promise((r) => setTimeout(r, 250));
        assert.equal(await canConnect(port), false, "proxy exits with the claude session");
    } finally {
        if (claudePid > 1) killPid(claudePid);
        if (proxyPid > 1) killPid(proxyPid);
        if (await canConnect(port)) {
            try {
                const leftover = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
                if (typeof leftover.pid === "number") killPid(leftover.pid);
            } catch {}
        }
        await rmHome(home);
    }
});

// #7: the stable-port proxy is shared across sessions, so the parent-gone
// watchdog had to become a WATCHER SET — POST /__bili/watcher lets an
// attached session register its claude host, and the proxy dies only when
// every owner is gone. This test pins the route contract against a real
// dist proxy, no fake claude needed (platform-neutral):
//   - armed proxies accept registrations (200) and reject garbage (400);
//   - daemon proxies (no BILI_PARENT_PID) NEVER take watchers (409) —
//     registering one must not arm a lifetime watchdog on a daemon;
//   - an armed proxy exits when its registered keeper dies.
test("watcher route: shared proxies take watcher registrations, daemons refuse (#7)", { timeout: 120_000, skip: liveSkip }, async () => {
    const distCli = path.resolve(import.meta.dirname, "..", "dist", "index.js");
    ensureDistBuilt(distCli);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watcher-route-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${origin}/__bili/watcher`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    // Keeper: a live pid the armed proxy watches. Its death must take the
    // proxy down (the sweep side of the set watchdog). A second keeper pins
    // the idle GRACE: registering within WATCHER_IDLE_GRACE_MS of the last
    // death cancels the pending shutdown.
    const keeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
    const keeperPid = keeper.pid ?? 0;
    const keeper2 = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
    const keeper2Pid = keeper2.pid ?? 0;
    const baseEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: xdg.home,
        XDG_CONFIG_HOME: xdg.config,
        XDG_STATE_HOME: xdg.state,
        XDG_CACHE_HOME: xdg.cache,
        XDG_DATA_HOME: xdg.data,
        NO_COLOR: "1",
    };
    let armed = 0;
    let daemon = 0;
    try {
        armed = spawnProxy(distCli, port, { ...baseEnv, BILI_PARENT_PID: String(keeperPid) });
        assert.ok(await waitForPort(port, 60_000), "armed proxy up");
        // The watcher route MUST sit inside the /__bili/ admin family: a URL
        // outside isAdminPath (e.g. a /__bili__/ spelling) silently skips the
        // tunnel-header, loopback and trusted-origin gates. Both probes below
        // must be rejected by the GATE (403), never reach the route.
        assert.equal((await post({ pid: keeperPid }, { "x-bili-tunnel": "1" })).status, 403, "watcher route is behind the tunnel-header gate");
        assert.equal((await post({ pid: keeperPid }, { origin: "https://evil.example" })).status, 403, "watcher route is behind the trusted-origin gate");
        assert.equal((await post({})).status, 400, "empty body rejected");
        assert.equal((await post({ pid: 0 })).status, 400, "pid 0 rejected");
        assert.equal((await post({ pid: "12" })).status, 400, "string pid rejected");
        assert.equal((await post({ pid: armed })).status, 400, "self-registration rejected");
        const ok = await post({ pid: keeperPid });
        assert.equal(ok.status, 200, "live pid accepted");
        assert.match(JSON.stringify(await ok.json()), /"ok":true/, "ok:true body");
        // #1322: health must expose the lifecycle state so callers can tell a
        // session-owned proxy from a daemon before they commit to it.
        const armedHealth = (await (await fetch(`${origin}/__bili/health`)).json()) as { watchdog?: { armed?: boolean; parentPid?: number; watchers?: number[] } };
        assert.equal(armedHealth.watchdog?.armed, true, "armed proxy reports armed");
        assert.equal(armedHealth.watchdog?.parentPid, keeperPid, "spawning owner reported");
        assert.deepEqual(armedHealth.watchdog?.watchers, [keeperPid], "owner seeded the set");

        // Grace: keeper1 dies, and BEFORE the idle grace expires a new owner
        // registers (the live race: spawner exits right after a second session
        // starts). The pending shutdown must be cancelled — the proxy stays up
        // well past the grace window.
        if (keeperPid > 1) killPid(keeperPid);
        await new Promise((r) => setTimeout(r, 3000));
        const late = await post({ pid: keeper2Pid });
        assert.equal(late.status, 200, "late registration within the grace window accepted");
        await new Promise((r) => setTimeout(r, 7000));
        assert.ok(await canConnect(port), "grace registration cancelled the pending shutdown");

        // LAST owner dies → armed proxy must follow (≤ a few ticks + grace).
        if (keeper2Pid > 1) killPid(keeper2Pid);
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && (await canConnect(port))) await new Promise((r) => setTimeout(r, 250));
        assert.equal(await canConnect(port), false, "armed proxy exits when its watcher dies");

        // Daemon mode: no BILI_PARENT_PID → registrations refused, and a
        // refused registration must not arm a watchdog that kills it later.
        daemon = spawnProxy(distCli, port, baseEnv);
        assert.ok(await waitForPort(port, 60_000), "daemon proxy up on the same port");
        assert.equal((await post({ pid: process.pid })).status, 409, "daemon refuses watchers");
        await new Promise((r) => setTimeout(r, 5000));
        assert.ok(await canConnect(port), "daemon stays up — no watchdog got armed");
        // #1322: the refusal must be visible through health — this is the field
        // that lets an attaching session notice the lifecycle contract is void.
        const daemonHealth = (await (await fetch(`${origin}/__bili/health`)).json()) as { watchdog?: { armed?: boolean; parentPid?: number; watchers?: number[] } };
        assert.equal(daemonHealth.watchdog?.armed, false, "unarmed proxy reports unarmed");
        assert.equal(daemonHealth.watchdog?.parentPid, undefined, "no owner pid");
        assert.deepEqual(daemonHealth.watchdog?.watchers, [], "refused registration joined nothing");
    } finally {
        if (keeperPid > 1) killPid(keeperPid);
        if (keeper2Pid > 1) killPid(keeper2Pid);
        if (armed > 1) killPid(armed);
        if (daemon > 1) killPid(daemon);
        await rmHome(home);
    }
});

// #1322 end-to-end: the reported failure shape — a manually started daemon
// squats on the stable port BEFORE any session begins, so every claude
// session attaches to it and its registration is refused (409). Old code
// swallowed that silently: the "lives and dies with the session" contract was
// void with zero signal. Now the hook must WARN loudly on stderr while
// staying non-destructive (the daemon keeps serving; its fate is the
// operator's). Linux-only like the other hook e2es (fake claude walks /proc).
test("hook e2e: attaching to a squatting daemon warns instead of staying silent (#1322)", { timeout: 180_000, skip: LIVE_E2E ? process.platform !== "linux" : liveSkip }, async () => {
    const distCli = path.resolve(import.meta.dirname, "..", "dist", "index.js");
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distCli);
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-squatter-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
    const port = await freePort();
    const baseEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: xdg.home,
        XDG_CONFIG_HOME: xdg.config,
        XDG_STATE_HOME: xdg.state,
        XDG_CACHE_HOME: xdg.cache,
        XDG_DATA_HOME: xdg.data,
        NO_COLOR: "1",
    };
    const squatter = spawnProxy(distCli, port, baseEnv);
    let claudePid = 0;
    try {
        assert.ok(await waitForPort(port, 60_000), "squatter daemon up on the stable port");
        // Fake claude reproducing the live SessionStart shape: node-shebang
        // binary (npm install form: argv [node, <path>/claude]), launches the
        // hook through /bin/sh -c, captures hook stderr to a file, then
        // OUTLIVES the hook like a real interactive session. Dynamic import
        // (not require/import statements): an extensionless file's module
        // system follows the NEAREST package.json, which differs per machine
        // (real /tmp → CJS; sandboxed tmpdirs inside a checkout → ESM).
        const binDir = path.join(home, "bin");
        fs.mkdirSync(binDir, { recursive: true });
        const claudeBin = path.join(binDir, "claude");
        const errFile = path.join(home, "hook-stderr.txt");
        const doneFile = path.join(home, "hook-done");
        fs.writeFileSync(
            claudeBin,
            '#!/usr/bin/env node\n' +
                'import("node:child_process").then(async ({ spawn }) => {\n' +
                '  const fs = await import("node:fs");\n' +
                '  const sh = spawn("/bin/sh", ["-c", process.env.HOOK_CMD], {\n' +
                '    env: process.env,\n' +
                '    stdio: ["ignore", fs.openSync(process.env.HOOK_ERRFILE, "w"), fs.openSync(process.env.HOOK_ERRFILE, "a")]\n' +
                '  });\n' +
                '  sh.on("exit", () => { try { fs.writeFileSync(process.env.HOOK_DONE, String(Date.now())); } catch {} });\n' +
                '});\n' +
                'setInterval(() => {}, 60000);\n',
            { mode: 0o755 },
        );
        claudePid = spawn(claudeBin, [], {
            env: { ...baseEnv, BILI_CLAUDE_NATIVE_PORT: String(port), HOOK_CMD: `"${process.execPath}" "${distScript}"`, HOOK_ERRFILE: errFile, HOOK_DONE: doneFile },
            detached: true,
            stdio: "ignore",
        }).pid ?? 0;
        assert.ok(claudePid > 1, "fake claude spawned");
        const t0 = Date.now();
        while (!fs.existsSync(doneFile) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 250));
        assert.ok(fs.existsSync(doneFile), "hook completed");
        const stderr = fs.readFileSync(errFile, "utf8");
        assert.match(stderr, /attaching to running proxy/, "hook attached to the squatting daemon");
        assert.match(stderr, /WARNING:.*NO session-lifecycle watchdog/s, "#1322: refusal surfaced instead of silently voiding the contract");
        assert.match(stderr, /\(#1322\)/, "warning cites the issue for operators");
        // Non-destructive: killing the session must NOT take the daemon down.
        killPid(claudePid);
        claudePid = 0;
        await new Promise((r) => setTimeout(r, 15_000));
        assert.ok(await canConnect(port), "daemon survives session end — operator decides its fate");
        const h = (await (await fetch(`http://127.0.0.1:${port}/__bili/health`)).json()) as { watchdog?: { armed?: boolean; watchers?: number[] } };
        assert.equal(h.watchdog?.armed, false, "health explains why the warning fired");
        assert.deepEqual(h.watchdog?.watchers, []);
    } finally {
        if (claudePid > 1) killPid(claudePid);
        if (squatter > 1) killPid(squatter);
        await rmHome(home);
    }
});

function spawnProxy(distCli: string, port: number, env: NodeJS.ProcessEnv): number {
    const child = spawn(process.execPath, [distCli, "start", "--host", "127.0.0.1", "--port", String(port)], { env, stdio: "ignore" });
    return child.pid ?? 0;
}

// #7 end-to-end: two concurrent claude sessions share ONE stable-port proxy.
// The first session's hook SPAWNS it (watchdog seeded with session A's host);
// the second ATTACHES and must register its own host via POST /__bili/watcher.
// Old code: A's exit killed the shared proxy and session B went down with it
// (Connection refused mid-session). Fixed: the proxy survives A's death while
// B lives, and dies only after the LAST session exits. Linux-only like the
// watchdog e2e above (fake claude walks /proc, /bin/sh shebang exec).
test("hook e2e: shared proxy survives the first session's exit, dies after the last (#7)", { timeout: 180_000, skip: LIVE_E2E ? process.platform !== "linux" : liveSkip }, async () => {
    const distScript = path.resolve(import.meta.dirname, "..", "dist", "claude-native-bootstrap.js");
    ensureDistBuilt(distScript);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-share-"));
    const xdg = { home, config: path.join(home, "cfg"), state: path.join(home, "state"), cache: path.join(home, "cache"), data: path.join(home, "data") };
    const tmp = path.join(xdg.home, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const port = await freePort();
    const binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const claudeBin = path.join(binDir, "claude");
    fs.writeFileSync(
        claudeBin,
        '#!/usr/bin/env node\nconst { spawn } = require("node:child_process");\n' +
            'spawn("/bin/sh", ["-c", process.env.BILI_FAKE_HOOK_CMD], { stdio: "ignore" });\n' +
            "setInterval(() => {}, 60000);\n",
    );
    fs.chmodSync(claudeBin, 0o755);
    const sessionEnv = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: xdg.home,
        XDG_CONFIG_HOME: xdg.config,
        XDG_STATE_HOME: xdg.state,
        XDG_CACHE_HOME: xdg.cache,
        XDG_DATA_HOME: xdg.data,
        BILI_CLAUDE_NATIVE_PORT: String(port),
        NO_COLOR: "1",
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        BILI_FAKE_HOOK_CMD: `"${process.execPath}" '${distScript}'`,
    };
    const spawnClaude = (): number => {
        const proc = spawn(claudeBin, [], { env: sessionEnv, stdio: "ignore", detached: true });
        return proc.pid ?? 0;
    };
    const instanceFile = path.join(xdg.state, "billion-context", "proxy-origin");
    const claudeA = spawnClaude();
    let proxyPid = 0;
    let claudeB = 0;
    try {
        // A is guaranteed the SPAWNER: its proxy is up before B is even born.
        assert.ok(await waitForPort(port, 60_000), "proxy up behind session A");
        const inst = JSON.parse(await waitForInstanceFile(instanceFile, 30_000)) as { pid: number; origin: string };
        proxyPid = inst.pid;
        assert.equal(inst.origin, `http://127.0.0.1:${port}`);

        // Session B starts: its hook attaches to the healthy proxy and
        // registers B's host pid. Generous margin so CI jitter can't flake it.
        claudeB = spawnClaude();
        await new Promise((r) => setTimeout(r, 8000));

        // A exits mid-B-session. Old watchdog: parent-gone killed the shared
        // proxy within one 2s tick. Now: B is still registered → alive.
        if (claudeA > 1) killPid(claudeA);
        await new Promise((r) => setTimeout(r, 6000));
        assert.ok(await canConnect(port), "proxy survives the FIRST session's exit while the second lives");
        const instMid = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
        assert.equal(instMid.pid, proxyPid, "same proxy instance throughout — no respawn");

        // Last session exits → the proxy must follow within a few ticks.
        if (claudeB > 1) killPid(claudeB);
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && (await canConnect(port))) await new Promise((r) => setTimeout(r, 250));
        assert.equal(await canConnect(port), false, "proxy exits after the LAST session");
    } finally {
        if (claudeA > 1) killPid(claudeA);
        if (claudeB > 1) killPid(claudeB);
        if (proxyPid > 1) killPid(proxyPid);
        if (await canConnect(port)) {
            try {
                const leftover = JSON.parse(fs.readFileSync(instanceFile, "utf8")) as { pid: number };
                if (typeof leftover.pid === "number") killPid(leftover.pid);
            } catch {}
        }
        await rmHome(home);
    }
});
