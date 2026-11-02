import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { PathLike } from "node:fs";
import { rmrf } from "./tmp-rm.ts";
import { supportsFileSymlink } from "./platform-capabilities.ts";
type SymlinkKind = "dir" | "file" | "junction";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
    claimStartingMarker,
    readStartingMarker,
    registerInstanceAndWarn,
    removeStartingMarker,
    startingMarkerPath,
    unregisterInstance,
    type ProxyInstanceFile as InstanceFile,
} from "../src/instance.ts";
import { resolveNonHttpProviders } from "../src/config.js";
import {
    LAUNCHER_DEFAULT_HOST,
    findLiveAttachableInstance,
    isLaunchClient,
    baseClientName,
    piTestArgs,
    proxyOrigin,
    healthUrl,
    wrapUpstream,
    unwrapUpstream,
    isLoopbackHost,
    buildPiEnv,
    buildCodexEnv,
    buildClaudeEnv,
    applyAuxProxyHandoff,
    childNamesProxy,
    buildIflowEnv,
    buildCodexArgs,
    prepareOpencodeHttpRewrite,
    opencodeMajorVersion,
    parseOpencodeMajor,
    stripInheritedProxy,
    stripInternalLauncherChannels,
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
    parseDshSettingsYaml,
    readDshConfig,
    resolveTraeHome,
    readTraeConfig,
    buildTraeEnv,
    TRAE_DEFAULT_MODEL_HOSTS,
    buildJcodeEnv,
    JCODE_DEFAULT_MODEL_HOSTS,
    buildAiderEnv,
    readAiderConfig,
    readAiderConfUrls,
    discoverAiderArgUrls,
    AIDER_DEFAULT_MODEL_HOSTS,
    resolveDshHome,
    prepareDshHome,
    writeDshAcpPatch,
    dshPluginEntry,
    writeDshClientShimFiles,
    writeDshClientShim,
    dshArgsWithPatch,
    prepareCodexHome,
    prepareCodexMcpInjection,
    resolveCodexHome,
    readOpencodeConfig,
    readOpencodeConfigRoot,
    resolveOpencodeConfigFile,
    findFreePort,
    ensureProxyRunning,
    resolveNodeRuntime,
    probeNodeWrapperTarget,
    probeNodeMajor,
    MIN_PROXY_NODE_MAJOR,
    stopProxy,
    stopProxyGuarded,
    resolveLauncherWindow,
    resolveCodexBudgetArgs,
    codexRunModePinned,
    codexSupportsNoDaemon,
    buildWindowsCommandLine,
    resolveClaudeBudgetEnv,
    resolveQoderBudgetEnv,
    buildQoderEnv,
    readQoderConfig,
    resolveQoderHome,
    qoderIsCnSite,
    QODER_DEFAULT_MODEL_HOSTS,
    resolveCodebuddyBudgetEnv,
    buildCodebuddyEnv,
    codexUpstreamUrl,
    readClaudeSettings,
    readCodebuddyConfig,
    parseCodebuddyModelsJson,
    resolveCodebuddyHome,
    parseKimiToml,
    readKimiConfig,
    resolveKimiHome,
    KIMI_DEFAULT_MODEL_HOSTS,
    parseMcodeYaml,
    readMcodeConfig,
    resolveMcodeInstallDir,
    MCODE_DEFAULT_MODEL_HOSTS,
    buildCopilotEnv,
    buildAmpEnv,
    buildCrushEnv,
    buildZedEnv,
    COPILOT_DEFAULT_MODEL_HOSTS,
    AMP_DEFAULT_MODEL_HOSTS,
    CRUSH_DEFAULT_MODEL_HOSTS,
    readCrushConfig,
    ZED_DEFAULT_MODEL_HOSTS,
    readZedConfig,
    resolveGooseDirs,
    readGooseConfig,
    prepareGooseHome,
    finalizeGooseHome,
    type SpawnChild,
    type SpawnFn,
    runLaunch,
    runTestPi,
    type ClientName,
    type ClientConfig,
    type HttpRewrite,
    type DiscoveredRoutes,
    opencodeEffectiveCwd,
    opencodeProjectBypassWarnings,
    readOpencodeProjectLayer,
} from "../src/launcher.ts";
import { _setForTest as registrySetForTest, _resetForTest as registryResetForTest } from "../src/registry.ts";

// ensureProxyRunning coordinates across processes via <state>/proxy-starting (#707)
// — point the state dir at a throwaway so these tests never touch the real one.
const prevXdgState = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bili-launcher-state-"));
// A host harness that launches bili (omp, codex, claude) exports its client binary,
// its proxy URL and its CA into every child process. Inherited here they change what
// runLaunch launches, because BILI_CLIENT_BIN outranks `client: "pi"`
// (src/launcher.ts:2190), so the injected spawnImpl never matches the fake client and
// never fires the `exit` this file waits on, hanging the test with no timer or socket
// left to trace; and they change what the assertions read back from the launched env,
// where trae then sees NODE_EXTRA_CA_CERTS and kimi sees BILLION_CONTEXT_PROXY.
const inheritedLaunchVars = [
    "BILI_CLIENT_BIN",
    "BILLION_CONTEXT_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "HTTPS_PROXY",
    "HTTP_PROXY",
];
const prevInheritedLaunchVars: Record<string, string | undefined> = {};
for (const name of inheritedLaunchVars) {
    prevInheritedLaunchVars[name] = process.env[name];
    delete process.env[name];
}
after(() => {
    removeStartingMarker();
    for (const name of inheritedLaunchVars) {
        const value = prevInheritedLaunchVars[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prevXdgState;
});

test("isLaunchClient: pi/claude/codex/omp/opencode/pi-test true, others false", () => {
    assert.equal(isLaunchClient("pi"), true);
    assert.equal(isLaunchClient("claude"), true);
    assert.equal(isLaunchClient("codex"), true);
    assert.equal(isLaunchClient("omp"), true);
    assert.equal(isLaunchClient("opencode"), true);
    assert.equal(isLaunchClient("hermes"), true);
    assert.equal(isLaunchClient("dsh"), true);
    assert.equal(isLaunchClient("trae"), true);
    assert.equal(isLaunchClient("qoder"), true);
    assert.equal(isLaunchClient("jcode"), true);
    assert.equal(isLaunchClient("kimi"), true);
    assert.equal(isLaunchClient("mcode"), true);
    assert.equal(isLaunchClient("aider"), true);
    assert.equal(isLaunchClient("copilot"), true);
    assert.equal(isLaunchClient("amp"), true);
    assert.equal(isLaunchClient("zed"), true);
    assert.equal(isLaunchClient("crush"), true);
    assert.equal(isLaunchClient("goose"), true);
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

// Vertex port, phase 1 (decision 1): one optional protocol segment on the pair
// rather than a second pair of helpers, so every existing call site stays as it is.
test("wrapUpstream: protocol segment pins the wire, and round-trips through unwrapUpstream", () => {
    const o = "http://127.0.0.1:8787";
    const vx = "https://aiplatform.googleapis.com/v1";
    assert.equal(wrapUpstream(o, vx, "anthropic"), `${o}/bili/anthropic/${vx}`);
    assert.equal(unwrapUpstream(`${o}/bili/anthropic/${vx}`), vx);
    // No segment: byte-identical to the previous behaviour.
    assert.equal(wrapUpstream(o, "https://api.anthropic.com"), `${o}/bili/https://api.anthropic.com`);
    assert.equal(unwrapUpstream(`${o}/bili/https://api.anthropic.com`), "https://api.anthropic.com");
});

test("unwrapUpstream: strips only the four known protocol segments", () => {
    assert.equal(unwrapUpstream("http://127.0.0.1:8787/bili/google/https://aiplatform.googleapis.com/v1"), "https://aiplatform.googleapis.com/v1");
    // A path that merely begins with a protocol-shaped word survives: an unknown
    // segment is part of the upstream, not a marker.
    assert.equal(unwrapUpstream("http://127.0.0.1:8787/bili/upstream.example/x"), "upstream.example/x");
    assert.equal(unwrapUpstream("http://127.0.0.1:8787/bili/vertex/https://x.example"), "vertex/https://x.example");
});

test("wrapUpstream: protocol form is idempotent on a second wrap", () => {
    const o = "http://127.0.0.1:8787";
    const once = wrapUpstream(o, "https://aiplatform.googleapis.com/v1", "anthropic");
    assert.equal(wrapUpstream(o, once, "anthropic"), once);
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

test("buildClaudeEnv: no HTTPS_PROXY + no NODE_EXTRA_CA_CERTS, preserves baseEnv", () => {
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", [], [], { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x" });
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.HTTP_PROXY, undefined);
    assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
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
    // Ask the OS for a port (listen 0), release it, then verify findFreePort
    // prefers it. A random pick from a fixed range races the OS: on Windows
    // the ephemeral range (49152-65535) covers 50000-50999, so an unrelated
    // outbound connection can occupy the "free" port mid-test.
    const probe = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
        probe.once("error", reject);
        probe.listen(0, LAUNCHER_DEFAULT_HOST, () => {
            const addr = probe.address();
            if (addr && typeof addr === "object") resolve(addr.port);
            else reject(new Error("no port"));
        });
    });
    await new Promise<void>((resolve) => probe.close(() => resolve()));
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
import { piPluginInstalled } from "../src/launcher.ts";

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
    const fakePi = path.join(home, process.platform === "win32" ? "fake-pi.exe" : "fake-pi");
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
            const orig = child.on!.bind(child);
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
    const fetchHealthInfo = async () => ({ ok: true, pid: 42422 });

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
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.deepEqual(clientArgsSeen[0].slice(0, 2), ["-e", distAgent]);

        // installed (settings.json packages already points at this install) → no -e
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: [root] }));
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
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
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.deepEqual(clientArgsSeen[0].slice(0, 2), ["-e", distAgent]);

        // a registry npm:billion-context entry DOES load this package's plugin → no -e
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:billion-context"] }));
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
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
        rmrf(home);
    }
});

test("runLaunch pi #535: refuses launch when http rewrites needed and extension cannot load; no overlay files written", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pirefuse-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevPiDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const piHome = path.join(home, ".pi/agent");
    fs.mkdirSync(piHome, { recursive: true });
    fs.writeFileSync(path.join(piHome, "models.json"), JSON.stringify({ providers: { glm: { baseUrl: "http://127.0.0.1:8199/v1" } } }));

    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "pi.js");
    const distBackup = `${distAgent}.bak-test`;
    const distExisted = fs.existsSync(distAgent);
    if (distExisted) fs.renameSync(distAgent, distBackup);

    const fakePi = path.join(home, process.platform === "win32" ? "fake-pi.exe" : "fake-pi");
    fs.writeFileSync(fakePi, "");
    const prevPiBin = process.env.PI_BIN;
    process.env.PI_BIN = fakePi;
    const prevExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;
    const clientArgsSeen: string[][] = [];
    const spawnImpl: SpawnFn = (cmd, args) => {
        if (cmd === fakePi) {
            clientArgsSeen.push([...args]);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        return makeFakeChild(42422);
    };
    try {
        // no dist file, no installed plugin entry → refuse, and refuse BEFORE
        // spawning anything (no proxy child, no client)
        await assert.rejects(
            runLaunch({ client: "pi", clientArgs: [], overrides: {} }, { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42422 }), spawnImpl, sleep: () => Promise.resolve() }),
            /needs provider URL rewrites but the bili extension cannot load/,
        );
        assert.equal(clientArgsSeen.length, 0);
        // no overlay dir was created for pi anymore (#535)
        assert.equal(fs.existsSync(`${piHome}-bili`), false, "no pi overlay dir");

        // plugin installed in settings.json → extension loadable → launch proceeds
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: [root] }));
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42422 }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].includes("-e"), "installed entry loads the plugin — no -e double load");
        assert.equal(fs.existsSync(`${piHome}-bili`), false, "still no overlay dir");
        assert.deepEqual(exitCalls, [0]);
    } finally {
        process.exit = prevExit;
        if (prevPiBin === undefined) delete process.env.PI_BIN;
        else process.env.PI_BIN = prevPiBin;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevPiDir;
        if (distExisted) fs.renameSync(distBackup, distAgent);
        rmrf(home);
    }
});

test("runLaunch omp #535: refuses launch when http rewrites needed and extension cannot load; no overlay files written", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omprefuse-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevOmpDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    process.env.BILI_CLIENT_BIN = path.join(home, process.platform === "win32" ? "fake-omp.exe" : "fake-omp");
    fs.writeFileSync(process.env.BILI_CLIENT_BIN, "");
    const ompHome = path.join(home, ".omp", "agent");
    fs.mkdirSync(ompHome, { recursive: true });
    fs.writeFileSync(path.join(ompHome, "models.yml"), "providers:\n  glm:\n    baseUrl: http://127.0.0.1:8199/v1\n");

    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "omp.js");
    const distBackup = `${distAgent}.bak-test`;
    const distExisted = fs.existsSync(distAgent);
    if (distExisted) fs.renameSync(distAgent, distBackup);

    const clientArgsSeen: string[][] = [];
    const spawnImpl: SpawnFn = (cmd, args) => {
        if (cmd === process.env.BILI_CLIENT_BIN) {
            clientArgsSeen.push([...args]);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        return makeFakeChild(42422);
    };
    const prevExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;
    try {
        // no dist file, no installed config.yml entry → refuse BEFORE spawning
        // anything (no proxy child, no client)
        await assert.rejects(
            runLaunch({ client: "omp", clientArgs: [], overrides: {} }, { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42422 }), spawnImpl, sleep: () => Promise.resolve() }),
            /omp needs provider URL rewrites but the bili extension cannot load/,
        );
        assert.equal(clientArgsSeen.length, 0);
        assert.equal(fs.existsSync(`${ompHome}-bili`), false, "no omp overlay dir");

        // plugin entry in config.yml (existing file) → extension loadable → launch proceeds
        const otherInstall = path.join(home, "other-install", "dist", "agent", "omp.js");
        fs.mkdirSync(path.dirname(otherInstall), { recursive: true });
        fs.writeFileSync(otherInstall, "");
        fs.writeFileSync(path.join(ompHome, "config.yml"), `extensions:\n  - ${otherInstall}\n`);
        await runLaunch(
            { client: "omp", clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42422 }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].includes("-e"), "installed entry loads the plugin — no -e double load");
        assert.equal(fs.existsSync(`${ompHome}-bili`), false, "still no overlay dir");
        assert.deepEqual(exitCalls, [0]);
    } finally {
        process.exit = prevExit;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevOmpDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevOmpDir;
        if (distExisted) fs.renameSync(distBackup, distAgent);
        rmrf(home);
    }
});

test("runLaunch hermes #535: proxy env routing, no HERMES_HOME overlay, real config untouched", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-hermesenv-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevHermesHome = process.env.HERMES_HOME;
    const prevHttpsProxy = process.env.HTTPS_PROXY;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.HTTPS_PROXY;
    const fakeHermes = path.join(home, process.platform === "win32" ? "fake-hermes.exe" : "fake-hermes");
    fs.writeFileSync(fakeHermes, "");
    process.env.BILI_CLIENT_BIN = fakeHermes;
    const hermesHome = path.join(home, ".hermes");
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(
        path.join(hermesHome, "config.yaml"),
        "providers:\n  sglang:\n    api: http://127.0.0.1:8199/v1\n",
    );
    // Custom real home: a user-set HERMES_HOME points at their actual hermes
    // install (discovery resolved the same path) and must survive to the child.
    process.env.HERMES_HOME = hermesHome;
    const configStat = fs.statSync(path.join(hermesHome, "config.yaml"));

    let childEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnFn = (cmd, _args, options) => {
        if (cmd === fakeHermes) {
            childEnv = options.env;
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
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
            { client: "hermes", clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42422 }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.deepEqual(exitCalls, [0]);
        assert.ok(childEnv, "client spawned");
        assert.match(childEnv!.HTTPS_PROXY ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.ok(childEnv!.HERMES_CA_BUNDLE, "CA bundle exported");
        assert.ok(
            String(childEnv!.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")),
            "combined CA bundle exported (#1375)",
        );
        assert.equal(childEnv!.HERMES_HOME, hermesHome, "user-set real home survives to the child");
        assert.equal(fs.existsSync(`${hermesHome}-bili`), false, "no hermes overlay dir");
        const after = fs.statSync(path.join(hermesHome, "config.yaml"));
        assert.equal(after.mtimeMs, configStat.mtimeMs, "real config.yaml untouched");
    } finally {
        process.exit = prevExit;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (prevHermesHome === undefined) delete process.env.HERMES_HOME;
        else process.env.HERMES_HOME = prevHermesHome;
        if (prevHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = prevHttpsProxy;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(home);
    }
});
test("runLaunch pi #535: refuses launch when ONLY https (hand-wrapped) rewrites needed and extension cannot load", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pirefuse2-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevPiDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const piHome = path.join(home, ".pi/agent");
    fs.mkdirSync(piHome, { recursive: true });
    // README Option 2: baseUrl already hand-wrapped to a stale origin — without
    // the manifest repin it would point at a dead embedded proxy origin.
    fs.writeFileSync(
        path.join(piHome, "models.json"),
        JSON.stringify({ providers: { openai: { baseUrl: "http://127.0.0.1:8787/bili/https://api.openai.com/v1" } } }),
    );

    const root = selfPackageRoot();
    const distAgent = path.join(root, "dist", "agent", "pi.js");
    const distBackup = `${distAgent}.bak-test`;
    const distExisted = fs.existsSync(distAgent);
    if (distExisted) fs.renameSync(distAgent, distBackup);

    const spawnImpl: SpawnFn = () => makeFakeChild(42422);
    try {
        await assert.rejects(
            runLaunch({ client: "pi", clientArgs: [], overrides: {} }, { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42422 }), spawnImpl, sleep: () => Promise.resolve() }),
            /needs provider URL rewrites but the bili extension cannot load/,
        );
    } finally {
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevPiDir;
        if (distExisted) fs.renameSync(distBackup, distAgent);
        rmrf(home);
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
    const fakeOmp = path.join(home, process.platform === "win32" ? "fake-omp.exe" : "fake-omp");
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
            const orig = child.on!.bind(child);
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
    const fetchHealthInfo = async () => ({ ok: true, pid: 42422 });

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
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
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
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].includes("-e"));

        // stale entry (file gone) → omp would fail to load it; -e injected again
        rmrf(path.dirname(otherInstall));
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "omp", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo, spawnImpl, sleep: () => Promise.resolve() },
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
        rmrf(home);
    }
});

test("piPluginInstalled: dead bili-shaped entries do not count as installed (#1318)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-piinst-"));
    try {
        const piHome = path.join(home, ".pi", "agent");
        fs.mkdirSync(piHome, { recursive: true });
        assert.equal(piPluginInstalled(piHome), false); // no settings.json
        // A bili-shaped entry pointing at a path that does not exist (hand-edited
        // settings, moved install, another machine's path) must NOT suppress the
        // launcher's -e fallback — that left pi with no plugin at all: no /acp,
        // no provider rewrites, traffic silently bypassing the proxy.
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["/u/node_modules/billion-context/dist/agent/pi.js"] }));
        assert.equal(piPluginInstalled(piHome), false); // dead target
        // npm: entries are pi-managed and count without a local file check
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: ["npm:billion-context"] }));
        assert.equal(piPluginInstalled(piHome), true);
        // A live absolute entry counts
        const live = path.join(home, "node_modules", "billion-context");
        fs.mkdirSync(live, { recursive: true });
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: [live] }));
        assert.equal(piPluginInstalled(piHome), true);
        // Foreign entries never count
        fs.writeFileSync(path.join(piHome, "settings.json"), JSON.stringify({ packages: [path.join(home, "some-other-pkg")] }));
        assert.equal(piPluginInstalled(piHome), false);
    } finally {
        rmrf(home);
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
    } finally {
        rmrf(home);
    }
});


// #1753 (shutdown side): the wrapper's exit must not kill a shared instance.
test("stopProxyGuarded: spares a spawned instance that other watchers still share (#1753)", async () => {
    if (process.platform === "win32") return; // guard defers to the server-side watchdog on win32; POSIX decision tree pinned here
    let killed = false;
    const child = makeFakeChild(42470);
    child.kill = () => { killed = true; return true; };
    let healthCalls = 0;
    await stopProxyGuarded({ origin: "http://127.0.0.1:18787", port: 18787, child }, async () => {
        healthCalls++;
        return { ok: true, watchdog: { armed: true, watchers: [process.pid, 42500] } };
    });
    assert.equal(healthCalls, 1, "guard consults /__bili/health exactly once");
    assert.equal(killed, false, "instance with other live watchers must be spared");
});

test("stopProxyGuarded: kills when the wrapper is the last watcher (#1753)", async () => {
    if (process.platform === "win32") return;
    let killed = false;
    const child = makeFakeChild(42471);
    child.kill = () => { killed = true; return true; };
    await stopProxyGuarded({ origin: "http://127.0.0.1:18787", port: 18787, child }, async () => ({
        ok: true,
        watchdog: { armed: true, watchers: [process.pid] },
    }));
    assert.equal(killed, true, "solo owner still owns the shutdown");
});

test("stopProxyGuarded: health parse failure degrades to the old kill behavior (#1753)", async () => {
    if (process.platform === "win32") return;
    let killed = false;
    const child = makeFakeChild(42472);
    child.kill = () => { killed = true; return true; };
    await stopProxyGuarded({ origin: "http://127.0.0.1:18787", port: 18787, child }, async () => undefined);
    assert.equal(killed, true, "unverifiable lifecycle → take it down, nothing else claims it");
});

test("stopProxyGuarded: unarmed watchdog without watchers still kills (#1753)", async () => {
    if (process.platform === "win32") return;
    let killed = false;
    const child = makeFakeChild(42473);
    child.kill = () => { killed = true; return true; };
    await stopProxyGuarded({ origin: "http://127.0.0.1:18787", port: 18787, child }, async () => ({
        ok: true,
        watchdog: { armed: true },
    }));
    assert.equal(killed, true, "absent watchers list → nobody else to spare it for");
});

test("stopProxyGuarded: attached handles never consult or kill (#1753)", async () => {
    let killed = false;
    let healthCalls = 0;
    const child = makeFakeChild(42474);
    child.kill = () => { killed = true; return true; };
    await stopProxyGuarded({ origin: "http://127.0.0.1:18787", port: 18787, attached: true, child }, async () => {
        healthCalls++;
        return { ok: true, watchdog: { armed: true, watchers: [process.pid, 42500] } };
    });
    assert.equal(healthCalls, 0);
    assert.equal(killed, false);
});

test("runLaunch: client exit spares the shared proxy when other watchers remain (#1753)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-spare-"));
    const fakeBin = path.join(home, process.platform === "win32" ? "fake-pi.exe" : "fake-pi");
    fs.writeFileSync(fakeBin, "");
    let proxyKilled = false;
    const spawnImpl: SpawnFn = (cmd, _args, options) => {
        if (cmd === fakeBin) {
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        const child = makeFakeChild(42480);
        child.kill = () => { proxyKilled = true; return true; };
        return child;
    };
    const prevHome = process.env.HOME;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevExit = process.exit;
    process.env.HOME = home;
    process.env.BILI_CLIENT_BIN = fakeBin;
    process.exit = (() => undefined) as typeof process.exit;
    try {
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 42480, watchdog: { armed: true, watchers: [process.pid, 42500] } }),
                spawnImpl,
                sleep: () => Promise.resolve(),
            },
        );
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        rmrf(home);
    }
    assert.equal(proxyKilled, false, "runLaunch exit must spare the instance other sessions are watching");
});

// #1753: spawn-wait fallback stubs identify as the most recently faked child.
let lastFakeChildPid: number | undefined;
function makeFakeChild(pid: number): SpawnChild {
    lastFakeChildPid = pid;
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

// #679/#1867 test seam: inverse of planClientSpawn's comspec wrapping — splits
// the single `comspec /d /s /c "<line>"` arg back into tokens (quote-aware;
// quoteWinToken only quotes whitespace-bearing tokens, so this round-trips it).
function splitWindowsCommandLine(line: string): string[] {
    const tokens: string[] = [];
    let cur = "";
    let quoted = false;
    for (const ch of line) {
        if (ch === '"') {
            quoted = !quoted;
            continue;
        }
        if (!quoted && /\s/.test(ch)) {
            if (cur !== "") tokens.push(cur);
            cur = "";
            continue;
        }
        cur += ch;
    }
    if (cur !== "") tokens.push(cur);
    return tokens;
}

test("ensureProxyRunning: spawns a fresh proxy when no live instance is recorded", async () => {
    let spawnCalls = 0;
    const spawnImpl: SpawnFn = () => {
        spawnCalls++;
        return makeFakeChild(0);
    };
    const fetchImpl = async () => ({ ok: true });
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: 0 }), spawnImpl, readInstanceFile: () => undefined },
    );
    assert.equal(spawnCalls, 1);
    assert.ok(handle.child);
    assert.equal(handle.origin, `http://127.0.0.1:${handle.port}`);
    assert.notEqual(handle.child, null);
});

test("ensureProxyRunning: spawns when not healthy, polls until healthy", async () => {
    let probes = 0;
    let healthProbes = 0;
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
        { fetchImpl, fetchHealthInfo: async () => ({ ok: ++healthProbes >= 2, pid: 42421 }), spawnImpl, sleep: () => Promise.resolve(), readInstanceFile: () => undefined },
    );
    assert.equal(handle.child?.pid, 42421);
    assert.ok(spawnedArgs !== null);
    assert.ok((spawnedArgs as string[]).includes("start"));
    assert.ok((spawnedArgs as string[]).includes("--host"));
    const portIdx = (spawnedArgs as string[]).indexOf("--port");
    assert.ok(portIdx >= 0, "spawn args include --port");
    assert.equal(spawnedArgs[portIdx + 1], String(handle.port));
    assert.ok(healthProbes >= 2, "fallback polls health until the child answers");
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
            { fetchImpl, fetchHealthInfo: async () => ({ ok: false }), spawnImpl, now, sleep, readInstanceFile: () => undefined },
        ),
        /did not become healthy/,
    );
});

test("ensureProxyRunning: registers a child 'error' handler so an async spawn failure rejects cleanly (#809/D)", async () => {
    const subscribed: string[] = [];
    const child: SpawnChild = {
        pid: 42420,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            subscribed.push(event);
            if (event === "error") setImmediate(() => listener(new Error("spawn /bad/node EACCES")));
        },
    };
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8791, passthrough: false, debug: false },
            {
                spawnImpl: () => child,
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                readInstanceFile: () => undefined,
                sleep: () => new Promise((r) => setTimeout(r, 0)),
            },
        ),
        /spawn failed/,
    );
    assert.ok(subscribed.includes("exit"));
    assert.ok(subscribed.includes("error"), "an 'error' handler was registered on the spawned proxy child");
});

// #1225: the attaching side hashes the script it WOULD spawn; the fake
// instance records the hash of this fixture so matching attach tests line up.
const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

function recordedInstance(over: Partial<InstanceFile> = {}): InstanceFile {
    return {
        origin: "http://127.0.0.1:8787",
        instanceId: "inst-1",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port: 8787,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH,
        ...over,
    };
}

// #1903: post-exit re-discovery. A spawned child dying before healthy PROVES
// the port it wanted is held; when the holder's identity record published
// AFTER our one-shot discovery snapshot (manual `bili start`: TCP accept
// precedes the 'listening' callback that writes proxy-origin), the launcher
// must attach on a bounded retry instead of failing from a stale view — and
// throw the original error when nothing republishes within the budget.
function makeFastExitChild(code: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid: 42423,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
            // synchronous emit: the death lands before the spawn poll loop's
            // first tick, so the failure path is reached without burning SPAWN_WAIT_MS
            if (event === "exit") listener(code, null);
        },
    };
}

test("ensureProxyRunning: attaches a late-publishing instance after the spawned child dies (#1903)", async () => {
    const PORT = 38991;
    const late = recordedInstance({ origin: `http://127.0.0.1:${PORT}`, port: PORT });
    let reads = 0;
    const registrations: Array<[string, number]> = [];
    let t = 0;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: PORT, passthrough: false, debug: false, strictPort: true, lane: "claude" },
        {
            spawnImpl: () => makeFastExitChild(1),
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) => origin === late.origin ? { ok: true, instanceId: late.instanceId, pid: late.pid } : undefined,
            readInstanceFile: () => (++reads > 1 ? late : undefined),
            now: () => t,
            sleep: async (ms) => { t += ms; },
            registerWatcher: async (origin, pid) => { registrations.push([origin, pid]); return "refused"; },
            attachDiag: () => {},
            scriptPath: FP_SCRIPT,
            // #2877: this scenario is a lane-less (manual) daemon being ridden by a
            // LANEd launch — the pre-#2877 cross-zone fallback. Pin it to the
            // legacy policy so it keeps exercising the post-exit re-discovery
            // mechanism (its actual subject) rather than the new own-lane default.
            resolveAttachPolicy: () => "global-fallback",
        },
    );
    assert.equal(handle.attached, true, "attached to the late publisher instead of failing");
    assert.equal(handle.origin, late.origin);
    assert.equal(handle.refusedWatcher, true, "manual daemon refuses watchers — #1322 flag carried through the retry path");
    assert.deepEqual(registrations, [[late.origin, process.pid]]);
    assert.equal(reads, 2, "initial snapshot missed it; the FIRST re-discovery tick caught it");
});

test("ensureProxyRunning: throws the original child-death error when nothing republishes within the budget (#1903)", async () => {
    let reads = 0;
    let t = 0;
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 38992, passthrough: false, debug: false, strictPort: true, lane: "claude" },
            {
                spawnImpl: () => makeFastExitChild(1),
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                readInstanceFile: () => { reads++; return undefined; },
                now: () => t,
                sleep: async (ms) => { t += ms; },
                registerWatcher: async () => "failed",
                attachDiag: () => {},
                scriptPath: FP_SCRIPT,
            },
        ),
        /exited before becoming healthy \(code 1\)/,
    );
    // exactly one initial discovery + POST_EXIT_REDISCOVERY_MS / HEALTH_POLL_INTERVAL_MS
    // re-discovery ticks — the budget is bounded and honored under the injected clock
    assert.equal(reads, 1 + Math.round(3000 / 200));
});

test("ensureProxyRunning: attaches to a compatible healthy instance instead of doubling (#394)", async () => {
    let spawnCalls = 0;
    const registrations: Array<[string, number]> = [];
    const spawnImpl: SpawnFn = () => {
        spawnCalls++;
        return makeFakeChild(42431);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            spawnImpl,
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
            readInstanceFile: () => recordedInstance(),
            registerWatcher: async (origin, pid) => { registrations.push([origin, pid]); return "ok"; },
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 0);
    assert.equal(handle.attached, true);
    assert.equal(handle.origin, "http://127.0.0.1:8787");
    // #1190: the attaching caller registers ITS owner pid with the shared
    // proxy so the first owner's exit cannot kill this session too.
    assert.deepEqual(registrations, [["http://127.0.0.1:8787", process.pid]]);
    let killed = false;
    stopProxy({ ...handle, child: { pid: 77777, kill: () => { killed = true; return true; } } });
    assert.equal(killed, false);
});

test("ensureProxyRunning: attach registers opts.parentPid when given, never on spawn (#1190)", async () => {
    const registrations: Array<[string, number]> = [];
    const registerWatcher = async (origin: string, pid: number): Promise<"ok" | "refused" | "failed"> => { registrations.push([origin, pid]); return "ok"; };

    const attached = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, parentPid: 42424 },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
            readInstanceFile: () => recordedInstance(),
            registerWatcher,
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(attached.attached, true);
    assert.deepEqual(registrations, [["http://127.0.0.1:8787", 42424]], "attach registers the explicit owner pid");

    registrations.length = 0;
    let spawned = false;
    const spawnedHandle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            fetchImpl: async () => ({ ok: true }),
            readInstanceFile: () => undefined,
            registerWatcher,
            scriptPath: FP_SCRIPT,
            spawnImpl: () => { spawned = true; return makeFakeChild(42432); },
            fetchHealthInfo: async () => ({ ok: true, pid: 42432 }),
            sleep: () => Promise.resolve(),
        },
    );
    assert.equal(spawned, true);
    assert.equal(spawnedHandle.attached, undefined);
    assert.deepEqual(registrations, [], "spawn must not register (BILI_PARENT_PID already arms the watchdog)");
});

// #1335: an unarmed listener is never attached by default, so the post-attach
// 409 path (#1322) is now reached through the escape hatch — pin it there.
test("ensureProxyRunning: refused watcher registration flags the handle for host-native surfacing (#1322/#1335)", async () => {
    const refused = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, parentPid: 42424 },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1" }),
            readInstanceFile: () => recordedInstance(),
            registerWatcher: async () => "refused",
            resolveAttachExternal: () => true,
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(refused.attached, true, "opt-in attach still succeeds on a daemon proxy");
    assert.equal(refused.refusedWatcher, true, "refusal is flagged so claude-native can warn the operator");

    const ok = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, parentPid: 42424 },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1" }),
            readInstanceFile: () => recordedInstance(),
            registerWatcher: async () => "ok",
            resolveAttachExternal: () => true,
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(ok.attached, true);
    assert.notEqual(ok.refusedWatcher, true, "a successful registration leaves the flag unset");
});

test("ensureProxyRunning: same lane attaches, different declared lanes spawn separate proxies (#1225)", async () => {
    let spawnCalls = 0;
    let lastSpawnEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnFn = (_cmd, _args, options) => {
        spawnCalls++;
        lastSpawnEnv = options.env ?? {};
        return makeFakeChild(42460);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
        {
            spawnImpl,
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
            readInstanceFile: () => recordedInstance({ lane: "pi" }),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 0);
    assert.equal(handle.attached, true);

    let reads = 0;
    const other = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "codex" },
        {
            spawnImpl,
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42460 }),
            readInstanceFile: () => (reads++ === 0 ? recordedInstance({ lane: "pi" }) : undefined),
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 1);
    assert.equal(other.attached, undefined);
    assert.equal(lastSpawnEnv?.BILI_LAUNCHER_LANE, "codex");
});

test("ensureProxyRunning: armed daemon (no lane) stays shareable with any client lane (#1225)", async () => {
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
        {
            spawnImpl: () => makeFakeChild(42463),
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
            readInstanceFile: () => recordedInstance(),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(handle.attached, true);
});

// #1335: the attach gate — an unarmed listener is never attached by
// default; the hook spawns its own session-owned proxy so every session runs
// the currently installed bili and the proxy dies with the last session
// (#1186 semantics). #1660 narrows the gate to LANE'D instances: a lane'd
// proxy with a dead/unarmed watchdog is a lifecycle-drift symptom and is
// refused; a USER-ZONE instance (manual `bili start`: no lane, no launch
// token) is deliberately maintained by the user and IS attachable — see the
// dedicated user-zone test below.
test("ensureProxyRunning: unarmed LANE'D listener is not attached by default — self-managed spawn (#1335/#1660)", async () => {
    let spawnCalls = 0;
    let registered = 0;
    let childToken = "";
    let spawned = false;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "claude-native" },
        {
            spawnImpl: (_cmd, _args, options) => {
                spawned = true;
                childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
                spawnCalls++;
                return makeFakeChild(42501);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "daemon-1", watchdog: { armed: false } }),
            readInstanceFile: () => (spawned ? recordedInstance({ launchToken: childToken }) : recordedInstance({ instanceId: "daemon-1", lane: "claude-native" })),
            registerWatcher: async () => {
                registered++;
                return "refused";
            },
            sleep: () => new Promise((r) => setTimeout(r, 0)),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 1, "self-managed proxy spawned instead of attaching to the unarmed lane'd daemon");
    assert.ok(handle.child);
    assert.equal(handle.attached, undefined);
    assert.equal(registered, 0, "no watcher registration is attempted against the refused daemon");
});

// #2877 flipped the default: an unarmed USER-ZONE daemon (manual `bili start`,
// no lane) is no longer ridden by a LANEd launch — every agent converging on one
// manual proxy was the bug (#2877). The hook now spawns its own session proxy.
test("ensureProxyRunning: unarmed USER-ZONE daemon (manual `bili start`) is NOT ridden by default — spawns its own (#2877)", async () => {
    let spawnCalls = 0;
    let childToken = "";
    let spawned = false;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
        {
            spawnImpl: (_cmd, _args, options) => {
                spawned = true;
                childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
                spawnCalls++;
                return makeFakeChild(42505);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "manual-1", watchdog: { armed: false } }),
            readInstanceFile: () => (spawned ? recordedInstance({ launchToken: childToken }) : recordedInstance({ instanceId: "manual-1" })),
            registerWatcher: async () => "ok",
            sleep: () => new Promise((r) => setTimeout(r, 0)),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 1, "the manual user-zone daemon is no longer ridden by default (#2877)");
    assert.ok(handle.child);
    assert.equal(handle.attached, undefined);
});

// The pre-#2877 behavior (ride the user-maintained daemon) is preserved behind
// the explicit legacy policy (#1660).
test("ensureProxyRunning: unarmed USER-ZONE daemon (manual `bili start`) is attached when attachPolicy=global-fallback (#1660/#2877)", async () => {
    let spawnCalls = 0;
    let registered = 0;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
        {
            spawnImpl: () => {
                spawnCalls++;
                return makeFakeChild(42506);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "manual-1", watchdog: { armed: false } }),
            readInstanceFile: () => recordedInstance({ instanceId: "manual-1" }),
            registerWatcher: async () => {
                registered++;
                return "ok";
            },
            sleep: () => new Promise((r) => setTimeout(r, 0)),
            scriptPath: FP_SCRIPT,
            resolveAttachPolicy: () => "global-fallback",
        },
    );
    assert.equal(spawnCalls, 0, "the user-maintained daemon is reused, not doubled");
    assert.equal(handle.attached, true);
    assert.equal(registered, 1);
});

test("ensureProxyRunning: a lane'd launch with port 0 binds the zone preference and settles it sticky (#1660)", async () => {
    let spawnedArgs: string[] | null = null;
    const preferred: string[] = [];
    const settled: Array<[string, number]> = [];
    const spawnImpl: SpawnFn = (_cmd, args) => {
        spawnedArgs = [...args];
        return makeFakeChild(42441);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "zcode" },
        {
            fetchImpl: async () => ({ ok: true }),
            spawnImpl,
            fetchHealthInfo: async () => ({ ok: true, pid: 42441 }),
            sleep: () => Promise.resolve(),
            readInstanceFile: () => undefined,
            zonePreferredPort: (lane) => {
                preferred.push(lane);
                return 18787;
            },
            writeZonePort: (lane, port) => {
                settled.push([lane, port]);
            },
        },
    );
    assert.deepEqual(preferred, ["zcode"], "the lane's zone preference resolves the spawn port");
    assert.ok(spawnedArgs !== null);
    const portIdx = (spawnedArgs as string[]).indexOf("--port");
    assert.equal(spawnedArgs[portIdx + 1], "18787", "zone base is the spawn port, not an OS ephemeral");
    assert.equal(handle.port, 18787);
    assert.deepEqual(settled, [["zcode", 18787]], "the settled port is recorded sticky for later launches");
});

