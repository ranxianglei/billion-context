import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { loadOptions, type ProxyOptions } from "../src/config.ts";
import { resolveUpstream, startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { fetchWithTimeout } from "../src/fetch-util.ts";
import {
    formatUpstreamError,
    matchesNoProxy,
    parseHttpProxy,
    proxyDispatcher,
    resetProxyCache,
    resolveProxy,
    resolveProxyDecision,
} from "../src/upstream-proxy.ts";

function listen(server: http.Server, port: number = 0): Promise<void> {
    server.listen(port, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function codexFixture(): { root: string; codexHome: string; configPath: string } {
    const root = path.join(tmpdir(), `bili-route-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexHome = path.join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    const configPath = path.join(codexHome, "config.toml");
    return { root, codexHome, configPath };
}

test("/codex resolves every future subpath against the active provider from config.toml", () => {
    const files = codexFixture();
    writeFileSync(files.configPath, [
        'model_provider = "relay"',
        "[model_providers.relay]",
        'name = "Relay"',
        'base_url = "https://relay.example/openai/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "supports_websockets = false",
    ].join("\n"), "utf8");
    const oldHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = files.codexHome;
    try {
        const opts = loadOptions({ ACP_PORT: "8787" });
        assert.deepEqual(resolveUpstream(opts, "/codex/responses?foo=a%2Fb"), {
            upstream: "https://relay.example/openai/v1",
            rewrittenUrl: "https://relay.example/openai/v1/responses?foo=a%2Fb",
        });
        assert.deepEqual(resolveUpstream(opts, "/codex/future/unknown?x=1"), {
            upstream: "https://relay.example/openai/v1",
            rewrittenUrl: "https://relay.example/openai/v1/future/unknown?x=1",
        });
        assert.equal(resolveUpstream(opts, "/codex-not-owned/responses"), undefined);
    } finally {
        if (oldHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = oldHome;
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("/codex integration preserves query, subscription, account and thread headers", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let captured: { url: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured = { url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"ok":true}');
        });
    });
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const files = codexFixture();
    writeFileSync(files.configPath, [
        'model_provider = "relay"',
        "[model_providers.relay]",
        'name = "Relay"',
        `base_url = "http://127.0.0.1:${upstreamPort}/backend-api/codex"`,
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "supports_websockets = false",
    ].join("\n"), "utf8");
    const oldHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = files.codexHome;
    const probe = http.createServer();
    await listen(probe);
    const biliPort = (probe.address() as { port: number }).port;
    await close(probe);
    const opts: ProxyOptions = {
        port: biliPort,
        host: "127.0.0.1",
        upstream: "http://unused.invalid",
        routes: {},
        proxy: "",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: true,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const bili = await startServer(opts);
    if (!bili.listening) await once(bili, "listening");
    try {
        const response = await fetch(`http://127.0.0.1:${biliPort}/codex/future/unknown?x=1&encoded=a%2Fb`, {
            method: "POST",
            headers: {
                authorization: "Bearer OfficialSubscription",
                "chatgpt-account-id": "account-1",
                "session-id": "session-1",
                "x-thread-id": "thread-1",
                "content-type": "application/json",
            },
            body: '{"future":true}',
        });
        assert.equal(response.status, 200);
        assert.ok(captured);
        assert.equal(captured.url, "/backend-api/codex/future/unknown?x=1&encoded=a%2Fb");
        assert.equal(captured.headers.authorization, "Bearer OfficialSubscription");
        assert.equal(captured.headers["chatgpt-account-id"], "account-1");
        assert.equal(captured.headers["session-id"], "session-1");
        assert.equal(captured.headers["x-thread-id"], "thread-1");
        assert.equal(captured.body, '{"future":true}');
    } finally {
        await close(bili);
        await close(upstream);
        if (oldHome === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = oldHome;
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("proxy precedence, NO_PROXY, HTTPS proxies and self-loop detection are deterministic", () => {
    const target = new URL("https://api.example.com:8443/v1");
    assert.equal(matchesNoProxy(target, "localhost,.internal.example,api.example.com:8443"), true);
    assert.equal(resolveProxy({}, undefined, target.href, {
        httpsProxy: "https://env.example:9443",
        systemProxy: { enabled: true, https: "http://system.example:8080" },
        biliPort: 8787,
    }), "https://env.example:9443/");
    assert.equal(resolveProxy({}, undefined, target.href, {
        systemProxy: { enabled: true, https: "http://system.example:8080" },
        biliPort: 8787,
    }), "http://system.example:8080/");
    assert.equal(resolveProxy({}, "http://explicit.example:8080", target.href, {
        noProxy: "api.example.com",
        biliPort: 8787,
    }), "http://explicit.example:8080/");
    assert.equal(resolveProxy({ "https://api.example.com:8443": { proxy: "http://provider.example:8080" } }, "http://explicit.example:8080", target.href, {
        biliPort: 8787,
    }), "http://provider.example:8080/");
    assert.deepEqual(resolveProxyDecision({}, undefined, target.href, {
        httpsProxy: "http://127.0.0.1:8787",
        systemProxy: { enabled: true, https: "http://system.example:8080" },
        biliPort: 8787,
    }), { proxy: "http://system.example:8080/", source: "windows-system" });
    assert.throws(() => parseHttpProxy("http://127.0.0.1:8787", 8787), /loop back into bili/);
    assert.throws(() => parseHttpProxy("http://[::ffff:7f00:1]:8787", 8787), /loop back into bili/);
    assert.equal(parseHttpProxy("https://proxy.example:9443")?.protocol, "https:");
});

test("loadOptions keeps BILI_UPSTREAM_PROXY above config/environment fallback", () => {
    const opts = loadOptions({
        ACP_PORT: "9100",
        BILI_UPSTREAM_PROXY: "https://explicit.example:9443",
        HTTPS_PROXY: "http://fallback.example:8080",
        ALL_PROXY: "http://all.example:8080",
        NO_PROXY: "localhost,127.0.0.1",
    });
    assert.equal(opts.proxy, "https://explicit.example:9443");
    assert.equal(opts.proxySource, "bili-env");
    assert.deepEqual(opts.proxyFallback, {
        httpsProxy: "http://fallback.example:8080",
        allProxy: "http://all.example:8080",
        noProxy: "localhost,127.0.0.1",
        biliPort: 9100,
        globalSource: "bili-env",
    });
});

test("PR #67 ProxyAgent remains the sole HTTP egress transport", async () => {
    const upstream = http.createServer((_req, res) => {
        res.writeHead(201, { "content-type": "text/plain" });
        res.end("via proxy");
    });
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    let capturedConnect = "";
    const tunnels = new Set<net.Socket>();
    const proxy = http.createServer();
    proxy.on("connect", (req, clientSocket, head) => {
        capturedConnect = req.url ?? "";
        const socket = net.connect(upstreamPort, "127.0.0.1", () => {
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) socket.write(head);
            clientSocket.pipe(socket);
            socket.pipe(clientSocket);
        });
        tunnels.add(clientSocket);
        tunnels.add(socket);
        clientSocket.once("close", () => tunnels.delete(clientSocket));
        socket.once("close", () => tunnels.delete(socket));
    });
    await listen(proxy);
    const port = (proxy.address() as { port: number }).port;
    const proxyUrl = `http://127.0.0.1:${port}`;
    try {
        const result = await fetchWithTimeout("http://upstream.invalid/future?q=1", {
            method: "POST",
            body: "payload",
            dispatcher: proxyDispatcher(proxyUrl),
        });
        assert.equal(result.response.status, 201);
        assert.equal(await result.response.text(), "via proxy");
        result.clearTimer();
        assert.equal(capturedConnect, "upstream.invalid:80");
    } finally {
        resetProxyCache();
        for (const socket of tunnels) socket.destroy();
        proxy.closeAllConnections();
        await close(proxy);
        upstream.closeAllConnections();
        await close(upstream);
    }
});

test("upstream failures expand nested causes with redacted proxy context", () => {
    const cause = Object.assign(new Error("connect timed out"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
        errno: -4039,
        syscall: "connect",
        address: "203.0.113.7",
        port: 443,
    });
    const detail = formatUpstreamError(
        new TypeError("fetch failed", { cause }),
        "https://chatgpt.com/backend-api/codex/responses",
        "http://user:secret@proxy.example:8080",
    );
    for (const expected of ["code=UND_ERR_CONNECT_TIMEOUT", "errno=-4039", "syscall=connect", "address=203.0.113.7", "port=443", "message=fetch failed <- connect timed out", "url=https://chatgpt.com/backend-api/codex/responses", "proxy=http://***:***@proxy.example:8080/"]) {
        assert.ok(detail.includes(expected), expected);
    }
});
