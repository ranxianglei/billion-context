import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.ts";
import { emitStreamError } from "../src/stream-error.ts";

// #7461: pin that the Anthropic stream the proxy synthesizes is accepted by the
// official `@anthropic-ai/sdk` — the same guarantee #7402 established for the
// Responses wire. The official SDK enforces the full SSE lifecycle (message_start
// before any content block); a synthesized stream that skips it is rejected
// ("Unexpected event order"), the same failure class as #7401.

function collector(): { res: ServerResponse; chunks: string[] } {
    const chunks: string[] = [];
    const res = {
        write(chunk: string | Buffer) { chunks.push(chunk.toString()); return true; },
        end() { return this; },
        once() { return this; },
        destroyed: false,
        writableEnded: false,
    } as unknown as ServerResponse;
    return { res, chunks };
}

async function consume(raw: string) {
    const requireSdk = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { default: Anthropic } = await import(pathToFileURL(requireSdk.resolve("@anthropic-ai/sdk")).href);
    const client = new Anthropic({
        apiKey: "synthetic-test-key",
        fetch: async () => new Response(raw, { headers: { "content-type": "text/event-stream" } }),
    });
    const stream = client.messages.stream({ model: "synthetic", max_tokens: 1024, messages: [{ role: "user", content: "synthetic" }] });
    const textDeltas: string[] = [];
    stream.on("text", (delta: string) => textDeltas.push(delta));
    const final = await stream.finalMessage();
    return { textDeltas, final };
}

// The upstream's message_start owns every content block; the adapter forwards it
// verbatim and never re-emits it. A synthesized stream must still open with it or
// the official SDK rejects the whole response ("content_block_start before
// message_start").
const messageStart =
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_syn", type: "message", role: "assistant", model: "synthetic", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`;

test("official Anthropic SDK consumes synthesized text content", async () => {
    const adapter = createAnthropicAdapter({ model: "synthetic", max_tokens: 1024 });
    const raw = messageStart + adapter.emitText("generated text").toString() + adapter.emitCompletion().toString();
    const { textDeltas, final } = await consume(raw);
    assert.deepEqual(textDeltas, ["generated text"]);
    assert.equal(final.content[0].type, "text");
    assert.equal((final.content[0] as { text: string }).text, "generated text");
    assert.equal(final.stop_reason, "end_turn");
});

test("official Anthropic SDK consumes a synthesized tool call", async () => {
    const adapter = createAnthropicAdapter({ model: "synthetic", max_tokens: 1024 });
    const raw =
        messageStart +
        adapter.emitToolCall({ name: "get_weather", callId: "toolu_1", arguments: '{"city":"Paris"}' }).toString() +
        adapter.emitCompletion({ finishReason: "tool_use" }).toString();
    const { final } = await consume(raw);
    const toolBlock = final.content.find((b: { type: string }) => b.type === "tool_use") as { name: string; input: unknown } | undefined;
    assert.ok(toolBlock);
    assert.equal(toolBlock.name, "get_weather");
    assert.deepEqual(toolBlock.input, { city: "Paris" });
    assert.equal(final.stop_reason, "tool_use");
});

test("official Anthropic SDK keeps provider usage fields in the synthesized completion", async () => {
    const adapter = createAnthropicAdapter({ model: "synthetic", max_tokens: 1024 });
    const raw =
        messageStart +
        adapter.emitText("hi").toString() +
        adapter.emitCompletion({ finishReason: "end_turn", usage: { inputTokens: 11, outputTokens: 22, cachedTokens: 7 } }).toString();
    const { final } = await consume(raw);
    assert.equal(final.usage?.input_tokens, 11);
    assert.equal(final.usage?.output_tokens, 22);
    assert.equal(final.usage?.cache_read_input_tokens, 7);
});

test("official Anthropic SDK consumes the legacy stream-error completion", async () => {
    // #2689: the legacy completion synthesizes message_start when the stream never
    // began, so it is well-formed even as the client's first frame.
    const { res, chunks } = collector();
    emitStreamError(res, "anthropic", "kaboom", undefined, "completion");
    const { final } = await consume(chunks.join(""));
    assert.equal(final.content[0].type, "text");
    assert.equal((final.content[0] as { text: string }).text, "\n❌ [ACP] stream error: kaboom");
    assert.equal(final.stop_reason, "end_turn");
});

test("official Anthropic SDK consumes the adapter's legacy error completion", async () => {
    // The loop-level twin: an upstream error before any bytes makes this the
    // client's first frame — the adapter must synthesize message_start (#413).
    const adapter = createAnthropicAdapter({ model: "synthetic", max_tokens: 1024 }, undefined, undefined, "completion");
    const { final } = await consume(adapter.emitError("kaboom").toString());
    assert.equal(final.content[0].type, "text");
    assert.equal((final.content[0] as { text: string }).text, "\n[acp-proxy: kaboom]\n");
    assert.equal(final.stop_reason, "end_turn");
});

test("official Anthropic SDK still rejects the default native error", async () => {
    const { res, chunks } = collector();
    emitStreamError(res, "anthropic", "kaboom");
    await assert.rejects(consume(chunks.join("")));
});

test("official Anthropic SDK consumes a proxy-mode re-emitted text stream", async () => {
    const upstream =
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_up", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Length: 10 " } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "m" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    const { res, chunks } = collector();
    const adapter = createAnthropicAdapter({ model: "synthetic", max_tokens: 1024 });
    let finishReason: string | undefined;
    for await (const event of adapter.parseStream(new Response(upstream).body!, 1)) {
        if (event.kind === "meta") chunks.push(event.chunk.toString());
        else if (event.kind === "text" && event.raw) chunks.push(event.raw.toString());
        else if (event.kind === "done") finishReason = event.finishReason;
    }
    chunks.push(adapter.emitCompletion({ finishReason }).toString());
    const { textDeltas, final } = await consume(chunks.join(""));
    assert.deepEqual(textDeltas, ["Length: 10 ", "m"]);
    assert.equal((final.content[0] as { text: string }).text, "Length: 10 m");
    assert.equal(final.stop_reason, "end_turn");
});
