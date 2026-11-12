import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { runCompressLoop, createAnthropicAdapter } from "../src/loop/index.ts";
import type { LoopCtx } from "../src/loop/core.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #5495: an Anthropic-wire upstream that does NOT sign thinking blocks (DeepSeek's
// /anthropic endpoint) requires the UNSIGNED thinking block passed back on the
// acp-loop re-request — the old gate (core.ts: protocol anthropic|google ⇒ require
// signature) dropped every such round's reasoning, leaving the tool_use assistant
// message without its thinking sibling → 400 invalid_request_error:
// "The `content[].thinking` in the thinking mode must be passed back to the API."
//
// Facts these tests pin (verified against the unfixed loop):
//  - unsigned round on an anthropic lane: the re-request body carries the thinking
//    block verbatim as a sibling of the tool_use (compress AND acp_status paths);
//  - a round that DID see a signature keeps the requirement — an unsigned block in
//    such a round is still dropped (Claude/Gemini lanes unchanged);
//  - a "must be passed back" 400 propagates with NO degraded strip-retry (stripping
//    perpetuates the rejection), and arms strictReasoningEcho on the new wording;
//  - a neutral 400 still gets the degraded strip-retry (the exclusion is scoped).
//
// NOTE: unlike tests/verify-sig-roundtrip.test.ts, every ctx here sets
// protocol: "anthropic" — the production invariant (server.ts always populates it)
// is exactly what made the bug reachable, so the harness must reproduce it.

type ContentBlock = Record<string, unknown>;

function makeCtx(): LoopCtx {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages: [],
        session: {
            id: "issue5495-unsigned-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: () => {},
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const SYS_PROMPT = buildCompressSystemPrompt();

// 7 big messages: m00001/m00002 compressible (kernel protects the tail).
function bigCtx() {
    const ctx = makeCtx();
    const big = (tag: string) => `${tag} ${"x".repeat(5000)}`;
    ctx.messages = [
        { id: "raw_1", role: "user", contentType: "text", text: big("ONE") },
        { id: "raw_2", role: "assistant", contentType: "text", text: big("TWO") },
        { id: "raw_3", role: "user", contentType: "text", text: big("THREE") },
        { id: "raw_4", role: "assistant", contentType: "text", text: big("FOUR") },
        { id: "raw_5", role: "user", contentType: "text", text: big("FIVE") },
        { id: "raw_6", role: "assistant", contentType: "text", text: big("SIX") },
        { id: "raw_7", role: "user", contentType: "text", text: big("SEVEN") },
    ];
    ctx.session.state.messageRefs = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return ctx;
}

const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "PAIR-SUMMARY-PAYLOAD-THAT-IS-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });

// Round-1 shape: [thinking blocks...] then a tool_use call, NO signature_delta.
function round1Stream(thinkingBlocks: string[], toolName: string, toolId: string, args: string): string {
    let s = sse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 5 } } });
    for (let i = 0; i < thinkingBlocks.length; i++) {
        s += sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } });
        if (thinkingBlocks[i]) s += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: thinkingBlocks[i]! } });
        s += sse("content_block_stop", { type: "content_block_stop", index: i });
    }
    const ti = thinkingBlocks.length;
    s += sse("content_block_start", { type: "content_block_start", index: ti, content_block: { type: "tool_use", id: toolId, name: toolName, input: {} } });
    s += sse("content_block_delta", { type: "content_block_delta", index: ti, delta: { type: "input_json_delta", partial_json: args } });
    s += sse("content_block_stop", { type: "content_block_stop", index: ti });
    s += sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
    s += sse("message_stop", { type: "message_stop" });
    return s;
}

const ROUND2_DONE = [
    sse("message_start", { type: "message_start", message: { id: "msg_r2", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 2 } } }),
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
    sse("content_block_stop", { type: "content_block_stop", index: 0 }),
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    sse("message_stop", { type: "message_stop" }),
].join("");

function reFetchProbe(respond: (n: number) => Response): { calls: () => number; bodies: () => string[]; restore: () => void } {
    let n = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        n++;
        if (init?.body) bodies.push(String(init.body));
        return respond(n);
    }) as typeof fetch;
    return { calls: () => n, bodies: () => bodies, restore: () => { globalThis.fetch = orig; } };
}

