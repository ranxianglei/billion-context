import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on 4xx retries so the #663 learn path exercises immediately
// instead of burning the default replay attempts.
process.env.BILI_REPLAY_RETRY_MAX = "1";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #663 regression: the ChatGPT-login codex backend rejects the Responses
// max_output_tokens parameter outright (400 {"detail":"Unsupported parameter:
// max_output_tokens"}), which killed preflight summaries with a 502 after the
// #626 stream fix. The proxy must detect the rejection, retry the
// summarization without the optional parameter, and remember it per
// session+upstream+model — so a model that accepts the limit keeps the 8192
// cap. Both rejection orders (stream-first, max_output_tokens-first) must
// recover, and standard providers must be untouched.

const SUMMARY_TEXT =
    "MAX-TOKENS SUMMARY: the segment held a deterministic load-growth payload across a dozen turns; every raw marker is derivable from the seed and none carries unique state, so the folded view loses nothing of value for continued work.";

type Call = { stream: boolean; summary: boolean; maxOutputTokens?: number; model?: string };

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function summarySse(res: http.ServerResponse): void {
    for (const part of [SUMMARY_TEXT.slice(0, 40), SUMMARY_TEXT.slice(40)]) {
        res.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: part }));
    }
    res.write(sse("response.completed", { type: "response.completed", response: { id: "resp_sum", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5 } } }));
    res.end();
}

function forwardSse(res: http.ServerResponse): void {
    res.write(sse("response.completed", {
        type: "response.completed",
        response: {
            id: "resp_fwd",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: 800, output_tokens: 4 },
        },
    }));
    res.end();
}

// A real upstream answers a non-stream call with plain JSON and a stream call
// with SSE — the proxy extracts the summary differently per shape, so the
// mock must honor the request's stream flag or non-stream summaries come back
// empty.
function respondSummary(res: http.ServerResponse, stream: boolean): void {
    if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        summarySse(res);
    } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "resp_sum", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: SUMMARY_TEXT }] }] }));
    }
}

// Order A — mirrors the real ChatGPT codex backend: the stream check fires
// before the parameter check. Non-stream → 400 stream; stream + max_output_tokens
// → 400 unsupported parameter; stream without it → 200.
function makeStreamFirstUpstream(calls: Call[]): http.Server {
    return makePickyUpstream(calls, (p) => {
        if (p.stream !== true) return { detail: "Stream must be set to true" };
        if (p.max_output_tokens !== undefined) return { detail: "Unsupported parameter: max_output_tokens" };
        return null;
    });
}

// Order B — a hypothetical backend that validates parameters before the
// stream flag: any request carrying max_output_tokens → 400 unsupported
// parameter; then non-stream → 400 stream; then 200.
function makeParamFirstUpstream(calls: Call[]): http.Server {
    return makePickyUpstream(calls, (p) => {
        if (p.max_output_tokens !== undefined) return { detail: "Unsupported parameter: max_output_tokens" };
        if (p.stream !== true) return { detail: "Stream must be set to true" };
        return null;
    });
}

function makePickyUpstream(calls: Call[], reject: (p: ParsedBody) => { detail: string } | null): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = parseBody(raw);
            calls.push({ stream: parsed.stream === true, summary: isSummaryCall(parsed), maxOutputTokens: parsed.max_output_tokens, model: parsed.model });
            const rejection = reject(parsed);
            if (rejection) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify(rejection));
                return;
            }
            if (isSummaryCall(parsed)) respondSummary(res, parsed.stream === true);
            else forwardSse(res);
        });
    });
}

type ParsedBody = { stream?: boolean; instructions?: unknown; input?: unknown; max_output_tokens?: number; model?: string };

function parseBody(raw: string): ParsedBody {
    try {
        return JSON.parse(raw) as ParsedBody;
    } catch {
        return {};
    }
}

function isSummaryCall(parsed: ParsedBody): boolean {
    return typeof parsed.instructions === "string" && Array.isArray(parsed.input) && parsed.input.length === 1;
}

function longResponsesInput(count: number) {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < count; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return input;
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

async function driveResponsesPreflight(proxyPort: number, upstreamPort: number, session: string, model: string, input: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session, ...extraHeaders },
        body: JSON.stringify({ model, stream: true, input }),
    });
}

function learnKey(url: string, model: string): string {
    return `${url}\u0000${model}`;
}

