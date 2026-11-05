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

// #1195: wire clients (omp/pi on the plain proxy path) treat an upstream
// context-overflow 400 as FATAL — they end the session on the first error, so
// the #987 arm-and-wait-for-the-next-turn rescue never gets its next turn and
// the session locks. The fix: when forward() sees a context overflow with a
// stated window, it re-runs prepare+preflight with the STATED window as a
// per-call limit override, folds the payload below the REAL window, and
// re-sends it ONCE within the same request. The original 400 still passes
// through verbatim when the payload cannot be rescued (nothing foldable, or
// the retry is also rejected) — the client-visible contract only IMPROVES.

const STATED_OVERFLOW_BODY_128K = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "prompt is too long: 130000 tokens > 128000 maximum" },
});

const RETRY_REJECT_BODY = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "rejected after compaction: 129000 tokens > 128000 maximum (retry-after-refold)" },
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

function failedCompressSse(): string {
    const input = JSON.stringify({ startId: "m9999999", endId: "m9999999", summary: "Invalid range; do not modify history." });
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_compress", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_compress", name: "compress", input: {} } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: input } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 50 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

interface RecordedUpstream {
    server: http.Server;
    port: number;
    bodies: string[];
}

// Records every request body in order. Streaming requests are answered by
// `onStreaming(callIndex)`; stream:false (summarization) requests by the
// in-band summary response.
async function recordedUpstream(onStreaming: (callIndex: number, res: http.ServerResponse) => void): Promise<RecordedUpstream> {
    const bodies: string[] = [];
    let streamingCall = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            let parsed: { stream?: boolean } = {};
            try {
                parsed = JSON.parse(raw) as { stream?: boolean };
            } catch {
                parsed = {};
            }
            if (parsed.stream === false) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(summaryJson());
                return;
            }
            const call = streamingCall;
            streamingCall += 1;
            onStreaming(call, res);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, port: (server.address() as { port: number }).port, bodies };
}

test("e2e #1195 A: stated-window overflow is rescued within the SAME request — folded body re-sent upstream, client sees the retry's 200", async (t) => {
    const upstream = await recordedUpstream((call, res) => {
        if (call === 0) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(STATED_OVERFLOW_BODY_128K);
        } else {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse());
        }
    });

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    // The operator declared 400k — the upstream just proved the REAL window is 128k.
    const proxy = await startServer(proxyBaseOptions(upstream.port, 400_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    t.after(async () => {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.server.close();
        upstream.server.closeIdleConnections?.();
        await once(upstream.server, "close");
    });

    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/messages`;
    const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
    const headers = { "content-type": "application/json", "x-acp-session": "refold-a" };

    const r1 = await fetch(url, { method: "POST", headers, body });
    assert.equal(r1.status, 200, "the client never sees the 400 — the turn is rescued in-request");
    assert.match(r1.headers.get("content-type") ?? "", /text\/event-stream/);
    const r1text = await r1.text();
    assert.ok(r1text.includes("text_delta"), "the retry's SSE stream is delivered");

    // bodies: [0] original 400'd forward, [1] summarization call, [2] retry.
    assert.equal(upstream.bodies.length, 3, `one overflow + one summary + one retry: ${upstream.bodies.length}`);
    assert.ok(upstream.bodies[0].includes("MARKER_1_") && upstream.bodies[0].includes("MARKER_11_"), "first forward carried the full history");
    assert.ok(upstream.bodies[2].includes(SUMMARY_TEXT), "the retry carries the fold summary");
    assert.ok(upstream.bodies[2].includes("MARKER_11_") && !upstream.bodies[2].includes("MARKER_1_"), "the retry keeps the recent tail, drops the folded early range");
    assert.ok(upstream.bodies[2].length < upstream.bodies[0].length, "the retried body is smaller than the rejected one");

    const s = listSessions().find((x) => x.id === "refold-a");
    assert.ok(s, "session exists");
    assert.equal(s!.metadata.confirmedContextLimits, undefined, "#987: nothing learned — the declared window keeps governing");
    assert.equal(s!.stats.lastInputTokensSource, "usage");
});

test("e2e #1195 B: an unfoldable payload passes the ORIGINAL overflow 400 through verbatim — the refold is not a client-visible change", async (t) => {
    const upstream = await recordedUpstream((_call, res) => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(STATED_OVERFLOW_BODY_128K);
    });

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstream.port, 400_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    t.after(async () => {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.server.close();
        upstream.server.closeIdleConnections?.();
        await once(upstream.server, "close");
    });

    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/messages`;
    // A single enormous message: nothing to fold — preflight cannot rescue it.
    const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "MEGA_" + "payload ".repeat(60_000) }] });
    const headers = { "content-type": "application/json", "x-acp-session": "refold-b" };

    const r1 = await fetch(url, { method: "POST", headers, body });
    assert.equal(r1.status, 400, "an unfoldable payload keeps the verbatim passthrough");
    const r1text = await r1.text();
    assert.equal(r1text, STATED_OVERFLOW_BODY_128K, "the ORIGINAL error body is byte-identical");

    const s = listSessions().find((x) => x.id === "refold-b");
    assert.ok(s, "session exists");
    // #3450: the body states the rejected prompt's own size (130000) — the
    // arm books THAT measurement; the side-request guard keeps the CEILING.
    assert.equal(s!.stats.lastInputTokens, 130000, "the arm still fires at the upstream-measured size — the next turn folds if it can");
    assert.equal(s!.stats.overflowArmTokens, 128000, "#1110: the arm is recorded (ceiling, unchanged by #3450)");
    assert.equal(s!.metadata.confirmedContextLimits, undefined, "#987: nothing learned");
});