test("ensureProxyRunning: an unlane'd launch keeps the OS ephemeral default — no zone, no sticky (#1660)", async () => {
    let spawnedArgs: string[] | null = null;
    const settled: Array<[string, number]> = [];
    const spawnImpl: SpawnFn = (_cmd, args) => {
        spawnedArgs = [...args];
        return makeFakeChild(42442);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, pid: 42442 }),
            spawnImpl,
            sleep: () => Promise.resolve(),
            readInstanceFile: () => undefined,
            writeZonePort: (lane, port) => {
                settled.push([lane, port]);
            },
        },
    );
    assert.ok(spawnedArgs !== null);
    const portIdx = (spawnedArgs as string[]).indexOf("--port");
    const childPort = Number(spawnedArgs[portIdx + 1]);
    assert.ok(Number.isInteger(childPort) && childPort > 0, `ephemeral port assigned, got ${childPort}`);
    assert.equal(handle.port, childPort);
    assert.deepEqual(settled, [], "no sticky write without a lane");
});

test("ensureProxyRunning: unverifiable lane'd listener (no watchdog field, pre-#1330 build) is treated as unarmed (#1335)", async () => {
    let spawnCalls = 0;
    let childToken = "";
    let spawned = false;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            spawnImpl: (_cmd, _args, options) => {
                spawned = true;
                childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
                spawnCalls++;
                return makeFakeChild(42502);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "stale-daemon" }),
            readInstanceFile: () => (spawned ? recordedInstance({ launchToken: childToken }) : recordedInstance({ instanceId: "stale-daemon", lane: "zcode" })),
            sleep: () => new Promise((r) => setTimeout(r, 0)),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 1, "missing watchdog field = unverifiable lifecycle = refused by default");
    assert.ok(handle.child);
});

test("ensureProxyRunning: attachExternal escape hatch restores attaching to an unarmed listener (#1335)", async () => {
    let spawnCalls = 0;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
        {
            spawnImpl: () => {
                spawnCalls++;
                return makeFakeChild(42503);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "daemon-1", watchdog: { armed: false } }),
            readInstanceFile: () => recordedInstance({ instanceId: "daemon-1" }),
            registerWatcher: async () => "ok",
            resolveAttachExternal: () => true,
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 0);
    assert.equal(handle.attached, true, "deliberate setups keep the old behavior via the opt-in");
});

test("ensureProxyRunning: strictPort launch fails fast when its pinned port is held by an unarmed LANE'D proxy (#1335/#964/#1660)", async () => {
    let spawnCalls = 0;
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8799, passthrough: false, debug: false, lane: "claude-native", strictPort: true },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42504);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "daemon-1", watchdog: { armed: false } }),
                readInstanceFile: () => recordedInstance({ origin: "http://127.0.0.1:8799", port: 8799, instanceId: "daemon-1", lane: "claude-native" }),
                sleep: () => Promise.resolve(),
                scriptPath: FP_SCRIPT,
            },
        ),
        /lifecycle-less bili proxy/,
    );
    assert.equal(spawnCalls, 0, "fail fast instead of burning the wait window into a confusing EADDRINUSE");
});

test("ensureProxyRunning: stale code (fingerprint mismatch) is not attached — rebuild takes effect (#1225)", async () => {
    let spawnCalls = 0;
    let reads = 0;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            spawnImpl: () => {
                spawnCalls++;
                return makeFakeChild(42461);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42461 }),
            readInstanceFile: () => (reads++ === 0 ? recordedInstance({ codeFingerprint: "stale-dist-hash" }) : undefined),
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 1);
    assert.equal(handle.attached, undefined);
});

test("ensureProxyRunning: pre-#1225 instance without codeFingerprint is never attached (#1225)", async () => {
    let spawnCalls = 0;
    let reads = 0;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            spawnImpl: () => {
                spawnCalls++;
                return makeFakeChild(42464);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42464 }),
            readInstanceFile: () => (reads++ === 0 ? recordedInstance({ codeFingerprint: undefined }) : undefined),
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnCalls, 1);
    assert.equal(handle.attached, undefined);
});

// #1232: with per-lane proxies the single proxy-origin file is last-writer-
// wins and can point at ANOTHER client's proxy. Attach discovery must scan
// every live registry entry. These tests seed real markers under an isolated
// state dir (the module-level XDG_STATE_HOME is shared across this file).
function isoStateDir(): { restore: () => void } {
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bili-iso-state-"));
    return {
        restore: () => {
            if (prev === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prev;
        },
    };
}

function liveRegistryInstance(over: Partial<InstanceFile>): InstanceFile {
    return recordedInstance({ pid: process.pid, ...over });
}

test("ensureProxyRunning: reattaches to own-lane instance when the instance file points at another client's proxy (#1232)", async () => {
    const st = isoStateDir();
    try {
        const A = liveRegistryInstance({ instanceId: "inst-A", origin: "http://127.0.0.1:8801", port: 8801, lane: "pi", startedAt: Date.now() - 60_000 });
        const B = liveRegistryInstance({ instanceId: "inst-B", origin: "http://127.0.0.1:8802", port: 8802, lane: "codex", startedAt: Date.now() });
        registerInstanceAndWarn(A, () => {});
        registerInstanceAndWarn(B, () => {});
        let spawnCalls = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42470);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) => ({ ok: true, instanceId: origin.endsWith("8801") ? "inst-A" : "inst-B", watchdog: { armed: true } }),
                readInstanceFile: () => B,
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 0, "must attach, not spawn a third proxy");
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, A.origin, "attach to the pi-lane instance, not the codex one the file pointed at");
    } finally {
        unregisterInstance("inst-A");
        unregisterInstance("inst-B");
        st.restore();
    }
});

test("ensureProxyRunning: same-lane instance wins over a newer wildcard daemon found via the registry (#1232)", async () => {
    const st = isoStateDir();
    try {
        const W = liveRegistryInstance({ instanceId: "inst-W", origin: "http://127.0.0.1:8803", port: 8803, startedAt: Date.now() });
        const A = liveRegistryInstance({ instanceId: "inst-A2", origin: "http://127.0.0.1:8804", port: 8804, lane: "pi", startedAt: Date.now() - 60_000 });
        registerInstanceAndWarn(W, () => {});
        registerInstanceAndWarn(A, () => {});
        let spawnCalls = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42471);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) => ({ ok: true, instanceId: origin.endsWith("8803") ? "inst-W" : "inst-A2", watchdog: { armed: true } }),
                readInstanceFile: () => W,
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 0);
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, A.origin, "same declared lane beats a wildcard even when the wildcard is newer");
    } finally {
        unregisterInstance("inst-W");
        unregisterInstance("inst-A2");
        st.restore();
    }
});

test("ensureProxyRunning: stale instance file still finds a live wildcard daemon via the registry (#1232)", async () => {
    const st = isoStateDir();
    try {
        const W = liveRegistryInstance({ instanceId: "inst-W3", origin: "http://127.0.0.1:8805", port: 8805 });
        registerInstanceAndWarn(W, () => {});
        let spawnCalls = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42472);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) => (origin.endsWith("8805") ? { ok: true, instanceId: "inst-W3", watchdog: { armed: true } } : undefined),
                readInstanceFile: () => recordedInstance({ instanceId: "inst-dead", origin: "http://127.0.0.1:8806", port: 8806, pid: 4_000_000 }),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 0, "registry discovery must recover the live daemon instead of doubling it");
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, W.origin);
    } finally {
        unregisterInstance("inst-W3");
        st.restore();
    }
});

// #2905: native.attachLanePriority lets an operator list FOREIGN lanes a hook may ride
// when no own-lane instance exists. Own lane always first; the user zone (manual
// `bili start`, the 8787 global) ALWAYS last; unlisted lanes stay non-attachable.
test("ensureProxyRunning: a listed foreign lane becomes attachable via attachLanePriority (#2905)", async () => {
    const st = isoStateDir();
    try {
        const D = liveRegistryInstance({ instanceId: "inst-D", origin: "http://127.0.0.1:8811", port: 8811, lane: "dsh", startedAt: Date.now() });
        registerInstanceAndWarn(D, () => {});
        let spawnCalls = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42480);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-D", watchdog: { armed: true } }),
                // the bug shape: the last-writer file points at ANOTHER lane's proxy
                readInstanceFile: () => D,
                attachLanePriority: () => ["dsh"],
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 0, "the listed foreign lane is ridden instead of spawning a third proxy");
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, D.origin);
    } finally {
        unregisterInstance("inst-D");
        st.restore();
    }
});

test("ensureProxyRunning: among listed foreign lanes, list position beats recency (#2905)", async () => {
    const st = isoStateDir();
    try {
        const O = liveRegistryInstance({ instanceId: "inst-O", origin: "http://127.0.0.1:8812", port: 8812, lane: "opencode", startedAt: Date.now() });
        const D = liveRegistryInstance({ instanceId: "inst-D2", origin: "http://127.0.0.1:8813", port: 8813, lane: "dsh", startedAt: Date.now() - 60_000 });
        registerInstanceAndWarn(O, () => {});
        registerInstanceAndWarn(D, () => {});
        let spawnCalls = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42481);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) => ({ ok: true, instanceId: origin.endsWith("8812") ? "inst-O" : "inst-D2", watchdog: { armed: true } }),
                readInstanceFile: () => O,
                attachLanePriority: () => ["dsh", "opencode"],
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 0);
        assert.equal(handle.origin, D.origin, "earlier list position beats a newer later entry");
    } finally {
        unregisterInstance("inst-O");
        unregisterInstance("inst-D2");
        st.restore();
    }
});

test("ensureProxyRunning: an UNLISTED foreign lane stays refused; the user zone remains the last-resort fallback (#2905)", async () => {
    const st = isoStateDir();
    try {
        const D = liveRegistryInstance({ instanceId: "inst-D3", origin: "http://127.0.0.1:8814", port: 8814, lane: "dsh", startedAt: Date.now() - 60_000 });
        const W = liveRegistryInstance({ instanceId: "inst-W2", origin: "http://127.0.0.1:8815", port: 8815, startedAt: Date.now() });
        registerInstanceAndWarn(D, () => {});
        registerInstanceAndWarn(W, () => {});
        let spawnCalls = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42482);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) => ({ ok: true, instanceId: origin.endsWith("8814") ? "inst-D3" : "inst-W2", watchdog: { armed: true } }),
                readInstanceFile: () => W,
                attachLanePriority: () => [],
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 0);
        assert.equal(handle.origin, W.origin, "the 8787-style user zone rides LAST — never the unlisted dsh lane");
    } finally {
        unregisterInstance("inst-D3");
        unregisterInstance("inst-W2");
        st.restore();
    }
});

// #964: a strictPort client dials a STATIC url — attaching to a healthy proxy
// on a DIFFERENT port would strand every request. The starter-wait path must
// apply the same port rule as the fast path; before pickAttachable it only
// checked config shape and attached to whatever the starter produced.
test("ensureProxyRunning: strictPort launcher refuses a different-port starter's proxy during the wait (#964/#1232)", async () => {
    const st = isoStateDir();
    try {
        claimStartingMarker({ token: "starter-strict", pid: process.pid, host: "127.0.0.1", port: 8807, startedAt: Date.now() });
        let spawnCalls = 0;
        let spawned = false;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8808, passthrough: false, debug: false, lane: "pi", strictPort: true },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    spawned = true;
                    return makeFakeChild(42473);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) =>
                    origin.endsWith("8807") ? { ok: true, instanceId: "inst-wait" } : origin.endsWith("8808") ? { ok: true, pid: 42473 } : undefined,
                // Before spawn: the starter's proxy is up on ANOTHER port. After
                // spawn: a dead-owner record so the readback falls back to the
                // preferred-origin health probe.
                readInstanceFile: () =>
                    spawned
                        ? recordedInstance({ instanceId: "inst-stale", origin: "http://127.0.0.1:8808", port: 8808, pid: 4_000_000 })
                        : recordedInstance({ instanceId: "inst-wait", origin: "http://127.0.0.1:8807", port: 8807 }),
                sleep: () => {
                    removeStartingMarker();
                    return new Promise<void>((r) => setTimeout(r, 200));
                },
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 1, "strictPort must not attach to a different-port proxy found while waiting");
        assert.equal(handle.attached, undefined);
        assert.ok(handle.child);
        assert.equal(handle.origin, "http://127.0.0.1:8808");
    } finally {
        removeStartingMarker();
        st.restore();
    }
});

// #2177: an explicit ACP_PORT/--port must pin the launch to exactly that port.
// Before the fix runLaunch/runTestPi omitted strictPort, so pickAttachable could
// attach to a compatible proxy on ANY other port — a resident `bili start` is
// exactly such a candidate (wildcard lane + user-zone exempt from the #1335
// gate) — and the spawned child got no BILI_STRICT_PORT either, so an EADDRINUSE
// on the requested port silently hopped +1. Either way the client dialed an
// origin the user did not ask for. port === 0 (omitted) must keep the legacy
// lane-zone/ephemeral selection untouched.
function piLaunchEnv(): { fakePi: string; restore: () => void } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-2177-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevPiBin = process.env.PI_BIN;
    const prevPiDir = process.env.PI_CODING_AGENT_DIR;
    const prevAcPort = process.env.ACP_PORT;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.ACP_PORT;
    const fakePi = path.join(home, process.platform === "win32" ? "fake-pi.exe" : "fake-pi");
    fs.writeFileSync(fakePi, "");
    process.env.PI_BIN = fakePi;
    const piHome = path.join(home, ".pi/agent");
    fs.mkdirSync(piHome, { recursive: true });
    fs.writeFileSync(path.join(piHome, "models.json"), JSON.stringify({ providers: {} }));
    return {
        fakePi,
        restore: () => {
            if (prevHome === undefined) delete process.env.HOME;
            else process.env.HOME = prevHome;
            if (prevUserProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = prevUserProfile;
            if (prevPiBin === undefined) delete process.env.PI_BIN;
            else process.env.PI_BIN = prevPiBin;
            if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = prevPiDir;
            if (prevAcPort === undefined) delete process.env.ACP_PORT;
            else process.env.ACP_PORT = prevAcPort;
        },
    };
}

function stubProcessExit(): { calls: number[]; restore: () => void } {
    const prev = process.exit;
    const calls: number[] = [];
    process.exit = ((code?: number) => {
        calls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;
    return {
        calls,
        restore: () => {
            process.exit = prev;
        },
    };
}

function exitingFakeClient(seen: { proxy?: string }): SpawnFn {
    return (_cmd, _args, options) => {
        seen.proxy = options.env?.HTTPS_PROXY;
        const child = makeFakeChild(0);
        const orig = child.on!.bind(child);
        (child as { on: SpawnChild["on"] }).on = (event, listener) => {
            orig(event, listener);
            if (event === "exit") setTimeout(() => listener(0, null), 0);
            return child;
        };
        return child;
    };
}

test("runLaunch: explicit ACP_PORT refuses a different-port compatible proxy and pins the exact port (#2177)", async () => {
    const env = piLaunchEnv();
    const st = isoStateDir();
    const ex = stubProcessExit();
    try {
        // resident `bili start`: no lane, no launch token → user zone, exempt
        // from the #1335 watchdog gate — the pre-fix attach target.
        const W = liveRegistryInstance({ instanceId: "inst-2177-w", origin: "http://127.0.0.1:18787", port: 18787 });
        registerInstanceAndWarn(W, () => {});
        let spawnCalls = 0;
        let proxyArgs: string[] | undefined;
        let proxyEnv: NodeJS.ProcessEnv | undefined;
        const clientSeen: { proxy?: string } = {};
        const spawnImpl: SpawnFn = (cmd, args, options) => {
            if (cmd === env.fakePi) return exitingFakeClient(clientSeen)(cmd, args, options);
            spawnCalls++;
            proxyArgs = [...args];
            proxyEnv = options.env;
            return makeFakeChild(42501);
        };
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: { ACP_PORT: "8787" } },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) =>
                    origin.endsWith(":18787")
                        ? { ok: true, instanceId: "inst-2177-w", watchdog: { armed: false } }
                        : { ok: true, pid: 42501 },
                spawnImpl,
                sleep: () => Promise.resolve(),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 1, "must NOT attach to the other-port resident daemon");
        assert.equal(proxyEnv?.BILI_STRICT_PORT, "1", "pinned port must be fail-loud in the spawned child");
        const i = (proxyArgs ?? []).indexOf("--port");
        assert.ok(i >= 0 && proxyArgs![i + 1] === "8787", "spawned proxy binds the exact requested port");
        assert.equal(clientSeen.proxy, "http://127.0.0.1:8787", "client dials the requested origin");
        assert.deepEqual(ex.calls, [0]);
    } finally {
        unregisterInstance("inst-2177-w");
        st.restore();
        ex.restore();
        env.restore();
    }
});

test("runLaunch: explicit ACP_PORT still attaches to a compatible proxy already bound to that exact port (#2177)", async () => {
    const env = piLaunchEnv();
    const st = isoStateDir();
    const ex = stubProcessExit();
    try {
        const S = liveRegistryInstance({ instanceId: "inst-2177-s", origin: "http://127.0.0.1:8787", port: 8787, lane: "pi" });
        registerInstanceAndWarn(S, () => {});
        let spawnCalls = 0;
        const clientSeen: { proxy?: string } = {};
        const spawnImpl: SpawnFn = (cmd, args, options) => {
            if (cmd === env.fakePi) return exitingFakeClient(clientSeen)(cmd, args, options);
            spawnCalls++;
            return makeFakeChild(42502);
        };
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: { ACP_PORT: "8787" } },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-2177-s", watchdog: { armed: true } }),
                spawnImpl,
                sleep: () => Promise.resolve(),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 0, "exact-port compatible instance must be attached, not respawned");
        assert.equal(clientSeen.proxy, "http://127.0.0.1:8787");
        assert.deepEqual(ex.calls, [0]);
    } finally {
        unregisterInstance("inst-2177-s");
        st.restore();
        ex.restore();
        env.restore();
    }
});

// #2877: pickAttachable discovery policy. Default "own-lane" rides only a
// same-lane daemon and never falls back to a lane-less / user-zone one;
// "global-fallback" restores the pre-#2877 fallback; an explicit attachUrl
// targets one origin regardless of policy.
test("findLiveAttachableInstance: own-lane (default) does NOT fall back to a lane-less user-zone daemon (#2877)", async () => {
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "pi" },
        {
            fetchHealthInfo: async () => ({ ok: true, watchdog: { armed: false } }),
            readInstanceFile: () => recordedInstance({ origin: "http://127.0.0.1:8787", port: 8787 }),
            resolveAttachPolicy: () => "own-lane",
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(inst, undefined, "lane-less user-zone daemon is not a same-lane match → no fallback");
});

test("findLiveAttachableInstance: global-fallback DOES ride a lane-less user-zone daemon (#2877)", async () => {
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "pi" },
        {
            fetchHealthInfo: async () => ({ ok: true, watchdog: { armed: false } }),
            readInstanceFile: () => recordedInstance({ origin: "http://127.0.0.1:8787", port: 8787 }),
            resolveAttachPolicy: () => "global-fallback",
            scriptPath: FP_SCRIPT,
        },
    );
    assert.ok(inst, "global-fallback restores the pre-#2877 ride");
    assert.equal(inst?.origin, "http://127.0.0.1:8787");
});

test("findLiveAttachableInstance: same-lane daemon still attaches under default own-lane (#2877)", async () => {
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "pi" },
        {
            fetchHealthInfo: async () => ({ ok: true, watchdog: { armed: true } }),
            readInstanceFile: () => recordedInstance({ origin: "http://127.0.0.1:18788", port: 18788, lane: "pi" }),
            resolveAttachPolicy: () => "own-lane",
            scriptPath: FP_SCRIPT,
        },
    );
    assert.ok(inst, "a same-lane armed daemon is always rideable");
    assert.equal(inst?.origin, "http://127.0.0.1:18788");
});

test("findLiveAttachableInstance: explicit attachUrl targets one daemon despite own-lane (#2877)", async () => {
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "pi" },
        {
            fetchHealthInfo: async () => ({ ok: true, watchdog: { armed: false } }),
            readInstanceFile: () => recordedInstance({ origin: "http://127.0.0.1:8787", port: 8787 }),
            resolveAttachPolicy: () => "own-lane",
            // trailing slash exercises normalizeOrigin
            resolveAttachUrl: () => "http://127.0.0.1:8787/",
            scriptPath: FP_SCRIPT,
        },
    );
    assert.ok(inst, "explicit target bypasses the policy filter");
    assert.equal(inst?.origin, "http://127.0.0.1:8787");
});

test("findLiveAttachableInstance: attachUrl pointing elsewhere leaves no candidate (#2877)", async () => {
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "pi" },
        {
            fetchHealthInfo: async () => ({ ok: true, watchdog: { armed: false } }),
            readInstanceFile: () => recordedInstance({ origin: "http://127.0.0.1:8787", port: 8787 }),
            resolveAttachPolicy: () => "own-lane",
            resolveAttachUrl: () => "http://127.0.0.1:9999",
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(inst, undefined, "target mismatch → nothing to attach to");
});

test("runLaunch: omitted ACP_PORT rides a lane-less user-zone daemon only when attachPolicy=global-fallback (#2877)", async () => {
    const env = piLaunchEnv();
    const st = isoStateDir();
    const ex = stubProcessExit();
    try {
        const W = liveRegistryInstance({ instanceId: "inst-2177-w2", origin: "http://127.0.0.1:18787", port: 18787 });
        registerInstanceAndWarn(W, () => {});
        let spawnCalls = 0;
        const clientSeen: { proxy?: string } = {};
        const spawnImpl: SpawnFn = (cmd, args, options) => {
            if (cmd === env.fakePi) return exitingFakeClient(clientSeen)(cmd, args, options);
            spawnCalls++;
            return makeFakeChild(42503);
        };
        await runLaunch(
            { client: "pi", clientArgs: [], overrides: {} },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-2177-w2", watchdog: { armed: false } }),
                spawnImpl,
                sleep: () => Promise.resolve(),
                scriptPath: FP_SCRIPT,
                resolveAttachPolicy: () => "global-fallback",
            },
        );
        assert.equal(spawnCalls, 0, "no explicit port → free to attach to the user-zone daemon (pre-existing behavior)");
        assert.equal(clientSeen.proxy, "http://127.0.0.1:18787");
        assert.deepEqual(ex.calls, [0]);
    } finally {
        unregisterInstance("inst-2177-w2");
        st.restore();
        ex.restore();
        env.restore();
    }
});

test("runTestPi: explicit ACP_PORT pins the spawned proxy to the exact port with BILI_STRICT_PORT (#2177)", async () => {
    const env = piLaunchEnv();
    const ex = stubProcessExit();
    try {
        let spawnCalls = 0;
        let proxyEnv: NodeJS.ProcessEnv | undefined;
        const clientSeen: { proxy?: string } = {};
        const spawnImpl: SpawnFn = (cmd, args, options) => {
            if (cmd === env.fakePi) return exitingFakeClient(clientSeen)(cmd, args, options);
            spawnCalls++;
            proxyEnv = options.env;
            return makeFakeChild(42504);
        };
        await runTestPi(
            { overrides: { ACP_PORT: "8787" } },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 42504 }),
                spawnImpl,
                sleep: () => Promise.resolve(),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawnCalls, 1);
        assert.equal(proxyEnv?.BILI_STRICT_PORT, "1", "pinned port must be fail-loud in the spawned child");
        assert.equal(clientSeen.proxy, "http://127.0.0.1:8787", "client dials the requested origin");
        assert.deepEqual(ex.calls, [0]);
    } finally {
        ex.restore();
        env.restore();
    }
});

test("ensureProxyRunning: active starting marker of a different lane → spawns immediately, does not wait (#1225)", async () => {
    try {
        claimStartingMarker({ token: "starter-lane", pid: process.pid, host: "127.0.0.1", port: 8794, startedAt: Date.now(), lane: "codex" });
        let spawnCalls = 0;
        let spawnedLane: string | undefined;
        let sleeps = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "pi" },
            {
                spawnImpl: (_cmd, _args, options) => {
                    spawnCalls++;
                    spawnedLane = options.env?.BILI_LAUNCHER_LANE;
                    return makeFakeChild(42462);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 42462 }),
                readInstanceFile: () => undefined,
                sleep: () => {
                    sleeps++;
                    return Promise.resolve();
                },
            },
        );
        assert.equal(spawnCalls, 1);
        assert.ok(handle.child);
        assert.equal(spawnedLane, "pi");
        assert.ok(sleeps <= 1, `must not wait behind a cross-lane starter (slept ${sleeps} times)`);
        assert.equal(readStartingMarker()?.token, "starter-lane");
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: incompatible recorded instance (modelWindows) is not attached", async () => {
    let spawnCalls = 0;
    const spawnImpl: SpawnFn = () => {
        spawnCalls++;
        return makeFakeChild(42434);
    };
    let reads = 0;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, modelWindows: { "m1": 100000 } },
        {
            spawnImpl,
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42434 }),
            readInstanceFile: () => (reads++ === 0 ? recordedInstance() : undefined),
            sleep: () => Promise.resolve(),
        },
    );
    assert.equal(spawnCalls, 1);
    assert.equal(handle.attached, undefined);
});

// #2195: BILI_LAUNCHER_* / BILI_STRICT_PORT are launcher→child channels, not
// user configuration. A copy inherited from the launcher's own env (a host
// that exported one, or a harness that injected it) must never ride into the
// spawned proxy when THIS launch derives nothing for it: a stale window map
// otherwise lands in the instance record and every later launch refuses to
// attach with model-windows-mismatch, while the twin-collision guard then
// kills the replacement spawn.
test("ensureProxyRunning: inherited launcher channels never leak into the spawn env (#2195)", async () => {
    const keys = ["BILI_LAUNCHER_LANE", "BILI_LAUNCHER_MODEL_WINDOWS", "BILI_LAUNCHER_MODEL_MAX_OUTPUTS", "BILI_STRICT_PORT"] as const;
    const prev = new Map<string, string | undefined>();
    for (const key of keys) prev.set(key, process.env[key]);
    process.env.BILI_LAUNCHER_LANE = "stale-lane";
    process.env.BILI_LAUNCHER_MODEL_WINDOWS = JSON.stringify({ "stale-model": 60000 });
    process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS = JSON.stringify({ "stale-model": 8192 });
    process.env.BILI_STRICT_PORT = "1";
    try {
        let spawnEnv: NodeJS.ProcessEnv | undefined;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "codex" },
            {
                spawnImpl: (_cmd, _args, options) => {
                    spawnEnv = options.env ?? {};
                    return makeFakeChild(42470);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42470 }),
                readInstanceFile: () => undefined,
                sleep: () => Promise.resolve(),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.ok(handle.child, "the launch still spawns");
        assert.equal(spawnEnv?.BILI_LAUNCHER_LANE, "codex", "this launch's own lane still crosses the boundary");
        assert.equal(spawnEnv?.BILI_LAUNCHER_MODEL_WINDOWS, undefined, "a stale inherited window map must not leak (#2195)");
        assert.equal(spawnEnv?.BILI_LAUNCHER_MODEL_MAX_OUTPUTS, undefined, "a stale inherited max-output map must not leak (#2195)");
        assert.equal(spawnEnv?.BILI_STRICT_PORT, undefined, "strictness is re-derived per launch, never inherited");
    } finally {
        for (const key of keys) {
            const value = prev.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("ensureProxyRunning: this launch's own window map still reaches the child (#2195)", async () => {
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    await ensureProxyRunning(
        {
            host: "127.0.0.1",
            port: 8787,
            passthrough: false,
            debug: false,
            lane: "codex",
            modelWindows: { "m1": 60000 },
            modelMaxOutputs: { "m1": 4096 },
        },
        {
            spawnImpl: (_cmd, _args, options) => {
                spawnEnv = options.env ?? {};
                return makeFakeChild(42471);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42471 }),
            readInstanceFile: () => undefined,
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.deepEqual(JSON.parse(String(spawnEnv?.BILI_LAUNCHER_MODEL_WINDOWS)), { "m1": 60000 });
    assert.deepEqual(JSON.parse(String(spawnEnv?.BILI_LAUNCHER_MODEL_MAX_OUTPUTS)), { "m1": 4096 });
});

// #2195: the strip above drops every inherited launcher channel; strictPort is
// one of them, so its re-injection path needs its own positive proof — without
// it a future refactor could silently stop forwarding this launch's own pin.
test("ensureProxyRunning: this launch's own strictPort still reaches the child (#2195)", async () => {
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, lane: "codex", strictPort: true },
        {
            spawnImpl: (_cmd, _args, options) => {
                spawnEnv = options.env ?? {};
                return makeFakeChild(42472);
            },
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42472 }),
            readInstanceFile: () => undefined,
            sleep: () => Promise.resolve(),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawnEnv?.BILI_STRICT_PORT, "1", "strictness set by THIS launch still crosses the boundary");
});

test("ensureProxyRunning: dead recorded pid is ignored (no attach)", async () => {
    let spawnCalls = 0;
    const spawnImpl: SpawnFn = () => {
        spawnCalls++;
        return makeFakeChild(42435);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            spawnImpl,
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42435 }),
            readInstanceFile: () => recordedInstance({ pid: 99999999 }),
            sleep: () => Promise.resolve(),
        },
    );
    assert.equal(spawnCalls, 1);
});

test("ensureProxyRunning: active starting marker → waits, then attaches instead of spawning (#707)", async () => {
    try {
        claimStartingMarker({ token: "starter-a", pid: process.pid, host: "127.0.0.1", port: 8788, startedAt: Date.now() });
        let reads = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl: () => {
                    throw new Error("double-spawn: another launch was still bringing its proxy up");
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-9", watchdog: { armed: true } }),
                readInstanceFile: () => (reads++ < 2 ? undefined : recordedInstance({ instanceId: "inst-9", origin: "http://127.0.0.1:8788", port: 8788 })),
                sleep: () => Promise.resolve(),
                registerWatcher: async () => "ok" as const,
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, "http://127.0.0.1:8788");
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: stale starting marker (dead owner) → removed, then spawns (#707)", async () => {
    try {
        claimStartingMarker({ token: "starter-b", pid: 99999999, host: "127.0.0.1", port: 8789, startedAt: Date.now() });
        let spawnCalls = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42451);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 42451 }),
                readInstanceFile: () => undefined,
                sleep: () => Promise.resolve(),
            },
        );
        assert.equal(spawnCalls, 1);
        assert.ok(handle.child);
        assert.equal(readStartingMarker(), undefined);
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: expired starting marker (hung owner) → spawns (#707)", async () => {
    try {
        claimStartingMarker({ token: "starter-c", pid: process.pid, host: "127.0.0.1", port: 8789, startedAt: Date.now() - 95_000 }); // #2187: past the extended 90s marker TTL
        let spawnCalls = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42452);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 42452 }),
                readInstanceFile: () => undefined,
                sleep: () => Promise.resolve(),
            },
        );
        assert.equal(spawnCalls, 1);
        assert.ok(handle.child);
        assert.equal(readStartingMarker(), undefined);
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: waiter bails early when the starter clears its marker (#707)", async () => {
    try {
        claimStartingMarker({ token: "starter-d", pid: process.pid, host: "127.0.0.1", port: 8790, startedAt: Date.now() });
        let sleeps = 0;
        let spawnCalls = 0;
        const t0 = Date.now();
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl: () => {
                    spawnCalls++;
                    return makeFakeChild(42453);
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 42453 }),
                readInstanceFile: () => undefined,
                sleep: () => {
                    if (++sleeps === 1) removeStartingMarker();
                    return Promise.resolve();
                },
            },
        );
        assert.equal(spawnCalls, 1);
        assert.ok(handle.child);
        assert.ok(Date.now() - t0 < 2000, `early bail took ${Date.now() - t0}ms; must not burn the full wait window`);
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: starter claims marker before spawning and clears it when done (#707)", async () => {
    try {
        let childToken = "";
        let markerTokenAtSpawn: string | undefined;
        const spawnImpl: SpawnFn = (_cmd, _args, options) => {
            childToken = (options.env?.BILI_LAUNCH_TOKEN as string) ?? "";
            markerTokenAtSpawn = readStartingMarker()?.token;
            return makeFakeChild(42454);
        };
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl,
                fetchImpl: async () => ({ ok: true }),
                readInstanceFile: () => (childToken ? recordedInstance({ launchToken: childToken }) : undefined),
                sleep: () => new Promise((r) => setTimeout(r, 0)),
            },
        );
        assert.ok(childToken.length > 0);
        assert.equal(markerTokenAtSpawn, childToken);
        assert.ok(handle.child);
        assert.equal(readStartingMarker(), undefined);
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: starter clears marker when the child exits pre-bind (#707)", async () => {
    try {
        const child: SpawnChild = {
            pid: 42455,
            unref() {},
            kill() {
                return true;
            },
            on(event, listener) {
                if (event === "exit") setImmediate(() => listener(1, null));
                return undefined;
            },
        };
        await assert.rejects(
            ensureProxyRunning(
                { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
                {
                    spawnImpl: () => child,
                    fetchImpl: async () => ({ ok: false }),
                    fetchHealthInfo: async () => undefined,
                    readInstanceFile: () => undefined,
                    sleep: () => new Promise((r) => setTimeout(r, 1)),
                },
            ),
            /exited before becoming healthy/,
        );
        assert.equal(readStartingMarker(), undefined);
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: incompatible bring-up (modelWindows) is not attached — spawns anyway (#707)", async () => {
    try {
        claimStartingMarker({ token: "starter-g", pid: process.pid, host: "127.0.0.1", port: 8791, startedAt: Date.now() });
        let spawnCalls = 0;
        let ticks = 0;
        await assert.rejects(
            ensureProxyRunning(
                { host: "127.0.0.1", port: 8787, passthrough: false, debug: false, modelWindows: { m1: 100000 } },
                {
                    spawnImpl: () => {
                        spawnCalls++;
                        return makeFakeChild(42456);
                    },
                    fetchImpl: async () => ({ ok: false }),
                    fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1" }),
                    readInstanceFile: () => recordedInstance(),
                    now: () => ticks * 1000,
                    sleep: () => {
                        ticks += 10;
                        return Promise.resolve();
                    },
                },
            ),
            /did not become healthy/,
        );
        assert.equal(spawnCalls, 1);
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: unreadable starting marker is self-healed — removed, slot re-claimed (#707)", async () => {
    try {
        fs.writeFileSync(startingMarkerPath(), "{{{garbage");
        let spawnCalls = 0;
        let childToken = "";
        let markerTokenAtSpawn: string | undefined;
        const spawnImpl: SpawnFn = (_cmd, _args, options) => {
            spawnCalls++;
            childToken = (options.env?.BILI_LAUNCH_TOKEN as string) ?? "";
            markerTokenAtSpawn = readStartingMarker()?.token;
            return makeFakeChild(42460);
        };
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl,
                fetchImpl: async () => ({ ok: true }),
                readInstanceFile: () => (childToken ? recordedInstance({ launchToken: childToken }) : undefined),
                sleep: () => new Promise((r) => setTimeout(r, 0)),
            },
        );
        assert.equal(spawnCalls, 1);
        assert.ok(handle.child);
        assert.equal(markerTokenAtSpawn, childToken, "re-claim after garbage removal carries our token");
        assert.equal(readStartingMarker(), undefined, "marker cleared after success");
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: instance appearing at the wait deadline is attached, not double-spawned (#707)", async () => {
    try {
        claimStartingMarker({ token: "starter-h", pid: process.pid, host: "127.0.0.1", port: 8792, startedAt: Date.now() });
        let ticks = 0;
        let reads = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl: () => {
                    throw new Error("double-spawn: instance appeared at the deadline");
                },
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-b", watchdog: { armed: true } }),
                readInstanceFile: () =>
                    reads++ < 3 ? undefined : recordedInstance({ instanceId: "inst-b", origin: "http://127.0.0.1:8792", port: 8792 }),
                now: () => ticks * 1000,
                sleep: () => {
                    ticks += 10;
                    return Promise.resolve();
                },
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(handle.attached, true);
        assert.equal(handle.origin, "http://127.0.0.1:8792");
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: hung starter (marker never clears) is bounded — waits max twice, then spawns (#707)", async () => {
    try {
        claimStartingMarker({ token: "starter-j", pid: process.pid, host: "127.0.0.1", port: 8793, startedAt: Date.now() });
        let spawnCalls = 0;
        let ticks = 0;
        await assert.rejects(
            ensureProxyRunning(
                { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
                {
                    spawnImpl: () => {
                        spawnCalls++;
                        return makeFakeChild(42461);
                    },
                    fetchImpl: async () => ({ ok: false }),
                    fetchHealthInfo: async () => undefined,
                    readInstanceFile: () => undefined,
                    now: () => ticks * 1000,
                    sleep: () => {
                        ticks += 10;
                        return Promise.resolve();
                    },
                },
            ),
            /did not become healthy/,
        );
        assert.equal(spawnCalls, 1, "bounded waits end in a spawn attempt, never an infinite loop");
        assert.equal(readStartingMarker()?.token, "starter-j", "foreign marker left untouched");
    } finally {
        removeStartingMarker();
    }
});

test("ensureProxyRunning: port 0 (no explicit --port) spawns on an OS-assigned ephemeral port (#446)", async () => {
    let spawnedArgs: string[] | null = null;
    const spawnImpl: SpawnFn = (_cmd, args) => {
        spawnedArgs = [...args];
        return makeFakeChild(42437);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
        { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve(), readInstanceFile: () => undefined },
    );
    assert.ok(spawnedArgs !== null);
    const portIdx = (spawnedArgs as string[]).indexOf("--port");
    assert.ok(portIdx >= 0, "spawn args include --port");
    const childPort = Number(spawnedArgs[portIdx + 1]);
    assert.ok(Number.isInteger(childPort) && childPort >= 1024 && childPort <= 65535, `ephemeral port assigned, got ${childPort}`);
    assert.equal(handle.port, childPort);
    assert.equal(handle.origin, `http://127.0.0.1:${childPort}`);
});

test("ensureProxyRunning: explicit port is honored verbatim (no ephemeral reassignment)", async () => {
    let spawnedArgs: string[] | null = null;
    const spawnImpl: SpawnFn = (_cmd, args) => {
        spawnedArgs = [...args];
        return makeFakeChild(42438);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve(), readInstanceFile: () => undefined },
    );
    assert.ok(spawnedArgs !== null);
    const portIdx = (spawnedArgs as string[]).indexOf("--port");
    assert.equal(spawnedArgs[portIdx + 1], "8787");
    assert.equal(handle.port, 8787);
});

test("ensureProxyRunning: launchToken handshake returns the child's real port (#407)", async () => {
    let handshaked: InstanceFile | undefined;
    const spawnImpl: SpawnFn = (_cmd, _args, options) => {
        const token = (options.env?.BILI_LAUNCH_TOKEN as string) ?? "";
        const parentPid = Number(options.env?.BILI_PARENT_PID);
        assert.ok(token.length > 0, "spawn env carries BILI_LAUNCH_TOKEN");
        assert.equal(parentPid, process.pid);
        setImmediate(() => {
            handshaked = recordedInstance({ origin: "http://127.0.0.1:8799", port: 8799, launchToken: token });
        });
        return makeFakeChild(42436);
    };
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            spawnImpl,
            fetchImpl: async (url: string) => ({ ok: url.startsWith("http://127.0.0.1:8799") }),
            readInstanceFile: () => handshaked,
            sleep: () => new Promise((r) => setTimeout(r, 0)),
        },
    );
    assert.equal(handle.port, 8799);
    assert.equal(handle.origin, "http://127.0.0.1:8799");
});

test("ensureProxyRunning: spawned child exits pre-bind → fails fast (<5s) with log path (#401/#480)", async () => {
    const child: SpawnChild = {
        pid: 42441,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            if (event === "exit") setImmediate(() => listener(1, null));
            return undefined;
        },
    };
    const spawnImpl: SpawnFn = () => child;
    const t0 = Date.now();
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                spawnImpl,
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                readInstanceFile: () => undefined,
                sleep: () => new Promise((r) => setTimeout(r, 1)),
            },
        ),
        (err: Error) => {
            assert.match(err.message, /exited before becoming healthy/);
            assert.match(err.message, /code 1/);
            assert.match(err.message, /log:/);
            return true;
        },
    );
    assert.ok(Date.now() - t0 < 5000, `fast-fail took ${Date.now() - t0}ms; must not burn the full poll window`);
});

