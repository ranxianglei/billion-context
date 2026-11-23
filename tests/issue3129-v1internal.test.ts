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
import { getUnrecognizedPathStats } from "../src/server/observability.ts";
import { extractSummaryFromSse, extractSummaryText } from "../src/preflight.ts";
import {
    extractConversationId,
    isV1BackgroundSideRequest,
    isV1InternalRequest,
    unwrapV1Internal,
    wrapV1Internal,
    unwrapV1ResponseJson,
    wrapV1ResponseJson as wrapRespJson,
    unwrapV1SseFrame,
    wrapV1SseFrame,
    v1UnwrapStream,
} from "../src/v1internal.ts";

// Antigravity (CloudCode) speaks a v1internal dialect over the Gemini wire:
// model-endpoint requests are wrapped in an outer envelope
//   { project, requestId, model, userAgent, requestType, request: {<standard GenerateContentRequest>} }
// and every response (SSE frame or JSON) is wrapped in
//   { response: <GenerateContentResponse>, traceId, metadata }.
// bili must read/write the standard fields off the INNER object and re-wrap on
// egress, key sessions by the stable "Conversation ID" UUID, and pass background
// side requests through verbatim. These tests pin all of that hermetically.

const CONV_ID = "3f9c1a6e-4b2d-4e8a-9c1f-2d5e8b7a6c4d";
const MODEL = "gemini-4-argon-high";

type Call = { path: string; raw: string };

function sse(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
}

function gcr(text: string): Record<string, unknown> {
    return {
        candidates: [{ index: 0, content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
    };
}

function envelope(resp: Record<string, unknown>): Record<string, unknown> {
    return { response: resp, traceId: "trace-xyz", metadata: {} };
}

function longContents(): { role: string; parts: { text: string }[] }[] {
    const out: { role: string; parts: { text: string }[] }[] = [];
    for (let i = 0; i < 6; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: `Turn ${i}: ` + "marker".repeat(40) }] });
    }
    return out;
}

function systemInstruction(convId?: string): Record<string, unknown> {
    const head = "<user_information>\nCurrent Date: 2026-10-14\nOperating System: Windows 11\n";
    const tail = convId ? `\nConversation ID: ${convId}\n</user_information>` : "\n</user_information>";
    return { parts: [{ text: head + tail }] };
}

function v1Request(opts: { convId?: string; requestType?: string; model?: string; tools?: boolean }): Record<string, unknown> {
    const inner: Record<string, unknown> = {
        contents: longContents(),
        systemInstruction: systemInstruction(opts.convId),
        generationConfig: { maxOutputTokens: 4096 },
        sessionId: -3750763034362895579,
    };
    if (opts.tools) inner.tools = [];
    return {
        project: "aicode-consumers",
        requestId: `agent/${CONV_ID}`,
        model: opts.model ?? MODEL,
        userAgent: "antigravity",
        requestType: opts.requestType ?? "agent",
        request: inner,
    };
}

function makeUpstream(calls: Call[], encodeFrame: (data: unknown) => string = sse): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const path = req.url ?? "";
            calls.push({ path, raw });
            if (path.includes(":streamGenerateContent") || path.includes(":generateContent")) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(encodeFrame(envelope(gcr("hello from cloudcode"))));
                res.end();
            } else if (path.includes(":countTokens")) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(envelope({ totalTokens: 42 })));
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ userInfo: { uid: 1 } }));
            }
        });
    });
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 10_000 } } } },
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
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
    } as unknown as ProxyOptions);
}

async function drive(proxyPort: number, upstreamPort: number, path: string, body: unknown): Promise<{ status: number; text: string }> {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: resp.status, text: await resp.text() };
}

function ssePayloads(text: string): unknown[] {
    const out: unknown[] = [];
    for (const chunk of text.split("\n\n")) {
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        try { out.push(JSON.parse(payload)); } catch { /* non-JSON keepalive */ }
    }
    return out;
}

test("isV1InternalRequest detects the envelope and rejects standard bodies", () => {
    assert.equal(isV1InternalRequest("/v1internal:streamGenerateContent?alt=sse", v1Request({})), true);
    assert.equal(isV1InternalRequest("/v1internal:generateContent", v1Request({})), true);
    assert.equal(isV1InternalRequest("/v1internal:countTokens", { project: "p", request: {} }), true);
    // Standard Google body: top-level contents, no .request field.
    assert.equal(isV1InternalRequest("/v1internal:streamGenerateContent", { contents: longContents() }), false);
    // Non-v1internal path never counts, even with a .request field.
    assert.equal(isV1InternalRequest("/v1beta/models/x:generateContent", v1Request({})), false);
});

