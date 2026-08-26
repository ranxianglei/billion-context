import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import os from "node:os";
import path from "node:path";
import {
    LAUNCHER_DEFAULT_HOST,
    isLaunchClient,
    baseClientName,
    piTestArgs,
    proxyOrigin,
    healthUrl,
    wrapUpstream,
    unwrapUpstream,
    buildPiEnv,
    buildCodexEnv,
    buildClaudeEnv,
    buildCodexArgs,
    preparePiHttpRewrite,
    prepareOmpHttpRewrite,
    prepareOpencodeHttpRewrite,
    stripInheritedProxy,
    resolvePiHome,
    resolveOmpHome,
    extractDomains,
    discoverDomains,
    discoverRoutes,
    resolveCaCertPath,
    resolveClientCommand,
    isOnPath,
    parseCodexToml,
    parseOmpYaml,
    readOmpConfig,
    parseHermesYaml,
    readHermesConfig,
    resolveHermesHome,
    prepareHermesHome,
    readOpencodeConfig,
    resolveOpencodeConfigFile,
    findFreePort,
    ensureProxyRunning,
    stopProxy,
    type SpawnChild,
    type SpawnFn,
    runLaunch,
    type ClientConfig,
    type HttpRewrite,
} from "../src/launcher.ts";

test("isLaunchClient: pi/claude/codex/omp/opencode/pi-test true, others false", () => {
    assert.equal(isLaunchClient("pi"), true);
    assert.equal(isLaunchClient("claude"), true);
    assert.equal(isLaunchClient("codex"), true);
    assert.equal(isLaunchClient("omp"), true);
    assert.equal(isLaunchClient("opencode"), true);
    assert.equal(isLaunchClient("hermes"), true);
    assert.equal(isLaunchClient("pi-test"), true);
    assert.equal(isLaunchClient("start"), false);
    assert.equal(isLaunchClient(""), false);
});

test("baseClientName: pi-test → pi, others unchanged", () => {
    assert.equal(baseClientName("pi-test"), "pi");
    assert.equal(baseClientName("pi"), "pi");
    assert.equal(baseClientName("claude"), "claude");
    assert.equal(baseClientName("codex"), "codex");
});

test("piTestArgs: prepends --no-extensions for pi-test, leaves other clients unchanged", () => {
    assert.deepEqual(piTestArgs("pi-test", ["print hi"]), ["--no-extensions", "print hi"]);
    assert.deepEqual(piTestArgs("pi-test", []), ["--no-extensions"]);
    assert.deepEqual(piTestArgs("pi", ["--foo", "bar"]), ["--foo", "bar"]);
    assert.deepEqual(piTestArgs("codex", ["--foo"]), ["--foo"]);
    assert.deepEqual(piTestArgs("claude", ["--foo"]), ["--foo"]);
});

test("proxyOrigin / healthUrl", () => {
    assert.equal(proxyOrigin("127.0.0.1", 8787), "http://127.0.0.1:8787");
    assert.equal(healthUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787/__bili/health");
});

test("wrapUpstream: prepends proxy prefix", () => {
    const o = "http://127.0.0.1:8787";
    assert.equal(wrapUpstream(o, "https://api.anthropic.com"), `${o}/bili/https://api.anthropic.com`);
});

test("wrapUpstream: strips trailing slashes on upstream", () => {
    const o = "http://127.0.0.1:8787";
    assert.equal(wrapUpstream(o, "https://api.openai.com/v1/"), `${o}/bili/https://api.openai.com/v1`);
    assert.equal(wrapUpstream(o, "https://api.openai.com/v1///"), `${o}/bili/https://api.openai.com/v1`);
});

test("wrapUpstream: idempotent (no double-wrap for same origin)", () => {
    const o = "http://127.0.0.1:8787";
    const once = wrapUpstream(o, "https://api.anthropic.com");
    assert.equal(wrapUpstream(o, once), once);
});

test("unwrapUpstream: recovers real upstream from a /bili/ wrap", () => {
    assert.equal(unwrapUpstream("http://127.0.0.1:8787/bili/https://api.example.com/v1"), "https://api.example.com/v1");
    assert.equal(unwrapUpstream("http://127.0.0.1:9000/bili/http://x.example/y/z"), "http://x.example/y/z");
});

test("unwrapUpstream: returns non-wrapped url as-is", () => {
    assert.equal(unwrapUpstream("https://api.openai.com/v1"), "https://api.openai.com/v1");
    assert.equal(unwrapUpstream("https://api.anthropic.com"), "https://api.anthropic.com");
});

test("buildPiEnv: sets HTTPS_PROXY + NODE_EXTRA_CA_CERTS, preserves baseEnv", () => {
    const env = buildPiEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-x");
});

test("buildCodexEnv: sets HTTPS_PROXY + SSL_CERT_FILE, preserves baseEnv", () => {
    const env = buildCodexEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin", OPENAI_API_KEY: "sk-x" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.OPENAI_API_KEY, "sk-x");
    assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
});

test("buildClaudeEnv: sets HTTPS_PROXY + NODE_EXTRA_CA_CERTS, preserves baseEnv", () => {
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", [], [], { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-x");
    assert.equal(env.SSL_CERT_FILE, undefined);
});

test("extractDomains: https hostnames only, unwraps /bili/, dedupes, drops http/unparseable", () => {
    assert.deepEqual(
        extractDomains([
            "https://api.anthropic.com",
            "https://open.bigmodel.cn/api/coding/paas/v4",
            "http://localhost:1234",
            "http://127.0.0.1:8787/bili/https://api.openai.com/v1",
            "https://api.anthropic.com",
            "not-a-url",
            "",
        ]),
        ["api.anthropic.com", "open.bigmodel.cn", "api.openai.com"],
    );
});

test("extractDomains: empty / all-invalid input → []", () => {
    assert.deepEqual(extractDomains([]), []);
    assert.deepEqual(extractDomains(["", "ftp://x.example", "http://only.http/v1"]), []);
});

test("discoverDomains: claude → [] (claude rides /bili/ rewrites, not cert MITM)", () => {
    assert.deepEqual(discoverDomains("claude", {}), []);
});

