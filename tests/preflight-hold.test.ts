import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on the very first 429 instead of the default 3 attempts with
// exponential backoff — the fail-fast tests below want the error immediately.
process.env.BILI_REPLAY_RETRY_MAX = "1";
// Shrink the preflight hold grace so a 1.5s-slow summarization call reliably
// outlives it (default is 30s — too slow for a test).
process.env.BILI_PREFLIGHT_HOLD_MS = "300";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #568: preflight compression previously sent ZERO bytes until it finished —
// clients with undici's default 300s headersTimeout aborted mid-compression,
// the proxy logged "summarization aborted: client disconnected" and never
// forwarded: a repeating 5-minute death loop. When preflight outlives the
// hold grace (BILI_PREFLIGHT_HOLD_MS, default 30s) the proxy must commit the
// response early (stream: 200 + SSE comment keep-alives; non-stream: 200 +
// whitespace) so the client's header timeout can never fire. Late failures
// then arrive in-band (protocol error event / JSON body) instead of as a
// status code that can no longer change.

const SLOW_MS = 1500;

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. " +
    "Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. " +
    "Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

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

type Call = { raw: string };

type TimedResponse = {
    status: number;
    headers: http.IncomingHttpHeaders;
    /** ms from request start to response headers */
    tHeaderMs: number;
    /** ms from request start to response end */
    tEndMs: number;
    body: string;
};

function timedPost(url: string, headers: Record<string, string>, body: string): Promise<TimedResponse> {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const req = http.request(url, { method: "POST", headers }, (res) => {
            const tHeaderMs = Date.now() - t0;
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => {
                resolve({
                    status: res.statusCode ?? 0,
                    headers: res.headers,
                    tHeaderMs,
                    tEndMs: Date.now() - t0,
                    body: Buffer.concat(chunks).toString("utf8"),
                });
            });
        });
        req.on("error", reject);
        req.end(body);
    });
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>, limit: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: limit,
        kernelConfig: defaultConfig(limit),
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