test("#2777: a failed compress after an accepted overflow fold keeps the fold for the next turn", async (t) => {
    const upstream = await recordedUpstream((call, res) => {
        if (call === 0) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(STATED_OVERFLOW_BODY_128K);
        } else {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(call === 1 ? failedCompressSse() : okSse());
        }
    });
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstream.port, 400_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    t.after(async () => {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.server.close();
        upstream.server.closeIdleConnections?.();
        await once(upstream.server, "close");
    });
    const response = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "refold-2777" },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() }),
    });
    assert.equal(response.status, 200);
    const stream = await response.text();
    const forwards = () => upstream.bodies.filter((raw) => (JSON.parse(raw) as { stream?: boolean }).stream !== false);
    // #4186→#5220: the failed-only compress round no longer ends the turn —
    // the receipt re-request is the third forward. It must carry the streamed
    // ❌ receipt (client-visible bytes) and NONE of this round's ephemeral
    // failure frames (#1548/#4186 seam invariant).
    assert.equal(forwards().length, 3, "original overflow + accepted folded retry + recovery-receipt re-request (#5220)");
    assert.ok(forwards()[0].includes("MARKER_1_"), "original request contains early history");
    assert.ok(forwards()[1].includes(SUMMARY_TEXT) && !forwards()[1].includes("MARKER_1_"), "accepted retry folded early history");
    assert.ok(forwards()[2].includes("Compression FAILED"), "receipt re-request carries the ❌ receipt as assistant text");
    assert.ok(!forwards()[2].includes("tool_result"), "ephemeral failure frames stay off the wire (#1548/#4186)");
    assert.match(stream, /Compression FAILED/, "the invalid-range receipt reaches the client");
    // #2777 core property under the new contract: the accepted fold survives
    // the failed compress into the NEXT turn's rebuild.
    const r2 = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": "refold-2777" },
        body: JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() }),
    });
    assert.equal(r2.status, 200);
    const f = forwards();
    assert.equal(f.length, 4, "next turn hits the upstream once more");
    assert.ok(f[3].includes(SUMMARY_TEXT), "next-turn rebuild retains the accepted summary");
    assert.ok(!f[3].includes("MARKER_1_"), "next-turn rebuild does not resurrect folded early history");
    assert.ok(f[3].includes("MARKER_11_"), "next-turn rebuild preserves the recent tail");
    assert.ok(f[3].length < f[0].length, "rebuild stays smaller than the rejected original");
});

test("e2e #1195 C: when the folded retry is ALSO rejected, the client sees the RETRY's verdict, not the stale first 400 — and the arm stays for the next turn", async (t) => {
    const upstream = await recordedUpstream((call, res) => {
        if (call === 0) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(STATED_OVERFLOW_BODY_128K);
        } else {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(RETRY_REJECT_BODY);
        }
    });

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer(proxyBaseOptions(upstream.port, 400_000));
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    t.after(async () => {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.server.close();
        upstream.server.closeIdleConnections?.();
        await once(upstream.server, "close");
    });

    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstream.port}/v1/messages`;
    const body = JSON.stringify({ model: "claude-test", max_tokens: 1024, stream: true, messages: bigConversation() });
    const headers = { "content-type": "application/json", "x-acp-session": "refold-c" };

    const r1 = await fetch(url, { method: "POST", headers, body });
    assert.equal(r1.status, 400, "the retry's rejection reaches the client");
    const r1text = await r1.text();
    assert.ok(r1text.includes("retry-after-refold"), "the RETRY's body is what the client sees");
    assert.ok(!r1text.includes("prompt is too long"), "the stale first 400 is not re-served");

    assert.ok(upstream.bodies.length >= 3, "original + summary + retry all hit the upstream");
    assert.ok(upstream.bodies[2].includes(SUMMARY_TEXT), "the retry was the folded body");

    const s = listSessions().find((x) => x.id === "refold-c");
    assert.ok(s, "session exists");
    assert.ok(
        s!.stats.lastInputTokens > 0 && s!.stats.lastInputTokens < 128000,
        `no usage landed — the armed baseline survives minus the fold's reclaim credit: ${s!.stats.lastInputTokens}`,
    );
    assert.equal(s!.stats.overflowArmTokens, 128000, "#1110 arm record stays at the stated window");
    assert.equal(s!.metadata.confirmedContextLimits, undefined, "#987: nothing learned");
});
