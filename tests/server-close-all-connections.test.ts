// #4380: server.closeAllConnections() must cut through the post-response
// linger (#1982) — before the fix, idle keep-alive pooled sockets sat out the
// linger budget (3-5s) after an explicit closeAllConnections() call, taxing
// every embedded startServer/close cycle (test teardown, graceful shutdown).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { startServer, restartForceCloseOf } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";

const UPSTREAM_BODY = JSON.stringify({
    id: "linger-cut", role: "assistant",
    content: [{ type: "text", text: "answer" }],
    usage: { input_tokens: 5, output_tokens: 1 },
});

async function harness(): Promise<{ proxy: http.Server; origin: string; upstream: http.Server; upstreamUrl: string }> {
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(UPSTREAM_BODY);
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "model-test": { context: 64_000 } } } },
        modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
    return { proxy, origin, upstream, upstreamUrl };
}

async function sendOne(origin: string, upstreamUrl: string): Promise<void> {
    const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "linger-cut" },
        body: JSON.stringify({ model: "model-test", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
    });
    const bodyText = await r.text();
    assert.equal(r.status, 200, bodyText);
}

test("closeAllConnections() cuts through the linger: server closes immediately after an explicit cut (#4380)", { timeout: 30_000 }, async () => {
    const { proxy, origin, upstream, upstreamUrl } = await harness();
    try {
        await sendOne(origin, upstreamUrl);
        proxy.close();
        proxy.closeAllConnections();
        const closedAt = Date.now();
        // Pre-fix behavior: the idle pooled socket sat out the linger (~3s
        // until undici's pool expires, up to the 5s budget). 2.5s stays far
        // under the linger floor while tolerating slow-runner noise.
        await once(proxy, "close");
        assert.ok(Date.now() - closedAt < 2_500, `close took ${Date.now() - closedAt}ms — linger still defeating closeAllConnections (#4380)`);
    } finally {
        upstream.close();
        upstream.closeIdleConnections?.();
        upstream.closeAllConnections?.();
    }
});

test("plain close() keeps the linger: an idle pooled socket is NOT cut without the explicit call (#4380 negative)", { timeout: 30_000 }, async () => {
    const { proxy, origin, upstream, upstreamUrl } = await harness();
    try {
        await sendOne(origin, upstreamUrl);
        proxy.close();
        // Without closeAllConnections() the linger protection must stay
        // armed: the idle keep-alive socket survives past the point where a
        // defeated linger would have let node close immediately.
        await new Promise((r) => setTimeout(r, 1_200));
        assert.equal(proxy.listening, false, "listener stopped (close() did run)");
        // Still no 'close' event => connection still held: the linger is intact.
        let fired = false;
        proxy.once("close", () => { fired = true; });
        assert.equal(fired, false, "close event must not have fired within the linger window — linger protection would be gone");
        // Finish via the sanctioned force-close seam.
        restartForceCloseOf(proxy)?.();
        await once(proxy, "close");
    } finally {
        upstream.close();
        upstream.closeIdleConnections?.();
        upstream.closeAllConnections?.();
    }
});
