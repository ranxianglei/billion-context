import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
    UPSTREAM_TIMEOUT_MS,
    _resetFetchUtilForTest,
    fetchWithTimeout,
    upstreamTimeoutMs,
} from "../src/fetch-util.ts";
import { _resetUpstreamProxyForTest, proxyDispatcher } from "../src/upstream-proxy.ts";

function listen(server: http.Server): Promise<void> {
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const TIMEOUT_ENV = "BILI_UPSTREAM_TIMEOUT_MS";

function restoreEnv(prev: string | undefined): void {
    if (prev === undefined) delete process.env[TIMEOUT_ENV];
    else process.env[TIMEOUT_ENV] = prev;
}

test("upstreamTimeoutMs honors BILI_UPSTREAM_TIMEOUT_MS and falls back to the 10-minute default", () => {
    const prev = process.env[TIMEOUT_ENV];
    try {
        delete process.env[TIMEOUT_ENV];
        assert.equal(upstreamTimeoutMs(), UPSTREAM_TIMEOUT_MS);
        process.env[TIMEOUT_ENV] = "123456";
        assert.equal(upstreamTimeoutMs(), 123456);
        for (const bad of ["not-a-number", "0", "-5", "1.5"]) {
            process.env[TIMEOUT_ENV] = bad;
            assert.equal(upstreamTimeoutMs(), UPSTREAM_TIMEOUT_MS, `bad value ${bad}`);
        }
    } finally {
        restoreEnv(prev);
    }
});

// Pre-fix, Node's hidden global undici agent capped every direct request at
// 300s (headersTimeout/bodyTimeout defaults) regardless of bili's own
// watchdog, so any prefill silence between the budget and 300s either slipped
// through (budget > 300s) or was killed by undici first (budget < 300s, e.g.
// the observed ~305s truncations). These two cases bracket the alignment:
// silence beyond the budget must die at the budget; silence within it must
// complete.
test("#551: body silence longer than the configured budget is cut at the budget", async () => {
    const budgetMs = 1500;
    const prev = process.env[TIMEOUT_ENV];
    process.env[TIMEOUT_ENV] = String(budgetMs);
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        setTimeout(() => {
            if (!res.destroyed) {
                res.write("late\n");
                res.end();
            }
        }, 3000);
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const started = Date.now();
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/silent`, {});
        let threw = false;
        try {
            const reader = result.response.body.getReader();
            await reader.read();
        } catch {
            threw = true;
        } finally {
            result.clearTimer();
        }
        const elapsed = Date.now() - started;
        assert.ok(threw, "expected the silent body to be aborted within the budget");
        assert.ok(elapsed < 8000, `expected the abort near ${budgetMs}ms, took ${elapsed}ms`);
    } finally {
        restoreEnv(prev);
        upstream.closeAllConnections();
        await close(upstream);
        _resetFetchUtilForTest();
    }
});

test("#551: a prefill silence shorter than the budget completes normally", async () => {
    const budgetMs = 8000;
    const upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        setTimeout(() => {
            res.write("token\n");
            res.end();
        }, 3000);
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const started = Date.now();
        const result = await fetchWithTimeout(`http://127.0.0.1:${port}/slow-prefill`, {}, budgetMs);
        const text = await result.response.text();
        result.clearTimer();
        const elapsed = Date.now() - started;
        assert.equal(text, "token\n");
        assert.ok(elapsed >= 3000, `expected to wait out the 3s prefill silence, got ${elapsed}ms`);
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
        _resetFetchUtilForTest();
    }
});

test("proxyDispatcher caches one ProxyAgent per (url, timeout) pair", () => {
    _resetUpstreamProxyForTest();
    const url = "http://127.0.0.1:1";
    const a = proxyDispatcher(url, 1000);
    const b = proxyDispatcher(url, 1000);
    const c = proxyDispatcher(url, 2000);
    assert.notEqual(a, undefined);
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.equal(proxyDispatcher(undefined), undefined);
    const d = proxyDispatcher(url, 1000);
    _resetUpstreamProxyForTest();
    const e = proxyDispatcher(url, 1000);
    assert.notEqual(d, e);
    _resetUpstreamProxyForTest();
});