test("e2e #663 (order A, stream-first): learn both rejections, summary recovers, fold + forward OK, second request first-shot compatible", async () => {
    const calls: Call[] = [];
    const upstream = makeStreamFirstUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-6-astra": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}/responses`;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s663-resp-a", "gpt-6-astra", longResponsesInput(12));
        assert.equal(r.status, 200, `first request must succeed, got ${r.status}`);

        const summaries = calls.filter((c) => c.summary);
        // Learning sequence: non-stream + max (400 stream) → stream + max
        // (400 unsupported parameter) → stream, no max (200). The payload
        // needs multiple folds to fit, so further summaries follow — every
        // one after the two rejections must already be first-shot compatible.
        assert.ok(summaries.length >= 3, `expected at least 3 summary attempts, got ${JSON.stringify(summaries)}`);
        assert.deepEqual(
            summaries.slice(0, 3).map((c) => [c.stream, c.maxOutputTokens !== undefined]),
            [
                [false, true],
                [true, true],
                [true, false],
            ],
            `unexpected learning sequence: ${JSON.stringify(summaries)}`,
        );
        assert.ok(
            summaries.slice(2).every((c) => c.stream && c.maxOutputTokens === undefined),
            `every summary after the two rejections must be first-shot compatible, got ${JSON.stringify(summaries)}`,
        );
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");

        const sess = listSessions().find((s) => s.id.includes("s663-resp-a"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightStreamSummary, true, "stream preference learned on the session");
        const learned = sess?.metadata?.preflightNoMaxOutputTokens as Record<string, unknown> | undefined;
        assert.ok(learned && typeof learned === "object", "max_output_tokens rejection learned on the session");
        assert.equal(learned?.[learnKey(upstreamUrl, "gpt-6-astra")], true, "learning scoped to upstream URL + model");

        // Second request (grown over-window again): every summary call is
        // first-shot compatible — stream, no max_output_tokens.
        const callsBefore = calls.length;
        const r2 = await driveResponsesPreflight(proxyPort, upstreamPort, "s663-resp-a", "gpt-6-astra", longResponsesInput(24));
        assert.equal(r2.status, 200, `second request must succeed, got ${r2.status}`);
        const newSummaries = calls.slice(callsBefore).filter((c) => c.summary);
        assert.ok(newSummaries.length >= 1, "second request triggered preflight summaries");
        assert.ok(
            newSummaries.every((c) => c.stream && c.maxOutputTokens === undefined),
            `second-request summaries must be first-shot compatible, got ${JSON.stringify(newSummaries)}`,
        );
    } finally {
        proxy.close();
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

test("e2e #663 (order B, param-first): max_output_tokens rejected before stream — both learned, recovery OK", async () => {
    const calls: Call[] = [];
    const upstream = makeParamFirstUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-6-astra": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s663-resp-b", "gpt-6-astra", longResponsesInput(12));
        assert.equal(r.status, 200, `request must succeed, got ${r.status}`);

        const summaries = calls.filter((c) => c.summary);
        // Learning sequence: non-stream + max (400 unsupported parameter) →
        // non-stream, no max (400 stream) → stream, no max (200). Further
        // folds follow (see order A) — all first-shot compatible.
        assert.ok(summaries.length >= 3, `expected at least 3 summary attempts, got ${JSON.stringify(summaries)}`);
        assert.deepEqual(
            summaries.slice(0, 3).map((c) => [c.stream, c.maxOutputTokens !== undefined]),
            [
                [false, true],
                [false, false],
                [true, false],
            ],
            `unexpected learning sequence: ${JSON.stringify(summaries)}`,
        );
        assert.ok(
            summaries.slice(2).every((c) => c.stream && c.maxOutputTokens === undefined),
            `every summary after the two rejections must be first-shot compatible, got ${JSON.stringify(summaries)}`,
        );
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");
    } finally {
        proxy.close();
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

// Standard Responses provider: accepts max_output_tokens — the 8192 cap must
// be retained on every summary call, and NO capability may be learned.
function makeStandardUpstream(calls: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = parseBody(Buffer.concat(chunks).toString("utf8"));
            calls.push({ stream: parsed.stream === true, summary: isSummaryCall(parsed), maxOutputTokens: parsed.max_output_tokens, model: parsed.model });
            if (isSummaryCall(parsed)) respondSummary(res, parsed.stream === true);
            else forwardSse(res);
        });
    });
}

