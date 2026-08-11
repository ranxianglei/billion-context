import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
    LAUNCHER_DEFAULT_HOST,
    isLaunchClient,
    proxyOrigin,
    healthUrl,
    wrapUpstream,
    unwrapUpstream,
    buildPiEnv,
    buildCodexEnv,
    buildClaudeEnv,
    extractDomains,
    discoverDomains,
    resolveCaCertPath,
    resolveClientCommand,
    isOnPath,
    parseCodexToml,
    findFreePort,
    ensureProxyRunning,
    stopProxy,
    type SpawnChild,
    type SpawnFn,
    type ClientConfig,
} from "../src/launcher.ts";

test("isLaunchClient: pi/claude/codex true, others false", () => {
    assert.equal(isLaunchClient("pi"), true);
    assert.equal(isLaunchClient("claude"), true);
    assert.equal(isLaunchClient("codex"), true);
    assert.equal(isLaunchClient("opencode"), false);
    assert.equal(isLaunchClient("start"), false);
    assert.equal(isLaunchClient(""), false);
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
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.ANTHROPIC_API_KEY, "sk-x");
});

test("buildCodexEnv: sets HTTPS_PROXY + SSL_CERT_FILE, preserves baseEnv", () => {
    const env = buildCodexEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin", OPENAI_API_KEY: "sk-x" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.SSL_CERT_FILE, "/tmp/ca.pem");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.OPENAI_API_KEY, "sk-x");
    assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
});

test("buildClaudeEnv: sets HTTPS_PROXY + NODE_EXTRA_CA_CERTS, preserves baseEnv", () => {
    const env = buildClaudeEnv("http://127.0.0.1:8787", "/tmp/ca.pem", { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-x" });
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:8787");
    assert.equal(env.NODE_EXTRA_CA_CERTS, "/tmp/ca.pem");
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

test("discoverDomains: claude → api.anthropic.com", () => {
    assert.deepEqual(discoverDomains("claude", {}), ["api.anthropic.com"]);
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

test("ensureProxyRunning: reuses an already-healthy proxy without spawning", async () => {
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
    assert.equal(handle.reused, true);
    assert.equal(handle.child, null);
    assert.equal(handle.origin, "http://127.0.0.1:8787");
    assert.equal(spawnCalls, 0);
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
    assert.equal(handle.reused, false);
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

test("stopProxy: no-op when reused (child null)", () => {
    assert.doesNotThrow(() =>
        stopProxy({ origin: "http://127.0.0.1:8787", port: 8787, reused: true, child: null }),
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

test("resolveClientCommand: pi on PATH resolves to 'pi'", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-path-"));
    const piFile = path.join(tmp, "pi");
    fs.writeFileSync(piFile, "#!/bin/sh\necho pi\n", { mode: 0o755 });
    try {
        assert.deepEqual(resolveClientCommand("pi", { PATH: tmp }), {
            command: "pi",
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
    assert.ok(r.prefixArgs[0].endsWith("pi-coding-agent/dist/cli.js"));
});