// The assistant message that called `toolName`, with its wire content array.
function toolCallAssistant(body: string, toolName: string): ContentBlock[] {
    const reBody = JSON.parse(body) as { messages: { role: string; content?: ContentBlock[] }[] };
    const m = reBody.messages.find((x) => x.role === "assistant" && Array.isArray(x.content)
        && x.content!.some((c) => c.type === "tool_use" && c.name === toolName));
    assert.ok(m, `re-request body must include the assistant message that called ${toolName}`);
    return m!.content!;
}

test("#5495: unsigned thinking on an anthropic lane replays verbatim on the compress re-request (no 400)", async () => {
    const ctx = bigCtx();
    ctx.protocol = "anthropic";

    const probe = reFetchProbe(() => new Response(ROUND2_DONE, { status: 200, headers: { "content-type": "text/event-stream" } }));
    let out = "";
    try {
        const adapter = createAnthropicAdapter({ model: "deepseek-v4-flash", max_tokens: 512, stream: true });
        for await (const chunk of runCompressLoop(
            new Response(round1Stream(["正在分析如何压缩这段历史……"], "compress", "toolu_01", COMPRESS_ARGS), { status: 200 }).body!,
            ctx,
            { model: "deepseek-v4-flash", max_tokens: 512, stream: true },
            { url: "http://mock", headers: {} },
            adapter,
            SYS_PROMPT,
        )) {
            out += chunk.toString();
        }
    } finally {
        probe.restore();
    }

    assert.ok(probe.calls() >= 1, "re-request fires after compress");
    const content = toolCallAssistant(probe.bodies()[0]!, "compress");
    const thinking = content.filter((c) => c.type === "thinking");
    assert.equal(thinking.length, 1, "the unsigned thinking block must ride on the re-request (old code dropped it → 400)");
    assert.equal(thinking[0]!.thinking, "正在分析如何压缩这段历史……", "thinking text replayed verbatim");
    assert.ok(!("signature" in thinking[0]!) || thinking[0]!.signature === "", "no signature invented for an unsigned block");
    assert.ok(out.includes("message_stop"), "loop streams a complete Anthropic SSE response to the client");
});

test("#5495: same replay on the acp_status path (both proxy-tool append sites share the guard)", async () => {
    const ctx = makeCtx();
    ctx.protocol = "anthropic";

    const probe = reFetchProbe(() => new Response(ROUND2_DONE, { status: 200, headers: { "content-type": "text/event-stream" } }));
    try {
        const adapter = createAnthropicAdapter({ model: "deepseek-v4-flash", max_tokens: 512, stream: true });
        for await (const _chunk of runCompressLoop(
            new Response(round1Stream(["status round thinking"], "acp_status", "toolu_02", "{}"), { status: 200 }).body!,
            ctx,
            { model: "deepseek-v4-flash", max_tokens: 512, stream: true },
            { url: "http://mock", headers: {} },
            adapter,
            SYS_PROMPT,
        )) { /* drain */ }
    } finally {
        probe.restore();
    }

    assert.ok(probe.calls() >= 1, "re-request fires after acp_status");
    const content = toolCallAssistant(probe.bodies()[0]!, "acp_status");
    const thinking = content.filter((c) => c.type === "thinking");
    assert.equal(thinking.length, 1, "unsigned thinking must ride the acp_status re-request too");
    assert.equal(thinking[0]!.thinking, "status round thinking");
});

test("#5495 negative control: a round that SAW a signature keeps the requirement — the unsigned sibling stays dropped", async () => {
    const ctx = bigCtx();
    ctx.protocol = "anthropic";

    // Block A arrives unsigned, block B signed: per-attempt signing evidence is
    // present, so the Claude/Gemini fatality rule still applies to A.
    let s = sse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", content: [], usage: { input_tokens: 100, output_tokens: 5 } } });
    s += sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    s += sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "UNSIGNED-BLOCK-A" } });
    s += sse("content_block_stop", { type: "content_block_stop", index: 0 });
    s += sse("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
    s += sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "SIGNED-BLOCK-B" } });
    s += sse("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "signature_delta", signature: "SIG-B==" } });
    s += sse("content_block_stop", { type: "content_block_stop", index: 1 });
    s += sse("content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_03", name: "compress", input: {} } });
    s += sse("content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: COMPRESS_ARGS } });
    s += sse("content_block_stop", { type: "content_block_stop", index: 2 });
    s += sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
    s += sse("message_stop", { type: "message_stop" });

    const probe = reFetchProbe(() => new Response(ROUND2_DONE, { status: 200, headers: { "content-type": "text/event-stream" } }));
    try {
        const adapter = createAnthropicAdapter({ model: "claude-test", max_tokens: 512, stream: true });
        for await (const _chunk of runCompressLoop(
            new Response(s, { status: 200 }).body!,
            ctx,
            { model: "claude-test", max_tokens: 512, stream: true },
            { url: "http://mock", headers: {} },
            adapter,
            SYS_PROMPT,
        )) { /* drain */ }
    } finally {
        probe.restore();
    }

    assert.ok(probe.calls() >= 1, "re-request fires after compress");
    const content = toolCallAssistant(probe.bodies()[0]!, "compress");
    const thinking = content.filter((c) => c.type === "thinking");
    assert.equal(thinking.length, 1, "signing-lane rule unchanged: only the signed block survives the rebuild");
    assert.equal(thinking[0]!.thinking, "SIGNED-BLOCK-B");
    assert.equal(thinking[0]!.signature, "SIG-B==");
});

