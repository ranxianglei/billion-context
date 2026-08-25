import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop } from "../src/loop/core.ts";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

function makeCtx(messages: CoreMessage[] = []) {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages,
        session: {
            id: "truncation-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        } as unknown as Session,
        log: () => {},
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] });

const TRUNCATED_CONCLUSION = [
    sse("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "本周总结:项目进展顺利," } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "下周计划包括" } }),
].join("");

const COMPLETE_CONCLUSION = TRUNCATED_CONCLUSION + [
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    sse("message_stop", { type: "message_stop" }),
].join("");

const ROUND1_COMPRESS = [
    sse("message_start", { type: "message_start", message: { id: "msg_0", usage: { input_tokens: 10 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "compress", input: {} } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: COMPRESS_ARGS } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
    sse("message_stop", { type: "message_stop" }),
].join("");

function streamOf(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    upstreams: string[],
    ctx: ReturnType<typeof makeCtx>,
): Promise<string> {
    const chunks: Buffer[] = [];
    const adapter = createAnthropicAdapter({ model: "claude-test", stream: true, messages: [] });
    let call = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        const body = upstreams[call] ?? upstreams[upstreams.length - 1];
        call += 1;
        return new Response(streamOf(body), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        for await (const chunk of runCompressLoop(
            stream,
            ctx as never,
            { model: "claude-test", stream: true, messages: [] },
            { url: "http://mock", headers: {} },
            adapter,
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = realFetch;
    }
    return Buffer.concat(chunks).toString("utf8");
}

test("issue #221 follow-up: truncated final round surfaces a visible error instead of silent end_turn", async () => {
    const out = await drain(streamOf(TRUNCATED_CONCLUSION), [], makeCtx());
    assert.ok(out.includes("本周总结"), "partial conclusion text should still reach the client");
    assert.ok(out.includes("[acp-proxy: upstream stream truncated"), "truncation must be visible, not a silent end_turn");
    assert.ok(out.includes("round 1"), "error should identify the round");
    assert.match(out, /stop_reason.*end_turn/, "client stream should still terminate cleanly");
});

test("control: normally completed round still ends without any error marker", async () => {
    const out = await drain(streamOf(COMPLETE_CONCLUSION), [], makeCtx());
    assert.ok(out.includes("本周总结"));
    assert.ok(!out.includes("upstream stream truncated"), "no false positive on a clean stream");
    assert.match(out, /stop_reason.*end_turn/);
});

test("truncated round after a compress round (conclusion dies mid-stream) is visible", async () => {
    const out = await drain(streamOf(ROUND1_COMPRESS), [TRUNCATED_CONCLUSION], makeCtx());
    assert.ok(out.includes("[ACP]"), "compress visibility marker should be present");
    assert.ok(out.includes("upstream stream truncated (no completion event; round 2"), "round-2 truncation must surface");
});
