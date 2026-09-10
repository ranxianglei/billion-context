import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: Buffer };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

// #619: an undecodable content-encoding body must not 400 in bili - relay the
// original bytes verbatim so the upstream, not bili, handles the failure.
test("undecodable content-encoding body is forwarded verbatim instead of 400", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
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
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} },
        passthroughSource: null,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    const badBody = Buffer.from("definitely-not-a-gzip-stream", "utf8");
    try {
        const res = await fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: {
                "content-encoding": "gzip",
                "content-type": "application/json",
            },
            body: badBody,
        });
        assert.equal(res.status, 200);
        await res.arrayBuffer();
        assert.equal(captured.length, 1);
        assert.deepEqual(captured[0].body, badBody);
        // #677: verbatim bytes must reach upstream with their encoding declared.
        assert.equal(captured[0].headers["content-encoding"], "gzip");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

// #619 gap: the decompression-bomb size guard must survive the decode-failure
// passthrough - an oversized DECOMPRESSED body is rejected 413 by bili, never relayed.
test("oversized decompressed body is rejected 413 and not forwarded", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            captured.push({ url: req.url ?? "", headers: req.headers, body: Buffer.alloc(0) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} },
        passthroughSource: null,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    const { gzipSync } = await import("node:zlib");
    // ~120MB of zeros gzips to ~120KB on the wire but decompresses past the 100MB cap.
    const bomb = gzipSync(Buffer.alloc(120 * 1024 * 1024, 0));
    try {
        const res = await fetch(`${base}/v1/messages`, {
            method: "POST",
            headers: {
                "content-encoding": "gzip",
                "content-type": "application/json",
            },
            body: bomb,
        });
        assert.equal(res.status, 413);
        await res.arrayBuffer();
        assert.equal(captured.length, 0);
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

// #677: unknown paths never attempt a decode, so their encoded bodies hit the
// same verbatim passthrough - the encoding marker must survive the forward too.
test("unknown-path passthrough keeps content-encoding on the forwarded request", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
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
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} },
        passthroughSource: null,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    const { gzipSync } = await import("node:zlib");
    const wireBody = gzipSync(Buffer.from(JSON.stringify({ input: ["hi"] }), "utf8"));
    try {
        const res = await fetch(`${base}/v1/embeddings`, {
            method: "POST",
            headers: {
                "content-encoding": "gzip",
                "content-type": "application/json",
            },
            body: wireBody,
        });
        assert.equal(res.status, 200);
        await res.arrayBuffer();
        assert.equal(captured.length, 1);
        assert.deepEqual(captured[0].body, wireBody);
        assert.equal(captured[0].headers["content-encoding"], "gzip");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});

// #677: the strip stays direction-specific - upstream RESPONSE encodings are
// still removed (Node fetch already decoded them) while requests pass through.
test("response content-encoding is stripped when forwarding upstream responses", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const { gzipSync } = await import("node:zlib");
    const upstream = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.from(JSON.stringify({ ok: true }), "utf8")));
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-5": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        compat: { roles: {} },
        passthroughSource: null,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`;
    try {
        const res = await fetch(`${base}/v1/embeddings`, { method: "POST", body: "{}" });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-encoding"), null);
        assert.deepEqual(JSON.parse(await res.text()), { ok: true });
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
