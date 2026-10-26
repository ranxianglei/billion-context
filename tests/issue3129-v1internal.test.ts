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

function makeUpstream(calls: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const path = req.url ?? "";
            calls.push({ path, raw });
            if (path.includes(":streamGenerateContent") || path.includes(":generateContent")) {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.write(sse(envelope(gcr("hello from cloudcode"))));
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
