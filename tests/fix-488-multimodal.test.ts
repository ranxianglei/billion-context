import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { REMOTE_IMAGE_TOKENS, imageTokensInParsedBody, imageTokensInRawBody } from "../src/image-tokens.ts";

// Issue #488: (A) image bytes were invisible to every payload-size decision
// while being forwarded verbatim, so multimodal payloads blew past the window
// unintercepted; (B) the preflight summary request for the Responses protocol
// omitted store:false, which codex relays reject with 400, killing the rescue.

const B64_8K = "A".repeat(8000);
const DATA_URL = `data:image/png;base64,${B64_8K}`;

test("image-tokens: base64 data URLs count as ceil(b64len/4) across protocols", () => {
    assert.equal(
        imageTokensInParsedBody("responses", { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }, { type: "input_image", image_url: DATA_URL }] }] }),
        2000);
    assert.equal(
        imageTokensInParsedBody("openai", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: DATA_URL } }] }] }),
        2000);
    assert.equal(
        imageTokensInParsedBody("openai", { messages: [{ role: "user", content: [{ type: "image_url", image_url: DATA_URL }] }] }),
        2000);
    assert.equal(
        imageTokensInParsedBody("anthropic", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: B64_8K } }] }] }),
        2000);
});

test("image-tokens: remote URLs get a flat cost; multiple images sum; string content ignored", () => {
    assert.equal(imageTokensInParsedBody("responses", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] }] }), REMOTE_IMAGE_TOKENS);
    assert.equal(imageTokensInParsedBody("anthropic", { messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }] }), REMOTE_IMAGE_TOKENS);
    const du = `data:image/png;base64,${"B".repeat(4000)}`;
    assert.equal(
        imageTokensInParsedBody("responses", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: du }, { type: "input_image", image_url: du }] }] }),
        2000);
    assert.equal(imageTokensInParsedBody("responses", { input: [{ type: "message", role: "user", content: "plain string body" }] }), 0);
    assert.equal(imageTokensInParsedBody("openai", { messages: [{ role: "user", content: "plain string body" }] }), 0);
    assert.equal(imageTokensInParsedBody("anthropic", { messages: [{ role: "user", content: [{ type: "text", text: "no images here" }] }] }), 0);
});

test("image-tokens: raw-body gate skips parsing when no image marker is present", () => {
    const noImage = JSON.stringify({ model: "m", input: [{ type: "message", role: "user", content: "hello world, no pictures" }] });
    assert.equal(imageTokensInRawBody("responses", noImage), 0);
    const du = `data:image/png;base64,${"C".repeat(12000)}`;
    const withImage = JSON.stringify({ model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: du }] }] });
    assert.equal(imageTokensInRawBody("responses", withImage), 3000);
    assert.equal(imageTokensInRawBody("responses", Buffer.from(withImage)), 3000);
    assert.equal(imageTokensInRawBody("responses", '{"input_image": broken'), 0);
});

test("image-tokens: BILI_IMAGE_TOKEN_CAP clamps each image's cost", () => {
    process.env.BILI_IMAGE_TOKEN_CAP = "500";
    try {
        assert.equal(
            imageTokensInParsedBody("responses", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: DATA_URL }, { type: "input_image", image_url: DATA_URL }] }] }),
            1000);
        assert.equal(
            imageTokensInParsedBody("responses", { input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/a.png" }] }] }),
            500);
    } finally {
        delete process.env.BILI_IMAGE_TOKEN_CAP;
    }
});

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a multi-step debugging session. Key decisions: chose the preflight approach over lossy truncation because the payload must stay coherent. Files touched: src/a.ts:10, src/b.ts:20. Outcome: fixed and verified by tests.";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function completed(inputTokens: number): string {
    return sse("response.completed", {
        response: { id: "resp_done", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5, total_tokens: inputTokens + 5 } },
    });
}

