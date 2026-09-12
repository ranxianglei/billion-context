import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on 4xx retries so the stream-learn path exercises immediately.
process.env.BILI_REPLAY_RETRY_MAX = "1";
// Short dead-end cooldown so the expiry leg of the #726 test stays fast.
process.env.BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS = "400";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { diagnoseEmptySummary } from "../src/preflight.ts";

// #726 regression: after the #626/#663 compatibility retries, a ChatGPT-backend
// summarization call can return HTTP 200 SSE carrying NO summary text (an
// in-stream error event / truncated stream). The proxy must (a) surface WHAT
// the body said instead of a bare "summary too short", (b) retry the failing
// chunk at smaller sizes before giving up on the range, and (c) stop client
// auto-retries from re-burning upstream quota on the identical doomed walk
// (per-session dead-end cooldown).

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

function makeUpstream(calls: Call[], failAboveChars: number): http.Server {
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
            if (failed) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                failedSummarySse(res);
                return;
            }
            if (isSummaryCall(parsed)) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                okSummarySse(res);
            } else {
                forwardSse(res);
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
        upstream.close();
        await new Promise<void>((resolve, reject) => {
            void Promise.allSettled([once(proxy, "close"), once(upstream, "close")]).then(() => resolve(), reject);
        });
    }
});

test("#726 systemic empty summary: diagnosis surfaced, bounded calls, cooldown blocks retries, expiry re-runs", async () => {
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
        assert.ok(
            j1.error?.message?.includes("restarting the session recovers immediately"),
            `fail-fast message must carry the recovery hint, got: ${j1.error?.message}`,
        );
        const summaries1 = calls.filter((c) => c.summary);
        assert.ok(summaries1.length >= 2 && summaries1.length <= 9, `summary calls must be bounded, got ${summaries1.length}: ${JSON.stringify(summaries1)}`);
        assert.ok(!calls.some((c) => !c.summary), "nothing may be forwarded on failure");

        const sess = listSessions().find((s) => s.id.includes("s726-deadend"));
        const marker = sess?.metadata?.preflightDeadEnd as Record<string, unknown> | undefined;
        assert.ok(marker && typeof marker === "object", "zero-progress failure must arm the dead-end marker");
        assert.equal(marker?.key, "gpt-7-sol\u000010000", "marker scoped to model + window");

        const callsBeforeRetry = calls.length;
        const r2 = await driveResponses(proxyPort, upstreamPort, "s726-deadend", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r2.status, 502, `cooldown must fail fast, got ${r2.status}`);
        const j2 = (await r2.json()) as { error?: { code?: string; message?: string } };
        assert.equal(j2.error?.code, "preflight_compress_failed");
        assert.equal(j2.error?.message, j1.error?.message, "cooldown replays the cached diagnosis");
        assert.equal(calls.length, callsBeforeRetry, "cooldown must spend ZERO upstream calls");

        await new Promise((resolve) => setTimeout(resolve, 450));
        const callsBeforeExpire = calls.length;
        const r3 = await driveResponses(proxyPort, upstreamPort, "s726-deadend", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r3.status, 502, `post-expiry retry must fail again, got ${r3.status}`);
        assert.ok(calls.length > callsBeforeExpire, "after the cooldown expires the walk must run again");
    } finally {
        proxy.close();
        upstream.close();
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
