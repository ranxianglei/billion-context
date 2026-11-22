import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { rootCertificates } from "node:tls";
import { Agent, ProxyAgent } from "undici";
import { _resetFetchUtilForTest, fetchWithTimeout, type FetchOptions } from "../src/fetch-util.js";
import { proxyDispatcher, resetProxyCache } from "../src/upstream-proxy.js";

// Undici's runtime DispatcherBase exposes these lifecycle getters, but ProxyAgent's
// declaration omits them. Read and validate the real getters rather than fabricating state.
function poolState(agent: Agent | ProxyAgent): { closed: boolean; destroyed: boolean } {
    const closed: unknown = Reflect.get(agent, "closed");
    const destroyed: unknown = Reflect.get(agent, "destroyed");
    assert.ok(typeof closed === "boolean" && typeof destroyed === "boolean");
    return { closed, destroyed };
}

function caFiles(t: TestContext): { a: string; b: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ca-pools-"));
    const a = path.join(dir, "a.pem");
    const b = path.join(dir, "b.pem");
    fs.writeFileSync(a, rootCertificates[0]);
    fs.writeFileSync(b, rootCertificates[0]);
    const previous = process.env.BILI_CA_FILE;
    _resetFetchUtilForTest();
    resetProxyCache();
    t.after(() => {
        _resetFetchUtilForTest();
        resetProxyCache();
        if (previous === undefined) delete process.env.BILI_CA_FILE;
        else process.env.BILI_CA_FILE = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { a, b };
}

function captureDirectAgent(t: TestContext): (timeoutMs?: number) => Promise<Agent> {
    let captured: object | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, opts: FetchOptions) => {
        captured = opts.dispatcher;
        return new Response("ok");
    });
    return async (timeoutMs = 10_000) => {
        const result = await fetchWithTimeout("http://127.0.0.1/fixture", {}, timeoutMs);
        try {
            await result.response.text();
            assert.ok(captured instanceof Agent);
            return captured;
        } finally {
            result.clearTimer();
        }
    };
}

test("CA rotation retires every old direct pool while unchanged trust reuses each timeout pool", async (t) => {
    const files = caFiles(t);
    const dispatcher = captureDirectAgent(t);
    process.env.BILI_CA_FILE = files.a;
    const a = await dispatcher();
    const longer = await dispatcher(20_000);
    assert.equal(await dispatcher(), a);
    assert.notEqual(longer, a);
    assert.equal(poolState(a).closed, false);
    assert.equal(poolState(longer).closed, false);

    process.env.BILI_CA_FILE = files.b;
    const b = await dispatcher();
    assert.notEqual(b, a);
    assert.equal(poolState(a).closed, true, "retired direct Agent must release its origin pools and CA material");
    assert.equal(poolState(longer).closed, true, "all timeout variants of the retired identity must close");
    assert.equal(poolState(b).closed, false);
    assert.equal(await dispatcher(), b);

    process.env.BILI_CA_FILE = files.a;
    assert.notEqual(await dispatcher(), a, "returning to an old identity must not resurrect its retired Agent");
    assert.equal(poolState(b).closed, true);
    delete process.env.BILI_CA_FILE;
    const defaults = await dispatcher();
    assert.equal(poolState(defaults).closed, false);
    assert.equal(await dispatcher(), defaults, "the unset trust identity is cached normally");
});