test("stopProxy: no-op when child missing pid", () => {
    assert.doesNotThrow(() =>
        stopProxy({ origin: "http://127.0.0.1:8787", port: 8787, child: { pid: 0 } }),
    );
});

test("stopProxy: POSIX kills the owned child, win32 defers to the parent-gone watcher (#414)", () => {
    let killed = false;
    const child: SpawnChild = {
        pid: 77777,
        kill: () => {
            killed = true;
            return true;
        },
    };
    stopProxy({ origin: "http://127.0.0.1:8787", port: 8787, child });
    if (process.platform === "win32") {
        assert.equal(killed, false, "win32 child.kill is TerminateProcess (no flush) — shutdown belongs to BILI_PARENT_PID watcher");
    } else {
        assert.equal(killed, true);
    }
});

test("isOnPath: finds a known binary on PATH, misses bogus name", () => {
    const nodeDir = path.dirname(process.execPath);
    const nodeName = path.basename(process.execPath);
    assert.equal(isOnPath(nodeName, { PATH: nodeDir }), true);
    assert.equal(isOnPath("definitely-not-a-real-bin-xyzzy", { PATH: nodeDir }), false);
    assert.equal(isOnPath(nodeName, {}), false);
});

test("resolveClientCommand: codex/claude not on PATH fall back to bare name", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-path-"));
    try {
        assert.deepEqual(resolveClientCommand("codex", { PATH: tmp }), {
            command: "codex",
            prefixArgs: [],
        });
        assert.deepEqual(resolveClientCommand("claude", { PATH: tmp }), {
            command: "claude",
            prefixArgs: [],
        });
    } finally {
        fs.rmdirSync(tmp);
    }
});

test("resolveClientCommand: codex/claude on PATH resolve to full path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-path-"));
    const codexFile = path.join(tmp, "codex");
    const claudeFile = path.join(tmp, "claude");
    fs.writeFileSync(codexFile, "#!/bin/sh\necho codex\n", { mode: 0o755 });
    fs.writeFileSync(claudeFile, "#!/bin/sh\necho claude\n", { mode: 0o755 });
    try {
        assert.deepEqual(resolveClientCommand("codex", { PATH: tmp }), {
            command: codexFile,
            prefixArgs: [],
        });
        assert.deepEqual(resolveClientCommand("claude", { PATH: tmp }), {
            command: claudeFile,
            prefixArgs: [],
        });
    } finally {
        fs.unlinkSync(codexFile);
        fs.unlinkSync(claudeFile);
        fs.rmdirSync(tmp);
    }
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

test("discoverRoutes: claude default → ANTHROPIC_BASE_URL /bili/ rewrite (no cert MITM; loopback NO_PROXY merged by buildClientEnv, #3446)", () => {
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

test("discoverRoutes: claude Vertex-on → second route keyed ANTHROPIC_VERTEX_BASE_URL, protocol-pinned", () => {
    // Vertex port, phase 1 (decision 2): registered ONLY when the client's own
    // switch is on, and it pins the `anthropic` wire — Vertex's :rawPredict
    // matches no suffix-ladder arm, so an unqualified /bili/<url> would be relayed
    // with no protocol at all.
    const config: ClientConfig = { claude: { vertexEnabled: true, vertexRegion: "global" } };
    const routes = discoverRoutes("claude", config);
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
        { key: "ANTHROPIC_VERTEX_BASE_URL", realUpstream: "https://aiplatform.googleapis.com/v1", protocol: "anthropic" },
    ]);
});

test("discoverRoutes: claude Vertex-on with an explicit base URL → that URL wins over the region", () => {
    const config: ClientConfig = {
        claude: { vertexEnabled: true, vertexRegion: "us-east5", vertexBaseUrl: "https://gateway.example/vertex/v1" },
    };
    const routes = discoverRoutes("claude", config);
    assert.deepEqual(routes.httpRewrites, [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
        { key: "ANTHROPIC_VERTEX_BASE_URL", realUpstream: "https://gateway.example/vertex/v1", protocol: "anthropic" },
    ]);
});

test("discoverRoutes: claude Vertex-on with an already-managed base URL → unwrapped, not nested", () => {
    // The managed block writes ANTHROPIC_VERTEX_BASE_URL and the next launch reads
    // it back (readClaudeSettings falls back to the process env, where Claude Code
    // exports the settings block). Wrapping that value as-is nested a
    // /bili/anthropic/ layer per launch, and the extra hop targeted the proxy's own
    // port — the tunnel guard denies it with 403 detail:"self".
    const config: ClientConfig = {
        claude: {
            vertexEnabled: true,
            vertexBaseUrl: "http://127.0.0.1:40000/bili/anthropic/https://aiplatform.googleapis.com/v1",
        },
    };
    const routes = discoverRoutes("claude", config);
    assert.deepEqual(routes.httpRewrites, [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
        { key: "ANTHROPIC_VERTEX_BASE_URL", realUpstream: "https://aiplatform.googleapis.com/v1", protocol: "anthropic" },
    ]);
});

test("discoverRoutes: claude Vertex-on without a usable region → no Vertex route (no guessed region)", () => {
    // Decision 3: never substitute a default region — a wrong one 404s every
    // request, while an absent route only means the launcher must warn.
    const config: ClientConfig = { claude: { vertexEnabled: true } };
    const routes = discoverRoutes("claude", config);
    assert.deepEqual(routes.httpRewrites, [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
    ]);
});

test("discoverRoutes: vertex keys present but switch off → byte-identical to pre-port discovery", () => {
    const config: ClientConfig = { claude: { vertexRegion: "global", vertexProjectId: "p", vertexBaseUrl: "https://gateway.example/v1" } };
    const routes = discoverRoutes("claude", config);
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
    assert.deepEqual(discoverRoutes("pi", {}), { httpsDomains: [], httpRewrites: [], httpsRewrites: [], httpEnvRoutes: [] });
    assert.deepEqual(discoverRoutes("codex", {}), { httpsDomains: [], httpRewrites: [], httpsRewrites: [], httpEnvRoutes: [] });
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

test("buildCodexArgs: #2197 extra args first, then -c rewrites (last-wins: bili's substitution must beat a user -c on the same key)", () => {
    const rewrites: HttpRewrite[] = [
        { key: "k1", realUpstream: "u1" },
        { key: "k2", realUpstream: "u2" },
    ];
    assert.deepEqual(buildCodexArgs("http://h:p", rewrites, [], ["--extra"]), [
        "--extra",
        "-c", "k1=http://h:p/bili/u1",
        "-c", "k2=http://h:p/bili/u2",
    ]);
});

test("buildCodexArgs: #2197 user -c on a rewritten key is clobbered by the appended bili rewrite", () => {
    const rewrites: HttpRewrite[] = [
        { key: "model_providers.e2e.base_url", realUpstream: "http://127.0.0.1:9/" },
    ];
    const out = buildCodexArgs(
        "http://127.0.0.1:41355",
        rewrites,
        [],
        ["-c", "model_providers.e2e.base_url=http://user-picked.local/v1"],
    );
    assert.deepEqual(out, [
        "-c", "model_providers.e2e.base_url=http://user-picked.local/v1",
        "-c", `model_providers.e2e.base_url=${wrapUpstream("http://127.0.0.1:41355", "http://127.0.0.1:9/")}`,
    ]);
});

test("buildCodexArgs: no rewrites → just extra args", () => {
    assert.deepEqual(buildCodexArgs("http://h:p", [], [], ["--foo"]), ["--foo"]);
});

// #2260(D): cli.ts only eats a LEADING `--` right after the client name, so a
// non-leading one reaches buildCodexArgs inside extra — and everything past it
// is positional to codex's parser. Appending there turned the rewrites into
// prompt text and silently bypassed the proxy (`bili codex exec -- "-p"`).
test("buildCodexArgs: #2260(D) rewrites land BEFORE a user `--` separator, not after its positionals", () => {
    const rewrites: HttpRewrite[] = [
        { key: "model_providers.x.base_url", realUpstream: "https://up.local/v1" },
    ];
    assert.deepEqual(buildCodexArgs("http://h:p", rewrites, [], ["exec", "--", "-p"]), [
        "exec",
        "-c", `model_providers.x.base_url=${wrapUpstream("http://h:p", "https://up.local/v1")}`,
        "--",
        "-p",
    ]);
});

test("buildCodexArgs: #2260(D) last-wins holds across `--` — a user -c before the separator still loses to bili's rewrite", () => {
    const rewrites: HttpRewrite[] = [
        { key: "model_providers.x.base_url", realUpstream: "https://up.local/v1" },
    ];
    const out = buildCodexArgs(
        "http://h:p",
        rewrites,
        [],
        ["-c", "model_providers.x.base_url=https://user-picked.local/v1", "--", "-p"],
    );
    assert.deepEqual(out, [
        "-c", "model_providers.x.base_url=https://user-picked.local/v1",
        "-c", `model_providers.x.base_url=${wrapUpstream("http://h:p", "https://up.local/v1")}`,
        "--",
        "-p",
    ]);
});

test("buildCodexArgs: #2281 resume — rewrites insert BEFORE the `resume` subcommand so the user's -c model=… survives codex's exec-resume parsing", () => {
    const rewrites: HttpRewrite[] = [
        { key: "model_providers.x.base_url", realUpstream: "http://up.local/v1" },
    ];
    const out = buildCodexArgs(
        "http://h:p",
        rewrites,
        [],
        ["exec", "--skip-git-repo-check", "-c", "model=gpt-5-codex", "resume", "--last", "turn two prompt"],
    );
    // rewrites sit ahead of `resume` — a -c AFTER the resume subcommand makes
    // codex-cli 0.147.0 drop the earlier `-c model=…` on exec resume (bisected
    // against the real binary: [-c model=B, resume, --last, -c provider…, prompt]
    // still loses model=B; see issue #2281).
    assert.deepEqual(out, [
        "exec", "--skip-git-repo-check", "-c", "model=gpt-5-codex",
        "-c", `model_providers.x.base_url=${wrapUpstream("http://h:p", "http://up.local/v1")}`,
        "resume", "--last", "turn two prompt",
    ]);
});

test("buildCodexArgs: #2281 never splits a value-taking flag from its value — trailing `-c <value>` keeps the legacy append", () => {
    const rewrites: HttpRewrite[] = [
        { key: "model_providers.x.base_url", realUpstream: "http://up.local/v1" },
    ];
    const out = buildCodexArgs(
        "http://h:p",
        rewrites,
        [],
        ["exec", "-c", "model=gpt-5-codex"],
    );
    assert.deepEqual(out, [
        "exec", "-c", "model=gpt-5-codex",
        "-c", `model_providers.x.base_url=${wrapUpstream("http://h:p", "http://up.local/v1")}`,
    ]);
});

test("buildCodexArgs: #2281 flags-only tail and unknown-flag tails keep the append behavior", () => {
    const rewrites: HttpRewrite[] = [
        { key: "model_providers.x.base_url", realUpstream: "http://up.local/v1" },
    ];
    assert.deepEqual(
        buildCodexArgs("http://h:p", rewrites, [], ["exec", "--some-unknown-flag", "maybe-a-value"]).slice(-2),
        ["-c", `model_providers.x.base_url=${wrapUpstream("http://h:p", "http://up.local/v1")}`],
    );
});

test("buildCodexArgs: #2281 `resume` with no trailing prompt still anchors the rewrites before it", () => {
    const rewrites: HttpRewrite[] = [
        { key: "model_providers.x.base_url", realUpstream: "http://up.local/v1" },
    ];
    assert.deepEqual(
        buildCodexArgs("http://h:p", rewrites, [], ["exec", "resume", "--last"]),
        ["exec",
            "-c", `model_providers.x.base_url=${wrapUpstream("http://h:p", "http://up.local/v1")}`,
            "resume", "--last"],
    );
});

test("buildClaudeEnv: ANTHROPIC_BASE_URL rewrite sets env, no proxy env", () => {
    const rewrites: HttpRewrite[] = [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "http://relay.local/anthropic" },
    ];
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin" });
    assert.equal(env.HTTPS_PROXY, undefined);
    assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787/bili/http://relay.local/anthropic");
});

test("buildClaudeEnv: no ANTHROPIC_BASE_URL rewrite → env.ANTHROPIC_BASE_URL unset", () => {
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", [], [], { PATH: "/usr/bin" });
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.HTTPS_PROXY, undefined);
});

// The child's own proxy env is a pass-through on this lane: it is the user's,
// and model traffic goes to loopback, so nothing here can hijack the model leg.
test("buildClaudeEnv: a shell proxy in baseEnv rides through untouched", () => {
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", [], [], { PATH: "/usr/bin", HTTPS_PROXY: "http://user.local:8080", ALL_PROXY: "http://user.local:8081" });
    assert.equal(env.HTTPS_PROXY, "http://user.local:8080");
    assert.equal(env.ALL_PROXY, "http://user.local:8081");
    assert.equal(env.HTTP_PROXY, undefined);
});

// The egress handoff that replaces the leaked HTTPS_PROXY: a child with no proxy
// env of its own gets the instance's aux proxy instead, and a child that already
// has one is left strictly alone (no probe, no rewrite, no log line).
test("childNamesProxy: any scheme, either case, counts as a configured child", () => {
    assert.equal(childNamesProxy({}), false);
    assert.equal(childNamesProxy({ PATH: "/usr/bin", HTTPS_PROXY: "  " }), false, "blank is not a proxy");
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
        assert.equal(childNamesProxy({ [key]: "http://user.local:8080" }), true, key);
    }
});

test("applyAuxProxyHandoff: no proxy env of its own → both variables get the aux proxy", async () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    const env = await applyAuxProxyHandoff(base, "http://127.0.0.1:8787", async () => ({ ok: true, auxProxy: "http://aux.local:3128", auxProxySource: "httpsProxy" }));
    assert.equal(env.HTTP_PROXY, "http://aux.local:3128");
    assert.equal(env.HTTPS_PROXY, "http://aux.local:3128");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(base.HTTP_PROXY, undefined, "input env untouched");
});

test("applyAuxProxyHandoff: a child that names a proxy is left alone and never probed", async () => {
    let probes = 0;
    const fetchHealth = async () => {
        probes++;
        return { ok: true, auxProxy: "http://aux.local:3128" };
    };
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
        const env = await applyAuxProxyHandoff({ [key]: "http://user.local:8080" }, "http://127.0.0.1:8787", fetchHealth);
        assert.deepEqual(env, { [key]: "http://user.local:8080" }, key);
    }
    assert.equal(probes, 0, "no health round trip when the child already has a proxy");
});

test("applyAuxProxyHandoff: nothing to hand over → env unchanged, never bili's own origin", async () => {
    const origin = "http://127.0.0.1:8787";
    const cases: Array<[string, () => Promise<{ ok: boolean; auxProxy?: string } | undefined>]> = [
        ["pre-handoff build (no field)", async () => ({ ok: true })],
        ["probe failed", async () => undefined],
        ["probe threw", async () => Promise.reject(new Error("boom"))],
    ];
    for (const [label, fetchHealth] of cases) {
        const env: NodeJS.ProcessEnv = await applyAuxProxyHandoff({ PATH: "/usr/bin" }, origin, fetchHealth);
        // a copy: assert.deepEqual is an assertion function and would narrow `env`
        const got: NodeJS.ProcessEnv = { ...env };
        assert.deepEqual(got, { PATH: "/usr/bin" }, label);
        assert.notEqual(env.HTTPS_PROXY, origin, "routing the child back through bili is the leak, not the fix");
    }
});

// Vertex port, phase 1 (decision 7): the Vertex variable is ADDITIVE. Both keys
// are set so a session that flips CLAUDE_CODE_USE_VERTEX off still finds a valid
// ANTHROPIC_BASE_URL, and each is resolved against its OWN rewrite — the old
// baseUrlKeys[0] fan-out would have aimed the Vertex key at api.anthropic.com.
test("buildClaudeEnv: Vertex route → ANTHROPIC_VERTEX_BASE_URL protocol-wrapped, ANTHROPIC_BASE_URL unchanged", () => {
    const rewrites: HttpRewrite[] = [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
        { key: "ANTHROPIC_VERTEX_BASE_URL", realUpstream: "https://aiplatform.googleapis.com/v1", protocol: "anthropic" },
    ];
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin" });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787/bili/https://api.anthropic.com");
    assert.equal(env.ANTHROPIC_VERTEX_BASE_URL, "http://127.0.0.1:8787/bili/anthropic/https://aiplatform.googleapis.com/v1");
    assert.equal(env.HTTPS_PROXY, undefined);
});

test("buildClaudeEnv: Vertex off (no Vertex rewrite) → the key stays unset, never mirrored from the primary", () => {
    const rewrites: HttpRewrite[] = [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
    ];
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin" });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787/bili/https://api.anthropic.com");
    assert.equal(env.ANTHROPIC_VERTEX_BASE_URL, undefined);
});

// The mirror fan-out the per-key resolution has to preserve: iFlow accepts two
// case variants and only the first ever gets a rewrite entry.
test("buildIflowEnv: alias key still mirrors the primary rewrite (no per-key regression)", () => {
    const rewrites: HttpRewrite[] = [
        { key: "IFLOW_BASE_URL", realUpstream: "https://apis.iflow.cn/v1" },
    ];
    const env = buildIflowEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin" });
    assert.equal(env.IFLOW_BASE_URL, "http://127.0.0.1:8787/bili/https://apis.iflow.cn/v1");
    assert.equal(env.IFLOW_baseUrl, env.IFLOW_BASE_URL);
});

test("buildClaudeEnv: /bili/-wrapped ANTHROPIC_BASE_URL → NO_PROXY/no_proxy loopback merge (#3446)", () => {
    const rewrites: HttpRewrite[] = [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
    ];
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin" });
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8787/bili/https://api.anthropic.com");
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
});

test("buildClaudeEnv: NO_PROXY merge unions both case variants, preserves user entries, dedupes (#3446)", () => {
    const rewrites: HttpRewrite[] = [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
    ];
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], {
        PATH: "/usr/bin",
        NO_PROXY: "corp.example.com, 10.0.0.5 ",
        no_proxy: "localhost,internal.corp",
    });
    assert.equal(env.NO_PROXY, "corp.example.com,10.0.0.5,localhost,internal.corp,127.0.0.1,::1");
    assert.equal(env.no_proxy, env.NO_PROXY);
});

test("buildClaudeEnv: NO_PROXY already covering all loopback hosts → value unchanged (#3446)", () => {
    const rewrites: HttpRewrite[] = [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://api.anthropic.com" },
    ];
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], {
        PATH: "/usr/bin",
        NO_PROXY: "localhost,127.0.0.1,::1",
    });
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
});

test("buildClaudeEnv: httpsRewrites raw upstream wins → no NO_PROXY merge (#3446)", () => {
    const httpsRewrites: HttpRewrite[] = [
        { key: "ANTHROPIC_BASE_URL", realUpstream: "https://relay.local/anthropic" },
    ];
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", [], httpsRewrites, { PATH: "/usr/bin" });
    assert.equal(env.ANTHROPIC_BASE_URL, "https://relay.local/anthropic");
    assert.equal(env.NO_PROXY, undefined);
    assert.equal(env.no_proxy, undefined);
});

test("buildCodexEnv: no base-URL lane → NO_PROXY untouched even with proxy set (#3446)", () => {
    const env = buildCodexEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.NO_PROXY, undefined);
    assert.equal(env.no_proxy, undefined);
});

test("buildPiEnv: http rewrites → BILI_PROVIDER_REWRITES manifest (#535 file-free routing)", () => {
    const env = buildPiEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin" }, [
        { key: "a", realUpstream: "http://example.com/v1" },
        { key: "b", realUpstream: "http://other.example.com" },
    ]);
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    const manifest = JSON.parse(env.BILI_PROVIDER_REWRITES ?? "null");
    assert.deepEqual(manifest, {
        a: "http://127.0.0.1:8787/bili/http://example.com/v1",
        b: "http://127.0.0.1:8787/bili/http://other.example.com",
    });
});

test("buildPiEnv: no rewrites → no manifest env", () => {
    const env = buildPiEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin" }, []);
    assert.equal(env.BILI_PROVIDER_REWRITES, undefined);
});

test("buildPiEnv: empty-key/empty-upstream entries skipped", () => {
    const env = buildPiEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin" }, [
        { key: "", realUpstream: "http://example.com/v1" },
        { key: "b", realUpstream: "" },
    ]);
    assert.equal(env.BILI_PROVIDER_REWRITES, undefined);
});

test("buildPiEnv: exports BILI_NON_HTTP_PROVIDERS only when non-http providers are listed (#1392)", () => {
    const env = buildPiEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin" }, [], [], [], ["claude-bridge"]);
    assert.equal(env.BILI_NON_HTTP_PROVIDERS, "claude-bridge");
    const bare = buildPiEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin" });
    assert.equal(bare.BILI_NON_HTTP_PROVIDERS, undefined);
});

test("resolveNonHttpProviders: providers-table compactionOptIn ∪ env list, deduped (#1392)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-nhp-"));
    const cfgFile = path.join(dir, "billion-context.json");
    fs.writeFileSync(cfgFile, JSON.stringify({
        providers: {
            "claude-bridge": { compactionOptIn: true },
            "off-provider": { compactionOptIn: false },
            "wrong-type": { compactionOptIn: "yes" },
            "no-field": {},
            "https://api.anthropic.com": { compactionOptIn: true },
        },
    }), "utf8");
    const prevCfg = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = cfgFile;
    try {
        // Only strictly-true compactionOptIn opts a provider id in: false,
        // "yes", and absent are ignored. URL-shaped entries with the field set
        // also resolve (inert — the plugin consults the set only for non-http
        // baseUrls) but keep deterministic order: config iteration order.
        assert.deepEqual(resolveNonHttpProviders({}), ["claude-bridge", "https://api.anthropic.com"]);
        // Env ∪ file, deduped: claude-bridge (both sources) + z (env-only).
        assert.deepEqual(resolveNonHttpProviders({ BILI_NON_HTTP_PROVIDERS: "claude-bridge,z" }), ["claude-bridge", "https://api.anthropic.com", "z"]);
    } finally {
        if (prevCfg === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevCfg;
        rmrf(dir);
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
    for (const k of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "no_proxy", "NO_PROXY"]) {
        assert.equal(cleaned[k], undefined, `${k} should be stripped`);
    }
    // #535: no_proxy/NO_PROXY are stripped too — an inherited exclusion list
    // could punch holes in the proxy routing we inject (hermes/httpx honors
    // no_proxy per-URL).
    assert.equal(cleaned.BILI_UPSTREAM_PROXY, "http://relay:9999", "BILI_UPSTREAM_PROXY kept (explicit chaining)");
    assert.equal(cleaned.PATH, "/usr/bin", "PATH kept");
    assert.equal(cleaned.HOME, "/home/dog", "HOME kept");
});

// #3521: the verbatim-passthrough client lanes (no routable providers, direct-URL
// mode) must keep the user's OWN proxy vars while losing every internal channel.
test("stripInternalLauncherChannels: #3521 removes only the internal channels, keeps user proxy vars", () => {
    const cleaned = stripInternalLauncherChannels({
        BILI_LAUNCHER_LANE: "pi",
        BILI_LAUNCHER_MODEL_WINDOWS: JSON.stringify({ "stale-model": 12345 }),
        BILI_LAUNCHER_MODEL_MAX_OUTPUTS: JSON.stringify({ "stale-model": 999 }),
        BILI_STRICT_PORT: "1",
        http_proxy: "http://corp:20172",
        HTTPS_PROXY: "http://corp:20172",
        PATH: "/usr/bin",
    });
    for (const k of ["BILI_LAUNCHER_LANE", "BILI_LAUNCHER_MODEL_WINDOWS", "BILI_LAUNCHER_MODEL_MAX_OUTPUTS", "BILI_STRICT_PORT"]) {
        assert.equal(cleaned[k], undefined, `${k} should be stripped`);
    }
    assert.equal(cleaned.http_proxy, "http://corp:20172", "user's own lowercase proxy var survives");
    assert.equal(cleaned.HTTPS_PROXY, "http://corp:20172", "user's own uppercase proxy var survives");
    assert.equal(cleaned.PATH, "/usr/bin", "PATH kept");
});

// #3521: internal launcher channels are not user configuration — a value left
// behind by an earlier spawn must not survive sanitization, while user-facing
// env (BILI_MITM_DOMAINS is the config twin of mitm.domains) must.
test("stripInheritedProxy: #3521 strips inherited internal launcher channels, keeps user-facing vars", () => {
    const cleaned = stripInheritedProxy({
        BILI_LAUNCHER_LANE: "pi",
        BILI_LAUNCHER_MODEL_WINDOWS: JSON.stringify({ "stale-model": 12345 }),
        BILI_LAUNCHER_MODEL_MAX_OUTPUTS: JSON.stringify({ "stale-model": 999 }),
        BILI_STRICT_PORT: "1",
        BILI_MITM_DOMAINS: "api.example.com",
        PATH: "/usr/bin",
    });
    for (const k of ["BILI_LAUNCHER_LANE", "BILI_LAUNCHER_MODEL_WINDOWS", "BILI_LAUNCHER_MODEL_MAX_OUTPUTS", "BILI_STRICT_PORT"]) {
        assert.equal(cleaned[k], undefined, `${k} should be stripped`);
    }
    assert.equal(cleaned.BILI_MITM_DOMAINS, "api.example.com", "user-facing mitm domains kept");
    assert.equal(cleaned.PATH, "/usr/bin", "PATH kept");
});

// #3521: an earlier spawn left its options in THIS process's env (long-lived
// desktop host, test harness). They must not ride into the next proxy child:
// the child records them in its instance file, later launches with different
// options fail attach (model-windows-mismatch) and die on the twin-collision
// path. Current options are still injected fresh on top of the clean env.
test("ensureProxyRunning: #3521 inherited launcher channels never reach the spawned proxy", async () => {
    const channelKeys = ["BILI_LAUNCHER_LANE", "BILI_LAUNCHER_MODEL_WINDOWS", "BILI_LAUNCHER_MODEL_MAX_OUTPUTS", "BILI_STRICT_PORT"] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of channelKeys) saved[k] = process.env[k];
    let liveInst: InstanceFile | undefined;
    const spawns: Array<NodeJS.ProcessEnv> = [];
    const spawnImpl: SpawnFn = (_cmd, _args, options) => {
        const env = options.env ?? {};
        spawns.push(env);
        const pid = 42900 + spawns.length;
        // The child records whatever lane/windows it was handed — here the
        // poisoned values, so launch two below cannot attach (lane-mismatch)
        // and must spawn, exactly like the real repro.
        liveInst = recordedInstance({ pid, lane: env.BILI_LAUNCHER_LANE ?? "stale-lane", modelWindows: { "stale-model": 12345 }, launchToken: env.BILI_LAUNCH_TOKEN });
        return makeFakeChild(pid);
    };
    const deps = {
        spawnImpl,
        fetchImpl: async () => ({ ok: true }),
        fetchHealthInfo: async () => ({ ok: true, instanceId: liveInst?.instanceId ?? "inst-1", pid: liveInst?.pid, watchdog: { armed: true } }),
        readInstanceFile: () => liveInst,
        sleep: () => Promise.resolve(),
        scriptPath: FP_SCRIPT,
    };
    try {
        process.env.BILI_LAUNCHER_LANE = "stale-lane";
        process.env.BILI_LAUNCHER_MODEL_WINDOWS = JSON.stringify({ "stale-model": 12345 });
        process.env.BILI_LAUNCHER_MODEL_MAX_OUTPUTS = JSON.stringify({ "stale-model": 999 });
        process.env.BILI_STRICT_PORT = "1";

        await ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            deps,
        );
        assert.equal(spawns.length, 1, "first launch spawns");
        for (const k of channelKeys) {
            assert.equal(spawns[0][k], undefined, `${k} must not ride along from the parent env`);
        }

        await ensureProxyRunning(
            {
                host: "127.0.0.1",
                port: 8787,
                passthrough: false,
                debug: false,
                lane: "pi",
                modelWindows: { "current-model": 200000 },
                modelMaxOutputs: { "current-model": 64000 },
                strictPort: true,
            },
            deps,
        );
        assert.equal(spawns.length, 2, "lane-mismatch against the recorded stale lane forces a fresh spawn");
        assert.equal(spawns[1].BILI_LAUNCHER_LANE, "pi", "current lane is injected fresh");
        assert.equal(spawns[1].BILI_LAUNCHER_MODEL_WINDOWS, JSON.stringify({ "current-model": 200000 }), "current windows replace, not merge with, stale ones");
        assert.equal(spawns[1].BILI_LAUNCHER_MODEL_MAX_OUTPUTS, JSON.stringify({ "current-model": 64000 }), "current max outputs replace, not merge with, stale ones");
        assert.equal(spawns[1].BILI_STRICT_PORT, "1", "explicit strict port still crosses the boundary");
    } finally {
        for (const k of channelKeys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
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
    assert.equal(cfg.providers?.["sglang-responses"]?.baseUrl, "http://127.0.0.1:8199/v1");
    assert.equal(cfg.providers?.["zhipuai"]?.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
    assert.equal(cfg.providers?.["ollama-chat"]?.baseUrl, "http://127.0.0.1:11435/v1");
    assert.equal(Object.keys(cfg.providers ?? {}).length, 3);
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
        assert.equal(cfg.providers?.a?.baseUrl, "http://x:1/v1");
    } finally {
        rmrf(home);
    }
});

test("readOmpConfig: missing models.yml → {}", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-omphome-"));
    try {
        assert.deepEqual(readOmpConfig(home), { providers: {} });
    } finally {
        rmrf(home);
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
        assert.deepEqual(cfg.providers?.["local"], { baseURL: "http://127.0.0.1:18081/v1" });
        assert.deepEqual(cfg.providers?.["remote"], { baseURL: "https://api.example.com/v1" });
        assert.equal(cfg.providers?.["noUrl"], undefined);
        assert.equal(readOpencodeConfig(path.join(dir, "missing.json")).providers?.["local"], undefined);
    } finally {
        rmrf(dir);
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

test("readOpencodeConfig: parses JSONC (comments + trailing commas)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-jsonc-"));
    try {
        const cfgFile = path.join(dir, "opencode.jsonc");
        fs.writeFileSync(
            cfgFile,
            [
                "{",
                "    // opencode accepts JSONC in every config file",
                '    "provider": {',
                '        "local": {',
                '            "options": { "baseURL": "http://127.0.0.1:18081/v1", },',
                "        },",
                "    },",
                "}",
            ].join("\n"),
        );
        const cfg = readOpencodeConfig(cfgFile);
        assert.deepEqual(cfg.providers?.["local"], { baseURL: "http://127.0.0.1:18081/v1" });
    } finally {
        rmrf(dir);
    }
});

test("readOpencodeConfigRoot: merges config.json → opencode.json → opencode.jsonc, OPENCODE_CONFIG wins", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-merge-"));
    try {
        const ocDir = path.join(dir, "opencode");
        fs.mkdirSync(ocDir);
        // opencode seeds a near-empty .jsonc when no config exists — the merge must
        // still surface the real provider living in opencode.json (#796: single-file
        // .jsonc-preference would miss it).
        fs.writeFileSync(path.join(ocDir, "opencode.jsonc"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }));
        fs.writeFileSync(
            path.join(ocDir, "opencode.json"),
            JSON.stringify({
                provider: {
                    fromjson: { options: { baseURL: "http://from.json/v1" } },
                    dup: { options: { baseURL: "http://dup-json/v1" }, models: { m: { limit: 4096 } } },
                },
            }),
        );
        fs.writeFileSync(path.join(ocDir, "config.json"), JSON.stringify({}));

        const env = { XDG_CONFIG_HOME: dir };
        const root = readOpencodeConfigRoot(env);
        assert.ok(root);
        assert.deepEqual((root.provider as Record<string, { options: { baseURL: string } }> | undefined)?.fromjson, { options: { baseURL: "http://from.json/v1" } } );

        // later files win on conflicting keys; providers from earlier files survive
        // a later file that also carries a top-level provider key (deep merge, like
        // opencode's own loader — a top-level spread would drop them)
        fs.writeFileSync(
            path.join(ocDir, "opencode.jsonc"),
            JSON.stringify({
                provider: { wins: { options: { baseURL: "http://from.jsonc/v1" } }, dup: { options: { baseURL: "http://dup-jsonc/v1" } } },
                $schema: "https://opencode.ai/config.json",
            }),
        );
        const merged = readOpencodeConfigRoot(env);
        const providers = (merged?.provider as Record<string, { options: { baseURL: string }; models?: Record<string, { limit: number }> }>) ?? {};
        assert.equal(providers.wins?.options.baseURL, "http://from.jsonc/v1");
        assert.equal(providers.fromjson?.options.baseURL, "http://from.json/v1");
        assert.equal(providers.dup?.options.baseURL, "http://dup-jsonc/v1");
        assert.deepEqual(providers.dup?.models, { m: { limit: 4096 } });

        // OPENCODE_CONFIG layers over the global merge (opencode loads the globals
        // first and merges the explicit file on top — it does not replace them)
        const directFile = path.join(dir, "direct.json");
        fs.writeFileSync(
            directFile,
            JSON.stringify({ provider: { direct: { options: { baseURL: "http://direct/v1" } }, wins: { options: { baseURL: "http://direct-wins/v1" } } } }),
        );
        const direct = readOpencodeConfigRoot({ XDG_CONFIG_HOME: dir, OPENCODE_CONFIG: directFile });
        const directProviders = (direct?.provider as Record<string, { options: { baseURL: string } }>) ?? {};
        assert.equal(directProviders.direct?.options.baseURL, "http://direct/v1");
        assert.equal(directProviders.wins?.options.baseURL, "http://direct-wins/v1");
        assert.equal(directProviders.fromjson?.options.baseURL, "http://from.json/v1");

        assert.equal(readOpencodeConfigRoot({ XDG_CONFIG_HOME: path.join(dir, "empty-xdg") }), undefined);
    } finally {
        rmrf(dir);
    }
});

test("prepareOpencodeHttpRewrite: writes rewritten copy from a JSONC user config, original untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rw-"));
    try {
        const cfgFile = path.join(dir, "opencode.jsonc");
        const original = [
            "{",
            "    // plugin list rides along",
            '    "plugin": ["opencode-acp@latest"],',
            '    "provider": { "zhipuai-lb": { "options": { "baseURL": "http://127.0.0.1:18081/v1" } } },',
            "}",
        ].join("\n");
        fs.writeFileSync(cfgFile, original);
        // empty-xdg keeps this hermetic: OPENCODE_CONFIG layers over whatever
        // lives in the global dir, so point that dir somewhere empty
        const root = readOpencodeConfigRoot({ XDG_CONFIG_HOME: path.join(dir, "empty-xdg"), OPENCODE_CONFIG: cfgFile });
        const rw = [{ key: "zhipuai-lb", realUpstream: "http://127.0.0.1:18081/v1" }];
        const spawnEnv: NodeJS.ProcessEnv = {};
        const tmpFile = prepareOpencodeHttpRewrite(root, "http://127.0.0.1:8787", rw, [], undefined, false, spawnEnv);
        assert.ok(tmpFile);
        const rewritten = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
        assert.equal(rewritten.provider["zhipuai-lb"].options.baseURL, "http://127.0.0.1:8787/bili/http://127.0.0.1:18081/v1");
        // #920: the acp entry is stripped from the clone — the thin plugin
        // imports the package as a library; its spec rides along via env.
        assert.deepEqual(rewritten.plugin, []);
        assert.equal(spawnEnv["BILI_OPENCODE_ACP_SPEC"], "opencode-acp@latest");
        assert.deepEqual(rewritten.compaction, { auto: false });
        assert.equal(fs.readFileSync(cfgFile, "utf8"), original);
        // the caller's merged root must stay pristine (rewrite happens on a clone)
        assert.deepEqual(root, { plugin: ["opencode-acp@latest"], provider: { "zhipuai-lb": { options: { baseURL: "http://127.0.0.1:18081/v1" } } } });
        rmrf(path.dirname(tmpFile));
        assert.equal(prepareOpencodeHttpRewrite(root, "http://127.0.0.1:8787", [], []), undefined);
        const withPlugin = prepareOpencodeHttpRewrite(root, "http://127.0.0.1:8787", [], [], "/opt/bili/dist/agent/opencode.js", false, { ...spawnEnv });
        assert.ok(withPlugin);
        const injected = JSON.parse(fs.readFileSync(withPlugin, "utf8"));
        assert.deepEqual(injected.plugin, ["/opt/bili/dist/agent/opencode.js"]);
        assert.equal(injected.provider["zhipuai-lb"].options.baseURL, "http://127.0.0.1:18081/v1");
        rmrf(path.dirname(withPlugin));
        const missingCfg = prepareOpencodeHttpRewrite(undefined, "http://127.0.0.1:8787", [], [], "/opt/bili/dist/agent/opencode.js");
        assert.ok(missingCfg);
        const fromEmpty = JSON.parse(fs.readFileSync(missingCfg, "utf8"));
        assert.deepEqual(fromEmpty.plugin, ["/opt/bili/dist/agent/opencode.js"]);
        assert.deepEqual(fromEmpty.compaction, { auto: false });
        rmrf(path.dirname(missingCfg));
    } finally {
        rmrf(dir);
    }
});

