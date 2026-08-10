import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { WEB_CLIENT } from "../src/web/client.ts";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("embedded Web client is valid JavaScript", () => {
    assert.doesNotThrow(() => new Function(WEB_CLIENT));
});

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

test("Web UI exposes route, upstream and history controls without inline handlers", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-web-routing-${process.pid}-${Date.now()}`);
    const codexHome = path.join(root, "codex");
    const codexConfig = path.join(codexHome, "config.toml");
    const authPath = path.join(codexHome, "auth.json");
    const routeState = path.join(root, "data", "codex-route-state.json");
    const biliConfig = path.join(root, "billion-context.json");
    mkdirSync(codexHome, { recursive: true });
    const originalCodex = 'model = "gpt-5.4"\n[mcp_servers.keep]\ncommand = "keep"\n';
    const originalAuth = '{"tokens":{"access_token":"keep-secret"}}\n';
    writeFileSync(codexConfig, originalCodex, "utf8");
    writeFileSync(authPath, originalAuth, "utf8");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");

    const previous = {
        codexHome: process.env.CODEX_HOME,
        config: process.env.BILI_CONFIG_FILE,
        state: process.env.BILI_CODEX_ROUTE_STATE,
    };
    process.env.CODEX_HOME = codexHome;
    process.env.BILI_CONFIG_FILE = biliConfig;
    process.env.BILI_CODEX_ROUTE_STATE = routeState;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        updateMode: "auto",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const ui = await (await fetch(`${base}/__bili/`)).text();
        assert.match(ui, /Codex 路由/);
        assert.match(ui, /上游网络/);
        assert.match(ui, /修复旧版路由会话/);
        assert.match(ui, /addEventListener/);
        assert.doesNotMatch(ui, /\sonclick=/i);
        assert.match(ui, /escapeHtml/);

        const initial = await (await fetch(`${base}/__bili/codex`)).json() as { state: string; provider?: { id: string } };
        assert.equal(initial.state, "disabled");
        assert.equal(initial.provider?.id, "openai");
        const crossOrigin = await fetch(`${base}/__bili/codex/enable`, {
            method: "POST",
            headers: { origin: "https://attacker.example" },
        });
        assert.equal(crossOrigin.status, 403);
        assert.equal((await (await fetch(`${base}/__bili/codex`)).json() as { state: string }).state, "disabled");
        const enabledResponse = await fetch(`${base}/__bili/codex/enable`, { method: "POST" });
        assert.equal(enabledResponse.status, 200);
        const enabled = await enabledResponse.json() as { state: string; providerId: string; baseUrl: string };
        assert.equal(enabled.state, "enabled");
        assert.equal(enabled.providerId, "openai");
        assert.equal(enabled.baseUrl, `http://127.0.0.1:${port}/codex`);
        assert.equal(readFileSync(authPath, "utf8"), originalAuth);

        const saveProxy = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ upstreamProxyMode: "manual", upstreamProxy: "http://127.0.0.1:9999" }),
        });
        assert.equal(saveProxy.status, 200);
        const config = await (await fetch(`${base}/__bili/config`)).json() as { upstreamProxy: string; upstreamProxyMode: string };
        assert.equal(config.upstreamProxy, "http://127.0.0.1:9999");
        assert.equal(config.upstreamProxyMode, "manual");
        const upstream = await (await fetch(`${base}/__bili/upstream`)).json() as { proxy: string; source: string };
        assert.equal(upstream.proxy, "http://127.0.0.1:9999/");
        assert.equal(upstream.source, "web-manual");

        const history = await (await fetch(`${base}/__bili/codex-history`)).json() as { targetProviderId: string; sessions: number };
        assert.equal(history.targetProviderId, "openai");
        assert.equal(history.sessions, 0);

        const disabledResponse = await fetch(`${base}/__bili/codex/disable`, { method: "POST" });
        assert.equal(disabledResponse.status, 200);
        assert.equal(readFileSync(codexConfig, "utf8"), originalCodex);
        assert.equal(readFileSync(authPath, "utf8"), originalAuth);

        const enabledForShutdown = await fetch(`${base}/__bili/codex/enable`, { method: "POST" });
        assert.equal(enabledForShutdown.status, 200);
    } finally {
        await close(proxy);
        const restoredOnClose = readFileSync(codexConfig, "utf8");
        if (previous.codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous.codexHome;
        if (previous.config === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = previous.config;
        if (previous.state === undefined) delete process.env.BILI_CODEX_ROUTE_STATE; else process.env.BILI_CODEX_ROUTE_STATE = previous.state;
        rmSync(root, { recursive: true, force: true });
        assert.equal(restoredOnClose, originalCodex);
    }
});

test("PUT /__bili/config with providers takes effect without a separate reload call", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const root = path.join(tmpdir(), `bili-put-providers-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const biliConfig = path.join(root, "billion-context.json");
    writeFileSync(biliConfig, '{"providers":{}}\n', "utf8");
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = biliConfig;
    const port = await freePort();
    const opts: ProxyOptions = {
        port,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        updateMode: "auto",
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    if (!proxy.listening) await once(proxy, "listening");
    const base = `http://127.0.0.1:${port}`;
    try {
        const providers = { "https://api.example.com/v1": { models: { "gpt-test": { context: 123456 } } } };
        const put = await fetch(`${base}/__bili/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providers }),
        });
        assert.equal(put.status, 200);
        const after = await (await fetch(`${base}/__bili/config`)).json() as { providers: Record<string, unknown> };
        assert.deepEqual(after.providers, providers, "providers saved and visible after PUT without /reload");
    } finally {
        await close(proxy);
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevConfig;
        rmSync(root, { recursive: true, force: true });
    }
});