test("CA rotation retires every old proxy pool without evicting other routes for unchanged trust", (t) => {
    const files = caFiles(t);
    process.env.BILI_CA_FILE = files.a;
    const a = proxyDispatcher("http://127.0.0.1:1", 10_000) as ProxyAgent;
    const otherRoute = proxyDispatcher("http://127.0.0.1:2", 20_000) as ProxyAgent;
    assert.equal(proxyDispatcher("http://127.0.0.1:1", 10_000), a);
    assert.equal(poolState(a).closed, false);
    assert.equal(poolState(otherRoute).closed, false);

    process.env.BILI_CA_FILE = files.b;
    const b = proxyDispatcher("http://127.0.0.1:1", 10_000) as ProxyAgent;
    assert.notEqual(b, a);
    assert.equal(poolState(a).closed, true, "retired ProxyAgent must release both proxy and target pools");
    assert.equal(poolState(otherRoute).closed, true, "all proxy routes using the retired identity must close");
    assert.equal(poolState(b).closed, false);
    assert.equal(proxyDispatcher("http://127.0.0.1:1", 10_000), b);

    process.env.BILI_CA_FILE = files.a;
    assert.notEqual(proxyDispatcher("http://127.0.0.1:1", 10_000), a);
    assert.equal(poolState(b).closed, true);
    delete process.env.BILI_CA_FILE;
    const defaults = proxyDispatcher("http://127.0.0.1:1", 10_000) as ProxyAgent;
    assert.equal(poolState(defaults).closed, false);
    assert.equal(proxyDispatcher("http://127.0.0.1:1", 10_000), defaults);
});

for (const proxied of [false, true]) {
    test(`retiring ${proxied ? "proxy" : "direct"} CA pools lets an in-flight response finish`, async (t) => {
        const files = caFiles(t);
        const sockets = new Set<Duplex>();
        const timers: Array<() => void> = [];
        let streaming: http.ServerResponse | undefined;
        const upstream = http.createServer((req, res) => {
            if (req.url === "/stream") {
                streaming = res;
                res.writeHead(200, { "content-type": "text/plain" });
                res.write("start\n");
            } else {
                res.end("new trust\n");
            }
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const port = (upstream.address() as net.AddressInfo).port;
        const proxy = http.createServer();
        proxy.on("connect", (_req, client, head) => {
            const target = net.connect(port, "127.0.0.1", () => {
                client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                if (head.length) target.write(head);
                client.pipe(target);
                target.pipe(client);
            });
            for (const socket of [client, target]) {
                sockets.add(socket);
                socket.on("error", () => socket.destroy());
                socket.on("close", () => sockets.delete(socket));
            }
        });
        proxy.listen(0, "127.0.0.1");
        await once(proxy, "listening");
        const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
        t.after(async () => {
            for (const clear of timers) clear();
            _resetFetchUtilForTest();
            resetProxyCache();
            for (const socket of sockets) socket.destroy();
            upstream.closeAllConnections();
            proxy.closeAllConnections();
            await Promise.all([upstream, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
        });
        const nativeFetch = globalThis.fetch;
        const used: Array<Agent | ProxyAgent> = [];
        t.mock.method(globalThis, "fetch", (url: string, opts: FetchOptions) => {
            assert.ok(opts.dispatcher instanceof Agent || opts.dispatcher instanceof ProxyAgent);
            used.push(opts.dispatcher);
            return nativeFetch(url, opts as RequestInit);
        });
        async function get(route: string) {
            const result = await fetchWithTimeout(`http://127.0.0.1:${port}${route}`, {
                dispatcher: proxied ? proxyDispatcher(proxyUrl, 10_000) : undefined,
            }, 10_000);
            timers.push(result.clearTimer);
            return result;
        }

        process.env.BILI_CA_FILE = files.a;
        const first = await get("/stream");
        const reader = first.response.body!.getReader();
        assert.equal(new TextDecoder().decode((await reader.read()).value), "start\n");
        process.env.BILI_CA_FILE = files.b;
        const second = await get("/fast");
        assert.equal(await second.response.text(), "new trust\n");
        assert.notEqual(used[0], used[1]);
        assert.equal(poolState(used[0]).closed, true, "the old dispatcher stops admitting new requests");
        assert.equal(poolState(used[0]).destroyed, false, "retirement waits for the existing body instead of destroying it");
        assert.ok(streaming);
        streaming.end("finish\n");
        assert.equal(new TextDecoder().decode((await reader.read()).value), "finish\n");
        assert.equal((await reader.read()).done, true);
        await used[0].close();
        assert.equal(poolState(used[0]).destroyed, true, "the retired pools are released after their last response");
        assert.equal(poolState(used[1]).closed, false, "the current identity remains available");
    });
}
