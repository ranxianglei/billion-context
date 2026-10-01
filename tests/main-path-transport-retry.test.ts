import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { afterEach, test } from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_REPLAY_RETRY_MAX = "3";
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";

import { defaultConfig } from "acp-kernel";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest, fetchWithTransportRetry, type ReplayRetryInfo } from "../src/fetch-util.ts";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #1688: the main model-request path was single-attempt — one millisecond
// DNS/reset/refused blip killed the whole round while acp-loop/preflight
// already replayed under fetchWithRetry. These tests pin the new contract:
// fail-fast pre-response transport deaths are bounded-transparently replayed
// (BILI_REPLAY_RETRY_MAX / BILI_REPLAY_RETRY_BASE_MS), HTTP verdicts stay
// untouched (no replay, no UpstreamHttpError conversion), and BILI_REPLAY_RETRY_MAX=1
// restores the legacy single-attempt behavior exactly.

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "each attempt releases its upstream idle timer");
    _resetFetchUtilForTest();
    process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
});

function errorChainText(err: unknown): string {
    let out = "";
    let cur: unknown = err;
    for (let i = 0; i < 8 && cur; i++) {
        out += `${cur instanceof Error ? cur.message : String(cur)}\n`;
        cur = (cur as { cause?: unknown }).cause;
    }
    return out;
}

async function closedPort(): Promise<number> {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    const port = (srv.address() as net.AddressInfo).port;
    srv.close();
    await once(srv, "close");
    return port;
}

test("#1688 unit: connect-refused is replayed and the recovered response is returned", async () => {
    process.env.BILI_REPLAY_RETRY_BASE_MS = "50";
    const holder = net.createServer();
    holder.listen(0, "127.0.0.1");
    await once(holder, "listening");
    const port = (holder.address() as net.AddressInfo).port;
    holder.close();
    await once(holder, "close");
    const srv = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    });

    const retries: ReplayRetryInfo[] = [];
    const pending = fetchWithTransportRetry(`http://127.0.0.1:${port}/`, { method: "GET" }, undefined, undefined, (i) => retries.push(i));
    await new Promise((r) => setTimeout(r, 10));
    srv.listen(port, "127.0.0.1");
    await once(srv, "listening");
    let result: Awaited<ReturnType<typeof fetchWithTransportRetry>>;
    try {
        result = await pending;
        assert.equal(result.response.status, 200);
        assert.equal(await result.response.text(), "ok");
    } finally {
        result?.clearTimer();
        srv.close();
        await once(srv, "close");
    }
    assert.equal(retries.length, 1);
    assert.match(retries[0].detail, /connect-refused/);
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].maxAttempts, 3);
});

test("#1688 unit: pre-response socket reset is replayed", async () => {
    let conns = 0;
    const srv = http.createServer((req, res) => {
        req.resume();
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    });
    srv.on("connection", (socket) => {
        if (++conns === 1) socket.destroy();
    });
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/`;

    const retries: ReplayRetryInfo[] = [];
    const result = await fetchWithTransportRetry(url, { method: "GET" }, undefined, undefined, (i) => retries.push(i));
    try {
        assert.equal(result.response.status, 200);
        assert.equal(await result.response.text(), "ok");
    } finally {
        result.clearTimer();
        srv.close();
        await once(srv, "close");
    }
    assert.equal(retries.length, 1);
    assert.match(retries[0].detail, /reset/);
});

test("#1688 unit: persistent DNS failure exhausts the budget and rethrows the original error", async () => {
    const retries: ReplayRetryInfo[] = [];
    let thrown: unknown;
    try {
        await fetchWithTransportRetry("http://bili-does-not-exist.invalid/x", { method: "GET" }, undefined, undefined, (i) => retries.push(i));
    } catch (e) {
        thrown = e;
    }
    assert.ok(thrown, "a persistent DNS failure must eventually surface");
    assert.match(errorChainText(thrown), /ENOTFOUND|EAI_AGAIN/);
    assert.equal(retries.length, 2, "maxAttempts-1 replays before giving up");
    assert.match(retries[0].detail, /dns/);
    assert.match(retries[1].detail, /dns/);
});

test("#1688 unit: any HTTP verdict passes through untouched — never replayed, never converted", async () => {
    let hits = 0;
    const srv = http.createServer((req, res) => {
        hits++;
        req.resume();
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "model does not exist" } }));
    });
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/`;

    const retries: ReplayRetryInfo[] = [];
    const result = await fetchWithTransportRetry(url, { method: "POST", body: "{}" }, undefined, undefined, (i) => retries.push(i));
    try {
        assert.equal(result.response.status, 400);
        assert.match(await result.response.text(), /model does not exist/);
        assert.equal(retries.length, 0);
    } finally {
        result.clearTimer();
        srv.close();
        await once(srv, "close");
    }
    assert.equal(hits, 1, "a 4xx verdict goes straight back to the caller");
});

