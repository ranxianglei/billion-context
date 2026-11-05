import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
// Fail fast on 4xx retries so the stream-learn path exercises immediately.
process.env.BILI_REPLAY_RETRY_MAX = "1";
// Zero backoff so the transient-retry legs run instantly.
process.env.BILI_REPLAY_RETRY_BASE_MS = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { diagnoseEmptySummary, emptySummaryIsSizeDriven, extractSummaryText } from "../src/preflight.ts";

// #2309 regression: a Responses-compatible gateway answered the preflight
// summary call with HTTP 200 application/json declaring
// status="incomplete" / incomplete_details.reason="max_output_tokens" while
// still carrying partial final text. The SSE path already rejects those
// terminals (#780/#784); the JSON path had no terminal check, so any partial
// past MIN_SUMMARY_CHARS (50) sailed through requestSummary into a
// compression block and the forwarded history. Contract pinned here:
// (a) the extractor rejects explicit incomplete/failed JSON bodies whatever
// their text length (both the output[] walk and the flat output_text
// shortcut); (b) the diagnosis names the terminal precisely with the raw
// reason/error embedded; (c) reason=max_output_tokens classifies as
// size-driven (halving recovery), other reasons as transient (bounded
// same-span re-draw); (d) end-to-end in BOTH proxy and plugin modes the
// partial text never reaches the wire — only the recovered complete summary
// does; (e) a persistently-incomplete upstream fails fast carrying the
// diagnosis and fails fast (#4079: the cooldown itself is removed).

const PARTIAL = "PARTIAL SUMMARY: completed the first change; the unresolved requirements and remaining work are";
const FULL = "FULL SUMMARY: every change in the segment is complete; the previously unresolved requirements were resolved and no remaining work is left.";

assert.equal(PARTIAL.length, 95, "repro partial must stay above MIN_SUMMARY_CHARS (50)");
assert.ok(FULL.length >= 50, "recovery summary must clear MIN_SUMMARY_CHARS");

function incompleteJsonBody(reason?: string): Record<string, unknown> {
    return {
        id: "resp_inc",
        status: "incomplete",
        ...(reason ? { incomplete_details: { reason } } : {}),
        output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: PARTIAL }] }],
    };
}

function completedJsonBody(): Record<string, unknown> {
    return {
        id: "resp_ok",
        status: "completed",
        output: [{ type: "message", id: "msg_2", role: "assistant", content: [{ type: "output_text", text: FULL }] }],
        usage: { input_tokens: 100, output_tokens: 10 },
    };
}

type SummaryInfo = { n: number; contentChars: number };

function makeUpstream(onSummary: (res: http.ServerResponse, info: SummaryInfo) => void, forwards: string[]): http.Server {
    let summaryCalls = 0;
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw) as { instructions?: unknown; input?: unknown };
            const isSummary = typeof parsed.instructions === "string" && Array.isArray(parsed.input) && parsed.input.length === 1;
            const first = Array.isArray(parsed.input) ? parsed.input[0] : undefined;
            const content = first && typeof first === "object" ? (first as Record<string, unknown>).content : undefined;
            if (isSummary) {
                summaryCalls += 1;
                onSummary(res, { n: summaryCalls, contentChars: typeof content === "string" ? content.length : 0 });
            } else {
                forwards.push(raw);
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(`event: response.completed\ndata: ${JSON.stringify({
                    type: "response.completed",
                    response: {
                        id: "resp_fwd",
                        status: "completed",
                        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
                        usage: { input_tokens: 800, output_tokens: 4 },
                    },
                })}\n\n`);
                res.end();
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

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-7-sol": { context: 10_000 } } } },
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

async function drive(proxyPort: number, upstreamPort: number, session: string, model: string, input: unknown, extraHeaders: Record<string, string>): Promise<Response> {
    return await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
        body: JSON.stringify({ model, stream: true, input }),
    });
}

async function closeAll(...servers: http.Server[]): Promise<void> {
    for (const s of servers) { s.close(); s.closeIdleConnections?.(); }
    await Promise.allSettled(servers.map((s) => once(s, "close")));
}

