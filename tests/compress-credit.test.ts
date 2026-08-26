import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

function makeCtx(messages: CoreMessage[]): {
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
            id: "compress-credit-test",
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
    };
}

function withRefs(ctx: ReturnType<typeof makeCtx>): ReturnType<typeof makeCtx> {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

const SYS_PROMPT = buildCompressSystemPrompt();

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    requestBody: Record<string, unknown>,
    requestOptions: { url: string; headers: Record<string, string> },
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, createResponsesAdapter(), SYS_PROMPT)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function makeCompressibleCtx(): ReturnType<typeof makeCtx> {
    return withRefs(makeCtx([
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ]));
}

const COMPRESS_ARGS = JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "CREDIT-TEST-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] });

test("#252: post-compress re-request usage is netted by the compress credit", async () => {
    const ctx = makeCompressibleCtx();
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", COMPRESS_ARGS),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");
    // Re-request reports the UNFOLDED context (80762 — the wire still carries
    // the full history for prefix-cache reasons). Pre-fix this landed raw in
    // lastInputTokens and the next nudge re-fired on the stale number.
    const REFETCH_USAGE = 80762;
    const refetch = sse("response.completed", { response: { id: "resp_refetch", status: "completed", output: [], usage: { input_tokens: REFETCH_USAGE, output_tokens: 5 } } });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(refetch, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        const credit = ctx.session.stats.compressCreditTokens;
        assert.ok(credit > 0, `credit accrued for the compressed tokens (got ${credit})`);
        assert.equal(ctx.session.stats.lastInputTokens, REFETCH_USAGE - credit, "lastInputTokens netted to post-compress estimate");
        // Cumulative billing stays raw truth.
        assert.equal(ctx.session.stats.inputTokens, REFETCH_USAGE, "inputTokens cumulative is NOT netted");
    } finally {
        globalThis.fetch = orig;
    }
});

test("#252: failed compress accrues no credit", async () => {
    const ctx = makeCompressibleCtx();
    // Sub-viability range (kernel minCompressRange) → compress FAILS.
    const badArgs = JSON.stringify({ content: [{ startId: "m00007", endId: "m00007", summary: "s" }] });
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", badArgs),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");
    const refetch = sse("response.completed", { response: { id: "resp_refetch", status: "completed", output: [], usage: { input_tokens: 50000 } } });
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(refetch, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    try {
        await drain(
            new Response(round1, { status: 200 }).body!,
            ctx,
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(ctx.session.stats.compressCreditTokens, 0, "no credit on failed compress");
        assert.equal(ctx.session.stats.lastInputTokens, 50000, "usage lands raw when nothing was compressed");
    } finally {
        globalThis.fetch = orig;
    }
});
