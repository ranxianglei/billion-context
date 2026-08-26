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

// A stream that is cut right after message_start: NO content block, NO text,
// NO reasoning, NO completion event. This is the relay-timeout shape from
// issue #221 (a long-running request cut before any token is emitted).
const TRUNCATED_EMPTY = [
    sse("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } }),
].join("");

const COMPLETE_RETRY = [
    sse("message_start", { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 10 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "重试后完整输出" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    sse("message_stop", { type: "message_stop" }),
].join("");

function withTruncationRetries(max: string, fn: () => Promise<void>): Promise<void> {
    const prev = process.env.BILI_TRUNCATION_RETRY_MAX;
    process.env.BILI_TRUNCATION_RETRY_MAX = max;
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            if (prev === undefined) delete process.env.BILI_TRUNCATION_RETRY_MAX;
            else process.env.BILI_TRUNCATION_RETRY_MAX = prev;
        });
}

test("issue #221: no-content truncation auto-retries and delivers the full response", async () => {
    await withTruncationRetries("2", async () => {
        const out = await drain(streamOf(TRUNCATED_EMPTY), [COMPLETE_RETRY], makeCtx());
        assert.ok(out.includes("重试后完整输出"), "retry content should reach the client");
        assert.ok(!out.includes("upstream stream truncated"), "no error marker when the retry succeeds");
        assert.match(out, /stop_reason.*end_turn/, "client stream should terminate cleanly");
        const starts = (out.match(/event: message_start/g) ?? []).length;
        assert.equal(starts, 1, "retry must not duplicate message_start");
    });
});

test("issue #221: no-content truncation that keeps truncating surfaces the error after retries are exhausted", async () => {
    await withTruncationRetries("1", async () => {
        const out = await drain(streamOf(TRUNCATED_EMPTY), [TRUNCATED_EMPTY, TRUNCATED_EMPTY], makeCtx());
        assert.ok(out.includes("upstream stream truncated"), "error must surface once retries are exhausted");
        assert.ok(!out.includes("重试后完整输出"), "no content should have been delivered");
    });
});

test("issue #221: partial-content truncation is NOT auto-retried (would duplicate the streamed prefix)", async () => {
    await withTruncationRetries("2", async () => {
        const out = await drain(streamOf(TRUNCATED_CONCLUSION), [COMPLETE_RETRY], makeCtx());
        assert.ok(out.includes("upstream stream truncated"), "partial truncation must still surface the error");
        assert.ok(!out.includes("重试后完整输出"), "must not re-request and duplicate the partial prefix");
    });
});

// A stream cut after a COMPLETELY CLOSED real tool_use block (no text, no
// reasoning, no completion event): the tool call is already flushed to the
// client, which will execute it and follow up with the tool result.
const TRUNCATED_TOOLCALL = [
    sse("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "bash", input: {} } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "ls" }) } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
].join("");

test("issue #221: truncation that already flushed a real tool call is NOT auto-retried", async () => {
    await withTruncationRetries("2", async () => {
        const out = await drain(streamOf(TRUNCATED_TOOLCALL), [COMPLETE_RETRY], makeCtx());
        assert.ok(out.includes("toolu_9"), "the flushed tool call still reaches the client");
        assert.ok(out.includes("upstream stream truncated"), "must surface the error, not silently re-request");
        assert.ok(!out.includes("重试后完整输出"), "retry content must not land behind the emitted tool call in the same stream");
    });
});

test("issue #221: zero-content truncation on the final round surfaces the error (no degenerate empty completion)", async () => {
    await withTruncationRetries("2", async () => {
        // Rounds 1-9: proxy-tool (compress) re-request loop. Round 10 (the last):
        // zero-content truncation — nothing left to re-request into, so the error
        // must surface instead of a silent stop_reason "length" completion.
        const upstreams = [...Array(8).fill(ROUND1_COMPRESS), TRUNCATED_EMPTY];
        const out = await drain(streamOf(ROUND1_COMPRESS), upstreams, makeCtx());
        assert.ok(out.includes("upstream stream truncated (no completion event; round 10"), "final-round truncation must surface");
        assert.ok(!out.includes('"stop_reason":"length"'), "must not end with a degenerate length completion");
    });
});

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