test("unwrapV1Internal → wrapV1Internal round-trips meta and inner", () => {
    const original = v1Request({ convId: CONV_ID, tools: true });
    const { inner, meta, model } = unwrapV1Internal(original);
    assert.equal(model, MODEL);
    assert.equal(meta.project, "aicode-consumers");
    assert.equal(meta.request, undefined, "request must be lifted out of meta");
    assert.ok(Array.isArray(inner.contents));
    assert.deepEqual(wrapV1Internal(inner, meta), original);
});

test("extractConversationId finds the UUID and returns null when absent", () => {
    assert.equal(extractConversationId(unwrapV1Internal(v1Request({ convId: CONV_ID })).inner), CONV_ID);
    assert.equal(extractConversationId(unwrapV1Internal(v1Request({ convId: undefined })).inner), null);
});

test("isV1BackgroundSideRequest classifies checkpoint vs agent turns", () => {
    const chk = unwrapV1Internal(v1Request({ requestType: "checkpoint", model: "gemini-3.5-flash-lite", tools: false }));
    assert.equal(isV1BackgroundSideRequest(chk.meta, chk.inner), true, "checkpoint sidecar bypasses");
    const micro = unwrapV1Internal(v1Request({ convId: undefined, model: "gemini-3.5-flash-lite", tools: false }));
    assert.equal(isV1BackgroundSideRequest(micro.meta, micro.inner), true, "flash-lite no-conv-id no-tools bypasses");
    const agent = unwrapV1Internal(v1Request({ convId: CONV_ID }));
    assert.equal(isV1BackgroundSideRequest(agent.meta, agent.inner), false, "agent turn with Conversation ID is not bypassed");
    const agentLite = unwrapV1Internal(v1Request({ convId: CONV_ID, model: "gemini-3.5-flash-lite", tools: true }));
    assert.equal(isV1BackgroundSideRequest(agentLite.meta, agentLite.inner), false, "flash-lite with tools + conv-id is not bypassed");
});

test("response json/frame envelope helpers are idempotent and pass-through safe", () => {
    const env = JSON.stringify(envelope(gcr("x")));
    const bare = JSON.stringify(gcr("x"));
    assert.deepEqual(JSON.parse(unwrapV1ResponseJson(env)), gcr("x"), "unwrap strips one envelope");
    assert.equal(unwrapV1ResponseJson(bare), bare, "bare body passes through");
    assert.equal(unwrapV1ResponseJson("not-json"), "not-json");
    const wrappedBare = JSON.parse(wrapRespJson(bare)) as Record<string, unknown>;
    assert.deepEqual(wrappedBare.response, gcr("x"), "wrap adds one envelope around the response");
    assert.equal(typeof wrappedBare.traceId, "string", "wrap stamps a traceId slot");
    assert.deepEqual(wrappedBare.metadata, {});
    assert.equal(wrapRespJson(env), env, "already-enveloped stays put");
    assert.equal(wrapRespJson("not-json"), "not-json");
    assert.equal(wrapV1SseFrame("data: [DONE]\n\n"), "data: [DONE]\n\n", "[DONE] passthrough");
    const unwrappedFrame = unwrapV1SseFrame(wrapV1SseFrame(sse(gcr("y"))));
    const payload = unwrappedFrame.split("\n").find((l) => l.startsWith("data:"))!.slice(5).trim();
    assert.deepEqual(JSON.parse(payload), gcr("y"));
});

test("v1UnwrapStream unwraps an SSE stream and a JSON body", async () => {
    const enc = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(sse(envelope(gcr("a"))) + sse(envelope(gcr("b"))))); c.close(); },
    });
    const frames = ssePayloads(await new Response(await v1UnwrapStream(sseBody)).text());
    assert.equal(frames.length, 2);
    assert.deepEqual((frames[0] as Record<string, unknown>).candidates, gcr("a").candidates);
    assert.equal((frames[0] as Record<string, unknown>).response, undefined, "envelope stripped");

    const jsonBody = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(enc.encode(JSON.stringify(envelope({ totalTokens: 7 })))); c.close(); },
    });
    assert.deepEqual(JSON.parse(await new Response(await v1UnwrapStream(jsonBody)).text()), { totalTokens: 7 });
});

