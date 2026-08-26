import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage, NudgeDecision } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { applyUsageFloor, pendingEstimateTokens } from "../src/util.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

function makeNudge(pendingT1: number, pendingT2 = 0, pendingT3 = 0): NudgeDecision {
    return {
        shouldInject: false,
        reason: "test",
        compressibleRanges: [],
        contextUsage: 0,
        tier: null,
        breakdown: {
            usage: 0,
            growth: 0,
            growthReference: 0,
            effectiveThreshold: 0,
            nudgeGrowthTokens: 50000,
            growthFloor: 22500,
            hasPendingNudge: 0,
            overLimit: 0,
            emergencyOverride: 0,
            pendingT1,
            pendingT2,
            pendingT3,
        },
    };
}

test("applyUsageFloor: engages only when the report is materially below the estimate", () => {
    // issue #256 shape: relay reports 5720, kernel counts 29238 pending T1.
    assert.equal(applyUsageFloor(5720, 29238), 29238);
    // Report above the estimate → untouched.
    assert.equal(applyUsageFloor(50000, 48000), 50000);
    // Small discrepancies (tokenizer noise) → untouched.
    assert.equal(applyUsageFloor(48000, 50000), 48000);
    assert.equal(applyUsageFloor(100000, 109000), 100000);
    // >10% AND >=2048 → floored.
    assert.equal(applyUsageFloor(100000, 115000), 115000);
    // No estimate → untouched.
    assert.equal(applyUsageFloor(5000, 0), 5000);
    // 0 report is never legitimate for a non-empty prompt → significant
    // estimate wins; tiny estimate is noise → keep the 0.
    assert.equal(applyUsageFloor(0, 29238), 29238);
    assert.equal(applyUsageFloor(0, 1000), 0);
});

test("pendingEstimateTokens: sums the tier pendings", () => {
    assert.equal(pendingEstimateTokens(undefined), 0);
    assert.equal(pendingEstimateTokens(null), 0);
    assert.equal(pendingEstimateTokens(makeNudge(1000, 200, 300)), 1500);
});

function makeCtx(messages: CoreMessage[], nudge?: NudgeDecision): {
    core: ReturnType<typeof createCore>;
    config: Config;
    messages: CoreMessage[];
    session: Session;
    log: (m: string) => void;
    nudge?: NudgeDecision;
    protocol: "responses";
} {
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "usage-floor-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        },
        log: () => {},
        nudge,
        protocol: "responses",
    };
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textStream(inputTokens: number): ReadableStream<Uint8Array> {
    const s = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { item: { type: "message", id: "msg_1", status: "in_progress", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "ok" }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "ok" }),
        sse("response.content_part.done", { item_id: "msg_1", output_index: 0, part: { type: "output_text", text: "ok" } }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "ok" }] }, output_index: 0 }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: inputTokens, output_tokens: 5 } } }),
    ].join("");
    return new Response(s, { status: 200 }).body!;
}

async function drainText(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
): Promise<void> {
    for await (const _chunk of runCompressLoop(stream, ctx, { model: "gpt-4o", input: [], stream: true }, { url: "http://mock", headers: {} }, createResponsesAdapter(), buildCompressSystemPrompt())) {
        // drain
    }
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

test("#256: under-reported relay usage is floored to the kernel estimate", async () => {
    const ctx = makeCtx([textMsg("m1", "user", "hello")], makeNudge(60000));
    await drainText(textStream(5000), ctx);
    assert.equal(ctx.session.stats.lastInputTokens, 60000, "lastInputTokens floored to the kernel estimate");
    assert.equal(ctx.session.stats.inputTokens, 5000, "cumulative billing stays raw");
});

test("#256: honest relay usage above the estimate is untouched", async () => {
    const ctx = makeCtx([textMsg("m1", "user", "hello")], makeNudge(60000));
    await drainText(textStream(80000), ctx);
    assert.equal(ctx.session.stats.lastInputTokens, 80000, "no floor when the report exceeds the estimate");
});

test("#256: no nudge decision → no floor", async () => {
    const ctx = makeCtx([textMsg("m1", "user", "hello")]);
    await drainText(textStream(5000), ctx);
    assert.equal(ctx.session.stats.lastInputTokens, 5000, "usage lands raw without a nudge decision");
});

test("#256: zero report is replaced by a significant estimate", async () => {
    const ctx = makeCtx([textMsg("m1", "user", "hello")], makeNudge(60000));
    await drainText(textStream(0), ctx);
    assert.equal(ctx.session.stats.lastInputTokens, 60000, "0 report replaced by the estimate");
});

const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "FLOOR-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });

test("#256: floor applies before the compress credit net-out", async () => {
    const messages = [
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ];
    const res = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    const ctx = makeCtx(messages, makeNudge(60000));
    ctx.session.state.messageRefs = res.map;
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress" }, output_index: 0 }),
        sse("response.function_call_arguments.delta", { item_id: "fc_c", delta: COMPRESS_ARGS }),
        sse("response.output_item.done", { item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: COMPRESS_ARGS }, output_index: 0 }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");
    // The re-request under-reports (50000 < estimate 60000) → floored, THEN
    // netted by the credit.
    const refetch = sse("response.completed", { response: { id: "resp_refetch", status: "completed", output: [], usage: { input_tokens: 50000, output_tokens: 5 } } });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(refetch, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    try {
        const chunks: Buffer[] = [];
        for await (const chunk of runCompressLoop(new Response(round1, { status: 200 }).body!, ctx, { model: "gpt-4o", input: [], stream: true }, { url: "http://mock", headers: {} }, createResponsesAdapter(), buildCompressSystemPrompt())) {
            chunks.push(chunk);
        }
        const credit = ctx.session.stats.compressCreditTokens;
        assert.ok(credit > 0, `credit accrued for the compressed tokens (got ${credit})`);
        assert.equal(ctx.session.stats.lastInputTokens, 60000 - credit, "floored total netted by the credit");
    } finally {
        globalThis.fetch = orig;
    }
});