test("prepareOpencodeHttpRewrite: strips opencode-acp entries in all spec forms (#920)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rw3-"));
    try {
        const root = {
            plugin: [
                "opencode-acp@latest",
                ["opencode-acp@1.2.3", { enabled: true }],
                { package: "./local/opencode-acp" },
                "my-opencode-acp-fork",
                "some-other-plugin",
            ],
            plugins: ["/abs/path/to/node_modules/opencode-acp"],
            provider: {},
        };
        const spawnEnv: NodeJS.ProcessEnv = {};
        const tmpFile = prepareOpencodeHttpRewrite(root, "http://127.0.0.1:8787", [], [], "/opt/bili/dist/agent/opencode.js", false, spawnEnv);
        assert.ok(tmpFile);
        const out = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
        assert.deepEqual(out.plugin, ["my-opencode-acp-fork", "some-other-plugin", "/opt/bili/dist/agent/opencode.js"]);
        assert.deepEqual(out.plugins, []);
        // first stripped spec wins — the copy the host would have loaded first
        assert.equal(spawnEnv["BILI_OPENCODE_ACP_SPEC"], "opencode-acp@latest");
        rmrf(path.dirname(tmpFile));
        // no acp entries → env untouched
        const env2: NodeJS.ProcessEnv = {};
        const plain = prepareOpencodeHttpRewrite({ plugin: ["other"], provider: {} }, "http://127.0.0.1:8787", [], [], "/opt/p.js", false, env2);
        assert.ok(plain);
        assert.equal(env2["BILI_OPENCODE_ACP_SPEC"], undefined);
        rmrf(path.dirname(plain));
    } finally {
        rmrf(dir);
    }
});

test("prepareOpencodeHttpRewrite: pluginDirMode wraps the plugin in an index.js shim dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rw2-"));
    try {
        const tmpFile = prepareOpencodeHttpRewrite({ provider: {} }, "http://127.0.0.1:8787", [], [], "/opt/bili/dist/agent/opencode.js", true);
        assert.ok(tmpFile);
        const injected = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
        const entry = injected.plugin[injected.plugin.length - 1];
        assert.ok(entry !== "/opt/bili/dist/agent/opencode.js");
        assert.ok(fs.statSync(entry).isDirectory());
        const shim = fs.readFileSync(path.join(entry, "index.js"), "utf8");
        assert.match(shim, /export \{ default \} from "\/opt\/bili\/dist\/agent\/opencode\.js";/);
        assert.deepEqual(injected.compaction, { auto: false });
        rmrf(path.dirname(tmpFile));
    } finally {
        rmrf(dir);
    }
});

test("prepareOpencodeHttpRewrite: re-anchors relative local plugin specs against the declaring dir (#826)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rw3-"));
    try {
        const xdg = path.join(dir, "xdg");
        const cfgDir = path.join(xdg, "opencode");
        fs.mkdirSync(cfgDir, { recursive: true });
        const original = JSON.stringify({
            plugin: ["./ntfy.js", "../up/other.js", ["./tupled.js", { flag: true }], "opencode-tps-meter@latest", "/abs/already.js"],
            plugins: [{ package: "./ntfy", options: {} }, { package: "../up/other" }, { package: "npm-pkg@1" }, { package: "/abs/dir" }],
        });
        fs.writeFileSync(path.join(cfgDir, "opencode.json"), original);
        const env = { XDG_CONFIG_HOME: xdg };
        const root = readOpencodeConfigRoot(env);
        const tmpFile = prepareOpencodeHttpRewrite(root, "http://127.0.0.1:8787", [], [], "/opt/bili/dist/agent/opencode.js", true, env);
        assert.ok(tmpFile);
        const cloned = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
        assert.deepEqual(cloned.plugin.slice(0, 5), [
            path.resolve(cfgDir, "./ntfy.js"),
            path.resolve(cfgDir, "../up/other.js"),
            [path.resolve(cfgDir, "./tupled.js"), { flag: true }],
            "opencode-tps-meter@latest",
            "/abs/already.js",
        ]);
        const shimDir = cloned.plugin[cloned.plugin.length - 1] as string;
        assert.notEqual(shimDir, "/opt/bili/dist/agent/opencode.js");
        assert.ok(fs.statSync(shimDir).isDirectory());
        assert.deepEqual(cloned.plugins, [
            { package: path.resolve(cfgDir, "./ntfy"), options: {} },
            { package: path.resolve(cfgDir, "../up/other") },
            { package: "npm-pkg@1" },
            { package: "/abs/dir" },
        ]);
        // original file untouched and the caller's merged root stays pristine
        assert.equal(fs.readFileSync(path.join(cfgDir, "opencode.json"), "utf8"), original);
        assert.equal((root!.plugin as unknown[])[0], "./ntfy.js");
        assert.equal(((root!.plugins as Array<Record<string, unknown>>)[0] as Record<string, unknown>).package, "./ntfy");
        rmrf(path.dirname(tmpFile));
    } finally {
        rmrf(dir);
    }
});

test("prepareOpencodeHttpRewrite: OPENCODE_CONFIG dir wins as the relative-spec base (#826)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-rw4-"));
    try {
        const xdg = path.join(dir, "xdg");
        fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
        const ocDir = path.join(dir, "project");
        fs.mkdirSync(ocDir, { recursive: true });
        const ocFile = path.join(ocDir, "opencode.json");
        fs.writeFileSync(ocFile, JSON.stringify({ plugins: [{ package: "./local" }] }));
        const env = { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG: ocFile };
        const root = readOpencodeConfigRoot(env);
        const tmpFile = prepareOpencodeHttpRewrite(root, "http://127.0.0.1:8787", [], [], "/opt/bili/dist/agent/opencode.js", false, env);
        assert.ok(tmpFile);
        const cloned = JSON.parse(fs.readFileSync(tmpFile, "utf8"));
        assert.deepEqual(cloned.plugins, [{ package: path.resolve(ocDir, "./local") }]);
        rmrf(path.dirname(tmpFile));
    } finally {
        rmrf(dir);
    }
});

test("opencodeMajorVersion: parses --version output, defaults to 1 on failure", () => {
    assert.equal(parseOpencodeMajor("opencode v2.0.3"), 2);
    assert.equal(parseOpencodeMajor("1.14.46"), 1);
    assert.equal(parseOpencodeMajor("no digits here"), undefined);
    assert.equal(opencodeMajorVersion("/nonexistent/bili-test-bin"), 1);
    if (process.platform === "win32") return; // shebang fakes are not executable on Windows
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-ver-"));
    try {
        const mk = (name: string, out: string): string => {
            const f = path.join(dir, name);
            fs.writeFileSync(f, `#!/bin/sh\necho "${out}"\n`);
            fs.chmodSync(f, 0o755);
            return f;
        };
        assert.equal(opencodeMajorVersion(mk("oc-v2.sh", "opencode v2.0.3")), 2);
        assert.equal(opencodeMajorVersion(mk("oc-v1.sh", "1.14.46")), 1);
    } finally {
        rmrf(dir);
    }
});

test("resolveOpencodeConfigFile: OPENCODE_CONFIG wins; first existing file, .jsonc preferred", () => {
    assert.equal(resolveOpencodeConfigFile({ OPENCODE_CONFIG: "/tmp/x.json" }), "/tmp/x.json");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-res-"));
    try {
        const ocDir = path.join(dir, "opencode");
        fs.mkdirSync(ocDir);
        const env = { XDG_CONFIG_HOME: dir };
        // none exists → .jsonc path (opencode's preferred file)
        assert.ok(resolveOpencodeConfigFile(env).endsWith(path.join("opencode", "opencode.jsonc")));
        // only .json → .json
        const jsonFile = path.join(ocDir, "opencode.json");
        fs.writeFileSync(jsonFile, "{}");
        assert.equal(resolveOpencodeConfigFile(env), jsonFile);
        // .jsonc appears → wins
        const jsoncFile = path.join(ocDir, "opencode.jsonc");
        fs.writeFileSync(jsoncFile, "{}");
        assert.equal(resolveOpencodeConfigFile(env), jsoncFile);
        // config.json is last
        fs.rmSync(jsoncFile);
        fs.rmSync(jsonFile);
        const legacyFile = path.join(ocDir, "config.json");
        fs.writeFileSync(legacyFile, "{}");
        assert.equal(resolveOpencodeConfigFile(env), legacyFile);
    } finally {
        rmrf(dir);
    }
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

test("parseHermesYaml: v12 dict base_url/url forms + base_url wins over api", () => {
    const canonical = parseHermesYaml([
        "providers:",
        "  bili:",
        "    name: bili",
        "    base_url: http://127.0.0.1:8199/v1",
        "    transport: openai_chat",
    ].join("\n"));
    assert.equal(canonical.providers.bili?.api, "http://127.0.0.1:8199/v1", "base_url is hermes' canonical form");

    const urlForm = parseHermesYaml("providers:\n  u:\n    url: http://u:1/v1\n");
    assert.equal(urlForm.providers.u?.api, "http://u:1/v1");

    const priority = parseHermesYaml([
        "providers:",
        "  p:",
        "    api: http://stale:1/v1",
        "    base_url: http://fresh:1/v1",
    ].join("\n"));
    assert.equal(priority.providers.p?.api, "http://fresh:1/v1", "base_url beats api (hermes priority)");
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
        rmrf(dir);
    }
});

test("discoverRoutes: hermes splits https → MITM domains, http → forward-proxy inventory (#535)", () => {
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
    assert.deepEqual(routes.httpsDomains, ["open.bigmodel.cn", "api.foo.io"]);
    // httpRewrites is inventory-only for hermes (banner + no-provider
    // warning); nothing is rewritten and the real config.yaml is untouched.
    assert.deepEqual(routes.httpRewrites.map((r) => r.key).sort(), ["sglang"]);
    const sglang = routes.httpRewrites.find((r) => r.key === "sglang");
    assert.equal(sglang?.realUpstream, "http://127.0.0.1:8199/v1");
});

test("readDshConfig + resolveDshHome + parseDshSettingsYaml", () => {
    assert.equal(resolveDshHome({ DSH_HOME: "/tmp/dd" }), "/tmp/dd");
    assert.ok(resolveDshHome({}).endsWith(path.join(".dsh")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cfg-"));
    try {
        assert.deepEqual(readDshConfig(path.join(dir, "nope")).baseUrls, []);
        fs.writeFileSync(
            path.join(dir, "settings.yaml"),
            [
                "llm-pi-ai:",
                "  providers:",
                "    anthropic:",
                "      baseURL: https://api.anthropic.com",
                "    sglang:",
                "      baseURL: http://127.0.0.1:8199/v1",
                "llm-deepseek:",
                "  baseURL: https://relay.example.com",
                "other:",
                "  base_url: http://10.0.0.5:1234/v1",
                "  noturl: notaurl",
            ].join("\n"),
        );
        const cfg = readDshConfig(dir);
        assert.deepEqual(cfg.baseUrls, [
            "https://api.anthropic.com",
            "http://127.0.0.1:8199/v1",
            "https://relay.example.com",
            "http://10.0.0.5:1234/v1",
        ]);
        assert.deepEqual(parseDshSettingsYaml('x:\n  baseURL: \'"notaurl\"\'\n'), []);
        assert.deepEqual(parseDshSettingsYaml('x:\n  baseURL: "https://api.quoted.io/v1"\n'), ["https://api.quoted.io/v1"]);
    } finally {
        rmrf(dir);
    }
});

test("discoverRoutes: dsh splits by destination — loopback rewrote, rest proxied (#535 phase 4)", () => {
    const config: ClientConfig = {};
    (config as Record<string, unknown>).dsh = {
        baseUrls: [
            "http://127.0.0.1:8199/v1",
            "https://localhost:8443/v1",
            "https://open.bigmodel.cn/api/paas/v4",
            "http://127.0.0.1:8787/bili/https://api.foo.io/v1",
            "http://10.0.0.5:1234/v1",
            "http://127.0.0.1:8199/v1",
            "::::",
        ],
    };
    const routes = discoverRoutes("dsh", config);
    // loopback (http OR https) → settings.yaml /bili/ rewrite; non-loopback
    // https → cert-MITM whitelist; wrapped values unwrap first (legacy
    // self-heal); non-loopback plain-http → HTTP_PROXY absolute-form routing.
    assert.deepEqual(
        routes.httpRewrites.map((r) => r.realUpstream).sort(),
        ["http://127.0.0.1:8199/v1", "https://localhost:8443/v1"],
    );
    assert.deepEqual(routes.httpsDomains, ["open.bigmodel.cn", "api.foo.io"]);
    assert.deepEqual(routes.httpEnvRoutes, ["http://10.0.0.5:1234/v1"]);
});

test("isLoopbackHost: localhost / ::1 / 127.x only", () => {
    for (const h of ["localhost", "LOCALHOST", "::1", "[::1]", "127.0.0.1", "127.5.6.7"]) {
        assert.equal(isLoopbackHost(h), true, h);
    }
    for (const h of ["1270.0.0.1", "127.evil.com", "127.abc.def", "10.0.0.1", "192.168.1.1", "open.bigmodel.cn", ""]) {
        assert.equal(isLoopbackHost(h), false, h);
    }
});

test("prepareDshHome: rewrites baseURL lines, shares siblings, never touches the real home", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
    try {
        fs.writeFileSync(
            path.join(dir, "settings.yaml"),
            [
                "llm-pi-ai:",
                "  providers:",
                "    anthropic:",
                "      baseURL: https://api.anthropic.com  # official",
                "    sglang:",
                "      baseURL: http://127.0.0.1:8199/v1",
                "llm-deepseek:",
                "  baseURL: https://relay.example.com",
                "unrelated: true",
            ].join("\n"),
        );
        fs.writeFileSync(path.join(dir, ".credentials.yaml"), "DEEPSEEK_API_KEY: sk-x");
        fs.mkdirSync(path.join(dir, "profiles"));
        const original = fs.readFileSync(path.join(dir, "settings.yaml"), "utf8");

        const rewrites: HttpRewrite[] = [
            { key: "dsh-1", realUpstream: "https://api.anthropic.com" },
            { key: "dsh-2", realUpstream: "http://127.0.0.1:8199/v1" },
            { key: "dsh-3", realUpstream: "https://relay.example.com" },
        ];
        const overlay = prepareDshHome(dir, "http://127.0.0.1:8787", rewrites);
        assert.ok(overlay);
        const txt = fs.readFileSync(path.join(overlay, "settings.yaml"), "utf8");
        assert.ok(txt.includes("baseURL: http://127.0.0.1:8787/bili/https://api.anthropic.com  # official"));
        assert.ok(txt.includes("baseURL: http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1"));
        assert.ok(txt.includes("baseURL: http://127.0.0.1:8787/bili/https://relay.example.com"));
        assert.ok(txt.includes("unrelated: true"));
        assert.equal(fs.readFileSync(path.join(dir, "settings.yaml"), "utf8"), original);
        assert.equal(fs.readFileSync(path.join(overlay, ".credentials.yaml"), "utf8"), "DEEPSEEK_API_KEY: sk-x");
        assert.ok(fs.lstatSync(path.join(overlay, "profiles")).isSymbolicLink());
        rmrf(overlay);

        assert.equal(prepareDshHome(dir, "http://127.0.0.1:8787", []), undefined);
    } finally {
        rmrf(dir);
    }
});

test("prepareDshHome: preserves CRLF line endings when rewriting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
    try {
        fs.writeFileSync(
            path.join(dir, "settings.yaml"),
            ["llm-pi-ai:", "  providers:", "    x:", "      baseURL: http://127.0.0.1:8199/v1"].join("\r\n") + "\r\n",
        );
        const rewrites: HttpRewrite[] = [{ key: "dsh-1", realUpstream: "http://127.0.0.1:8199/v1" }];
        const overlay = prepareDshHome(dir, "http://127.0.0.1:8787", rewrites);
        assert.ok(overlay);
        const txt = fs.readFileSync(path.join(overlay, "settings.yaml"), "utf8");
        assert.ok(txt.includes("\r\n"), "CRLF preserved");
        assert.ok(!/\r\n\r\n/.test(txt), "no doubled newlines");
        assert.ok(txt.includes("baseURL: http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1\r"));
        rmrf(overlay);
    } finally {
        rmrf(dir);
    }
});

test("writeDshAcpPatch: writes insert overlay with file:// plugin URL into <home>-bili", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-patch-"));
    try {
        const file = writeDshAcpPatch(dir);
        assert.ok(file);
        assert.equal(file, path.join(`${dir}-bili`, ".bili-acp.patch.yml"));
        const txt = fs.readFileSync(file, "utf8");
        assert.ok(txt.startsWith("- insert:\n"));
        assert.match(txt, /^ {4}- id: bili-native\n {6}name: file:\/\/.+dsh-native\.js$/m);
        // #3662: the always-on gate entry mounts alongside bili-native in the URL lane too
        assert.match(txt, /^ {4}- id: bili-compaction-gate\n {6}name: file:\/\/.+dsh-compaction-gate\.js$/m);
        assert.match(txt, /^- id: compaction-basic\n  config:\n    auto: false\n/m);
        assert.match(txt, /^- id: llm-deepseek\n  config:\n    retryPolicy:\n      mode: normal\n      retryableCodes: \[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE\]\n/m);
        assert.match(txt, /^- id: llm-deepseek-account\n  config:\n    retryPolicy:\n      mode: normal\n      retryableCodes: \[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE\]\n$/m);
        rmrf(`${dir}-bili`);
    } finally {
        rmrf(dir);
    }
});

test("writeDshAcpPatch: honors an explicit bare-specifier entry name (#1590)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-patch-"));
    try {
        const file = writeDshAcpPatch(dir, "billion-context");
        assert.ok(file);
        const txt = fs.readFileSync(file, "utf8");
        assert.match(txt, /^ {4}- id: bili-native\n {6}name: billion-context$/m);
        // #3662: the bare lane resolves the gate through the shim's subpath export
        assert.match(txt, /^ {4}- id: bili-compaction-gate\n {6}name: billion-context\/dsh-compaction-gate$/m);
        rmrf(`${dir}-bili`);
    } finally {
        rmrf(dir);
    }
});

test("writeDshClientShimFiles + dshPluginEntry: resolvable shim yields the bare entry, missing or broken shim falls back to the file URL (#1590)", (t) => {
    if (!supportsFileSymlink()) {
        t.skip("the shim contract requires file symlinks for live bundle updates");
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-shim-"));
    try {
        // os.tmpdir() sits inside this repo: a differently-named package.json
        // above the probe anchor stops Node's self-name resolution from
        // "finding" billion-context in the checkout instead of the fixture.
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bili-launcher-fixture", version: "0.0.0" }));
        const home = path.join(dir, ".dsh");
        fs.mkdirSync(home);
        const hostBundle = path.join(dir, "agent", "dsh-native.js");
        const clientBundle = path.join(dir, "agent", "dsh-native-client.js");
        const gateBundle = path.join(dir, "agent", "dsh-compaction-gate.js");
        fs.mkdirSync(path.dirname(hostBundle), { recursive: true });
        fs.writeFileSync(hostBundle, "// host\n");
        fs.writeFileSync(clientBundle, "// client\n");
        fs.writeFileSync(gateBundle, "// gate\n");
        const shimDir = path.join(home, "node_modules", "billion-context");

        assert.equal(writeDshClientShimFiles(shimDir, hostBundle, clientBundle, "0.1.169", gateBundle), true);
        const shimPkg = JSON.parse(fs.readFileSync(path.join(shimDir, "package.json"), "utf8"));
        assert.equal(shimPkg.name, "billion-context");
        // #3662: the bare lane resolves the gate entry through this subpath export
        assert.deepEqual(shimPkg.exports, { ".": "./index.js", "./dsh": "./index.js", "./package.json": "./package.json", "./dsh/package.json": "./package.json", "./client": "./bundle.js", "./dsh-compaction-gate": "./gate.js" });
        assert.equal(shimPkg.dsh.client.platform, "web");
        // The bundles are SYMLINKS into bili's live dist — an auto-update that
        // moves dist self-heals on the next launch without rewriting the shim.
        assert.equal(fs.realpathSync(path.join(shimDir, "index.js")), fs.realpathSync(hostBundle));
        assert.equal(fs.realpathSync(path.join(shimDir, "bundle.js")), fs.realpathSync(clientBundle));
        assert.equal(fs.realpathSync(path.join(shimDir, "gate.js")), fs.realpathSync(gateBundle));

        // Resolvable from the home's walk-up chain, and the root import
        // lands on the host module itself ⇒ the bare entry.
        assert.equal(dshPluginEntry(home), "billion-context");

        // #3043: dsh's client scanner locates the package root via
        // require.resolve("billion-context/package.json") before reading dsh.client.
        // Node's closed `exports` map throws ERR_PACKAGE_PATH_NOT_EXPORTED for any
        // unlisted subpath — omit "./package.json" here (as in the published pkg)
        // and the scanner swallows the throw, so the browser half never registers.
        const shimRequire = createRequire(path.join(home, "probe.cjs"));
        assert.equal(shimRequire.resolve("billion-context/package.json"), path.join(shimDir, "package.json"));

        // A shim whose root "." export points elsewhere (e.g. a real install
        // whose root is the CLI entry, not the dsh host half) must NOT claim
        // the bare lane: importing the root would boot the CLI inside dsh.
        // Built in a SEPARATE home: the CJS loader caches package.json reads
        // per path per process, so mutating the first shim in place would be
        // invisible to the next resolve.
        const home2 = path.join(dir, ".dsh2");
        fs.mkdirSync(home2);
        const shimDir2 = path.join(home2, "node_modules", "billion-context");
        assert.equal(writeDshClientShimFiles(shimDir2, hostBundle, clientBundle, "0.1.169"), true);
        const pkg2 = path.join(shimDir2, "package.json");
        fs.writeFileSync(pkg2, JSON.stringify({ ...JSON.parse(fs.readFileSync(pkg2, "utf8")), exports: { ".": "./other.js" } }));
        fs.writeFileSync(path.join(shimDir2, "other.js"), "// not the host half\n");
        assert.match(dshPluginEntry(home2), /^file:\/\/.+dsh-native\.js$/);

        // A stale shim (resolved package.json but dangling index.js symlink)
        // degrades to the legacy file URL instead of failing dsh boot.
        fs.rmSync(path.join(shimDir, "index.js"));
        assert.match(dshPluginEntry(home), /^file:\/\/.+dsh-native\.js$/);

        // No shim at all: the same fallback.
        rmrf(shimDir);
        assert.match(dshPluginEntry(home), /^file:\/\/.+dsh-native\.js$/);

        // Missing dist bundles: nothing written, existing content untouched.
        const other = path.join(dir, "nm", "billion-context");
        fs.mkdirSync(other, { recursive: true });
        fs.writeFileSync(path.join(other, "keep.txt"), "x");
        assert.equal(writeDshClientShimFiles(other, path.join(dir, "missing.js"), clientBundle, "0.0.0"), false);
        assert.equal(fs.readFileSync(path.join(other, "keep.txt"), "utf8"), "x");

        // #3662: a missing gate bundle degrades to the pre-gate shim (no export,
        // no dangling symlink) instead of failing the whole shim.
        const other2 = path.join(dir, "nm2", "billion-context");
        fs.mkdirSync(other2, { recursive: true });
        assert.equal(writeDshClientShimFiles(other2, hostBundle, clientBundle, "0.0.0", path.join(dir, "missing-gate.js")), true);
        const shimPkg3 = JSON.parse(fs.readFileSync(path.join(other2, "package.json"), "utf8"));
        assert.ok(!Object.hasOwn(shimPkg3.exports, "./dsh-compaction-gate"));
        assert.ok(!fs.existsSync(path.join(other2, "gate.js")));
    } finally {
        rmrf(dir);
    }
});

test("writeDshClientShim: stamps the real bili version into the shim package.json (#1590)", (t) => {
    const root = selfPackageRoot();
    if (!fs.existsSync(path.join(root, "dist", "agent", "dsh-native.js")) || !fs.existsSync(path.join(root, "dist", "agent", "dsh-native-client.js")) || !fs.existsSync(path.join(root, "dist", "agent", "dsh-compaction-gate.js"))) {
        t.skip("needs a built dist (npm run build first)");
        return;
    }
    if (!supportsFileSymlink()) {
        t.skip("the shim contract requires file symlinks for live bundle updates");
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-shimver-"));
    try {
        const home = path.join(dir, ".dsh");
        fs.mkdirSync(home);
        assert.equal(writeDshClientShim(home), true);
        const shimPkg = JSON.parse(fs.readFileSync(path.join(home, "node_modules", "billion-context", "package.json"), "utf8"));
        const repoPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        assert.equal(shimPkg.version, repoPkg.version);
        // #3662: the real-dist shim carries the gate subpath export for the bare lane
        assert.equal(shimPkg.exports["./dsh-compaction-gate"], "./gate.js");
    } finally {
        rmrf(dir);
    }
});

test("dshArgsWithPatch: splices --patch by dsh argv shape", () => {
    const patch = "/tmp/x/.bili-acp.patch.yml";
    assert.deepEqual(dshArgsWithPatch(["--profile", "headless", "task"], patch), ["--patch", patch, "--profile", "headless", "task"]);
    assert.deepEqual(dshArgsWithPatch([], patch), ["--patch", patch]);
    assert.deepEqual(dshArgsWithPatch(["web", "--port", "3080"], patch), ["web", "--patch", patch, "--port", "3080"]);
    assert.deepEqual(dshArgsWithPatch(["plugin", "--profile", "web", "add", "pkg"], patch), ["plugin", "--profile", "web", "add", "pkg"]);
    assert.deepEqual(dshArgsWithPatch(["--dump-default-config"], patch), ["--dump-default-config"]);
});

test("prepareDshHome: returns undefined for unreadable settings even with rewrites pending", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
    try {
        const rewrites: HttpRewrite[] = [{ key: "dsh-1", realUpstream: "http://127.0.0.1:8199/v1" }];
        assert.equal(prepareDshHome(dir, "http://127.0.0.1:8787", rewrites), undefined);
    } finally {
        rmrf(dir);
    }
});

test("resolveCodexHome: honours CODEX_HOME, defaults to ~/.codex", () => {
    assert.equal(resolveCodexHome({ CODEX_HOME: "/tmp/cx" }), "/tmp/cx");
    assert.ok(resolveCodexHome({}).endsWith(".codex"));
});

test("prepareCodexHome: no real config → overlay holds only the bili MCP block, siblings shared, real home untouched (#681)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-home-"));
    const origin = "http://127.0.0.1:8787";
    const cid = "conv-1";
    try {
        fs.writeFileSync(path.join(dir, "auth.json"), '{"id_token":"x"}');
        fs.mkdirSync(path.join(dir, "sessions"));
        const authOriginal = fs.readFileSync(path.join(dir, "auth.json"), "utf8");

        const overlay = prepareCodexHome({ codexHome: dir, origin, caPath: "/ca.pem", conversationId: cid, manageRouting: false });
        assert.ok(overlay);
        assert.equal(overlay, `${dir}-bili`);
        const txt = fs.readFileSync(path.join(overlay, "config.toml"), "utf8");
        assert.equal((txt.match(/\[mcp_servers\.bili\]/g) ?? []).length, 1);
        assert.ok(txt.includes(`command = ${JSON.stringify(process.execPath)}`));
        assert.match(txt, /args = \[.*mcp\.js.*\]/);
        assert.ok(txt.includes(`BILI_MCP_PROXY = ${JSON.stringify(origin)}`));
        assert.ok(txt.includes(`BILI_CONVERSATION_ID = ${JSON.stringify(cid)}`));
        // the command value must be a quoted TOML basic string — only then does a spaced/quoted Windows path survive being read from the file
        assert.match(txt, /^command = ".+"$/m);
        const authStat = fs.lstatSync(path.join(overlay, "auth.json"));
        assert.ok(authStat.isSymbolicLink() || authStat.nlink > 1);
        assert.ok(fs.lstatSync(path.join(overlay, "sessions")).isSymbolicLink());
        assert.equal(fs.readFileSync(path.join(dir, "auth.json"), "utf8"), authOriginal);
        assert.ok(!fs.existsSync(path.join(dir, "config.toml")));
        rmrf(overlay);
    } finally {
        rmrf(dir);
    }
});

test("prepareCodexHome: real config without bili → original preserved, block appended once (#681)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-home-"));
    try {
        fs.writeFileSync(
            path.join(dir, "config.toml"),
            ['model = "gpt-5"', "", '[model_providers.openai]', 'name = "OpenAI"', ''].join("\n"),
        );
        const original = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
        const overlay = prepareCodexHome({ codexHome: dir, origin: "http://127.0.0.1:8787", caPath: "/ca.pem", conversationId: "conv-2", manageRouting: false });
        assert.ok(overlay);
        const txt = fs.readFileSync(path.join(overlay, "config.toml"), "utf8");
        assert.ok(txt.includes('model = "gpt-5"'));
        assert.ok(txt.includes('[model_providers.openai]'));
        assert.equal((txt.match(/\[mcp_servers\.bili\]/g) ?? []).length, 1);
        assert.equal(fs.readFileSync(path.join(dir, "config.toml"), "utf8"), original);
        rmrf(overlay);
    } finally {
        rmrf(dir);
    }
});

test("prepareCodexHome: pre-existing [mcp_servers.bili] is replaced, never duplicated (#681)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-home-"));
    try {
        fs.writeFileSync(
            path.join(dir, "config.toml"),
            [
                "model = \"gpt-5\"",
                "",
                "[mcp_servers.bili]",
                "command = \"/old/path/node\"",
                "args = [\"/old/mcp.js\"]",
                "env = { BILI_MCP_PROXY = \"http://old:1\" }",
                "",
                "[other_table]",
                "keep = \"me\"",
                "",
            ].join("\n"),
        );
        const overlay = prepareCodexHome({ codexHome: dir, origin: "http://127.0.0.1:8787", caPath: "/ca.pem", conversationId: "conv-3", manageRouting: false });
        assert.ok(overlay);
        const txt = fs.readFileSync(path.join(overlay, "config.toml"), "utf8");
        assert.equal((txt.match(/\[mcp_servers\.bili\]/g) ?? []).length, 1, "exactly one bili block");
        assert.ok(!txt.includes("/old/path/node"), "stale install block removed");
        assert.ok(!txt.includes("http://old:1"), "stale proxy origin removed");
        assert.ok(txt.includes(`BILI_CONVERSATION_ID = ${JSON.stringify("conv-3")}`), "per-spawn conversation id added");
        assert.ok(txt.includes('model = "gpt-5"'), "unrelated top-level key kept");
        assert.ok(txt.includes('[other_table]') && txt.includes('keep = "me"'), "unrelated table kept");
        rmrf(overlay);
    } finally {
        rmrf(dir);
    }
});

test("prepareCodexMcpInjection: redirects CODEX_HOME to the overlay on every platform, no inline -c args (#681/#1802)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-home-"));
    try {
        fs.writeFileSync(path.join(dir, "auth.json"), "{}");
        const r = prepareCodexMcpInjection({
            codexHome: dir,
            origin: "http://127.0.0.1:8787",
            caPath: "/ca.pem",
            conversationId: "conv-w",
            manageRouting: false,
        });
        assert.deepEqual(r.clientArgs, [], "no inline -c args anywhere");
        assert.equal(r.envPatch.CODEX_HOME, `${dir}-bili`);
        assert.ok(fs.existsSync(path.join(`${dir}-bili`, "config.toml")));
        const txt = fs.readFileSync(path.join(`${dir}-bili`, "config.toml"), "utf8");
        assert.equal((txt.match(/\[mcp_servers\.bili\]/g) ?? []).length, 1);
        rmrf(`${dir}-bili`);
    } finally {
        rmrf(dir);
    }
});

test("prepareCodexMcpInjection: routing-only launch (no MCP) still builds the overlay for .env protection (#1802)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cx-home-"));
    try {
        fs.writeFileSync(path.join(dir, ".env"), "HTTPS_PROXY=socks5h://127.0.0.1:7890\nOPENAI_API_KEY=sk-user\n");
        const r = prepareCodexMcpInjection({
            codexHome: dir,
            origin: "http://127.0.0.1:8787",
            caPath: "/ca.pem",
            manageRouting: true,
        });
        assert.equal(r.warning, undefined);
        assert.equal(r.envPatch.CODEX_HOME, `${dir}-bili`);
        assert.ok(!fs.existsSync(path.join(`${dir}-bili`, "config.toml")) || fs.lstatSync(path.join(`${dir}-bili`, "config.toml")).isSymbolicLink(), "config.toml stays shared without a conversation id");
        const envText = fs.readFileSync(path.join(`${dir}-bili`, ".env"), "utf8");
        assert.ok(envText.includes("HTTPS_PROXY=http://127.0.0.1:8787"));
        rmrf(`${dir}-bili`);
    } finally {
        rmrf(dir);
    }
});

test("runLaunch dsh: non-loopback upstreams ride proxy envs, loopback keeps the overlay (#535 phase 4)", async (t) => {
    if (!supportsFileSymlink()) {
        t.skip("the dsh live shim contract requires file symlinks for live bundle updates");
        return;
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-launch-"));
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevDshHome = process.env.DSH_HOME;
    const prevNoProxy = process.env.NO_PROXY;
    const dshHome = path.join(home, ".dsh");
    fs.mkdirSync(dshHome);
    fs.writeFileSync(
        path.join(dshHome, "settings.yaml"),
        [
            "llm-pi-ai:",
            "  providers:",
            "    anthropic:",
            "      baseURL: https://api.anthropic.com",
            "    sglang:",
            "      baseURL: http://127.0.0.1:8199/v1",
        ].join("\n"),
    );
    fs.mkdirSync(path.join(dshHome, "profiles"));
    const original = fs.readFileSync(path.join(dshHome, "settings.yaml"), "utf8");
    // A differently-named package.json above the probe anchor: os.tmpdir()
    // can sit inside a billion-context checkout (as it does in this sandbox),
    // and tsx's resolver checks the nearest enclosing package.json for a
    // self-name match BEFORE walking node_modules — without the guard the
    // probe would resolve against the checkout's own package.json instead of
    // the fixture/shim below. It must sit on the overlay anchor's walk-up
    // chain (home root), not merely beside it.
    fs.writeFileSync(path.join(home, "package.json"), JSON.stringify({ name: "bili-dsh-launch-fixture", version: "0.0.0" }));
    const dshTree = path.join(home, "dshhost");
    fs.mkdirSync(path.join(dshTree, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dshTree, "package.json"), JSON.stringify({ name: "dsh-fake-host", version: "0.0.0" }));
    // #1590: pre-seed the resolvable shim where runLaunch probes it (the
    // overlay home — loopback rewrites are pending here, so the overlay
    // exists). Keeps the bare-entry assertion deterministic on trees without
    // a build: runLaunch's own writeDshClientShim only overwrites the fixture
    // with real dist symlinks when bili's dist bundles exist. The fixture
    // files MUST be named agent/dsh-native.js / -client.js: dshPluginEntry's
    // identity check requires the resolved root's realpath to end with
    // agent/dsh-native.js — mere resolvability is not enough (#1889).
    const hostFixture = path.join(home, "agent", "dsh-native.js");
    const clientFixture = path.join(home, "agent", "dsh-native-client.js");
    fs.mkdirSync(path.dirname(hostFixture), { recursive: true });
    fs.writeFileSync(hostFixture, "// host\n");
    fs.writeFileSync(clientFixture, "// client\n");
    assert.equal(writeDshClientShimFiles(path.join(`${dshHome}-bili`, "node_modules", "billion-context"), hostFixture, clientFixture, "0.1.169"), true);
    const fakeDsh = path.join(dshTree, "bin", process.platform === "win32" ? "fake-dsh.exe" : "fake-dsh");
    fs.writeFileSync(fakeDsh, "");
    process.env.BILI_CLIENT_BIN = fakeDsh;
    process.env.DSH_HOME = dshHome;
    process.env.NO_PROXY = "localhost,.corp";

    const envSeen: NodeJS.ProcessEnv[] = [];
    const argsSeen: string[][] = [];
    const proxyEnvs: NodeJS.ProcessEnv[] = [];
    const spawnImpl: SpawnFn = (cmd, args, options) => {
        if (cmd === fakeDsh) {
            if (options?.env) envSeen.push(options.env);
            argsSeen.push([...args]);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        if (options?.env) proxyEnvs.push(options.env);
        return makeFakeChild(42423);
    };

    const prevExit = process.exit;
    const exitCalls: number[] = [];
    process.exit = ((code?: number) => {
        exitCalls.push(code ?? 0);
        return undefined as never;
    }) as typeof process.exit;

    try {
        await runLaunch(
            { client: "dsh", clientArgs: ["--profile", "headless", "task"], overrides: {} },
            // hermetic: never attach to / handshake against a real proxy
            // whose instance file happens to live on this machine
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve(), readInstanceFile: () => undefined },
        );
        assert.equal(envSeen.length, 1);
        const seenEnv = envSeen[0];
        const origin = seenEnv.BILLION_CONTEXT_PROXY;
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)));
        assert.equal(seenEnv.DEEPSEEK_BASE_URL, `${origin}/bili/https://api.deepseek.com`);
        // Session identity for the proxy: forces dsh's pi-ai stack to stamp
        // prompt_cache_key (the dsh session id) on every request.
        assert.equal(seenEnv.PI_CACHE_RETENTION, "long");
        // Non-loopback upstreams ride the proxy envs; the combined bundle is
        // mandatory because SSL_CERT_FILE replaces dsh's trust store. Proxy
        // vars are fully stripped (same contract as hermes): dsh's loopback
        // exclusion comes from its built-in policy, not from NO_PROXY.
        assert.equal(seenEnv.HTTPS_PROXY, origin);
        assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")));
        // #710: Windows official Node ignores SSL_CERT_FILE and reads only
        // NODE_EXTRA_CA_CERTS — both must carry the combined bundle.
        assert.ok(String(seenEnv.NODE_EXTRA_CA_CERTS).endsWith(path.join("billion-context", "ca", "combined-ca.pem")));
        assert.equal(seenEnv.HTTP_PROXY, undefined);
        assert.equal(seenEnv.NO_PROXY, undefined);
        // Loopback sglang stays on the /bili/ rewrite path via the persistent
        // overlay — and ONLY the loopback endpoint gets rewritten there.
        assert.equal(seenEnv.DSH_HOME, `${dshHome}-bili`);
        assert.deepEqual(exitCalls, [0]);
        assert.equal(fs.readFileSync(path.join(dshHome, "settings.yaml"), "utf8"), original);
        const overlay = `${dshHome}-bili`;
        const overlayTxt = fs.readFileSync(path.join(overlay, "settings.yaml"), "utf8");
        assert.ok(overlayTxt.includes(`baseURL: ${origin}/bili/http://127.0.0.1:8199/v1`));
        assert.ok(overlayTxt.includes("baseURL: https://api.anthropic.com"));
        assert.ok(fs.lstatSync(path.join(overlay, "profiles")).isSymbolicLink());
        // The MITM whitelist carries the non-loopback https host.
        assert.ok(proxyEnvs.length > 0);
        assert.ok(String(proxyEnvs[0].BILI_MITM_DOMAINS).split(",").includes("api.anthropic.com"));
        // /acp command injection: --patch flag spliced before user args, and
        // the patch overlay file exists pointing at our bundled cordis plugin.
        const patchFile = path.join(overlay, ".bili-acp.patch.yml");
        assert.ok(fs.existsSync(patchFile));
        const patchTxt = fs.readFileSync(patchFile, "utf8");
        assert.ok(patchTxt.startsWith("- insert:\n"));
        // #1590: the launcher seeds a resolvable shim under the DSH_HOME
        // walk-up chain ⇒ bare specifier (lets dsh load the host half AND its
        // client scanner attach the browser half), not the legacy file URL;
        // NODE_PATH points the scanner's CJS resolution at the base home.
        assert.ok(/- id: bili-native\n {6}name: billion-context\n/.test(patchTxt));
        assert.match(patchTxt, /^- id: compaction-basic\n  config:\n    auto: false\n/m);
        assert.match(patchTxt, /^- id: llm-deepseek\n  config:\n    retryPolicy:\n      mode: normal\n      retryableCodes: \[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE\]\n/m);
        assert.match(patchTxt, /^- id: llm-deepseek-account\n  config:\n    retryPolicy:\n      mode: normal\n      retryableCodes: \[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE\]\n$/m);
        assert.ok(String(seenEnv.NODE_PATH ?? "").startsWith(path.join(dshHome, "node_modules")), `NODE_PATH seeds the scanner: ${seenEnv.NODE_PATH}`);
        assert.deepEqual(argsSeen[0], ["--patch", patchFile, "--profile", "headless", "task"]);
        rmrf(overlay);
    } finally {
        process.exit = prevExit;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
        rmrf(home);
    }
});

