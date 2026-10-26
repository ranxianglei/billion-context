// #4743 — the loop lane's own egress sends feed the 429 governor.
//
// The governor's observe pair (noteUpstreamThrottle429 / noteUpstreamThrottleResolved)
// was wired only on the relay forwarding path. Three loop-lane chokepoints still
// bypassed it: the Responses-wire compress loop, the preflight refold, and the
// reasoning-guard continuation rounds. Each of those sites now reports its verdict
// so a 429-storming upstream arms the egress hold for the NEXT client turn.
//
// #4772 review fix: the preflight site reports RESOLVED per response but arms ONLY
// at the caller's withhold verdict (server.ts) — arming per-response there would
// block the same request's own forward of a fitting payload (#301). The e2e pin for
// the withhold-time arm lives in tests/preflight-fail-fast.test.ts.
//
// Unlike PR #4725's governor-contract pin (which passes on master too), these are
// WIRING pins: they drive the real code path against a 429 upstream and assert the
// governor armed — so they FAIL on master and pass only once the site observes.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type Config, type CoreMessage } from "acp-kernel";
import { compressLoopResponsesJson } from "../src/compress-loop-responses.ts";
import { runReasoningGuard, type SseSink } from "../src/reasoning-guard.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { noteUpstreamThrottle429, upstreamThrottleLocalReject, _resetUpstreamThrottleForTest } from "../src/upstream-throttle.ts";

process.env.NODE_ENV = "test";
process.env.BILI_REPLAY_RETRY_MAX = "3";
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
_setStoreForTest(new SessionStore({ enabled: false }));

afterEach(() => {
    _resetUpstreamThrottleForTest();
    process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
});

test("responses-wire compress loop feeds the 429 governor (#4743)", async () => {
    const baseCore = createCore();
    const core = { ...baseCore, applyCompression: (input: Parameters<typeof baseCore.applyCompression>[0]) => ({ state: input.state, result: { blocksCreated: 0, tokensCompressed: 0, errors: [], warnings: [] } }) };
    const ctx = {
        core,
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: getSession(`issue4743-rsp-${randomUUID()}`),
        log: () => {},
    };
    const url = "https://loop-4743.test/responses";
    const headers: Record<string, string> = { "content-type": "application/json" };
    const initial = {
        id: "r4743",
        status: "completed",
        output: [{ type: "function_call", id: "fc1", call_id: "c1", name: "compress", arguments: JSON.stringify({ content: [{ startId: "m1", endId: "m1", summary: "s" }] }) }],
    };
    const body = { model: "gpt-5", input: [{ type: "message", role: "user", content: "go" }] };

    const prevFetch = globalThis.fetch;
    try {
        // Arm: the loop's round-2 resend hits a 429 upstream; fetchWithRetry exhausts
        // its budget and throws UpstreamHttpError(429), whose observe arms the governor.
        globalThis.fetch = (async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } })) as typeof fetch;
        let threw = false;
        try {
            await compressLoopResponsesJson(initial, ctx, body, { url, headers });
        } catch {
            threw = true;
        }
        assert.ok(threw, "a terminal 429 propagates out of the loop");
        assert.ok(upstreamThrottleLocalReject(url, headers), "governor armed after the loop's terminal 429");

        // Clear: a settled ok response lifts the hold.
        globalThis.fetch = (async () => new Response(JSON.stringify({ id: "ok", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
        await compressLoopResponsesJson(initial, ctx, body, { url, headers });
        assert.equal(upstreamThrottleLocalReject(url, headers), undefined, "a resolved verdict lifts the hold");

        // Review fix (#4772): a fail-fast NON-429 verdict also settles the endpoint —
        // the #4204 contract clears on ANY resolved non-429 (relay parity), so the
        // loop's boundary report must cover thrown UpstreamHttpError(≠429) too.
        globalThis.fetch = (async () => new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 })) as typeof fetch;
        try { await compressLoopResponsesJson(initial, ctx, body, { url, headers }); } catch { /* expected */ }
        assert.ok(upstreamThrottleLocalReject(url, headers), "re-armed by a second terminal 429");
        globalThis.fetch = (async () => new Response(JSON.stringify({ error: "invalid model" }), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch;
        let threw400 = false;
        try { await compressLoopResponsesJson(initial, ctx, body, { url, headers }); } catch { threw400 = true; }
        assert.ok(threw400, "a fail-fast 400 propagates out of the loop");
        assert.equal(upstreamThrottleLocalReject(url, headers), undefined, "a settled non-429 verdict lifts the hold");
    } finally {
        globalThis.fetch = prevFetch;
    }
});

// --- reasoning-guard helpers (mirrored from tests/reasoning-guard.test.ts) ---
function sseRound(o: { reasoningTokens: number; encrypted?: string; messageText?: string }): string {
    const nonReasoning = o.messageText ? 10 : 0;
    const outputTokens = o.reasoningTokens + nonReasoning;
    const events: Array<Record<string, unknown>> = [];
    events.push({ type: "response.created", response: { id: "resp_x", status: "in_progress", model: "gpt-5.5" } });
    events.push({ type: "response.output_item.added", output_index: 0, item: { id: "rs_1", type: "reasoning", status: "in_progress" } });
    const reasonDone: Record<string, unknown> = { id: "rs_1", type: "reasoning", status: "completed" };
    if (o.encrypted !== undefined) reasonDone.encrypted_content = o.encrypted;
    events.push({ type: "response.output_item.done", output_index: 0, item: reasonDone });
    let oi = 1;
    if (o.messageText) {
        events.push({ type: "response.output_item.added", output_index: oi, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } });
        events.push({ type: "response.output_item.done", output_index: oi, item: { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: o.messageText }] } });
        oi++;
    }
    events.push({ type: "response.completed", response: { id: "resp_x", status: "completed", model: "gpt-5.5", output: [], usage: { input_tokens: 100, output_tokens: outputTokens, total_tokens: 100 + outputTokens, output_tokens_details: { reasoning_tokens: o.reasoningTokens } } } });
    let out = "";
    for (const e of events) out += `data: ${JSON.stringify(e)}\n\n`;
    out += "data: [DONE]\n\n";
    return out;
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(enc.encode(text)); controller.close(); } });
}

