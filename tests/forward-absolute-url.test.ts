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
