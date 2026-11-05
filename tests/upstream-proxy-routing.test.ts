import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { loadOptions, resolveConfiguredContextLimit, type ProxyOptions, type ProviderRoutes } from "../src/config.ts";
import { resolveUpstream, startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { fetchWithTimeout } from "../src/fetch-util.ts";
import { setLogCapture } from "../src/logger.ts";
import {
    _resetUpstreamProxyForTest,
    formatUpstreamError,
    matchesNoProxy,
    parseHttpProxy,
    proxyDispatcher,
    resetProxyCache,
    resolveProxy,
    resolveProxyDecision,
    unsupportedProxyScheme,
    validateHttpProxy,
} from "../src/upstream-proxy.ts";

function listen(server: http.Server, port: number = 0): Promise<void> {
    server.listen(port, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("/bili/ resolves upstream host and full path from embedded URL", () => {
    const opts = loadOptions({ ACP_PORT: "8787" });
    assert.deepEqual(resolveUpstream(opts, "/bili/https://relay.example/openai/v1/responses?foo=a%2Fb"), {
        upstream: "https://relay.example",
        rewrittenUrl: "https://relay.example/openai/v1/responses?foo=a%2Fb",
        explicitProtocol: undefined,
        tunnel: true,
    });
    assert.deepEqual(resolveUpstream(opts, "/bili/https://relay.example/openai/v1/future/unknown?x=1"), {
        upstream: "https://relay.example",
        rewrittenUrl: "https://relay.example/openai/v1/future/unknown?x=1",
        explicitProtocol: undefined,
        tunnel: true,
    });
    assert.deepEqual(resolveUpstream(opts, "/bili/responses/https://relay.example/custom-path"), {
        upstream: "https://relay.example",
        rewrittenUrl: "https://relay.example/custom-path",
        explicitProtocol: "responses",
        tunnel: true,
    });
    assert.deepEqual(resolveUpstream(opts, "/bili/anthropic/https://relay.example/api/generate"), {
        upstream: "https://relay.example",
        rewrittenUrl: "https://relay.example/api/generate",
        explicitProtocol: "anthropic",
        tunnel: true,
    });
    assert.equal(resolveUpstream(opts, "/bili-not-owned/responses"), undefined);
});

test("#535/#562: absolute-form request URLs route as forward-proxy targets", () => {
    const opts = loadOptions({ ACP_PORT: "8787" });
    // httpx through an http_proxy emits absolute form for plain-http base URLs
    assert.deepEqual(resolveUpstream(opts, "http://127.0.0.1:8199/v1/chat/completions", { headers: { host: "127.0.0.1:8787" } } as never), {
        upstream: "http://127.0.0.1:8199",
        rewrittenUrl: "http://127.0.0.1:8199/v1/chat/completions",
        tunnel: true,
    });
    assert.deepEqual(resolveUpstream(opts, "https://relay.example/v1/responses?x=1", { headers: { host: "127.0.0.1:8787" } } as never), {
        upstream: "https://relay.example",
        rewrittenUrl: "https://relay.example/v1/responses?x=1",
        tunnel: true,
    });
    // #562: the real transport form — every genuine forward-proxy request has
    // Host == the URL authority (the client points Host at the UPSTREAM, not the
    // proxy). These MUST route as tunnels; previously they were dropped to
    // undefined (misread as self), silently losing per-upstream window config.
    assert.deepEqual(resolveUpstream(opts, "http://model-server.example.invalid:8080/v1/responses", { headers: { host: "model-server.example.invalid:8080" } } as never), {
        upstream: "http://model-server.example.invalid:8080",
        rewrittenUrl: "http://model-server.example.invalid:8080/v1/responses",
        tunnel: true,
    });
    // A target pointing back at the proxy's own listen endpoint is still marked
    // a tunnel HERE — resolveUpstream cannot see the bound port. In the live
    // pipeline handle() rewrites such self-addressed requests to origin form
    // BEFORE this resolves (#1073/#3245), so they are served locally like direct
    // connections; the marking keeps any self destination that DOES reach
    // admission 403'd by checkTunnelDestination's self-layer; see the
    // forward-absolute-url integration tests.
    assert.deepEqual(resolveUpstream(opts, "http://127.0.0.1:8787/v1/chat/completions", { headers: { host: "127.0.0.1:8787" } } as never), {
        upstream: "http://127.0.0.1:8787",
        rewrittenUrl: "http://127.0.0.1:8787/v1/chat/completions",
        tunnel: true,
    });
    assert.equal(resolveUpstream(opts, "http://127.0.0.1:8787:bad/v1"), undefined, "malformed absolute URL falls through");
    assert.equal(resolveUpstream(opts, "/v1/chat/completions", { headers: { host: "127.0.0.1:8787" } } as never), undefined, "origin-form stays own-API");
});

test("#562: forward-proxy and /bili/ forms of the same upstream resolve the same model window", () => {
    const opts = loadOptions({ ACP_PORT: "8787" });
    const fwd = resolveUpstream(opts, "http://model-server.example.invalid:8080/v1/responses", { headers: { host: "model-server.example.invalid:8080" } } as never);
    const bili = resolveUpstream(opts, "/bili/http://model-server.example.invalid:8080/v1/responses");
    assert.ok(fwd && bili, "both access modes must produce a route");
    assert.equal(fwd.rewrittenUrl, bili.rewrittenUrl, "forward-proxy and /bili/ must share one target resolution");
    const routes: ProviderRoutes = {
        "http://model-server.example.invalid:8080": { models: { "example-model": { context: 120_000 } } },
    };
    assert.equal(resolveConfiguredContextLimit(routes, fwd.rewrittenUrl, "example-model"), 120_000, "forward-proxy hits the per-upstream window, not the global default");
    assert.equal(resolveConfiguredContextLimit(routes, bili.rewrittenUrl, "example-model"), 120_000);
});

test("/bili/ integration preserves query, subscription, account and thread headers", async () => {
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
autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
mitm: { enabled: false, domains: [] },
    };
    const bili = await startServer(opts);
    if (!bili.listening) await once(bili, "listening");
    try {
        const response = await fetch(`http://127.0.0.1:${biliPort}/bili/http://127.0.0.1:${upstreamPort}/backend-api/codex/future/unknown?x=1&encoded=a%2Fb`, {
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

test("Windows ProxyOverride mid-token wildcards bypass the system proxy (#2502)", () => {
    const clashDefault = "localhost;127.*;192.168.*;10.*;172.16.*;172.31.*;<local>";
    assert.equal(matchesNoProxy(new URL("http://127.0.0.1:8893"), clashDefault, { windowsBypass: true }), true);
    assert.equal(matchesNoProxy(new URL("http://192.168.1.5:11434"), clashDefault, { windowsBypass: true }), true);
    assert.equal(matchesNoProxy(new URL("http://10.0.0.9"), clashDefault, { windowsBypass: true }), true);
    assert.equal(matchesNoProxy(new URL("http://172.31.9.9"), clashDefault, { windowsBypass: true }), true);
    assert.equal(matchesNoProxy(new URL("http://localhost:8893"), clashDefault, { windowsBypass: true }), true);
    assert.equal(matchesNoProxy(new URL("http://myhost:80"), clashDefault, { windowsBypass: true }), true);
    assert.equal(matchesNoProxy(new URL("http://api.openai.com/v1"), clashDefault, { windowsBypass: true }), false);
    // literal-dot boundary: 127.* requires the actual dot (127abc.example must not match)
    assert.equal(matchesNoProxy(new URL("http://127abc.example/"), clashDefault, { windowsBypass: true }), false);
    // existing grammar stays intact under the flag: *.suffix (incl. apex), <local>, exact
    assert.equal(matchesNoProxy(new URL("https://sub.example.com"), "*.example.com", { windowsBypass: true }), true);
    assert.equal(matchesNoProxy(new URL("https://example.com"), "*.example.com", { windowsBypass: true }), true);
    // NO_PROXY grammar unchanged: a mid-token * is not a wildcard there
    assert.equal(matchesNoProxy(new URL("http://127.0.0.1:8893"), "127.*"), false);
    assert.equal(matchesNoProxy(new URL("http://127.0.0.1:8893"), "127.*", {}), false);
    // decision level: loopback upstream with Clash's default list goes windows-bypass,
    // public upstream still rides the system proxy
    assert.deepEqual(resolveProxyDecision({}, undefined, "http://127.0.0.1:8893/v1", {
        systemProxy: { enabled: true, http: "http://127.0.0.1:7897", bypass: clashDefault },
        biliPort: 8787,
    }), { source: "windows-bypass" });
    assert.deepEqual(resolveProxyDecision({}, undefined, "http://192.168.1.5:11434/api", {
        systemProxy: { enabled: true, http: "http://127.0.0.1:7897", bypass: clashDefault },
        biliPort: 8787,
    }), { source: "windows-bypass" });
    assert.deepEqual(resolveProxyDecision({}, undefined, "https://api.openai.com/v1", {
        systemProxy: { enabled: true, https: "http://127.0.0.1:7897", bypass: clashDefault },
        biliPort: 8787,
    }), { proxy: "http://127.0.0.1:7897/", source: "windows-system" });
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
    // #2809: proxyFallback gained defaultDirect (false here — an explicit
    // BILI_UPSTREAM_PROXY is set, so the unset-mode diagnostic peek is off).
    assert.deepEqual(opts.proxyFallback, {
        httpsProxy: "http://fallback.example:8080",
        allProxy: "http://all.example:8080",
        noProxy: "localhost,127.0.0.1",
        biliPort: 9100,
        globalSource: "bili-env",
        explicitDirect: false,
        defaultDirect: false,
    });
});

test("default (unset mode) is direct, not env auto-detect (#346)", () => {
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = "/nonexistent/bili-test-config.json";
    try {
        // No BILI_UPSTREAM_PROXY_MODE and no BILI_UPSTREAM_PROXY, but HTTPS_PROXY is
        // set in the environment. Before the #346 fix, unset mode auto-detected the
        // env proxy; now unset means "direct" (matches the web UI default + ZCode).
        const opts = loadOptions({
            ACP_PORT: "9101",
            HTTPS_PROXY: "http://fallback.example:8080",
        });
        assert.equal(opts.proxy, "");
        assert.equal(opts.proxySource, "direct");
        assert.equal(opts.proxyFallback!.explicitDirect, true);
        // #346 egress pin stands (source stays "direct"); #2809 adds the
        // diagnostic-only skippedProxy naming the env proxy that was skipped.
        const decision = resolveProxyDecision(opts.routes, opts.proxy, "https://api.example.com/v1", opts.proxyFallback);
        assert.deepEqual(decision, {
            source: "direct",
            skippedProxy: { proxy: "http://fallback.example:8080/", source: "HTTPS_PROXY" },
        });
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
    }
});

test("explicit 'auto' mode still follows the env proxy (#346 opt-in)", () => {
    const prevConfig = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = "/nonexistent/bili-test-config.json";
    try {
        const opts = loadOptions({
            ACP_PORT: "9102",
            BILI_UPSTREAM_PROXY_MODE: "auto",
            HTTPS_PROXY: "http://fallback.example:8080",
        });
        assert.equal(opts.proxySource, "auto");
        assert.equal(opts.proxyFallback!.explicitDirect, false);
        const decision = resolveProxyDecision(opts.routes, opts.proxy, "https://api.example.com/v1", opts.proxyFallback);
        assert.deepEqual(decision, { proxy: "http://fallback.example:8080/", source: "HTTPS_PROXY" });
    } finally {
        if (prevConfig === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prevConfig;
    }
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
        tunnels.add(clientSocket as net.Socket);
        tunnels.add(socket);
        clientSocket.once("close", () => tunnels.delete(clientSocket as net.Socket));
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

test("#1014: unsupportedProxyScheme classifies schemes without false positives on bare host:port", () => {
    assert.equal(unsupportedProxyScheme("socks5h://127.0.0.1:7890"), "socks5h");
    assert.equal(unsupportedProxyScheme("socks5://127.0.0.1:1080"), "socks5");
    assert.equal(unsupportedProxyScheme("socks://proxy.example:1080"), "socks");
    assert.equal(unsupportedProxyScheme("http://proxy.example:8080"), undefined);
    assert.equal(unsupportedProxyScheme("https://proxy.example:9443"), undefined);
    assert.equal(unsupportedProxyScheme("127.0.0.1:7890"), undefined, "schemeless host:port normalizes to http like parseHttpProxy");
    assert.equal(unsupportedProxyScheme(undefined), undefined);
    assert.equal(unsupportedProxyScheme(""), undefined);
});

test("#1014: env proxy with unsupported scheme falls through to direct loudly, once per source+scheme", () => {
    _resetUpstreamProxyForTest();
    const captured: Array<{ level: string; msg: string }> = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    try {
        const fallback = {
            httpsProxy: "socks5h://user:secret@127.0.0.1:7890",
            allProxy: "socks5://127.0.0.1:1080",
            systemProxy: { enabled: false },
            biliPort: 8787,
        };
        const first = resolveProxyDecision({}, undefined, "https://api.example.com/v1", fallback);
        assert.deepEqual(first, { source: "direct" });
        const warnings = () => captured.filter((entry) => entry.level === "warn" && entry.msg.startsWith("[upstream-proxy] ignoring"));
        assert.equal(warnings().length, 2, `expected 2 warnings, got: ${captured.map((e) => e.msg).join(" | ")}`);
        assert.ok(warnings().some((entry) => entry.msg.includes("HTTPS_PROXY=socks5h://***:***@127.0.0.1:7890")), "redacted HTTPS_PROXY warning");
        assert.ok(!captured.some((entry) => entry.msg.includes("secret")), "credential must not leak into the log");
        assert.ok(warnings().some((entry) => entry.msg.includes("ALL_PROXY=socks5://127.0.0.1:1080") && entry.msg.includes('scheme "socks5"')));
        assert.ok(warnings().every((entry) => entry.msg.includes("mixed port over http://")));
        const before = captured.length;
        const second = resolveProxyDecision({}, undefined, "https://api.example.com/v1", fallback);
        assert.deepEqual(second, { source: "direct" });
        assert.equal(captured.length, before, "warning must not repeat on later requests");
    } finally {
        setLogCapture(null);
        _resetUpstreamProxyForTest();
    }
});

test("#1014: a valid env proxy still wins while an earlier unsupported one warns and drops", () => {
    _resetUpstreamProxyForTest();
    const captured: Array<{ level: string; msg: string }> = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    try {
        const decision = resolveProxyDecision({}, undefined, "https://api.example.com/v1", {
            httpsProxy: "socks5h://127.0.0.1:7890",
            httpProxy: "http://fallback.example:8080",
            systemProxy: { enabled: false },
            biliPort: 8787,
        });
        assert.deepEqual(decision, { proxy: "http://fallback.example:8080/", source: "HTTP_PROXY" });
        const warnings = captured.filter((entry) => entry.level === "warn" && entry.msg.startsWith("[upstream-proxy] ignoring"));
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].msg.includes("HTTPS_PROXY=socks5h://127.0.0.1:7890"));
    } finally {
        setLogCapture(null);
        _resetUpstreamProxyForTest();
    }
});

test("#1014: explicit socks proxy fails startup with an actionable error, not the generic origin message", () => {
    assert.throws(() => validateHttpProxy("socks5h://127.0.0.1:7890"), /unsupported scheme "socks5h"/);
    assert.throws(() => validateHttpProxy("socks5://127.0.0.1:1080"), /mixed port over http/);
    assert.throws(() => validateHttpProxy("http://proxy.example/bad-path"), /must be an HTTP\/HTTPS proxy origin/);
    assert.doesNotThrow(() => validateHttpProxy("http://127.0.0.1:7890"));
    assert.doesNotThrow(() => validateHttpProxy(undefined));
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