test("runLaunch dsh: no loopback custom providers — no DSH_HOME overlay (#535 phase 4)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-launch-"));
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevDshHome = process.env.DSH_HOME;
    const dshHome = path.join(home, ".dsh");
    fs.mkdirSync(dshHome);
    fs.writeFileSync(
        path.join(dshHome, "settings.yaml"),
        [
            "llm-pi-ai:",
            "  providers:",
            "    anthropic:",
            "      baseURL: https://api.anthropic.com",
        ].join("\n"),
    );
    const fakeDsh = path.join(home, process.platform === "win32" ? "fake-dsh.exe" : "fake-dsh");
    fs.writeFileSync(fakeDsh, "");
    process.env.BILI_CLIENT_BIN = fakeDsh;
    process.env.DSH_HOME = dshHome;

    const envSeen: NodeJS.ProcessEnv[] = [];
    const spawnImpl: SpawnFn = (cmd, args, options) => {
        if (cmd === fakeDsh) {
            if (options?.env) envSeen.push(options.env);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        return makeFakeChild(42423);
    };

    const prevExit = process.exit;
    process.exit = ((code?: number) => {
        return undefined as never;
    }) as typeof process.exit;

    try {
        await runLaunch(
            { client: "dsh", clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve(), readInstanceFile: () => undefined },
        );
        assert.equal(envSeen.length, 1);
        const seenEnv = envSeen[0];
        const origin = seenEnv.BILLION_CONTEXT_PROXY;
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)));
        // The single non-loopback https provider still rides cert MITM...
        assert.equal(seenEnv.HTTPS_PROXY, origin);
        // ...but nothing needs the settings rewrite, so no overlay redirect —
        // the inherited DSH_HOME (the real home discovery read) passes through
        // unchanged; the -bili dir only holds the /acp patch file written by
        // writeDshAcpPatch.
        assert.equal(seenEnv.DSH_HOME, dshHome);
        assert.equal(fs.existsSync(path.join(`${dshHome}-bili`, "settings.yaml")), false);
        assert.ok(fs.existsSync(path.join(`${dshHome}-bili`, ".bili-acp.patch.yml")));
    } finally {
        process.exit = prevExit;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        if (prevDshHome === undefined) delete process.env.DSH_HOME;
        else process.env.DSH_HOME = prevDshHome;
        rmrf(home);
    }
});

test("resolveNodeRuntime: a live Node executable wins without consulting PATH (#819)", () => {
    assert.equal(resolveNodeRuntime("/usr/local/bin/node", { PATH: "" }, "linux", () => false), "/usr/local/bin/node");
    assert.equal(resolveNodeRuntime("C:/nodejs/node.exe", {}, "win32", () => false), "C:/nodejs/node.exe");
});

test("resolveNodeRuntime: non-Node host uses the BILLION_CONTEXT_NODE override when it exists", () => {
    const exists = (p: string): boolean => p === "/opt/runtimes/node";
    assert.equal(
        resolveNodeRuntime("/usr/bin/opencode", { BILLION_CONTEXT_NODE: "  /opt/runtimes/node ", PATH: "" }, "linux", exists),
        "/opt/runtimes/node",
    );
    // an override pointing at a missing file is ignored — the PATH search still runs
    assert.equal(
        resolveNodeRuntime("/usr/bin/opencode", { BILLION_CONTEXT_NODE: "/missing/node", PATH: "/usr/local/bin" }, "linux", (p) => p === "/usr/local/bin/node", undefined, undefined, () => 20),
        "/usr/local/bin/node",
    );
});

test("resolveNodeRuntime: PATH search finds node for non-Node hosts (posix + win32 shapes)", () => {
    const posixExists = (p: string): boolean => p === "/opt/host/bin/node";
    assert.equal(
        resolveNodeRuntime("/snap/opencode/current/usr/bin/opencode", { PATH: "/nonexistent:/opt/host/bin" }, "linux", posixExists, undefined, undefined, () => 20),
        "/opt/host/bin/node",
    );
    // forward-slash fake paths keep the join platform-independent on any CI host
    const winExists = (p: string): boolean => p === "C:/Program Files/nodejs/node.exe";
    assert.equal(
        resolveNodeRuntime("C:/opencode/opencode.exe", { PATH: "C:/nope;C:/Program Files/nodejs" }, "win32", winExists, undefined, undefined, () => 20),
        "C:/Program Files/nodejs/node.exe",
    );
});

test("resolveNodeRuntime: throws with the actionable message when nothing resolves", () => {
    assert.throws(
        () => resolveNodeRuntime("/usr/bin/opencode", { PATH: "/nonexistent" }, "linux", () => false),
        /BILLION_CONTEXT_NODE/,
    );
});

test("resolveNodeRuntime: GUI/Electron host finds node in a well-known dir its PATH omits (#1429)", () => {
    const exists = (p: string): boolean => p === "/usr/local/bin/node";
    assert.equal(
        resolveNodeRuntime(
            "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
            { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
            "linux",
            exists,
            "33.0.0",
            undefined,
            () => 20,
        ),
        "/usr/local/bin/node",
    );
});

test("resolveNodeRuntime: Electron host with no Node anywhere falls back to its own binary (#1429)", () => {
    assert.equal(
        resolveNodeRuntime(
            "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
            { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
            "linux",
            () => false,
            "33.0.0",
        ),
        "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness",
    );
});

test("resolveNodeRuntime: a real node on PATH beats the Electron fallback (#1429)", () => {
    const exists = (p: string): boolean => p === "/opt/host/bin/node";
    assert.equal(
        resolveNodeRuntime("/Applications/App.app/Contents/MacOS/App", { PATH: "/opt/host/bin" }, "linux", exists, "33.0.0", undefined, () => 20),
        "/opt/host/bin/node",
    );
});

test("resolveNodeRuntime: win32 GUI host finds node in Program Files not on PATH (#1429)", () => {
    const winExists = (p: string): boolean => p === "C:/Program Files/nodejs/node.exe";
    assert.equal(
        resolveNodeRuntime("C:/app/desktop.exe", { PATH: "C:/Windows/System32" }, "win32", winExists, "33.0.0", undefined, () => 20),
        "C:/Program Files/nodejs/node.exe",
    );
});

test("resolveNodeRuntime: non-Electron host still throws when no Node resolves (#1429)", () => {
    assert.throws(
        () => resolveNodeRuntime("/usr/bin/opencode", { PATH: "/nonexistent" }, "linux", () => false, undefined),
        /BILLION_CONTEXT_NODE/,
    );
});

test("resolveNodeRuntime: win32 PATH node that re-execs into a wrapper resolves to the real Node (#1887)", () => {
    const shim = "C:/Users/x/AppData/Local/mise/shims/node.exe";
    const real = "C:/Users/x/scoop/apps/nodejs-lts/current/node.exe";
    const probed: string[] = [];
    const probe = (c: string): string | undefined => { probed.push(c); return real; };
    const exists = (p: string): boolean => p === shim || p === real;
    assert.equal(
        resolveNodeRuntime("C:/opencode/opencode.exe", { PATH: "C:/Users/x/AppData/Local/mise/shims" }, "win32", exists, undefined, probe, () => 20),
        real,
    );
    // the discovered candidate is consulted exactly once, on the wrapper itself
    assert.deepEqual(probed, [shim]);
});

test("resolveNodeRuntime: win32 wrapper probe failure falls back to the shim unchanged (#1887)", () => {
    const shim = "C:/Users/x/AppData/Local/mise/shims/node.exe";
    const probe = (): string | undefined => undefined;
    const exists = (p: string): boolean => p === shim;
    assert.equal(
        resolveNodeRuntime("C:/opencode/opencode.exe", { PATH: "C:/Users/x/AppData/Local/mise/shims" }, "win32", exists, undefined, probe, () => 20),
        shim,
    );
});

test("resolveNodeRuntime: win32 wrapper resolving to a missing target falls back to the shim (#1887)", () => {
    const shim = "C:/Users/x/AppData/Local/mise/shims/node.exe";
    const probe = (): string | undefined => "C:/gone/node.exe";
    const exists = (p: string): boolean => p === shim;
    assert.equal(
        resolveNodeRuntime("C:/opencode/opencode.exe", { PATH: "C:/Users/x/AppData/Local/mise/shims" }, "win32", exists, undefined, probe, () => 20),
        shim,
    );
});

test("resolveNodeRuntime: win32 real node whose probe reports itself is left unchanged (#1887)", () => {
    const node = "C:/Program Files/nodejs/node.exe";
    const probe = (c: string): string | undefined => c;
    const exists = (p: string): boolean => p === node;
    assert.equal(
        resolveNodeRuntime("C:/opencode/opencode.exe", { PATH: "C:/Program Files/nodejs" }, "win32", exists, undefined, probe, () => 20),
        node,
    );
});

test("resolveNodeRuntime: posix never consults the wrapper probe (#1887)", () => {
    const node = "/opt/host/bin/node";
    let calls = 0;
    const probe = (): string | undefined => { calls++; return "/elsewhere/node"; };
    const exists = (p: string): boolean => p === node;
    assert.equal(
        resolveNodeRuntime("/snap/opencode/opencode", { PATH: "/nonexistent:/opt/host/bin" }, "linux", exists, undefined, probe, () => 20),
        node,
    );
    assert.equal(calls, 0);
});

test("resolveNodeRuntime: a live Node executable is returned without probing (#1887)", () => {
    let calls = 0;
    const probe = (): string | undefined => { calls++; return "x"; };
    assert.equal(
        resolveNodeRuntime("C:/nodejs/node.exe", { PATH: "C:/whatever" }, "win32", () => false, undefined, probe),
        "C:/nodejs/node.exe",
    );
    assert.equal(calls, 0);
});

test("resolveNodeRuntime: an explicit BILLION_CONTEXT_NODE override is honored verbatim, not probed (#1887)", () => {
    const override = "C:/pinned/node.exe";
    let calls = 0;
    const probe = (): string | undefined => { calls++; return "x"; };
    const exists = (p: string): boolean => p === override || p === "C:/shim/node.exe";
    assert.equal(
        resolveNodeRuntime("C:/opencode/opencode.exe", { BILLION_CONTEXT_NODE: override, PATH: "C:/shim" }, "win32", exists, undefined, probe),
        override,
    );
    assert.equal(calls, 0);
});

test("resolveNodeRuntime: a PATH candidate that cannot prove it is Node is skipped, not accepted (#3383)", () => {
    // Microsoft HPC Pack's cluster CLI: named node.exe, ignores -p/--version,
    // prints help text and exits 0. Pre-fix it was accepted verbatim and
    // crash-looped every spawn forever; now the scan must reject it.
    const fake = "C:/Program Files/Microsoft HPC Pack 2019/Bin/node.exe";
    const env = { PATH: "C:/Program Files/Microsoft HPC Pack 2019/Bin" };
    const helpText = "Node Commands\n\nSyntax:\n    node {operator} [options] [arguments]\n";
    const probeWrapperStub = (): string | undefined => helpText;
    const probeNodeStub = (): number | undefined => undefined;
    const exists = (p: string): boolean => p === fake;
    // Electron host: the fake is skipped, nothing else exists → host-binary fallback
    assert.equal(
        resolveNodeRuntime(
            "E:/DSH Desktop/DSH Desktop.exe",
            env,
            "win32",
            exists,
            "33.0.0",
            probeWrapperStub,
            probeNodeStub,
        ),
        "E:/DSH Desktop/DSH Desktop.exe",
    );
    // non-Electron host: nothing usable resolves → actionable throw, not a doomed spawn
    assert.throws(
        () => resolveNodeRuntime("C:/opencode/opencode.exe", env, "win32", exists, undefined, probeWrapperStub, probeNodeStub),
        /BILLION_CONTEXT_NODE/,
    );
});

test("resolveNodeRuntime: scanning continues past a rejected candidate to a good Node later (#3383)", () => {
    const fake = "C:/hpc/Bin/node.exe";
    const real = "C:/Program Files/nodejs/node.exe";
    const probeNodeStub = (c: string): number | undefined => (c === real ? 22 : undefined);
    const exists = (p: string): boolean => p === fake || p === real;
    assert.equal(
        resolveNodeRuntime(
            "C:/opencode/opencode.exe",
            { PATH: "C:/hpc/Bin" },
            "win32",
            exists,
            "33.0.0",
            () => undefined,
            probeNodeStub,
        ),
        real,
    );
});

test("resolveNodeRuntime: a valid Node below the engines floor is rejected (#3383)", () => {
    const old = "/opt/host/bin/node";
    const probeNodeStub = (): number | undefined => 18;
    const exists = (p: string): boolean => p === old;
    assert.throws(
        () => resolveNodeRuntime("/usr/bin/opencode", { PATH: "/opt/host/bin" }, "linux", exists, undefined, undefined, probeNodeStub),
        /BILLION_CONTEXT_NODE/,
    );
});

test("resolveNodeRuntime: a wrapper answer that is not a node-shaped path is ignored, candidate validated itself (#3383)", () => {
    const shim = "C:/shims/node.exe";
    const exists = (p: string): boolean => p === shim;
    const probeNodeStub = (c: string): number | undefined => (c === shim ? 20 : undefined);
    // relative fragment → invalid answer, hop ignored
    assert.equal(
        resolveNodeRuntime("C:/app/app.exe", { PATH: "C:/shims" }, "win32", exists, "33.0.0", () => "relative/helper.exe", probeNodeStub),
        shim,
    );
    // absolute path but wrong basename → invalid answer, hop ignored
    assert.equal(
        resolveNodeRuntime("C:/app/app.exe", { PATH: "C:/shims" }, "win32", exists, "33.0.0", () => "C:/tools/helper.exe", probeNodeStub),
        shim,
    );
});

test("probeNodeMajor: the running Node reports its major version, missing executable yields undefined (#3383)", () => {
    const major = probeNodeMajor(process.execPath, { ...process.env });
    assert.ok(major !== undefined && major >= MIN_PROXY_NODE_MAJOR, `expected a major version >= ${MIN_PROXY_NODE_MAJOR}, got ${major}`);
    assert.equal(probeNodeMajor("/definitely/not/a/node", { ...process.env }), undefined);
});

test("probeNodeWrapperTarget: a plain node reports its own execPath (#1887)", () => {
    const out = probeNodeWrapperTarget(process.execPath, { ...process.env });
    assert.ok(typeof out === "string" && out.length > 0, "expected a non-empty path");
    assert.ok(fs.existsSync(out), `expected an existing path, got ${out}`);
    const lower = out.toLowerCase();
    assert.ok(lower.endsWith("node") || lower.endsWith("node.exe"), `expected a node path, got ${out}`);
});

test("ensureProxyRunning: spawns the resolved Node runtime, not blind process.execPath (#819)", async () => {
    let spawnedCmd: string | null = null;
    const spawnImpl: SpawnFn = (cmd) => {
        spawnedCmd = cmd as string;
        return makeFakeChild(42425);
    };
    await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42425 }), spawnImpl, readInstanceFile: () => undefined, nodeRuntime: "/custom/node" },
    );
    assert.equal(spawnedCmd, "/custom/node");
});