function longInput() {
    const input: { type: string; role: string; content: string }[] = [];
    for (let i = 0; i < 12; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return input;
}

async function startProxy(upstreamPort: number): Promise<{ proxy: http.Server; url: string }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-resp": { context: 10_000 } } } },
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
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return { proxy, url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses` };
}

test("e2e #488-B (Responses): preflight summary requests carry store:false so codex relays accept them", async () => {
    let summaryCalls = 0;
    const summaryBodies: unknown[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
            if (parsed.stream === false) {
                summaryCalls += 1;
                summaryBodies.push(parsed);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ output_text: SUMMARY_TEXT }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(completed(1000));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { proxy, url } = await startProxy(upstreamPort);

    try {
        // Fresh session replaying an oversized raw history (~13k > 10k window,
        // lastInputTokens=0) — preflight must run its summarization rescue.
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "resp-sess-b", instructions: "You are the test coding agent.", input: longInput() }),
        });
        assert.equal(r.status, 200, "oversized restored session's request succeeds");
        await r.text();

        assert.ok(summaryCalls >= 1, `preflight summarization ran (got ${summaryCalls})`);
        for (const b of summaryBodies) {
            assert.equal((b as { store?: unknown }).store, false, "preflight summary request keeps store:false");
        }

        const s = listSessions().find((x) => x.meta.label === "resp-sess-b");
        assert.ok(s, "session exists");
        assert.ok((s!.state.blocks ?? []).some((b) => b.active), "compression block recorded from preflight");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("e2e #488-A (Responses): images alone over the window are withheld with an actionable error, never forwarded", async () => {
    const streamForwards: boolean[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
            streamForwards.push(parsed.stream === true);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(completed(100));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { proxy, url } = await startProxy(upstreamPort);

    try {
        // 7 screenshots × 60k base64 chars = 7 × 15_000 = 105_000 image tokens,
        // against a 10_000 window — no amount of text folding can fix this.
        const bigB64 = "A".repeat(60_000);
        const input = [
            {
                type: "message",
                role: "user",
                content: [
                    { type: "input_text", text: "here are seven screenshots of the failing screen" },
                    ...Array.from({ length: 7 }, () => ({ type: "input_image", image_url: `data:image/png;base64,${bigB64}` })),
                ],
            },
        ];
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "img-sess-a", instructions: "You are the test coding agent.", input }),
        });
        assert.equal(r.status, 502, "over-window multimodal payload is withheld");
        const err = JSON.parse(await r.text()) as { error?: { code?: string; message?: string; retryable?: boolean } };
        assert.equal(err.error?.code, "preflight_compress_failed");
        assert.match(err.error?.message ?? "", /Images alone account for ~105000 tokens/);
        assert.ok(!streamForwards.includes(true), "the over-window payload was never forwarded upstream");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("e2e #488-A2 (Responses): image tokens count toward the output-budget clamp", async () => {
    const forwardedMaxOutput: number[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean; max_output_tokens?: number };
            if (parsed.stream === true && typeof parsed.max_output_tokens === "number") forwardedMaxOutput.push(parsed.max_output_tokens);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write(completed(100));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { proxy, url } = await startProxy(upstreamPort);

    try {
        // Control: text-only input vs the 10k window — a 5k output request fits, no clamp.
        const r1 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "img-sess-c1", instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: "hello there" }], max_output_tokens: 5_000 }),
        });
        assert.equal(r1.status, 200);
        await r1.text();

        // Same shape plus one 16k-base64-char screenshot (4_000 image tokens): input+output
        // would overflow the 10k window, so the outgoing max_output_tokens must be clamped.
        const bigB64 = "A".repeat(16_000);
        const r2 = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "img-sess-c2", instructions: "You are the test coding agent.", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "screenshot attached" }, { type: "input_image", image_url: `data:image/png;base64,${bigB64}` }] }], max_output_tokens: 5_000 }),
        });
        assert.equal(r2.status, 200);
        await r2.text();

        assert.equal(forwardedMaxOutput[0], 5_000, "text-only request keeps its requested output budget");
        assert.ok(forwardedMaxOutput.length >= 2, "image-bearing request was forwarded");
        assert.ok(forwardedMaxOutput[1] < 5_000, `image tokens shrink the output budget (got ${forwardedMaxOutput[1]})`);
        assert.ok(forwardedMaxOutput[1] >= 1024, "clamp stays above the floor");
    } finally {
        await closeAll(proxy, upstream);
    }
});

async function closeAll(...servers: http.Server[]): Promise<void> {
    for (const s of servers) {
        s.close();
        await once(s, "close");
    }
}
