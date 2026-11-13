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
}

// `bili pi-inline` (#3278/#4526): the launcher must start NO proxy, hand the
// child a clean env with BILI_PI_INLINE=1 (no BILLION_CONTEXT_PROXY/HTTPS_PROXY
// — planNativePi would otherwise attach instead of arming the in-process
// engine), and follow the same single-load rule as the proxy lane for `-e`.
test("runLaunch pi-inline: no proxy spawned, BILI_PI_INLINE=1, attach/proxy env stripped, -e only when plugin not installed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-piinline-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevPiBin = process.env.PI_BIN;
    const prevPiDir = process.env.PI_CODING_AGENT_DIR;
    const prevBcp = process.env.BILLION_CONTEXT_PROXY;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    const prevMitmHosts = process.env.BILI_MITM_HOSTS;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    // Hostile inherited posture: these would flip planNativePi to attach (or
    // MITM-shape routing) if the launcher failed to strip them.
    process.env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.BILI_MITM_HOSTS = "example.com";
    const fakePi = path.join(home, process.platform === "win32" ? "fake-pi.exe" : "fake-pi");
    fs.writeFileSync(fakePi, "");
    process.env.PI_BIN = fakePi;
    const piHome = path.join(home, ".pi/agent");
    fs.mkdirSync(piHome, { recursive: true });
    fs.writeFileSync(path.join(piHome, "models.json"), JSON.stringify({ providers: {} }));

    // runLaunch only injects -e when dist/agent/pi.js exists; create a stub
    // when running tests from a checkout without a prior build (same seam as
    // tests/launcher.test.ts).
    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "pi.js");
    const stubbed = !fs.existsSync(distAgent);
    if (stubbed) {
        fs.mkdirSync(path.dirname(distAgent), { recursive: true });
        fs.writeFileSync(distAgent, "");
    }

    const spawns: SpawnRecord[] = [];
    const spawnImpl: SpawnFn = (cmd, args, options) => {
        spawns.push({ command: cmd, args: [...args], env: options?.env });
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
            { client: "pi-inline", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(spawns.length, 1, "exactly one child (pi itself) — no proxy spawn");
        assert.equal(spawns[0].command, fakePi);
        assert.deepEqual(spawns[0].args.slice(0, 2), ["-e", distAgent], "plugin injected via -e when settings.json has no entry");
        const env = spawns[0].env!;
        assert.equal(env.BILI_PI_INLINE, "1");
        assert.equal(env.BILLION_CONTEXT_PROXY, undefined, "inherited BILLION_CONTEXT_PROXY must be stripped (attach would win)");
        assert.equal(env.HTTPS_PROXY, undefined, "inherited HTTPS_PROXY must be stripped (no MITM lane)");
        assert.equal(env.BILI_MITM_HOSTS, undefined);
        assert.deepEqual(fetched, [], "no proxy health/fetch traffic on the inline lane");
        assert.deepEqual(exitCalls, [0]);

        // settings.json packages already points at this install → no -e
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: [root] }));
        spawns.length = 0;
        exitCalls.length = 0;
        await runLaunch(
            { client: "pi-inline", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(spawns.length, 1);
        assert.ok(!spawns[0].args.includes("-e"), "no double-register when settings.json already loads the plugin");
        assert.equal(spawns[0].env!.BILI_PI_INLINE, "1");
        assert.deepEqual(exitCalls, [0]);
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevPiBin === undefined) delete process.env.PI_BIN;
        else process.env.PI_BIN = prevPiBin;
        if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevPiDir;
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

// Without a loadable extension the inline lane must refuse BEFORE spawning
// anything: there is no wire-mode fallback when no proxy exists, so a silent
// pass-through would run the whole session uncompressed.
test("runLaunch pi-inline: refuses (exit 2) when the bili extension cannot load", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-piinlineref-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevPiBin = process.env.PI_BIN;
    const prevPiDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const fakePi = path.join(home, process.platform === "win32" ? "fake-pi.exe" : "fake-pi");
    fs.writeFileSync(fakePi, "");
    process.env.PI_BIN = fakePi;
    const piHome = path.join(home, ".pi/agent");
    fs.mkdirSync(piHome, { recursive: true });
    fs.writeFileSync(path.join(piHome, "models.json"), JSON.stringify({ providers: {} }));

    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "pi.js");
    const distBackup = `${distAgent}.bak-test`;
    const distExisted = fs.existsSync(distAgent);
    if (distExisted) fs.renameSync(distAgent, distBackup);
    else {
        // A stub that exists would make the launch succeed — ensure absence.
        fs.rmSync(distAgent, { force: true });
    }

    const spawns: SpawnRecord[] = [];
    const spawnImpl: SpawnFn = (cmd, args, options) => {
        spawns.push({ command: cmd, args: [...args], env: options?.env });
        return makeFakeChild(42422);
    };

    const prevExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;

    try {
        await runLaunch(
            { client: "pi-inline", clientArgs: [], overrides: {} },
            { spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(exitCalls.length, 1);
        assert.equal(exitCalls[0], 2, "must refuse with exit code 2");
        assert.equal(spawns.length, 0, "nothing may be spawned — not even pi");
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevPiBin === undefined) delete process.env.PI_BIN;
        else process.env.PI_BIN = prevPiBin;
        if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevPiDir;
        if (distExisted) fs.renameSync(distBackup, distAgent);
        rmrf(home);
    }
});
