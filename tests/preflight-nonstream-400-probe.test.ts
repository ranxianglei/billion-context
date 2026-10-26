import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on 4xx retries so the #2494 probe exercises immediately instead
// of burning the default replay attempts.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #2494 regression: an upstream that mandates streaming answers NON-STREAM
// calls with HTTP 400 in vendor-specific wording. The #626 regex only matched
// "stream … true" phrasings; this upstream says "Non-stream chat request is
// currently not supported" (code 11101), which no phrase list covers. The fix
// makes the rejection SHAPE the detector: any 400 on a non-streaming summary
// attempt gets exactly one SSE probe, learned on the session. These tests pin
// both the exact issue repro and the wording-independence.

const SUMMARY_TEXT =
    "PROBE SUMMARY: the segment held a deterministic load-growth payload across a dozen turns; every raw marker is derivable from the seed and none carries unique state, so the folded view loses nothing of value for continued work.";

const ISSUE_11101_BODY = JSON.stringify({
    code: 11101,
    msg: "Non-stream chat request is currently not supported",
    requestId: "req-2494-repro",
    displayMsg: { en: "Invalid request. Please retry", zh: "请求内容不合法，请重试" },
});

type Call = { stream: boolean; summary: boolean };

function sseChunk(deltaContent: string | null, finishReason: string | null): string {
    const delta: Record<string, unknown> = {};
    if (deltaContent !== null) delta.content = deltaContent;
    return `data: ${JSON.stringify({ id: "chatcmpl-t", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

// OpenAI-chat-completions-flavored stream-only upstream. Non-stream calls get
// the configured 400 body; stream calls get a valid chat-completions SSE.
// Summary calls are recognized by their exact payload shape (two messages:
// system + user); the forwarded client request carries the long history.
function makeOpenAIUpstream(calls: Call[], rejectBody: string): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; messages?: unknown[] } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = Array.isArray(parsed.messages) && parsed.messages.length === 2;
            calls.push({ stream: parsed.stream === true, summary: isSummary });
            if (parsed.stream !== true) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(rejectBody);
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const text = isSummary ? SUMMARY_TEXT : "ok";
            for (const part of [text.slice(0, 40), text.slice(40)]) {
                if (part) res.write(sseChunk(part, null));
            }
            res.write(sseChunk(null, "stop"));
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
}

function longOpenAIMessages() {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "openai-test": { context: 10_000 } } } },
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

async function driveChatPreflight(proxyPort: number, upstreamPort: number, session: string): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model: "openai-test", stream: true, messages: longOpenAIMessages() }),
    });
}

async function closeAll(...servers: http.Server[]): Promise<void> {
    for (const s of servers) { s.close(); s.closeIdleConnections?.(); }
    await Promise.allSettled(servers.map((s) => once(s, "close")));
}

test("e2e #2494: 400 'Non-stream … not supported' (code 11101) → one-shot SSE probe, fold + forward OK, learned", async () => {
    const calls: Call[] = [];
    const upstream = makeOpenAIUpstream(calls, ISSUE_11101_BODY);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveChatPreflight(proxyPort, upstreamPort, "s2494-11101-1");
        assert.equal(r.status, 200, `first request must succeed (was 502 fail-fast before the fix), got ${r.status}`);

        // The learning sequence: the rejected non-stream summary, then the
        // streamed summary that applied, then the folded forward.
        const nonStreamSummaries = calls.filter((c) => c.summary && !c.stream);
        const streamSummaries = calls.filter((c) => c.summary && c.stream);
        assert.ok(nonStreamSummaries.length >= 1, "the non-stream summary attempt must have been made (and 400'd)");
        assert.ok(streamSummaries.length >= 1, "the one-shot SSE probe must have happened despite the unrecognized wording");
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");

        const sess = listSessions().find((s) => s.id.includes("s2494-11101-1"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightStreamSummary, true, "stream preference learned on the session");

        // Second preflight on the same session: stream first-shot — no more
        // non-stream 400 round-trips.
        const callsBefore = calls.length;
        const r2 = await driveChatPreflight(proxyPort, upstreamPort, "s2494-11101-1");
        assert.equal(r2.status, 200);
        const newCalls = calls.slice(callsBefore);
        assert.ok(newCalls.length > 0, "second request produced upstream calls");
        assert.ok(
            newCalls.every((c) => c.stream),
            `every second-request call must be stream (learned), got ${JSON.stringify(newCalls)}`,
        );
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("e2e #2494: ANY wording triggers the probe — generic 400 body naming neither 'stream' nor 'true'", async () => {
    const calls: Call[] = [];
    const upstream = makeOpenAIUpstream(calls, JSON.stringify({ error: { message: "request rejected by gateway policy" } }));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveChatPreflight(proxyPort, upstreamPort, "s2494-generic-1");
        assert.equal(r.status, 200, `probe must fire on unrelated 400 wording too (shape is the detector), got ${r.status}`);
        assert.ok(calls.some((c) => c.summary && !c.stream), "non-stream summary attempt made first");
        assert.ok(calls.some((c) => c.summary && c.stream), "SSE probe happened");
        const sess = listSessions().find((s) => s.id.includes("s2494-generic-1"));
        assert.equal(sess?.metadata?.preflightStreamSummary, true, "learned");
    } finally {
        await closeAll(proxy, upstream);
    }
});