test("runLaunch omp: launcher hands per-model windows to the spawned proxy", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mw-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevOmpDir = process.env.PI_CODING_AGENT_DIR;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.PI_CODING_AGENT_DIR;
    const fakeOmp = path.join(home, process.platform === "win32" ? "fake-omp.exe" : "fake-omp");
    fs.writeFileSync(fakeOmp, "");
    process.env.BILI_CLIENT_BIN = fakeOmp;
    const ompHome = path.join(home, ".omp", "agent");
    fs.mkdirSync(ompHome, { recursive: true });
    fs.writeFileSync(
        path.join(ompHome, "models.yml"),
        [
            "providers:",
            "  sglang-responses:",
            "    baseUrl: http://127.0.0.1:8199/v1",
            "    models:",
            "      - id: qwen3.8-27b",
            "        contextWindow: 262144",
            "      - id: tiny",
            "        contextWindow: 4096",
        ].join("\n"),
    );
    // A loadable config.yml entry makes the extension available regardless
    // of whether dist/ is built — CI runs the tests without a prior build, so
    // the #535 omp refusal must not fire here (models.yml has rewrites).
    const otherInstall = path.join(home, "other-install", "dist", "agent", "omp.js");
    fs.mkdirSync(path.dirname(otherInstall), { recursive: true });
    fs.writeFileSync(otherInstall, "");
    fs.writeFileSync(path.join(ompHome, "config.yml"), `extensions:\n  - ${otherInstall}\n`);

    const proxyEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        if (cmd === fakeOmp) {
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        proxyEnvs.push((opts as { env?: NodeJS.ProcessEnv } | undefined)?.env);
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
        await runLaunch(
            { client: "omp", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.deepEqual(exitCalls, [0]);
        assert.equal(proxyEnvs.length, 1, "proxy spawned once");
        const raw = proxyEnvs[0]?.BILI_LAUNCHER_MODEL_WINDOWS;
        assert.ok(typeof raw === "string", "BILI_LAUNCHER_MODEL_WINDOWS handed to the proxy");
        const windows = JSON.parse(raw as string) as Record<string, number>;
        assert.equal(windows["qwen3.8-27b"], 262144);
        assert.equal(windows.tiny, 4096);
    } finally {
        process.exit = prevExit;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevOmpDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = prevOmpDir;
        rmrf(home);
    }
});

// --- PR-D (#321): launcher budget alignment (codex -c / claude env) ---

test("codexUpstreamUrl: provider base_url > openai_base_url > built-in default", () => {
    assert.equal(codexUpstreamUrl(undefined), "https://api.openai.com/v1");
    assert.equal(codexUpstreamUrl({ providers: {} }), "https://api.openai.com/v1");
    assert.equal(
        codexUpstreamUrl({ providers: {}, openaiBaseUrl: "https://relay.example.com/v1" }),
        "https://relay.example.com/v1",
    );
    assert.equal(
        codexUpstreamUrl({
            modelProvider: "relay",
            openaiBaseUrl: "https://openai.example.com/v1",
            providers: { relay: { baseUrl: "https://relay.example.com/v1" } },
        }),
        "https://relay.example.com/v1",
    );
    assert.equal(
        codexUpstreamUrl({ modelProvider: "missing", openaiBaseUrl: "https://openai.example.com/v1", providers: {} }),
        "https://openai.example.com/v1",
    );
});

test("resolveLauncherWindow: config route > built-in table > registry > nothing", async () => {
    const routes = { "https://api.openai.com/v1": { models: { "gpt-x": { context: 123456 } } } };
    registrySetForTest({});
    try {
        assert.equal(await resolveLauncherWindow("gpt-x", routes, "https://api.openai.com/v1"), 123456);
        assert.equal(await resolveLauncherWindow("gpt-5.5", {}, "https://api.openai.com/v1"), 400000);
        registrySetForTest({ "openai/bili-fallback-model": { limit: { context: 333333 } } });
        assert.equal(await resolveLauncherWindow("bili-fallback-model", {}, "https://api.openai.com/v1"), 333333);
        assert.equal(await resolveLauncherWindow("bili-nonexistent-model-xyz", {}, "https://api.openai.com/v1"), undefined);
        assert.equal(await resolveLauncherWindow(undefined, routes, "https://api.openai.com/v1"), undefined);
    } finally {
        registryResetForTest();
    }
});

test("resolveCodexBudgetArgs: injects window + same-value limit from bili's chain", async () => {
    registrySetForTest({});
    try {
        assert.deepEqual(
            await resolveCodexBudgetArgs({ model: "gpt-5.5", clientWindow: undefined, clientAutoCompactLimit: undefined, routes: {}, upstreamUrl: "https://api.openai.com/v1" }),
            ["-c", "model_context_window=400000", "-c", "model_auto_compact_token_limit=400000"],
        );
        const routes = { "https://relay.example.com/v1": { models: { "gpt-x": { context: 123456 } } } };
        assert.deepEqual(
            await resolveCodexBudgetArgs({ model: "gpt-x", clientWindow: undefined, clientAutoCompactLimit: undefined, routes, upstreamUrl: "https://relay.example.com/v1" }),
            ["-c", "model_context_window=123456", "-c", "model_auto_compact_token_limit=123456"],
        );
        registrySetForTest({ "openai/bili-fallback-model": { limit: { context: 333333 } } });
        assert.deepEqual(
            await resolveCodexBudgetArgs({ model: "bili-fallback-model", clientWindow: undefined, clientAutoCompactLimit: undefined, routes: {}, upstreamUrl: "https://api.openai.com/v1" }),
            ["-c", "model_context_window=333333", "-c", "model_auto_compact_token_limit=333333"],
        );
    } finally {
        registryResetForTest();
    }
});

test("resolveCodexBudgetArgs: no injection when user self-aligned or unresolvable", async () => {
    registrySetForTest({});
    try {
        assert.deepEqual(await resolveCodexBudgetArgs({ model: "gpt-5.5", clientWindow: 1000000, clientAutoCompactLimit: undefined, routes: {}, upstreamUrl: "https://api.openai.com/v1" }), []);
        assert.deepEqual(await resolveCodexBudgetArgs({ model: undefined, clientWindow: undefined, clientAutoCompactLimit: undefined, routes: {}, upstreamUrl: "https://api.openai.com/v1" }), []);
        assert.deepEqual(await resolveCodexBudgetArgs({ model: "bili-nonexistent-model-xyz", clientWindow: undefined, clientAutoCompactLimit: undefined, routes: {}, upstreamUrl: "https://api.openai.com/v1" }), []);
    } finally {
        registryResetForTest();
    }
});

test("resolveCodexBudgetArgs: honors user-set model_auto_compact_token_limit", async () => {
    assert.deepEqual(
        await resolveCodexBudgetArgs({ model: "gpt-5.5", clientWindow: undefined, clientAutoCompactLimit: 111111, routes: {}, upstreamUrl: "https://api.openai.com/v1" }),
        ["-c", "model_context_window=400000", "-c", "model_auto_compact_token_limit=111111"],
    );
});

test("resolveClaudeBudgetEnv: injects CLAUDE_CODE_AUTO_COMPACT_WINDOW from bili's chain", async () => {
    registrySetForTest({});
    try {
        assert.deepEqual(
            await resolveClaudeBudgetEnv({ model: "claude-sonnet-4-5", userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://api.anthropic.com" }),
            { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" },
        );
        const routes = { "https://relay.example.com": { models: { "claude-x": { context: 123456 } } } };
        assert.deepEqual(
            await resolveClaudeBudgetEnv({ model: "claude-x", userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes, upstreamUrl: "https://relay.example.com" }),
            { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "123456" },
        );
        registrySetForTest({ "anthropic/bili-fallback-model": { limit: { context: 333333 } } });
        assert.deepEqual(
            await resolveClaudeBudgetEnv({ model: "bili-fallback-model", userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://api.anthropic.com" }),
            { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "333333" },
        );
    } finally {
        registryResetForTest();
    }
});

test("resolveClaudeBudgetEnv: no injection when user self-aligned or unresolvable", async () => {
    registrySetForTest({});
    try {
        assert.deepEqual(await resolveClaudeBudgetEnv({ model: "claude-sonnet-4-5", userAutoCompactWindow: 300000, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://api.anthropic.com" }), {});
        assert.deepEqual(await resolveClaudeBudgetEnv({ model: "claude-sonnet-4-5", userAutoCompactWindow: undefined, shellAutoCompactWindow: "250000", routes: {}, upstreamUrl: "https://api.anthropic.com" }), {});
        assert.deepEqual(await resolveClaudeBudgetEnv({ model: undefined, userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://api.anthropic.com" }), {});
        assert.deepEqual(await resolveClaudeBudgetEnv({ model: "bili-nonexistent-model-xyz", userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://api.anthropic.com" }), {});
    } finally {
        registryResetForTest();
    }
});

test("parseCodexToml: stores model / model_context_window / model_auto_compact_token_limit", () => {
    const cfg = parseCodexToml(`
model = "gpt-5.5"
model_context_window = 1000000
model_auto_compact_token_limit = 900000

[model_providers.relay]
base_url = "https://relay.example.com/v1"
`);
    assert.equal(cfg.model, "gpt-5.5");
    assert.equal(cfg.contextWindow, 1000000);
    assert.equal(cfg.autoCompactLimit, 900000);
    assert.deepEqual(cfg.modelWindows, [{ id: "gpt-5.5", contextWindow: 1000000 }]);
    const bare = parseCodexToml(`model = "gpt-5.5"\n`);
    assert.equal(bare.model, "gpt-5.5");
    assert.equal(bare.contextWindow, undefined);
    assert.equal(bare.autoCompactLimit, undefined);
    assert.equal(bare.modelWindows, undefined);
});

test("readClaudeSettings: model from env block / top-level, autoCompactWindow from both forms", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-settings-"));
    try {
        const settingsDir = path.join(home, ".claude");
        fs.mkdirSync(settingsDir, { recursive: true });
        // top-level model + autoCompactWindow
        fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", autoCompactWindow: 300000 }));
        let cfg = readClaudeSettings(home, os.tmpdir(), {});
        assert.equal(cfg.model, "claude-sonnet-4-5");
        assert.equal(cfg.autoCompactWindow, 300000);
        // env block beats same-file top-level
        fs.writeFileSync(
            path.join(settingsDir, "settings.json"),
            JSON.stringify({ model: "claude-sonnet-4-5", autoCompactWindow: 300000, env: { ANTHROPIC_MODEL: "claude-opus-4-5", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000" } }),
        );
        cfg = readClaudeSettings(home, os.tmpdir(), {});
        assert.equal(cfg.model, "claude-opus-4-5");
        assert.equal(cfg.autoCompactWindow, 250000);
        // nothing set → empty object
        fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({}));
        cfg = readClaudeSettings(home, os.tmpdir(), {});
        assert.deepEqual(cfg, {});
    } finally {
        rmrf(home);
    }
});

test("runLaunch codex: budget args injected for MITM mode (built-in table window)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-budget-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevAnthropicModel = process.env.ANTHROPIC_MODEL;
    const prevAutoCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const fakeCodex = path.join(home, process.platform === "win32" ? "fake-codex.exe" : "fake-codex");
    fs.writeFileSync(fakeCodex, "");
    process.env.BILI_CLIENT_BIN = fakeCodex;
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');

    const clientArgsSeen: string[][] = [];
    const spawnImpl: SpawnFn = (cmd, args) => {
        if (cmd === fakeCodex) {
            clientArgsSeen.push([...args]);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
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
    process.exit = (() => undefined) as typeof process.exit;

    try {
        await runLaunch(
            { client: "codex", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        const args = clientArgsSeen[0];
        const i = args.indexOf("model_context_window=400000");
        assert.ok(i > -1, `expected model_context_window=400000 in ${JSON.stringify(args)}`);
        assert.equal(args[i - 1], "-c");
        const j = args.indexOf("model_auto_compact_token_limit=400000");
        assert.ok(j > -1, `expected model_auto_compact_token_limit=400000 in ${JSON.stringify(args)}`);
        assert.equal(args[j - 1], "-c");

        // user self-aligned (model_context_window in config.toml) → no injection
        fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\nmodel_context_window = 1000000\n');
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "codex", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].some((a) => a.startsWith("model_context_window=")), JSON.stringify(clientArgsSeen[0]));

        // no model in config.toml → no injection
        fs.writeFileSync(path.join(codexHome, "config.toml"), "");
        clientArgsSeen.length = 0;
        await runLaunch(
            { client: "codex", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].some((a) => a.startsWith("model_context_window=")), JSON.stringify(clientArgsSeen[0]));
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = prevCodexHome;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (prevAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
        else process.env.ANTHROPIC_MODEL = prevAnthropicModel;
        if (prevAutoCompact === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prevAutoCompact;
        rmrf(home);
    }
});

test("codexRunModePinned: detects user-pinned run mode (#1867)", () => {
    assert.equal(codexRunModePinned([]), false);
    assert.equal(codexRunModePinned(["-c", "model_context_window=400000"]), false);
    assert.equal(codexRunModePinned(["resume", "abc"]), false);
    assert.equal(codexRunModePinned(["--no-daemon"]), true);
    assert.equal(codexRunModePinned(["--remote", "ws://127.0.0.1:9"]), true);
    assert.equal(codexRunModePinned(["--remote=ws://127.0.0.1:9"]), true);
});

test("splitWindowsCommandLine: round-trips buildWindowsCommandLine quoting (#679/#1867)", () => {
    // helper contract: the inner line, i.e. the comspec arg minus its outer quote pair
    assert.deepEqual(
        splitWindowsCommandLine(buildWindowsCommandLine("C:\\temp\\fake-codex.cmd", ["--no-daemon", "-c", "model_context_window=400000"]).slice(1, -1)),
        ["C:\\temp\\fake-codex.cmd", "--no-daemon", "-c", "model_context_window=400000"],
    );
    assert.deepEqual(
        splitWindowsCommandLine(buildWindowsCommandLine("C:\\Users\\Some User\\temp\\fake-codex.cmd", ["--remote", "ws://127.0.0.1:9"]).slice(1, -1)),
        ["C:\\Users\\Some User\\temp\\fake-codex.cmd", "--remote", "ws://127.0.0.1:9"],
    );
});

test("codexSupportsNoDaemon: probes --help output, fails soft (#1867)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-nodaemon-"));
    const isWin = process.platform === "win32";
    const helpWithFlag = isWin
        ? "@echo Options:\r\n@echo   --no-daemon\r\n@echo       Run without the shared background server\r\n"
        : "#!/bin/sh\necho \"Options:\"\necho \"  --no-daemon\"\necho \"      Run without the shared background server\"\n";
    const helpWithoutFlag = isWin
        ? "@echo Options:\r\n@echo   --profile <NAME>\r\n"
        : "#!/bin/sh\necho \"Options:\"\necho \"  --profile <NAME>\"\n";
    const mk = (name: string, body: string): string => {
        const p = path.join(dir, name + (isWin ? ".cmd" : ""));
        fs.writeFileSync(p, body);
        if (!isWin) fs.chmodSync(p, 0o755);
        return p;
    };
    try {
        assert.equal(codexSupportsNoDaemon(mk("new-codex", helpWithFlag), []), true);
        assert.equal(codexSupportsNoDaemon(mk("old-codex", helpWithoutFlag), []), false);
        assert.equal(codexSupportsNoDaemon(mk("dead-codex", isWin ? "@exit /b 3\r\n" : "#!/bin/sh\nexit 3\n"), []), false);
        assert.equal(codexSupportsNoDaemon(path.join(dir, "missing-codex" + (isWin ? ".cmd" : "")), []), false);
        // cached per command path
        const again = mk("new-codex-2", helpWithFlag);
        assert.equal(codexSupportsNoDaemon(again, []), true);
        fs.writeFileSync(again, helpWithoutFlag);
        if (!isWin) fs.chmodSync(again, 0o755);
        assert.equal(codexSupportsNoDaemon(again, []), true);
    } finally {
        rmrf(dir);
    }
});

test("runLaunch codex: --no-daemon pinned when supported, escape hatches honored (#1867)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-nodaemon-run-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevAnthropicModel = process.env.ANTHROPIC_MODEL;
    const prevAutoCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    process.env.HOME = home;
    process.env.CODEX_HOME = path.join(home, ".codex");
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const isWin = process.platform === "win32";
    const fakeCodex = path.join(home, isWin ? "fake-codex.cmd" : "fake-codex");
    fs.writeFileSync(fakeCodex, isWin ? "@echo Options:\r\n@echo   --no-daemon\r\n@echo       Run without the shared background server\r\n" : "#!/bin/sh\necho \"Options:\"\necho \"  --no-daemon\"\necho \"      Run without the shared background server\"\n");
    if (!isWin) fs.chmodSync(fakeCodex, 0o755);
    process.env.BILI_CLIENT_BIN = fakeCodex;
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\n');

    const clientArgsSeen: string[][] = [];
    const fakeBase = path.basename(fakeCodex);
    const spawnImpl: SpawnFn = (cmd, args) => {
        // #679: runClient plans the spawn before calling us — on win32 a .cmd
        // fake arrives as `comspec /d /s /c "<line>"`, so the client path sits
        // inside one arg instead of being cmd itself.
        const wrappedLine = cmd !== fakeCodex
            ? args.find((a): a is string => typeof a === "string" && a.includes(fakeBase))
            : undefined;
        if (cmd !== fakeCodex && wrappedLine === undefined) return makeFakeChild(42422);
        const clientArgs = wrappedLine === undefined
            ? [...args]
            : splitWindowsCommandLine(wrappedLine.slice(1, -1)).slice(1);
        clientArgsSeen.push(clientArgs);
        const child = makeFakeChild(0);
        const orig = child.on!.bind(child);
        (child as { on: SpawnChild["on"] }).on = (event, listener) => {
            orig(event, listener);
            if (event === "exit") setTimeout(() => listener(0, null), 0);
            return child;
        };
        return child;
    };
    const fetchImpl = async () => ({ ok: true });
    const prevExit = process.exit;
    process.exit = (() => undefined) as typeof process.exit;
    const launch = (clientArgs: string[]) =>
        runLaunch(
            { client: "codex", clientArgs, overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );

    try {
        // fresh launch → #321 budget args AND explicit embedded pin
        await launch([]);
        assert.equal(clientArgsSeen.length, 1);
        let args = clientArgsSeen[0];
        assert.ok(args.includes("--no-daemon"), JSON.stringify(args));
        assert.ok(args.includes("model_context_window=400000") && args.includes("model_auto_compact_token_limit=400000"), JSON.stringify(args));

        // user self-aligned window (no budget injection) → still pinned: without this
        // the session would silently attach to an external daemon and bypass bili
        fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"\nmodel_context_window = 1000000\n');
        clientArgsSeen.length = 0;
        await launch([]);
        args = clientArgsSeen[0];
        assert.ok(args.includes("--no-daemon"), JSON.stringify(args));
        assert.ok(!args.some((a) => a.startsWith("model_context_window=")), JSON.stringify(args));

        // unresolvable model (no budget injection) → still pinned
        fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "totally-unknown-model"\n');
        clientArgsSeen.length = 0;
        await launch([]);
        args = clientArgsSeen[0];
        assert.ok(args.includes("--no-daemon"), JSON.stringify(args));

        // user already passed --no-daemon → not duplicated
        clientArgsSeen.length = 0;
        await launch(["--no-daemon"]);
        args = clientArgsSeen[0];
        assert.equal(args.filter((a) => a === "--no-daemon").length, 1, JSON.stringify(args));

        // user passed --remote → no injection (codex hard-errors the combo)
        clientArgsSeen.length = 0;
        await launch(["--remote", "ws://127.0.0.1:9"]);
        args = clientArgsSeen[0];
        assert.ok(!args.includes("--no-daemon"), JSON.stringify(args));
        assert.ok(args.includes("--remote"), JSON.stringify(args));
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = prevCodexHome;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (prevAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
        else process.env.ANTHROPIC_MODEL = prevAnthropicModel;
        if (prevAutoCompact === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prevAutoCompact;
        rmrf(home);
    }
});

test("runLaunch codex: old binary without --no-daemon launches unchanged (#1867)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-nodaemon-old-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevAnthropicModel = process.env.ANTHROPIC_MODEL;
    const prevAutoCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const isWin = process.platform === "win32";
    const fakeCodex = path.join(home, isWin ? "old-codex.cmd" : "old-codex");
    fs.writeFileSync(fakeCodex, isWin ? "@echo Options:\r\n@echo   --profile <NAME>\r\n" : "#!/bin/sh\necho \"Options:\"\necho \"  --profile <NAME>\"\n");
    if (!isWin) fs.chmodSync(fakeCodex, 0o755);
    process.env.BILI_CLIENT_BIN = fakeCodex;
    const codexHome = path.join(home, ".codex");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), "");

    const clientArgsSeen: string[][] = [];
    const fakeBase = path.basename(fakeCodex);
    const spawnImpl: SpawnFn = (cmd, args) => {
        // #679: runClient plans the spawn before calling us — on win32 a .cmd
        // fake arrives as `comspec /d /s /c "<line>"`, so the client path sits
        // inside one arg instead of being cmd itself.
        const wrappedLine = cmd !== fakeCodex
            ? args.find((a): a is string => typeof a === "string" && a.includes(fakeBase))
            : undefined;
        if (cmd !== fakeCodex && wrappedLine === undefined) return makeFakeChild(42422);
        const clientArgs = wrappedLine === undefined
            ? [...args]
            : splitWindowsCommandLine(wrappedLine.slice(1, -1)).slice(1);
        clientArgsSeen.push(clientArgs);
        const child = makeFakeChild(0);
        const orig = child.on!.bind(child);
        (child as { on: SpawnChild["on"] }).on = (event, listener) => {
            orig(event, listener);
            if (event === "exit") setTimeout(() => listener(0, null), 0);
            return child;
        };
        return child;
    };
    const fetchImpl = async () => ({ ok: true });
    const prevExit = process.exit;
    process.exit = (() => undefined) as typeof process.exit;

    try {
        await runLaunch(
            { client: "codex", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientArgsSeen.length, 1);
        assert.ok(!clientArgsSeen[0].includes("--no-daemon"), JSON.stringify(clientArgsSeen[0]));
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (prevAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
        else process.env.ANTHROPIC_MODEL = prevAnthropicModel;
        if (prevAutoCompact === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prevAutoCompact;
        rmrf(home);
    }
});

test("runLaunch claude: CLAUDE_CODE_AUTO_COMPACT_WINDOW injected (built-in table window)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-claude-budget-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevAnthropicModel = process.env.ANTHROPIC_MODEL;
    const prevAutoCompact = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    const fakeClaude = path.join(home, process.platform === "win32" ? "fake-claude.exe" : "fake-claude");
    fs.writeFileSync(fakeClaude, "");
    process.env.BILI_CLIENT_BIN = fakeClaude;
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }));

    const clientEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        if (cmd === fakeClaude) {
            clientEnvs.push((opts as { env?: NodeJS.ProcessEnv } | undefined)?.env);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
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
    process.exit = (() => undefined) as typeof process.exit;

    try {
        await runLaunch(
            { client: "claude", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1);
        assert.equal(clientEnvs[0]?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");

        // user self-aligned (settings autoCompactWindow) → no injection
        fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", autoCompactWindow: 300000 }));
        clientEnvs.length = 0;
        await runLaunch(
            { client: "claude", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1);
        assert.equal(clientEnvs[0]?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);

        // shell-exported ANTHROPIC_MODEL wins over settings model
        fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }));
        process.env.ANTHROPIC_MODEL = "claude-opus-4-5";
        clientEnvs.length = 0;
        await runLaunch(
            { client: "claude", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1);
        assert.equal(clientEnvs[0]?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (prevAnthropicModel === undefined) delete process.env.ANTHROPIC_MODEL;
        else process.env.ANTHROPIC_MODEL = prevAnthropicModel;
        if (prevAutoCompact === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
        else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = prevAutoCompact;
        rmrf(home);
    }
});

test("isLaunchClient: codebuddy true", () => {
    assert.equal(isLaunchClient("codebuddy"), true);
});

test("resolveCodebuddyHome: CODEBUDDY_CONFIG_DIR > default ~/.codebuddy", () => {
    const h = os.homedir();
    assert.equal(resolveCodebuddyHome({ CODEBUDDY_CONFIG_DIR: "/custom/cb" }), "/custom/cb");
    assert.equal(resolveCodebuddyHome({}), path.join(h, ".codebuddy"));
    assert.equal(resolveCodebuddyHome({ CODEBUDDY_CONFIG_DIR: "  " }), path.join(h, ".codebuddy"));
});

test("parseCodebuddyModelsJson: top-level map / models map / array shapes", () => {
    const topMap = parseCodebuddyModelsJson({
        "model-a": { url: "https://a.example.com/v1/chat/completions", apiKey: "k", maxInputTokens: 100000 },
        "model-b": { maxInputTokens: 200000 },
        junk: "not-an-object",
    });
    assert.deepEqual(topMap.models, [
        { id: "model-a", contextWindow: 100000 },
        { id: "model-b", contextWindow: 200000 },
    ]);
    assert.deepEqual(topMap.urls, ["https://a.example.com/v1/chat/completions"]);

    const modelsMap = parseCodebuddyModelsJson({
        models: { "model-c": { url: "https://c.example.com/v1/chat/completions", maxInputTokens: 300000 } },
    });
    assert.deepEqual(modelsMap.models, [{ id: "model-c", contextWindow: 300000 }]);
    assert.deepEqual(modelsMap.urls, ["https://c.example.com/v1/chat/completions"]);

    const arr = parseCodebuddyModelsJson([
        { id: "model-d", url: "https://d.example.com/v1/chat/completions", maxInputTokens: 400000 },
        { name: "model-e", maxInputTokens: 500000 },
        "junk",
    ]);
    assert.deepEqual(arr.models, [
        { id: "model-d", contextWindow: 400000 },
        { id: "model-e", contextWindow: 500000 },
    ]);
    assert.deepEqual(arr.urls, ["https://d.example.com/v1/chat/completions"]);

    assert.deepEqual(parseCodebuddyModelsJson(null), { models: [], urls: [] });
    assert.deepEqual(parseCodebuddyModelsJson("nope"), { models: [], urls: [] });
    assert.deepEqual(parseCodebuddyModelsJson({ "model-x": { maxInputTokens: -1 } }), { models: [], urls: [] });
});

test("readCodebuddyConfig: settings env block / top-level model / autoCompactWindow / shell fallback", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codebuddy-settings-"));
    try {
        const cbDir = path.join(home, ".codebuddy");
        fs.mkdirSync(cbDir, { recursive: true });
        fs.writeFileSync(
            path.join(cbDir, "settings.json"),
            JSON.stringify({ model: "cb-model-1", autoCompactWindow: 300000, env: { CODEBUDDY_BASE_URL: "http://relay.local/cb" } }),
        );
        let cfg = readCodebuddyConfig(cbDir, os.tmpdir(), {});
        assert.equal(cfg.codebuddyBaseUrl, "http://relay.local/cb");
        assert.equal(cfg.model, "cb-model-1");
        assert.equal(cfg.autoCompactWindow, 300000);

        // shell-exported CODEBUDDY_BASE_URL fills in when settings has none
        fs.writeFileSync(path.join(cbDir, "settings.json"), JSON.stringify({ model: "cb-model-1" }));
        cfg = readCodebuddyConfig(cbDir, os.tmpdir(), { CODEBUDDY_BASE_URL: "https://shell.example.com/v2" });
        assert.equal(cfg.codebuddyBaseUrl, "https://shell.example.com/v2");

        // nothing set → empty object
        fs.writeFileSync(path.join(cbDir, "settings.json"), JSON.stringify({}));
        cfg = readCodebuddyConfig(cbDir, os.tmpdir(), {});
        assert.deepEqual(cfg, {});
    } finally {
        rmrf(home);
    }
});

test("readCodebuddyConfig: two-tier models.json, project level wins per model", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codebuddy-models-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codebuddy-cwd-"));
    try {
        const cbDir = path.join(home, ".codebuddy");
        fs.mkdirSync(cbDir, { recursive: true });
        fs.writeFileSync(
            path.join(cbDir, "models.json"),
            JSON.stringify({
                "shared-model": { url: "https://global.example.com/v1/chat/completions", maxInputTokens: 100000 },
                "global-only": { url: "https://global.example.com/v1/chat/completions", maxInputTokens: 200000 },
            }),
        );
        const projDir = path.join(cwd, ".codebuddy");
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(
            path.join(projDir, "models.json"),
            JSON.stringify({
                "shared-model": { url: "https://project.example.com/v1/chat/completions", maxInputTokens: 999999 },
            }),
        );
        const cfg = readCodebuddyConfig(cbDir, cwd, {});
        assert.deepEqual(cfg.models, [
            { id: "shared-model", contextWindow: 999999 },
            { id: "global-only", contextWindow: 200000 },
        ]);
        assert.deepEqual(cfg.modelUrls, [
            "https://global.example.com/v1/chat/completions",
            "https://project.example.com/v1/chat/completions",
        ]);
    } finally {
        rmrf(home);
        rmrf(cwd);
    }
});

test("buildCodebuddyEnv: CODEBUDDY_BASE_URL rewrite sets env + keeps HTTPS_PROXY/CA", () => {
    const rewrites: HttpRewrite[] = [
        { key: "CODEBUDDY_BASE_URL", realUpstream: "http://relay.local/cb" },
    ];
    const env = buildCodebuddyEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin", CODEBUDDY_API_KEY: "cb-x" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.CODEBUDDY_API_KEY, "cb-x");
    assert.equal(env.CODEBUDDY_BASE_URL, "http://127.0.0.1:8787/bili/http://relay.local/cb");
});

test("buildCodebuddyEnv: no CODEBUDDY_BASE_URL rewrite → env.CODEBUDDY_BASE_URL unset", () => {
    const env = buildCodebuddyEnv("http://127.0.0.1:8787", "/tmp/ca.pem", [], [], { PATH: "/usr/bin" });
    assert.equal(env.CODEBUDDY_BASE_URL, undefined);
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
});

test("buildCodebuddyEnv: /bili/-wrapped CODEBUDDY_BASE_URL → NO_PROXY/no_proxy loopback merge (#3446)", () => {
    const rewrites: HttpRewrite[] = [
        { key: "CODEBUDDY_BASE_URL", realUpstream: "https://api.codebuddy.cn/v2" },
    ];
    const env = buildCodebuddyEnv("http://127.0.0.1:8787", "/tmp/ca.pem", rewrites, [], { PATH: "/usr/bin" });
    assert.equal(env.CODEBUDDY_BASE_URL, "http://127.0.0.1:8787/bili/https://api.codebuddy.cn/v2");
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
});

test("discoverRoutes: codebuddy default → CODEBUDDY_BASE_URL /bili/ rewrite (CN platform endpoint)", () => {
    const routes = discoverRoutes("codebuddy", {});
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpsRewrites, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "CODEBUDDY_BASE_URL", realUpstream: "https://tencent.sso.codebuddy.cn/v2" },
    ]);
});

test("discoverRoutes: codebuddy configured http base URL → httpRewrites entry, no https domains", () => {
    const config: ClientConfig = {
        codebuddy: { codebuddyBaseUrl: "http://relay.local/cb" },
    };
    const routes = discoverRoutes("codebuddy", config);
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "CODEBUDDY_BASE_URL", realUpstream: "http://relay.local/cb" },
    ]);
});

test("discoverRoutes: codebuddy /bili/-wrapped base_url unwraps to real upstream for re-wrap", () => {
    const config: ClientConfig = {
        codebuddy: { codebuddyBaseUrl: "http://127.0.0.1:8787/bili/https://relay.example.com/v2" },
    };
    const routes = discoverRoutes("codebuddy", config);
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "CODEBUDDY_BASE_URL", realUpstream: "https://relay.example.com/v2" },
    ]);
});

test("discoverRoutes: codebuddy models.json urls → httpsDomains inventory, never rewritten", () => {
    const config: ClientConfig = {
        codebuddy: {
            modelUrls: [
                "https://models.example.com/v1/chat/completions",
                "http://local.example.com/v1/chat/completions",
                "not-a-url",
            ],
        },
    };
    const routes = discoverRoutes("codebuddy", config);
    assert.deepEqual(routes.httpsDomains, ["models.example.com"]);
    assert.deepEqual(routes.httpRewrites, [
        { key: "CODEBUDDY_BASE_URL", realUpstream: "https://tencent.sso.codebuddy.cn/v2" },
    ]);
});

test("resolveCodebuddyBudgetEnv: injects CODEBUDDY_AUTO_COMPACT_WINDOW from bili's chain", async () => {
    registrySetForTest({});
    try {
        assert.deepEqual(
            await resolveCodebuddyBudgetEnv({ model: "claude-sonnet-4-5", userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://tencent.sso.codebuddy.cn/v2" }),
            { CODEBUDDY_AUTO_COMPACT_WINDOW: "200000" },
        );
        const routes = { "https://relay.example.com": { models: { "cb-x": { context: 123456 } } } };
        assert.deepEqual(
            await resolveCodebuddyBudgetEnv({ model: "cb-x", userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes, upstreamUrl: "https://relay.example.com" }),
            { CODEBUDDY_AUTO_COMPACT_WINDOW: "123456" },
        );
        registrySetForTest({ "anthropic/bili-fallback-model": { limit: { context: 333333 } } });
        assert.deepEqual(
            await resolveCodebuddyBudgetEnv({ model: "bili-fallback-model", userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://tencent.sso.codebuddy.cn/v2" }),
            { CODEBUDDY_AUTO_COMPACT_WINDOW: "333333" },
        );
    } finally {
        registryResetForTest();
    }
});

test("resolveCodebuddyBudgetEnv: no injection when user self-aligned or unresolvable", async () => {
    registrySetForTest({});
    try {
        assert.deepEqual(await resolveCodebuddyBudgetEnv({ model: "claude-sonnet-4-5", userAutoCompactWindow: 300000, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://tencent.sso.codebuddy.cn/v2" }), {});
        assert.deepEqual(await resolveCodebuddyBudgetEnv({ model: "claude-sonnet-4-5", userAutoCompactWindow: undefined, shellAutoCompactWindow: "250000", routes: {}, upstreamUrl: "https://tencent.sso.codebuddy.cn/v2" }), {});
        assert.deepEqual(await resolveCodebuddyBudgetEnv({ model: undefined, userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://tencent.sso.codebuddy.cn/v2" }), {});
        assert.deepEqual(await resolveCodebuddyBudgetEnv({ model: "bili-nonexistent-model-xyz", userAutoCompactWindow: undefined, shellAutoCompactWindow: undefined, routes: {}, upstreamUrl: "https://tencent.sso.codebuddy.cn/v2" }), {});
    } finally {
        registryResetForTest();
    }
});

test("resolveClientCommand: codebuddy resolves codebuddy, then cbc, then bare name", () => {
    assert.deepEqual(resolveClientCommand("codebuddy", { PATH: "/nonexistent-dir-zzz" }), {
        command: "codebuddy",
        prefixArgs: [],
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-path-"));
    const cbcFile = path.join(tmp, "cbc");
    fs.writeFileSync(cbcFile, "#!/bin/sh\necho cbc\n", { mode: 0o755 });
    try {
        assert.deepEqual(resolveClientCommand("codebuddy", { PATH: tmp }), {
            command: cbcFile,
            prefixArgs: [],
        });
    } finally {
        fs.unlinkSync(cbcFile);
        fs.rmdirSync(tmp);
    }
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "bili-path-"));
    const cbFile = path.join(tmp2, "codebuddy");
    const cbFile2 = path.join(tmp2, "cbc");
    fs.writeFileSync(cbFile, "#!/bin/sh\necho cb\n", { mode: 0o755 });
    fs.writeFileSync(cbFile2, "#!/bin/sh\necho cbc\n", { mode: 0o755 });
    try {
        assert.deepEqual(resolveClientCommand("codebuddy", { PATH: tmp2 }), {
            command: cbFile,
            prefixArgs: [],
        });
    } finally {
        fs.unlinkSync(cbFile);
        fs.unlinkSync(cbFile2);
        fs.rmdirSync(tmp2);
    }
});

test("runLaunch codebuddy: CODEBUDDY_BASE_URL /bili/ rewrite + budget injected (built-in table window)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codebuddy-budget-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevClientBin = process.env.BILI_CLIENT_BIN;
    const prevBaseUrl = process.env.CODEBUDDY_BASE_URL;
    const prevAutoCompact = process.env.CODEBUDDY_AUTO_COMPACT_WINDOW;
    const prevConfigDir = process.env.CODEBUDDY_CONFIG_DIR;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.CODEBUDDY_BASE_URL;
    delete process.env.CODEBUDDY_AUTO_COMPACT_WINDOW;
    delete process.env.CODEBUDDY_CONFIG_DIR;
    const fakeCodebuddy = path.join(home, process.platform === "win32" ? "fake-codebuddy.exe" : "fake-codebuddy");
    fs.writeFileSync(fakeCodebuddy, "");
    process.env.BILI_CLIENT_BIN = fakeCodebuddy;
    const cbDir = path.join(home, ".codebuddy");
    fs.mkdirSync(cbDir, { recursive: true });
    fs.writeFileSync(path.join(cbDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5" }));

    const clientEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        if (cmd === fakeCodebuddy) {
            clientEnvs.push((opts as { env?: NodeJS.ProcessEnv } | undefined)?.env);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
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
    process.exit = (() => undefined) as typeof process.exit;

    try {
        await runLaunch(
            { client: "codebuddy", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1);
        assert.match(clientEnvs[0]?.CODEBUDDY_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+\/bili\/https:\/\/tencent\.sso\.codebuddy\.cn\/v2$/);
        assert.equal(clientEnvs[0]?.CODEBUDDY_AUTO_COMPACT_WINDOW, "200000");
        assert.equal(clientEnvs[0]?.HTTPS_PROXY, clientEnvs[0]?.BILLION_CONTEXT_PROXY);

        // user self-aligned (settings autoCompactWindow) → no budget injection
        fs.writeFileSync(path.join(cbDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-4-5", autoCompactWindow: 300000 }));
        clientEnvs.length = 0;
        await runLaunch(
            { client: "codebuddy", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1);
        assert.equal(clientEnvs[0]?.CODEBUDDY_AUTO_COMPACT_WINDOW, undefined);
        assert.match(clientEnvs[0]?.CODEBUDDY_BASE_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+\/bili\//);
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevClientBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevClientBin;
        if (prevBaseUrl === undefined) delete process.env.CODEBUDDY_BASE_URL;
        else process.env.CODEBUDDY_BASE_URL = prevBaseUrl;
        if (prevAutoCompact === undefined) delete process.env.CODEBUDDY_AUTO_COMPACT_WINDOW;
        else process.env.CODEBUDDY_AUTO_COMPACT_WINDOW = prevAutoCompact;
        if (prevConfigDir === undefined) delete process.env.CODEBUDDY_CONFIG_DIR;
        else process.env.CODEBUDDY_CONFIG_DIR = prevConfigDir;
        rmrf(home);
    }
});

test("qoderIsCnSite: QODERCLI_SITE and CN-prefixed envs decide the site", () => {
    assert.equal(qoderIsCnSite({ QODERCLI_SITE: "cn" }), true);
    assert.equal(qoderIsCnSite({ QODERCLI_SITE: "CN " }), true);
    assert.equal(qoderIsCnSite({ QODERCLI_SITE: "intl" }), false);
    assert.equal(qoderIsCnSite({ QODERCN_CONFIG_DIR: "/tmp/qcn" }), true);
    assert.equal(qoderIsCnSite({ QODERCN_CLI_HOME: "/tmp/qcn" }), true);
    assert.equal(qoderIsCnSite({ QODER_CONFIG_DIR: "/tmp/q" }), false);
});

test("qoderIsCnSite: on-disk config dirs only break the tie (no dirs → intl)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-qoder-site-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    try {
        assert.equal(qoderIsCnSite({}), false, "no config dirs → intl");
        fs.mkdirSync(path.join(home, ".qoder-cn"));
        assert.equal(qoderIsCnSite({}), true, "only .qoder-cn present → cn");
        fs.mkdirSync(path.join(home, ".qoder"));
        assert.equal(qoderIsCnSite({}), false, "both present → intl (default)");
    } finally {
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(home);
    }
});

test("resolveQoderHome: env override > CLI_HOME+dir name > site default", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-qoder-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    try {
        assert.equal(resolveQoderHome({ QODER_CONFIG_DIR: "/tmp/qc" }), "/tmp/qc");
        assert.equal(resolveQoderHome({ QODERCLI_SITE: "cn", QODERCN_CONFIG_DIR: "/tmp/qcn" }), "/tmp/qcn");
        assert.equal(resolveQoderHome({ QODER_CLI_HOME: "/tmp/parent" }), path.join("/tmp/parent", ".qoder"));
        assert.equal(resolveQoderHome({ QODER_CONFIG_DIR_NAME: ".qoder-x" }), path.join(home, ".qoder-x"));
        assert.equal(
            resolveQoderHome({ QODERCLI_SITE: "cn", QODERCN_CLI_HOME: "/tmp/parent", QODERCN_CONFIG_DIR_NAME: ".qcn" }),
            path.join("/tmp/parent", ".qcn"),
        );
        assert.equal(resolveQoderHome({}), path.join(home, ".qoder"));
        assert.equal(resolveQoderHome({ QODERCLI_SITE: "cn" }), path.join(home, ".qoder-cn"));
    } finally {
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(home);
    }
});

test("readQoderConfig: settings.json model (string + object) and model server host env", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-qoder-cfg-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    const dir = path.join(home, ".qoder");
    fs.mkdirSync(dir, { recursive: true });
    try {
        assert.deepEqual(readQoderConfig(dir, {}), {});
        fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: { name: "qwen3-max" } }));
        assert.deepEqual(readQoderConfig(dir, {}), { model: "qwen3-max" });
        fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: "qwen3-max", mcpServers: {} }));
        assert.deepEqual(readQoderConfig(dir, {}), { model: "qwen3-max" });
        fs.writeFileSync(path.join(dir, "settings.json"), "not-json{");
        assert.deepEqual(readQoderConfig(dir, {}), {});
        fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: { name: "qwen3-max" } }));
        const withHost = readQoderConfig(dir, { QODER_MODEL_SERVER_HOST: "https://my-relay.example.com:8443/" });
        assert.equal(withHost.model, "qwen3-max");
        assert.equal(withHost.modelServerHost, "my-relay.example.com:8443");
        const cnHost = readQoderConfig(dir, { QODERCLI_SITE: "cn", QODERCN_MODEL_SERVER_HOST: "cn-relay.example.com" });
        assert.equal(cnHost.modelServerHost, "cn-relay.example.com");
        const mixed = readQoderConfig(dir, { QODERCLI_SITE: "cn", QODER_MODEL_SERVER_HOST: "intl.example.com" });
        assert.equal(mixed.modelServerHost, undefined, "intl-prefixed host ignored on CN site");
    } finally {
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(home);
    }
});

test("discoverRoutes: qoder → default MITM hosts, no rewrites (#653)", () => {
    const routes = discoverRoutes("qoder", {});
    assert.deepEqual(routes.httpsDomains, QODER_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpsRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("discoverRoutes: qoder modelServerHost replaces the default map", () => {
    const config: ClientConfig = { qoder: { model: "m", modelServerHost: "my-relay.example.com" } };
    const routes = discoverRoutes("qoder", config);
    assert.deepEqual(routes.httpsDomains, ["my-relay.example.com"]);
});

test("buildQoderEnv: HTTPS_PROXY + NODE_EXTRA_CA_CERTS + BILLION_CONTEXT_PROXY, baseEnv preserved", () => {
    const env = buildQoderEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { FOO: "bar" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.FOO, "bar");
});

test("resolveQoderBudgetEnv: injects the site-prefixed window key from bili's chain", async () => {
    registrySetForTest({});
    try {
        assert.deepEqual(
            await resolveQoderBudgetEnv({ model: "claude-sonnet-4-5", userAutoCompactWindow: undefined, windowKey: "QODER_AUTOCOMPACT_WINDOW", routes: {}, upstreamUrl: "https://api2-v2.qoder.sh" }),
            { QODER_AUTOCOMPACT_WINDOW: "200000" },
        );
        const routes = { "https://relay.example.com": { models: { "qoder-x": { context: 123456 } } } };
        assert.deepEqual(
            await resolveQoderBudgetEnv({ model: "qoder-x", userAutoCompactWindow: undefined, windowKey: "QODERCN_AUTOCOMPACT_WINDOW", routes, upstreamUrl: "https://relay.example.com" }),
            { QODERCN_AUTOCOMPACT_WINDOW: "123456" },
        );
        registrySetForTest({ "anthropic/bili-fallback-model": { limit: { context: 333333 } } });
        assert.deepEqual(
            await resolveQoderBudgetEnv({ model: "bili-fallback-model", userAutoCompactWindow: undefined, windowKey: "QODER_AUTOCOMPACT_WINDOW", routes: {}, upstreamUrl: "https://api.anthropic.com" }),
            { QODER_AUTOCOMPACT_WINDOW: "333333" },
        );
    } finally {
        registryResetForTest();
    }
});

test("resolveQoderBudgetEnv: no injection when user self-aligned or unresolvable", async () => {
    registrySetForTest({});
    try {
        assert.deepEqual(await resolveQoderBudgetEnv({ model: "claude-sonnet-4-5", userAutoCompactWindow: "300000", windowKey: "QODER_AUTOCOMPACT_WINDOW", routes: {}, upstreamUrl: "https://api2-v2.qoder.sh" }), {});
        assert.deepEqual(await resolveQoderBudgetEnv({ model: undefined, userAutoCompactWindow: undefined, windowKey: "QODER_AUTOCOMPACT_WINDOW", routes: {}, upstreamUrl: "https://api2-v2.qoder.sh" }), {});
        assert.deepEqual(await resolveQoderBudgetEnv({ model: "qoder-nonexistent-model-xyz", userAutoCompactWindow: undefined, windowKey: "QODER_AUTOCOMPACT_WINDOW", routes: {}, upstreamUrl: "https://api2-v2.qoder.sh" }), {});
    } finally {
        registryResetForTest();
    }
});

test("resolveClientCommand: qoder resolves `qoder`, falls back to `qodercli`", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-qoder-bin-"));
    try {
        const env: NodeJS.ProcessEnv = { PATH: dir };
        assert.deepEqual(resolveClientCommand("qoder", env), { command: "qoder", prefixArgs: [] });
        fs.writeFileSync(path.join(dir, "qodercli"), "");
        assert.deepEqual(resolveClientCommand("qoder", env), { command: path.join(dir, "qodercli"), prefixArgs: [] });
        fs.writeFileSync(path.join(dir, "qoder"), "");
        assert.deepEqual(resolveClientCommand("qoder", env), { command: path.join(dir, "qoder"), prefixArgs: [] });
    } finally {
        rmrf(dir);
    }
});

test("runLaunch qoder: cert-MITM envs, transport forced, budget aligned, default MITM whitelist (#653)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-qoder-launch-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevModel = process.env.QODER_MODEL;
    const prevWindow = process.env.QODER_AUTOCOMPACT_WINDOW;
    const prevTransport = process.env.QODER_MODEL_TRANSPORT;
    const prevNoProxy = process.env.NO_PROXY;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    delete process.env.QODER_MODEL;
    delete process.env.QODER_AUTOCOMPACT_WINDOW;
    delete process.env.QODER_MODEL_TRANSPORT;
    const qoderDir = path.join(home, ".qoder");
    fs.mkdirSync(qoderDir, { recursive: true });
    fs.writeFileSync(path.join(qoderDir, "settings.json"), JSON.stringify({ model: { name: "claude-sonnet-4-5" } }));
    const fakeQoder = path.join(home, process.platform === "win32" ? "fake-qoder.exe" : "fake-qoder");
    fs.writeFileSync(fakeQoder, "");
    process.env.BILI_CLIENT_BIN = fakeQoder;
    process.env.NO_PROXY = "localhost,.corp";

    const clientEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const proxyEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        const env = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        if (cmd === fakeQoder) {
            clientEnvs.push(env);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        proxyEnvs.push(env);
        return makeFakeChild(42424);
    };
    const fetchImpl = async () => ({ ok: true });
    const prevExit = process.exit;
    process.exit = (() => undefined) as typeof process.exit;

    try {
        await runLaunch(
            { client: "qoder", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1);
        const seenEnv = clientEnvs[0]!;
        const origin = seenEnv.BILLION_CONTEXT_PROXY;
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
        assert.equal(seenEnv.HTTPS_PROXY, origin);
        assert.ok(String(seenEnv.NODE_EXTRA_CA_CERTS).endsWith(path.join("billion-context", "ca", "root-ca.pem")), String(seenEnv.NODE_EXTRA_CA_CERTS));
        assert.equal(seenEnv.HTTP_PROXY, undefined, "inherited HTTP_PROXY stripped");
        assert.equal(seenEnv.NO_PROXY, undefined, "inherited NO_PROXY stripped");
        assert.equal(seenEnv.QODER_MODEL_TRANSPORT, "http");
        assert.equal(seenEnv.QODER_AUTOCOMPACT_WINDOW, "200000", "budget aligned from built-in table");
        assert.ok(proxyEnvs.length > 0, "proxy child spawned");
        const mitm = String(proxyEnvs[0]!.BILI_MITM_DOMAINS).split(",");
        for (const h of QODER_DEFAULT_MODEL_HOSTS) {
            assert.ok(mitm.includes(h), `whitelist has ${h}: ${mitm.join(",")}`);
        }
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        if (prevModel === undefined) delete process.env.QODER_MODEL;
        else process.env.QODER_MODEL = prevModel;
        if (prevWindow === undefined) delete process.env.QODER_AUTOCOMPACT_WINDOW;
        else process.env.QODER_AUTOCOMPACT_WINDOW = prevWindow;
        if (prevTransport === undefined) delete process.env.QODER_MODEL_TRANSPORT;
        else process.env.QODER_MODEL_TRANSPORT = prevTransport;
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
        rmrf(home);
    }
});

test("resolveTraeHome: TRAE_CONFIG_DIR override > ~/.trae", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-trae-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    try {
        assert.equal(resolveTraeHome({ TRAE_CONFIG_DIR: "/tmp/trae-cfg" }), "/tmp/trae-cfg");
        assert.equal(resolveTraeHome({}), path.join(home, ".trae"));
    } finally {
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(home);
    }
});

test("readTraeConfig: TRAE_CLI_API_HOST (scheme + trailing slash stripped)", () => {
    assert.deepEqual(readTraeConfig({}), {});
    assert.deepEqual(readTraeConfig({ TRAE_CLI_API_HOST: "https://my-relay.example.com:8443/" }), { modelApiHost: "my-relay.example.com:8443" });
    assert.deepEqual(readTraeConfig({ TRAE_CLI_API_HOST: "my-relay.example.com" }), { modelApiHost: "my-relay.example.com" });
    assert.deepEqual(readTraeConfig({ TRAE_CLI_API_HOST: "   " }), {});
});

test("discoverRoutes: trae → default MITM hosts, no rewrites (#655)", () => {
    const routes = discoverRoutes("trae", {});
    assert.deepEqual(routes.httpsDomains, TRAE_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpsRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("discoverRoutes: trae modelApiHost replaces the default map", () => {
    const config: ClientConfig = { trae: { modelApiHost: "my-relay.example.com" } };
    const routes = discoverRoutes("trae", config);
    assert.deepEqual(routes.httpsDomains, ["my-relay.example.com"]);
});

test("discoverRoutes: trae modelApiHost with :port → hostname only (MITM is SNI-based, #655)", () => {
    const config: ClientConfig = { trae: { modelApiHost: "my-relay.example.com:8443" } };
    const routes = discoverRoutes("trae", config);
    assert.deepEqual(routes.httpsDomains, ["my-relay.example.com"]);
});

test("buildTraeEnv: HTTPS_PROXY + SSL_CERT_FILE + BILLION_CONTEXT_PROXY, baseEnv preserved", () => {
    const env = buildTraeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { FOO: "bar" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.FOO, "bar");
});

test("buildJcodeEnv: HTTPS_PROXY + SSL_CERT_FILE + BILLION_CONTEXT_PROXY + NO_PROXY loopback, baseEnv preserved", () => {
    const env = buildJcodeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { FOO: "bar" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
    assert.equal(env.FOO, "bar");
});

test("discoverRoutes: jcode whitelists the default zai host for cert-MITM", () => {
    const routes = discoverRoutes("jcode", {});
    assert.deepEqual(routes.httpsDomains, [...JCODE_DEFAULT_MODEL_HOSTS]);
});

test("readAiderConfig: env channels, order + dedupe (#1048)", () => {
    assert.deepEqual(readAiderConfig({}, "/nonexistent"), { baseUrls: [] });
    const env: NodeJS.ProcessEnv = {
        OPENAI_API_BASE: "https://a.example.com/v1",
        OPENAI_BASE_URL: "https://a.example.com/v1",
        ANTHROPIC_BASE_URL: "https://b.example.com",
        GEMINI_API_BASE: "   ",
    };
    assert.deepEqual(readAiderConfig(env, "/nonexistent"), { baseUrls: ["https://a.example.com/v1", "https://b.example.com"] });
});

test("readAiderConfUrls: home > git root > cwd precedence, quoted values (#1048)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-aider-home-"));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "bili-aider-repo-"));
    const work = path.join(repo, "work");
    try {
        fs.mkdirSync(path.join(repo, ".git"));
        fs.mkdirSync(work);
        const homeConf = path.join(home, ".aider.conf.yml");
        const gitConf = path.join(repo, ".aider.conf.yml");
        const cwdConf = path.join(work, ".aider.conf.yml");
        fs.writeFileSync(homeConf, "openai-api-base: https://home.example.com/v1\n");
        fs.writeFileSync(gitConf, 'openai-api-base: "https://git.example.com/v1"\n');
        fs.writeFileSync(cwdConf, "openai-api-base: https://cwd.example.com/v1\n");
        const confEnv: NodeJS.ProcessEnv = { HOME: home };
        assert.deepEqual(readAiderConfUrls(work, confEnv), ["https://home.example.com/v1"]);
        fs.rmSync(homeConf);
        assert.deepEqual(readAiderConfUrls(work, confEnv), ["https://git.example.com/v1"]);
        fs.rmSync(gitConf);
        assert.deepEqual(readAiderConfUrls(work, confEnv), ["https://cwd.example.com/v1"]);
    } finally {
        rmrf(home);
        rmrf(repo);
    }
});

test("discoverAiderArgUrls: --openai-api-base space/equal forms + --set-env filtering (#1048)", () => {
    assert.deepEqual(discoverAiderArgUrls([]), []);
    assert.deepEqual(discoverAiderArgUrls(["-m", "gpt-4o"]), []);
    assert.deepEqual(
        discoverAiderArgUrls(["--openai-api-base", "https://x.example.com/v1", "-m", "gpt-4o"]),
        ["https://x.example.com/v1"],
    );
    assert.deepEqual(
        discoverAiderArgUrls(["--openai-api-base=https://y.example.com/v1"]),
        ["https://y.example.com/v1"],
    );
    assert.deepEqual(
        discoverAiderArgUrls(["--set-env", "ANTHROPIC_API_BASE=https://z.example.com"]),
        ["https://z.example.com"],
    );
    assert.deepEqual(
        discoverAiderArgUrls(["--set-env=OPENAI_BASE_URL=https://w.example.com"]),
        ["https://w.example.com"],
    );
    assert.deepEqual(discoverAiderArgUrls(["--set-env", "UNRELATED=1", "--set-env", "OPENAI_API_BASE"]), []);
});

test("discoverRoutes: aider → default hosts when nothing declared (#1048)", () => {
    const routes = discoverRoutes("aider", {});
    assert.deepEqual(routes.httpsDomains, AIDER_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpsRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("discoverRoutes: aider classifies declared URLs — https MITM, http LAN forward-proxy, loopback inventory (#1048)", () => {
    const config: ClientConfig = { aider: { baseUrls: [
        "https://relay.example.com/v1",
        "http://lan-gw.example:8080/v1",
        "http://127.0.0.1:11434/v1",
        "https://relay.example.com/v1",
    ] } };
    const routes = discoverRoutes("aider", config);
    assert.deepEqual(routes.httpsDomains, ["relay.example.com"]);
    assert.deepEqual(routes.httpEnvRoutes, ["http://lan-gw.example:8080/v1"]);
    assert.deepEqual(routes.httpRewrites, [{ key: "aider-1", realUpstream: "http://127.0.0.1:11434/v1" }]);
    assert.deepEqual(routes.httpsRewrites, []);
});

test("discoverRoutes: aider with only a loopback endpoint → no defaults, inventory only (#1048)", () => {
    const config: ClientConfig = { aider: { baseUrls: ["http://127.0.0.1:11434/v1"] } };
    const routes = discoverRoutes("aider", config);
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
    assert.equal(routes.httpRewrites.length, 1);
});

test("buildAiderEnv: dual CA vars + NO_PROXY loopback + conditional HTTP_PROXY (#1048)", () => {
    const noHttp = buildAiderEnv("http://127.0.0.1:8787", "/tmp/combined-ca.pem", { FOO: "bar" }, false);
    assert.equal(noHttp.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(noHttp.HTTP_PROXY, undefined);
    assert.equal(noHttp.SSL_CERT_FILE, "/tmp/combined-ca.pem");
    assert.equal(noHttp.REQUESTS_CA_BUNDLE, "/tmp/combined-ca.pem");
    assert.equal(noHttp.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(noHttp.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(noHttp.no_proxy, "localhost,127.0.0.1,::1");
    assert.equal(noHttp.FOO, "bar");
    const withHttp = buildAiderEnv("http://127.0.0.1:8787", "/tmp/combined-ca.pem", {}, true);
    assert.equal(withHttp.HTTP_PROXY, "http://127.0.0.1:8787");
});

test("resolveClientCommand: aider resolves the `aider` bin generically (#1048)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-aider-bin-"));
    try {
        const env: NodeJS.ProcessEnv = { PATH: dir };
        assert.deepEqual(resolveClientCommand("aider", env), { command: "aider", prefixArgs: [] });
        fs.writeFileSync(path.join(dir, "aider"), "");
        assert.deepEqual(resolveClientCommand("aider", env), { command: path.join(dir, "aider"), prefixArgs: [] });
    } finally {
        rmrf(dir);
    }
});

test("buildCopilotEnv: HTTPS_PROXY + SSL_CERT_FILE + BILLION_CONTEXT_PROXY, baseEnv preserved (#1049)", () => {
    const env = buildCopilotEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { FOO: "bar" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.FOO, "bar");
});

test("buildAmpEnv: HTTPS_PROXY + SSL_CERT_FILE + BILLION_CONTEXT_PROXY, baseEnv preserved (#1049)", () => {
    const env = buildAmpEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { FOO: "bar" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.FOO, "bar");
});

test("buildCrushEnv: HTTPS_PROXY + SSL_CERT_FILE + BILLION_CONTEXT_PROXY, baseEnv preserved (#2340)", () => {
    const env = buildCrushEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { FOO: "bar" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.FOO, "bar");
});

test("discoverRoutes: copilot whitelists api.githubcopilot.com + plan subdomains (#1049)", () => {
    const routes = discoverRoutes("copilot", {});
    assert.deepEqual(routes.httpsDomains, [...COPILOT_DEFAULT_MODEL_HOSTS]);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("discoverRoutes: amp whitelists ampcode.com (#1049)", () => {
    const routes = discoverRoutes("amp", {});
    assert.deepEqual(routes.httpsDomains, [...AMP_DEFAULT_MODEL_HOSTS]);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("discoverRoutes: crush whitelists built-in provider hosts (#2340)", () => {
    const routes = discoverRoutes("crush", {});
    assert.deepEqual(routes.httpsDomains, [...CRUSH_DEFAULT_MODEL_HOSTS]);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("discoverRoutes: crush adds crush.json base_url hosts, deduped, https only (#2340)", () => {
    const config: ClientConfig = { crush: { baseUrls: [
        "https://relay.example.com/v1",
        "https://api.anthropic.com/v1", // dup of the built-ins — must not repeat
        "http://127.0.0.1:11434/v1",    // http loopback — cannot be cert-MITM'd
        "not-a-url",
    ] } };
    const routes = discoverRoutes("crush", config);
    assert.deepEqual(routes.httpsDomains, [...CRUSH_DEFAULT_MODEL_HOSTS, "relay.example.com"]);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("readCrushConfig: collects https base_urls from crush.json, tolerates junk (#2340)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-crush-cfg-"));
    fs.mkdirSync(path.join(home, "crush"), { recursive: true });
    fs.writeFileSync(path.join(home, "crush", "crush.json"), JSON.stringify({
        providers: {
            openai: { base_url: "https://relay.example.com/v1" },
            custom: { base_url: "https://api.deepseek.com/bili" },
            loopback: { base_url: "http://127.0.0.1:11434/v1" },
            junk: { base_url: 12345 },
            none: { api_key: "sk-x" },
        },
    }));
    assert.deepEqual(readCrushConfig({ XDG_CONFIG_HOME: home }), { baseUrls: ["https://relay.example.com/v1", "https://api.deepseek.com/bili"] });
    // CRUSH_CONFIG points straight at the file, bypassing the XDG layout
    assert.deepEqual(
        readCrushConfig({ XDG_CONFIG_HOME: "/nonexistent", CRUSH_CONFIG: path.join(home, "crush", "crush.json") }),
        { baseUrls: ["https://relay.example.com/v1", "https://api.deepseek.com/bili"] },
    );
    // missing / corrupt files must soft-fail to an empty config
    assert.deepEqual(readCrushConfig({ XDG_CONFIG_HOME: "/nonexistent" }), {});
    fs.writeFileSync(path.join(home, "crush", "crush.json"), "{not json");
    assert.deepEqual(readCrushConfig({ XDG_CONFIG_HOME: home }), {});
});

test("buildZedEnv: HTTPS_PROXY + SSL_CERT_FILE + NO_PROXY loopback bypass (#2340)", () => {
    const env = buildZedEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { FOO: "bar" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.equal(env.BILLION_CONTEXT_PROXY, "http://127.0.0.1:8787");
    // loopback providers (ollama/lmstudio) must stay direct
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(env.no_proxy, "localhost,127.0.0.1,::1");
    assert.equal(env.FOO, "bar");
});

test("discoverRoutes: zed whitelists built-in provider hosts (#2340)", () => {
    const routes = discoverRoutes("zed", {});
    assert.deepEqual(routes.httpsDomains, [...ZED_DEFAULT_MODEL_HOSTS]);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("discoverRoutes: zed adds settings.json api_url hosts, deduped, https only (#2340)", () => {
    const config: ClientConfig = { zed: { baseUrls: [
        "https://relay.example.com/v1",
        "https://api.openai.com/v1",   // dup of the built-ins — must not repeat
        "http://127.0.0.1:11434/v1",   // http loopback — cannot be cert-MITM'd
        "not-a-url",
    ] } };
    const routes = discoverRoutes("zed", config);
    assert.deepEqual(routes.httpsDomains, [...ZED_DEFAULT_MODEL_HOSTS, "relay.example.com"]);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("readZedConfig: collects https api_urls from settings.json, tolerates junk (#2340)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-zed-cfg-"));
    fs.mkdirSync(path.join(home, "zed"), { recursive: true });
    fs.writeFileSync(path.join(home, "zed", "settings.json"), JSON.stringify({
        language_models: {
            openai_compatible: {
                mine: { api_url: "https://relay.example.com/v1", api_key: "sk-x" },
                loopback: { api_url: "http://127.0.0.1:11434/v1" },
                junk: { api_url: 12345 },
                none: { available_models: [] },
            },
            anthropic_compatible: {
                ant: { api_url: "https://api.deepseek.com/bili" },
            },
            ollama: { url: "http://localhost:11434" }, // not a compatible family — ignored
        },
    }));
    assert.deepEqual(readZedConfig({ XDG_CONFIG_HOME: home }), { baseUrls: ["https://relay.example.com/v1", "https://api.deepseek.com/bili"] });
    // missing / corrupt files must soft-fail to an empty config
    assert.deepEqual(readZedConfig({ XDG_CONFIG_HOME: "/nonexistent" }), {});
    fs.writeFileSync(path.join(home, "zed", "settings.json"), "{not json");
    assert.deepEqual(readZedConfig({ XDG_CONFIG_HOME: home }), {});
});

test("discoverRoutes: goose rewrites custom provider base_urls (incl. loopback), no MITM domains (#1049)", () => {
    const routes = discoverRoutes("goose", {
        goose: {
            activeProvider: "mine",
            customProviders: {
                mine: "https://api.custom.example/v1",
                local: "http://127.0.0.1:11434/v1",
                dup: "https://api.custom.example/v1",
            },
        },
    });
    assert.deepEqual(routes.httpsDomains, []);
    assert.deepEqual(routes.httpRewrites, [
        { key: "mine", realUpstream: "https://api.custom.example/v1" },
        { key: "local", realUpstream: "http://127.0.0.1:11434/v1" },
    ]);
});

test("resolveGooseDirs: GOOSE_PATH_ROOT wins; XDG fallback scatters under Block (#1049)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-goose-root-"));
    try {
        const dirs = resolveGooseDirs({ GOOSE_PATH_ROOT: root });
        assert.deepEqual(dirs, {
            configDir: path.join(root, "config"),
            dataDir: path.join(root, "data"),
            stateDir: path.join(root, "state"),
            agentsDir: path.join(root, ".agents"),
        });
        const h = os.homedir();
        const plain = resolveGooseDirs({});
        assert.equal(plain.configDir, path.join(h, ".config", "goose"));
        assert.equal(plain.dataDir, path.join(h, ".local", "share", "Block", "goose"));
        assert.equal(plain.stateDir, plain.dataDir);
        assert.equal(plain.agentsDir, path.join(plain.dataDir, ".agents"));
        const xdg = resolveGooseDirs({
            XDG_CONFIG_HOME: "/x/cfg",
            XDG_DATA_HOME: "/x/data",
            XDG_STATE_HOME: "/x/state",
        });
        assert.deepEqual(xdg, {
            configDir: path.join("/x/cfg", "goose"),
            dataDir: path.join("/x/data", "Block", "goose"),
            stateDir: path.join("/x/state", "Block", "goose"),
            agentsDir: path.join("/x/data", "Block", "goose", ".agents"),
        });
    } finally {
        rmrf(root);
    }
});

test("readGooseConfig: active_provider + custom_providers base_urls; GOOSE_PROVIDER wins (#1049)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-goose-cfg-"));
    try {
        const cfgDir = path.join(root, "config");
        fs.mkdirSync(path.join(cfgDir, "custom_providers"), { recursive: true });
        fs.writeFileSync(path.join(cfgDir, "config.toml"), 'active_provider = "mine"\n');
        fs.writeFileSync(path.join(cfgDir, "custom_providers", "mine.toml"), 'name = "Mine"\nbase_url = "https://api.custom.example/v1"  # comment\n');
        fs.writeFileSync(path.join(cfgDir, "custom_providers", "nourl.toml"), 'name = "NoUrl"\n');
        fs.writeFileSync(path.join(cfgDir, "custom_providers", "notes.txt"), "ignored");
        const dirs = resolveGooseDirs({ GOOSE_PATH_ROOT: root });
        const cfg = readGooseConfig(dirs, {});
        assert.equal(cfg.activeProvider, "mine");
        assert.deepEqual(cfg.customProviders, { mine: "https://api.custom.example/v1" });
        assert.equal(readGooseConfig(dirs, { GOOSE_PROVIDER: "override" }).activeProvider, "override");
        assert.deepEqual(readGooseConfig(resolveGooseDirs({ GOOSE_PATH_ROOT: "/nonexistent-bili-test" }), {}).customProviders, {});
    } finally {
        rmrf(root);
    }
});

test("prepareGooseHome/finalizeGooseHome: overlay layout, patched urls, merge-back round-trip (#1049)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-goose-home-"));
    try {
        const cfgDir = path.join(home, ".config", "goose");
        fs.mkdirSync(path.join(cfgDir, "custom_providers"), { recursive: true });
        fs.writeFileSync(path.join(cfgDir, "config.toml"), 'active_provider = "openai"\n');
        fs.writeFileSync(path.join(cfgDir, "custom_providers", "mine.toml"), 'name = "Mine"\nbase_url = "https://api.custom.example/v1"\n');
        fs.writeFileSync(path.join(cfgDir, "custom_providers", "other.toml"), 'name = "Other"\nbase_url = "https://keep.example/v1"\n');
        const origin = "http://127.0.0.1:9999";
        const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state") };
        const overlay = prepareGooseHome(env, origin, [{ key: "mine", realUpstream: "https://api.custom.example/v1" }]);
        assert.ok(overlay, "overlay prepared");
        const root = overlay!.root;
        assert.equal(root, path.join(home, ".config", "goose-bili"));
        assert.ok(fs.lstatSync(path.join(root, "data")).isSymbolicLink());
        assert.ok(fs.lstatSync(path.join(root, "state")).isSymbolicLink());
        assert.ok(fs.lstatSync(path.join(root, ".agents")).isSymbolicLink());
        const patched = fs.readFileSync(path.join(root, "config", "custom_providers", "mine.toml"), "utf8");
        assert.equal(patched, 'name = "Mine"\nbase_url = "' + wrapUpstream(origin, "https://api.custom.example/v1") + '"\n', "line rewritten in place, nothing else touched");
        const untouched = fs.readFileSync(path.join(root, "config", "custom_providers", "other.toml"), "utf8");
        assert.ok(untouched.includes('base_url = "https://keep.example/v1"'), untouched);
        const realBefore = fs.readFileSync(path.join(cfgDir, "custom_providers", "mine.toml"), "utf8");
        assert.ok(realBefore.includes("https://api.custom.example/v1"), "real config untouched by prepare");
        fs.writeFileSync(path.join(root, "config", "config.toml"), 'active_provider = "mine"\n');
        fs.writeFileSync(path.join(root, "config", "custom_providers", "newprov.toml"), 'name = "New"\nbase_url = "https://new.example/v1"\n');
        finalizeGooseHome(overlay!);
        assert.ok(fs.readFileSync(path.join(cfgDir, "config.toml"), "utf8").includes('active_provider = "mine"'), "user edit merged back");
        assert.ok(fs.existsSync(path.join(cfgDir, "custom_providers", "newprov.toml")), "new file merged back");
        assert.ok(realBefore === fs.readFileSync(path.join(cfgDir, "custom_providers", "mine.toml"), "utf8"), "patched file did NOT leak into real config");
        assert.ok(!fs.readFileSync(path.join(cfgDir, "custom_providers", "newprov.toml"), "utf8").includes(origin), "new file content verbatim");
        assert.equal(prepareGooseHome(env, origin, []), undefined, "no rewrites → no overlay");
    } finally {
        rmrf(home);
    }
});

test("resolveClientCommand: trae resolves `traecli`, falls back to `trae-cli` then `trae`", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-trae-bin-"));
    try {
        const env: NodeJS.ProcessEnv = { PATH: dir };
        assert.deepEqual(resolveClientCommand("trae", env), { command: "traecli", prefixArgs: [] });
        fs.writeFileSync(path.join(dir, "trae"), "");
        assert.deepEqual(resolveClientCommand("trae", env), { command: path.join(dir, "trae"), prefixArgs: [] });
        fs.writeFileSync(path.join(dir, "trae-cli"), "");
        assert.deepEqual(resolveClientCommand("trae", env), { command: path.join(dir, "trae-cli"), prefixArgs: [] });
        fs.writeFileSync(path.join(dir, "traecli"), "");
        assert.deepEqual(resolveClientCommand("trae", env), { command: path.join(dir, "traecli"), prefixArgs: [] });
    } finally {
        rmrf(dir);
    }
});

test("runLaunch trae: cert-MITM envs (SSL_CERT_FILE combined bundle), no budget/transport, default MITM whitelist (#655)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-trae-launch-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevNoProxy = process.env.NO_PROXY;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    const fakeTrae = path.join(home, process.platform === "win32" ? "fake-traecli.exe" : "fake-traecli");
    fs.writeFileSync(fakeTrae, "");
    process.env.BILI_CLIENT_BIN = fakeTrae;
    process.env.NO_PROXY = "localhost,.corp";

    const clientEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const proxyEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        const env = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        if (cmd === fakeTrae) {
            clientEnvs.push(env);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        proxyEnvs.push(env);
        return makeFakeChild(42424);
    };
    const fetchImpl = async () => ({ ok: true });
    const prevExit = process.exit;
    process.exit = (() => undefined) as typeof process.exit;

    try {
        await runLaunch(
            { client: "trae", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1);
        const seenEnv = clientEnvs[0]!;
        const origin = seenEnv.BILLION_CONTEXT_PROXY;
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
        assert.equal(seenEnv.HTTPS_PROXY, origin);
        assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(seenEnv.SSL_CERT_FILE));
        assert.equal(seenEnv.NODE_EXTRA_CA_CERTS, undefined, "trae uses SSL_CERT_FILE, not NODE_EXTRA_CA_CERTS");
        assert.equal(seenEnv.HTTP_PROXY, undefined, "inherited HTTP_PROXY stripped");
        assert.equal(seenEnv.NO_PROXY, undefined, "inherited NO_PROXY stripped");
        assert.ok(proxyEnvs.length > 0, "proxy child spawned");
        const mitm = String(proxyEnvs[0]!.BILI_MITM_DOMAINS).split(",");
        for (const h of TRAE_DEFAULT_MODEL_HOSTS) {
            assert.ok(mitm.includes(h), `whitelist has ${h}: ${mitm.join(",")}`);
        }
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
        rmrf(home);
    }
});

const INHERITED_PROXY_TEST_VARS = [
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
] as const;

// #890 harness: runLaunch under a fake HOME + BILI_CLIENT_BIN shim with every
// generic proxy var inherited from the "shell"; returns the env actually
// passed to the spawned client.
async function captureLaunchedClientEnv(client: ClientName): Promise<NodeJS.ProcessEnv> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `bili-${client}-launch-`));
    const fakeBin = path.join(home, process.platform === "win32" ? `fake-${client}.exe` : `fake-${client}`);
    fs.writeFileSync(fakeBin, "");
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevExit = process.exit;
    const savedProxyVars: Record<string, string | undefined> = {};
    for (const k of INHERITED_PROXY_TEST_VARS) savedProxyVars[k] = process.env[k];
    const prevMarker = process.env.BILI_TEST_MARKER;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    process.env.BILI_CLIENT_BIN = fakeBin;
    process.env.http_proxy = "http://corp-proxy.example:8080";
    process.env.https_proxy = "http://corp-proxy.example:8080";
    process.env.all_proxy = "socks5://corp-proxy.example:1080";
    process.env.HTTP_PROXY = "http://corp-proxy.example:8080";
    process.env.ALL_PROXY = "socks5://corp-proxy.example:1080";
    process.env.no_proxy = "localhost,.corp";
    process.env.NO_PROXY = "localhost,.corp";
    process.env.BILI_TEST_MARKER = "keep";
    process.exit = (() => undefined) as typeof process.exit;
    const clientEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        const env = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        if (cmd === fakeBin) {
            clientEnvs.push(env);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        return makeFakeChild(42424);
    };
    try {
        await runLaunch(
            { client, clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42424 }), spawnImpl, sleep: () => Promise.resolve() },
        );
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        for (const [k, v] of Object.entries(savedProxyVars)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        if (prevMarker === undefined) delete process.env.BILI_TEST_MARKER;
        else process.env.BILI_TEST_MARKER = prevMarker;
        rmrf(home);
    }
    assert.equal(clientEnvs.length, 1, `${client} client spawned exactly once`);
    return clientEnvs[0]!;
}

function assertInheritedProxyStripped(
    seenEnv: NodeJS.ProcessEnv,
    origin: string,
    launcherOwned?: Partial<Record<"NO_PROXY" | "no_proxy", string>>,
): void {
    assert.equal(seenEnv.HTTPS_PROXY, origin, "HTTPS_PROXY points at bili");
    for (const k of INHERITED_PROXY_TEST_VARS) {
        if (k === "HTTPS_PROXY") continue;
        if ((k === "NO_PROXY" || k === "no_proxy") && launcherOwned && k in launcherOwned) {
            // #3446: base-URL lanes get a launcher-owned loopback NO_PROXY value;
            // inherited entries must still be gone from it.
            assert.equal(seenEnv[k], launcherOwned[k], `${k} carries only the launcher-owned value`);
            continue;
        }
        assert.equal(seenEnv[k], undefined, `inherited ${k} stripped`);
    }
    assert.equal(seenEnv.BILI_TEST_MARKER, "keep", "unrelated env vars preserved");
}

test("runLaunch opencode: inherited proxy vars stripped so traffic cannot bypass bili (#890)", async () => {
    const seenEnv = await captureLaunchedClientEnv("opencode");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.NODE_EXTRA_CA_CERTS).endsWith(path.join("billion-context", "ca", "root-ca.pem")), String(seenEnv.NODE_EXTRA_CA_CERTS));
    assertInheritedProxyStripped(seenEnv, String(origin));
});

test("runLaunch pi: inherited proxy vars stripped so traffic cannot bypass bili (#890)", async () => {
    const seenEnv = await captureLaunchedClientEnv("pi");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.NODE_EXTRA_CA_CERTS).endsWith(path.join("billion-context", "ca", "root-ca.pem")), String(seenEnv.NODE_EXTRA_CA_CERTS));
    assertInheritedProxyStripped(seenEnv, String(origin));
});

test("runLaunch omp: inherited proxy vars stripped so traffic cannot bypass bili (#890)", async () => {
    const seenEnv = await captureLaunchedClientEnv("omp");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.NODE_EXTRA_CA_CERTS).endsWith(path.join("billion-context", "ca", "root-ca.pem")), String(seenEnv.NODE_EXTRA_CA_CERTS));
    assertInheritedProxyStripped(seenEnv, String(origin));
});