test("discoverDomains: pi → https hostnames from providers (http dropped, /bili/ unwrapped)", () => {
    const config: ClientConfig = {
        pi: {
            providers: {
                zhipu: { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
                bailian: { baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic" },
                local: { baseUrl: "http://127.0.0.1:18081" },
                wrapped: { baseUrl: "http://127.0.0.1:8787/bili/https://api.openai.com/v1" },
            },
        },
    };
    assert.deepEqual(discoverDomains("pi", config), [
        "open.bigmodel.cn",
        "coding.dashscope.aliyuncs.com",
        "api.openai.com",
    ]);
});

test("discoverDomains: codex → https hostnames from providers + openaiBaseUrl", () => {
    const config: ClientConfig = {
        codex: {
            openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
            providers: {
                openai: { baseUrl: "https://api.openai.com/v1" },
                local: { baseUrl: "http://localhost:8080" },
            },
        },
    };
    assert.deepEqual(discoverDomains("codex", config), ["api.openai.com", "chatgpt.com"]);
});

test("discoverDomains: empty config → [] for pi/codex", () => {
    assert.deepEqual(discoverDomains("pi", {}), []);
    assert.deepEqual(discoverDomains("codex", {}), []);
});

test("resolveCaCertPath: honors XDG_DATA_HOME", () => {
    assert.equal(
        resolveCaCertPath({ XDG_DATA_HOME: "/custom/data" }),
        path.join("/custom/data", "billion-context", "ca", "root-ca.pem"),
    );
});

test("resolveCaCertPath: falls back to ~/.local/share", () => {
    assert.equal(
        resolveCaCertPath({}),
        path.join(os.homedir(), ".local", "share", "billion-context", "ca", "root-ca.pem"),
    );
});

test("parseCodexToml: reads model_provider + each provider base_url (skips non-string values)", () => {
    const toml = `
model_provider = "bili-relay"
model = "gpt-5"

[model_providers.bili-relay]
name = "bili-relay"
base_url = "http://127.0.0.1:8787/bili/https://api.example.com/v1"
wire_api = "responses"
requires_openai_auth = false

[model_providers.bili-openai]
base_url = "http://127.0.0.1:8787/bili/https://api.openai.com/v1"

tools.web_search = false
`;
    const cfg = parseCodexToml(toml);
    assert.equal(cfg.modelProvider, "bili-relay");
    assert.equal(cfg.providers["bili-relay"].baseUrl, "http://127.0.0.1:8787/bili/https://api.example.com/v1");
    assert.equal(cfg.providers["bili-openai"].baseUrl, "http://127.0.0.1:8787/bili/https://api.openai.com/v1");
});

test("findFreePort: returns preferred when it is free", async () => {
    const port = 50000 + Math.floor(Math.random() * 1000);
    const got = await findFreePort(port, LAUNCHER_DEFAULT_HOST);
    assert.equal(got, port);
});

test("findFreePort: returns another port when preferred is occupied", async () => {
    const blocker = net.createServer();
    const occupied = await new Promise<number>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(0, LAUNCHER_DEFAULT_HOST, () => {
            const addr = blocker.address();
            if (addr && typeof addr === "object") resolve(addr.port);
            else reject(new Error("no port"));
        });
    });
    try {
        const got = await findFreePort(occupied, LAUNCHER_DEFAULT_HOST);
        assert.notEqual(got, occupied);
        assert.ok(got > 0);
    } finally {
        blocker.close();
    }
});

import { selfPackageRoot, ompPluginLoadedFrom } from "../src/plugin-install.js";

