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

// #3450: an upstream-stated overflow body carries more than its window — the
// rejected payload's OWN counts ("N in the messages, K in the completion").
// The old code booked the WINDOW as the armed baseline and threw the counts
// away, so preflight saw "payload ~window, deficit 0" on an underestimating
// local meter and forwarded a payload the upstream then billed over the wall
// (messages AND completion against 1048576) — killing the turn. Now:
//   1. the measured message count is what gets armed (a ceiling is not a size);
//   2. the proven completion share is reserved off the wall for fit judgments;
//   3. prepare/nudge and preflight judge on ONE wall per request (min of
//      declared and upstream-stated);
//   4. when declaration ≠ stated, a one-time warning names both values.

const DEEPSEEK_OVERFLOW_BODY = JSON.stringify({
    error: {
        code: "context_length_exceeded",
        message:
            "This model's maximum context length is 1048576 tokens. However, you requested 1160518 tokens (904518 in the messages, 256000 in the completion). Please reduce the length of the inputs or output.",
    },
});

// A small-window variant where the fold CAN close the gap within the request:
// stated 30000, rejected payload 35000 = 28000 messages + 7000 completion →
// message budget 23000.
const SMALL_WINDOW_OVERFLOW_BODY = JSON.stringify({
    error: {
        code: "context_length_exceeded",
        message: "This model's maximum context length is 30000 tokens. However, you requested 35000 tokens (28000 in the messages, 7000 in the completion). Please reduce the length of the inputs or output.",
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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

test("e2e #3450 T1: stated counts arm at the MEASURED size, reserve the completion share, warn once on mismatch — and the uncloseable gap fails honestly (no silent over-forward)", async () => {
    // Declared 1M (the dsh-native shape: host declares its own window, sitting
    // at the ceiling with no margin). Upstream proves: wall 1048576, rejected
    // payload 904518 messages + 256000 completion. The local conversation is
    // only ~16k tokens — folding it cannot close a 904k-measured gap, so the
    // turn must end in a visible 400, NOT a "fitsWindow=true" forward that
    // dies upstream.
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
                res.writeHead(200, { "content-type": "application/json" });
                res.end(summaryJson());
                return;
            }
            res.writeHead(400, { "content-type": "application/json" });
            res.end(DEEPSEEK_OVERFLOW_BODY);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstreamPort, 1_000_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
        const headers = { "content-type": "application/json", "x-acp-session": "t3450-arm-sess" };

        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 400, "the measured gap is uncloseable locally — the rejection surfaces, it is not masked by an over-window forward");
        await r1.text();
        const s = listSessions().find((x) => x.id === "t3450-arm-sess");
        assert.ok(s, "session exists");
        // 1. armed baseline = the upstream-stated MESSAGE count, not the window.
        assert.ok(s!.stats.lastInputTokens < 904_518, `armed below the stated 904518 (folds netted out): ${s!.stats.lastInputTokens}`);
        assert.ok(s!.stats.lastInputTokens > 800_000, `armed near the stated 904518, not the 1M declaration: ${s!.stats.lastInputTokens}`);
        assert.equal(s!.stats.lastInputTokensSource, "overflow-arm");
        // 2. the completion share is reserved off the wall while the arm lives.
        assert.equal(s!.stats.overflowArmCompletionReserve, 256_000);
        // 3. the side-request guard keeps the CEILING even though the baseline
        // books the measurement.
        assert.equal(s!.stats.overflowArmTokens, 1_048_576);
        // 4. declaration (1M) ≠ stated (1048576) → one-time mismatch warning flag.
        assert.equal(s!.stats.overflowArmMismatchWarned, true);
        // nothing learned into the declared window (#987 contract unchanged).
        assert.equal(s!.metadata.confirmedContextLimits, undefined);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});

test("e2e #3450 T2: with a small stated window the same counts rescue the turn IN-REQUEST and the reservation retires with the arm", async () => {
    // Declared 40k, upstream states wall 30k and a rejected payload of
    // 28000 messages + 7000 completion → message budget 23k. The local
    // conversation (~16k) CAN reach under 23k once folds net out of the
    // armed floor, so the refold path must converge on fit and re-send within
    // the same request.
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
                res.end(SMALL_WINDOW_OVERFLOW_BODY);
            } else {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(okSse());
            }
            streamingCall += 1;
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstreamPort, 40_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
        const headers = { "content-type": "application/json", "x-acp-session": "t3450-rec-sess" };

        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 200, "#1195/#3450: folded under the message budget (window − completion) and re-sent within the same request");
        assert.equal(r1.headers.get("content-type"), "text/event-stream");
        await r1.text();
        assert.ok(summaryCalls >= 1, "preflight ran compress summary calls");
        const lastForward = bodies[bodies.length - 1];
        assert.ok(lastForward.includes(SUMMARY_TEXT), "the forwarded body carries the fold summary");
        const s = listSessions().find((x) => x.id === "t3450-rec-sess");
        assert.ok(s, "session exists");
        // The retry's real usage report replaces the armed baseline and retires
        // BOTH the arm and its completion reservation (#1110 lifecycle).
        assert.equal(s!.stats.lastInputTokens, 5000, "the retry's usage report already replaced the armed baseline");
        assert.equal(s!.stats.lastInputTokensSource, "usage");
        assert.equal(s!.stats.overflowArmTokens, undefined, "the one-shot arm retired with the recovery");
        assert.equal(s!.stats.overflowArmCompletionReserve, undefined, "the proven reservation retires WITH the arm");
        assert.equal(s!.stats.overflowArmMismatchWarned, true, "the one-time warning flag survives recovery (it is provenance)");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "nothing learned into the declared window");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
