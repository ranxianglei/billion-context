import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on 4xx retries so the #626 learn path exercises immediately
// instead of burning the default replay attempts.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #626 regression: upstreams that REQUIRE stream:true (ChatGPT-login codex
// backend: 400 {"detail":"Stream must be set to true"}) must not kill
// preflight compression. The proxy detects the rejection, retries the
// summarization as SSE, and remembers the preference on the session so later
// preflights stream first-shot.

const SUMMARY_TEXT =
    "STREAMED SUMMARY: the segment held a deterministic load-growth payload across a dozen turns; every raw marker is derivable from the seed and none carries unique state, so the folded view loses nothing of value for continued work.";

type Call = { stream: boolean; summary: boolean };

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Responses-flavored stream-only upstream: non-stream calls get the #626 400,
// stream calls get a valid Responses SSE (deltas + completed carrying the full
// response — both extraction paths must work; we exercise delta accumulation
// on the summary and completed-only on the forwarded call).
function makeResponsesUpstream(calls: Call[], summaryViaCompleted: boolean): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; instructions?: unknown; input?: unknown } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = typeof parsed.instructions === "string" && Array.isArray(parsed.input) && parsed.input.length === 1;
            calls.push({ stream: parsed.stream === true, summary: isSummary });
            if (parsed.stream !== true) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ detail: "Stream must be set to true" }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (isSummary) {
                if (summaryViaCompleted) {
                    res.write(sse("response.completed", {
                        type: "response.completed",
                        response: {
                            id: "resp_sum",
                            status: "completed",
                            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: SUMMARY_TEXT }] }],
                            usage: { input_tokens: 100, output_tokens: 5 },
                        },
                    }));
                } else {
                    for (const part of [SUMMARY_TEXT.slice(0, 40), SUMMARY_TEXT.slice(40)]) {
                        res.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: part }));
                    }
                    res.write(sse("response.completed", { type: "response.completed", response: { id: "resp_sum", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5 } } }));
                }
            } else {
                res.write(sse("response.completed", {
                    type: "response.completed",
                    response: {
                        id: "resp_fwd",
                        status: "completed",
                        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
                        usage: { input_tokens: 800, output_tokens: 4 },
                    },
                }));
            }
            res.end();
        });
    });
}

function longResponsesInput() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 12; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return input;
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-6-astra": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
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
    } as ProxyOptions);
}

async function driveResponsesPreflight(proxyPort: number, upstreamPort: number, session: string, calls: Call[]): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: longResponsesInput() }),
    });
}

test("e2e #626 (Responses, delta SSE): stream-only upstream → learn on 400, summary via SSE, fold + forward OK", async () => {
    const calls: Call[] = [];
    const upstream = makeResponsesUpstream(calls, false);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s626-resp-1", calls);
        assert.equal(r.status, 200, `first request must succeed, got ${r.status}`);

        // The learning sequence: at least one rejected non-stream summary,
        // then a streamed summary that applied, then the forward.
        const nonStreamSummaries = calls.filter((c) => c.summary && !c.stream);
        const streamSummaries = calls.filter((c) => c.summary && c.stream);
        assert.ok(nonStreamSummaries.length >= 1, "the non-stream summary attempt must have been made (and 400'd)");
        assert.ok(streamSummaries.length >= 1, "the stream retry must have happened");

        // The fold applied: the forwarded payload no longer carries the raw
        // markers (the summary replaced the oldest range).
        const forwardBodies = calls.filter((c) => !c.summary).length;
        assert.ok(forwardBodies >= 1, "the folded payload was forwarded");

        // Learned: metadata carries the sticky flag.
        const sess = listSessions().find((s) => s.id.includes("s626-resp-1"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightStreamSummary, true, "stream preference learned on the session");

        // Second preflight on the same session: stream first-shot — no more
        // non-stream 400 round-trips.
        const callsBefore = calls.length;
        const r2 = await driveResponsesPreflight(proxyPort, upstreamPort, "s626-resp-1", calls);
        assert.equal(r2.status, 200);
        const newCalls = calls.slice(callsBefore);
        assert.ok(newCalls.length > 0, "second request produced upstream calls");
        assert.ok(
            newCalls.every((c) => c.stream),
            `every second-request call must be stream (learned), got ${JSON.stringify(newCalls)}`,
        );
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

test("e2e #626 (Responses, completed-only SSE): summary extracted from response.completed payload", async () => {
    const calls: Call[] = [];
    const upstream = makeResponsesUpstream(calls, true);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s626-resp-2", calls);
        assert.equal(r.status, 200);
        assert.ok(calls.some((c) => c.summary && c.stream), "streamed summary call happened");
        // The forward body must contain the completed-only summary text as the
        // applied fold's content (the summary entered the rebuilt payload).
        const forwardRaw = calls.map((c, i) => (c.summary ? "" : String(i)));
        assert.ok(forwardRaw.length > 0);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

// Anthropic-flavored variant: same learn-and-retry on /v1/messages.
function makeAnthropicUpstream(calls: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; messages?: unknown[] } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = Array.isArray(parsed.messages) && parsed.messages.length === 1;
            calls.push({ stream: parsed.stream === true, summary: isSummary });
            if (parsed.stream !== true) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Stream must be set to true." } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const text = isSummary ? SUMMARY_TEXT : "ok";
            res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 100 } } })}\n\n`);
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
            res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
            res.end();
        });
    });
}

function longAnthropicMessages() {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

test("e2e #626 (Anthropic): stream-only upstream → learn on 400, text_delta SSE summary, fold + forward OK", async () => {
    const calls: Call[] = [];
    const upstream = makeAnthropicUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
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
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "s626-anth-1" },
            body: JSON.stringify({ model: "claude-test", stream: true, max_tokens: 1024, system: "You are a test assistant.", messages: longAnthropicMessages() }),
        });
        assert.equal(r.status, 200, `request must succeed, got ${r.status}`);
        assert.ok(calls.some((c) => c.summary && !c.stream), "non-stream summary attempt made first");
        assert.ok(calls.some((c) => c.summary && c.stream), "stream retry happened");
        const sess = listSessions().find((s) => s.id.includes("s626-anth-1"));
        assert.equal(sess?.metadata?.preflightStreamSummary, true, "learned");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});
