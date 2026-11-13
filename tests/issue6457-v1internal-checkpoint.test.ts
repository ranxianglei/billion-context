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
import { estimateRawBodyTokens } from "../src/preflight.ts";
import { truncateV1ContentsForBudget } from "../src/v1internal.ts";

// #6457: a CloudCode/Antigravity requestType=checkpoint background side request
// packs the FULL uncompressed local history into inner.contents. The #3129
// bypass forwarded it verbatim, so once the history exceeded the upstream window
// the forward was a guaranteed 400 ("input token count exceeds the maximum
// number of tokens") that Antigravity treated as fatal — it terminated the whole
// agent loop. These tests pin the size-gated passthrough:
//   A. a small checkpoint (fits the window) is forwarded byte-for-byte verbatim;
//   B. an over-window checkpoint is truncated to (first user instruction anchor
//      + most recent contiguous tail) and forwarded;
//   C. an unshrinkable pathological payload is blocked locally (413) instead of
//      forwarded as a guaranteed 400.
// The three unit tests pin truncateV1ContentsForBudget in isolation.

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

// N alternating user/model entries, each carrying a unique TURN-<i> marker plus
// `chars` filler chars so the token size is controllable (defaultCountTokens ≈
// chars/4 for Latin).
function bigContents(count: number, chars: number): { role: string; parts: { text: string }[] }[] {
    const out: { role: string; parts: { text: string }[] }[] = [];
    for (let i = 0; i < count; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: `TURN-${i} ` + "x".repeat(chars) }] });
    }
    return out;
}

function systemInstruction(): Record<string, unknown> {
    const head = "<user_information>\nCurrent Date: 2026-11-14\nOperating System: Windows 11\n";
    return { parts: [{ text: head + "\n</user_information>" }] };
}

