import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on the very first 429 instead of the default 3 attempts with
// exponential backoff — these tests are about the post-retry behavior.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #301: when preflight (overflow) compression cannot proceed because the
// SUMMARY UPSTREAM failed (rate-limiting, error) — a transient state — the
// proxy must FAIL FAST with a structured error instead of forwarding the
// over-window payload as-is (guaranteed upstream 400, wasted quota, client
// retry storms; log evidence in #292).
// #333: when preflight cannot proceed because NOTHING IS LEFT TO FOLD (no
// compressible ranges — a static state no retry can change), failing fast is
// a permanent 502 loop: the client retries into the same wall forever and the
// EMERGENCY nudge can never reach the model. The proxy must forward the
// over-window payload as-is instead: the upstream either accepts (its real
// window is larger than bili's limit) or rejects with a truthful 400 the
// client can act on (and the overflow self-heal learns the real window).
// Forwarding as-is also stays legal when the payload's own estimate actually
// fits the window (the trigger floors on stats.lastInputTokens, which can be
// stale — #300 double-counted usage).

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        const filler = `MARKER_${i}_content_`.repeat(250);
        msgs.push({ role, content: `Message ${i} of the long conversation. ${filler}` });
    }
    return msgs;
}

type Call = { stream: boolean; body: string };

function makeUpstream429(calls?: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls?.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                res.writeHead(429, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
            }
        });
    });
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
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
    } as ProxyOptions);
}

test("e2e #301: overflow + summary upstream 429 → structured 503, over-window payload NOT forwarded", async () => {
    const calls: Call[] = [];
    // The preflight summarization call hits the same rate-limited upstream as
    // the main request (the #292 scenario).
    const upstream = makeUpstream429(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        // Fresh session: a ~13k-token history against a 10k window — the
        // payload itself overflows, preflight fires, its summarization call
        // 429s. The proxy must fail fast, NOT forward the over-window body.
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-429-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        });
        assert.equal(r.status, 503, "fail-fast 503 when the summary upstream rate-limits");
        const json = JSON.parse(await r.text()) as { error?: { type?: string; code?: string; message?: string; retryable?: boolean } };
        assert.equal(json.error?.type, "server_error");
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, true);
        assert.ok(json.error?.message?.includes("429"), `message names the cause (got: ${json.error?.message})`);
        assert.ok(json.error?.message?.includes("NOT forwarded"), `message states the payload was withheld (got: ${json.error?.message})`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded upstream");
        assert.ok(calls.filter((c) => !c.stream).length >= 1, "preflight attempted the (429'd) summarization call");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e #301: payload fits the window + preflight 429 → request still forwarded (no false positive)", async () => {
    const calls: Call[] = [];
    let streamCalls = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                streamCalls += 1;
                // The first forward (big model) reports a 300k-token context
                // — a stale floor for the later small-model request.
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(streamCalls === 1 ? 300_000 : 1000));
            } else {
                res.writeHead(429, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, {
        "claude-big": { context: 400_000 },
        "claude-small": { context: 20_000 },
    });
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const headers = { "content-type": "application/json", "x-acp-session": "preflight-fits-429-sess" };

        const r1 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-big", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // The ~13k-token conversation FITS the 20k window, but the trigger
        // fires on the stale 300k floor: preflight runs, its summarization
        // call 429s — and the proxy must STILL forward the fitting payload.
        const r2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        });
        assert.equal(r2.status, 200, "a fitting payload is forwarded even when preflight 429s");
        await r2.text();

        assert.ok(calls.filter((c) => !c.stream).length >= 1, "preflight did attempt the (429'd) summarization call");
        assert.equal(calls.filter((c) => c.stream).length, 2, "both requests were forwarded upstream");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e #333: over-window payload with nothing compressible → forwarded as-is (no 502 livelock)", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream429(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        // A single ~12k-token message against a 10k window: over-window, but
        // the kernel never folds the lone (last) user message → no
        // compressible ranges → preflight cannot proceed at all. #333: this
        // is a STATIC state — failing fast here was a permanent 502 loop
        // (every client retry hit the same wall). The proxy must forward the
        // payload as-is and let the upstream decide.
        const filler = "FILLER_".repeat(7000);
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-exhausted-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: [{ role: "user", content: filler }] }),
        });
        assert.equal(r.status, 200, "#333: exhausted preflight forwards instead of looping on 502");
        await r.text();
        assert.equal(calls.filter((c) => !c.stream).length, 0, "no summarization call was spent on an incompressible payload");
        assert.equal(calls.filter((c) => c.stream).length, 1, "the over-window payload WAS forwarded upstream");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e #333: over-window payload with nothing compressible → upstream 400 passed through + window self-heal", async () => {
    const calls: Call[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            calls.push({ stream: true, body: raw });
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "This model's maximum context length is 8000 tokens", type: "invalid_request_error", code: "context_length_exceeded" } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        // Same static state as above, but the upstream's REAL window is
        // smaller than bili's configured one: the forwarded over-window
        // payload is rejected. The client must see the upstream's truthful
        // 400 (not a bili 502), and the overflow self-heal must learn the
        // real window for the next turn.
        const filler = "FILLER_".repeat(7000);
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-400-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: [{ role: "user", content: filler }] }),
        });
        assert.equal(r.status, 400, "the upstream's truthful 400 is passed through to the client");
        const text = await r.text();
        assert.ok(text.includes("maximum context length"), `client sees the upstream error (got: ${text})`);
        assert.equal(calls.length, 1, "the over-window payload was forwarded upstream exactly once");

        const sess = listSessions().find((s) => s.id === "preflight-400-sess");
        assert.ok(sess, "session exists");
        const learned = sess?.metadata.learnedContextLimits as Record<string, number> | undefined;
        assert.equal(learned?.["claude-small"], 8000, "self-heal learned the real window from the 400");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
