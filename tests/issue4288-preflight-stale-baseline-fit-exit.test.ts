import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #4288: mid-session switch to a SMALLER-window model wedged the session. The
// stale usage baseline (session.lastInputTokens) was measured under the PRIOR
// wider-window model and sits above the new window, so the preflight TRIGGER
// fires on that baseline alone even though the actual payload FITS the new
// window. Inside preflight the round-boundary exit judged on `decisionTokens`,
// which is FLOORED by that same stale baseline — so `decisionTokens <
// textTarget` never trips and the loop burns the whole slow summarization
// ladder on an already-fitting payload; the client times out mid-ladder and
// the session appears stuck.
//
// Fix: the round-boundary exit judges on the payload's OWN floorless estimate
// (result.payloadEstimate) — the same quantity the caller's forward gate
// trusts (#1839/#1492). When the payload fits, preflight must stop IMMEDIATELY
// (zero summarization calls) and forward, instead of folding.
//
// Scenario (mirrors tests/preflight-compress.test.ts #247, inverted):
//   1. Request 1 on claude-big (400k window) creates the session; we then pin
//      its usage baseline to 300k (source "usage") — the value a PRIOR
//      wide-window model left behind, i.e. the #4288 precondition.
//   2. Request 2 switches to claude-small (SMALL_WINDOW) carrying an ~18k-token
//      conversation that FITS the window, yet the stale 300k baseline still
//      trips the trigger. Before the fix the ladder burned (2 summarization
//      calls); after the fix preflight exits at round 1 with ZERO summarization
//      calls and forwards a 200.

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session.";

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

// #4288 calibration: bigConversation() below is ~18k tokens, so it fits 40k
// with margin while staying far below the pinned 300k stale usage baseline.
const SMALL_WINDOW = 40_000;