test("e2e #663 (standard provider): max_output_tokens retained, no capability learned", async () => {
    const calls: Call[] = [];
    const upstream = makeStandardUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-6-astra": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s663-resp-c", "gpt-6-astra", longResponsesInput(12));
        assert.equal(r.status, 200, `request must succeed, got ${r.status}`);

        const summaries = calls.filter((c) => c.summary);
        assert.ok(summaries.length >= 1, "preflight summaries happened");
        assert.ok(
            summaries.every((c) => c.maxOutputTokens === 8192),
            `every summary must keep the 8192 output limit, got ${JSON.stringify(summaries)}`,
        );
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");

        const sess = listSessions().find((s) => s.id.includes("s663-resp-c"));
        assert.ok(sess, "session recorded");
        assert.notEqual(sess?.metadata?.preflightNoMaxOutputTokens, true, "no max_output_tokens learning for a standard provider");
        assert.equal((sess?.metadata?.preflightNoMaxOutputTokens as Record<string, unknown> | undefined)?.[learnKey(`http://127.0.0.1:${upstreamPort}/responses`, "gpt-6-astra")], undefined, "no per-endpoint learning recorded");
        assert.equal(sess?.metadata?.preflightStreamSummary, undefined, "no stream learning for a standard provider");
    } finally {
        proxy.close();
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

// Model scoping: model A (same endpoint) rejects max_output_tokens, model B
// accepts it. Learning for A must NOT strip the cap from B's summaries.
function makeModelSplitUpstream(calls: Call[]): http.Server {
    return makePickyUpstream(calls, (p) => {
        if (p.model === "gpt-6-astra" && p.max_output_tokens !== undefined) return { detail: "Unsupported parameter: max_output_tokens" };
        return null;
    });
}

test("e2e #663 (model scoping): rejection learned for model A keeps model B's 8192 cap", async () => {
    const calls: Call[] = [];
    const upstream = makeModelSplitUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-6-astra": { context: 10_000 }, "gpt-6-standard": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const upstreamUrl = `http://127.0.0.1:${upstreamPort}/responses`;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s663-resp-d", "gpt-6-astra", longResponsesInput(12));
        assert.equal(r.status, 200, `first request (model A) must succeed, got ${r.status}`);
        const astraSummaries = calls.filter((c) => c.summary && c.model === "gpt-6-astra");
        // Model A accepts non-stream, so the first attempt is non-stream +
        // cap (rejected), then every retry — however many folds the payload
        // needs — is non-stream without the cap.
        assert.ok(astraSummaries.length >= 2, `model A: one rejected attempt + at least one retry, got ${JSON.stringify(astraSummaries)}`);
        assert.equal(astraSummaries[0].maxOutputTokens, 8192, "model A first attempt carries the cap");
        assert.ok(
            astraSummaries.slice(1).every((c) => c.maxOutputTokens === undefined),
            `every model A retry must drop the cap, got ${JSON.stringify(astraSummaries)}`,
        );

        // Same session, different model: preflight must fire again (grown
        // over-window) and model B's summary keeps the cap.
        const callsBefore = calls.length;
        const r2 = await driveResponsesPreflight(proxyPort, upstreamPort, "s663-resp-d", "gpt-6-standard", longResponsesInput(24));
        assert.equal(r2.status, 200, `second request (model B) must succeed, got ${r2.status}`);
        const standardSummaries = calls.slice(callsBefore).filter((c) => c.summary);
        assert.ok(standardSummaries.length >= 1, "second request triggered preflight summaries");
        assert.ok(
            standardSummaries.every((c) => c.model === "gpt-6-standard" && c.maxOutputTokens === 8192),
            `model B summaries must keep the 8192 cap, got ${JSON.stringify(standardSummaries)}`,
        );

        const sess = listSessions().find((s) => s.id.includes("s663-resp-d"));
        const learned = sess?.metadata?.preflightNoMaxOutputTokens as Record<string, unknown> | undefined;
        assert.ok(learned && typeof learned === "object", "learning map recorded");
        assert.equal(learned?.[learnKey(upstreamUrl, "gpt-6-astra")], true, "model A key learned");
        assert.equal(learned?.[learnKey(upstreamUrl, "gpt-6-standard")], undefined, "model B key NOT learned");
    } finally {
        proxy.close();
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

// #663 (follow-up): the main Codex request carries the request-shape-specific
// x-openai-internal-codex-responses-lite header (its body has
// reasoning.context: all_turns). requestSummary used to copy ALL main-request
// headers into its independently-built summary body (no reasoning field), so
// the backend rejected the summary: 400 "…requires `reasoning.context` to be
// `all_turns`". The fix strips that one header from the summary call only — the
// main request keeps it. These tests record the exact headers the proxy sends
// on each upstream call and assert the separation.
type HeaderCall = { summary: boolean; headers: http.IncomingHttpHeaders };

// Records req.headers per upstream call; always succeeds, so the assertions
// are purely about which headers ride each call.
function makeHeaderRecordingUpstream(calls: HeaderCall[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = parseBody(Buffer.concat(chunks).toString("utf8"));
            calls.push({ summary: isSummaryCall(parsed), headers: req.headers });
            if (isSummaryCall(parsed)) respondSummary(res, parsed.stream === true);
            else forwardSse(res);
        });
    });
}

