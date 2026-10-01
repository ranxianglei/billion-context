import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildClaudeSettingsArg,
    runClient,
    runLaunch,
    type SpawnChild,
    type SpawnFn,
} from "../src/launcher.ts";
import { rmrf } from "./tmp-rm.ts";

// #1292: Windows npm installs resolve claude to claude.cmd; the launcher's
// inline --settings JSON then crossed cmd.exe /d /s /c + the batch shim, whose
// quote-toggle parsing strips embedded quotes — claude received a quoteless
// {env:{...}} and died with "Invalid JSON provided to --settings". Fix: on
// win32 the same object rides a temp file (a path carries no quotes); POSIX
// keeps the inline form.

// ensureProxyRunning coordinates across processes via <state>/proxy-starting (#707)
// — point the state dir at a throwaway so these tests never touch the real one.
const prevXdgState = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1292-state-"));

const inheritedLaunchVars = [
    "BILI_CLIENT_BIN",
    "BILLION_CONTEXT_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
];
for (const k of inheritedLaunchVars) delete process.env[k];

function makeFakeChild(pid: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
        },
    };
}

const MANAGED_BASE_URL = "http://127.0.0.1:8788/bili/https://api.anthropic.com";

test("#1292 buildClaudeSettingsArg: non-win32 keeps the inline JSON (pre-fix behavior preserved)", () => {
    for (const platform of ["linux", "darwin", "freebsd"] as const) {
        const r = buildClaudeSettingsArg(platform, MANAGED_BASE_URL);
        assert.equal(r.tmpFile, undefined);
        assert.deepEqual(r.clientArgs, ["--settings", JSON.stringify({ env: { ANTHROPIC_BASE_URL: MANAGED_BASE_URL } })]);
    }
});

test("#1292 buildClaudeSettingsArg: win32 delivers a temp settings file whose content parses as JSON", () => {
    const r = buildClaudeSettingsArg("win32", MANAGED_BASE_URL);
    try {
        assert.equal(r.clientArgs[0], "--settings");
        const p = r.clientArgs[1];
        assert.equal(r.tmpFile, p);
        assert.ok(p.endsWith(".json"), p);
        assert.ok(!p.includes('"'), "the arg crossing the shim must carry no quotes");
        assert.ok(fs.existsSync(p), "settings file must exist");
        assert.deepEqual(JSON.parse(fs.readFileSync(p, "utf8")), { env: { ANTHROPIC_BASE_URL: MANAGED_BASE_URL } });
    } finally {
        if (r.tmpFile) fs.rmSync(r.tmpFile, { force: true });
    }
});

interface ShimSpawnCapture {
    line: string;
    env: NodeJS.ProcessEnv;
    settingsMatch: RegExpMatchArray | null;
    existsAtSpawn: boolean;
    contentAtSpawn: string | null;
}

function writeNativeInstallHome(home: string): void {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(
        path.join(home, ".claude", "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: MANAGED_BASE_URL } }),
    );
}

test("#1292 runLaunch claude simulated win32: --settings crosses the .cmd shim boundary as a parseable-JSON file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1292-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevComspec = process.env.COMSPEC;
    const prevPlugin = process.env.BILI_LAUNCHER_PLUGIN;
    const prevExit = process.exit;

    writeNativeInstallHome(home);
    const fakeClaude = path.join(home, "fake-claude.cmd");
    fs.writeFileSync(fakeClaude, "");
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    process.env.BILI_CLIENT_BIN = fakeClaude;
    process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe";
    process.env.BILI_LAUNCHER_PLUGIN = "0";
    process.exit = (() => undefined) as typeof process.exit;

    const seen: ShimSpawnCapture[] = [];
    const spawnImpl: SpawnFn = (command, args, opts) => {
        if (args.length >= 4 && args[0] === "/d" && args[1] === "/s" && args[2] === "/c") {
            const line = args[3];
            const m = line.match(/--settings\s+("[^"]+"|\S+)/);
            let exists = false;
            let content: string | null = null;
            if (m) {
                const value = m[1].replace(/^"|"$/g, "");
                exists = fs.existsSync(value);
                if (exists) content = fs.readFileSync(value, "utf8");
            }
            seen.push({ line, env: opts.env ?? {}, settingsMatch: m, existsAtSpawn: exists, contentAtSpawn: content });
            const child = makeFakeChild(42424);
            const orig = child.on?.bind(child);
            if (orig) {
                child.on = (event, listener) => {
                    orig(event, listener);
                    if (event === "exit") setTimeout(() => listener(0, null), 0);
                    return child;
                };
            }
            return child;
        }
        return makeFakeChild(42422);
    };

    try {
        await runLaunch(
            { client: "claude", clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42422 }), spawnImpl, sleep: () => Promise.resolve(), platform: "win32" },
        );
        assert.equal(seen.length, 1, "exactly one client spawn through comspec");
        const cap = seen[0];
        assert.equal(cap.env.ANTHROPIC_BASE_URL?.startsWith("http://127.0.0.1:"), true, JSON.stringify(cap.env.ANTHROPIC_BASE_URL));
        assert.match(cap.env.ANTHROPIC_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+\/bili\/https:\/\/api\.anthropic\.com$/);
        assert.ok(cap.line.includes(fakeClaude), `shim path in comspec line: ${cap.line}`);
        assert.ok(cap.line.startsWith('"') && cap.line.endsWith('"'), "outer pair for cmd /s");
        assert.ok(cap.settingsMatch, `comspec line carries --settings: ${cap.line}`);
        const value = cap.settingsMatch![1].replace(/^"|"$/g, "");
        assert.ok(value.endsWith(".json"), `--settings value must be the temp file path, got: ${value}`);
        assert.ok(!value.includes('"'), "no embedded quotes may cross the shim layer");
        assert.equal(cap.existsAtSpawn, true, "settings file must exist while claude runs");
        const parsed = JSON.parse(cap.contentAtSpawn ?? "") as { env?: { ANTHROPIC_BASE_URL?: string } };
        assert.equal(parsed.env?.ANTHROPIC_BASE_URL, cap.env.ANTHROPIC_BASE_URL, "file carrier === process-env carrier");
        assert.ok(!fs.existsSync(value), "tmp settings file cleaned up after launch");
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevComspec === undefined) delete process.env.COMSPEC;
        else process.env.COMSPEC = prevComspec;
        if (prevPlugin === undefined) delete process.env.BILI_LAUNCHER_PLUGIN;
        else process.env.BILI_LAUNCHER_PLUGIN = prevPlugin;
        if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdgState;
        rmrf(home);
    }
});

