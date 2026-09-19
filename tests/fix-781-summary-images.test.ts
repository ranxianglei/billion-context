import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { CoreMessage } from "acp-kernel";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";
import { IMAGE_PLACEHOLDER, imagePlaceholders, messageImages } from "../src/image-note.ts";

// Issue #781: renderRange only read m.text while images ride BiliMessage
// sidecars — so every image in a folded range vanished from the tier-1 summary
// input (openai image-only messages were skipped outright, responses dropped
// image-only items at toCore, anthropic left a bare information-free "[image]").
// Each carried image must now render as an explicit placeholder in the summary
// input, carrying real pixels nowhere (placeholder-only by design).

function pngB64(w: number, h: number): string {
    const b = Buffer.alloc(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b.toString("base64");
}

function jpegB64(w: number, h: number): string {
    const b = Buffer.alloc(30);
    b[0] = 0xff; b[1] = 0xd8;
    b[2] = 0xff; b[3] = 0xe0; b[4] = 0x00; b[5] = 0x10;
    b.write("JFIF", 6, "ascii");
    b[20] = 0xff; b[21] = 0xc0; b[22] = 0x00; b[23] = 0x11; b[24] = 0x08;
    b.writeUInt16BE(h, 25);
    b.writeUInt16BE(w, 27);
    return b.toString("base64");
}

const PNG_B64 = pngB64(1024, 768);
const JPEG_B64 = jpegB64(768, 1024);
const GARBAGE_B64 = "A".repeat(8000);

function msg(extra: Record<string, unknown>): CoreMessage {
    return { id: "u1", role: "user", contentType: "text", ...extra } as CoreMessage;
}

function countOcc(s: string, sub: string): number {
    let n = 0, i = s.indexOf(sub);
    while (i !== -1) { n++; i = s.indexOf(sub, i + sub.length); }
    return n;
}

test("image-note: plain text message carries no images", () => {
    assert.deepEqual(messageImages(msg({ text: "hello world" })), []);
    assert.deepEqual(imagePlaceholders(msg({ text: "hello world" })), []);
});

test("image-note: anthropic base64 image block yields media type + decoded dimensions", () => {
    const m = msg({
        text: "[image]",
        rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
    });
    assert.deepEqual(imagePlaceholders(m), ["[image: png 1024x768]"]);
});

test("image-note: anthropic url-source images degrade gracefully", () => {
    const remote = msg({ text: "[image]", rawAnthropicBlock: { type: "image", source: { type: "url", media_type: "image/png", url: "https://example.com/a.png" } } });
    assert.deepEqual(imagePlaceholders(remote), ["[image: png]"]);
    const dataUrl = msg({ text: "[image]", rawAnthropicBlock: { type: "image", source: { type: "url", url: `data:image/png;base64,${PNG_B64}` } } });
    assert.deepEqual(imagePlaceholders(dataUrl), ["[image: png 1024x768]"]);
});

test("image-note: anthropic structured tool_result sidecar is not an image", () => {
    const m = msg({ text: "result", contentType: "tool-result", rawAnthropicBlock: { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] } });
    assert.deepEqual(messageImages(m), []);
});

test("image-note: openai single data-URL image yields media type + dimensions", () => {
    const m = msg({
        text: "look here",
        rawOpenaiContent: { type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` } },
        imageMediaType: "image/jpeg",
        imageBase64: JPEG_B64,
    });
    assert.deepEqual(imagePlaceholders(m), ["[image: jpeg 768x1024]"]);
});

test("image-note: openai multi-image parts walk in order", () => {
    // The codec's rawOpenaiContentParts only ever carries data-URL parts
    // (allImageParts filters on parseDataUrl success); remote-URL parts are
    // dropped at toCore — tracked separately as a kernel-side gap.
    const m = msg({
        rawOpenaiContentParts: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${JPEG_B64}` } },
        ],
    });
    assert.deepEqual(imagePlaceholders(m), ["[image: png 1024x768]", "[image: jpeg 768x1024]"]);
});

test("image-note: openai developer-role rawOpenaiContent object is not an image", () => {
    const m = msg({ text: "", rawOpenaiContent: { role: "developer", content: "be concise" } });
    assert.deepEqual(messageImages(m), []);
});

