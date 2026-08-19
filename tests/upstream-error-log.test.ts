import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

/** #2 field report: a relay answered 400 "请求参数无效" for 34 minutes and
 *  bili.log carried zero trace, because non-2xx upstream responses were
 *  piped through verbatim without logging. The proxy must now warn with
 *  status + request-id + body snippet while still passing the body through
 *  byte-for-byte. */

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

interface Captured {
    level: string;
    msg: string;
}

async function startProxyWith(upstream: http.Server): Promise<{ proxy: http.Server; proxyPort: number; upstreamPort: number; captured: Captured[] }> {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } },
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, proxyPort, upstreamPort, captured };
}

async function postChat(proxyPort: number, upstreamPort: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "upstream-error-log-1" },
        body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
    });
}

test("non-2xx upstream: body passes through verbatim and proxy logs warn with status, request-id, snippet (#2)", async () => {
    const errorBody = JSON.stringify({ error: { message: "请求参数无效，请检查请求格式和参数 (request id: 202608190253469928499778268d9d6MaylrIZ3)" } });
    const upstream = http.createServer((req, res) => {
        res.writeHead(400, { "content-type": "application/json", "x-request-id": "202608190253469928499778268d9d6MaylrIZ3" });
        res.end(errorBody);
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await postChat(proxyPort, upstreamPort);
        assert.equal(resp.status, 400);
        assert.equal(await resp.text(), errorBody);
        const warn = captured.find((c) => c.level === "warn" && c.msg.includes("← upstream 400"));
        assert.ok(warn, `expected warn log, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.match(warn.msg, /请求参数无效/);
        assert.match(warn.msg, /request-id=202608190253469928499778268d9d6MaylrIZ3/);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});

test("non-2xx upstream: chunked body streams through fully and is logged", async () => {
    const upstream = http.createServer((req, res) => {
        res.writeHead(500, { "content-type": "text/plain" });
        res.write("part1-");
        res.write("part2");
        res.end();
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await postChat(proxyPort, upstreamPort);
        assert.equal(resp.status, 500);
        assert.equal(await resp.text(), "part1-part2");
        const warn = captured.find((c) => c.level === "warn" && c.msg.includes("← upstream 500"));
        assert.ok(warn, `expected warn log, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.match(warn.msg, /part1-part2/);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});

test("non-2xx upstream: oversized body passes through fully; snippet is capped and marked truncated", async () => {
    const chunk = "x".repeat(2048);
    const upstream = http.createServer((req, res) => {
        res.writeHead(429, { "content-type": "text/plain" });
        for (let i = 0; i < 100; i++) res.write(chunk);
        res.end();
    });
    const { proxy, proxyPort, upstreamPort, captured } = await startProxyWith(upstream);
    try {
        const resp = await postChat(proxyPort, upstreamPort);
        assert.equal(resp.status, 429);
        const body = await resp.text();
        assert.equal(body.length, 2048 * 100);
        const warn = captured.find((c) => c.level === "warn" && c.msg.includes("← upstream 429"));
        assert.ok(warn, `expected warn log, got: ${captured.map((c) => c.msg).join(" | ")}`);
        assert.ok(warn.msg.length < 1000, "snippet must be capped");
        assert.match(warn.msg, /…$/);
    } finally {
        setLogCapture(null);
        await close(proxy);
        await close(upstream);
    }
});