test("runLaunch codex: inherited proxy vars stripped so traffic cannot bypass bili (#890)", async () => {
    const prevPlugin = process.env.BILI_LAUNCHER_PLUGIN;
    process.env.BILI_LAUNCHER_PLUGIN = "0";
    let seenEnv: NodeJS.ProcessEnv;
    try {
        seenEnv = await captureLaunchedClientEnv("codex");
    } finally {
        if (prevPlugin === undefined) delete process.env.BILI_LAUNCHER_PLUGIN;
        else process.env.BILI_LAUNCHER_PLUGIN = prevPlugin;
    }
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(seenEnv.SSL_CERT_FILE));
    assert.equal(seenEnv.NODE_EXTRA_CA_CERTS, undefined, "codex uses SSL_CERT_FILE, not NODE_EXTRA_CA_CERTS");
    assertInheritedProxyStripped(seenEnv, String(origin));
});

test("runLaunch codebuddy: inherited proxy vars stripped so loopback traffic cannot be hijacked (#890)", async () => {
    const seenEnv = await captureLaunchedClientEnv("codebuddy");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.NODE_EXTRA_CA_CERTS).endsWith(path.join("billion-context", "ca", "root-ca.pem")), String(seenEnv.NODE_EXTRA_CERTS));
    // #3446: codebuddy's base URL is bili's own /bili/ loopback form, so the launcher
    // injects the loopback NO_PROXY triple; the inherited ".corp" entries stay stripped.
    assertInheritedProxyStripped(seenEnv, String(origin), {
        NO_PROXY: "localhost,127.0.0.1,::1",
        no_proxy: "localhost,127.0.0.1,::1",
    });
});

async function runAiderLaunch(
    clientArgs: string[],
    envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ client: NodeJS.ProcessEnv; proxy: NodeJS.ProcessEnv }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-aider-launch-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const savedProxyVars: Record<string, string | undefined> = {};
    for (const k of INHERITED_PROXY_TEST_VARS) {
        savedProxyVars[k] = process.env[k];
        delete process.env[k];
    }
    const savedOverrides: [string, string | undefined][] = [];
    for (const [k, v] of Object.entries(envOverrides)) {
        savedOverrides.push([k, process.env[k]]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    const fakeAider = path.join(home, process.platform === "win32" ? "fake-aider.exe" : "fake-aider");
    fs.writeFileSync(fakeAider, "");
    process.env.BILI_CLIENT_BIN = fakeAider;
    let clientEnv: NodeJS.ProcessEnv | undefined;
    let proxyEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        const env = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        if (cmd === fakeAider) {
            clientEnv = env;
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        proxyEnv = env;
        return makeFakeChild(42424);
    };
    const fetchImpl = async () => ({ ok: true });
    const prevExit = process.exit;
    process.exit = (() => undefined) as typeof process.exit;
    try {
        await runLaunch(
            { client: "aider", clientArgs, overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        for (const [k, v] of Object.entries(savedProxyVars)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        for (const [k, v] of savedOverrides) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        rmrf(home);
    }
    assert.ok(clientEnv, "aider client spawned");
    assert.ok(proxyEnv, "proxy child spawned");
    return { client: clientEnv!, proxy: proxyEnv! };
}

test("runLaunch aider: nothing declared → default hosts whitelisted for cert-MITM (#1048)", async () => {
    const { client, proxy } = await runAiderLaunch([]);
    const origin = String(client.BILLION_CONTEXT_PROXY);
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), `origin: ${origin}`);
    assert.equal(client.HTTPS_PROXY, origin);
    assert.ok(String(client.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(client.SSL_CERT_FILE));
    assert.equal(client.REQUESTS_CA_BUNDLE, client.SSL_CERT_FILE, "requests reads REQUESTS_CA_BUNDLE");
    assert.equal(client.HTTP_PROXY, undefined, "no plaintext-http route → HTTP_PROXY unset");
    assert.equal(client.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(client.no_proxy, "localhost,127.0.0.1,::1");
    const mitm = String(proxy.BILI_MITM_DOMAINS).split(",");
    for (const h of AIDER_DEFAULT_MODEL_HOSTS) {
        assert.ok(mitm.includes(h), `whitelist has ${h}: ${mitm.join(",")}`);
    }
});

test("runLaunch aider: env endpoints discovered — https MITM-whitelisted, http LAN forward-proxied, inherited proxy stripped (#1048)", async () => {
    const { client, proxy } = await runAiderLaunch([], {
        OPENAI_API_BASE: "https://my-relay.example.com/v1",
        ANTHROPIC_BASE_URL: "http://lan-gw.example:8080/v1",
        http_proxy: "http://evil.example:3128",
    });
    const origin = String(client.BILLION_CONTEXT_PROXY);
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), `origin: ${origin}`);
    assert.equal(client.HTTPS_PROXY, origin);
    assert.ok(String(client.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(client.SSL_CERT_FILE));
    assert.equal(client.REQUESTS_CA_BUNDLE, client.SSL_CERT_FILE);
    assert.equal(client.HTTP_PROXY, origin, "plaintext-http route present → HTTP_PROXY set");
    assert.equal(client.http_proxy, undefined, "inherited http_proxy stripped");
    const mitm = String(proxy.BILI_MITM_DOMAINS).split(",");
    assert.ok(mitm.includes("my-relay.example.com"), `whitelist has my-relay.example.com: ${mitm.join(",")}`);
    assert.ok(!mitm.includes("lan-gw.example"), "plaintext-http host rides the forward proxy, not MITM");
});

test("runLaunch aider: --openai-api-base passed through the launcher updates the whitelist (#1048)", async () => {
    const { proxy } = await runAiderLaunch(["--openai-api-base", "https://arg-relay.example.com/v1"]);
    const mitm = String(proxy.BILI_MITM_DOMAINS).split(",");
    assert.ok(mitm.includes("arg-relay.example.com"), `whitelist has arg-relay.example.com: ${mitm.join(",")}`);
});

test("parseKimiToml: providers/models/env channels (quoted names, overrides win, per-model base_url)", () => {
    const toml = [
        "# comment",
        'default_model = "k3"',
        "",
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        'base_url = "https://api.kimi.com/coding/v1"',
        "",
        "[providers.local]",
        "type = \"openai\"",
        'base_url = "http://127.0.0.1:8199/v1"',
        "",
        "[providers.envonly]",
        "type = \"openai\"",
        "",
        "[providers.envonly.env]",
        'OPENAI_BASE_URL = "https://relay.example.com/v1"',
        "",
        "[models.k3]",
        'provider = "managed:kimi-code"',
        'model = "kimi-for-coding"',
        "max_context_size = 1048576",
        "",
        "[models.k3.overrides]",
        "max_context_size = 200000",
        "",
        "[models.local-m]",
        'provider = "local"',
        'model = "qwen3.8-27b"',
        "max_context_size = 262144",
        'base_url = "http://10.0.0.5:9000/v1"',
        "",
        "[models.nowin]",
        'model = "x"',
        "max_context_size = notanumber",
    ].join("\n");
    const cfg = parseKimiToml(toml);
    assert.equal(cfg.defaultModel, "k3");
    assert.equal(cfg.providers["managed:kimi-code"]?.baseUrl, "https://api.kimi.com/coding/v1");
    assert.equal(cfg.providers.local?.baseUrl, "http://127.0.0.1:8199/v1");
    assert.equal(cfg.providers.envonly?.baseUrl, "https://relay.example.com/v1");
    assert.deepEqual(cfg.modelUrls, ["http://10.0.0.5:9000/v1"]);
    assert.deepEqual(cfg.models, [
        { id: "kimi-for-coding", contextWindow: 200000 },
        { id: "qwen3.8-27b", contextWindow: 262144 },
    ]);
});

test("readKimiConfig + resolveKimiHome: KIMI_CODE_HOME override, env channels, synthetic KIMI_MODEL window (#757)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-kimi-home-"));
    try {
        assert.equal(resolveKimiHome({ KIMI_CODE_HOME: "/tmp/kh" }), "/tmp/kh");
        assert.ok(resolveKimiHome({}).endsWith(path.join(".kimi-code")));
        assert.deepEqual(readKimiConfig(home, {}), { providers: {} });
        fs.writeFileSync(
            path.join(home, "config.toml"),
            ['[providers.p]', 'base_url = "https://api.kimi.com/coding/v1"', "", "[models.m]", 'model = "kimi-for-coding"', "max_context_size = 1048576"].join("\n"),
        );
        const cfg = readKimiConfig(home, {
            KIMI_MODEL_NAME: "synthetic-model",
            KIMI_MODEL_MAX_CONTEXT_SIZE: "999999",
            KIMI_MODEL_BASE_URL: "http://10.1.1.1:2/v1",
            KIMI_CODE_BASE_URL: "https://api.kimi.ai/coding/v1",
        } as NodeJS.ProcessEnv);
        assert.deepEqual(cfg.envUrls, ["http://10.1.1.1:2/v1", "https://api.kimi.ai/coding/v1"]);
        assert.deepEqual(cfg.models, [
            { id: "kimi-for-coding", contextWindow: 1048576 },
            { id: "synthetic-model", contextWindow: 999999 },
        ]);
        const defSize = readKimiConfig(home, { KIMI_MODEL_NAME: "m2" } as NodeJS.ProcessEnv);
        assert.deepEqual(defSize.models, [
            { id: "kimi-for-coding", contextWindow: 1048576 },
            { id: "m2", contextWindow: 262144 },
        ]);
    } finally {
        rmrf(home);
    }
});

test("discoverRoutes: kimi — loopback inventory, https MITM whitelist, http proxy-env, wrapped skip (#757)", () => {
    const config: ClientConfig = {
        kimi: {
            providers: {
                local: { baseUrl: "http://127.0.0.1:8199/v1" },
                remote: { baseUrl: "https://api.kimi.com/coding/v1" },
                lan: { baseUrl: "http://10.0.0.5:1234/v1" },
                wrapped: { baseUrl: "http://127.0.0.1:8787/bili/http://127.0.0.1:9999/v1" },
            },
            modelUrls: ["https://api.kimi.com/coding/v1", "::::"],
            envUrls: ["http://10.0.0.5:1234/v1"],
        },
    };
    const routes = discoverRoutes("kimi", config);
    assert.deepEqual(routes.httpRewrites, [{ key: "kimi-1", realUpstream: "http://127.0.0.1:8199/v1" }]);
    assert.deepEqual(routes.httpsDomains, ["api.kimi.com"]);
    assert.deepEqual(routes.httpEnvRoutes, ["http://10.0.0.5:1234/v1"]);
});

test("discoverRoutes: kimi empty config → managed OAuth fallback hosts (#757)", () => {
    const routes = discoverRoutes("kimi", {});
    assert.deepEqual(routes.httpsDomains, KIMI_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("resolveClientCommand: kimi resolves `kimi` on PATH, falls back to <home>/bin/kimi (#757)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-kimi-bin-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-kimi-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    try {
        const env: NodeJS.ProcessEnv = { PATH: dir };
        assert.deepEqual(resolveClientCommand("kimi", env), { command: path.join(home, ".kimi-code", "bin", "kimi"), prefixArgs: [] });
        fs.writeFileSync(path.join(dir, "kimi"), "");
        assert.deepEqual(resolveClientCommand("kimi", env), { command: path.join(dir, "kimi"), prefixArgs: [] });
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-kimi-empty-"));
        assert.deepEqual(resolveClientCommand("kimi", { PATH: emptyDir, KIMI_CODE_HOME: "/tmp/kh" }), { command: path.join("/tmp/kh", "bin", "kimi"), prefixArgs: [] });
        rmrf(emptyDir);
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(dir);
        rmrf(home);
    }
});

test("runLaunch kimi: cert-MITM envs (combined CA on SSL_CERT_FILE + NODE_EXTRA_CA_CERTS), discovered host whitelist, model windows (#757)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-kimi-launch-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevNoProxy = process.env.NO_PROXY;
    fs.mkdirSync(path.join(home, ".kimi-code"));
    fs.writeFileSync(
        path.join(home, ".kimi-code", "config.toml"),
        ['default_model = "k3"', "", '[providers."managed:kimi-code"]', "type = \"kimi\"", 'base_url = "https://api.kimi.com/coding/v1"', "", "[models.k3]", 'model = "kimi-for-coding"', "max_context_size = 1048576"].join("\n"),
    );
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    const fakeKimi = path.join(home, process.platform === "win32" ? "fake-kimi.exe" : "fake-kimi");
    fs.writeFileSync(fakeKimi, "");
    process.env.BILI_CLIENT_BIN = fakeKimi;
    process.env.NO_PROXY = "localhost,.corp";

    const clientEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const proxyEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        const env = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        if (cmd === fakeKimi) {
            clientEnvs.push(env);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        proxyEnvs.push(env);
        return makeFakeChild(42425);
    };
    const fetchImpl = async () => ({ ok: true });
    const prevExit = process.exit;
    process.exit = (() => undefined) as typeof process.exit;

    try {
        await runLaunch(
            { client: "kimi", clientArgs: [], overrides: {} },
            { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1);
        const seenEnv = clientEnvs[0]!;
        const origin = seenEnv.HTTPS_PROXY;
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
        assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(seenEnv.SSL_CERT_FILE));
        assert.equal(seenEnv.NODE_EXTRA_CA_CERTS, seenEnv.SSL_CERT_FILE, "combined bundle on both CA vars");
        assert.equal(seenEnv.HTTP_PROXY, undefined, "no plain-http routes → no HTTP_PROXY");
        assert.equal(seenEnv.NO_PROXY, undefined, "inherited NO_PROXY stripped");
        assert.equal(seenEnv.BILLION_CONTEXT_PROXY, undefined, "kimi has no agent-side plugin consumer");
        assert.ok(proxyEnvs.length > 0, "proxy child spawned");
        const mitm = String(proxyEnvs[0]!.BILI_MITM_DOMAINS).split(",");
        assert.ok(mitm.includes("api.kimi.com"), `whitelist has api.kimi.com: ${mitm.join(",")}`);
        assert.ok(!mitm.includes("api.kimi.ai"), "explicit provider present → no managed fallback hosts");
        const windows = String(proxyEnvs[0]!.BILI_LAUNCHER_MODEL_WINDOWS ?? "");
        assert.ok(windows.includes("kimi-for-coding"), `windows: ${windows}`);
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
        rmrf(home);
    }
});

test("parseMcodeYaml: minimax_api.baseURL, custom_provider options.baseURL (reserved keys skipped), model limits → windows (#1050)", () => {
    const yaml = [
        "minimax_api:",
        "  apiKey: sk-mm",
        "  baseURL: https://agent.minimax.io/mavis/api/v1/llm/v1",
        "custom_provider:",
        "  minimax_api:",
        "    options:",
        "      baseURL: https://ignored.example.com/",
        "  relay:",
        "    name: Relay",
        '    options:',
        '      apiKey: "sk-relay"',
        "      baseURL: https://relay.example.com/anthropic",
        "    models:",
        "      MiniMax-M3:",
        "        limit:",
        "          context: 200000",
        "          output: 16384",
        "      NoLimit:",
        "        limit:",
        "          context: 128000",
        "",
    ].join("\n");
    const cfg = parseMcodeYaml(yaml);
    assert.deepEqual(cfg.providers, {
        minimax_api: { baseUrl: "https://agent.minimax.io/mavis/api/v1/llm/v1" },
        relay: { baseUrl: "https://relay.example.com/anthropic" },
    });
    assert.deepEqual(cfg.models, [
        { id: "MiniMax-M3", contextWindow: 200000, maxOutput: 16384 },
        { id: "NoLimit", contextWindow: 128000 },
    ]);
});

test("readMcodeConfig: window merge keeps the known maxOutput when a larger context window replaces it (#1060)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcode-merge-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    try {
        fs.mkdirSync(path.join(home, ".minimax"));
        fs.writeFileSync(
            path.join(home, ".minimax", "config.yaml"),
            ["custom_provider:", "  a:", "    models:", "      m1:", "        limit:", "          context: 200000", "          output: 8192", "      m2:", "        limit:", "          context: 100000", "          output: 4096"].join("\n"),
        );
        fs.mkdirSync(path.join(home, ".minimax-work"));
        fs.writeFileSync(
            path.join(home, ".minimax-work", "config.yaml"),
            ["custom_provider:", "  a:", "    models:", "      m1:", "        limit:", "          context: 400000", "      m2:", "        limit:", "          context: 300000", "          output: 2048"].join("\n"),
        );
        const cfg = readMcodeConfig({});
        const byId = new Map((cfg.models ?? []).map((w) => [w.id, w]));
        assert.equal(byId.get("m1")?.contextWindow, 400000, "larger window from the later file wins");
        assert.equal(byId.get("m1")?.maxOutput, 8192, "replacement without output keeps the earlier maxOutput");
        assert.equal(byId.get("m2")?.contextWindow, 300000);
        assert.equal(byId.get("m2")?.maxOutput, 4096, "replacement with a smaller output keeps the larger maxOutput");
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(home);
    }
});

test("readMcodeConfig + resolveMcodeInstallDir: union-scan ~/.minimax*/config.yaml, MINIMAX_DATA_DIR override wins (#1050)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcode-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    try {
        assert.ok(resolveMcodeInstallDir({}).endsWith(path.join(".minimax-code")));
        assert.equal(resolveMcodeInstallDir({ MCODE_INSTALL_DIR: "/tmp/md" }), "/tmp/md");
        assert.deepEqual(readMcodeConfig({}), { providers: {} });
        fs.mkdirSync(path.join(home, ".minimax"));
        fs.writeFileSync(path.join(home, ".minimax", "config.yaml"), "minimax_api:\n  baseURL: https://agent.minimax.cn/mavis/api/v1/llm/v1\n");
        fs.mkdirSync(path.join(home, ".minimax-work"));
        fs.writeFileSync(
            path.join(home, ".minimax-work", "config.yaml"),
            ["custom_provider:", "  relay:", "    options:", "      baseURL: https://relay.example.com/anthropic", "    models:", "      MiniMax-M3:", "        limit:", "          context: 200000"].join("\n"),
        );
        const cfg = readMcodeConfig({});
        assert.equal(cfg.providers["minimax_api"]?.baseUrl, "https://agent.minimax.cn/mavis/api/v1/llm/v1");
        assert.equal(cfg.providers["relay"]?.baseUrl, "https://relay.example.com/anthropic");
        assert.deepEqual(cfg.models, [{ id: "MiniMax-M3", contextWindow: 200000 }]);
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcode-data-"));
        fs.writeFileSync(path.join(dataDir, "config.yaml"), "minimax_api:\n  baseURL: https://override.example.com/\n");
        const overridden = readMcodeConfig({ MINIMAX_DATA_DIR: dataDir });
        assert.deepEqual(Object.keys(overridden.providers), ["minimax_api"]);
        assert.equal(overridden.providers["minimax_api"]?.baseUrl, "https://override.example.com/");
        rmrf(dataDir);
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(home);
    }
});

test("discoverRoutes: mcode — loopback inventory, https MITM whitelist, http proxy-env, wrapped skip (#1050)", () => {
    const config: ClientConfig = {
        mcode: {
            providers: {
                local: { baseUrl: "http://127.0.0.1:8199/v1" },
                remote: { baseUrl: "https://agent.minimax.io/mavis/api/v1/llm/v1" },
                lan: { baseUrl: "http://10.0.0.5:1234/v1" },
                wrapped: { baseUrl: "http://127.0.0.1:8787/bili/http://127.0.0.1:9999/v1" },
            },
        },
    };
    const routes = discoverRoutes("mcode", config);
    assert.deepEqual(routes.httpRewrites, [{ key: "mcode-1", realUpstream: "http://127.0.0.1:8199/v1" }]);
    assert.deepEqual(routes.httpsDomains, ["agent.minimax.io"]);
    assert.deepEqual(routes.httpEnvRoutes, ["http://10.0.0.5:1234/v1"]);
});

test("discoverRoutes: mcode empty config → official fallback hosts (#1050)", () => {
    const routes = discoverRoutes("mcode", {});
    assert.deepEqual(routes.httpsDomains, MCODE_DEFAULT_MODEL_HOSTS);
    assert.deepEqual(routes.httpRewrites, []);
    assert.deepEqual(routes.httpEnvRoutes, []);
});

test("resolveClientCommand: mcode resolves `mcode` on PATH, falls back to <install>/bin/mcode (#1050)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcode-bin-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcode-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    try {
        const env: NodeJS.ProcessEnv = { PATH: dir };
        assert.deepEqual(resolveClientCommand("mcode", env), { command: path.join(home, ".minimax-code", "bin", "mcode"), prefixArgs: [] });
        fs.writeFileSync(path.join(dir, "mcode"), "");
        assert.deepEqual(resolveClientCommand("mcode", env), { command: path.join(dir, "mcode"), prefixArgs: [] });
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcode-empty-"));
        assert.deepEqual(resolveClientCommand("mcode", { PATH: emptyDir, MCODE_INSTALL_DIR: "/tmp/md" }), { command: path.join("/tmp/md", "bin", "mcode"), prefixArgs: [] });
        rmrf(emptyDir);
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(dir);
        rmrf(home);
    }
});

test("resolveClientCommand: antigravity/mcode honor the injectable platform param (#2260)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-agy-home-"));
    const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "bili-agy-lad-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    try {
        process.env.HOME = home;
        // os.homedir() reads USERPROFILE on win32, not HOME — seal it so the
        // non-win32 expectations below hold on every host (CI runs on Windows).
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = home;
        // Before #2260 these branches read process.platform directly, so the
        // win32 layout was unreachable from tests (and wrong under any future
        // platform-injection use). Pin both layouts via EXPLICIT platform args
        // so the test stays host-independent (a bare default-platform call
        // resolves through the real host's os.homedir() and cannot hold one
        // literal on both Windows and POSIX runners).
        assert.deepEqual(
            resolveClientCommand("antigravity", { PATH: "/nonexistent-dir-zzz", LOCALAPPDATA: localAppData }, "win32"),
            { command: path.join(localAppData, "agy", "bin", "agy"), prefixArgs: [] },
        );
        assert.deepEqual(
            resolveClientCommand("antigravity", { PATH: "/nonexistent-dir-zzz" }, "linux"),
            { command: path.join(home, ".local", "bin", "agy"), prefixArgs: [] },
        );
        const mdDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcode-plat-"));
        fs.mkdirSync(path.join(mdDir, "bin"), { recursive: true });
        fs.writeFileSync(path.join(mdDir, "bin", "mcode.cmd"), "");
        assert.deepEqual(
            resolveClientCommand("mcode", { PATH: "/nonexistent-dir-zzz", MCODE_INSTALL_DIR: mdDir }, "win32"),
            { command: path.join(mdDir, "bin", "mcode.cmd"), prefixArgs: [] },
        );
        assert.deepEqual(
            resolveClientCommand("mcode", { PATH: "/nonexistent-dir-zzz", MCODE_INSTALL_DIR: mdDir }, "linux"),
            { command: path.join(mdDir, "bin", "mcode"), prefixArgs: [] },
        );
        rmrf(mdDir);
    } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        rmrf(home);
        rmrf(localAppData);
    }
});

