import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_REPLAY_RETRY_MAX = "1";
// Zero backoff so the transient-retry legs run instantly.
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
process.env.BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS = "400";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { diagnoseEmptySummary, emptySummaryIsSizeDriven } from "../src/preflight.ts";

// #1767 regression: a flash summarizer (deepseek/deepseek-v4.1-flash behind a
// gateway) answered the preflight summary call with HTTP 200 plain JSON whose
// content was EMPTY (finish_reason=content_filter). Preflight treated every
// empty summary as size-driven (halving cascade, #726) — but a single-message
// span cannot be halved, so the ONLY range that could fit the payload got
// exactly one doomed draw, the turn fail-fasted 502 in-band, and the user had
// to send 继续 to re-trigger preflight 90s later when the filter cleared.
// Empty summaries with no size signal are TRANSIENT: retry the same span a
// bounded number of times before giving up.

const SUMMARY_TEXT =
    "#1767 TEST SUMMARY: the segment held a large tool output plus several short turns; the raw payload is derivable, so the folded view loses nothing of value.";

type Call = { summary: boolean; failed: boolean };

function sse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function okSummarySse(res: http.ServerResponse): void {
    for (const part of [SUMMARY_TEXT.slice(0, 40), SUMMARY_TEXT.slice(40)]) {
        res.write(sse("response.output_text.delta", { type: "response.output_text.delta", delta: part }));
    }
    res.write(sse("response.completed", { type: "response.completed", response: { id: "resp_sum", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5 } } }));
    res.end();
}

// The incident shape: HTTP 200, plain JSON, empty content, content_filter.
function contentFilterJson(res: http.ServerResponse): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
        id: "chatcmpl-cf", object: "chat.completion", model: "deepseek/deepseek-v4.1-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    }));
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

type ParsedBody = { stream?: boolean; instructions?: unknown; input?: unknown };

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

// failFirstN: the first N summary calls answer with the content_filter shape,
// the rest succeed. failAll: every summary call fails.
function makeUpstream(calls: Call[], failFirstN: number, failAll: boolean): http.Server {
    let summarySeen = 0;
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = parseBody(Buffer.concat(chunks).toString("utf8"));
            const summary = isSummaryCall(parsed);
            const failed = summary && (failAll || summarySeen < failFirstN);
            if (summary) summarySeen += 1;
            calls.push({ summary, failed });
            if (failed) {
                contentFilterJson(res);
                return;
            }
            if (summary) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                okSummarySse(res);
            } else {
                forwardSse(res);
            }
        });
    });
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

async function driveResponses(proxyPort: number, upstreamPort: number, session: string, model: string, input: unknown): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model, stream: true, input }),
    });
}

// One giant tool output sitting OUTSIDE the soft-protected recent zone,
// followed by a short tail. The giant item is a single message: span halving
// cannot shrink it, so recovery is impossible unless the failed draw is
// retried. This is the exact #1767 geometry (m02079, ~136K tokens of tool).
function giantToolInput(): unknown[] {
    const big = "TOOL_OUTPUT_LINE ".repeat(5_000);
    return [
        { type: "function_call", name: "bash", arguments: "{\"command\":\"make test\"}" },
        { type: "function_call_output", output: big },
        { type: "message", role: "user", content: "what did that produce?" },
        { type: "message", role: "assistant", content: "a very long log" },
        { type: "message", role: "user", content: "ok ignore the tail" },
        { type: "message", role: "assistant", content: "sure" },
        { type: "message", role: "user", content: "final question here" },
    ];
}