test("#2309 extractor rejects explicit Responses terminal states on the JSON path", () => {
    const withOutput = (status: string, extra: Record<string, unknown> = {}) => ({
        id: "resp_1", status, ...extra,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: PARTIAL }] }],
    });
    // Explicit bad terminals reject whatever text rides the body — both the
    // output[] walk and the flat output_text shortcut.
    assert.equal(extractSummaryText("responses", withOutput("incomplete", { incomplete_details: { reason: "max_output_tokens" } })), "");
    assert.equal(extractSummaryText("responses", { id: "resp_1", status: "incomplete", output_text: PARTIAL }), "");
    assert.equal(extractSummaryText("responses", withOutput("failed", { error: { code: "boom", message: "nope" } })), "");
    // Completed and status-omitted bodies keep extracting unchanged.
    assert.equal(extractSummaryText("responses", withOutput("completed")), PARTIAL);
    assert.equal(extractSummaryText("responses", { id: "resp_1", output: withOutput("x").output }), PARTIAL);
    // Other protocols are untouched by the Responses terminal check.
    assert.equal(extractSummaryText("openai", { choices: [{ message: { content: PARTIAL } }] }), PARTIAL);
    assert.equal(extractSummaryText("anthropic", { content: [{ type: "text", text: PARTIAL }] }), PARTIAL);
});

test("#2309 diagnosis names the JSON terminal precisely and routes the size signal", () => {
    const inc = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] };
    assert.equal(
        diagnoseEmptySummary(JSON.stringify(inc), inc),
        "the upstream returned an incomplete Responses summary (status=incomplete, reason=max_output_tokens)",
    );
    assert.equal(
        diagnoseEmptySummary(JSON.stringify({ status: "incomplete", output: [] }), { status: "incomplete", output: [] }),
        "the upstream returned an incomplete Responses summary (status=incomplete)",
    );
    const failed = { status: "failed", error: { code: "boom", message: "nope" }, output: [] };
    assert.equal(
        diagnoseEmptySummary(JSON.stringify(failed), failed),
        "the upstream returned a failed Responses summary (status=failed, boom, nope)",
    );
    // Shape guard: a body with a bad status but no recognizable Responses
    // output shape keeps the generic routing (not claimed by this diagnosis).
    assert.match(
        diagnoseEmptySummary('{"status":"incomplete"}', { status: "incomplete" }),
        /non-SSE body with no summary text/,
    );
    // Classifier: max_output_tokens truncation is size-driven (halving is the
    // recovery); other reasons are blips worth a bounded same-span re-draw.
    assert.equal(emptySummaryIsSizeDriven("the upstream returned an incomplete Responses summary (status=incomplete, reason=max_output_tokens)"), true);
    assert.equal(emptySummaryIsSizeDriven("the upstream returned an incomplete Responses summary (status=incomplete, reason=content_filter)"), false);
    assert.equal(emptySummaryIsSizeDriven("the upstream returned an incomplete Responses summary (status=incomplete)"), false);
});