test("runLaunch mcode: cert-MITM envs (combined CA on SSL_CERT_FILE + NODE_EXTRA_CA_CERTS), discovered host whitelist, model windows (#1050)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mcode-launch-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevNoProxy = process.env.NO_PROXY;
    fs.mkdirSync(path.join(home, ".minimax"));
    fs.writeFileSync(
        path.join(home, ".minimax", "config.yaml"),
        ["minimax_api:", "  apiKey: sk-mm", "  baseURL: https://agent.minimax.io/mavis/api/v1/llm/v1", "", "custom_provider:", "  relay:", "    name: Relay", "    options:", "      apiKey: sk-relay", "      baseURL: https://relay.example.com/anthropic", "    models:", "      MiniMax-M3:", "        limit:", "          context: 200000", "          output: 16384"].join("\n"),
    );
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    const fakeMcode = path.join(home, process.platform === "win32" ? "fake-mcode.exe" : "fake-mcode");
    fs.writeFileSync(fakeMcode, "");
    process.env.BILI_CLIENT_BIN = fakeMcode;
    process.env.NO_PROXY = "localhost,.corp";

    const clientEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const proxyEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        const env = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        if (cmd === fakeMcode) {
            clientEnvs.push(env);
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        proxyEnvs.push(env);
        return makeFakeChild(42425);
    };
    const fetchImpl = async () => ({ ok: true });
    const prevExit = process.exit;
    process.exit = (() => undefined) as typeof process.exit;
    try {
        await runLaunch({ client: "mcode", clientArgs: [], overrides: {} }, { fetchImpl, fetchHealthInfo: async () => ({ ok: true, pid: lastFakeChildPid }), spawnImpl, sleep: () => Promise.resolve() });
        assert.equal(clientEnvs.length, 1);
        const seenEnv = clientEnvs[0]!;
        const origin = seenEnv.HTTPS_PROXY;
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
        assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(seenEnv.SSL_CERT_FILE));
        assert.equal(seenEnv.NODE_EXTRA_CA_CERTS, seenEnv.SSL_CERT_FILE, "combined bundle on both CA vars");
        assert.equal(seenEnv.HTTP_PROXY, undefined, "no plain-http routes → no HTTP_PROXY");
        assert.equal(seenEnv.NO_PROXY, undefined, "inherited NO_PROXY stripped");
        assert.equal(seenEnv.BILLION_CONTEXT_PROXY, undefined, "mcode has no agent-side plugin consumer");
        assert.ok(proxyEnvs.length > 0, "proxy child spawned");
        const mitm = String(proxyEnvs[0]!.BILI_MITM_DOMAINS).split(",");
        assert.ok(mitm.includes("agent.minimax.io"), `whitelist has agent.minimax.io: ${mitm.join(",")}`);
        assert.ok(mitm.includes("relay.example.com"), `whitelist has relay.example.com: ${mitm.join(",")}`);
        const windows = String(proxyEnvs[0]!.BILI_LAUNCHER_MODEL_WINDOWS ?? "");
        assert.ok(windows.includes("MiniMax-M3"), `windows: ${windows}`);
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
        rmrf(home);
    }
});

test("readOpencodeProjectLayer: git-bounded walk, nearest wins, .opencode dir, jsonc", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "oc-proj-"));
    try {
        const repo = path.join(base, "repo");
        const deep = path.join(repo, "a", "b");
        fs.mkdirSync(deep, { recursive: true });
        fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
        fs.writeFileSync(
            path.join(base, "opencode.json"),
            JSON.stringify({ provider: { outer: { options: { baseURL: "http://127.0.0.1:1/outer" } } } }),
        );
        fs.writeFileSync(
            path.join(repo, "opencode.json"),
            JSON.stringify({
                provider: {
                    shared: { options: { baseURL: "http://127.0.0.1:2/root" } },
                    onlyRoot: { options: { baseURL: "http://127.0.0.1:3/root" } },
                },
            }),
        );
        fs.mkdirSync(path.join(repo, ".opencode"), { recursive: true });
        fs.writeFileSync(
            path.join(repo, ".opencode", "opencode.json"),
            JSON.stringify({ provider: { dotdir: { options: { baseURL: "http://127.0.0.1:4/dot" } } } }),
        );
        fs.writeFileSync(
            path.join(deep, "opencode.jsonc"),
            '// line comment\n/* block */\n{"provider":{"shared":{"options":{"baseURL":"http://127.0.0.1:5/deep"}}},}',
        );
        const layer = readOpencodeProjectLayer(deep);
        assert.equal(layer.providers["outer"], undefined, "walk stops at the git root");
        assert.deepEqual(layer.providers["shared"], { baseURL: "http://127.0.0.1:5/deep", file: path.join(deep, "opencode.jsonc") });
        assert.deepEqual(layer.providers["onlyRoot"], { baseURL: "http://127.0.0.1:3/root", file: path.join(repo, "opencode.json") });
        assert.deepEqual(layer.providers["dotdir"], { baseURL: "http://127.0.0.1:4/dot", file: path.join(repo, ".opencode", "opencode.json") });
        const sibling = path.join(repo, "empty");
        fs.mkdirSync(sibling);
        const layer2 = readOpencodeProjectLayer(sibling);
        assert.deepEqual(Object.keys(layer2.providers).sort(), ["dotdir", "onlyRoot", "shared"]);
    } finally {
        rmrf(base);
    }
});

test("readOpencodeProjectLayer: outside a repo walks all ancestor levels", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "oc-nogit-"));
    try {
        const top = path.join(base, "top");
        const mid = path.join(top, "mid");
        const leaf = path.join(mid, "leaf");
        fs.mkdirSync(leaf, { recursive: true });
        fs.writeFileSync(
            path.join(top, "opencode.json"),
            JSON.stringify({ provider: { topP: { options: { baseURL: "http://127.0.0.1:6/top" } } } }),
        );
        fs.writeFileSync(
            path.join(mid, "opencode.json"),
            JSON.stringify({ provider: { midP: { options: { baseURL: "http://127.0.0.1:7/mid" } } } }),
        );
        const layer = readOpencodeProjectLayer(leaf);
        assert.deepEqual(layer.providers["topP"], { baseURL: "http://127.0.0.1:6/top", file: path.join(top, "opencode.json") });
        assert.deepEqual(layer.providers["midP"], { baseURL: "http://127.0.0.1:7/mid", file: path.join(mid, "opencode.json") });
    } finally {
        rmrf(base);
    }
});

test("opencodeEffectiveCwd: honors --dir, defaults to process.cwd()", () => {
    assert.equal(opencodeEffectiveCwd([]), process.cwd());
    assert.equal(opencodeEffectiveCwd(["run"]), process.cwd());
    const abs = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dir-"));
    try {
        assert.equal(opencodeEffectiveCwd(["--dir", abs]), abs);
        assert.equal(opencodeEffectiveCwd(["--dir=" + abs]), abs);
    } finally {
        rmrf(abs);
    }
    assert.equal(opencodeEffectiveCwd(["--dir", "rel/z"]), path.resolve("rel/z"));
});

test("opencodeProjectBypassWarnings: override + project-only warn, routed values silent", () => {
    const routes: DiscoveredRoutes = {
        httpsDomains: ["open.bigmodel.cn"],
        httpRewrites: [{ key: "local-lb", realUpstream: "http://127.0.0.1:8199/v1" }],
        httpsRewrites: [{ key: "bigmodel", realUpstream: "https://open.bigmodel.cn/api/v4" }],
        httpEnvRoutes: [],
    };
    const F = "/proj/opencode.json";
    let w = opencodeProjectBypassWarnings({ providers: { "local-lb": { baseURL: "http://127.0.0.1:9999/a", file: F } } }, routes);
    assert.equal(w.length, 1);
    assert.match(w[0], /redefines provider "local-lb"/);
    assert.match(w[0], /will NOT go through the proxy/);
    assert.match(w[0], new RegExp(F.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    w = opencodeProjectBypassWarnings({ providers: { ghost: { baseURL: "http://127.0.0.1:7777/p", file: F } } }, routes);
    assert.equal(w.length, 1);
    assert.match(w[0], /defined only in opencode's project layer/);
    w = opencodeProjectBypassWarnings({ providers: { "local-lb": { baseURL: "http://127.0.0.1:8787/bili/http://127.0.0.1:8199/v1", file: F } } }, routes);
    assert.deepEqual(w, [], "already /bili/-wrapped → routed");
    w = opencodeProjectBypassWarnings({ providers: { bigmodel: { baseURL: "https://open.bigmodel.cn/api/v4", file: F } } }, routes);
    assert.deepEqual(w, [], "https host already MITM-routed");
    w = opencodeProjectBypassWarnings({ providers: { "local-lb": { file: F } } }, routes);
    assert.deepEqual(w, [], "no explicit baseURL → inherits delivered value via deep merge");
    w = opencodeProjectBypassWarnings({ providers: { "local-lb": { baseURL: "http://127.0.0.1:9/a", file: F }, ghost: { baseURL: "http://127.0.0.1:7/b", file: F } } }, routes);
    assert.equal(w.length, 2);
    assert.deepEqual(opencodeProjectBypassWarnings({ providers: {} }, routes), []);
});

test("runLaunch copilot: cert-MITM env (HTTPS_PROXY + combined SSL_CERT_FILE), inherited proxy stripped (#1049)", async () => {
    const seenEnv = await captureLaunchedClientEnv("copilot");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(seenEnv.SSL_CERT_FILE));
    assert.equal(seenEnv.NODE_EXTRA_CA_CERTS, undefined);
    assertInheritedProxyStripped(seenEnv, String(origin));
});

test("runLaunch amp: cert-MITM env (HTTPS_PROXY + combined SSL_CERT_FILE), inherited proxy stripped (#1049)", async () => {
    const seenEnv = await captureLaunchedClientEnv("amp");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(seenEnv.SSL_CERT_FILE));
    assert.equal(seenEnv.NODE_EXTRA_CA_CERTS, undefined);
    assertInheritedProxyStripped(seenEnv, String(origin));
});

test("runLaunch crush: cert-MITM env (HTTPS_PROXY + combined SSL_CERT_FILE), inherited proxy stripped (#2340)", async () => {
    const seenEnv = await captureLaunchedClientEnv("crush");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(seenEnv.SSL_CERT_FILE));
    assert.equal(seenEnv.NODE_EXTRA_CA_CERTS, undefined);
    assertInheritedProxyStripped(seenEnv, String(origin));
});

test("runLaunch zed: cert-MITM env + NO_PROXY loopback bypass, inherited proxy stripped (#2340)", async () => {
    const seenEnv = await captureLaunchedClientEnv("zed");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.ok(String(seenEnv.SSL_CERT_FILE).endsWith(path.join("billion-context", "ca", "combined-ca.pem")), String(seenEnv.SSL_CERT_FILE));
    assert.equal(seenEnv.NODE_EXTRA_CA_CERTS, undefined);
    // loopback providers (ollama/lmstudio) stay direct
    assert.equal(seenEnv.NO_PROXY, "localhost,127.0.0.1,::1");
    assert.equal(seenEnv.no_proxy, "localhost,127.0.0.1,::1");
    // inherited generic proxy vars are stripped (NO_PROXY/no_proxy excepted —
    // they are re-set by the launcher's own loopback bypass)
    for (const k of INHERITED_PROXY_TEST_VARS) {
        if (k === "HTTPS_PROXY" || k === "NO_PROXY" || k === "no_proxy") continue;
        assert.equal(seenEnv[k], undefined, `inherited ${k} stripped`);
    }
    assert.equal(seenEnv.BILI_TEST_MARKER, "keep");
});

test("runLaunch goose: *_HOST redirects to the proxy, no proxy envs at all (#1049)", async () => {
    const seenEnv = await captureLaunchedClientEnv("goose");
    const origin = seenEnv.BILLION_CONTEXT_PROXY;
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(String(origin)), `origin: ${origin}`);
    assert.equal(seenEnv.OPENAI_HOST, wrapUpstream(String(origin), "https://api.openai.com"));
    assert.equal(seenEnv.ANTHROPIC_HOST, wrapUpstream(String(origin), "https://api.anthropic.com"));
    for (const k of INHERITED_PROXY_TEST_VARS) {
        assert.equal(seenEnv[k], undefined, `${k} must stay unset — rustls distrusts bili's CA`);
    }
    assert.equal(seenEnv.GOOSE_PATH_ROOT, undefined, "no custom providers → no overlay");
    assert.equal(seenEnv.BILI_TEST_MARKER, "keep");
});

test("runLaunch goose: custom provider rides the regenerated GOOSE_PATH_ROOT overlay, edits merge back (#1049)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-goose-launch-"));
    const fakeBin = path.join(home, process.platform === "win32" ? "fake-goose.exe" : "fake-goose");
    fs.writeFileSync(fakeBin, "");
    const cfgDir = path.join(home, ".config", "goose");
    fs.mkdirSync(path.join(cfgDir, "custom_providers"), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, "config.toml"), 'active_provider = "mine"\n');
    fs.writeFileSync(path.join(cfgDir, "custom_providers", "mine.toml"), 'name = "Mine"\nbase_url = "https://api.custom.example/v1"\n');
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevBin = process.env.BILI_CLIENT_BIN;
    const prevExit = process.exit;
    const savedProxyVars: Record<string, string | undefined> = {};
    for (const k of INHERITED_PROXY_TEST_VARS) savedProxyVars[k] = process.env[k];
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const prevXdgData = process.env.XDG_DATA_HOME;
    const prevXdgState = process.env.XDG_STATE_HOME;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    process.env.BILI_CLIENT_BIN = fakeBin;
    for (const k of INHERITED_PROXY_TEST_VARS) delete process.env[k];
    process.exit = (() => undefined) as typeof process.exit;
    const clientEnvs: (NodeJS.ProcessEnv | undefined)[] = [];
    const spawnImpl: SpawnFn = (cmd, args, opts) => {
        const env = (opts as { env?: NodeJS.ProcessEnv } | undefined)?.env;
        if (cmd === fakeBin) {
            clientEnvs.push(env);
            fs.writeFileSync(path.join(String(env!.GOOSE_PATH_ROOT), "config", "config.toml"), 'active_provider = "mine"\nsome_new_key = 1\n');
            const child = makeFakeChild(0);
            const orig = child.on!.bind(child);
            (child as { on: SpawnChild["on"] }).on = (event, listener) => {
                orig(event, listener);
                if (event === "exit") setTimeout(() => listener(0, null), 0);
                return child;
            };
            return child;
        }
        return makeFakeChild(42424);
    };
    try {
        await runLaunch(
            { client: "goose", clientArgs: [], overrides: {} },
            { fetchImpl: async () => ({ ok: true }), fetchHealthInfo: async () => ({ ok: true, pid: 42424 }), spawnImpl, sleep: () => Promise.resolve() },
        );
        assert.equal(clientEnvs.length, 1, "goose client spawned exactly once");
        const seenEnv = clientEnvs[0]!;
        const origin = String(seenEnv.BILLION_CONTEXT_PROXY);
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin), `origin: ${origin}`);
        assert.equal(seenEnv.OPENAI_HOST, wrapUpstream(origin, "https://api.openai.com"));
        assert.equal(seenEnv.GOOSE_PATH_ROOT, path.join(home, ".config", "goose-bili"));
        for (const k of INHERITED_PROXY_TEST_VARS) {
            assert.equal(seenEnv[k], undefined, `${k} must stay unset`);
        }
        const patched = fs.readFileSync(path.join(home, ".config", "goose-bili", "config", "custom_providers", "mine.toml"), "utf8");
        assert.ok(patched.includes(`base_url = "${wrapUpstream(origin, "https://api.custom.example/v1")}"`), patched);
        const realAfter = fs.readFileSync(path.join(cfgDir, "config.toml"), "utf8");
        assert.ok(realAfter.includes("some_new_key = 1"), "user edit merged back into the real config via runLaunch cleanup");
        assert.ok(fs.readFileSync(path.join(cfgDir, "custom_providers", "mine.toml"), "utf8").includes('base_url = "https://api.custom.example/v1"'), "patched url did not leak into the real config");
    } finally {
        process.exit = prevExit;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevBin === undefined) delete process.env.BILI_CLIENT_BIN;
        else process.env.BILI_CLIENT_BIN = prevBin;
        if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdgConfig;
        if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdgData;
        if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdgState;
        for (const [k, v] of Object.entries(savedProxyVars)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        rmrf(home);
    }
});

// #1623: attach decisions must leave a trace. Every silent drop/skip branch
// in probeLiveInstances/pickAttachable now emits a reason via attachDiag so
// "why did we spawn instead of attaching?" is diagnosable from bili.log.

test("findLiveAttachableInstance probes only — no spawn, no wait (#1623)", async () => {
    let spawned = false;
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
        {
            spawnImpl: () => { spawned = true; return makeFakeChild(42433); },
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
            readInstanceFile: () => recordedInstance(),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(spawned, false);
    assert.equal(inst?.origin, "http://127.0.0.1:8787");
});

test("attach diagnostics record an owner-process-gone drop (#1623)", async () => {
    const diag: string[] = [];
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
        {
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
            readInstanceFile: () => recordedInstance({ pid: 99999999 }),
            attachDiag: (m) => diag.push(m),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(inst, undefined);
    assert.ok(diag.some((m) => m.includes("owner process gone")), `diag was: ${JSON.stringify(diag)}`);
});

test("attach diagnostics record a fingerprint-mismatch skip (#1623)", async () => {
    const diag: string[] = [];
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
        {
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
            readInstanceFile: () => recordedInstance({ codeFingerprint: "deadbeef" }),
            attachDiag: (m) => diag.push(m),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(inst, undefined);
    assert.ok(diag.some((m) => m.includes("code-fingerprint-mismatch")), `diag was: ${JSON.stringify(diag)}`);
});

test("attach diagnostics record a lifecycle-gate refusal (#1623)", async () => {
    const diag: string[] = [];
    // #1660: an unarmed instance WITHOUT a lane is a user-zone manual start
    // and attaches by default — the refusal path needs a lane'd one.
    const inst = await findLiveAttachableInstance(
        { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
        {
            fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1" }),
            readInstanceFile: () => recordedInstance({ lane: "zcode" }),
            attachDiag: (m) => diag.push(m),
            scriptPath: FP_SCRIPT,
        },
    );
    assert.equal(inst, undefined);
    assert.ok(diag.some((m) => m.includes("refusing to attach")), `diag was: ${JSON.stringify(diag)}`);
});

// #3200: normal candidate filtering is NOT user-actionable — it must land in
// the durable log file only, never on the interactive terminal. Host
// processes (pi/omp/… native lanes) never call configureLogger, so the old
// teeLog default was terminal-only with NO file record at all. Explicit
// debug adds exactly one controlled stderr copy for CLI contexts.
test("default attach diagnostics go to the log file, never the terminal (#3200)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3200-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const prevXdgData = process.env.XDG_DATA_HOME;
    const prevXdgState = process.env.XDG_STATE_HOME;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    const stderrWrites: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
        stderrWrites.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;
    try {
        const inst = await findLiveAttachableInstance(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
            {
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
                readInstanceFile: () => recordedInstance({ codeFingerprint: "deadbeef" }),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(inst, undefined, "incompatible candidate stays skipped");
        assert.equal(stderrWrites.length, 0, `terminal got bytes: ${JSON.stringify(stderrWrites)}`);
        const logFile = path.join(process.env.XDG_STATE_HOME!, "billion-context", "bili.log");
        const content = fs.readFileSync(logFile, "utf8");
        assert.ok(content.includes("native-attach: skip"), `log was: ${content}`);
        assert.ok(content.includes("code-fingerprint-mismatch"), `log was: ${content}`);

        // explicit debug: one controlled stderr copy, same head format as the
        // legacy teeLog line, file record still written
        const dbg = await findLiveAttachableInstance(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: true },
            {
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", watchdog: { armed: true } }),
                readInstanceFile: () => recordedInstance({ codeFingerprint: "deadbeef" }),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(dbg, undefined);
        assert.equal(stderrWrites.length, 1, `debug stderr was: ${JSON.stringify(stderrWrites)}`);
        assert.ok(stderrWrites[0]!.includes("code-fingerprint-mismatch"), stderrWrites[0]);
        assert.ok(/^\d{4}-\d{2}-\d{2}T[\d:.]+ \[info\] \[v=\d+\.\d+\.\d+\] native-attach: skip /.test(stderrWrites[0]!), `head format: ${stderrWrites[0]}`);
        const content2 = fs.readFileSync(logFile, "utf8");
        assert.equal(content2.split("code-fingerprint-mismatch").length - 1, 2, "one file line per run");
    } finally {
        process.stderr.write = origStderrWrite;
        process.env.HOME = prevHome;
        if (prevUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdgConfig;
        if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdgData;
        if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdgState;
        rmrf(home);
    }
});

test("ensureProxyRunning non-debug: incompatible candidate skipped silently, reason in file, spawn proceeds (#3200)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3200-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const prevXdgData = process.env.XDG_DATA_HOME;
    const prevXdgState = process.env.XDG_STATE_HOME;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    const stderrWrites: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
        stderrWrites.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;
    // alive during pre-spawn discovery (a live incompatible candidate — the
    // reported field case), dead once the spawn-wait loop re-reads it (so the
    // #1753 pid-match fallback can settle on our own child)
    let instPid = process.pid;
    let spawned = 0;
    try {
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: false, lane: "pi" },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: 42434, watchdog: { armed: true } }),
                readInstanceFile: () => recordedInstance({ lane: "opencode", codeFingerprint: "deadbeef", pid: instPid }),
                spawnImpl: () => {
                    spawned++;
                    instPid = 99999999;
                    return makeFakeChild(42434);
                },
                sleep: () => Promise.resolve(),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(spawned, 1, "no attach target → fresh proxy spawned");
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(handle.origin), `origin: ${handle.origin}`);
        assert.equal(stderrWrites.length, 0, `terminal got bytes: ${JSON.stringify(stderrWrites)}`);
        const content = fs.readFileSync(path.join(process.env.XDG_STATE_HOME!, "billion-context", "bili.log"), "utf8");
        assert.ok(content.includes("native-attach: skip"), `log was: ${content}`);
        assert.ok(content.includes("code-fingerprint-mismatch"), `log was: ${content}`);
    } finally {
        process.stderr.write = origStderrWrite;
        process.env.HOME = prevHome;
        if (prevUserProfile !== undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdgConfig;
        if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdgData;
        if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdgState;
        rmrf(home);
    }
});

// #3404: the two remaining startup banners (`attaching to running proxy`,
// `another bili launch ...`) still went out through raw console.error — in a
// native host process that lands on the physical screen bypassing the TUI
// renderer (Pi's input draft after herdr restore, same mechanism as
// #2827/#2831). They now ride the #3200 host-safe channel: durable log file by
// default, one controlled stderr copy under explicit debug. The failure-path
// console.error lines in the same function stay visible — these tests pin the
// boundary. Shared harness: isolated HOME/XDG tree (logHostEvent target) plus
// stderr capture proving nothing reaches the terminal.
function isolatedHomeWithStderrCapture(
    fn: (home: string, stderrWrites: string[]) => Promise<void>,
): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3404-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const prevXdgData = process.env.XDG_DATA_HOME;
    const prevXdgState = process.env.XDG_STATE_HOME;
    const stderrWrites: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    process.stderr.write = ((chunk: unknown) => {
        stderrWrites.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;
    return Promise.resolve()
        .then(() => fn(home, stderrWrites))
        .finally(() => {
            process.stderr.write = origStderrWrite;
            process.env.HOME = prevHome;
            if (prevUserProfile === undefined) delete process.env.USERPROFILE;
            else process.env.USERPROFILE = prevUserProfile;
            if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = prevXdgConfig;
            if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = prevXdgData;
            if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
            else process.env.XDG_STATE_HOME = prevXdgState;
            rmrf(home);
        });
}

function stateLog(home: string): string {
    return fs.readFileSync(path.join(home, ".local", "state", "billion-context", "bili.log"), "utf8");
}

test("attach banner stays off the terminal by default; file keeps origin/pid, watcher unchanged (#3404)", async () => {
    await isolatedHomeWithStderrCapture(async (home, stderrWrites) => {
        const registrations: Array<[string, number]> = [];
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: process.pid, watchdog: { armed: true } }),
                readInstanceFile: () => recordedInstance(),
                registerWatcher: async (origin, pid) => { registrations.push([origin, pid]); return "ok"; },
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(handle.attached, true, "still attaches to the healthy instance");
        assert.equal(handle.origin, "http://127.0.0.1:8787");
        assert.deepEqual(registrations, [["http://127.0.0.1:8787", process.pid]], "watcher registration unchanged");
        assert.equal(stderrWrites.length, 0, `terminal got bytes: ${JSON.stringify(stderrWrites)}`);
        const content = stateLog(home);
        assert.ok(content.includes(`bili: attaching to running proxy at http://127.0.0.1:8787 (pid ${process.pid})`), `log was: ${content}`);
    });
});

test("concurrent-startup wait banner goes to the file only; wait-then-attach behavior unchanged (#3404)", async () => {
    await isolatedHomeWithStderrCapture(async (home, stderrWrites) => {
        // Active starter marker (our own pid, fresh timestamp, undeclared lane =
        // wildcard) forces the cross-process startup window instead of a direct
        // attach; the instance appears only on the FIRST starter poll tick.
        const markerDir = path.join(home, ".local", "state", "billion-context");
        fs.mkdirSync(markerDir, { recursive: true });
        fs.writeFileSync(
            path.join(markerDir, "proxy-starting"),
            `${JSON.stringify({ token: "starter-3404", pid: process.pid, host: "127.0.0.1", port: 0, startedAt: Date.now() })}\n`,
        );
        let reads = 0;
        const registrations: Array<[string, number]> = [];
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: process.pid, watchdog: { armed: true } }),
                readInstanceFile: () => (++reads > 1 ? recordedInstance() : undefined),
                registerWatcher: async (origin, pid) => { registrations.push([origin, pid]); return "ok"; },
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(handle.attached, true, "waited for the starter, then attached — did not spawn a second writer");
        assert.equal(reads, 2, "initial snapshot saw nothing; the first starter poll found the instance");
        assert.deepEqual(registrations, [["http://127.0.0.1:8787", process.pid]]);
        assert.equal(stderrWrites.length, 0, `terminal got bytes: ${JSON.stringify(stderrWrites)}`);
        const content = stateLog(home);
        assert.ok(content.includes("another bili launch is bringing up a proxy"), `log was: ${content}`);
        assert.ok(content.includes("bili: attaching to running proxy at http://127.0.0.1:8787"), `log was: ${content}`);
    });
});

test("explicit debug keeps one controlled stderr copy of the attach banner (#3404)", async () => {
    await isolatedHomeWithStderrCapture(async (_home, stderrWrites) => {
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: true },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1", pid: process.pid, watchdog: { armed: true } }),
                readInstanceFile: () => recordedInstance(),
                registerWatcher: async () => "ok",
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(handle.attached, true);
        assert.equal(stderrWrites.length, 1, `debug stderr was: ${JSON.stringify(stderrWrites)}`);
        assert.ok(stderrWrites[0]!.includes("bili: attaching to running proxy at http://127.0.0.1:8787"), stderrWrites[0]);
        assert.ok(/^\d{4}-\d{2}-\d{2}T[\d:.]+ \[info\] \[v=\d+\.\d+\.\d+\] /.test(stderrWrites[0]!), `head format: ${stderrWrites[0]}`);
    });
});

test("user-actionable gate refusal stays on the terminal — not hidden with the banners (#3404)", async () => {
    await isolatedHomeWithStderrCapture(async (home, stderrWrites) => {
        const inst = await findLiveAttachableInstance(
            { host: "127.0.0.1", port: 0, passthrough: false, debug: false },
            {
                fetchHealthInfo: async () => ({ ok: true, instanceId: "inst-1" }),
                readInstanceFile: () => recordedInstance({ lane: "opencode" }),
                scriptPath: FP_SCRIPT,
            },
        );
        assert.equal(inst, undefined, "unverifiable-watchdog lane instance is still refused");
        assert.ok(stderrWrites.some((m) => m.includes("refusing to attach")), `stderr was: ${JSON.stringify(stderrWrites)}`);
        assert.ok(stateLog(home).includes("refusing to attach"), "file record kept as well");
    });
});

test("recovery-path attach announcement goes through the host-safe channel; child-death notice stays visible (#3404)", async () => {
    await isolatedHomeWithStderrCapture(async (home, stderrWrites) => {
        // Same shape as the #1903 late-publisher scenario, but on the DEFAULT
        // diag sink: the spawned child dies before healthy (failure notice must
        // stay on the terminal), re-discovery then attaches a late publisher —
        // that SUCCESS announcement is what moved off the terminal.
        const PORT = 38993;
        const late = recordedInstance({ origin: `http://127.0.0.1:${PORT}`, port: PORT });
        let reads = 0;
        let t = 0;
        const handle = await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false, strictPort: true, lane: "claude" },
            {
                spawnImpl: () => makeFastExitChild(1),
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async (origin) => origin === late.origin ? { ok: true, instanceId: late.instanceId, pid: late.pid } : undefined,
                readInstanceFile: () => (++reads > 1 ? late : undefined),
                now: () => t,
                sleep: async (ms) => { t += ms; },
                registerWatcher: async () => "ok",
                scriptPath: FP_SCRIPT,
                // #2877: lane-less (manual) daemon ridden by a LANEd launch — pin
                // the legacy policy so this keeps exercising the post-exit
                // re-discovery mechanism, like the #1903 test it mirrors.
                resolveAttachPolicy: () => "global-fallback",
            },
        );
        assert.equal(handle.attached, true, "attached to the late publisher via the recovery path");
        assert.equal(handle.origin, late.origin);
        assert.equal(reads, 2, "initial snapshot missed it; the FIRST re-discovery tick caught it");
        assert.equal(stderrWrites.length, 1, `stderr was: ${JSON.stringify(stderrWrites)}`);
        assert.ok(stderrWrites[0]!.includes("spawned proxy exited before becoming healthy"), stderrWrites[0]);
        assert.ok(!stderrWrites.some((m) => m.includes("attached to")), "success announcement must not reach the terminal");
        const content = stateLog(home);
        assert.ok(content.includes(`bili: attached to ${late.origin} (pid ${late.pid})`), `log was: ${content}`);
    });
});

// #1753: the spawn-wait fallback must verify the healthy responder on the
// preferred port is the child WE spawned. A foreign proxy squats the preferred
// port (that is exactly why our child laddered away); trusting "healthy" alone
// exports the client to an instance the attach gate (#1225) would have rejected.
test("ensureProxyRunning: a healthy squatter on the preferred port is not mistaken for the spawned child (#1753)", async () => {
    const child = makeFakeChild(42451);
    const spawned: string[] = [];
    let childToken = "";
    const spawnImpl: SpawnFn = (_cmd, args, options) => {
        spawned.push(...args);
        childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
        return child;
    };
    let recorded = false;
    const settled: Array<[string | undefined, number]> = [];
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 18787, passthrough: false, debug: false },
        {
            // The preferred port answers health — but with a FOREIGN pid.
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async (origin) => ({
                ok: true,
                pid: origin.endsWith(":18787") ? 875250 : 42451,
            }),
            spawnImpl,
            sleep: () => {
                return Promise.resolve();
            },
            // After the first squatter probe, the child's laddered record appears.
            readInstanceFile: () =>
                recorded
                    ? recordedInstance({ origin: "http://127.0.0.1:18790", port: 18790, pid: 42451, launchToken: childToken })
                    : undefined,
            now: (() => {
                let ticks = 0;
                return () => {
                    if (++ticks === 2) recorded = true;
                    return ticks * 100;
                };
            })(),
            writeZonePort: (lane, port) => {
                settled.push([lane, port]);
            },
        },
    );
    assert.equal(handle.origin, "http://127.0.0.1:18790", "client is exported to the child's real (laddered) origin");
    assert.equal(handle.port, 18790);
    // Fixed-port launches never settle sticky themselves (#1660 settles lane'd
    // ephemerals; the child side drifts the zone record on its own boot).
    assert.deepEqual(settled, [], "the squatter's port is never settled sticky");
});

test("ensureProxyRunning: the fallback still accepts the preferred port when the responder IS the spawned child (#1753)", async () => {
    // Legacy/broken-state-dir child that never writes an instance record but
    // does answer health — and the health pid matches the spawned child.
    const spawnImpl: SpawnFn = () => makeFakeChild(42452);
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
        {
            fetchImpl: async () => ({ ok: true }),
            fetchHealthInfo: async () => ({ ok: true, pid: 42452 }),
            spawnImpl,
            sleep: () => Promise.resolve(),
            readInstanceFile: () => undefined,
        },
    );
    assert.equal(handle.origin, `http://127.0.0.1:8787`);
    assert.equal(handle.port, 8787);
});

test("ensureProxyRunning: a squatter without a matching child record ends in a loud failure, not a silent misroute (#1753)", async () => {
    const spawnImpl: SpawnFn = () => makeFakeChild(42453);
    let ticks = 0;
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port: 8787, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 875250 }),
                spawnImpl,
                now: () => ticks * 1000,
                sleep: () => {
                    ticks += 10;
                    return Promise.resolve();
                },
                readInstanceFile: () => undefined,
            },
        ),
        /did not become healthy/,
    );
});

// #3575: the #1753 squatter wait is a SELF-RECOVERING progress diagnostic —
// the launch still succeeds once the child's laddered record publishes — so
// it must ride the host-safe channel (durable log file; stderr only under
// explicit debug) instead of a raw console.error that lands on the TUI screen
// itself in native lanes. Scenario builder: foreign pid 875250 squats the
// preferred port 18787; our child (pid 42451) ladders to 18790 and its
// launchToken record becomes visible on the SECOND spawn-wait read — the
// first read sees nothing, so the #1753 squatter branch provably fires before
// the handshake settles (gating on read count taken AT SPAWN, immune to
// however many times pre-spawn discovery reads the file).
const SQUATTER_MSG = "bili: port 18787 answers health (pid 875250) but is not the proxy this launcher spawned (child pid 42451) — waiting for the spawned instance to report its real origin; if that never happens, kill pid 875250 or set native.attachExternal=true / BILI_NATIVE_ATTACH_EXTERNAL=1 to attach to the holder instead";
function makeSquatterScenario(debug: boolean, attachDiag?: (msg: string) => void) {
    let childToken = "";
    let preSpawnReads = -1;
    let reads = 0;
    const deps = {
        fetchImpl: async () => ({ ok: true }),
        fetchHealthInfo: async (origin: string) => ({
            ok: true,
            pid: origin.endsWith(":18787") ? 875250 : 42451,
        }),
        spawnImpl: (_cmd: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
            preSpawnReads = reads;
            childToken = options.env?.BILI_LAUNCH_TOKEN ?? "";
            return makeFakeChild(42451);
        },
        sleep: () => Promise.resolve(),
        listRegistryInstances: () => [],
        scriptPath: FP_SCRIPT,
        attachDiag,
        readInstanceFile: () => {
            reads += 1;
            return reads >= preSpawnReads + 2 && childToken !== ""
                ? recordedInstance({ origin: "http://127.0.0.1:18790", port: 18790, pid: 42451, launchToken: childToken })
                : undefined;
        },
    };
    return {
        deps,
        opts: { host: "127.0.0.1", port: 18787, passthrough: false, debug },
    };
}
function withHomeSandbox(run: () => Promise<void>): Promise<void> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3575-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    const prevXdgConfig = process.env.XDG_CONFIG_HOME;
    const prevXdgData = process.env.XDG_DATA_HOME;
    const prevXdgState = process.env.XDG_STATE_HOME;
    process.env.HOME = home;
    if (prevUserProfile !== undefined) process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    return run().finally(() => {
        process.env.HOME = prevHome;
        if (prevUserProfile !== undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = prevUserProfile;
        if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdgConfig;
        if (prevXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdgData;
        if (prevXdgState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdgState;
        rmrf(home);
    });
}
function captureStderr(): { writes: string[]; restore: () => void } {
    const writes: string[] = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
    }) as typeof process.stderr.write;
    return { writes, restore: () => { process.stderr.write = origStderrWrite; } };
}
function stateLogPath(): string {
    return path.join(process.env.XDG_STATE_HOME!, "billion-context", "bili.log");
}

test("ensureProxyRunning non-debug: squatter wait diagnostic goes to the log file, terminal stays silent (#3575)", async () => {
    await withHomeSandbox(async () => {
        const { writes, restore } = captureStderr();
        try {
            const scenario = makeSquatterScenario(false);
            const handle = await ensureProxyRunning(scenario.opts, scenario.deps);
            assert.equal(handle.origin, "http://127.0.0.1:18790", "client still exported to the child's real (laddered) origin");
            assert.equal(writes.length, 0, `terminal got bytes: ${JSON.stringify(writes)}`);
            const content = fs.readFileSync(stateLogPath(), "utf8");
            const hits = content.split("but is not the proxy this launcher spawned").length - 1;
            assert.equal(hits, 1, `squatter diagnostic expected exactly once:\n${content}`);
            assert.ok(content.includes("(pid 875250)"), `foreign pid missing from log:\n${content}`);
            assert.ok(content.includes("(child pid 42451)"), `child pid missing from log:\n${content}`);
        } finally {
            restore();
        }
    });
});

test("ensureProxyRunning: injected attachDiag receives the squatter diagnostic verbatim, default sink bypassed (#3575)", async () => {
    await withHomeSandbox(async () => {
        const { writes, restore } = captureStderr();
        try {
            const diag: string[] = [];
            const scenario = makeSquatterScenario(false, (m) => diag.push(m));
            const handle = await ensureProxyRunning(scenario.opts, scenario.deps);
            assert.equal(handle.origin, "http://127.0.0.1:18790");
            assert.deepEqual(diag, [SQUATTER_MSG], `diag calls: ${JSON.stringify(diag)}`);
            assert.equal(writes.length, 0, `terminal got bytes: ${JSON.stringify(writes)}`);
            let content = "";
            try {
                content = fs.readFileSync(stateLogPath(), "utf8");
            } catch {}
            assert.ok(!content.includes("but is not the proxy this launcher spawned"), `default sink must stay untouched when a host injects its own channel:\n${content}`);
        } finally {
            restore();
        }
    });
});

test("ensureProxyRunning explicit debug: squatter diagnostic keeps one controlled stderr copy (#3575)", async () => {
    await withHomeSandbox(async () => {
        const { writes, restore } = captureStderr();
        try {
            const scenario = makeSquatterScenario(true);
            const handle = await ensureProxyRunning(scenario.opts, scenario.deps);
            assert.equal(handle.origin, "http://127.0.0.1:18790");
            const expected = new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+ \\[info\\] \\[v=[^\\]]+\\] ${SQUATTER_MSG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
            const hits = writes.filter((w) => w.includes("but is not the proxy this launcher spawned"));
            assert.equal(hits.length, 1, `expected exactly one terminal line, got: ${JSON.stringify(writes)}`);
            assert.ok(expected.test(hits[0].trimEnd()), `stderr line format drifted: ${JSON.stringify(hits[0])}`);
            assert.equal(writes.length, 1, `unexpected extra terminal output: ${JSON.stringify(writes)}`);
        } finally {
            restore();
        }
    });
});
