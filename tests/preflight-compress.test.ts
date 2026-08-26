import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, defaultCountTokens } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #247: mid-session model switch to a smaller-window model. The trigger and
// the fit check run on the REAL post-fold payload size (max of the session's
// lastInputTokens and the current payload estimate), so preflight fires both
// for a stable session whose measured context exceeds the new window AND for
// a fresh session (id rotated by the switch) whose lastInputTokens is 0 but
// whose raw history overflows. Without it the payload overflows at forward
// time and the reactive nudge can never fire (the request itself is rejected
// before the model sees it) — the session is stuck. The proxy must
// proactively compress the oldest compressible ranges BEFORE forwarding
// (dedicated summarization calls sized to fit the smaller window), then
// rebuild and forward a payload that fits.
//
// Scenario:
//   1. Request 1 on claude-big (400k window), upstream reports
//      input_tokens=300000 → session.lastInputTokens = 300000.
//   2. Request 2 on claude-small (10k window) with a ~13k-token
//      conversation: the payload itself overflows → preflight fires: the
//      oldest compressible ranges are summarized (non-streaming JSON calls
//      to the upstream) and folded into blocks; the rebuilt payload (recent
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-big": { context: 400_000 }, "claude-small": { context: 10_000 } } } },
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
        // FIRST user message — the kernel's prune always preserves it; the
        // exact fold boundary depends on the kernel's range partitioning, so
        // only the oldest and newest markers are asserted.)
        const forwards = calls.filter((c) => c.stream);
        const lastForward = forwards[forwards.length - 1];
        assert.ok(lastForward, "a forward happened");
        assert.ok(!lastForward.body.includes("MARKER_1_"), "compressed messages are out of the payload");
        assert.ok(lastForward.body.includes("MARKER_7_"), "recent messages remain in the payload");
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