test("#2309 proxy mode: incomplete JSON summary is rejected, recovery replaces it, partial never reaches the wire", async () => {
    const forwards: string[] = [];
    const infos: SummaryInfo[] = [];
    const upstream = makeUpstream((res, info) => {
        infos.push(info);
        res.writeHead(200, { "content-type": "application/json" });
        // First summary answer is the truncated JSON; every later one completes.
        res.end(JSON.stringify(info.n === 1 ? incompleteJsonBody("max_output_tokens") : completedJsonBody()));
    }, forwards);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await drive(proxyPort, upstreamPort, "s2309-proxy", "gpt-7-sol", longResponsesInput(12), { "x-acp-session": "s2309-proxy" });
        const body = await r.text();
        assert.equal(r.status, 200, `request must recover after the rejected incomplete summary, got ${r.status}: ${body.slice(0, 300)}`);

        assert.ok(infos.length >= 2, `expected the rejected draw plus at least one recovery draw, got ${JSON.stringify(infos)}`);
        assert.ok(forwards.length >= 1, "the folded payload was forwarded");
        const wire = forwards.join("\n");
        assert.ok(wire.includes(FULL), "the recovered complete summary reached the forwarded history");
        assert.ok(!wire.includes(PARTIAL), "the rejected partial text must NOT reach the forwarded history");

        const sess = listSessions().find((s) => s.id.includes("s2309-proxy"));
        assert.ok(sess, "session recorded");
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "successful preflight must not leave a dead-end marker");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("#2309 plugin mode: same rejection/recovery contract on the x-bili-plugin lane", async () => {
    const forwards: string[] = [];
    const infos: SummaryInfo[] = [];
    const upstream = makeUpstream((res, info) => {
        infos.push(info);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(info.n === 1 ? incompleteJsonBody("max_output_tokens") : completedJsonBody()));
    }, forwards);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await drive(proxyPort, upstreamPort, "s2309-plugin", "gpt-7-sol", longResponsesInput(12), { "x-bili-plugin": "test-agent", "x-acp-session": "s2309-plugin" });
        const body = await r.text();
        assert.equal(r.status, 200, `plugin-lane request must recover after the rejected incomplete summary, got ${r.status}: ${body.slice(0, 300)}`);

        assert.ok(infos.length >= 2, `expected the rejected draw plus at least one recovery draw, got ${JSON.stringify(infos)}`);
        assert.ok(forwards.length >= 1, "the folded payload was forwarded");
        const wire = forwards.join("\n");
        assert.ok(wire.includes(FULL), "the recovered complete summary reached the forwarded history");
        assert.ok(!wire.includes(PARTIAL), "the rejected partial text must NOT reach the forwarded history");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("#2309 transient incomplete (no size reason) re-draws the SAME span before recovery", async () => {
    const forwards: string[] = [];
    const infos: SummaryInfo[] = [];
    const upstream = makeUpstream((res, info) => {
        infos.push(info);
        res.writeHead(200, { "content-type": "application/json" });
        // No reason -> transient class: the same span is re-drawn, not halved.
        res.end(JSON.stringify(info.n === 1 ? incompleteJsonBody() : completedJsonBody()));
    }, forwards);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await drive(proxyPort, upstreamPort, "s2309-transient", "gpt-7-sol", longResponsesInput(12), { "x-acp-session": "s2309-transient" });
        const body = await r.text();
        assert.equal(r.status, 200, `request must recover via the same-span re-draw, got ${r.status}: ${body.slice(0, 300)}`);

        assert.ok(infos.length >= 2, `expected the rejected draw plus a re-draw, got ${JSON.stringify(infos)}`);
        assert.equal(infos[0].contentChars, infos[1].contentChars, "the transient re-draw must cover the same span (no halving)");
        const wire = forwards.join("\n");
        assert.ok(wire.includes(FULL) && !wire.includes(PARTIAL), "only the recovered summary may reach the wire");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("#2309 persistent incomplete JSON fails fast with the diagnosis, retries re-run bounded", async () => {
    const forwards: string[] = [];
    const infos: SummaryInfo[] = [];
    const upstream = makeUpstream((res, info) => {
        infos.push(info);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(incompleteJsonBody("max_output_tokens")));
    }, forwards);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await drive(proxyPort, upstreamPort, "s2309-deadend", "gpt-7-sol", longResponsesInput(12), { "x-acp-session": "s2309-deadend" });
        assert.equal(r.status, 502, `systemic incomplete summaries must fail-fast, got ${r.status}`);
        const j = (await r.json()) as { error?: { code?: string; message?: string } };
        assert.equal(j.error?.code, "preflight_compress_failed");
        assert.ok(
            j.error?.message?.includes("incomplete Responses summary (status=incomplete, reason=max_output_tokens)"),
            `fail-fast message must carry the terminal diagnosis, got: ${j.error?.message}`,
        );
        assert.ok(infos.length >= 2 && infos.length <= 32, `summary calls must be bounded, got ${infos.length}`);
        assert.equal(forwards.length, 0, "nothing may be forwarded on failure");

        const sess = listSessions().find((s) => s.id.includes("s2309-deadend"));
        assert.equal(sess?.metadata?.preflightDeadEnd, undefined, "(#4079) no dead-end marker may persist");

        const callsBeforeRetry = infos.length;
        const r2 = await drive(proxyPort, upstreamPort, "s2309-deadend", "gpt-7-sol", longResponsesInput(12), { "x-acp-session": "s2309-deadend" });
        assert.equal(r2.status, 502, `the retry must fail fast again, got ${r2.status}`);
        await r2.text();
        assert.ok(infos.length > callsBeforeRetry && infos.length - callsBeforeRetry <= 32, `the re-run walk is itself bounded (#4079 trade), got +${infos.length - callsBeforeRetry}`);
    } finally {
        await closeAll(proxy, upstream);
    }
});