test("#1292 runLaunch claude posix: --settings stays inline JSON, no temp file created", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1292-posix-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevPlugin = process.env.BILI_LAUNCHER_PLUGIN;
    const prevExit = process.exit;

    writeNativeInstallHome(home);
    const fakeClaude = path.join(home, "fake-claude");
    fs.writeFileSync(fakeClaude, "");
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    process.env.BILI_CLIENT_BIN = fakeClaude;
    process.env.BILI_LAUNCHER_PLUGIN = "0";
    process.exit = (() => undefined) as typeof process.exit;

    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const spawnImpl: SpawnFn = (command, args, opts) => {
        if (command === fakeClaude) {
            seen.push({ args: [...args], env: opts.env ?? {} });
            const child = makeFakeChild(42424);
            const orig = child.on?.bind(child);
            if (orig) {
                child.on = (event, listener) => {
                    orig(event, listener);
                    if (event === "exit") setTimeout(() => listener(0, null), 0);
                    return child;
                };
            }
            return child;
        }
        return makeFakeChild(42422);
    };

    const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("bili-claude-settings-")));
    try {
        await runLaunch(
            { client: "claude", clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42422 }), spawnImpl, sleep: () => Promise.resolve(), platform: "linux" },
        );
        assert.equal(seen.length, 1, "exactly one direct client spawn");
        const { args, env } = seen[0];
        const i = args.indexOf("--settings");
        assert.ok(i > -1, `--settings present: ${JSON.stringify(args)}`);
        const v = args[i + 1];
        assert.ok(v.startsWith('{"env"'), `inline JSON preserved on posix: ${v}`);
        assert.deepEqual(JSON.parse(v), { env: { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } });
        const tmpAfter = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("bili-claude-settings-")));
        for (const f of tmpAfter) assert.ok(tmpBefore.has(f), `no settings temp file created on posix: ${f}`);
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevPlugin === undefined) delete process.env.BILI_LAUNCHER_PLUGIN;
        else process.env.BILI_LAUNCHER_PLUGIN = prevPlugin;
        if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdgState;
        rmrf(home);
    }
});

test("#1292 real win32: settings file path survives the actual cmd.exe + batch shim round-trip", { skip: process.platform !== "win32" }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1292-wt-"));
    try {
        const shimDir = path.join(root, "bin dir");
        fs.mkdirSync(shimDir, { recursive: true });
        const shim = path.join(shimDir, "fake-claude.cmd");
        fs.writeFileSync(shim, '@echo off\r\n> "%~dp0argv.txt" echo(%*\r\n');
        const r = buildClaudeSettingsArg("win32", MANAGED_BASE_URL);
        assert.ok(r.tmpFile);
        try {
            const code = await runClient(shim, r.clientArgs, process.env);
            assert.equal(code, 0);
            const argvText = fs.readFileSync(path.join(shimDir, "argv.txt"), "utf8");
            assert.ok(argvText.includes("--settings"), argvText);
            assert.ok(argvText.includes(r.tmpFile), `shim saw the settings path intact: ${argvText}`);
            assert.deepEqual(JSON.parse(fs.readFileSync(r.tmpFile, "utf8")), { env: { ANTHROPIC_BASE_URL: MANAGED_BASE_URL } });
        } finally {
            fs.rmSync(r.tmpFile, { force: true });
        }
    } finally {
        rmrf(root);
    }
});