test("e2e #663 (codex lite header): summary drops the Lite header, main request keeps it; auth preserved", async () => {
    const calls: HeaderCall[] = [];
    const upstream = makeHeaderRecordingUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-6-astra": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponsesPreflight(proxyPort, upstreamPort, "s663-lite", "gpt-6-astra", longResponsesInput(12), {
            "x-openai-internal-codex-responses-lite": "true",
            "authorization": "Bearer test-token",
        });
        assert.equal(r.status, 200, `request must succeed, got ${r.status}`);

        const summaries = calls.filter((c) => c.summary);
        const forwards = calls.filter((c) => !c.summary);
        assert.ok(summaries.length >= 1, "preflight summaries happened");
        assert.ok(forwards.length >= 1, "the folded payload was forwarded");

        // The summary body is built independently (no reasoning.context), so it
        // must NOT carry the request-shape-specific Lite header — but it must
        // keep auth so the side call can authenticate.
        for (const c of summaries) {
            assert.equal(c.headers["x-openai-internal-codex-responses-lite"], undefined, `summary call must drop the Lite header, got ${JSON.stringify(Object.keys(c.headers))}`);
            assert.equal(c.headers["authorization"], "Bearer test-token", "summary call must keep the auth header");
        }
        // The main forwarded request keeps the Lite header (its body has
        // reasoning.context: all_turns) and auth.
        for (const c of forwards) {
            assert.equal(c.headers["x-openai-internal-codex-responses-lite"], "true", "main request must keep the Lite header");
            assert.equal(c.headers["authorization"], "Bearer test-token", "main request must keep the auth header");
        }
    } finally {
        proxy.close();
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

// #663 (follow-up): the strip is keyed on the Codex Lite header, so it must be
// a no-op for protocols that never send it. Anthropic preflight stays
// untouched: the summary call keeps its auth header and the fold + forward
// still succeed.
type AnthHeaderCall = { summary: boolean; headers: http.IncomingHttpHeaders };

function makeAnthropicHeaderUpstream(calls: AnthHeaderCall[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; messages?: unknown[] } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = Array.isArray(parsed.messages) && parsed.messages.length === 1;
            calls.push({ summary: isSummary, headers: req.headers });
            const text = isSummary ? SUMMARY_TEXT : "ok";
            if (parsed.stream === true) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 100 } } })}\n\n`);
                res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
                res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`);
                res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
                res.end();
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ content: [{ type: "text", text }] }));
            }
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

test("e2e #663 (anthropic): header strip is a no-op — summary keeps auth, fold + forward OK", async () => {
    const calls: AnthHeaderCall[] = [];
    const upstream = makeAnthropicHeaderUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "claude-test": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "s663-anth", "x-api-key": "test-key" },
            body: JSON.stringify({ model: "claude-test", stream: true, max_tokens: 1024, system: "You are a test assistant.", messages: longAnthropicMessages() }),
        });
        assert.equal(r.status, 200, `request must succeed, got ${r.status}`);

        const summaries = calls.filter((c) => c.summary);
        const forwards = calls.filter((c) => !c.summary);
        assert.ok(summaries.length >= 1, "preflight summaries happened");
        assert.ok(forwards.length >= 1, "the folded payload was forwarded");

        // Anthropic never sends the Codex Lite header, so the strip is a no-op:
        // the summary call keeps its auth header untouched.
        for (const c of summaries) {
            assert.equal(c.headers["x-api-key"], "test-key", "anthropic summary call must keep its auth header");
            assert.equal(c.headers["x-openai-internal-codex-responses-lite"], undefined, "no Lite header present for anthropic");
        }
        for (const c of forwards) {
            assert.equal(c.headers["x-api-key"], "test-key", "anthropic main request keeps its auth header");
        }
    } finally {
        proxy.close();
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});
