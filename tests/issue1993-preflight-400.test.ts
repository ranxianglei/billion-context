import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on 4xx retries so rejections surface immediately.
process.env.BILI_REPLAY_RETRY_MAX = "1";
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
// Short dead-end cooldown so the expiry leg stays fast.
process.env.BILI_PREFLIGHT_DEAD_END_COOLDOWN_MS = "400";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

// #1993: a preflight summarization call answered HTTP 400 left the session
// wedged and undiagnosable — the response body was never logged or dumped,
// there was no chunk-shrink fallback (unlike the unusable-HTTP-200 path), and
// the turn fail-fasted 502 retryable=false with a dead-end cooldown. These
// tests pin: (a) the rejection body is logged AND surfaced in the client
// message, (b) hard size-plausible 400/413 get the same halving recovery as an
// unusable 200 while transient/auth/routing 4xx keep their old semantics,
// (c) BILI_DUMP_4XX persists the full summary exchange (request + response),
// (d) the dead-end cooldown only arms after the shrink cascade is genuinely
// exhausted with zero progress.

const SUMMARY_TEXT =
    "PREFLIGHT-400 TEST SUMMARY: the segment held a deterministic load-growth payload across several turns; every raw marker is derivable from the seed, so the folded view loses nothing of value.";

// No transient marker ("rate limit", "try again", ...), no stream/max_output_tokens
// adaptation trigger — a plain hard rejection.
const SYSTEMIC_400_BODY = '{"error":{"message":"request too large: 523200 tokens exceeds the 128000 input limit"}}';
const FAIL_ABOVE_CHARS = 16_000;

type Call = { stream: boolean; summary: boolean; contentChars: number };

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

// Summary calls over failAboveChars get `rejectStatus` + rejectBody; everything
// else is summarized normally. failAboveChars=0 makes every summary call reject.
function makeUpstream(calls: Call[], failAboveChars: number, rejectStatus: number, rejectBody: string, forwardInputTokens = 800): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = parseBody(Buffer.concat(chunks).toString("utf8"));
            const contentChars = isSummaryCall(parsed) ? inputContentChars(parsed) : 0;
            calls.push({ stream: parsed.stream === true, summary: isSummaryCall(parsed), contentChars });
            if (isSummaryCall(parsed)) {
                if (contentChars > failAboveChars) {
                    res.writeHead(rejectStatus, { "content-type": "application/json" });
                    res.end(rejectBody);
                    return;
                }
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                okSummarySse(res);
                return;
            }
            forwardSse(res, forwardInputTokens);
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

