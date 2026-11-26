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
import { findV1Continuation, spliceV1ContinuationInner } from "../src/v1internal.ts";

// #6963: Antigravity (CloudCode) continues a MAX_TOKENS-cut turn by resending
// the SAME input plus a continuationToken. Upstream binds the token to the
// exact inner bytes it saw on the minting leg and 400s any deviation — and
// bili's stateful pipeline (nudge / status line / ACP tag re-render / output
// clamp) mutated leg 2's outbound vs leg 1's. The fix replays the cached
// minting-leg egress inner, splicing back only the client's fresh
// maxOutputTokens and the token itself. These tests pin the splice helpers
// hermetically and the replay contract through the real proxy.

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

function contents(tag: string): { role: string; parts: { text: string }[] }[] {
    const out: { role: string; parts: { text: string }[] }[] = [];
    for (let i = 0; i < 6; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: `${tag} Turn ${i}: ` + "marker".repeat(40) }] });
    }
    return out;
}

function systemInstruction(convId?: string): Record<string, unknown> {
    const head = "<user_information>\nCurrent Date: 2026-10-14\nOperating System: Windows 11\n";
    const tail = convId ? `\nConversation ID: ${convId}\n</user_information>` : "\n</user_information>";
    return { parts: [{ text: head + tail }] };
}

type V1Opts = {
    convId?: string;
    requestType?: string;
    model?: string;
    tools?: boolean;
    contents?: { role: string; parts: { text: string }[] }[];
    maxOutputTokens?: number;
    requestId?: string;
    // Where the continuation token rides: envelope meta, inner root, or
    // inner.generationConfig — camelCase or snake_case.
    token?: { location: "meta" | "inner" | "generationConfig"; value: string; snake?: boolean };
};