test("#1767 transient content_filter empties: same-span retries recover the turn without a client retry", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 2, false);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s1767-recover", "gpt-7-sol", giantToolInput());
        const body = await r.text();
        assert.equal(r.status, 200, `same-span retries must recover the turn, got ${r.status}: ${body.slice(0, 300)}`);

        const summaries = calls.filter((c) => c.summary);
        const failed = summaries.filter((c) => c.failed);
        assert.equal(failed.length, 2, `exactly the two scripted content_filter draws may fail, got ${JSON.stringify(summaries)}`);
        assert.ok(summaries.length >= 3, `a third draw must follow the two failures, got ${summaries.length}`);
        assert.ok(summaries.some((c) => !c.failed), "a successful summary must exist");
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");

        const sess = listSessions().find((s) => s.id.includes("s1767-recover"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "successful preflight must not leave a dead-end marker");
    } finally {
        proxy.close();
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

// Plain-text over-window history (the #726 shape): unlike tool outputs, prose
// messages survive the outbound fold at full size, so the retry request also
// fails the fit gate and must hit the dead-end cooldown instead of forwarding.
function longPlainInput(): unknown[] {
    const items: unknown[] = [];
    for (let i = 0; i < 12; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        items.push({ type: "message", role, content: `Message ${i} of the long conversation. ${`MARKER_${i}_content_`.repeat(250)}` });
    }
    return items;
}

test("#1767 systemic content_filter: bounded summary calls, diagnosis surfaced, dead-end arms, nothing forwarded", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 0, true);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s1767-deadend", "gpt-7-sol", longPlainInput());
        assert.equal(r.status, 502, `systemic failure must fail-fast, got ${r.status}`);
        const j = (await r.json()) as { error?: { code?: string; message?: string } };
        assert.equal(j.error?.code, "preflight_compress_failed");
        assert.ok(
            j.error?.message?.includes("finish_reason=content_filter"),
            `fail-fast message must carry the content_filter diagnosis, got: ${j.error?.message}`,
        );
        const summaries = calls.filter((c) => c.summary);
        // Two protection regimes x the 16-call per-regime ceiling bounds the walk
        // even though every draw is now retried twice more.
        assert.ok(summaries.length >= 2 && summaries.length <= 32, `summary calls must stay bounded, got ${summaries.length}`);
        assert.ok(!calls.some((c) => !c.summary), "nothing may be forwarded on failure");

        const sess = listSessions().find((s) => s.id.includes("s1767-deadend"));
        assert.ok(sess?.metadata?.preflightDeadEnd, "zero-progress failure must arm the dead-end marker");

        const callsBeforeRetry = calls.length;
        const r2 = await driveResponses(proxyPort, upstreamPort, "s1767-deadend", "gpt-7-sol", longPlainInput());
        assert.equal(r2.status, 502, `cooldown must fail fast, got ${r2.status}`);
        await r2.text();
        assert.equal(calls.length, callsBeforeRetry, "cooldown must spend ZERO upstream calls");
    } finally {
        proxy.close();
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

test("#1767 empty-summary classifier: transient vs size-driven", () => {
    // The incident shape: plain-JSON completion, empty content, content_filter.
    const cf = JSON.stringify({
        id: "chatcmpl-cf", object: "chat.completion", model: "deepseek/deepseek-v4.1-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "content_filter" }],
    });
    const cfDetail = diagnoseEmptySummary(cf, JSON.parse(cf));
    assert.match(cfDetail, /plain-JSON completion with empty content \(finish_reason=content_filter, answered as model=deepseek\/deepseek-v4\.1-flash\)/);
    assert.equal(emptySummaryIsSizeDriven(cfDetail), false, "content_filter empty completion is transient");
    const len = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "length" }] });
    assert.equal(emptySummaryIsSizeDriven(diagnoseEmptySummary(len, JSON.parse(len))), true, "finish_reason=length is size-driven");
    const mt = JSON.stringify({ id: "msg_1", model: "claude-x", content: [], stop_reason: "max_tokens" });
    assert.equal(emptySummaryIsSizeDriven(diagnoseEmptySummary(mt, JSON.parse(mt))), true, "stop_reason=max_tokens is size-driven");
    const cl = sse("response.failed", { type: "response.failed", response: { status: "failed", error: { code: "context_length_exceeded", message: "Input is too long." } } });
    assert.equal(emptySummaryIsSizeDriven(diagnoseEmptySummary(cl)), true, "context_length_exceeded is size-driven");
    assert.equal(emptySummaryIsSizeDriven(diagnoseEmptySummary(sse("response.incomplete", { type: "response.incomplete", response: { status: "incomplete", error: { message: "cut off" } } }))), false, "incomplete stream is transient");
    assert.equal(emptySummaryIsSizeDriven(diagnoseEmptySummary(sse("error", { type: "error", error: { message: "boom" } }))), false, "in-stream error is transient");
    assert.equal(emptySummaryIsSizeDriven(diagnoseEmptySummary("")), false, "empty body is transient");
    // #780 truncation shape: complete frames plus a half-line cut mid-JSON.
    const truncated = sse("response.output_text.delta", { type: "response.output_text.delta", delta: "abcd" })
        + sse("response.output_text.delta", { type: "response.output_text.delta", delta: "efgh" })
        + `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "tail" }).slice(0, 30)}\n`;
    assert.equal(emptySummaryIsSizeDriven(diagnoseEmptySummary(truncated)), false, "truncated stream is transient");
});