test("#5495: 'must be passed back' 400 propagates — no degraded strip-retry, learner arms on the new wording", async () => {
    const ctx = makeCtx();
    ctx.protocol = "anthropic";

    const deepseek400 = () => new Response(JSON.stringify({
        error: { message: "The `content[].thinking` in the thinking mode must be passed back to the API.", type: "invalid_request_error" },
    }), { status: 400, headers: { "content-type": "application/json" } });

    const probe = reFetchProbe(deepseek400);
    let out = "";
    try {
        const adapter = createAnthropicAdapter({ model: "deepseek-v4-flash", max_tokens: 512, stream: true });
        for await (const chunk of runCompressLoop(
            new Response(round1Stream(["mandatory thinking round"], "acp_status", "toolu_04", "{}"), { status: 200 }).body!,
            ctx,
            { model: "deepseek-v4-flash", max_tokens: 512, stream: true },
            { url: "http://mock", headers: {} },
            adapter,
            SYS_PROMPT,
        )) {
            out += chunk.toString();
        }
    } finally {
        probe.restore();
    }

    assert.ok(probe.calls() >= 1, "the re-request fired");
    assert.equal(probe.calls(), 1, "a thinking-required 400 must NOT get a strip-retry — stripping guarantees another 400");
    assert.ok(out.includes("upstream error 400"), `original rejection surfaces to the client: ${out.slice(0, 200)}`);
    const content = toolCallAssistant(probe.bodies()[0]!, "acp_status");
    assert.equal(content.filter((c) => c.type === "thinking").length, 1, "the (only) re-request carried the unsigned thinking");
    assert.equal(ctx.session.metadata.strictReasoningEcho, true, "learn-on-failure arms on DeepSeek's Anthropic-wire wording (#684/#5495)");
});

test("#5495 contrast: a neutral 400 still gets the degraded strip-retry (exclusion is scoped, not blanket)", async () => {
    const ctx = makeCtx();
    ctx.protocol = "anthropic";

    const neutral400 = JSON.stringify({ error: { message: "internal policy violation, no reasoning wording" } });
    const probe = reFetchProbe((n) => n === 1
        ? new Response(neutral400, { status: 400, headers: { "content-type": "application/json" } })
        : new Response(ROUND2_DONE, { status: 200, headers: { "content-type": "text/event-stream" } }));
    try {
        const adapter = createAnthropicAdapter({ model: "claude-test", max_tokens: 512, stream: true });
        for await (const _chunk of runCompressLoop(
            new Response(round1Stream(["optional thinking round"], "acp_status", "toolu_05", "{}"), { status: 200 }).body!,
            ctx,
            { model: "claude-test", max_tokens: 512, stream: true },
            { url: "http://mock", headers: {} },
            adapter,
            SYS_PROMPT,
        )) { /* drain */ }
    } finally {
        probe.restore();
    }

    assert.equal(probe.calls(), 2, "neutral 400 on an anthropic lane still triggers the #539 degraded retry");
    const first = toolCallAssistant(probe.bodies()[0]!, "acp_status");
    assert.equal(first.filter((c) => c.type === "thinking").length, 1, "first attempt carried the replayed thinking");
    const second = toolCallAssistant(probe.bodies()[1]!, "acp_status");
    assert.equal(second.filter((c) => c.type === "thinking").length, 0, "degraded retry stripped the loop thinking (existing recovery preserved)");
});