function v1Request(opts: V1Opts): Record<string, unknown> {
    const inner: Record<string, unknown> = {
        contents: opts.contents ?? contents("A"),
        systemInstruction: systemInstruction(opts.convId),
        generationConfig: { maxOutputTokens: opts.maxOutputTokens ?? 4096 },
        sessionId: -3750763034362895579,
    };
    if (opts.tools) inner.tools = [];
    const key = opts.token?.snake ? "continuation_token" : "continuationToken";
    if (opts.token) {
        if (opts.token.location === "inner") inner[key] = opts.token.value;
        else if (opts.token.location === "generationConfig") (inner.generationConfig as Record<string, unknown>)[key] = opts.token.value;
    }
    const env: Record<string, unknown> = {
        project: "aicode-consumers",
        requestId: opts.requestId ?? `agent/${CONV_ID}`,
        model: opts.model ?? MODEL,
        userAgent: "antigravity",
        requestType: opts.requestType ?? "agent",
        request: inner,
    };
    if (opts.token?.location === "meta") env[key] = opts.token.value;
    return env;
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

// Strip exactly the two fields the replay is allowed to splice (the token and
// the client's fresh maxOutputTokens, either spelling) so the rest of the
// inner can be compared byte-for-byte.
function normalizeInner(inner: Record<string, unknown>): Record<string, unknown> {
    const c: Record<string, unknown> = { ...inner };
    const gc = c.generationConfig;
    if (gc && typeof gc === "object" && !Array.isArray(gc)) {
        const g = { ...(gc as Record<string, unknown>) };
        delete g.maxOutputTokens;
        delete g.max_output_tokens;
        delete g.continuationToken;
        delete g.continuation_token;
        c.generationConfig = Object.keys(g).length > 0 ? g : undefined;
        if (c.generationConfig === undefined) delete c.generationConfig;
    }
    delete c.continuationToken;
    delete c.continuation_token;
    return c;
}

// ---------------------------------------------------------------------------
// Splice helpers (hermetic)
// ---------------------------------------------------------------------------

test("findV1Continuation locates the token at meta / inner / generationConfig, camelCase + snake_case", () => {
    const meta = { project: "p", continuationToken: "t-meta" };
    const inner = { contents: [], generationConfig: { continuationToken: "t-gc" } };
    const found = findV1Continuation(meta, inner);
    assert.deepEqual(found, { location: "meta", key: "continuationToken", value: "t-meta" }, "meta wins over inner");

    const atInner = findV1Continuation({}, { continuation_token: "t-inner", generationConfig: { continuationToken: "t-gc" } });
    assert.deepEqual(atInner, { location: "inner", key: "continuation_token", value: "t-inner" }, "inner root wins over generationConfig, snake_case kept");

    const atGc = findV1Continuation({}, { generationConfig: { continuation_token: "t-gc" } });
    assert.deepEqual(atGc, { location: "generationConfig", key: "continuation_token", value: "t-gc" });

    assert.equal(findV1Continuation({}, { generationConfig: {} }), undefined, "no token anywhere");
    assert.equal(findV1Continuation({}, { generationConfig: { continuationToken: "" } }), undefined, "empty string is not a token");
    assert.equal(findV1Continuation({}, { generationConfig: { continuationToken: 42 } }), undefined, "non-string is not a token");
});

test("spliceV1ContinuationInner: generationConfig location splices token + raised maxOutputTokens, rest stays byte-identical", () => {
    const cached = {
        contents: [{ role: "user", parts: [{ text: "x" }] }],
        systemInstruction: { parts: [{ text: "sys" }] },
        tools: [{ name: "compress" }],
        sessionId: -3750763034362895579,
        generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
    };
    const incoming = {
        contents: [{ role: "user", parts: [{ text: "CHANGED" }] }],
        generationConfig: { maxOutputTokens: 8192, continuationToken: "tok-1" },
    };
    const out = spliceV1ContinuationInner(cached, incoming, { location: "generationConfig", key: "continuationToken", value: "tok-1" });
    const gc = out.generationConfig as Record<string, unknown>;
    assert.equal(gc.continuationToken, "tok-1");
    assert.equal(gc.maxOutputTokens, 8192, "client's raised budget wins");
    assert.equal(gc.temperature, 0.7, "other generationConfig fields preserved");
    assert.deepEqual(out.contents, cached.contents, "contents stay byte-identical to the minting leg");
    assert.deepEqual(out.tools, cached.tools, "tools stay byte-identical to the minting leg");
    assert.equal(out.sessionId, cached.sessionId);
});

test("spliceV1ContinuationInner: inner-root location splices at the root, not into generationConfig", () => {
    const cached = { contents: [], generationConfig: { maxOutputTokens: 4096 } };
    const out = spliceV1ContinuationInner(cached, { generationConfig: { maxOutputTokens: 9999, continuationToken: "t" } }, { location: "inner", key: "continuationToken", value: "t" });
    const gc = out.generationConfig as Record<string, unknown>;
    assert.equal(out.continuationToken, "t");
    assert.equal(gc.continuationToken, undefined, "token must not leak into generationConfig");
    assert.equal(gc.maxOutputTokens, 9999);
});

test("spliceV1ContinuationInner: meta location leaves the inner untouched (relay re-wraps with the incoming meta)", () => {
    const cached = { contents: [{ role: "user", parts: [{ text: "x" }] }], generationConfig: { maxOutputTokens: 4096 } };
    const out = spliceV1ContinuationInner(cached, { generationConfig: { maxOutputTokens: 2048 } }, { location: "meta", key: "continuationToken", value: "t" });
    const gc = out.generationConfig as Record<string, unknown>;
    assert.equal(out.continuationToken, undefined);
    assert.equal(gc.continuationToken, undefined);
    assert.equal(gc.max_output_tokens, undefined);
    assert.equal(gc.maxOutputTokens, 2048, "raised budget still spliced");
    assert.deepEqual(out.contents, cached.contents);
});

test("spliceV1ContinuationInner: non-finite maxOutputTokens keeps the cached value", () => {
    const cached = { generationConfig: { maxOutputTokens: 4096 } };
    const out = spliceV1ContinuationInner(cached, { generationConfig: { maxOutputTokens: "huge", continuationToken: "t" } }, { location: "generationConfig", key: "continuationToken", value: "t" });
    assert.equal((out.generationConfig as Record<string, unknown>).maxOutputTokens, 4096, "string budget is ignored, cached value kept");
    const out2 = spliceV1ContinuationInner(cached, { generationConfig: { continuationToken: "t" } }, { location: "generationConfig", key: "continuationToken", value: "t" });
    assert.equal((out2.generationConfig as Record<string, unknown>).maxOutputTokens, 4096, "absent budget keeps the cached value");
});

// ---------------------------------------------------------------------------
// Replay contract through the real proxy
// ---------------------------------------------------------------------------

test("#6963 A: a continuation leg replays the minting leg's egress inner byte-identical", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // Leg 1: the minting turn (MAX_TOKENS-cut in production; a plain turn
        // here is enough to mint the cache).
        const leg1 = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ convId: CONV_ID, tools: true }));
        assert.equal(leg1.status, 200, `leg 1 must succeed, got HTTP ${leg1.status}: ${leg1.text.slice(0, 300)}`);

        // Leg 2: the client resends the SAME inbound plus the token, with a
        // raised maxOutputTokens (accumulated across legs) and a fresh
        // requestId (the envelope meta differs per leg by design).
        const leg2 = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse",
            v1Request({ convId: CONV_ID, tools: true, requestId: `agent/${CONV_ID}/2`, maxOutputTokens: 8192, token: { location: "generationConfig", value: "tok-abc" } }));
        assert.equal(leg2.status, 200, `leg 2 must succeed, got HTTP ${leg2.status}: ${leg2.text.slice(0, 300)}`);
        assert.match(leg2.text, /hello from cloudcode/);

        const env1 = JSON.parse(calls[0].raw) as Record<string, unknown>;
        const env2 = JSON.parse(calls[1].raw) as Record<string, unknown>;
        const inner1 = env1.request as Record<string, unknown>;
        const inner2 = env2.request as Record<string, unknown>;

        // The spliced fields carry leg 2's fresh values.
        const gc2 = inner2.generationConfig as Record<string, unknown>;
        assert.equal(gc2.continuationToken, "tok-abc", "token spliced back into generationConfig");
        assert.equal(gc2.maxOutputTokens, 8192, "client's raised budget reaches upstream");

        // Everything else is byte-identical to the minting leg's egress inner
        // — re-running the stateful pipeline (nudge / status line / ACP tag
        // re-render / clamp) would have mutated it and upstream 400s the leg.
        assert.deepEqual(normalizeInner(inner2), normalizeInner(inner1), "egress inner must equal the minting leg's egress inner modulo the spliced fields");

        // The envelope is re-wrapped from leg 2's OWN meta (fresh requestId),
        // not the cached leg-1 meta.
        assert.equal(env2.requestId, `agent/${CONV_ID}/2`, "egress envelope carries the incoming leg's meta");
        assert.equal(env2.project, "aicode-consumers");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#6963 B: a continuation leg without a prior egress falls back to the full pipeline", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // Fresh conversation: the token arrives before any minting leg was
        // egressed (client-side restart / first leg after a bili restart).
        // The pipeline must still run — no crash, upstream gets a processed
        // body (compress tool injected).
        const leg = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse",
            v1Request({ convId: "aaaa1111-2222-3333-4444-555566667777", tools: true, token: { location: "generationConfig", value: "tok-orphan" } }));
        assert.equal(leg.status, 200, `orphan continuation leg must not crash the pipeline, got HTTP ${leg.status}: ${leg.text.slice(0, 300)}`);
        const inner = (JSON.parse(calls[0].raw) as Record<string, unknown>).request as Record<string, unknown>;
        assert.ok(Array.isArray(inner.tools) && (inner.tools as unknown[]).length >= 1, "fallback leg enters the pipeline (compress tool injected)");
        assert.equal((inner.generationConfig as Record<string, unknown>).continuationToken, "tok-orphan", "token forwarded on the fallback path");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#6963 C: countTokens egress does not clobber the continuation cache", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // Leg 1 mints the cache with contents tagged "A".
        await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ convId: CONV_ID, tools: true, contents: contents("A") }));
        // A countTokens side request with DIFFERENT contents ("B") must not
        // overwrite the cache — it never mints continuation tokens.
        const ct = await drive(proxyPort, upstreamPort, "/v1internal:countTokens", v1Request({ convId: CONV_ID, tools: true, contents: contents("B") }));
        assert.equal(ct.status, 200, `countTokens must succeed, got HTTP ${ct.status}: ${ct.text.slice(0, 300)}`);
        // Leg 2 continues: the replay must be leg 1's inner (contents "A"),
        // not the countTokens inner (contents "B").
        const leg2 = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse",
            v1Request({ convId: CONV_ID, tools: true, contents: contents("A"), maxOutputTokens: 8192, token: { location: "generationConfig", value: "tok-c" } }));
        assert.equal(leg2.status, 200);
        const inner2 = (JSON.parse(calls[2].raw) as Record<string, unknown>).request as Record<string, unknown>;
        const inner1 = (JSON.parse(calls[0].raw) as Record<string, unknown>).request as Record<string, unknown>;
        assert.deepEqual(inner2.contents, inner1.contents, "replay must be the minting leg's inner, not the countTokens inner");
        assert.match(JSON.stringify(inner2.contents), /A Turn 0/, "contents are the minting leg's, not the countTokens leg's");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#6963 D: a token at the inner root or the envelope meta is honored on replay", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // Mint with a plain turn.
        await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ convId: CONV_ID, tools: true }));
        // Leg 2a: token at the inner root.
        const leg2a = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse",
            v1Request({ convId: CONV_ID, tools: true, requestId: `agent/${CONV_ID}/2a`, token: { location: "inner", value: "tok-root" } }));
        assert.equal(leg2a.status, 200);
        const env2a = JSON.parse(calls[1].raw) as Record<string, unknown>;
        const inner2a = env2a.request as Record<string, unknown>;
        assert.equal(inner2a.continuationToken, "tok-root", "token spliced back at the inner root");
        assert.equal((inner2a.generationConfig as Record<string, unknown>).continuationToken, undefined, "token must not leak into generationConfig");
        assert.deepEqual(normalizeInner(inner2a), normalizeInner((JSON.parse(calls[0].raw) as Record<string, unknown>).request as Record<string, unknown>));

        // Leg 2b: token in the envelope meta — the inner stays token-free and
        // the relay re-wraps with leg 2b's own meta, which carries it.
        const leg2b = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse",
            v1Request({ convId: CONV_ID, tools: true, requestId: `agent/${CONV_ID}/2b`, token: { location: "meta", value: "tok-meta" } }));
        assert.equal(leg2b.status, 200);
        const env2b = JSON.parse(calls[2].raw) as Record<string, unknown>;
        const inner2b = env2b.request as Record<string, unknown>;
        assert.equal(env2b.continuationToken, "tok-meta", "envelope meta carries the incoming leg's token");
        assert.equal(inner2b.continuationToken, undefined, "inner root stays token-free");
        assert.equal((inner2b.generationConfig as Record<string, unknown>).continuationToken, undefined, "generationConfig stays token-free");
        assert.deepEqual(normalizeInner(inner2b), normalizeInner((JSON.parse(calls[0].raw) as Record<string, unknown>).request as Record<string, unknown>));
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#6963 E: the replayed leg streams its response back enveloped", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ convId: CONV_ID, tools: true }));
        const leg2 = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse",
            v1Request({ convId: CONV_ID, tools: true, maxOutputTokens: 8192, token: { location: "generationConfig", value: "tok-e" } }));
        assert.equal(leg2.status, 200);
        const frames = ssePayloads(leg2.text);
        assert.ok(frames.length >= 1, `expected at least one SSE frame, got: ${leg2.text.slice(0, 300)}`);
        for (const f of frames) {
            assert.ok((f as Record<string, unknown>).response !== undefined, "client frame re-wrapped in {response}");
        }
        assert.match(leg2.text, /hello from cloudcode/);
    } finally {
        proxy.close(); upstream.close();
    }
});
