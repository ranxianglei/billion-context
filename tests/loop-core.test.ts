import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createResponsesAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

function makeCtx(messages: CoreMessage[] = []): {
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
            id: "loop-core-test",
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

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    requestBody: Record<string, unknown>,
    requestOptions: { url: string; headers: Record<string, string> },
    systemPrompt = buildCompressSystemPrompt(),
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of runCompressLoop(stream, ctx, requestBody, requestOptions, createResponsesAdapter(), systemPrompt)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function fcEvents(outputIndex: number, callId: string, name: string, args: string): string {
    return [
        sse("response.output_item.added", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name }, output_index: outputIndex }),
        sse("response.function_call_arguments.delta", { item_id: `fc_${callId}`, delta: args }),
        sse("response.output_item.done", { item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args }, output_index: outputIndex }),
    ].join("");
}

const COMPLETED = sse("response.completed", { response: { id: "resp_done", status: "completed", output: [] } });

test("loop #1: acp_status-only round → marker surfaced, NO re-request, graceful completion", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_status", "acp_status", "{}"),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "acp_status visibility marker surfaced to client");
        assert.ok(/response\.completed/.test(out), "graceful completion present (no 炸锅)");
        assert.equal(fetchCalls, 0, "NO re-request: acp_status is read-only, turn ends");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #2: search_context-only round → marker surfaced, NO re-request, graceful completion", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_search", "search_context", JSON.stringify({ query: "auth", limit: 3 })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "search_context marker surfaced");
        assert.ok(/response\.completed/.test(out), "graceful completion present");
        assert.equal(fetchCalls, 0, "NO re-request: search_context is read-only");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #8: real-tool passthrough → emitted to client, loop ends (no re-request)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_bash", "bash", JSON.stringify({ command: "ls" })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("\"name\":\"bash\""), "real tool call emitted to client");
        assert.ok(/response\.completed/.test(out), "completion present (loop ended)");
        assert.equal(fetchCalls, 0, "NO re-request: real tool ends the loop");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #9: mixed compress + real tool → forwarded (no re-request), compress executed, marker shown", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        fcEvents(0, "call_compress", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        fcEvents(1, "call_bash", "bash", JSON.stringify({ command: "echo hi" })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => { fetchCalls++; return new Response(round1, { status: 200 }); }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(out.includes("[ACP]"), "compress marker shown");
        assert.ok(out.includes("\"name\":\"bash\""), "real tool forwarded to client");
        assert.equal(fetchCalls, 0, "NO re-request: real tool present alongside mutating proxy tool");
        assert.ok(/response\.completed/.test(out), "completion present");
    } finally {
        globalThis.fetch = orig;
    }
});

test("loop #5: limit-hit graceful — 10 mutating rounds never degenerate empty, no crash", async () => {
    const mutatingRound = [
        sse("response.created", { response: { id: "resp_m", status: "in_progress" } }),
        fcEvents(0, "call_c", "compress", JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "s" }] })),
        COMPLETED,
    ].join("");
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(mutatingRound, { status: 200 });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(mutatingRound, { status: 200 }).body!,
            makeCtx(),
            { model: "gpt-4o", input: [], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.ok(/response\.completed/.test(out), "graceful completion at limit (NOT degenerate empty)");
        assert.ok(!/^data: \[\]\n\n$/.test(out), "no degenerate empty payload");
        const completedCount = (out.match(/event: response\.completed/g) || []).length;
        assert.equal(completedCount, 1, "exactly one completion event (one SSE event line)");
    } finally {
        globalThis.fetch = orig;
    }
});