function startProxy(upstreamPort: number, models: Record<string, { context: number }>, log = false): Promise<http.Server> {
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
        log,
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

async function closeAll(...servers: http.Server[]): Promise<void> {
    servers.forEach((s) => s.close());
    await new Promise<void>((resolve, reject) => {
        void Promise.allSettled(servers.map((s) => once(s, "close"))).then(() => resolve(), reject);
    });
}

test("#1993 systemic hard 400: body surfaced in log+message, bounded halving cascade, cooldown arms after exhaustion", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 0, 400, SYSTEMIC_400_BODY);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r1 = await driveResponses(proxyPort, upstreamPort, "s1993-systemic", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r1.status, 502, `systemic hard 400 must fail-fast, got ${r1.status}`);
        const j1 = (await r1.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
        assert.equal(j1.error?.code, "preflight_compress_failed");
        assert.equal(j1.error?.retryable, false);
        assert.ok(
            j1.error?.message?.includes("rejected by the upstream (HTTP 400)"),
            `fail-fast message must name the rejection, got: ${j1.error?.message}`,
        );
        // The core of #1993: WHY the upstream said no must reach the operator.
        assert.ok(
            j1.error?.message?.includes("request too large: 523200 tokens exceeds the 128000 input limit"),
            `fail-fast message must carry the rejection body snippet, got: ${j1.error?.message}`,
        );
        const summaries = calls.filter((c) => c.summary);
        // More than one call proves the halving cascade ran instead of the old
        // instant give-up; the ceiling is the per-preflight budget.
        assert.ok(summaries.length >= 2 && summaries.length <= 16, `summary calls must be bounded by the cascade, got ${summaries.length}: ${JSON.stringify(summaries)}`);
        assert.ok(!calls.some((c) => !c.summary), "nothing may be forwarded on failure");

        const sess = listSessions().find((s) => s.id.includes("s1993-systemic"));
        const marker = sess?.metadata.preflightDeadEnd as Record<string, unknown> | undefined;
        assert.ok(marker && typeof marker === "object", "exhausted zero-progress 400 cascade must arm the dead-end marker");
        assert.match(String(marker?.key), /^gpt-7-sol\u000010000\u0000[0-9a-f]{64}$/, "marker scoped to model, window and request body");

        const callsBeforeRetry = calls.length;
        const r2 = await driveResponses(proxyPort, upstreamPort, "s1993-systemic", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r2.status, 502, `cooldown must fail fast, got ${r2.status}`);
        const j2 = (await r2.json()) as { error?: { message?: string } };
        assert.equal(j2.error?.message, j1.error?.message, "cooldown replays the cached diagnosis");
        assert.equal(calls.length, callsBeforeRetry, "cooldown must spend ZERO upstream calls");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("#1993 size-driven 400: oversized chunk rejected, halved chunk recovers, session continues", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, FAIL_ABOVE_CHARS, 400, SYSTEMIC_400_BODY);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s1993-recover", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r.status, 200, `request must recover via smaller chunks, got ${r.status}`);
        await r.text();

        const summaries = calls.filter((c) => c.summary);
        const failed = summaries.filter((c) => c.contentChars > FAIL_ABOVE_CHARS);
        const succeeded = summaries.filter((c) => c.contentChars <= FAIL_ABOVE_CHARS);
        assert.ok(failed.length >= 1, `expected at least one oversized rejected summary, got ${JSON.stringify(summaries)}`);
        assert.ok(succeeded.length >= 1, `expected recovered smaller summaries, got ${JSON.stringify(summaries)}`);
        assert.ok(
            summaries.indexOf(failed[0]!) < summaries.indexOf(succeeded[0]!),
            `halved retry must follow the rejected chunk, got ${JSON.stringify(summaries)}`,
        );
        assert.ok(calls.some((c) => !c.summary), "the folded payload was forwarded");

        const sess = listSessions().find((s) => s.id.includes("s1993-recover"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "recovered preflight must not leave a dead-end marker");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("#1993 non-size 4xx does not shrink: 401 fails fast after exactly one summary call", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 0, 401, '{"error":"unauthorized"}');
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s1993-auth", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r.status, 502, `auth rejection must fail-fast, got ${r.status}`);
        const j = (await r.json()) as { error?: { message?: string; retryable?: boolean } };
        assert.equal(j.error?.retryable, false);
        assert.ok(j.error?.message?.includes("rejected by the upstream (HTTP 401)"), `got: ${j.error?.message}`);
        const summaries = calls.filter((c) => c.summary);
        assert.equal(summaries.length, 1, `401 must not burn the budget on halving, got ${summaries.length} calls`);
        const sess = listSessions().find((s) => s.id.includes("s1993-auth"));
        assert.ok(sess?.metadata?.preflightDeadEnd, "zero-progress auth rejection must arm the dead-end marker");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("#1993 warn log carries the rejection body snippet and the halving decision", async () => {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 0, 400, SYSTEMIC_400_BODY);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } }, true);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s1993-log", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r.status, 502);
        await r.text();
        assert.ok(
            lines.some((l) => l.includes("[preflight] summarization failed: HTTP 400") && l.includes("request too large: 523200")),
            `warn log must carry the rejection body snippet, got: ${lines.filter((l) => l.includes("summarization failed")).join(" | ")}`,
        );
        assert.ok(
            lines.some((l) => /\[preflight\] chunk m\d+:m\d+ rejected with HTTP 400; retrying with smaller chunks/.test(l)),
            `warn log must record the halving decision`,
        );
    } finally {
        setLogCapture(null);
        await closeAll(proxy, upstream);
    }
});

test("#1993 BILI_DUMP_4XX persists the rejected summary exchange (request + response)", async () => {
    const savedGate = process.env.BILI_DUMP_4XX;
    const savedDir = process.env.ACP_DUMP_DIR;
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-summary-dump-"));
    process.env.BILI_DUMP_4XX = "1";
    process.env.ACP_DUMP_DIR = dumpDir;
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, 0, 400, SYSTEMIC_400_BODY);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort, { "gpt-7-sol": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await driveResponses(proxyPort, upstreamPort, "s1993-dump", "gpt-7-sol", longResponsesInput(12));
        assert.equal(r.status, 502);
        await r.text();

        const files = fs.readdirSync(dumpDir).filter((f) => f.startsWith("summary-err-") && f.endsWith("-400.json"));
        assert.ok(files.length >= 1, `expected at least one summary-err dump, dir has: ${JSON.stringify(fs.readdirSync(dumpDir))}`);
        const parsed = JSON.parse(fs.readFileSync(path.join(dumpDir, files[0]!), "utf8")) as { status: number; request: unknown; response: unknown };
        assert.equal(parsed.status, 400);
        assert.ok(typeof parsed.request === "string" && parsed.request.includes("instructions"), "dump must carry the request bytes");
        assert.ok(typeof parsed.response === "string" && parsed.response.includes("request too large: 523200"), "dump must carry the response bytes");
    } finally {
        if (savedGate === undefined) delete process.env.BILI_DUMP_4XX;
        else process.env.BILI_DUMP_4XX = savedGate;
        if (savedDir === undefined) delete process.env.ACP_DUMP_DIR;
        else process.env.ACP_DUMP_DIR = savedDir;
        await closeAll(proxy, upstream);
        rmrf(dumpDir);
    }
});
