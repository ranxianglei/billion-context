import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #661 follow-up: a forward proxy must not silently follow upstream redirects.
// undici's default (redirect: "follow") downgrades a POST to a GET and drops
// the body on 301/302/303, so a redirecting upstream (CDN/WAF) turns a valid
// POST into a 405 at the redirect target. bili must pass the 3xx through to
// the client, which follows it with its own policy. ACP compression stays on:
// the kernel round-trip still rewrites the body before the (now non-followed)
// forward.

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const POST_BODY = JSON.stringify({
    model: "claude-test",
    max_tokens: 4096,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
});

function makeOpts(upstream: string): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream,
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
}

interface Seen {
    method: string | null;
    body: string;
}

function makeRedirector(capture: Seen, targetUrl: string): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            capture.method = req.method ?? null;
            capture.body = Buffer.concat(chunks).toString("utf8");
            res.writeHead(302, { location: targetUrl });
            res.end();
        });
    });
}

function makeTarget(seen: { hit: boolean; method: string | null }): http.Server {
    return http.createServer((req, res) => {
        seen.hit = true;
        seen.method = req.method ?? null;
        if (req.method === "POST") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        } else {
            res.writeHead(405, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "method not allowed" }));
        }
    });
}

function requestThroughProxy(
    proxyPort: number,
    redirectorHost: string,
    method: "POST" | "GET",
    path: string,
    body: string | null,
): Promise<{ status: number; location: string | null; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                host: "127.0.0.1",
                port: proxyPort,
                method,
                path: `/bili/http://${redirectorHost}${path}`,
                headers: {
                    host: redirectorHost,
                    "x-acp-session": "redirect-test",
                    ...(body !== null ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } : {}),
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode ?? 0,
                    location: res.headers.location ?? null,
                    body: Buffer.concat(chunks).toString("utf8"),
                }));
            },
        );
        req.on("error", reject);
        if (body !== null) req.write(body);
        req.end();
    });
}

test("POST: a 302 is passed through to the client, NOT followed (no POST→GET downgrade to 405); compression stays on", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const targetSeen = { hit: false, method: null as string | null };
    const target = makeTarget(targetSeen);
    target.listen(0, "127.0.0.1");
    await listen(target);
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/target`;

    const redirectorSeen: Seen = { method: null, body: "" };
    const redirector = makeRedirector(redirectorSeen, targetUrl);
    redirector.listen(0, "127.0.0.1");
    await listen(redirector);
    const redirectorHost = `127.0.0.1:${(redirector.address() as { port: number }).port}`;

    const proxy = await startServer(makeOpts(`http://${redirectorHost}`));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const out = await requestThroughProxy(proxyPort, redirectorHost, "POST", "/v1/messages", POST_BODY);

        assert.equal(out.status, 302, `client must see the upstream 302 passed through; got ${out.status}: ${out.body}`);
        assert.equal(out.location, targetUrl, "Location must be preserved so the client follows the redirect itself");
        assert.equal(targetSeen.hit, false, "bili must NOT follow the redirect — the target must never be contacted");
        assert.equal(redirectorSeen.method, "POST", "bili must forward the original method (POST) to the initial upstream");
        assert.ok(redirectorSeen.body.includes("\x3cacp "), "ACP compression must still be active: the kernel round-trip rewrites the body before the forward");
    } finally {
        await close(proxy);
        await close(redirector);
        await close(target);
    }
});

test("GET: a 302 is passed through to the client, NOT followed", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const targetSeen = { hit: false, method: null as string | null };
    const target = makeTarget(targetSeen);
    target.listen(0, "127.0.0.1");
    await listen(target);
    const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}/target`;

    const redirectorSeen: Seen = { method: null, body: "" };
    const redirector = makeRedirector(redirectorSeen, targetUrl);
    redirector.listen(0, "127.0.0.1");
    await listen(redirector);
    const redirectorHost = `127.0.0.1:${(redirector.address() as { port: number }).port}`;

    const proxy = await startServer(makeOpts(`http://${redirectorHost}`));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const out = await requestThroughProxy(proxyPort, redirectorHost, "GET", "/v1/models", null);

        assert.equal(out.status, 302, `client must see the upstream 302 passed through; got ${out.status}: ${out.body}`);
        assert.equal(out.location, targetUrl, "Location must be preserved");
        assert.equal(targetSeen.hit, false, "bili must NOT follow the redirect — the target must never be contacted");
        assert.equal(redirectorSeen.method, "GET", "bili must forward the original method (GET)");
    } finally {
        await close(proxy);
        await close(redirector);
        await close(target);
    }
});