test("runLaunch pi: native -e plugin injected only when not installed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pie-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevPiBin = process.env.PI_BIN;
    const prevPiDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    // resolvePiHome falls back to os.homedir(), which on Windows reads
    // USERPROFILE, not HOME — set both or the test reads the runner's real
    // home and the second assertion fails.
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const fakePi = path.join(home, "fake-pi");
    fs.writeFileSync(fakePi, "");
    process.env.PI_BIN = fakePi;
    const piHome = path.join(home, ".pi/agent");
    fs.mkdirSync(piHome, { recursive: true });
    fs.writeFileSync(path.join(piHome, "models.json"), JSON.stringify({ providers: {} }));

    // runLaunch only injects -e when dist/agent/pi.js exists; create a stub
    // when running tests from a checkout without a prior build.
    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "pi.js");
    const stubbed = !fs.existsSync(distAgent);
    if (stubbed) {
        fs.mkdirSync(path.dirname(distAgent), { recursive: true });
        fs.writeFileSync(distAgent, "");
    }

    const clientArgsSeen: string[][] = [];
    const spawnImpl: SpawnFn = (cmd, args) => {
        if (cmd === fakePi) {
            clientArgsSeen.push([...args]);
            // runClient resolves on "exit" — fire it on next tick.
            const child = makeFakeChild(0);
            const orig = child.on.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        return makeFakeChild(42422);
    };
    const fetchImpl = async () => ({ ok: true });

    // runLaunch ends with process.exit() — stub it or it kills the test
    // runner and every test registered after this one silently never runs.
    const prevExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;

    try {
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            { fetchImpl, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.deepEqual(clientArgsSeen[0].slice(0, 2), ["-e", distAgent]);

        // installed (settings.json packages already points at this install) → no -e
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: [root] }));
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            { fetchImpl, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].includes("-e"));
        assert.deepEqual(exitCalls, [0, 0]);

        // legacy billion-context-pi entry is a DIFFERENT (usually absent) package
        // that self-disables under BILLION_CONTEXT_PROXY — it must NOT suppress -e
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:billion-context-pi"] }));
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            { fetchImpl, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.deepEqual(clientArgsSeen[0].slice(0, 2), ["-e", distAgent]);

        // a registry npm:billion-context entry DOES load this package's plugin → no -e
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:billion-context"] }));
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            { fetchImpl, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].includes("-e"));
        assert.deepEqual(exitCalls, [0, 0, 0, 0]);
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevPiBin === undefined) delete process.env.PI_BIN;
        else process.env.PI_BIN = prevPiBin;
        if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevPiDir;
        if (stubbed) fs.rmSync(distAgent, { force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("runLaunch omp: native -e plugin injected only when no loadable config entry", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ompe-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevOmpDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const fakeOmp = path.join(home, "fake-omp");
    fs.writeFileSync(fakeOmp, "");
    process.env.BILI_CLIENT_BIN = fakeOmp;
    const ompHome = path.join(home, ".omp", "agent");
    fs.mkdirSync(ompHome, { recursive: true });
    fs.writeFileSync(path.join(ompHome, "models.yml"), "providers: {}\n");

    // runLaunch only injects -e when dist/agent/omp.js exists; stub it when
    // running tests from a checkout without a prior build.
    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "omp.js");
    const stubbed = !fs.existsSync(distAgent);
    if (stubbed) {
        fs.mkdirSync(path.dirname(distAgent), { recursive: true });
        fs.writeFileSync(distAgent, "");
    }

    const clientArgsSeen: string[][] = [];
    const spawnImpl: SpawnFn = (cmd, args) => {
        if (cmd === fakeOmp) {
            clientArgsSeen.push([...args]);
            const child = makeFakeChild(0);
            const orig = child.on.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        return makeFakeChild(42422);
    };
    const fetchImpl = async () => ({ ok: true });

    const prevExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;

    try {
        // no config.yml at all → -e injected
        await runLaunch(
            { client: "omp", clientArgs: [], overrides: {} },
            { fetchImpl, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.deepEqual(clientArgsSeen[0].slice(0, 2), ["-e", distAgent]);

        // loadable entry (existing file) → omp loads it from config; no -e
        const otherInstall = path.join(home, "other-install", "dist", "agent", "omp.js");
        fs.mkdirSync(path.dirname(otherInstall), { recursive: true });
        fs.writeFileSync(otherInstall, "");
        fs.writeFileSync(path.join(ompHome, "config.yml"), `extensions:\n  - ${otherInstall}\n`);
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "omp", clientArgs: [], overrides: {} },
            { fetchImpl, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].includes("-e"));

        // stale entry (file gone) → omp would fail to load it; -e injected again
        fs.rmSync(path.dirname(otherInstall), { recursive: true, force: true });
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "omp", clientArgs: [], overrides: {} },
            { fetchImpl, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.deepEqual(clientArgsSeen[0].slice(0, 2), ["-e", distAgent]);
        assert.deepEqual(exitCalls, [0, 0, 0]);
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (prevOmpDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevOmpDir;
        if (stubbed) fs.rmSync(distAgent, { force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("ompPluginLoadedFrom: only entries whose file exists count as loaded", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ompl-"));
    try {
        const ompHome = path.join(home, ".omp", "agent");
        fs.mkdirSync(ompHome, { recursive: true });
        assert.equal(ompPluginLoadedFrom(ompHome), false); // no config.yml
        const live = path.join(home, "live", "dist", "agent", "omp.js");
        fs.mkdirSync(path.dirname(live), { recursive: true });
        fs.writeFileSync(live, "");
        fs.writeFileSync(path.join(ompHome, "config.yml"), `# omp config\nextensions:\n  - ${live} # bili\nmodelRoles:\n  default: x\n`);
        assert.equal(ompPluginLoadedFrom(ompHome), true); // comments/inline tolerated
        fs.writeFileSync(path.join(ompHome, "config.yml"), "extensions:\n  - /gone/dist/agent/omp.js\n");
        assert.equal(ompPluginLoadedFrom(ompHome), false); // stale target
        fs.writeFileSync(path.join(ompHome, "config.yml"), "extensions:\n  - /some/other/plugin.js\n");
        assert.equal(ompPluginLoadedFrom(ompHome), false); // foreign plugin
        // Path-shaped value OUTSIDE the extensions block must not gate -e.
        fs.writeFileSync(path.join(ompHome, "config.yml"), `modelRoles:\n  default: ${live}\n`);
        assert.equal(ompPluginLoadedFrom(ompHome), false);
        // `~`-prefixed loadable entry counts as loaded (omp expands it too).
        fs.writeFileSync(path.join(ompHome, "config.yml"), `extensions:\n  - ~/live/dist/agent/omp.js\n`);
        const realHome = live.slice(0, live.indexOf("/live/"));
        const savedHome = os.homedir();
        try {
            Object.defineProperty(os, "homedir", { value: () => realHome, configurable: true });
            assert.equal(ompPluginLoadedFrom(ompHome), true);
        } finally {
            Object.defineProperty(os, "homedir", { value: () => savedHome, configurable: true });
        }
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

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

test("ensureProxyRunning: always spawns a fresh proxy, never reuses a listener", async () => {
    let spawnCalls = 0;
    const spawnImpl: SpawnFn = () => {
        spawnCalls++;
        return makeFakeChild(0);
    };
    const fetchImpl = async () => ({ ok: true });
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        { fetchImpl, spawnImpl },
    );
    assert.equal(spawnCalls, 1);
    assert.ok(handle.child);
    assert.equal(handle.origin, `http://127.0.0.1:${handle.port}`);
    assert.notEqual(handle.child, null);
});

test("ensureProxyRunning: spawns when not healthy, polls until healthy", async () => {
    let probes = 0;
    const fetchImpl = async () => {
        probes++;
        return { ok: probes >= 2 };
    };
    let spawnedArgs: string[] | null = null;
    const spawnImpl: SpawnFn = (_cmd, args) => {
        spawnedArgs = [...args];
        return makeFakeChild(42421);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        { fetchImpl, spawnImpl, sleep: () => Promise.resolve() },
    );
    assert.equal(handle.child?.pid, 42421);
    assert.ok(spawnedArgs !== null);
    assert.ok(spawnedArgs.includes("start"));
    assert.ok(spawnedArgs.includes("--host"));
    const portIdx = spawnedArgs.indexOf("--port");
    assert.ok(portIdx >= 0, "spawn args include --port");
    assert.equal(spawnedArgs[portIdx + 1], String(handle.port));
    assert.ok(probes >= 2);
});

test("ensureProxyRunning: throws when never healthy within deadline", async () => {
    const fetchImpl = async () => ({ ok: false });
    const spawnImpl: SpawnFn = () => makeFakeChild(42422);
    let ticks = 0;
    const now = () => ticks * 1000;
    const sleep = () => {
        ticks += 10;
        return Promise.resolve();
    };
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            { fetchImpl, spawnImpl, now, sleep },
        ),
        /did not become healthy/,
    );
});

test("stopProxy: no-op when child missing pid", () => {
    assert.doesNotThrow(() =>
        stopProxy({ origin: "http://127.0.0.1:8787", port: 8787, child: { pid: 0 } }),
    );
});

test("stopProxy: kills the owned child", () => {
    let killed = false;
    const child: SpawnChild = {
        pid: 77777,
        kill: () => {
            killed = true;
            return true;
        },
    };
    stopProxy({ origin: "http://127.0.0.1:8787", port: 8787, reused: false, child });
    assert.equal(killed, true);
});

test("isOnPath: finds a known binary on PATH, misses bogus name", () => {
    const nodeDir = path.dirname(process.execPath);
    const nodeName = path.basename(process.execPath);
    assert.equal(isOnPath(nodeName, { PATH: nodeDir }), true);
    assert.equal(isOnPath("definitely-not-a-real-bin-xyzzy", { PATH: nodeDir }), false);
    assert.equal(isOnPath(nodeName, {}), false);
});

test("resolveClientCommand: codex/claude resolve to themselves", () => {
    assert.deepEqual(resolveClientCommand("codex", { PATH: "/usr/bin" }), {
        command: "codex",
        prefixArgs: [],
    });
    assert.deepEqual(resolveClientCommand("claude", { PATH: "/usr/bin" }), {
        command: "claude",
        prefixArgs: [],
    });
});

test("resolveClientCommand: pi prefers PI_BIN env", () => {
    assert.deepEqual(resolveClientCommand("pi", { PI_BIN: "/custom/pi", PATH: "/usr/bin" }), {
        command: "/custom/pi",
        prefixArgs: [],
    });
});

test("resolveClientCommand: pi on PATH resolves to full path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-path-"));
    const piFile = path.join(tmp, "pi");
    fs.writeFileSync(piFile, "#!/bin/sh\necho pi\n", { mode: 0o755 });
    try {
        assert.deepEqual(resolveClientCommand("pi", { PATH: tmp }), {
            command: piFile,
            prefixArgs: [],
        });
    } finally {
        fs.unlinkSync(piFile);
        fs.rmdirSync(tmp);
    }
});

test("resolveClientCommand: pi falls back to node + cli.js when not on PATH and no PI_BIN", () => {
    const r = resolveClientCommand("pi", { PATH: "/nonexistent-dir-zzz" });
    assert.equal(r.command, process.execPath);
    assert.equal(r.prefixArgs.length, 1);
    assert.ok(
        r.prefixArgs[0].split(path.sep).join("/").endsWith("pi-coding-agent/dist/cli.js"),
        `prefixArgs[0]=${r.prefixArgs[0]}`,
    );
});

test("resolvePiHome: PI_CODING_AGENT_DIR > PI_HOME > default ~/.pi/agent", () => {
    const h = os.homedir();
    assert.equal(resolvePiHome({ PI_CODING_AGENT_DIR: "/custom/dir" }), "/custom/dir");
    assert.equal(resolvePiHome({ PI_HOME: "/pi/home" }), "/pi/home");
    assert.equal(resolvePiHome({ PI_CODING_AGENT_DIR: "/a", PI_HOME: "/b" }), "/a");
    assert.equal(resolvePiHome({}), path.join(h, ".pi", "agent"));
    assert.equal(resolvePiHome({ PI_CODING_AGENT_DIR: "  ", PI_HOME: "/b" }), "/b");
});

test("discoverRoutes: codex mixed http+https → splits httpsDomains + httpRewrites", () => {
    const config: ClientConfig = {
        codex: {
            openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
            providers: {
                openai: { baseUrl: "https://api.openai.com/v1" },
                relay: { baseUrl: "http://relay.local/v1" },
            },
        },
    };
    const routes = discoverRoutes("codex", config);
    assert.deepEqual(routes.httpsDomains, ["api.openai.com", "chatgpt.com"]);
    assert.deepEqual(routes.httpRewrites, [
        { key: "model_providers.relay.base_url", realUpstream: "http://relay.local/v1" },
    ]);
});

test("discoverRoutes: codex wrapped /bili/ http provider → unwrapped realUpstream", () => {
    const config: ClientConfig = {
        codex: {
            providers: {
                relay: { baseUrl: "http://127.0.0.1:8787/bili/http://relay.local/v1" },
            },
        },
    };
    const routes = discoverRoutes("codex", config);
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "model_providers.relay.base_url", realUpstream: "http://relay.local/v1" },
    ]);
});

