import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on 4xx retries so the stream-learn path exercises immediately.
process.env.BILI_REPLAY_RETRY_MAX = "1";
// Zero backoff so #1767's transient-retry legs (truncation is now retried) run instantly.
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
// #3274/#4079: the #726 dead-end cooldown this file pinned is REMOVED —
// retries now re-run a bounded walk with no cached diagnosis and no marker.

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { diagnoseEmptySummary } from "../src/preflight.ts";

// #726 regression: after the #626/#663 compatibility retries, a ChatGPT-backend
// summarization call can return HTTP 200 SSE carrying NO summary text (an
// in-stream error event / truncated stream). The proxy must (a) surface WHAT
// the body said instead of a bare "summary too short", (b) retry the failing
// chunk at smaller sizes before giving up on the range. (#4079: the #726
// cooldown that used to stop client auto-retries is removed — the bounded
// walk itself plus retryable:false is the whole contract now.)

const SUMMARY_TEXT =
    "EMPTY-SUMMARY TEST SUMMARY: the segment held a deterministic load-growth payload across several turns; every raw marker is derivable from the seed, so the folded view loses nothing of value.";

const FAIL_ABOVE_CHARS = 16_000;

type Call = { stream: boolean; summary: boolean; contentChars: number; failed: boolean };

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function failedSummarySse(res: http.ServerResponse): void {
    res.write(sse("response.failed", {
        type: "response.failed",
        response: { id: "resp_fail", status: "failed", error: { code: "context_length_exceeded", message: "Input is too long for this model." } },
    }));
    res.end();
}

function okSummarySse(res: http.ServerResponse): void {
    for (const part of [SUMMARY_TEXT.slice(0, 40), SUMMARY_TEXT.slice(40)]) {
        res.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: part }));
    }
    res.write(sse("response.completed", { type: "response.completed", response: { id: "resp_sum", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5 } } }));
    res.end();
}