test("#3331 v1UnwrapStream: CRLF-framed SSE is unwrapped, incl. a CRLF split across chunks", async () => {
    const enc = new TextEncoder();
    // whole stream uses \r\n terminators (SSE-spec-legal); the second frame's
    // terminating CRLF is split across two chunks to exercise the hold-back.
    const f1 = `data: ${JSON.stringify(envelope(gcr("a")))}\r\n\r\n`;
    const f2 = `data: ${JSON.stringify(envelope(gcr("b")))}\r\n\r\n`;
    const sseBody = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(enc.encode(f1 + f2.slice(0, -1))); // ends mid-CRLF (…\r)
            c.enqueue(enc.encode(f2.slice(-1)));          // partner \n
            c.close();
        },
    });
    const frames = ssePayloads(await new Response(await v1UnwrapStream(sseBody)).text());
    assert.equal(frames.length, 2, "both CRLF frames unwrapped");
    assert.deepEqual((frames[0] as Record<string, unknown>).candidates, gcr("a").candidates);
    assert.deepEqual((frames[1] as Record<string, unknown>).candidates, gcr("b").candidates);
    assert.equal((frames[0] as Record<string, unknown>).response, undefined, "envelope stripped");
});

test("#3129 A: an enveloped Antigravity turn round-trips the envelope end-to-end", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ convId: CONV_ID, tools: true }));
        assert.equal(status, 200, `Antigravity turn must succeed, got HTTP ${status}: ${text.slice(0, 300)}`);

        const seen = JSON.parse(calls[0].raw) as Record<string, unknown>;
        assert.equal(seen.project, "aicode-consumers", "egress re-wrap restores the outer envelope");
        assert.equal(seen.model, MODEL);
        const inner = seen.request as Record<string, unknown>;
        assert.ok(Array.isArray(inner.contents) && inner.contents.length > 0, "request.contents carried inside the envelope");
        assert.ok(Array.isArray(inner.tools) && (inner.tools as unknown[]).length >= 1, "main turn enters the pipeline (compress tool injected)");

        const frames = ssePayloads(text);
        assert.ok(frames.length >= 1, `expected at least one SSE frame, got: ${text.slice(0, 300)}`);
        for (const f of frames) {
            const fr = f as Record<string, unknown>;
            assert.ok(fr.response !== undefined, "client frame re-wrapped in {response}");
            assert.ok(((fr.response as Record<string, unknown>).candidates as Array<Record<string, unknown>> | undefined)?.[0]?.content);
        }
        assert.match(text, /hello from cloudcode/);
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#3129 B: a CLI-style request with no Conversation ID still resolves identity", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ convId: undefined }));
        assert.equal(status, 200, `no-conv-id turn must resolve via content affinity, got HTTP ${status}: ${text.slice(0, 300)}`);
        assert.match(text, /hello from cloudcode/);
    } finally {
        proxy.close(); upstream.close();
    }
});

test("multiline CloudCode SSE preserves the model reply through the real proxy", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, data =>
        JSON.stringify(data, null, 2).split("\n").map(line => `data: ${line}`).join("\n") + "\n\n");
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse",
            v1Request({ convId: "b29caf80-933b-40c7-8e15-089ab49d2774", tools: true }));
        assert.equal(status, 200);
        const frames = ssePayloads(text) as Array<{ response?: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } }>;
        const texts = frames.flatMap(frame => frame.response?.candidates ?? [])
            .flatMap(candidate => candidate.content?.parts ?? []).map(part => part.text ?? "").join("");
        assert.equal(texts, "hello from cloudcode", "the inner model text must reach the client exactly once");
        assert.equal(calls.length, 1, "a complete reply must not trigger a continuation request");
        assert.doesNotMatch(text, /upstream_stream_truncated/);
    } finally {
        proxy.close();
        upstream.close();
    }
});