test("#568: stream + slow preflight → early 200 + SSE keep-alive, then the real stream", async () => {
    const calls: Call[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                // Slow summarization call — outlives the 300ms hold grace.
                setTimeout(() => {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        id: "msg_summary",
                        type: "message",
                        role: "assistant",
                        model: "claude-small",
                        content: [{ type: "text", text: SUMMARY_TEXT }],
                        stop_reason: "end_turn",
                        usage: { input_tokens: 500, output_tokens: 50 },
                    }));
                }, SLOW_MS);
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } }, 400_000);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        // Fresh session, ~13k-token history vs 10k window → preflight fires
        // and its summarization call takes 1.5s ≫ the 300ms grace.
        const r = await timedPost(
            `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
            { "content-type": "application/json", "x-acp-session": "hold-stream-ok-sess" },
            JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        );
        assert.equal(r.status, 200);
        assert.equal(String(r.headers["content-type"]), "text/event-stream");
        assert.equal(r.headers["x-bili-preflight"], "compressing", "early commit is marked for observability");
        assert.ok(r.tHeaderMs < SLOW_MS, `headers arrived before summarization finished (${r.tHeaderMs}ms)`);
        assert.ok(r.tEndMs >= SLOW_MS, `the response waited for the slow preflight (${r.tEndMs}ms) — the hold did real work`);
        assert.ok(r.body.includes(": bili-preflight"), "an SSE comment keep-alive was sent while compressing");
        assert.ok(r.body.includes('"text_delta"'), "the real stream content follows the keep-alive");
        assert.ok(r.body.includes("message_stop"), "the stream completed");

        const forwards = calls.filter((c) => c.raw.includes('"stream":true'));
        assert.equal(forwards.length, 1, "exactly one forward upstream");
        const fwd = forwards[0]!.raw;
        assert.ok(fwd.includes(SUMMARY_TEXT), "the rebuilt payload carries the preflight summary");
        assert.ok(!fwd.includes("MARKER_1_"), "compressed messages are out of the payload");
        assert.ok(fwd.includes("MARKER_11_"), "recent protected messages remain in the payload");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("#568: stream + slow preflight 429 → early-committed 200 carries the error in-band, nothing forwarded", async () => {
    const calls: Call[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
            } else {
                // Slow rate-limited summarization call (#292 scenario, slow edition).
                setTimeout(() => {
                    res.writeHead(429, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
                }, SLOW_MS);
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 10_000 } }, 400_000);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const r = await timedPost(
            `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
            { "content-type": "application/json", "x-acp-session": "hold-stream-429-sess" },
            JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        );
        // The hold already committed 200 before the 429 landed — the client
        // gets the structured error IN-BAND instead of a hang/abort.
        assert.equal(r.status, 200, "status was committed early and cannot become 503 anymore");
        assert.equal(r.headers["x-bili-preflight"], "compressing");
        assert.ok(r.body.includes("event: error"), "SSE error event delivered in-band");
        assert.ok(r.body.includes("preflight_compress_failed"), "structured error code preserved in-band");
        assert.ok(r.body.includes("rate limited") || r.body.includes("429"), "the cause is named");
        assert.equal(calls.filter((c) => c.raw.includes('"stream":true')).length, 0, "the over-window payload was NOT forwarded");
        assert.ok(calls.filter((c) => !c.raw.includes('"stream":true')).length >= 1, "the (slow, 429'd) summarization call happened");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("#568: Responses protocol + slow preflight 429 → early-committed 200, in-band error event", async () => {
    const calls: Call[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ raw });
            if (parsed.stream === false) {
                setTimeout(() => {
                    res.writeHead(429, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
                }, SLOW_MS);
            } else {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.end(`event: response.completed\ndata: ${JSON.stringify({ response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: 1000, output_tokens: 5, total_tokens: 1005 } } })}\n\n`);
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "gpt-resp": { context: 10_000 } }, 10_000);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const input = bigConversation().map((m) => ({ type: "message", role: m.role, content: m.content }));
        const r = await timedPost(
            `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`,
            { "content-type": "application/json", "x-acp-session": "hold-resp-429-sess" },
            JSON.stringify({ model: "gpt-resp", stream: true, session_id: "hold-resp-429-sess", instructions: "You are the test coding agent.", input }),
        );
        assert.equal(r.status, 200, "status was committed early and cannot become 503 anymore");
        assert.ok(r.body.includes("event: error"), "Responses-API error event delivered in-band");
        assert.ok(r.body.includes("preflight_compress_failed"), "structured error code preserved in-band");
        assert.equal(calls.filter((c) => !c.raw.includes('"stream":false')).length, 0, "nothing was forwarded");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("#568: non-stream + slow preflight → early 200 + whitespace keep-alive, then valid JSON", async () => {
    const calls: Call[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; messages?: Array<{ role?: string }> } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ raw });
            // #987: detect summarization calls by SHAPE (exactly two messages,
            // system first), not by the 32768 cap — the cap is now clamped to
            // the window headroom on small windows, so it no longer identifies
            // them. The main request is a 12-message user/assistant conversation.
            const msgs = parsed.messages;
            if (Array.isArray(msgs) && msgs.length === 2 && msgs[0]?.role === "system") {
                setTimeout(() => {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY_TEXT } }] }));
                }, SLOW_MS);
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "chatcmpl-hold",
                    object: "chat.completion",
                    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 1000, completion_tokens: 3, total_tokens: 1003 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    const proxy = await startProxy(upstreamPort, { "gpt-small": { context: 10_000 } }, 400_000);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const r = await timedPost(
            `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
            { "content-type": "application/json", "x-acp-session": "hold-json-ok-sess" },
            JSON.stringify({ model: "gpt-small", max_tokens: 1024, messages: bigConversation() }),
        );
        assert.equal(r.status, 200);
        assert.equal(String(r.headers["content-type"]), "application/json");
        assert.equal(r.headers["x-bili-preflight"], "compressing");
        assert.ok(r.tHeaderMs < SLOW_MS, `headers arrived before summarization finished (${r.tHeaderMs}ms)`);
        assert.ok(r.tEndMs >= SLOW_MS, `the response waited for the slow preflight (${r.tEndMs}ms)`);
        assert.ok(r.body.startsWith(" "), "whitespace keep-alive precedes the JSON body");
        const json = JSON.parse(r.body) as { choices?: Array<{ message?: { content?: string } }> };
        assert.equal(json.choices?.[0]?.message?.content, "ok", "the JSON body stays parseable despite the padding byte");

        const forwards = calls.filter((c) => {
            let p: { messages?: Array<{ role?: string }> } = {};
            try { p = JSON.parse(c.raw); } catch { /* non-JSON never matches */ }
            return !(Array.isArray(p.messages) && p.messages.length === 2 && p.messages[0]?.role === "system");
        });
        assert.equal(forwards.length, 1, "exactly one forward upstream");
        assert.ok(forwards[0]!.raw.includes(SUMMARY_TEXT), "the rebuilt payload carries the preflight summary");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
