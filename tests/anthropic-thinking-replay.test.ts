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
            id: "thinking-replay-test",
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

function round1Thinking(withSignature: boolean): string {
    const events = [
        sse("message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "I should compress first." } }),
    ];
    if (withSignature) {
        events.push(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } }));
    }
    events.push(
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "compress", input: {} } }),
        sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: COMPRESS_ARGS } }),
        sse("content_block_stop", { type: "content_block_stop", index: 1 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }),
        sse("message_stop", { type: "message_stop" }),
    );
    return events.join("");
}

const ROUND2_TEXT = [
    sse("message_start", { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 20 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Continued after compression." } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    sse("message_stop", { type: "message_stop" }),
].join("");

interface CapturedRequest {
    body: Record<string, unknown>;
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    captured: CapturedRequest[],
): Promise<string> {
    const chunks: Buffer[] = [];
    const adapter = createAnthropicAdapter({ model: "claude-test", stream: true, messages: [] });
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
    return Buffer.concat(chunks).toString("utf8");
}

function assistantThinkingBlocks(body: Record<string, unknown>): unknown[] {
    const messages = body.messages as { role: string; content: { type: string }[] }[];
    const blocks: unknown[] = [];
    for (const m of messages ?? []) {
        if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
        for (const block of m.content) {
            if (block.type === "thinking") blocks.push(block);
        }
    }
    return blocks;
}

test("issue #221: re-request rejected 400 → degraded retry without thinking replay succeeds (agent continues, no silent halt)", async () => {
    const captured: CapturedRequest[] = [];
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        fetchCalls++;
        captured.push({ body: JSON.parse(String(init?.body)) });
        if (fetchCalls === 1) {
            return new Response("invalid thinking block signature", { status: 400 });
        }
        return new Response(ROUND2_TEXT, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1Thinking(true), { status: 200 }).body!,
            makeCtx(),
            captured,
        );
        assert.equal(fetchCalls, 2, "first re-request 400s, degraded retry follows");
        assert.equal(assistantThinkingBlocks(captured[0].body).length, 1, "first re-request replays the signed thinking block");
        assert.equal(assistantThinkingBlocks(captured[1].body).length, 0, "degraded retry strips thinking blocks");
        assert.ok(JSON.stringify(captured[1].body).includes('"compress"'), "degraded retry keeps the compress tool_use + tool_result continuation");
        assert.ok(out.includes("[ACP]"), "marker surfaced to client");
        assert.ok(out.includes("Continued after compression."), "round-2 text reaches the client");
        assert.ok(!out.includes("upstream error"), "no error surfaced to the client");
        assert.ok(/"stop_reason":"end_turn"/.test(out), "turn ends with end_turn after real content (not a silent stop right after the marker)");
    } finally {
        globalThis.fetch = orig;
    }
});

test("issue #221: signature-less thinking (relay never sent signature_delta) is proactively dropped from the replay", async () => {
    const captured: CapturedRequest[] = [];
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        fetchCalls++;
        captured.push({ body: JSON.parse(String(init?.body)) });
        return new Response(ROUND2_TEXT, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1Thinking(false), { status: 200 }).body!,
            makeCtx(),
            captured,
        );
        assert.equal(fetchCalls, 1, "single re-request, accepted on first try");
        assert.equal(assistantThinkingBlocks(captured[0].body).length, 0, "signature-less thinking is never replayed (it 400s on Anthropic-protocol validation)");
        assert.ok(JSON.stringify(captured[0].body).includes('"compress"'), "compress continuation intact");
        assert.ok(out.includes("[ACP]"), "marker surfaced to client");
        assert.ok(out.includes("Continued after compression."), "round-2 text reaches the client");
    } finally {
        globalThis.fetch = orig;
    }
});

test("issue #221: degraded retry also rejected → error surfaced (visible failure, not a silent stop)", async () => {
    const captured: CapturedRequest[] = [];
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
        fetchCalls++;
        captured.push({ body: JSON.parse(String(init?.body)) });
        return new Response("bad request", { status: 400 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1Thinking(true), { status: 200 }).body!,
            makeCtx(),
            captured,
        );
        assert.equal(fetchCalls, 2, "one full attempt + one degraded attempt, then give up");
        assert.ok(out.includes("upstream error 400"), "error is visible to the client");
        assert.ok(/"stop_reason":"end_turn"/.test(out), "stream still terminates cleanly");
    } finally {
        globalThis.fetch = orig;
    }
});