test("discoverRoutes: claude with http ANTHROPIC_BASE_URL → httpRewrites entry, no https domains", () => {
    const config: ClientConfig = {
        claude: { anthropicBaseUrl: "http://relay.local/anthropic" },
    };
    const routes = discoverRoutes("claude", config);
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "http://relay.local/anthropic" },
    ]);
});

test("discoverRoutes: claude default → ANTHROPIC_BASE_URL /bili/ rewrite (no cert MITM; undici ignores HTTPS_PROXY)", () => {
    const routes = discoverRoutes("claude", {});
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpsRewrites, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
    ]);
});

test("discoverRoutes: claude /bili/-wrapped base_url unwraps to real upstream for re-wrap", () => {
    const config: ClientConfig = {
        claude: { anthropicBaseUrl: "http://127.0.0.1:8787/bili/https://api.anthropic.com" },
    };
    const routes = discoverRoutes("claude", config);
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
    ]);
});

test("discoverRoutes: pi with one http provider → rewrite keyed by provider name", () => {
    const config: ClientConfig = {
        pi: {
            providers: {
                zhipu: { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
                local: { baseUrl: "http://127.0.0.1:18081" },
            },
        },
    };
    const routes = discoverRoutes("pi", config);
    assert.deepEqual(routes.httpsDomains, ["open.bigmodel.cn"]);
    assert.deepEqual(routes.httpRewrites, [
        { key: "local", realUpstream: "http://127.0.0.1:18081" },
    ]);
});

test("discoverRoutes: empty config → {httpsDomains:[], httpRewrites:[]}", () => {
    assert.deepEqual(discoverRoutes("pi", {}), { httpsDomains: [], httpRewrites: [], httpsRewrites: [] });
    assert.deepEqual(discoverRoutes("codex", {}), { httpsDomains: [], httpRewrites: [], httpsRewrites: [] });
});

test("discoverRoutes: codex /bili/-wrapped HTTPS provider → httpsRewrites to raw upstream", () => {
    const config: ClientConfig = {
        codex: {
            providers: {
                "bili-comfly": { baseUrl: "http://127.0.0.1:8787/bili/https://ai.comfly.org/v1" },
            },
        },
    };
    const routes = discoverRoutes("codex", config);
    assert.deepEqual(routes.httpsDomains, ["ai.comfly.org"]);
    assert.deepEqual(routes.httpsRewrites, [
        { key: "model_providers.bili-comfly.base_url", realUpstream: "https://ai.comfly.org/v1" },
    ]);
    assert.deepEqual(routes.httpRewrites, []);
});

test("discoverRoutes: codex clean (unwrapped) HTTPS → httpsDomains only, httpsRewrites empty", () => {
    const config: ClientConfig = {
        codex: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
    };
    const routes = discoverRoutes("codex", config);
    assert.deepEqual(routes.httpsDomains, ["api.openai.com"]);
    assert.deepEqual(routes.httpsRewrites, []);
    assert.deepEqual(routes.httpRewrites, []);
});

test("buildCodexArgs: httpsRewrites emit -c key=raw upstream (unwrapped, for cert MITM)", () => {
    const httpsRewrites: HttpRewrite[] = [
        { key: "model_providers.x.base_url", realUpstream: "https://ai.comfly.org/v1" },
    ];
    assert.deepEqual(buildCodexArgs("http://127.0.0.1:41355", [], httpsRewrites, []), [
        "-c", "model_providers.x.base_url=https://ai.comfly.org/v1",
    ]);
});

test("buildCodexArgs: emits -c pairs for each http rewrite, then extra args", () => {
    const rewrites: HttpRewrite[] = [
        { key: "k1", realUpstream: "u1" },
        { key: "k2", realUpstream: "u2" },
    ];
    assert.deepEqual(buildCodexArgs("http://h:p", rewrites, [], ["--extra"]), [
        "-c", "k1=http://h:p/bili/u1",
        "-c", "k2=http://h:p/bili/u2",
        "--extra",
    ]);
});

test("buildCodexArgs: no rewrites → just extra args", () => {
    assert.deepEqual(buildCodexArgs("http://h:p", [], [], ["--foo"]), ["--foo"]);
});

test("buildClaudeEnv: ANTHROPIC_BASE_URL rewrite sets env + keeps HTTPS_PROXY/CA", () => {
    const rewrites: HttpRewrite[] = [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "http://relay.local/anthropic" },
    ];
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/ca.pem");
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787/bili/http://relay.local/anthropic");
});