test("image-note: openai single rawOpenaiContent without a decodable data URL degrades to the bare placeholder", () => {
    const m = msg({ text: "", rawOpenaiContent: { type: "image_url", image_url: { url: "https://example.com/legacy.png" } } });
    assert.deepEqual(messageImages(m), [{}]);
    assert.deepEqual(imagePlaceholders(m), [IMAGE_PLACEHOLDER]);
});

test("image-note: responses item keeps every input_image part", () => {
    const m = msg({
        text: "see the shots",
        rawResponsesItem: {
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: "see the shots" },
                { type: "input_image", image_url: `data:image/png;base64,${PNG_B64}` },
                { type: "input_image", image_url: "https://example.com/c.png" },
            ],
        },
    });
    assert.deepEqual(imagePlaceholders(m), ["[image: png 1024x768]", "[image]"]);
});

test("image-note: responses singular imageBase64 fallback works without the item", () => {
    const m = msg({ text: "shot", imageMediaType: "image/png", imageBase64: PNG_B64 });
    assert.deepEqual(imagePlaceholders(m), ["[image: png 1024x768]"]);
});

test("image-note: undecodable payloads degrade to media type, then the bare placeholder", () => {
    assert.deepEqual(imagePlaceholders(msg({ imageMediaType: "image/png", imageBase64: GARBAGE_B64 })), ["[image: png]"]);
    const bare = imagePlaceholders(msg({ imageBase64: GARBAGE_B64 }));
    assert.deepEqual(bare, [IMAGE_PLACEHOLDER]);
    assert.equal(IMAGE_PLACEHOLDER, "[image]");
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

function anthropicOkSse(inputTokens: number): string {
    return (
        sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } }) +
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }) +
        sse("message_stop", { type: "message_stop" })
    );
}

function filler(i: number): string {
    return `MARKER_${i}_content_`.repeat(250);
}