test("e2e #4288: model switch to a smaller window whose payload FITS → preflight exits with zero summarization (no ladder)", async () => {
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
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse(streamCalls === 1 ? 300_000 : 1000));
            } else {
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
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-big": { context: 400_000 }, "claude-small": { context: SMALL_WINDOW } } } },
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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const headers = { "content-type": "application/json", "x-acp-session": "issue4288-sess" };

        // --- Request 1: big model creates the session ---
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
        // Simulate the #4288 precondition directly: the session carries a usage
        // baseline (300k) measured under the PRIOR wide-window model. We set it
        // explicitly rather than relying on request 1's SSE usage report, because
        // the point under test is the preflight round-EXIT given a stale-high
        // baseline + a fitting payload — the baseline-establishment path is
        // orthogonal (and covered by other suites).
        s1.stats.lastInputTokens = 300_000;
        s1.stats.lastInputTokensSource = "usage";

        // --- Request 2: switch to the SMALL_WINDOW model with the ~18k conversation ---
        // The payload fits the window, but the stale 300k baseline still trips
        // the trigger. The fix must make preflight exit at round 1 with ZERO
        // summarization calls and forward a 200 (before the fix the ladder ran).
        const r2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages: bigConversation() }),
        });
        assert.equal(r2.status, 200, "the switched-model request succeeds (no context-full error, no mid-ladder abort)");
        await r2.text();

        const summaryCalls = calls.filter((c) => !c.stream);
        assert.equal(summaryCalls.length, 0, `payload fits the new window — preflight must NOT burn the summarization ladder (got ${summaryCalls.length} call(s); #4288)`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("unit #4288 band: payload above the fold target but below the window + 429 → attempts, fails, still forwardable", async () => {
    // Companion to the e2e above: #4288 must NOT fold payloads that fit the
    // window, but payloads BETWEEN the fold target and the hard window (an
    // explicit compressionTarget below the window) still fold — and when their
    // summarization call 429s, the fail-fast forward gate must see
    // fitsWindow=true (forward, never a false-positive withhold — the #301
    // contract preserved under the narrowed exit).
    // Space discipline (round-2 review F1): the exit compares TEXT to TEXT —
    // roundText vs textTarget (already reserve-carved). With limit 20K,
    // imageReserve 5K, compressionTarget 12K → textTarget 7K; the ~10.5K text
    // payload is above the target (attempt) while its total ~15.5K estimate
    // still fits the window (forwardable).
    const { preflightCompress } = await import("../src/preflight.ts");
    const { createCore, defaultPrompts } = await import("acp-kernel");
    type CoreMessage = import("acp-kernel").CoreMessage;
    const { getSession } = await import("../src/session.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const registry = await import("../src/registry.ts");
    _setStoreForTest(new SessionStore({ enabled: false }));
    registry._resetForTest();

    let summaryCalls = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            summaryCalls++;
            res.writeHead(429, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const { port } = upstream.address() as { port: number };

    const session = getSession(`issue4288-band-${Math.random().toString(36).slice(2)}`);
    const config = defaultConfig(20_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    session.stats.lastInputTokens = 300_000;
    session.stats.lastInputTokensSource = "usage";
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(7000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    try {
        const result = await preflightCompress(
            {
                core: createCore(), session, config, prompts: defaultPrompts, protocol: "openai",
                url: `http://127.0.0.1:${port}/v1/messages`, headers: {}, model: "test-model",
                imageReserve: 5000, compressionTarget: 12_000,
                log: () => { /* quiet */ },
            },
            messages,
        );
        assert.ok(summaryCalls >= 1, `payload above the fold target still folds (calls: ${summaryCalls})`);
        assert.ok(result.failure !== undefined, "the 429 surfaces as a preflight failure");
        assert.equal(result.fitsWindow, true, "#301: an under-window payload stays forwardable despite the 429");
    } finally {
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("unit #4288 image lane: reserve must not carve the exit twice — fitting payload forwards with zero summarization calls", async () => {
    // Round-2 review F1 pin: the exit compares roundText (text-space) against
    // textTarget (already imageReserve-carved). A total-to-text comparison
    // (payloadEstimate < textTarget) subtracts the reserve TWICE and misses the
    // exit on image lanes, resurrecting the ladder-burn #4288 fixed. Here the
    // ~10.5K text + 5K reserve payload (total ~15.5K) fits the 20K window and
    // sits BELOW the 15K text target → zero summarization calls, forward.
    const { preflightCompress } = await import("../src/preflight.ts");
    const { createCore, defaultPrompts } = await import("acp-kernel");
    type CoreMessage = import("acp-kernel").CoreMessage;
    const { getSession } = await import("../src/session.ts");
    const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
    const registry = await import("../src/registry.ts");
    _setStoreForTest(new SessionStore({ enabled: false }));
    registry._resetForTest();

    let summaryCalls = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            summaryCalls++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { content: "summary text long enough to pass the apply gate at fifty chars." } }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const { port } = upstream.address() as { port: number };

    const session = getSession(`issue4288-img-${Math.random().toString(36).slice(2)}`);
    const config = defaultConfig(20_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 });
    session.stats.lastInputTokens = 300_000;
    session.stats.lastInputTokensSource = "usage";
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(7000) },
        { id: "last", role: "user", contentType: "text", text: "Continue the task." },
    ];
    try {
        const result = await preflightCompress(
            {
                core: createCore(), session, config, prompts: defaultPrompts, protocol: "openai",
                url: `http://127.0.0.1:${port}/v1/messages`, headers: {}, model: "test-model",
                imageReserve: 5000,
                log: () => { /* quiet */ },
            },
            messages,
        );
        assert.equal(summaryCalls, 0, `fitting payload with image reserve must not fold (calls: ${summaryCalls})`);
        assert.equal(result.compressedRanges ?? 0 > 0 ? 1 : 0, 0, "no ranges compressed");
        assert.equal(result.fitsWindow, true, "the payload is window-fitting and forwardable");
    } finally {
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
