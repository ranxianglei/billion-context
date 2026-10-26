import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("forward: absolute-URL proxy-mode request reaches the correct upstream (no URL mangling)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let capturedUrl = "";
    let capturedHost = "";
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            capturedUrl = req.url ?? "";
            capturedHost = String(req.headers["host"] ?? "");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const upstreamHost = `127.0.0.1:${upstreamPort}`;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "https://api.anthropic.com",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    const body = JSON.stringify({
        model: "gpt-test",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
    });

    try {
        await new Promise<void>((resolve, reject) => {
            const req = http.request(
                {
                    host: "127.0.0.1",
                    port: proxyPort,
                    method: "POST",
                    path: `http://${upstreamHost}/v1/chat/completions`,
                    headers: {
                        "content-type": "application/json",
                        host: upstreamHost,
                        "x-acp-session": "forward-absolute-url-test",
                        "content-length": String(Buffer.byteLength(body)),
                    },
                },
                (res) => {
                    res.on("data", () => {});
                    res.on("end", () => resolve());
                },
            );
            req.on("error", reject);
            req.write(body);
            req.end();
        });

        assert.equal(
            capturedUrl,
            "/v1/chat/completions",
            `upstream must receive the PATH, not a mangled URL; got "${capturedUrl}"`,
        );
        assert.equal(
            capturedHost,
            upstreamHost,
            `upstream Host header must be the real upstream host, not the default; got "${capturedHost}"`,
        );
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

// #3245 (supersedes the #562 pin): a client whose network stack routes plain-HTTP
// traffic through bili's own listener (ZCode's GUI Network proxy setting) emits
// absolute-form targets equal to the proxy origin for its own endpoints. That
// shape is a fetch of us, not a tunnel — it must be served locally exactly like
// the equivalent direct origin-form request, not 403'd by the self-layer. The
// #562 property (no forwarding of self destinations via the tunnel path) now
// lives in the explicit-wrapper negative test below.
test("forward: a self-targeting absolute-URL request is served locally like a direct connection (#3245)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    let capturedUrl = "";
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            capturedUrl = req.url ?? "";
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const outcome = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = http.request(
                {
                    host: "127.0.0.1",
                    port: proxyPort,
                    method: "POST",
                    path: `http://127.0.0.1:${proxyPort}/v1/chat/completions`,
                    headers: {
                        "content-type": "application/json",
                        host: `127.0.0.1:${proxyPort}`,
                        "x-acp-session": "self-target-local-test",
                        "content-length": String(Buffer.byteLength(JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: "hi" }] }))),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
                },
            );
            req.on("error", reject);
            req.write(JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: "hi" }] }));
            req.end();
        });

        assert.equal(outcome.status, 200, `self-target must be served locally and forwarded to the configured upstream; got ${outcome.status}: ${outcome.body}`);
        assert.equal(capturedUrl, "/v1/chat/completions", `local pipeline must forward the origin-form path to the default upstream; got "${capturedUrl}"`);
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

test("forward: an explicit /bili/ wrapper naming the proxy itself is still denied (#562 self-layer)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "https://api.anthropic.com",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        // An embedded-URL wrapper whose destination IS the proxy's own endpoint
        // is still a genuine self-tunnel — the #3245 rewrite only strips
        // outer-form authority, it never rewrites /bili/-embedded targets.
        const outcome = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = http.request(
                {
                    host: "127.0.0.1",
                    port: proxyPort,
                    method: "GET",
                    path: `/bili/http://127.0.0.1:${proxyPort}/v1/models`,
                    headers: { host: `127.0.0.1:${proxyPort}` },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
                },
            );
            req.on("error", reject);
            req.end();
        });

        assert.equal(outcome.status, 403, `explicit self-wrapper must stay denied with 403; got ${outcome.status}: ${outcome.body}`);
        assert.match(outcome.body, /tunnel_destination_denied/, outcome.body);
    } finally {
        await close(proxy);
    }
});
