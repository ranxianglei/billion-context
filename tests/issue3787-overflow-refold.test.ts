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

// #3787: the agnes/cch relay rejects over-window sends with a NUMBERLESS
// overflow body whose marker strings ("context_limit" type, Chinese message)
// matched none of CONTEXT_OVERFLOW_PATTERNS, so the whole #987/#1195 self-heal
// chain was dead for this gateway: the 400 passed through verbatim and the
// one-shot emergency shrink never armed (field log: four failed turns, dsh,
// agnes-3.0-flash through a 512K deployment). This file pins the captured
// shape end-to-end: the oversized turn's 400 is recognized, the one-shot arm
// fires, prepare+preflight re-run under the armed window, and the folded body
// is re-sent WITHIN THE SAME REQUEST — the client sees the retry's 200, never
// the 400 (same contract as e2e-overflow-selfheal T1, whose body stated a
// window number; here the arm falls back to the declared/payload size).

const AGNES_OVERFLOW_BODY = JSON.stringify({
    type: "error",
    error: {
        type: "context_limit",
        message: "上下文长度超过模型限制，请减少对话历史或输入内容 (cch_session_id: sess_test)",
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

test("e2e #3787: the agnes/cch numberless context_limit 400 is recognized and the oversized turn is rescued in-request (#987/#1195)", async () => {
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
                res.end(AGNES_OVERFLOW_BODY);
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
    // Declared window far above the payload's true size: preflight skips the
    // first turn entirely (nothing over 100K), the gateway 400s the RAW body
    // anyway (its real ceiling is below the payload — agnes-3.0-flash through
    // a mis-declared cch), and the rescue must come from the recognized error:
    // arm = min(declared, payload's own estimate), refold under arm*0.9 folds
    // real ranges, the smaller body is re-sent within the same request.
    // (A declared window BELOW the payload cannot express this contract: the
    // calibrated trigger now folds everything compressible BEFORE the send,
    // so a numberless rejection arrives with zero foldable mass left — the
    // rescue's historical "success" there rode on re-render truncation
    // asymmetry, which #3939 ③ eliminated.)
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
        const headers = { "content-type": "application/json", "x-acp-session": "t3787-sess" };

        // r1: the agnes-shaped 400 must NOT reach the client — #1195: the arm
        // fires (no stated number → min(declared window, payload size)),
        // prepare+preflight re-run under the armed window, the folded body is
        // re-sent within the same request, and the retry's 200 answers.
        const r1 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r1.status, 200, "#3787: the numberless context_limit 400 is recognized and refolded in-request");
        assert.equal(r1.headers.get("content-type"), "text/event-stream", "the retry's SSE is what the client sees");
        await r1.text();
        assert.ok(summaryCalls >= 1, "the rescue ran a preflight fold");
        assert.ok(bodies[bodies.length - 1]!.includes(SUMMARY_TEXT), "the re-sent body carries the fold summary");
        const s = listSessions().find((x) => x.id === "t3787-sess");
        assert.ok(s, "session exists");
        assert.equal(s!.metadata.confirmedContextLimits, undefined, "#987: nothing learned from the overflow");
        assert.equal(s!.stats.lastInputTokens, 5000, "the retry's own usage report replaced the armed baseline");
        assert.equal(s!.stats.lastInputTokensSource, "usage", "the successful retry reports usage-grade");
        assert.equal(s!.stats.overflowArmTokens, undefined, "#1129: the retry's usage report retired the one-shot arm");

        // r2: same payload — the fold is sticky, forwarded compacted, no new fold.
        const summaryCallsBefore = summaryCalls;
        const r2 = await fetch(url, { method: "POST", headers, body });
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(summaryCalls, summaryCallsBefore, "r2 forwards the sticky fold without folding again");
        assert.ok(bodies[bodies.length - 1]!.includes(SUMMARY_TEXT), "r2 carries the compacted view");
        assert.ok(!bodies[bodies.length - 1]!.includes("MARKER_1_content_"), "the folded early range stays folded");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
    }
});