test("buildClaudeEnv: no ANTHROPIC_BASE_URL rewrite → env.ANTHROPIC_BASE_URL unset", () => {
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", [], [], { PATH: "/usr/bin" });
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
});

test("preparePiHttpRewrite: rewrites matching provider, leaves others, symlinks siblings", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pihome-"));
    fs.writeFileSync(
        path.join(home, "models.json"),
        JSON.stringify({
            providers: {
                a: { baseUrl: "http://example.com/v1" },
                b: { baseUrl: "https://secure.example.com" },
            },
        }),
    );
    fs.writeFileSync(path.join(home, "auth.json"), '{"key":"x"}');
    const tmp = preparePiHttpRewrite(home, "http://127.0.0.1:8787", [
        { key: "a", realUpstream: "http://example.com/v1" },
    ], []);
    try {
        assert.ok(typeof tmp === "string" && tmp.length > 0);
        const out = JSON.parse(fs.readFileSync(path.join(tmp!, "models.json"), "utf8"));
        assert.equal(out.providers.a.baseUrl, "http://127.0.0.1:8787/bili/http://example.com/v1");
        assert.equal(out.providers.b.baseUrl, "https://secure.example.com");
        assert.equal(fs.lstatSync(path.join(tmp!, "auth.json")).isSymbolicLink(), true);
        assert.equal(fs.realpathSync(path.join(tmp!, "auth.json")), path.join(home, "auth.json"));
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("preparePiHttpRewrite: returns undefined when no rewrites", () => {
    assert.equal(preparePiHttpRewrite("/whatever", "http://127.0.0.1:8787", [], []), undefined);
});

test("preparePiHttpRewrite: returns undefined when models.json missing or unparseable", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pihome-"));
    const rw: HttpRewrite[] = [{ key: "a", realUpstream: "http://x/v1" }];
    try {
        assert.equal(preparePiHttpRewrite(home, "http://127.0.0.1:8787", rw, []), undefined);
        fs.writeFileSync(path.join(home, "models.json"), "not-json{");
        assert.equal(preparePiHttpRewrite(home, "http://127.0.0.1:8787", rw, []), undefined);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("preparePiHttpRewrite: returns undefined when models.json is not an object", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pihome-"));
    const rw: HttpRewrite[] = [{ key: "a", realUpstream: "http://x/v1" }];
    try {
        fs.writeFileSync(path.join(home, "models.json"), JSON.stringify([1, 2, 3]));
        assert.equal(preparePiHttpRewrite(home, "http://127.0.0.1:8787", rw, []), undefined);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("stripInheritedProxy: removes generic proxy redirector vars, keeps the rest", () => {
    const cleaned = stripInheritedProxy({
        http_proxy: "http://corp:20172",
        https_proxy: "http://corp:20172",
        all_proxy: "http://corp:20172",
        HTTP_PROXY: "http://corp:20172",
        HTTPS_PROXY: "http://corp:20172",
        ALL_PROXY: "http://corp:20172",
        no_proxy: "127.0.0.1",
        NO_PROXY: "127.0.0.1",
        BILI_UPSTREAM_PROXY: "http://relay:9999",
        PATH: "/usr/bin",
        HOME: "/home/dog",
    });
    for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
        assert.equal(cleaned[k], undefined, `${k} should be stripped`);
    }
    assert.equal(cleaned.no_proxy, "127.0.0.1", "no_proxy kept");
    assert.equal(cleaned.BILI_UPSTREAM_PROXY, "http://relay:9999", "BILI_UPSTREAM_PROXY kept (explicit chaining)");
    assert.equal(cleaned.PATH, "/usr/bin", "PATH kept");
    assert.equal(cleaned.HOME, "/home/dog", "HOME kept");
});

test("parseOmpYaml: reads providers.<name>.baseUrl (skips non-matching)", () => {
    const yml = [
        "providers:",
        "  sglang-responses:",
        "    baseUrl: http://127.0.0.1:8199/v1",
        "    models:",
        "      - name: qwen3.8-27b",
        "  zhipuai:",
        "    baseUrl: https://open.bigmodel.cn/api/coding/paas/v4",
        "    api: openai",
        "  ollama-chat:",
        "    baseUrl: http://127.0.0.1:11435/v1",
        "modelRoles:",
        "  default: sglang-responses/qwen3.8-27b:high",
    ].join("\n");
    const cfg = parseOmpYaml(yml);
    assert.equal(cfg.providers["sglang-responses"].baseUrl, "http://127.0.0.1:8199/v1");
    assert.equal(cfg.providers["zhipuai"].baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
    assert.equal(cfg.providers["ollama-chat"].baseUrl, "http://127.0.0.1:11435/v1");
    assert.equal(Object.keys(cfg.providers).length, 3);
});

test("parseOmpYaml: no providers key → {}", () => {
    assert.deepEqual(parseOmpYaml("modelRoles:\n  default: x\n"), { providers: {} });
    assert.deepEqual(parseOmpYaml(""), { providers: {} });
});

test("readOmpConfig: reads models.yml from omp home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    try {
        fs.writeFileSync(path.join(home, "models.yml"), "providers:\n  a:\n    baseUrl: http://x:1/v1\n");
        const cfg = readOmpConfig(home);
        assert.equal(cfg.providers.a.baseUrl, "http://x:1/v1");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("readOmpConfig: missing models.yml → {}", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    try {
        assert.deepEqual(readOmpConfig(home), { providers: {} });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("resolveOmpHome: PI_CODING_AGENT_DIR > default ~/.omp/agent", () => {
    assert.equal(resolveOmpHome({ PI_CODING_AGENT_DIR: "/custom/omp" }), "/custom/omp");
    assert.equal(resolveOmpHome({}), path.join(os.homedir(), ".omp", "agent"));
});

test("discoverRoutes: omp http + https providers → splits httpsDomains + httpRewrites", () => {
    const config: ClientConfig = {
        omp: {
            providers: {
                zhipuai: { baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
                sglang: { baseUrl: "http://127.0.0.1:8199/v1" },
            },
        },
    };
    const routes = discoverRoutes("omp", config);
    assert.deepEqual(routes.httpsDomains, ["open.bigmodel.cn"]);
    assert.deepEqual(routes.httpRewrites, [
        { key: "sglang", realUpstream: "http://127.0.0.1:8199/v1" },
    ]);
});

test("prepareOmpHttpRewrite: rewrites matching provider, leaves others, symlinks siblings", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    fs.writeFileSync(
        path.join(home, "models.yml"),
        [
            "providers:",
            "  a:",
            "    baseUrl: http://example.com/v1",
            "  b:",
            "    baseUrl: https://secure.example.com",
        ].join("\n"),
    );
    fs.writeFileSync(path.join(home, "config.yml"), "extensions:\n  - /x/omp.js\n");
    const tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", [
        { key: "a", realUpstream: "http://example.com/v1" },
    ], []);
    try {
        assert.equal(tmp, `${home}-bili`);
        const out = fs.readFileSync(path.join(tmp!, "models.yml"), "utf8");
        assert.ok(out.includes("baseUrl: http://127.0.0.1:8787/bili/http://example.com/v1"), "a rewritten");
        assert.ok(out.includes("baseUrl: https://secure.example.com"), "b unchanged");
        assert.equal(fs.lstatSync(path.join(tmp!, "config.yml")).isSymbolicLink(), true);
        assert.equal(fs.realpathSync(path.join(tmp!, "config.yml")), path.join(home, "config.yml"));
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("prepareOmpHttpRewrite: overlay is stable, refreshes symlinks, keeps bili-created entries", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    const modelsYml = ["providers:", "  a:", "    baseUrl: http://example.com/v1"].join("\n");
    fs.writeFileSync(path.join(home, "models.yml"), modelsYml);
    fs.mkdirSync(path.join(home, "sessions"));
    const rw = [{ key: "a", realUpstream: "http://example.com/v1" }];
    let tmp: string | undefined;
    try {
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        assert.equal(tmp, `${home}-bili`);
        assert.equal(fs.lstatSync(path.join(tmp!, "sessions")).isSymbolicLink(), true);
        fs.writeFileSync(path.join(tmp!, "agent.db"), "state-created-inside-overlay");
        const tmp2 = prepareOmpHttpRewrite(home, "http://127.0.0.1:9999", rw, []);
        assert.equal(tmp2, tmp);
        assert.equal(fs.readFileSync(path.join(tmp!, "agent.db"), "utf8"), "state-created-inside-overlay");
        const rewritten = fs.readFileSync(path.join(tmp!, "models.yml"), "utf8");
        assert.ok(rewritten.includes("baseUrl: http://127.0.0.1:9999/bili/http://example.com/v1"), "port updated");
        fs.mkdirSync(path.join(home, "memories"));
        const tmp3 = prepareOmpHttpRewrite(home, "http://127.0.0.1:9999", rw, []);
        assert.equal(tmp3, tmp);
        assert.equal(fs.lstatSync(path.join(tmp!, "memories")).isSymbolicLink(), true);
        const leftovers = fs.readdirSync(tmp!).filter((f) => /^\.models\.yml\.\d+\.tmp$/.test(f));
        assert.deepEqual(leftovers, [], "no leftover models.yml tmp files");
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("prepareOmpHttpRewrite: drops dead symlinks and merges shadowed dirs into real home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    const modelsYml = ["providers:", "  a:", "    baseUrl: http://example.com/v1"].join("\n");
    fs.writeFileSync(path.join(home, "models.yml"), modelsYml);
    fs.mkdirSync(path.join(home, "sessions"));
    const rw = [{ key: "a", realUpstream: "http://example.com/v1" }];
    const overlay = `${home}-bili`;
    let tmp: string | undefined;
    try {
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        fs.symlinkSync(path.join(home, "gone-entry"), path.join(overlay, "gone-entry"));
        fs.rmSync(path.join(overlay, "sessions"));
        fs.mkdirSync(path.join(overlay, "sessions"));
        fs.writeFileSync(path.join(overlay, "sessions", "orphaned.jsonl"), "session-created-under-bili");
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        assert.equal(fs.existsSync(path.join(overlay, "gone-entry")), false, "dead symlink dropped");
        assert.equal(fs.lstatSync(path.join(overlay, "sessions")).isSymbolicLink(), true, "shadow dir re-linked");
        assert.equal(
            fs.readFileSync(path.join(home, "sessions", "orphaned.jsonl"), "utf8"),
            "session-created-under-bili",
            "shadow dir merged into real home",
        );
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("prepareOmpHttpRewrite: shadow FILE merged newer-wins, loser kept as .bili-conflict", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    const modelsYml = ["providers:", "  a:", "    baseUrl: http://example.com/v1"].join("\n");
    fs.writeFileSync(path.join(home, "models.yml"), modelsYml);
    fs.writeFileSync(path.join(home, "settings.json"), "stale-from-real-home");
    fs.writeFileSync(path.join(home, "older.json"), "real-newer");
    const rw = [{ key: "a", realUpstream: "http://example.com/v1" }];
    const overlay = `${home}-bili`;
    let tmp: string | undefined;
    try {
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        assert.equal(fs.readFileSync(path.join(overlay, ".bili-launch.pid"), "utf8").trim(), `${process.pid}`, "launch pid marker written");
        fs.rmSync(path.join(overlay, "settings.json"));
        fs.writeFileSync(path.join(overlay, "settings.json"), "client-newer-write");
        const now = Date.now();
        fs.utimesSync(path.join(home, "settings.json"), new Date(now - 4000), new Date(now - 4000));
        fs.rmSync(path.join(overlay, "older.json"));
        fs.writeFileSync(path.join(overlay, "older.json"), "overlay-stale");
        fs.utimesSync(path.join(overlay, "older.json"), new Date(now - 4000), new Date(now - 4000));
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        assert.equal(fs.readFileSync(path.join(home, "settings.json"), "utf8"), "client-newer-write", "newer overlay file wins");
        assert.equal(fs.readFileSync(path.join(home, "settings.json.bili-conflict"), "utf8"), "stale-from-real-home", "loser preserved as conflict copy");
        assert.equal(fs.lstatSync(path.join(overlay, "settings.json")).isSymbolicLink(), true, "shadow file re-linked");
        assert.equal(fs.readFileSync(path.join(home, "older.json"), "utf8"), "real-newer", "newer real-home file wins");
        assert.equal(fs.readFileSync(path.join(home, "older.json.bili-conflict"), "utf8"), "overlay-stale", "stale overlay copy preserved as conflict");
        assert.equal(fs.lstatSync(path.join(overlay, "older.json")).isSymbolicLink(), true, "re-linked after merge");
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("prepareOmpHttpRewrite: recursive dir merge keeps deep new files when both sides share a subdir", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    const modelsYml = ["providers:", "  a:", "    baseUrl: http://example.com/v1"].join("\n");
    fs.writeFileSync(path.join(home, "models.yml"), modelsYml);
    fs.mkdirSync(path.join(home, "sessions", "sub"), { recursive: true });
    fs.writeFileSync(path.join(home, "sessions", "sub", "old.jsonl"), "old");
    const rw = [{ key: "a", realUpstream: "http://example.com/v1" }];
    const overlay = `${home}-bili`;
    let tmp: string | undefined;
    try {
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        fs.rmSync(path.join(overlay, "sessions"));
        fs.mkdirSync(path.join(overlay, "sessions", "sub"), { recursive: true });
        fs.writeFileSync(path.join(overlay, "sessions", "sub", "new.jsonl"), "deep-new-session");
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        assert.equal(fs.readFileSync(path.join(home, "sessions", "sub", "old.jsonl"), "utf8"), "old", "existing deep file untouched");
        assert.equal(fs.readFileSync(path.join(home, "sessions", "sub", "new.jsonl"), "utf8"), "deep-new-session", "deep new file merged, not destroyed");
        assert.equal(fs.lstatSync(path.join(overlay, "sessions")).isSymbolicLink(), true, "shadow dir re-linked");
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("prepareOmpHttpRewrite: file-vs-dir type clash preserves both sides", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    const modelsYml = ["providers:", "  a:", "    baseUrl: http://example.com/v1"].join("\n");
    fs.writeFileSync(path.join(home, "models.yml"), modelsYml);
    fs.writeFileSync(path.join(home, "state.bin"), "v1-file");
    const rw = [{ key: "a", realUpstream: "http://example.com/v1" }];
    const overlay = `${home}-bili`;
    let tmp: string | undefined;
    try {
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        fs.rmSync(path.join(overlay, "state.bin"));
        fs.mkdirSync(path.join(overlay, "state.bin", "x"), { recursive: true });
        fs.writeFileSync(path.join(overlay, "state.bin", "x", "precious.txt"), "precious");
        tmp = prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []);
        assert.equal(fs.statSync(path.join(home, "state.bin")).isDirectory(), true, "merged dir took the canonical name");
        assert.equal(fs.readFileSync(path.join(home, "state.bin", "x", "precious.txt"), "utf8"), "precious", "overlay subtree preserved, not destroyed");
        assert.equal(fs.readFileSync(path.join(home, "state.bin.bili-conflict"), "utf8"), "v1-file", "displaced real-home file preserved as conflict copy");
        assert.equal(fs.lstatSync(path.join(overlay, "state.bin")).isSymbolicLink(), true, "re-linked after merge");
    } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("prepareOmpHttpRewrite: returns undefined when no rewrites", () => {
    assert.equal(prepareOmpHttpRewrite("/whatever", "http://127.0.0.1:8787", [], []), undefined);
});

test("prepareOmpHttpRewrite: returns undefined when models.yml missing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    try {
        const rw = [{ key: "a", realUpstream: "http://example.com/v1" }];
        assert.equal(prepareOmpHttpRewrite(home, "http://127.0.0.1:8787", rw, []), undefined);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("readOpencodeConfig: reads provider baseURLs from opencode.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-cfg-"));
    try {
        const cfgFile = path.join(dir, "opencode.json");
        fs.writeFileSync(
            cfgFile,
            JSON.stringify({
                provider: {
                    local: { options: { baseURL: "http://127.0.0.1:18081/v1" } },
                    remote: { options: { baseURL: "https://api.example.com/v1" } },
                    noUrl: { options: {} },
                },
            }),
        );
        const cfg = readOpencodeConfig(cfgFile);
        assert.deepEqual(cfg.providers["local"], { baseURL: "http://127.0.0.1:18081/v1" });
        assert.deepEqual(cfg.providers["remote"], { baseURL: "https://api.example.com/v1" });
        assert.equal(cfg.providers["noUrl"], undefined);
        assert.equal(readOpencodeConfig(path.join(dir, "missing.json")).providers["local"], undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("discoverRoutes(opencode): HTTP baseURL → /bili/ rewrite, HTTPS → MITM domain", () => {
    const config = {
        opencode: {
            providers: {
                "zhipuai-lb": { baseURL: "http://127.0.0.1:18081/v1" },
                zhipuai: { baseURL: "https://open.bigmodel.cn/api/coding/paas/v4" },
            },
        },
    } as unknown as import("../src/client-config.js").ClientConfig;
    const routes = discoverRoutes("opencode", config);
    assert.equal(routes.httpRewrites.length, 1);
    assert.equal(routes.httpRewrites[0].key, "zhipuai-lb");
    assert.equal(routes.httpRewrites[0].realUpstream, "http://127.0.0.1:18081/v1");
    assert.deepEqual(routes.httpsDomains, ["open.bigmodel.cn"]);
});

test("prepareOpencodeHttpRewrite: writes rewritten copy, original untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rw-"));
    try {
        const cfgFile = path.join(dir, "opencode.json");
        const original = JSON.stringify({
            plugin: ["opencode-acp@latest"],
            provider: { "zhipuai-lb": { options: { baseURL: "http://127.0.0.1:18081/v1" } } },
        });
        fs.writeFileSync(cfgFile, original);
        const rw = [{ key: "zhipuai-lb", realUpstream: "http://127.0.0.1:18081/v1" }];
        const tmpFile = prepareOpencodeHttpRewrite(cfgFile, "http://127.0.0.1:8787", rw, []);
        assert.ok(tmpFile);
        const rewritten = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
        assert.equal(rewritten.provider["zhipuai-lb"].options.baseURL, "http://127.0.0.1:8787/bili/http://127.0.0.1:18081/v1");
        assert.deepEqual(rewritten.plugin, ["opencode-acp@latest"]);
        assert.equal(fs.readFileSync(cfgFile, "utf8"), original);
        fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
        assert.equal(prepareOpencodeHttpRewrite(cfgFile, "http://127.0.0.1:8787", [], []), undefined);
        const withPlugin = prepareOpencodeHttpRewrite(cfgFile, "http://127.0.0.1:8787", [], [], "/opt/bili/dist/agent/opencode.js");
        assert.ok(withPlugin);
        const injected = JSON.parse(fs.readFileSync(withPlugin, "utf8"));
        assert.deepEqual(injected.plugin, ["opencode-acp@latest", "/opt/bili/dist/agent/opencode.js"]);
        assert.equal(injected.provider["zhipuai-lb"].options.baseURL, "http://127.0.0.1:18081/v1");
        fs.rmSync(path.dirname(withPlugin), { recursive: true, force: true });
        const missingCfg = prepareOpencodeHttpRewrite(path.join(dir, "nope.json"), "http://127.0.0.1:8787", [], [], "/opt/bili/dist/agent/opencode.js");
        assert.ok(missingCfg);
        const fromEmpty = JSON.parse(fs.readFileSync(missingCfg, "utf8"));
        assert.deepEqual(fromEmpty.plugin, ["/opt/bili/dist/agent/opencode.js"]);
        fs.rmSync(path.dirname(missingCfg), { recursive: true, force: true });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("resolveOpencodeConfigFile: OPENCODE_CONFIG wins, XDG fallback", () => {
    assert.equal(resolveOpencodeConfigFile({ OPENCODE_CONFIG: "/tmp/x.json" }), "/tmp/x.json");
    const p = resolveOpencodeConfigFile({ XDG_CONFIG_HOME: "/tmp/xdg" });
    assert.ok(p.endsWith(path.join("opencode", "opencode.json")));
});

test("parseHermesYaml: v12 providers dict + legacy custom_providers list", () => {
    const v12 = parseHermesYaml([
        "model:",
        "  default: qwen3.8-27b",
        "  provider: bili",
        "providers:",
        "  bili:",
        "    name: bili",
        "    api: http://127.0.0.1:8199/v1",
        "    transport: openai_chat",
        "  glm:",
        "    api: https://open.bigmodel.cn/api/paas/v4",
    ].join("\n"));
    assert.equal(v12.providers.bili?.api, "http://127.0.0.1:8199/v1");
    assert.equal(v12.providers.glm?.api, "https://open.bigmodel.cn/api/paas/v4");
    assert.deepEqual(v12.providers.bili ?? {}, { api: "http://127.0.0.1:8199/v1" });

    const legacy = parseHermesYaml([
        "custom_providers:",
        "  - name: sglang",
        "    base_url: http://127.0.0.1:8199/v1",
        "    api_key: sk-x",
        "  - base_url: http://other:1/v1",
    ].join("\n"));
    assert.equal(legacy.providers.sglang?.api, "http://127.0.0.1:8199/v1");
    assert.equal(legacy.providers["custom-1"]?.api, "http://other:1/v1");
});

test("readHermesConfig + resolveHermesHome", () => {
    assert.equal(resolveHermesHome({ HERMES_HOME: "/tmp/hh" }), "/tmp/hh");
    assert.ok(resolveHermesHome({}).endsWith(path.join(".hermes")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cfg-"));
    try {
        assert.deepEqual(readHermesConfig(path.join(dir, "nope")).providers, {});
        fs.writeFileSync(path.join(dir, "config.yaml"), "providers:\n  x:\n    api: http://1.2.3.4:9/v1\n");
        const cfg = readHermesConfig(dir);
        assert.equal(cfg.providers.x?.api, "http://1.2.3.4:9/v1");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("discoverRoutes: hermes wraps http AND https via /bili/ (no MITM domains)", () => {
    const config: ClientConfig = {};
    (config as Record<string, unknown>).hermes = {
        providers: {
            sglang: { api: "http://127.0.0.1:8199/v1" },
            glm: { api: "https://open.bigmodel.cn/api/paas/v4" },
            wrapped: { api: "http://127.0.0.1:8787/bili/https://api.foo.io/v1" },
            broken: { api: "::::" },
        },
    };
    const routes = discoverRoutes("hermes", config);
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpRewrites.map((r) => r.key).sort(), ["glm", "sglang", "wrapped"]);
    const glm = routes.httpRewrites.find((r) => r.key === "glm");
    assert.equal(glm?.realUpstream, "https://open.bigmodel.cn/api/paas/v4");
    const wrapped = routes.httpRewrites.find((r) => r.key === "wrapped");
    assert.equal(wrapped?.realUpstream, "https://api.foo.io/v1");
});

test("prepareHermesHome: rewrites api lines, shares siblings, never touches the real home", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
    try {
        fs.writeFileSync(path.join(dir, "config.yaml"), [
            "model:",
            "  default: qwen3.8-27b",
            "providers:",
            "  bili:",
            "    api: http://127.0.0.1:8199/v1  # local sglang",
            "  glm:",
            "    api: https://open.bigmodel.cn/api/paas/v4",
            "custom_providers:",
            "  - name: legacy",
            "    base_url: http://10.0.0.5:1234/v1",
        ].join("\n"));
        fs.writeFileSync(path.join(dir, "SOUL.md"), "soul");
        fs.mkdirSync(path.join(dir, "skills"));
        const original = fs.readFileSync(path.join(dir, "config.yaml"), "utf8");

        const rewrites: HttpRewrite[] = [
            { key: "bili", realUpstream: "http://127.0.0.1:8199/v1" },
            { key: "glm", realUpstream: "https://open.bigmodel.cn/api/paas/v4" },
            { key: "legacy", realUpstream: "http://10.0.0.5:1234/v1" },
        ];
        const tmp = prepareHermesHome(dir, "http://127.0.0.1:8787", rewrites);
        assert.ok(tmp);
        const txt = fs.readFileSync(path.join(tmp, "config.yaml"), "utf8");
        assert.ok(txt.includes("api: http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1  # local sglang"));
        assert.ok(txt.includes("api: http://127.0.0.1:8787/bili/https://open.bigmodel.cn/api/paas/v4"));
        assert.ok(txt.includes("base_url: http://127.0.0.1:8787/bili/http://10.0.0.5:1234/v1"));
        assert.equal(fs.readFileSync(path.join(dir, "config.yaml"), "utf8"), original);
        assert.equal(fs.readFileSync(path.join(tmp, "SOUL.md"), "utf8"), "soul");
        assert.ok(fs.lstatSync(path.join(tmp, "skills")).isSymbolicLink());
        fs.rmSync(tmp, { recursive: true, force: true });

        assert.equal(prepareHermesHome(dir, "http://127.0.0.1:8787", []), undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("prepareHermesHome: preserves CRLF line endings when rewriting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
    try {
        fs.writeFileSync(
            path.join(dir, "config.yaml"),
            ["model:", "  default: qwen3.8-27b", "providers:", "  bili:", "    api: http://127.0.0.1:8199/v1"].join("\r\n") + "\r\n",
        );
        const rewrites: HttpRewrite[] = [{ key: "bili", realUpstream: "http://127.0.0.1:8199/v1" }];
        const tmp = prepareHermesHome(dir, "http://127.0.0.1:8787", rewrites);
        assert.ok(tmp);
        const txt = fs.readFileSync(path.join(tmp, "config.yaml"), "utf8");
        assert.ok(txt.includes("\r\n"), "CRLF preserved");
        assert.ok(!/\r\n\r\n/.test(txt), "no doubled newlines");
        assert.ok(txt.includes("api: http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1\r"));
        fs.rmSync(tmp, { recursive: true, force: true });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("prepareHermesHome: returns undefined for unreadable config even with rewrites pending", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
    try {
        const rewrites: HttpRewrite[] = [{ key: "bili", realUpstream: "http://127.0.0.1:8199/v1" }];
        assert.equal(prepareHermesHome(dir, "http://127.0.0.1:8787", rewrites), undefined);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