test("#3129 C: background side requests bypass the pipeline and pass through verbatim", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ requestType: "checkpoint", model: "gemini-3.5-flash-lite", tools: false }));
        assert.equal(status, 200, `checkpoint side request must pass through, got HTTP ${status}: ${text.slice(0, 300)}`);

        const seen = JSON.parse(calls[0].raw) as Record<string, unknown>;
        assert.equal(seen.requestType, "checkpoint");
        const inner = seen.request as Record<string, unknown>;
        assert.ok(!Array.isArray(inner.tools) || (inner.tools as unknown[]).length === 0, "bypass must NOT inject the compress tool");
        const frames = ssePayloads(text);
        assert.ok(frames.length >= 1 && (frames[0] as Record<string, unknown>).response !== undefined, "already-enveloped response streams back verbatim");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#3129 E: a non-streaming countTokens response is re-wrapped into the envelope", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:countTokens", v1Request({ convId: CONV_ID, tools: true }));
        assert.equal(status, 200, `countTokens must succeed, got HTTP ${status}: ${text.slice(0, 300)}`);
        // Egress re-wrap on the request.
        const seen = JSON.parse(calls[0].raw) as Record<string, unknown>;
        assert.equal(seen.project, "aicode-consumers");
        assert.ok((seen.request as Record<string, unknown>).contents);
        // Non-streaming JSON response must come back enveloped in {"response":...}.
        const parsed = JSON.parse(text) as Record<string, unknown>;
        assert.ok(parsed.response !== undefined, `client JSON must be enveloped, got: ${text.slice(0, 200)}`);
        assert.deepEqual((parsed.response as Record<string, unknown>).totalTokens, 42);
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#3129 D: v1internal control-plane paths are exempt from unrecognized-path stats", async () => {
    const countOf = (ep: string): number => {
        for (const [k, n] of Object.entries(getUnrecognizedPathStats().paths)) if (k.includes(ep)) return n;
        return 0;
    };
    const beforeFetch = countOf("fetchUserInfo");
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:fetchUserInfo", {});
        assert.equal(status, 200, `control-plane passthrough must succeed, got HTTP ${status}: ${text.slice(0, 200)}`);
        assert.match(text, /userInfo/);
        // The control-plane endpoint must never be recorded as an unrecognized path.
        assert.equal(countOf("fetchUserInfo"), beforeFetch, "fetchUserInfo leaked into unrecognized-path stats");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("extractSummaryText and extractSummaryFromSse unwrap v1internal response envelopes while preserving standard Google responses", () => {
    const summaryText = "TASK AS OF THIS BLOCK: summarized v1internal range with full fidelity and context.";
    // Enveloped v1internal SSE and JSON responses
    assert.equal(extractSummaryFromSse("google", sse(envelope(gcr(summaryText)))), summaryText);
    assert.equal(extractSummaryText("google", envelope(gcr(summaryText))), summaryText);
    // Negative control: standard unwrapped Google SSE and JSON responses remain intact
    assert.equal(extractSummaryFromSse("google", sse(gcr(summaryText))), summaryText);
    assert.equal(extractSummaryText("google", gcr(summaryText)), summaryText);
});

