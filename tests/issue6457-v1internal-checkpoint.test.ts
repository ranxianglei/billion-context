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

// #6457: Antigravity fires a background `requestType=checkpoint` side request
// after each agent turn, packing the FULL uncompressed local history into
// inner.contents. The #3129 bypass classifies it as a background side request
// and forwards it VERBATIM — so once the history exceeds the upstream window,
// the forward is a guaranteed 400 ("exceeds the maximum number of tokens")
// that Antigravity treats as fatal and terminates the whole agent loop on.
//
// The fix size-gates the verbatim passthrough: a checkpoint that fits is
// forwarded unchanged (today's behavior, #3129 C stays green); one that exceeds
// the window is shrunk to fit (first user instruction + most recent tail,
// role-alternation-safe) so the snapshot is partial but the session survives;
// a pathological payload that cannot fit even after shrinking is blocked locally
// instead of forwarded as a guaranteed 400 (#554 pattern). These tests pin all
// three branches hermetically.

const CONV_ID = "3f9c1a6e-4b2d-4e8a-9c1f-2d5e8b7a6c4d";
const MODEL = "gemini-4-argon-high";

type Call = { path: string; raw: string };
type Content = { role: string; parts: { text: string }[] };

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

// `turns` alternating user/model contents, each carrying ~`charsPerTurn` chars
// of text (~charsPerTurn/4 tokens). Used to build a history that clearly
// exceeds the 10_000-token test window.
function giantContents(turns: number, charsPerTurn: number): Content[] {
    const out: Content[] = [];
    for (let i = 0; i < turns; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "model", parts: [{ text: `Turn ${i}: ` + "x".repeat(charsPerTurn) }] });
    }
    return out;
}

function systemInstruction(convId?: string): Record<string, unknown> {
    const head = "<user_information>\nCurrent Date: 2026-10-14\nOperating System: Windows 11\n";
    const tail = convId ? `\nConversation ID: ${convId}\n</user_information>` : "\n</user_information>";
    return { parts: [{ text: head + tail }] };
}