test("#1688 unit: BILI_REPLAY_RETRY_MAX=1 restores the legacy single-attempt behavior", async () => {
    process.env.BILI_REPLAY_RETRY_MAX = "1";
    try {
        const port = await closedPort();
        let retries = 0;
        let thrown: unknown;
        try {
            await fetchWithTransportRetry(`http://127.0.0.1:${port}/`, { method: "GET" }, undefined, undefined, () => retries++);
        } catch (e) {
            thrown = e;
        }
        assert.ok(thrown);
        assert.match(errorChainText(thrown), /ECONNREFUSED/);
        assert.equal(retries, 0);
    } finally {
        process.env.BILI_REPLAY_RETRY_MAX = "3";
    }
});

test("#1688 unit: replays honor the exponential backoff budget", async () => {
    process.env.BILI_REPLAY_RETRY_BASE_MS = "50";
    const port = await closedPort();
    const delays: number[] = [];
    const t0 = Date.now();
    let thrown: unknown;
    try {
        await fetchWithTransportRetry(`http://127.0.0.1:${port}/`, { method: "GET" }, undefined, undefined, (i) => delays.push(i.delayMs));
    } catch (e) {
        thrown = e;
    }
    const elapsed = Date.now() - t0;
    assert.ok(thrown);
    assert.deepEqual(delays, [50, 100]);
    assert.ok(elapsed >= 150, `backoff was actually awaited (${elapsed}ms >= 150ms)`);
});

test("#1688 unit: a client disconnect during backoff kills the replay chain promptly", async () => {
    process.env.BILI_REPLAY_RETRY_BASE_MS = "500";
    const port = await closedPort();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    let thrown: unknown;
    try {
        await fetchWithTransportRetry(`http://127.0.0.1:${port}/`, { method: "GET" }, undefined, ac.signal);
    } catch (e) {
        thrown = e;
    }
    const elapsed = Date.now() - t0;
    assert.ok(thrown, "an aborted backoff must not resolve into a success");
    assert.ok(elapsed < 450, `aborted backoff exits promptly (${elapsed}ms < 450ms)`);
});

const WINDOW = 32_000;

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

const RELAY_ERROR_BODY = JSON.stringify({
    error: { type: "invalid_request_error", message: "model does not exist" },
});

interface RelayOpts {
    destroyStreamingAt?: number[];
    failFirstStreamingWith?: number;
}

function makeRelay(opts: RelayOpts) {
    const received: boolean[] = [];
    let streamingCall = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            let parsed: Record<string, unknown> = {};
            try {
                parsed = JSON.parse(raw.toString("utf8"));
            } catch {
                /* non-JSON */
            }
            if (parsed.stream !== true) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end("{}");
                return;
            }
            streamingCall += 1;
            received.push(true);
            if (opts.destroyStreamingAt?.includes(streamingCall)) {
                req.socket.destroy();
                return;
            }
            if (opts.failFirstStreamingWith && streamingCall === 1) {
                res.writeHead(opts.failFirstStreamingWith, { "content-type": "application/json" });
                res.end(RELAY_ERROR_BODY);
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse());
        });
    });
    return { server, streamingCalls: () => streamingCall };
}

async function startProxy(upstreamPort: number): Promise<{ proxy: http.Server; port: number }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-relay": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, port: proxy.address().port };
}

function chatBody(): string {
    return JSON.stringify({
        model: "claude-relay",
        max_tokens: 1024,
        stream: true,
        system: "You are a helpful assistant.",
        messages: [
            { role: "user", content: "Hello" },
            { role: "assistant", content: "Hi!" },
            { role: "user", content: "How are you?" },
        ],
    });
}

test("#1688 e2e: a pre-response reset mid-round is replayed transparently — the client sees one 200", async () => {
    const relay = makeRelay({ destroyStreamingAt: [1] });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const { proxy, port } = await startProxy(upstreamPort);

    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "retry-sess" },
            body: chatBody(),
        });
        assert.equal(r.status, 200, "the round survives the blip");
        const text = await r.text();
        assert.match(text, /message_stop/, "the recovered stream reaches the client intact");
        assert.equal(relay.streamingCalls(), 2, "exactly one transparent replay within the same request");
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});

test("#1688 e2e: persistent transport failure exhausts the budget, then surfaces bili's 502", async () => {
    const relay = makeRelay({ destroyStreamingAt: [1, 2, 3, 4, 5] });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const { proxy, port } = await startProxy(upstreamPort);

    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "retry-sess-2" },
            body: chatBody(),
        });
        assert.equal(r.status, 502);
        const text = await r.text();
        assert.match(text, /acp-proxy failure/);
        assert.match(text, /upstream request failed/);
        assert.equal(relay.streamingCalls(), 3, "exactly BILI_REPLAY_RETRY_MAX attempts, no unbounded storm");
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});

test("#1688 e2e: an upstream 4xx verdict passes through verbatim without any replay", async () => {
    const relay = makeRelay({ failFirstStreamingWith: 400 });
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = relay.server.address().port;
    const { proxy, port } = await startProxy(upstreamPort);

    try {
        const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "retry-sess-3" },
            body: chatBody(),
        });
        assert.equal(r.status, 400, "the upstream verdict is not masked by a proxy-side error");
        const text = await r.text();
        assert.match(text, /model does not exist/);
        assert.equal(relay.streamingCalls(), 1);
    } finally {
        proxy.close();
        await once(proxy, "close");
        relay.server.close();
        await once(relay.server, "close");
    }
});