function makeSink(): { sink: SseSink } {
    const sink: SseSink = {
        headersSent: false,
        writableEnded: false,
        writeHead() { sink.headersSent = true; },
        write() { return true; },
        end() { sink.writableEnded = true; },
        once() { return undefined; },
    };
    return { sink };
}

test("reasoning-guard continuation rounds feed the 429 governor (#4743)", async () => {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(429, { "retry-after": "1" });
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const url = `http://127.0.0.1:${addr.port}/v1/responses`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    try {
        // A lattice-truncated first round (516 reasoning tokens + encrypted_content)
        // triggers a continuation round; that round's 429 verdict arms the governor.
        const firstResponse = new Response(streamFrom(sseRound({ reasoningTokens: 516, encrypted: "enc1" })), { headers: { "content-type": "text/event-stream" } });
        const { sink } = makeSink();
        await runReasoningGuard({
            firstResponse,
            clearFirstTimer: () => {},
            upstreamUrl: url,
            reqHeaders: headers,
            originalBody: JSON.stringify({ model: "gpt-5.5", stream: true, input: [] }),
            signal: new AbortController().signal,
            res: sink,
            config: { enabled: true },
            log: () => {},
        });
        assert.ok(upstreamThrottleLocalReject(url, headers), "governor armed after a 429 continuation round");
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections?.();
        await closed;
    }
});

const PREFLIGHT_SUMMARY = "SUMMARY: keep the goal and acceptance criteria.";

function preflightFixture(url: string) {
    const session = getSession(`issue4743-preflight-${randomUUID()}`);
    session.metadata.preflightStreamSummary = true;
    const messages: CoreMessage[] = [
        { id: "first", role: "user", contentType: "text", text: "Keep the task goal." },
        { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(4000) },
        { id: "last", role: "user", contentType: "text", text: "Continue." },
    ];
    const deps: PreflightDeps = {
        core: createCore(),
        session,
        config: defaultConfig(6000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
        prompts: defaultPrompts,
        protocol: "responses",
        url,
        headers: {},
        model: "test-model",
        log: () => {},
    };
    return { deps, messages };
}

test("preflight refold clears the 429 hold without self-arming (#4743/#4772)", async () => {
    let mode: "429" | "200" = "429";
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            if (mode === "429") {
                res.writeHead(429, { "retry-after": "1" });
                res.end("rate limited");
            } else {
                const event = { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: PREFLIGHT_SUMMARY }] }] } };
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(`data: ${JSON.stringify(event)}\n\n`);
            }
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const url = `http://127.0.0.1:${addr.port}/responses`;
    const headers: Record<string, string> = {};
    try {
        // Anti-self-block (#4772 review): a 429'd summary probe must NOT arm the hold —
        // this request's own forward runs AFTER preflight and passes the relay gate, so
        // arming here would block our own forward of a fitting payload (#301 contract).
        // The arm lives at the caller's withhold verdict (server.ts; e2e pin in
        // tests/preflight-fail-fast.test.ts). This phase FAILS on the per-response-arm
        // tree and passes only with the verdict-time arm.
        mode = "429";
        const probed = preflightFixture(url);
        await preflightCompress(probed.deps, probed.messages);
        assert.equal(upstreamThrottleLocalReject(url, headers), undefined, "a 429'd summary probe alone does not arm the hold (no self-block)");

        // Clear: a settled non-429 summary response lifts an existing hold (same origin key).
        noteUpstreamThrottle429(url, headers, null);
        assert.ok(upstreamThrottleLocalReject(url, headers), "setup: hold armed");
        mode = "200";
        const cleared = preflightFixture(url);
        await preflightCompress(cleared.deps, cleared.messages);
        assert.equal(upstreamThrottleLocalReject(url, headers), undefined, "a resolved summary lifts the hold");
    } finally {
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections?.();
        await closed;
    }
});
