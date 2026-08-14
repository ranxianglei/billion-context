import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// Verification test for the thinking-signature 400 fix:
// round 1 streams thinking_delta + signature_delta + compress tool_use;
// the loop must rebuild the reasoning message WITH thinkingSignature, so the
// round-2 re-request body carries the signature back to upstream.

function makeCtx(messages: CoreMessage[] = []): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "sig-roundtrip-test",
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

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function bigText(n: number): string {
    return "x".repeat(n);
}

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function bigCtx() {
    return withRefs(makeCtx([
        { id: "raw_1", role: "user", contentType: "text", text: bigText(5000) },
        { id: "raw_2", role: "assistant", contentType: "text", text: bigText(5000) },
        { id: "raw_3", role: "user", contentType: "text", text: bigText(5000) },
        { id: "raw_4", role: "assistant", contentType: "text", text: bigText(5000) },
        { id: "raw_5", role: "user", contentType: "text", text: bigText(5000) },
        { id: "raw_6", role: "assistant", contentType: "text", text: bigText(5000) },
        { id: "raw_7", role: "user", contentType: "text", text: bigText(5000) },
    ]));
}

// Locate the thinking block(s) of the round-1 assistant turn in a re-request body.
function thinkingBlocksOf(body: string): { thinking?: string; signature?: string }[] {
    const reBody = JSON.parse(body);
    const asstMsgs = (reBody.messages as { role: string; content?: { type?: string }[] }[])
        .filter((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "thinking"));
    assert.equal(asstMsgs.length, 1, `expected 1 assistant thinking message, got ${asstMsgs.length}`);
    return asstMsgs[0]!.content!.filter((c) => c.type === "thinking") as { thinking?: string; signature?: string }[];
}

const SYS_PROMPT = buildCompressSystemPrompt();

// Round-2 (re-request) mock: return a clean Anthropic completion so the loop
// terminates. Capture the re-request body for assertions.
function reFetchProbe(): { calls: () => number; bodies: () => string[]; restore: () => void } {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    const round2 = [
        sse("message_start", { type: "message_start", message: { id: "msg_r2", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 2 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return new Response(round2, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    return { calls: () => n, bodies: () => bodies, restore: () => { globalThis.fetch = orig; } };
}

test("sig-roundtrip: round-1 thinking+signature → round-2 re-request body carries signature (400 fix)", async () => {
    // 7 big messages: m00001/m00002 compressible (kernel protects last 5).
    const ctx = bigCtx();

    const sig = "EhMiCg-R2VmJjk6ODAzNjcyNDA5Mzc0Nw==";
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "PAIR-SUMMARY-PAYLOAD-THAT-IS-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    const round1 = [
        sse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 5 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "正在分析如何压缩这段历史……" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: sig } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "compress", input: {} } }),
        sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: compressArgs } }),
        sse("content_block_stop", { type: "content_block_stop", index: 1 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");

    const probe = reFetchProbe();
    try {
        const adapter = createAnthropicAdapter({ model: "deepseek-v4-flash", max_tokens: 512, stream: true });
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "deepseek-v4-flash", max_tokens: 512, stream: true },
            { url: "http://mock", headers: {} },
            adapter,
            SYS_PROMPT,
        )) {
            chunks.push(chunk);
        }
        const out = Buffer.concat(chunks).toString("utf8");

        assert.ok(probe.calls() >= 1, "re-request fires after compress");
        const bodies = probe.bodies();
        assert.equal(bodies.length, 1, "exactly one re-request body");
        const reBody = JSON.parse(bodies[0]);

        // The rebuilt reasoning message must carry the signature so DeepSeek
        // does not 400 ("content[].thinking in thinking mode must be passed back").
        // Round-1's assistant (thinking + tool_use) is the LAST assistant message.
        const asstMsgs = (reBody.messages as { role: string; content?: { type?: string; signature?: string }[] }[])
            .filter((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((c) => c.type === "thinking"));
        assert.ok(asstMsgs.length === 1, `expected 1 assistant thinking message, got ${asstMsgs.length}`);
        const thinkingBlock = asstMsgs[0]!.content!.find((c) => c.type === "thinking");
        assert.ok(thinkingBlock, "re-request body contains a thinking block");
        assert.equal(thinkingBlock.signature, sig, "signature survives the rebuild → no 400");
        assert.ok(out.includes("message_stop"), "loop streams a complete Anthropic SSE response to the client");
    } finally {
        probe.restore();
    }
});

test("sig-roundtrip: signature_delta split across fragments concatenates (protocol allows fragmented signatures)", async () => {
    const ctx = bigCtx();
    const sig1 = "EhMiCg-R2VmJjk6ODAz";
    const sig2 = "NjcyNDA5Mzc0Nw==";
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "PAIR-SUMMARY-PAYLOAD-THAT-IS-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    const round1 = [
        sse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 5 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "正在分析如何压缩这段历史……" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: sig1 } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: sig2 } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "compress", input: {} } }),
        sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: compressArgs } }),
        sse("content_block_stop", { type: "content_block_stop", index: 1 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");

    const probe = reFetchProbe();
    try {
        const adapter = createAnthropicAdapter({ model: "deepseek-v4-flash", max_tokens: 512, stream: true });
        for await (const _chunk of runCompressLoop(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "deepseek-v4-flash", max_tokens: 512, stream: true },
            { url: "http://mock", headers: {} },
            adapter,
            SYS_PROMPT,
        )) {
            // drain
        }
        assert.equal(probe.bodies().length, 1, "exactly one re-request body");
        const blocks = thinkingBlocksOf(probe.bodies()[0]!);
        assert.equal(blocks.length, 1, "single thinking block");
        assert.equal(blocks[0]!.signature, sig1 + sig2, "fragmented signature_delta events concatenate into the full signature");
    } finally {
        probe.restore();
    }
});

test("sig-roundtrip: interleaved thinking blocks each keep their own signature", async () => {
    const ctx = bigCtx();
    const sigA = "SIG-BLOCK-A==";
    const sigB = "SIG-BLOCK-B==";
    const compressArgs = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "PAIR-SUMMARY-PAYLOAD-THAT-IS-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });
    const round1 = [
        sse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 5 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先分析历史结构。" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: sigA } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "再确认压缩范围。" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: sigB } }),
        sse("content_block_stop", { type: "content_block_stop", index: 1 }),
        sse("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_01", name: "compress", input: {} } }),
        sse("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: compressArgs } }),
        sse("content_block_stop", { type: "content_block_stop", index: 2 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
        sse("message_stop", { type: "message_stop" }),
    ].join("");

    const probe = reFetchProbe();
    try {
        const adapter = createAnthropicAdapter({ model: "deepseek-v4-flash", max_tokens: 512, stream: true });
        for await (const _chunk of runCompressLoop(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "deepseek-v4-flash", max_tokens: 512, stream: true },
            { url: "http://mock", headers: {} },
            adapter,
            SYS_PROMPT,
        )) {
            // drain
        }
        assert.equal(probe.bodies().length, 1, "exactly one re-request body");
        const blocks = thinkingBlocksOf(probe.bodies()[0]!);
        assert.equal(blocks.length, 2, "two thinking blocks rebuilt as separate blocks");
        assert.equal(blocks[0]!.thinking, "先分析历史结构。");
        assert.equal(blocks[0]!.signature, sigA, "first thinking block keeps its own signature");
        assert.equal(blocks[1]!.thinking, "再确认压缩范围。");
        assert.equal(blocks[1]!.signature, sigB, "second thinking block keeps its own signature");
    } finally {
        probe.restore();
    }
});
