import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Agent, fetch } from "undici";
import { loadOptions } from "../src/config.ts";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { matchesNoProxy, resetProxyCache, resolveProxyDecision } from "../src/upstream-proxy.ts";

for (const [target, token] of [
    ["http://[::1]", "0:0:0:0:0:0:0:1"],
    ["https://[2001:db8::1]", "[2001:0DB8:0000:0000:0000:0000:0000:0001]"],
    ["http://[2001:0:0:1::1]", "2001::1:0:0:0:1"],
    ["http://[::ffff:7f00:1]", "::ffff:127.0.0.1"],
    ["https://[::ffff:192.0.2.1]:8443", "[0:0:0:0:0:ffff:c000:201]:8443"],
] as const) {
    test(`NO_PROXY matches the same IPv6 address: ${token}`, () => {
        assert.equal(matchesNoProxy(new URL(target), `other.example; ${token},last.example`), true);
        assert.deepEqual(resolveProxyDecision({}, undefined, target, {
            httpProxy: "http://proxy.example:8080", httpsProxy: "http://proxy.example:8443",
            noProxy: token, systemProxy: { enabled: false },
        }), { source: "no-proxy" });
    });
}

test("IPv6 bypass keeps address and explicit/default port boundaries", () => {
    const target = new URL("https://[::1]/v1");
    assert.equal(matchesNoProxy(target, "[0:0:0:0:0:0:0:1]:443"), true);
    for (const token of ["[0:0:0:0:0:0:0:1]:80", "0:0:0:0:0:0:0:2", "::ffff:127.0.0.1", "::1%lo", "[not:an:ip]", "2001:db8::/32"]) {
        assert.equal(matchesNoProxy(target, token), false, token);
    }
    assert.equal(matchesNoProxy(new URL("http://127.0.0.1"), "::ffff:127.0.0.1"), false);
});

test("Windows exact IPv6 bypass entries use the same address comparison", () => {
    assert.deepEqual(resolveProxyDecision({}, undefined, "http://[::1]:8080/v1", {
        systemProxy: { enabled: true, http: "http://system.example:3128", bypass: "[0:0:0:0:0:0:0:1]:8080" },
    }), { source: "windows-bypass" });
});

test("explicit proxy and direct choices retain precedence over IPv6 bypass", () => {
    const url = "http://[::1]/v1";
    const fallback = { noProxy: "0:0:0:0:0:0:0:1", systemProxy: { enabled: false } };
    assert.equal(resolveProxyDecision({}, "http://explicit.example:8080", url, fallback).source, "global");
    assert.equal(resolveProxyDecision({ "http://[::1]": { proxy: "http://provider.example:8080" } }, undefined, url, fallback).source, "provider");
    assert.deepEqual(resolveProxyDecision({}, "", url, { ...fallback, explicitDirect: true }), { source: "direct" });
});

test("DNS suffixes, IPv4 addresses, wildcard modes, and malformed tokens retain their behavior", () => {
    assert.equal(matchesNoProxy(new URL("https://api.example.com"), ".example.com"), true);
    assert.equal(matchesNoProxy(new URL("https://example.com"), "*.example.com"), true);
    assert.equal(matchesNoProxy(new URL("http://127.0.0.1:8080"), "127.0.0.1:8080"), true);
    assert.equal(matchesNoProxy(new URL("http://[::1]"), "[::1]"), true);
    assert.equal(matchesNoProxy(new URL("http://[::1]"), "*"), true);
    assert.equal(matchesNoProxy(new URL("http://[2001:db8::1]"), "2001:*"), false);
    assert.equal(matchesNoProxy(new URL("http://[2001:db8::1]"), "2001:*", { windowsBypass: true }), true);
    assert.equal(matchesNoProxy(new URL("https://api.example.com"), "[::1"), false);
});

test("auto proxy mode reaches the real IPv6 upstream without sending CONNECT for an equivalent NO_PROXY literal", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    let received = "";
    const upstream = http.createServer((req, res) => {
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => { received += chunk; });
        req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"direct":true}'); });
    });
    upstream.listen(0, "::1");
    await once(upstream, "listening");
    let connects = 0;
    const proxy = http.createServer();
    proxy.on("connect", (_req, socket) => {
        connects++;
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const port = (upstream.address() as { port: number }).port;
    const proxyPort = (proxy.address() as { port: number }).port;
    const client = new Agent();
    let bili: http.Server | undefined;
    try {
        bili = await startServer({
            ...loadOptions({ BILI_UPSTREAM_PROXY_MODE: "auto", HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: `[0:0:0:0:0:0:0:1]:${port}` }),
            port: 0, host: "127.0.0.1", upstream: `http://[::1]:${port}`, routes: {},
            passthrough: true, autoUpdate: false, autoRestartOnUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
            log: false, debug: false, mitm: { enabled: false, domains: [] },
        });
        if (!bili.listening) await once(bili, "listening");
        const response = await fetch(`http://127.0.0.1:${(bili.address() as { port: number }).port}/v1/future`, {
            method: "POST", body: '{"payload":"keep me"}', headers: { "content-type": "application/json" }, dispatcher: client,
            signal: AbortSignal.timeout(5000),
        });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        assert.equal(body, '{"direct":true}');
        assert.equal(received, '{"payload":"keep me"}');
        assert.equal(connects, 0);
    } finally {
        resetProxyCache();
        _resetFetchUtilForTest();
        await client.close();
        for (const server of [bili, proxy, upstream]) {
            if (!server) continue;
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
});
