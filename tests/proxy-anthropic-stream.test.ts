import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteSseStream } from "../src/stream.ts";
import { COMPRESS_TOOL_NAME } from "../src/compress-tool.ts";
import { createCore, createInitialState, defaultConfig } from "acp-kernel";

function makeCtx() {
    const core = createCore();
    const config = defaultConfig(200000);
    const state = createInitialState();
    return { ctx: { core, config, messages: [], session: { id: "t", meta: {}, stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, contextTokens: 0 }, metadata: {}, state }, log: () => {} } as never };
}

function evt(type: string, data: object): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function rewrite(sse: string, ctx: never): Promise<string> {
    const upstream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); } });
    const out: string[] = [];
    for await (const buf of rewriteSseStream(upstream, ctx)) out.push(buf.toString("utf8"));
    return out.join("");
}

// C1 regression: a plain text response (no compress tool_use) must preserve
// message_delta + message_stop. Before the fix these were unconditionally
// dropped, so every non-compress Anthropic stream hung the client.
test("C1: plain text response preserves message_delta and message_stop", async () => {
    const { ctx } = makeCtx();
    const sse = [
        evt("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant" as const, content: [], model: "claude", stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
        evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
        evt("content_block_stop", { type: "content_block_stop", index: 0 }),
        evt("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
        evt("message_stop", { type: "message_stop" }),
    ].join("");
    const out = await rewrite(sse, ctx);
    assert.ok(out.includes('"Hello"'), "text content must pass through");
    assert.ok(out.includes('"message_delta"'), "message_delta must be preserved (C1)");
    assert.ok(out.includes('"message_stop"'), "message_stop must be preserved (C1)");
    assert.ok(out.includes('"end_turn"'), "original stop_reason must survive");
});

// When a compress tool_use IS present, the original message_delta is suppressed
// and a rewritten one (end_turn, no real tool_use) is emitted at the end.
test("compress tool_use suppresses original message_delta and emits rewritten stop", async () => {
    const { ctx } = makeCtx();
    const sse = [
        evt("message_start", { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant" as const, content: [], model: "claude", stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
        evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: COMPRESS_TOOL_NAME, input: {} } }),
        evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"content":[{"startId":"m00001","endId":"m00001","summary":"x"}]}' } }),
        evt("content_block_stop", { type: "content_block_stop", index: 0 }),
        evt("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
        evt("message_stop", { type: "message_stop" }),
    ].join("");
    const out = await rewrite(sse, ctx);
    assert.ok(out.includes("Compressed") || out.includes("Compression FAILED"), "compress note must be emitted");
    assert.ok(out.includes('"end_turn"'), "rewritten stop_reason must be end_turn");
});

// M2 regression: the replacement text block must reuse the suppressed tool_use's
// index, not hardcode 0. Here compress is at index 2 (after two text blocks).
test("M2: replacement block uses the suppressed tool_use index, not hardcoded 0", async () => {
    const { ctx } = makeCtx();
    const sse = [
        evt("message_start", { type: "message_start", message: { id: "msg_3", type: "message", role: "assistant" as const, content: [], model: "claude", stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }),
        evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "thinking" } }),
        evt("content_block_stop", { type: "content_block_stop", index: 0 }),
        evt("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
        evt("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "more" } }),
        evt("content_block_stop", { type: "content_block_stop", index: 1 }),
        evt("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_2", name: COMPRESS_TOOL_NAME, input: {} } }),
        evt("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"content":[{"startId":"m00001","endId":"m00001","summary":"x"}]}' } }),
        evt("content_block_stop", { type: "content_block_stop", index: 2 }),
        evt("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
        evt("message_stop", { type: "message_stop" }),
    ].join("");
    const out = await rewrite(sse, ctx);
    // The replacement content_block must reference index 2 (the tool_use
    // position), proving it reused the suppressed block's index, not 0.
    // (The original index:2 tool_use was suppressed, so any index:2 in the
    // output comes only from the replacement block.)
    assert.ok(out.includes('"index":2'), "replacement content_block must use index 2 (M2)");
    // Replacement emitted some compress note (success or failed — messages is
    // empty here so applyRanges will report failure, which is fine).
    assert.ok(/ompress/i.test(out), "a compress note must be emitted for the tool_use");
});