test("e2e: fresh session (lastInputTokens=0) whose raw history overflows the window → preflight compresses", async () => {
    const calls: Array<{ stream: boolean; body: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(1000));
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-small": { context: 10_000 } } } },
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
        // No prior request: the session is brand new (lastInputTokens = 0),
        // e.g. after a model switch rotated the session id and the client
        // resends its full raw history. The ~13k-token history overflows the
        // 10k window on the very first request — preflight must still fire
        // (payload-size trigger, not lastInputTokens).
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "preflight-fresh-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        });
        assert.equal(r.status, 200, "the fresh-session request succeeds (no context-full error)");
        await r.text();

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= 1, `preflight made summarization call(s) before forwarding (got ${summaryCalls.length})`);
        for (const c of summaryCalls) {
            assert.ok(c.body.includes("Compression") || c.body.includes("compress"), "summarization call carries the compression rules");
        }

        const s = listSessions()[0];
        const activeBlocks = (s?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 1, `preflight created compression block(s) (got ${activeBlocks.length})`);
        assert.ok(activeBlocks.every((b) => b.summary === SUMMARY_TEXT), "blocks hold the upstream-written summaries");

        const forwards = calls.filter((c) => c.stream);
        const lastForward = forwards[forwards.length - 1];
        assert.ok(lastForward, "a forward happened");
        assert.ok(!lastForward.body.includes("MARKER_1_"), "compressed messages are out of the payload");
        assert.ok(lastForward.body.includes("MARKER_7_"), "recent messages remain in the payload");
        assert.ok(lastForward.body.includes("MARKER_11_"), "recent protected messages remain in the payload");
        assert.ok(lastForward.body.includes(SUMMARY_TEXT), "the preflight summary is in the rebuilt payload");

        // The session's input baseline is corrected from 0 to the real
        // (small) post-fold size via the usage report — the next turn is not
        // stuck on a stale figure.
        assert.equal(s?.stats.lastInputTokens, 1000);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

// CJK regression: a Chinese conversation is ~1 token/char, but the fast
// chars/4 estimator sees ~4× fewer tokens. The trigger still fires (it floors
// on the session's measured lastInputTokens), so the gap is in the loop's fit
// check: with the undercount it believes the payload already fits and stops
// without compressing → the oversized payload is forwarded → upstream 400.
// The mock upstream ENFORCES the model window like a real provider (counts
// input tokens with the CJK-aware defaultCountTokens, rejects over-window).
// This test asserts the FIXED behavior (preflight compresses, the rebuilt
// payload fits, 200) — it is RED on the chars/4 estimator.
test("e2e: CJK stable session switch → preflight compresses (CJK-aware token accounting)", async () => {
    const WINDOW = 20_000;
    const calls: Array<{ stream: boolean; body: string }> = [];
    let streamCalls = 0;

    function bodyContentTokens(raw: string): number {
        let parsed: { messages?: Array<{ content?: unknown }> } = {};
        try { parsed = JSON.parse(raw); } catch { return 0; }
        let total = 0;
        for (const m of parsed.messages ?? []) {
            let text = "";
            if (typeof m.content === "string") text = m.content;
            else if (Array.isArray(m.content)) {
                text = (m.content as Array<{ text?: string }>).map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
            }
            total += defaultCountTokens(text);
        }
        return total;
    }

    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (parsed.stream) {
                // Real forward: enforce the model window like a real provider.
                const tok = bodyContentTokens(raw);
                if (tok > WINDOW) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        type: "error",
                        error: { type: "invalid_request_error", message: `prompt is too long: ${tok} tokens > ${WINDOW} maximum` },
                    }));
                    return;
                }
                streamCalls += 1;
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(streamCalls === 1 ? 30_000 : 1000));
            } else {
                // Preflight summarization call: non-streaming JSON message.
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
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-big": { context: 400_000 }, "claude-small": { context: WINDOW } } } },
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

    // 12 alternating messages, each ~2495 CJK chars (≈1 token/char) → ~30k
    // accurate tokens but only ~7.5k by the chars/4 estimator.
    const phrase = "上下文切换测试模型窗口大小";
    const filler = phrase.repeat(208).slice(0, 2495);
    const cjkConversation = (): Array<{ role: string; content: string }> => {
        const msgs: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 12; i++) {
            const role = i % 2 === 0 ? "user" : "assistant";
            msgs.push({ role, content: `M${i}_` + filler });
        }
        return msgs;
    };

    try {
        const headers = { "content-type": "application/json", "x-acp-session": "preflight-cjk-sess" };

        // --- Request 1: big model, upstream reports a 30k-token context ---
        const r1 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-big", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "你好" }] }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = listSessions()[0]!;
        assert.equal(s1.stats.lastInputTokens, 30_000, "session context is 30k tokens");

        // --- Request 2: switch to the 20k-window model with the CJK history ---
        const r2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: cjkConversation() }),
        });
        assert.equal(r2.status, 200, "the switched-model CJK request succeeds (no context-full error)");
        await r2.text();

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.ok(summaryCalls.length >= 1, `preflight made summarization call(s) before forwarding (got ${summaryCalls.length})`);

        const s2 = listSessions().find((x) => x.id === s1.id);
        const activeBlocks = (s2?.state.blocks ?? []).filter((b) => b.active);
        assert.ok(activeBlocks.length >= 1, `preflight created compression block(s) (got ${activeBlocks.length})`);

        // The rebuilt payload fits the window: the mock only returns 200 when
        // bodyContentTokens <= WINDOW, so a 200 already proves it fits. The
        // oldest CJK messages are folded out; the recent ones remain.
        const forwards = calls.filter((c) => c.stream);
        const lastForward = forwards[forwards.length - 1];
        assert.ok(lastForward, "a forward happened");
        assert.ok(!lastForward.body.includes("M1_"), "oldest compressed CJK message is out of the payload");
        assert.ok(lastForward.body.includes("M11_"), "recent CJK message remains in the payload");
        assert.ok(lastForward.body.includes(SUMMARY_TEXT), "the preflight summary is in the rebuilt payload");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