function v1Request(contents: { role: string; parts: { text: string }[] }[]): Record<string, unknown> {
    return {
        project: "aicode-consumers",
        requestId: `checkpoint/${CONV_ID}`,
        model: MODEL,
        userAgent: "antigravity",
        requestType: "checkpoint",
        request: {
            contents,
            systemInstruction: systemInstruction(),
            generationConfig: { maxOutputTokens: 4096 },
            sessionId: -3750763034362895579,
        },
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
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(envelope({ totalTokens: 42 })));
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

test("#6457 unit: truncateV1ContentsForBudget — fits → unchanged", () => {
    const contents = bigContents(6, 100); // ~150 tokens, well under the budget
    const result = truncateV1ContentsForBudget(contents, 10_000);
    assert.equal(result.truncated, false, "fits → not truncated");
    assert.equal(result.fits, true);
    assert.deepEqual(result.contents, contents, "fits → contents returned unchanged");
});

test("#6457 unit: truncateV1ContentsForBudget — over → anchor + most-recent tail, alternating, fits budget", () => {
    const contents = bigContents(30, 2000); // ~15_000 tokens
    const budget = 9_500;
    const result = truncateV1ContentsForBudget(contents, budget);
    assert.equal(result.truncated, true, "over → truncated");
    assert.equal(result.fits, true, "truncated result fits the budget");
    assert.ok(result.contents.length < 30, `truncated to ${result.contents.length} entries (from 30)`);
    assert.ok((result.contents[0].parts as { text: string }[])[0].text.startsWith("TURN-0 "), "anchor is the first user instruction");
    const last = result.contents[result.contents.length - 1];
    assert.ok((last.parts as { text: string }[])[0].text.startsWith("TURN-29 "), "most recent entry kept");
    // Role-alternation-safe at the join: no two consecutive same-role entries.
    for (let i = 1; i < result.contents.length; i++) {
        assert.notEqual(result.contents[i].role, result.contents[i - 1].role, `consecutive same-role at join (index ${i})`);
    }
    // The result fits the budget.
    const total = result.contents.reduce(
        (s, c) => s + (c.parts as { text: string }[]).reduce((p, pt) => p + Math.ceil(pt.text.length / 4), 0),
        0,
    );
    assert.ok(total <= budget, `result ${total} tokens fits budget ${budget}`);
});

test("#6457 unit: truncateV1ContentsForBudget — single giant anchor → returned alone for the caller to block", () => {
    const contents = bigContents(1, 48_000); // single user entry, ~12_000 tokens
    const budget = 9_960;
    const result = truncateV1ContentsForBudget(contents, budget);
    assert.equal(result.truncated, true, "giant anchor → truncated");
    assert.equal(result.fits, false, "giant anchor alone exceeds the budget → caller blocks");
    assert.equal(result.contents.length, 1, "the giant anchor is returned alone");
    assert.ok((result.contents[0].parts as { text: string }[])[0].text.startsWith("TURN-0 "), "the giant anchor is the returned entry");
});

test("#6457 A: small checkpoint fits the window → forwarded verbatim (byte-for-byte, no tool injection, enveloped response)", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const contents = bigContents(6, 100);
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request(contents));
        assert.equal(status, 200, `small checkpoint must pass through, got HTTP ${status}: ${text.slice(0, 300)}`);

        const seen = JSON.parse(calls[0].raw) as Record<string, unknown>;
        assert.equal(seen.requestType, "checkpoint", "requestType preserved");
        const inner = seen.request as Record<string, unknown>;
        assert.deepEqual(inner.contents, contents, "fits → contents forwarded byte-for-byte (verbatim)");
        assert.ok(!Array.isArray(inner.tools) || (inner.tools as unknown[]).length === 0, "bypass must NOT inject the compress tool");
        const frames = ssePayloads(text);
        assert.ok(frames.length >= 1 && (frames[0] as Record<string, unknown>).response !== undefined, "already-enveloped response streams back verbatim");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#6457 B: over-window checkpoint → truncated (requestType preserved, anchor + most-recent tail kept, fits window, no tool injection)", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const contents = bigContents(30, 2000); // ~15_000 tokens > window 10_000
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request(contents));
        assert.equal(status, 200, `over-window checkpoint must be truncated and forwarded, got HTTP ${status}: ${text.slice(0, 300)}`);

        const seen = JSON.parse(calls[0].raw) as Record<string, unknown>;
        assert.equal(seen.requestType, "checkpoint", "requestType preserved after truncation");
        const inner = seen.request as Record<string, unknown>;
        const sent = inner.contents as Array<{ role: string; parts: { text: string }[] }>;
        assert.ok(sent.length < 30, `truncated to ${sent.length} entries (from 30)`);
        assert.ok(sent[0].parts[0].text.startsWith("TURN-0 "), "anchor (first user instruction) kept");
        assert.ok(sent[sent.length - 1].parts[0].text.startsWith("TURN-29 "), "most recent entry kept");
        const estimate = estimateRawBodyTokens(inner);
        assert.ok(estimate <= 10_000, `truncated inner ${estimate} tokens fits the 10_000 window`);
        assert.ok(!Array.isArray(inner.tools) || (inner.tools as unknown[]).length === 0, "bypass must NOT inject the compress tool");
        const frames = ssePayloads(text);
        assert.ok(frames.length >= 1 && (frames[0] as Record<string, unknown>).response !== undefined, "truncated forward still streams an enveloped response");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#6457 C: pathological checkpoint (single giant message) → local 413, nothing forwarded upstream", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const contents = bigContents(1, 48_000); // single user entry, ~12_000 tokens > window 10_000
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request(contents));
        assert.equal(status, 413, `pathological checkpoint must be blocked locally, got HTTP ${status}: ${text.slice(0, 300)}`);
        assert.match(text, /v1internal_side_request_payload_too_large/, "413 carries the v1internal payload-too-large code");
        assert.equal(calls.length, 0, "nothing forwarded upstream on the 413 path");
    } finally {
        proxy.close(); upstream.close();
    }
});
