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

// #987: the context window is a deployment property — owned by declarations
// (config / registry / runtime-info), NEVER adjusted from session traffic.
// An upstream overflow 400:
//   1. is passed through verbatim (no client-visible change);
//   2. arms the ONE-SHOT emergency shrink when (and only when) the upstream
//      STATED a window number — so the next turn's kernel sees tokenCount at
//      that window and can nudge/truncate;
//   3. persists NOTHING that could re-center the declared window. No
//      metadata.confirmedContextLimits, no upward self-heal, no retraction —
//      those learner stores were removed wholesale.
// Recovery from an oversized turn comes from the DECLARED window: when the
// declaration is correct, the armed value + preflight fold the next turn
// under it (T3). When the declaration is wrong, the fix is an operator
// declaration change — not session-time guessing.

const STATED_OVERFLOW_BODY = JSON.stringify({
    error: {
        code: "context_length_exceeded",
        message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 13000 tokens.",
    },
});

const STATED_OVERFLOW_BODY_128K = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" },
});

const NUMBERLESS_OVERFLOW_BODY = JSON.stringify({
    error: {
        code: "context_window_exceeded",
        message: "The model's context window was exceeded. Start a new thread or clear earlier history before retrying.",
    },
});

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

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

function summaryJson(): string {
    return JSON.stringify({
        id: "msg_summary",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: SUMMARY_TEXT }],
        stop_reason: "end_turn",
        usage: { input_tokens: 500, output_tokens: 50 },
    });
}

function bigConversation(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

function proxyBaseOptions(upstreamPort: number, window: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: window } } } },
        modelContextLimit: window,
        kernelConfig: defaultConfig(window),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

test("e2e #987/#1195 T1: a stated-window overflow arms the one-shot shrink, learns nothing, and (#1195) the turn is rescued in-request", async () => {
    let streamingCall = 0;
    let summaryCalls = 0;
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = {};
            }
            if (parsed.stream === false) {
                summaryCalls += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(summaryJson());
                return;
            }
            if (streamingCall === 0) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(STATED_OVERFLOW_BODY_128K);
            } else {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            }
            streamingCall += 1;
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstreamPort, 400_000));
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
        const headers = { "content-type": "application/json", "x-acp-session": "t1-sess" };

        // r1: the upstream 400 stating 128000 no longer reaches the client —
        // #1195: the arm fires, prepare+preflight re-run against the STATED
        // window (per-call override, nothing learned), the folded body is
        // re-sent within the same request, and the retry's 200 answers.
        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 200, "#1195: refolded and re-sent within the same request");
        assert.equal(r1.headers.get("content-type"), "text/event-stream", "the retry's SSE is what the client sees");
        await r1.text();
        const s = listSessions().find((x) => x.id === "t1-sess");
        assert.ok(s, "session exists");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "#987: nothing learned");
        assert.equal(s!.metadata.confirmedContextLimit, undefined, "#987: no legacy scalar either");
        assert.equal(s!.stats.lastInputTokens, 5000, "the retry's own usage report already replaced the armed baseline");
        assert.equal(s!.stats.lastInputTokensSource, "usage", "a window the upstream stated is usage-grade (#857)");
        assert.equal(s!.stats.overflowArmTokens, undefined, "#1129: the retry's usage report retired the one-shot arm — the emergency is over");

        // r2: same payload, declared window (400k) governs — the payload is
        // IN-window, so no further fold: forwarded verbatim, upstream 200.
        const r2 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(summaryCalls, 1, "exactly the one fold from r1's rescue — r2 itself does not fold");
        const lastForward = bodies[bodies.length - 1];
        assert.ok(lastForward.includes(SUMMARY_TEXT), "the fold is sticky — r2 forwards the compacted view, not the resent full history");
        assert.ok(lastForward.includes("MARKER_11_"), "the recent tail is preserved verbatim");
        assert.ok(!lastForward.includes("MARKER_1_"), "the already-folded early range stays folded");
        const s2 = listSessions().find((x) => x.id === "t1-sess");
        assert.equal(s2?.stats.lastInputTokens, 5000, "the successful turn's usage report overwrote the armed value");
        assert.equal(s2?.metadata.confirmedContextLimits, undefined, "still nothing learned after recovery");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e #987 T2: an overflow WITHOUT a window number arms at the declared window and learns nothing", async () => {
    let streamingCall = 0;
    let summaryCalls = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
                parsed = {};
            }
            if (parsed.stream === false) {
                summaryCalls += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(summaryJson());
                return;
            }
            if (streamingCall === 0) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(NUMBERLESS_OVERFLOW_BODY);
            } else {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            }
            streamingCall += 1;
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstreamPort, 400_000));
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
        const headers = { "content-type": "application/json", "x-acp-session": "t2-sess" };

        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 400);
        await r1.text();
        const s = listSessions().find((x) => x.id === "t2-sess");
        assert.ok(s, "session exists");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "nothing learned");
        assert.ok(s!.stats.lastInputTokens > 10_000 && s!.stats.lastInputTokens < 400_000, `armed at the payload's own size (~16k, not the 400k declaration): ${s!.stats.lastInputTokens}`);
        assert.equal(s!.stats.lastInputTokensSource, "usage", "a rejection the upstream itself issued is usage-grade");

        // r2: forwarded as-is (no arm, nothing learned) — the pass-through
        // shape the old #969 test asserted is unchanged.
        const r2 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(summaryCalls, 0, "no fold");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("e2e #987 T3: with a CORRECT declared window, an oversized turn still recovers — stated 400 arms, the next turn preflight-folds under the declared window", async () => {
    let streamingCall = 0;
    let summaryCalls = 0;
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = {};
            }
            if (parsed.stream === false) {
                summaryCalls += 1;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(summaryJson());
                return;
            }
            if (streamingCall === 0) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(STATED_OVERFLOW_BODY);
            } else {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            }
            streamingCall += 1;
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    // The operator declares the TRUE window (8192) — recovery works purely
    // through the declared window + the one-shot arm. No learning required.
    const proxy = await startServer(proxyBaseOptions(upstreamPort, 8192));
    await once(proxy, "listening");
    const proxyPort = proxy.address().port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
        const headers = { "content-type": "application/json", "x-acp-session": "t3-sess" };

        // r1: 13000-token payload vs the declared 8192 — preflight should fold
        // BEFORE the upstream is hit... except the arm comes from this 400. In
        // the #987 world the first oversized turn is rejected verbatim (the
        // proxy cannot guess a window), which arms the shrink.
        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 400);
        await r1.text();
        const s = listSessions().find((x) => x.id === "t3-sess");
        assert.ok(s, "session exists");
        assert.equal(s!.stats.lastInputTokens, 8192, "armed at the stated window");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "nothing learned");

        // r2: the payload (~13k) exceeds the DECLARED window (8192) — preflight
        // folds it under the window and forwards the summary-carrying body.
        const r2 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r2.status, 200, "second request recovers via preflight fold under the declared window");
        await r2.text();
        assert.ok(summaryCalls >= 1, "preflight ran a compress summary call");
        const lastForward = bodies[bodies.length - 1];
        assert.ok(lastForward.includes(SUMMARY_TEXT), "the forwarded body carries the fold summary");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