test("v1internal preflight summarization wraps the summary request in the v1internal envelope and unwraps the enveloped summary response", async () => {
    const calls: Call[] = [];
    const summaryReply = "TASK AS OF THIS BLOCK: compressed earlier v1internal turns preserving all technical artifacts, file paths, and decisions.";
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const path = req.url ?? "";
            calls.push({ path, raw });
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            if (path.startsWith("/v1internal:")) {
                // Real CloudCode rejects top-level contents / systemInstruction on /v1internal:* with HTTP 400
                if ("contents" in parsed || "systemInstruction" in parsed || !parsed.request || typeof parsed.request !== "object") {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        error: {
                            code: 400,
                            message: "Invalid JSON payload received. Unknown name \"contents\": Cannot find field.\nInvalid JSON payload received. Unknown name \"systemInstruction\": Cannot find field.",
                            status: "INVALID_ARGUMENT",
                        },
                    }));
                    return;
                }
                const inner = parsed.request as Record<string, unknown>;
                const sysText = JSON.stringify(inner.systemInstruction ?? "");
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                if (sysText.includes("Write a tier-1 compression summary")) {
                    res.end(sse(envelope(gcr(summaryReply))));
                    return;
                }
                // Main turn: report usage above the 10_000 window so the next turn triggers preflight compression
                res.end(sse(envelope({
                    candidates: [{ index: 0, content: { role: "model", parts: [{ text: "hello from cloudcode" }] }, finishReason: "STOP" }],
                    usageMetadata: { promptTokenCount: 12_000, candidatesTokenCount: 30, totalTokenCount: 12_030 },
                })));
                return;
            }
            // Standard Google wire negative control (/v1beta/models/...)
            if ("request" in parsed) {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { code: 400, message: "Unexpected v1internal envelope on standard Google endpoint" } }));
                return;
            }
            const sysText = JSON.stringify(parsed.systemInstruction ?? "");
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (sysText.includes("Write a tier-1 compression summary")) {
                res.end(sse(gcr(summaryReply)));
                return;
            }
            res.end(sse({
                candidates: [{ index: 0, content: { role: "model", parts: [{ text: "hello from standard google" }] }, finishReason: "STOP" }],
                usageMetadata: { promptTokenCount: 12_000, candidatesTokenCount: 30, totalTokenCount: 12_030 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const preflightConvId = "e4cd2260-fc13-4253-8e5f-894aa8f01449";
        const bigContents = () => {
            const out: { role: string; parts: { text: string }[] }[] = [];
            for (let i = 0; i < 12; i++) {
                out.push({
                    role: i % 2 === 0 ? "user" : "model",
                    parts: [{ text: `Turn ${i}: ` + `detailed payload segment ${i} `.repeat(120) }],
                });
            }
            return out;
        };
        const reqBody = {
            ...v1Request({ convId: preflightConvId, tools: true }),
            continuationToken: "stale-token-should-not-leak-to-summary",
            request: {
                contents: bigContents(),
                systemInstruction: systemInstruction(preflightConvId),
                generationConfig: { maxOutputTokens: 1024 },
                sessionId: -3750763034362895579,
                tools: [],
            },
        };
        // Turn 1 settles the 12_000-token usage baseline (> 10_000 window).
        const turn1 = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", reqBody);
        assert.equal(turn1.status, 200, `turn 1 must succeed, got HTTP ${turn1.status}: ${turn1.text.slice(0, 300)}`);

        // Turn 2 triggers preflight compression on the v1internal lane.
        const turn2 = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", reqBody);
        assert.equal(turn2.status, 200, `turn 2 preflight on v1internal must succeed without 400/502, got HTTP ${turn2.status}: ${turn2.text.slice(0, 400)}`);
        assert.match(turn2.text, /hello from cloudcode/);

        // Verify the summarization call itself was wrapped in the v1internal envelope and stripped continuationToken.
        const summaryCalls = calls.filter((c) => c.path.startsWith("/v1internal:") && c.raw.includes("Write a tier-1 compression summary"));
        assert.ok(summaryCalls.length >= 1, `expected at least 1 v1internal preflight summary call, saw ${summaryCalls.length}`);
        const sumParsed = JSON.parse(summaryCalls[0].raw) as Record<string, unknown>;
        assert.equal(sumParsed.project, "aicode-consumers");
        assert.equal(sumParsed.model, MODEL);
        assert.equal(sumParsed.userAgent, "antigravity");
        assert.equal(sumParsed.continuationToken, undefined, "summary call must not inherit continuationToken from v1Meta");
        assert.equal(sumParsed.contents, undefined, "top-level contents must not appear on v1internal summary call");
        assert.ok(sumParsed.request && typeof sumParsed.request === "object", "summary payload must live under .request");

        // Negative control: standard Google endpoint (/v1beta/models/...) must NOT wrap preflight summary calls in v1internal envelope.
        const stdBody = {
            contents: bigContents(),
            systemInstruction: systemInstruction("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"),
            generationConfig: { maxOutputTokens: 1024 },
        };
        const stdPath = `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
        const stdTurn1 = await drive(proxyPort, upstreamPort, stdPath, stdBody);
        assert.equal(stdTurn1.status, 200);
        const stdTurn2 = await drive(proxyPort, upstreamPort, stdPath, stdBody);
        assert.equal(stdTurn2.status, 200, `standard Google preflight must remain unwrapped, got HTTP ${stdTurn2.status}: ${stdTurn2.text.slice(0, 300)}`);
        const stdSummaryCalls = calls.filter((c) => c.path.startsWith("/v1beta/") && c.raw.includes("Write a tier-1 compression summary"));
        assert.ok(stdSummaryCalls.length >= 1, "expected standard Google preflight summary call");
        const stdSumParsed = JSON.parse(stdSummaryCalls[0].raw) as Record<string, unknown>;
        assert.equal(stdSumParsed.request, undefined, "standard Google summary call must not carry v1internal .request wrapper");
        assert.ok(Array.isArray(stdSumParsed.contents), "standard Google summary call must keep top-level contents");
    } finally {
        proxy.close();
        upstream.close();
    }
});
