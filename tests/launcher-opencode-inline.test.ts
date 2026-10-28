import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";
import { runLaunch } from "../src/launcher.js";
import type { SpawnChild, SpawnFn } from "../src/launcher.js";
import { selfPackageRoot } from "../src/plugin-install.js";

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

interface SpawnRecord {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv | undefined;
    verbatim: boolean | undefined;
}

// `bili opencode-inline` (#4669): the launcher must start NO proxy, hand the
// child a clean env with BILI_OPENCODE_INLINE=1 (no BILLION_CONTEXT_PROXY/
// HTTPS_PROXY — planNativeOpencode would otherwise attach instead of arming
// the in-process engine), and load the bili plugin through an OPENCODE_CONFIG
// clone (plugin injection only; 2.x directory wrapper when the host is 2.x).
test("runLaunch opencode-inline: no proxy spawned, BILI_OPENCODE_INLINE=1, attach/proxy env stripped, plugin rides OPENCODE_CONFIG", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ocinline-"));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevOcConfig = process.env.OPENCODE_CONFIG;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevBcp = process.env.BILLION_CONTEXT_PROXY;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    const prevMitmHosts = process.env.BILI_MITM_HOSTS;
    // Isolated config root: no user opencode.json, no ambient OPENCODE_CONFIG.
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    delete process.env.OPENCODE_CONFIG;
    // Hostile inherited posture: these would flip planNativeOpencode to
    // attach (or MITM-shape routing) if the launcher failed to strip them.
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.BILI_MITM_HOSTS = "example.com";
    // Fake opencode binary: reports 2.x so the plugin rides the directory
    // wrapper (the shape OpenCode 2.x requires); the spawn itself is faked.
    const fakeOc = path.join(home, process.platform === "win32" ? "fake-opencode.cmd" : "fake-opencode");
    fs.writeFileSync(fakeOc, process.platform === "win32" ? "@echo opencode 2.0.3\n" : '#!/bin/sh\necho "opencode 2.0.3"\n');
    if (process.platform !== "win32") fs.chmodSync(fakeOc, 0o755);
    process.env.BILI_CLIENT_BIN = fakeOc;

    // runLaunch needs the plugin entry on disk; create a stub when running
    // tests from a checkout without a prior build (same seam as
    // tests/launcher.test.ts).
    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "opencode-native.js");
    const stubbed = !fs.existsSync(distAgent);
    if (stubbed) {
        fs.mkdirSync(path.dirname(distAgent), { recursive: true });
        fs.writeFileSync(distAgent, "");
    }

    const spawns: SpawnRecord[] = [];
    const spawnImpl: SpawnFn = (cmd, args, options) => {
        spawns.push({ command: cmd, args: [...args], env: options?.env, verbatim: options?.windowsVerbatimArguments });
        const child = makeFakeChild(0);
        const orig = child.on!.bind(child);
        (child as { on: SpawnChild["on"] }).on = (event, listener) => {
            orig(event, listener);
            if (event === "exit") setTimeout(() => listener(0, null), 0);
            return child;
        };
        return child;
    };
    // No proxy is started on this lane — any health probe or fetch is a bug.
    const fetched: string[] = [];
    const fetchImpl = async (url: string) => {
        fetched.push(String(url));
        return { ok: true };
    };
    const fetchHealthInfo = async (origin: string) => {
        fetched.push(`health:${origin}`);
        return { ok: true, pid: 42422 };
    };

    const prevExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;

    try {
        await runLaunch(
            { client: "opencode-inline", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(spawns.length, 1, "exactly one child (opencode itself) — no proxy spawn");
        // #679: on Windows the .cmd shim rides comspec /d /s /c "<line>"
        // (CreateProcess cannot execute a batch file); elsewhere it spawns directly.
        // Expectations derive from the child's captured env, not ambient
        // process.env — concurrent tests in one CI shard rewrite globals mid-flight (#4599).
        const cap = spawns[0];
        if (process.platform === "win32") {
            // Mirror planClientSpawn's case-insensitive probe: sanitized env
            // copies keep the OS key casing (`ComSpec`), plain objects don't (#4599).
            const ce = cap.env ?? {};
            const childComspec = ce.COMSPEC ?? ce.ComSpec ?? ce.comspec;
            const expectedComspec = typeof childComspec === "string" && childComspec.trim().length > 0 ? childComspec : "cmd.exe";
            assert.equal(cap.command, expectedComspec, "#679 comspec wrap uses the child env's COMSPEC");
            const quotedOc = /\s/.test(fakeOc) ? `"${fakeOc}"` : fakeOc;
            assert.deepEqual(cap.args, ["/d", "/s", "/c", `"${quotedOc}"`]);
            assert.equal(cap.verbatim, true, "#679 verbatim argv keeps cmd.exe from re-splitting");
            assert.match(cap.args[3] ?? "", /^".*\.cmd"$/, "comspec line wraps the quoted .cmd shim");
        } else {
            assert.equal(cap.command, fakeOc);
            assert.deepEqual(cap.args, []);
        }
        const env = cap.env!;
        assert.equal(env.BILI_OPENCODE_INLINE, "1");
        assert.equal(env.BILLION_CONTEXT_PROXY, undefined, "inherited BILLION_CONTEXT_PROXY must be stripped (attach would win)");
        assert.equal(env.HTTPS_PROXY, undefined, "inherited HTTPS_PROXY must be stripped (no MITM lane)");
        assert.equal(env.BILI_MITM_HOSTS, undefined);
        assert.deepEqual(fetched, [], "no proxy health/fetch traffic on the inline lane");
        assert.deepEqual(exitCalls, [0]);
        // The plugin entry rides the OPENCODE_CONFIG clone — 2.x dir wrapper.
        const ocConfig = env.OPENCODE_CONFIG;
        assert.ok(ocConfig, "OPENCODE_CONFIG clone handed to the child");
        const clone = JSON.parse(fs.readFileSync(ocConfig, "utf8")) as { plugin?: unknown[]; compaction?: { auto?: boolean } };
        assert.ok(Array.isArray(clone.plugin), "clone injects the plugin entry");
        const entry = clone.plugin![0];
        if (typeof entry === "string" && entry !== distAgent) {
            // directory wrapper: its index.js re-exports the dist entry
            const idx = path.join(entry, "index.js");
            assert.ok(fs.existsSync(idx), "2.x plugin wrapper directory exists");
            assert.ok(fs.readFileSync(idx, "utf8").includes("opencode-native.js"), "wrapper re-exports the dist entry");
        } else {
            assert.equal(entry, distAgent, "1.x: bare dist path injected");
        }
        assert.equal(clone.compaction?.auto, false, "host auto-compaction stays off (ACP owns compression)");
    } finally {
        process.exit = prevExit;
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevOcConfig === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOcConfig;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (prevBcp === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevBcp;
        if (prevHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = prevHttpsProxy;
        if (prevMitmHosts === undefined) delete process.env.BILI_MITM_HOSTS;
        else process.env.BILI_MITM_HOSTS = prevMitmHosts;
        if (stubbed) fs.rmSync(distAgent, { force: true });
        rmrf(home);
    }
});

// Without the plugin entry on disk the inline lane must refuse BEFORE
// spawning anything: there is no wire-mode fallback when no proxy exists, so
// a silent pass-through would run the whole session uncompressed.
test("runLaunch opencode-inline: refuses (exit 2) when the bili opencode plugin entry cannot load", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ocinline2-"));
    const prevHome = process.env.HOME;
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevOcConfig = process.env.OPENCODE_CONFIG;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    delete process.env.OPENCODE_CONFIG;
    const fakeOc = path.join(home, process.platform === "win32" ? "fake-opencode.cmd" : "fake-opencode");
    fs.writeFileSync(fakeOc, process.platform === "win32" ? "@echo opencode 2.0.3\n" : '#!/bin/sh\necho "opencode 2.0.3"\n');
    if (process.platform !== "win32") fs.chmodSync(fakeOc, 0o755);
    process.env.BILI_CLIENT_BIN = fakeOc;

    // Point selfPackageRoot at an empty dist so the entry is missing.
    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "opencode-native.js");
    const had = fs.existsSync(distAgent);
    if (had) fs.renameSync(distAgent, `${distAgent}.bak`);

    const spawns: SpawnRecord[] = [];
    const spawnImpl: SpawnFn = (cmd, args, options) => {
        spawns.push({ command: cmd, args: [...args], env: options?.env, verbatim: options?.windowsVerbatimArguments });
        return makeFakeChild(0);
    };
    const prevExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;

    try {
        await runLaunch(
            { client: "opencode-inline", clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 1 }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(spawns.length, 0, "nothing spawned when the plugin entry is missing");
        assert.deepEqual(exitCalls, [2], "refused with exit 2");
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        if (prevOcConfig === undefined) delete process.env.OPENCODE_CONFIG;
        else process.env.OPENCODE_CONFIG = prevOcConfig;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (had) fs.renameSync(`${distAgent}.bak`, distAgent);
        rmrf(home);
    }
});