async function startProxy(upstreamPort: number, model: string, path: string): Promise<{ proxy: http.Server; url: string }> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [model]: { context: 10_000 } } } },
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
    return { proxy, url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${path}` };
}

async function closeAll(...servers: http.Server[]): Promise<void> {
    for (const s of servers) {
        s.close();
        await once(s, "close");
    }
}

test("e2e #781 (Responses): mixed text+image items render explicit placeholders in the summary input", async () => {
    const summaryBodies: unknown[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
            if (parsed.stream === false) {
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
    const { proxy, url } = await startProxy(upstreamPort, "gpt-resp", "/v1/responses");

    try {
        const input: unknown[] = [
            { type: "message", role: "user", content: [{ type: "input_text", text: "here is the failing screen" }, { type: "input_image", image_url: `data:image/png;base64,${PNG_B64}` }] },
            { type: "message", role: "assistant", content: `Message 0 of the long conversation. ${filler(0)}` },
            { type: "message", role: "user", content: [{ type: "input_text", text: "and another screenshot" }, { type: "input_image", image_url: `data:image/png;base64,${PNG_B64}` }] },
        ];
        for (let i = 1; i < 12; i++) {
            input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ${filler(i)}` });
        }
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-resp", stream: true, session_id: "img-sess-781-resp", instructions: "You are the test coding agent.", input }),
        });
        assert.equal(r.status, 200, "oversized multimodal session's request succeeds");
        await r.text();

        assert.ok(summaryBodies.length >= 1, `preflight summarization ran (got ${summaryBodies.length})`);
        const all = summaryBodies.map((b) => JSON.stringify(b)).join("\n");
        assert.equal(countOcc(all, "[image: png 1024x768]"), 2, "every folded image renders one explicit placeholder in the summary input");
        assert.ok(!all.includes(PNG_B64.slice(0, 24)), "no image bytes leak into the summary request");

        const s = listSessions().find((x) => x.meta.label === "img-sess-781-resp");
        assert.ok(s, "session exists");
        assert.ok((s!.state.blocks ?? []).some((b) => b.active), "compression block recorded from preflight");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("e2e #781 (Anthropic): the codec's bare [image] literal is replaced by the richer note", async () => {
    const summaryBodies: Array<{ messages?: Array<{ role?: string; content?: unknown }> }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
            if (!parsed.stream) {
                summaryBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "msg_summary",
                    type: "message",
                    role: "assistant",
                    model: "claude-small",
                    content: [{ type: "text", text: SUMMARY_TEXT }],
                    stop_reason: "end_turn",
                    usage: { input_tokens: 500, output_tokens: 50 },
                }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(anthropicOkSse(1000));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { proxy, url } = await startProxy(upstreamPort, "claude-small", "/v1/messages");

    try {
        const messages: unknown[] = [
            { role: "user", content: `Message 0 of the long conversation. ${filler(0)}` },
            { role: "assistant", content: `Message 1 of the long conversation. ${filler(1)}` },
            { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }] },
        ];
        // 14 messages total: with a 10k window the kernel's protected tail
        // leaves m00001–m00009 compressible — exactly enough to fold under
        // (18k → ~9.7k); 13 messages stalls at ~10.7k and fails preflight.
        for (let i = 2; i < 13; i++) {
            messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ${filler(i)}` });
        }
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "img-sess-781-anth" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, messages }),
        });
        assert.equal(r.status, 200, "oversized multimodal session's request succeeds");
        await r.text();

        assert.ok(summaryBodies.length >= 1, `preflight summarization ran (got ${summaryBodies.length})`);
        const userTexts = summaryBodies.flatMap((b) => (b.messages ?? []).filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))));
        const joined = userTexts.join("\n");
        assert.equal(countOcc(joined, "[image: png 1024x768]"), 1, "the image block renders as the richer placeholder");
        assert.ok(!joined.includes("[image]"), "the bare codec literal no longer appears");
        assert.ok(!joined.includes(PNG_B64.slice(0, 24)), "no image bytes leak into the summary request");
    } finally {
        await closeAll(proxy, upstream);
    }
});

test("e2e #781 (OpenAI): image-bearing messages render placeholders in the summary input", async () => {
    const summaryBodies: unknown[] = [];
    const forwards: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string }> };
            // #987: detect summary calls by shape (two messages, system first)
            // — the 32k output cap is now clamped to the window headroom on
            // small windows and no longer identifies them.
            const msgs = parsed.messages;
            if (Array.isArray(msgs) && msgs.length === 2 && msgs[0]?.role === "system") {
                summaryBodies.push(JSON.parse(raw));
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY_TEXT } }] }));
                return;
            }
            forwards.push(raw);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-781",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1000, completion_tokens: 3, total_tokens: 1003 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const { proxy, url } = await startProxy(upstreamPort, "gpt-small", "/v1/chat/completions");

    try {
        const messages: unknown[] = [
            { role: "user", content: `Message 0 of the long conversation. ${filler(0)}` },
            { role: "user", content: [{ type: "text", text: "screenshot one" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } }] },
            { role: "assistant", content: `Message 1 of the long conversation. ${filler(1)}` },
            { role: "user", content: [{ type: "text", text: "screenshot two" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_B64}` } }] },
        ];
        for (let i = 2; i < 12; i++) {
            messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the long conversation. ${filler(i)}` });
        }
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "img-sess-781-oai" },
            body: JSON.stringify({ model: "gpt-small", max_tokens: 1024, messages }),
        });
        assert.equal(r.status, 200, "oversized multimodal session's request succeeds");
        await r.text();

        assert.ok(summaryBodies.length >= 1, `preflight summarization ran (got ${summaryBodies.length})`);
        const all = summaryBodies.map((b) => JSON.stringify(b)).join("\n");
        assert.equal(countOcc(all, "[image: png 1024x768]"), 2, "every folded image renders one explicit placeholder in the summary input");
        assert.ok(!all.includes(PNG_B64.slice(0, 24)), "no image bytes leak into the summary request");
        assert.equal(forwards.length, 1, "exactly one forward upstream");
        assert.ok(forwards[0]!.includes(SUMMARY_TEXT), "the rebuilt payload carries the preflight summary");
    } finally {
        await closeAll(proxy, upstream);
    }
});
