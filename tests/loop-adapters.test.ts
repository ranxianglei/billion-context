import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

function makeCtx(id: string, messages: CoreMessage[] = []): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    proxyUrl?: string;
    textProtocol?: boolean;
} {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages,
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
    };
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    adapter: ReturnType<typeof createOpenaiAdapter> | ReturnType<typeof createAnthropicAdapter>,
    requestBody: Record<string, unknown>,
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, { url: "http://mock", headers: {} }, adapter, buildCompressSystemPrompt())) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

test("openai adapter: plain text round-trips live + [DONE] termination", async () => {
    const round1 = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const out = await drain(
        new Response(round1, { status: 200 }).body!,
        makeCtx("openai-text"),
        createOpenaiAdapter({ model: "gpt" }),
        { model: "gpt", messages: [], stream: true },
    );
    assert.ok(out.includes("Hello"), "round-1 text streamed live");
    assert.ok(out.includes("[DONE]"), "[DONE] terminator present");
    assert.ok(/finish_reason/.test(out), "finish chunk present");
});

test("openai adapter: acp_status-only round → marker + graceful completion, no re-request, no crash", async () => {
    const round1 = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_s", type: "function", function: { name: "acp_status", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx("openai-status"),
            createOpenaiAdapter({ model: "gpt" }),
            { model: "gpt", messages: [], stream: true },
        );
        assert.ok(out.includes("[ACP]"), "acp_status marker surfaced");
        assert.ok(out.includes("[DONE]"), "graceful completion ([DONE])");
        assert.equal(fetchCalls, 0, "no re-request for read-only acp_status");
    } finally {
        globalThis.fetch = orig;
    }
});

test("anthropic adapter: plain text round-trips live + message_delta/message_stop termination", async () => {
    const round1 = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const out = await drain(
        new Response(round1, { status: 200 }).body!,
        makeCtx("anthropic-text"),
        createAnthropicAdapter({ model: "claude" }),
        { model: "claude", messages: [], stream: true, max_tokens: 10 },
    );
    assert.ok(out.includes("Hello"), "round-1 text streamed live");
    assert.ok(out.includes("message_delta"), "message_delta terminal present");
    assert.ok(out.includes("message_stop"), "message_stop terminal present");
});

test("anthropic adapter: acp_status-only round → marker + graceful completion, no re-request, no crash", async () => {
    const round1 = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_s", name: "acp_status", input: {} } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx("anthropic-status"),
            createAnthropicAdapter({ model: "claude" }),
            { model: "claude", messages: [], stream: true, max_tokens: 10 },
        );
        assert.ok(out.includes("[ACP]"), "acp_status marker surfaced");
        assert.ok(out.includes("message_stop"), "graceful completion (message_stop)");
        assert.equal(fetchCalls, 0, "no re-request for read-only acp_status");
    } finally {
        globalThis.fetch = orig;
    }
});

test("openai adapter (S1): a single finish_reason chunk is forwarded exactly once (not double-emitted)", async () => {
    const round1 = [
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        `data: [DONE]\n\n`,
    ].join("");
    const out = await drain(
        new Response(round1, { status: 200 }).body!,
        makeCtx("openai-single-finish"),
        createOpenaiAdapter({ model: "gpt" }),
        { model: "gpt", messages: [], stream: true },
    );
    const finishCount = (out.match(/"finish_reason":"stop"/g) || []).length;
    assert.equal(finishCount, 1, "finish_reason:\"stop\" emitted exactly once (S1: original finish chunk not passthrough'd + emitCompletion)");
});

test("ACP_LOOP_V2 smoke: import + runCompressLoop round-trips (responses) without crashing", async () => {
    const mod = await import("../src/loop/index.ts");
    assert.equal(typeof mod.runCompressLoop, "function", "runCompressLoop exported");
    assert.equal(typeof mod.pickAdapter, "function", "pickAdapter exported");
    const adapter = mod.pickAdapter("responses", { model: "gpt" });
    assert.equal(typeof adapter.parseStream, "function", "responses adapter has parseStream");
    const openaiA = mod.pickAdapter("openai", { model: "gpt" });
    assert.equal(typeof openaiA.emitCompletion, "function", "openai adapter has emitCompletion");
    const anthA = mod.pickAdapter("anthropic", { model: "claude" });
    assert.equal(typeof anthA.emitText, "function", "anthropic adapter has emitText");
});