function v1Request(opts: { convId?: string; requestType?: string; model?: string; contents?: Content[] }): Record<string, unknown> {
    const inner: Record<string, unknown> = {
        contents: opts.contents ?? giantContents(6, 160),
        systemInstruction: systemInstruction(opts.convId),
        generationConfig: { maxOutputTokens: 4096 },
        sessionId: -3750763034362895579,
    };
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

// --- Unit tests: truncateV1ContentsForBudget ---------------------------------

test("truncateV1ContentsForBudget: unchanged when it fits the budget", () => {
    const contents: Content[] = [
        { role: "user", parts: [{ text: "hello" }] },
        { role: "model", parts: [{ text: "hi there" }] },
    ];
    const result = truncateV1ContentsForBudget(contents, 10_000) as Content[];
    assert.deepEqual(result, contents, "fits → returned unchanged");
});

test("truncateV1ContentsForBudget: keeps first user anchor + most recent tail, alternating", () => {
    const contents = giantContents(20, 400); // 20 turns × ~100 tokens ≈ 2000 tokens
    const result = truncateV1ContentsForBudget(contents, 500) as Content[];
    assert.ok(result.length < contents.length, "over budget → truncated");
    assert.ok(result.length >= 2, "keeps at least the anchor + one tail turn");
    assert.equal(result[0].role, "user", "first content is user");
    assert.equal(result[0].parts[0].text, contents[0].parts[0].text, "anchor = first user instruction preserved");
    assert.equal(result[result.length - 1].parts[0].text, contents[contents.length - 1].parts[0].text, "most recent tail preserved");
    for (let i = 1; i < result.length; i++) {
        assert.notEqual(result[i].role, result[i - 1].role, `roles alternate at index ${i}`);
    }
    // The truncated payload must actually fit the budget.
    assert.ok(estimateRawBodyTokens({ contents: result }) <= 500, "truncated contents fit the budget");
});

test("truncateV1ContentsForBudget: a single giant anchor that cannot fit is returned alone", () => {
    const contents: Content[] = [{ role: "user", parts: [{ text: "y".repeat(40_000) }] }]; // ~10k tokens
    const result = truncateV1ContentsForBudget(contents, 100) as Content[];
    assert.equal(result.length, 1, "nothing else to keep");
    assert.equal(result[0].role, "user");
    assert.equal(result[0].parts[0].text, contents[0].parts[0].text, "the anchor itself is returned (caller blocks)");
});

test("truncateV1ContentsForBudget: tail head collides with the anchor role → drop the tail head, keep the anchor", () => {
    // 4 entries, each ~502 tokens: [user(0), model(1), user(2), model(3)].
    // The budget keeps the two most recent entries (2, 3) but not entry 1, so
    // the tail head (user, entry 2) collides with the anchor's role (user,
    // entry 0). The join fix must drop the tail head (entry 2), NOT the anchor
    // (entry 0), so the first user instruction survives.
    const contents = giantContents(4, 2000);
    const result = truncateV1ContentsForBudget(contents, 1750) as Content[];
    assert.equal(result.length, 2, "anchor + one tail entry after the collision drop");
    assert.equal(result[0].parts[0].text, contents[0].parts[0].text, "the anchor (first user instruction) is kept, not dropped");
    assert.equal(result[1].parts[0].text, contents[3].parts[0].text, "the most recent entry is kept");
    assert.notEqual(result[1].role, result[0].role, "the join alternates");
    assert.ok(estimateRawBodyTokens({ contents: result }) <= 1750, "the result fits the budget");
});

// --- Integration tests: the size-gated v1internal bypass ---------------------

test("#6457 A: a checkpoint that FITS the window is forwarded verbatim (unchanged)", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const contents = giantContents(6, 160); // small: well under the window
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ requestType: "checkpoint", contents }));
        assert.equal(status, 200, `fitting checkpoint must pass through, got HTTP ${status}: ${text.slice(0, 300)}`);

        const seen = JSON.parse(calls[0].raw) as Record<string, unknown>;
        assert.equal(seen.requestType, "checkpoint", "requestType preserved");
        const inner = seen.request as Record<string, unknown>;
        assert.ok(!Array.isArray(inner.tools) || (inner.tools as unknown[]).length === 0, "bypass must NOT inject the compress tool");
        assert.deepEqual(inner.contents, contents, "fitting payload forwarded byte-for-byte");
        const frames = ssePayloads(text);
        assert.ok(frames.length >= 1 && (frames[0] as Record<string, unknown>).response !== undefined, "enveloped response streams back");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#6457 B: a checkpoint that EXCEEDS the window is truncated to fit, not 400'd", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const contents = giantContents(60, 800); // 60 turns × ~200 tokens ≈ 12k tokens ≫ 10k window
        assert.ok(estimateRawBodyTokens({ contents }) > 10_000, "precondition: the history clearly exceeds the window");
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ requestType: "checkpoint", contents }));
        assert.equal(status, 200, `oversized checkpoint must be shrunk and forwarded (not 400'd), got HTTP ${status}: ${text.slice(0, 300)}`);

        const seen = JSON.parse(calls[0].raw) as Record<string, unknown>;
        assert.equal(seen.project, "aicode-consumers", "egress re-wrap restores the outer envelope");
        assert.equal(seen.requestType, "checkpoint", "requestType preserved through truncation");
        const inner = seen.request as Record<string, unknown>;
        assert.ok(!Array.isArray(inner.tools) || (inner.tools as unknown[]).length === 0, "bypass must NOT inject the compress tool");
        const forwarded = inner.contents as Content[];
        assert.ok(Array.isArray(forwarded) && forwarded.length > 0, "truncated contents present");
        assert.ok(forwarded.length < contents.length, `contents truncated (${contents.length} → ${forwarded.length})`);
        assert.equal(forwarded[0].role, "user", "first forwarded content is user");
        assert.equal(forwarded[0].parts[0].text, contents[0].parts[0].text, "anchor (first user instruction) preserved");
        assert.equal(forwarded[forwarded.length - 1].parts[0].text, contents[contents.length - 1].parts[0].text, "most recent tail preserved");
        assert.ok(estimateRawBodyTokens({ contents: forwarded }) <= 10_000, "truncated payload fits the window");
        const frames = ssePayloads(text);
        assert.ok(frames.length >= 1 && (frames[0] as Record<string, unknown>).response !== undefined, "enveloped response streams back");
    } finally {
        proxy.close(); upstream.close();
    }
});

test("#6457 C: a pathological checkpoint that cannot fit even after truncation is blocked locally", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // A single user message that alone exceeds the window: the anchor cannot
        // be shrunk, so the request must be blocked locally (413) rather than
        // forwarded as a guaranteed 400.
        const contents: Content[] = [{ role: "user", parts: [{ text: "z".repeat(200_000) }] }]; // ~50k tokens
        const { status, text } = await drive(proxyPort, upstreamPort, "/v1internal:streamGenerateContent?alt=sse", v1Request({ requestType: "checkpoint", contents }));
        assert.equal(status, 413, `unshrinkable checkpoint must be blocked locally, got HTTP ${status}: ${text.slice(0, 300)}`);
        assert.equal(calls.length, 0, "nothing forwarded upstream");
        const err = JSON.parse(text) as { error?: { code?: string; retryable?: boolean } };
        assert.equal(err.error?.code, "v1internal_side_request_payload_too_large");
        assert.equal(err.error?.retryable, false);
    } finally {
        proxy.close(); upstream.close();
    }
});