// #780: two complete delta frames, then a half-line cut mid-JSON — no
// completed terminal, no final frame terminator (#764 gateway-corruption shape).
// The extractor must reject this as unusable rather than persist the partial text.
function truncatedSummarySse(res: http.ServerResponse): void {
    res.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: SUMMARY_TEXT.slice(0, 40) }));
    res.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: SUMMARY_TEXT.slice(40, 80) }));
    res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "tail" }).slice(0, 30)}\n`);
    res.end();
}

function forwardSse(res: http.ServerResponse, inputTokens = 800): void {
    res.write(sse("response.completed", {
        type: "response.completed",
        response: {
            id: "resp_fwd",
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
            usage: { input_tokens: inputTokens, output_tokens: 4 },
        },
    }));
    res.end();
}

type ParsedBody = { stream?: boolean; instructions?: unknown; input?: unknown; model?: string };

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

function inputContentChars(parsed: ParsedBody): number {
    const first = Array.isArray(parsed.input) ? parsed.input[0] : undefined;
    const c = first && typeof first === "object" ? (first as Record<string, unknown>).content : undefined;
    return typeof c === "string" ? c.length : 0;
}

function makeUpstream(calls: Call[], failAboveChars: number, forwardInputTokens = 800, truncateSummaries = false): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = parseBody(Buffer.concat(chunks).toString("utf8"));
            const contentChars = isSummaryCall(parsed) ? inputContentChars(parsed) : 0;
            const failed = isSummaryCall(parsed) && contentChars > failAboveChars;
            calls.push({ stream: parsed.stream === true, summary: isSummaryCall(parsed), contentChars, failed });
            if (isSummaryCall(parsed) && parsed.stream !== true) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ detail: "Stream must be set to true" }));
                return;
            }
            if (truncateSummaries && isSummaryCall(parsed)) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                truncatedSummarySse(res);
                return;
            }
            if (failed) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                failedSummarySse(res);
                return;
            }
            if (isSummaryCall(parsed)) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                okSummarySse(res);
            } else {
                forwardSse(res, forwardInputTokens);
            }
        });
    });
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
autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

async function driveResponses(proxyPort: number, upstreamPort: number, session: string, model: string, input: unknown): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model, stream: true, input }),
    });
}

test("(#4079) no dead-end cooldown: retries — identical or changed — re-run the walk, no marker persists", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 0);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const input = longResponsesInput(12);
        const first = await driveResponses(proxyPort, upstreamPort, "changed-cooldown", "gpt-7-sol", input);
        assert.equal(first.status, 502);
        await first.text();
        const session = listSessions().find((s) => s.id.includes("changed-cooldown"));
        // The old cooldown's body-hash keying is gone with the mechanism: the
        // retry below is byte-identical and must still re-run preflight —
        // freezing identical retries for minutes was #3974's uninstall event.
        assert.equal(session?.metadata?.preflightDeadEnd, undefined, "no dead-end marker may persist (#4079)");
        const callsBefore = calls.length;
        const identical = await driveResponses(proxyPort, upstreamPort, "changed-cooldown", "gpt-7-sol", input);
        assert.equal(identical.status, 502);
        await identical.text();
        assert.ok(calls.length > callsBefore, "an identical retry re-runs the bounded walk (no cooldown freeze)");
        const callsBeforeChange = calls.length;
        input[8].content = input[8].content.replace("Message", "Updated");
        const changed = await driveResponses(proxyPort, upstreamPort, "changed-cooldown", "gpt-7-sol", input);
        assert.equal(changed.status, 502);
        await changed.text();
        assert.ok(calls.length > callsBeforeChange, "changed content retries preflight too");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await Promise.all([once(proxy, "close"), once(upstream, "close")]);
    }
});

for (const [status, responseBody] of [
    [503, { error: "Temporary failure" }],
    [400, { code: 3007, msg: "captcha verify failed" }],
] as const) {
test(`temporary summary HTTP ${status} failure does not cache a deterministic dead end`, async () => {
    let calls = 0;
    const upstream = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            calls++;
            res.writeHead(status, { "content-type": "application/json" });
            res.end(JSON.stringify(responseBody));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const first = await driveResponses(proxyPort, upstreamPort, "transient-cooldown", "gpt-7-sol", longResponsesInput(12));
        const body = await first.json() as { error: { retryable: boolean } };
        assert.equal(body.error.retryable, true);
        const session = listSessions().find((s) => s.id.includes("transient-cooldown"));
        assert.equal(session?.metadata.preflightDeadEnd, undefined);
        const callsBefore = calls;
        const next = await driveResponses(proxyPort, upstreamPort, "transient-cooldown", "gpt-7-sol", longResponsesInput(12));
        await next.text();
        assert.ok(calls > callsBefore, "next request must reach the upstream");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        upstream.close();
        upstream.closeIdleConnections?.();
        await Promise.all([once(proxy, "close"), once(upstream, "close")]);
    }
});
}

test("#726 size-driven empty summary: oversized chunk fails, halved chunk recovers, session continues", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, FAIL_ABOVE_CHARS);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s726-recover", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r.status, 200, `request must recover via smaller chunks, got ${r.status}`);

        const summaries = calls.filter((c) => c.summary);
        const failed = summaries.filter((c) => c.failed);
        const succeeded = summaries.filter((c) => !c.failed);
        assert.ok(failed.length >= 1, `expected at least one oversized failed summary, got ${JSON.stringify(summaries)}`);
        assert.ok(failed.every((c) => c.contentChars > FAIL_ABOVE_CHARS), "only oversized chunks may fail");
        assert.ok(succeeded.length >= 1, `expected a recovered smaller summary, got ${JSON.stringify(summaries)}`);
        // The first failure must precede the recovery — halving walks oldest-first.
        assert.ok(
            summaries.indexOf(failed[0]) < summaries.indexOf(succeeded.find((c) => c.stream)!),
            `halved retry must follow the failed chunk, got ${JSON.stringify(summaries)}`,
        );
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");

        const sess = listSessions().find((s) => s.id.includes("s726-recover"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "successful preflight must not leave a dead-end marker");
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

test("#726 systemic empty summary: diagnosis surfaced, bounded calls, retries re-run a bounded walk with no marker", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 0);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r1 = await driveResponses(proxyPort, upstreamPort, "s726-deadend", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r1.status, 502, `systemic failure must fail-fast, got ${r1.status}`);
        const j1 = (await r1.json()) as { error?: { code?: string; message?: string } };
        assert.equal(j1.error?.code, "preflight_compress_failed");
        assert.ok(
            j1.error?.message?.includes("the upstream stream ended with a failed response (context_length_exceeded)"),
            `fail-fast message must carry the upstream diagnosis, got: ${j1.error?.message}`,
        );
        // (#4079) the cooldown recovery hint is gone with the mechanism.
        assert.ok(
            !j1.error?.message?.includes("cooldown"),
            `fail-fast message must not reference a removed cooldown, got: ${j1.error?.message}`,
        );
        const summaries1 = calls.filter((c) => c.summary);
        assert.ok(summaries1.length >= 2 && summaries1.length <= 9, `summary calls must be bounded, got ${summaries1.length}: ${JSON.stringify(summaries1)}`);
        assert.ok(!calls.some((c) => !c.summary), "nothing may be forwarded on failure");

        const sess = listSessions().find((s) => s.id.includes("s726-deadend"));
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "(#4079) no dead-end marker may persist");

        const callsBeforeRetry = calls.length;
        const r2 = await driveResponses(proxyPort, upstreamPort, "s726-deadend", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r2.status, 502, `the retry must fail fast again, got ${r2.status}`);
        const j2 = (await r2.json()) as { error?: { code?: string; message?: string } };
        assert.equal(j2.error?.code, "preflight_compress_failed");
        assert.ok(
            j2.error?.message?.includes("context_length_exceeded"),
            `the regenerated diagnosis carries the same core, got: ${j2.error?.message}`,
        );
        const retrySummaries = calls.slice(callsBeforeRetry).filter((c) => c.summary);
        assert.ok(retrySummaries.length >= 2 && retrySummaries.length <= 9, `the re-run walk is itself bounded (#4079 trade), got ${retrySummaries.length}`);

        // #3274 expiry leg removed with the cooldown (#4079): every retry
        // already re-runs the walk — there is no marker to expire.
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

test("#300 regression (was #726 cooldown side-pin): fitting payload under a stale-high baseline still goes out", async () => {
    const calls: Call[] = [];
    // failAboveChars=0 → every summary call fails; forwardInputTokens=15_000 lets
    // a successful turn seed a stale-high usage baseline above the 10_000 window (#300 shape).
    const upstream = makeUpstream(calls, 0, 15_000);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const seed = await driveResponses(proxyPort, upstreamPort, "s726-stale", "gpt-7-sol", longResponsesInput(1));
        assert.equal(seed.status, 200, `seed request must forward, got ${seed.status}`);
        let sess = listSessions().find((s) => s.id.includes("s726-stale"));
        assert.ok(sess && sess.stats.lastInputTokens >= 10_000, `seed must leave a high baseline, got ${sess?.stats.lastInputTokens}`);

        const r1 = await driveResponses(proxyPort, upstreamPort, "s726-stale", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r1.status, 502, `systemic failure must fail-fast, got ${r1.status}`);
        sess = listSessions().find((s) => s.id.includes("s726-stale"));
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "(#4079) no dead-end marker persists");

        // Same session, smaller payload: its own estimate fits the window; only
        // the stale baseline trips the trigger — the #300 safe-forward path
        // must let it through (the old cooldown once risked converting this
        // into a false 502; that hazard is now structurally impossible).
        const callsBeforeSmall = calls.length;
        const r2 = await driveResponses(proxyPort, upstreamPort, "s726-stale", "gpt-7-sol", [{ type: "message", role: "user", content: "small follow-up" }]);
        assert.equal(r2.status, 200, `fitting payload under a warm marker must still forward, got ${r2.status}`);
        assert.ok(calls.length > callsBeforeSmall && calls[calls.length - 1].summary === false, "the small payload was forwarded to the upstream");
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

test("#726 diagnoseEmptySummary: extracts terminal error signals from 200 bodies", () => {
    assert.match(
        diagnoseEmptySummary(sse("response.failed", { type: "response.failed", response: { status: "failed", error: { code: "context_length_exceeded", message: "Input is too long." } } })),
        /failed response \(context_length_exceeded\): Input is too long\./,
    );
    assert.match(
        diagnoseEmptySummary(sse("error", { type: "error", error: { message: "boom" } })),
        /in-stream error: boom/,
    );
    assert.match(
        diagnoseEmptySummary(sse("response.incomplete", { type: "response.incomplete", response: { status: "incomplete", error: { message: "cut off" } } })),
        /incomplete \(status=incomplete \(cut off\)\)/,
    );
    assert.match(
        diagnoseEmptySummary("", { error: { message: "bare json error" } }),
        /reported an error: bare json error/,
    );
    assert.equal(diagnoseEmptySummary(""), "the upstream returned an empty body");
    assert.match(
        diagnoseEmptySummary(sse("response.created", { type: "response.created", response: { id: "r1" } })),
        /carried 1 SSE event\(s\) but no summary text/,
    );
    assert.match(
        diagnoseEmptySummary('{"unrelated":"body"}'),
        /non-SSE body with no summary text/,
    );
});

// #987: an upstream that enforces input+output <= window answers the summary
// call with a plain-JSON completion whose content is EMPTY (observed on
// muse-spark behind a 9router alias). That is valid JSON — calling it "a
// non-SSE body" sends the operator looking for the wrong failure. The
// diagnosis must name the shape, the finish reason, and the model id the
// upstream answered as (the alias-vs-real-model mismatch is the clue).
test("#987 diagnoseEmptySummary names plain-JSON empty completions precisely", () => {
    const openai = JSON.stringify({
        id: "chatcmpl-1789806312367", object: "chat.completion", model: "muse-spark-1.3-contributor",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    });
    // #2832: the diagnosis now carries the block-level fingerprint — the
    // text_chars/text_blocks parts are what separate a thinking-only answer
    // from a relay that stripped the text.
    assert.match(
        diagnoseEmptySummary(openai, JSON.parse(openai)),
        /plain-JSON completion with empty content \(finish_reason=stop, text_chars=0, answered as model=muse-spark-1\.3-contributor\)/,
    );
    const anthropic = JSON.stringify({ id: "msg_1", model: "claude-x", content: [], stop_reason: "max_tokens" });
    assert.match(
        diagnoseEmptySummary(anthropic, JSON.parse(anthropic)),
        /plain-JSON completion with empty content \(stop_reason=max_tokens, text_blocks=0, answered as model=claude-x\)/,
    );
    // #2309: an explicit Responses terminal state now gets its own precise
    // diagnosis (the old string claimed "empty content", which is false when
    // partial text rides the body).
    const responses = JSON.stringify({ id: "resp_1", status: "incomplete", output: [] });
    assert.match(
        diagnoseEmptySummary(responses, JSON.parse(responses)),
        /incomplete Responses summary \(status=incomplete\)/,
    );
    // Unrecognized JSON keeps the generic diagnosis (shape guard).
    assert.match(
        diagnoseEmptySummary('{"unrelated":"body"}', { unrelated: "body" }),
        /non-SSE body with no summary text/,
    );
});

test("#780 truncated summary stream is unusable: diagnosis names truncation, bounded calls, retries re-run bounded, nothing forwarded", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 0, 800, true);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s780-trunc", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r.status, 502, `truncated summaries must fail-fast, got ${r.status}`);
        const j = (await r.json()) as { error?: { code?: string; message?: string } };
        assert.equal(j.error?.code, "preflight_compress_failed");
        assert.ok(
            j.error?.message?.includes("stream appears truncated"),
            `fail-fast message must carry the truncation diagnosis, got: ${j.error?.message}`,
        );
        const summaries = calls.filter((c) => c.summary);
        // #1767: truncation is now transient-classified, so each span gets up to
        // two extra same-span draws; the ceiling is 2 protection regimes x 16.
        assert.ok(summaries.length >= 2 && summaries.length <= 32, `summary calls must be bounded, got ${summaries.length}: ${JSON.stringify(summaries)}`);
        assert.ok(!calls.some((c) => !c.summary), "nothing may be forwarded on failure");

        const sess = listSessions().find((s) => s.id.includes("s780-trunc"));
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "(#4079) no dead-end marker persists");

        const callsBeforeRetry = calls.length;
        const r2 = await driveResponses(proxyPort, upstreamPort, "s780-trunc", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r2.status, 502, `the retry must fail fast again, got ${r2.status}`);
        const retrySummaries = calls.slice(callsBeforeRetry).filter((c) => c.summary);
        assert.ok(retrySummaries.length >= 2 && retrySummaries.length <= 32, `the re-run walk is itself bounded, got ${retrySummaries.length}`);
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
