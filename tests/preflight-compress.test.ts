import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #247: mid-session model switch from a 1M-context model to a 260k one.
// The session's real context (previous turn's upstream input_tokens) exceeds
// the new model's window, so the payload overflows at forward time and the
// reactive nudge can never fire (the request itself is rejected before the
// model sees it) — the session is stuck. The proxy must proactively compress
// the oldest compressible ranges BEFORE forwarding (dedicated summarization
// calls sized to fit the smaller window), then rebuild and forward a payload
// that fits.
//
// Scenario:
//   1. Request 1 on claude-big (400k window), upstream reports
//      input_tokens=300000 → session.lastInputTokens = 300000.
//   2. Request 2 on claude-small (260k window) with a 12-message
//      conversation. 300000 >= 260000 → preflight fires: the oldest
//      compressible ranges are summarized (non-streaming JSON calls to the
//      upstream) and folded into blocks; the rebuilt payload (recent
//      protected messages + summaries) is forwarded and gets a 200.

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

test("e2e: model switch to a smaller window → preflight compresses before forward", async () => {
    const calls: Array<{ stream: boolean; body: string }> = [];
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
                // The real forward: normal 200 SSE. The first forward (big
                // model) reports a 300k-token context; later ones (small
                // model, post-preflight) report 1000.
                streamCalls += 1;
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(streamCalls === 1 ? 300_000 : 1000));
            } else {
                // A preflight summarization call: non-streaming JSON message.
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
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-big": { context: 400_000 }, "claude-small": { context: 260_000 } } } },
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
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const headers = { "content-type": "application/json", "x-acp-session": "preflight-sess" };

        // --- Request 1: big model, upstream reports a 300k-token context ---
        const r1 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-big", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const sessions = listSessions();
        assert.equal(sessions.length, 1, "exactly one session after request 1");
        const s1 = sessions[0]!;
        assert.equal(s1.stats.lastInputTokens, 300_000, "session context is 300k tokens");
        assert.equal(calls.filter((c) => !c.stream).length, 0, "no summarization on the first request");

        // --- Request 2: switch to the 260k model with a long conversation ---
        const r2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        });
        assert.equal(r2.status, 200, "the switched-model request succeeds (no context-full error)");
        await r2.text();

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= 1, `preflight made summarization call(s) before forwarding (got ${summaryCalls.length})`);
        for (const c of summaryCalls) {
            assert.ok(c.body.includes("Compression") || c.body.includes("compress"), "summarization call carries the compression rules");
        }

        const s2 = listSessions().find((x) => x.id === s1.id);
        const activeBlocks = (s2?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 1, `preflight created compression block(s) (got ${activeBlocks.length})`);
        assert.ok(activeBlocks.every((b) => b.summary === SUMMARY_TEXT), "blocks hold the upstream-written summaries");

        // The forwarded payload is the rebuilt one: oldest messages folded
        // into summaries, recent protected messages intact. (MARKER_0_ is the
        // FIRST user message — the kernel's prune always preserves it, so it
        // is the only original that may remain.)
        const forwards = calls.filter((c) => c.stream);
        const lastForward = forwards[forwards.length - 1];
        assert.ok(lastForward, "a forward happened");
        assert.ok(!lastForward.body.includes("MARKER_1_"), "compressed messages are out of the payload");
        assert.ok(!lastForward.body.includes("MARKER_4_"), "compressed messages are out of the payload");
        assert.ok(!lastForward.body.includes("MARKER_6_"), "compressed messages are out of the payload");
        assert.ok(lastForward.body.includes("MARKER_11_"), "recent protected messages remain in the payload");
        assert.ok(lastForward.body.includes(SUMMARY_TEXT), "the preflight summary is in the rebuilt payload");

        // The successful turn's usage report overwrote the 300k figure.
        assert.equal(s2?.stats.lastInputTokens, 1000);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e: no preflight when the context fits the (small) model window", async () => {
    const calls: Array<{ stream: boolean }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(50_000));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary", type: "message", role: "assistant", model: "claude-small",
                    content: [{ type: "text", text: SUMMARY_TEXT }], stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-big": { context: 400_000 }, "claude-small": { context: 260_000 } } } },
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
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const headers = { "content-type": "application/json", "x-acp-session": "preflight-fits-sess" };
        const r1 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-big", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hello" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // 50k < 260k window → switching models must NOT trigger preflight.
        const r2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        });
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(calls.filter((c) => !c.stream).length, 0, "no summarization calls when the context fits");
        const s = listSessions()[0];
        assert.equal((s?.state.blocks ?? []).filter((b) => b.active).length, 0, "no blocks created");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
