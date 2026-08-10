import { test } from "node:test";
import assert from "node:assert/strict";
import { compressLoopResponsesStream } from "../src/compress-loop-responses.ts";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { ACP_TEXT_CLOSE, ACP_TEXT_OPEN } from "../src/compress-tool.ts";

function makeCtx(log: (m: string) => void): { core: ReturnType<typeof createCore>; config: Config; messages: CoreMessage[]; session: Session; log: (m: string) => void } {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: {
            id: "test",
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
        log,
    };
}

async function drain(
    stream: ReadableStream<Uint8Array>,
    ctx: ReturnType<typeof makeCtx>,
    requestBody: Record<string, unknown>,
    requestOptions: { url: string; headers: Record<string, string> },
): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of compressLoopResponsesStream(stream, ctx, requestBody, requestOptions)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("compressLoopResponsesStream: plain text response (no proxy calls) passes through and completes", async () => {
    const events = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { item: { type: "message", id: "msg_1", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "Hello" }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "Hello" }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_1" }, output_index: 0 }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");
    const out = await drain(
        new Response(events).body!,
        makeCtx(() => {}),
        { model: "gpt-4o", input: [{ type: "message", role: "user", content: "hi" }], stream: true },
        { url: "http://unused", headers: {} },
    );
    assert.ok(out.includes("Hello"), "plain text delta passes through");
    assert.ok(out.includes("response.completed"), "completion event emitted");
    assert.ok(!out.includes("compress"), "no compress artifacts");
});

test("compressLoopResponsesStream: compress-only round executes tool and re-requests (mocked fetch)", async () => {
    // Round 1: model calls compress only.
    const round1 = [
        sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
        sse("response.output_item.added", {
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "compress" },
            output_index: 0,
        }),
        sse("response.function_call_arguments.delta", {
            item_id: "fc_1",
            delta: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "sum" }] }),
        }),
        sse("response.output_item.done", {
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "sum" }] }) },
            output_index: 0,
        }),
        sse("response.completed", { response: { id: "resp_2", status: "completed", output: [] } }),
    ].join("");
    // Round 2: model produces the real answer.
    const round2 = [
        sse("response.created", { response: { id: "resp_3", status: "in_progress" } }),
        sse("response.output_text.delta", { item_id: "msg_2", output_index: 0, delta: "Done." }),
        sse("response.completed", { response: { id: "resp_3", status: "completed", output: [] } }),
    ].join("");

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown) => {
        fetchCalls++;
        return new Response(fetchCalls === 1 ? round2 : round1, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;

    const logs: string[] = [];
    try {
        const out = await drain(
            new Response(round1, { status: 200, headers: { "content-type": "text/event-stream" } }).body!,
            makeCtx((m) => logs.push(m)),
            { model: "gpt-4o", input: [{ type: "message", role: "user", content: "hi" }], stream: true },
            { url: "http://mock", headers: {} },
        );
        // The compress function_call events from round 1 must be suppressed.
        assert.ok(!out.includes("function_call_arguments.delta") || fetchCalls > 0, "compress fc events suppressed in round 1");
        // A visibility marker (📦) must appear.
        assert.ok(out.includes("[ACP]"), "compress visibility marker emitted");
        // Round 2 content passes through.
        assert.ok(out.includes("Done."), "round 2 real content emitted");
        // Exactly one re-request happened.
        assert.equal(fetchCalls, 1, "exactly one upstream re-request after compress");
        // Final completion present.
        assert.ok(/response\.completed/.test(out), "final completion emitted");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("compressLoopResponsesStream: Codex text protocol never sends synthetic function items", async () => {
    const trigger = `${ACP_TEXT_OPEN}${JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "sum" }] })}${ACP_TEXT_CLOSE}`;
    const round1 = [
        sse("response.created", { response: { id: "resp_text_1", status: "in_progress" } }),
        sse("response.output_text.delta", { item_id: "msg_text_1", output_index: 0, delta: trigger }),
        sse("response.completed", { response: { id: "resp_text_1", status: "completed", output: [] } }),
    ].join("");
    const round2 = [
        sse("response.created", { response: { id: "resp_text_2", status: "in_progress" } }),
        sse("response.output_text.delta", { item_id: "msg_text_2", output_index: 0, delta: "Done." }),
        sse("response.completed", { response: { id: "resp_text_2", status: "completed", output: [] } }),
    ].join("");
    const originalFetch = globalThis.fetch;
    let forwarded: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        forwarded = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(round2, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const ctx = { ...makeCtx(() => {}), textProtocol: true };
        const out = await drain(
            new Response(round1, { status: 200, headers: { "content-type": "text/event-stream" } }).body!,
            ctx,
            { model: "gpt-5", input: [{ type: "message", role: "user", content: "hi" }], stream: true },
            { url: "http://mock", headers: {} },
        );
        const types = (forwarded?.input as Array<{ type: string }>).map((item) => item.type);
        assert.ok(!types.includes("function_call"));
        assert.ok(!types.includes("function_call_output"));
        assert.ok(types.every((type) => type === "message"));
        assert.ok(out.includes("Done."));
        assert.ok(!out.includes(ACP_TEXT_OPEN));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("compressLoopResponsesStream: Codex code_mode custom_tool_call passes through in text-protocol (regression for 无法使用工具)", async () => {
    const events = [
        sse("response.created", { response: { id: "resp_ctc", status: "in_progress" } }),
        sse("response.output_item.added", { item: { type: "message", id: "msg_ctc", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_ctc", output_index: 0, delta: "Running ls." }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_ctc" }, output_index: 0 }),
        sse("response.output_item.added", { item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_ctc_1", name: "shell", input: "" }, output_index: 1 }),
        sse("response.custom_tool_call.input_text.delta", { item_id: "ctc_1", delta: '{"cmd":"ls"}' }),
        sse("response.output_item.done", { item: { type: "custom_tool_call", id: "ctc_1", call_id: "call_ctc_1", name: "shell", input: '{"cmd":"ls"}' }, output_index: 1 }),
        sse("response.completed", { response: { id: "resp_ctc", status: "completed", output: [] } }),
    ].join("");
    const ctx = { ...makeCtx(() => {}), textProtocol: true };
    const out = await drain(
        new Response(events).body!,
        ctx,
        { model: "gpt-5", input: [{ type: "message", role: "user", content: "list files" }], stream: true },
        { url: "http://unused", headers: {} },
    );
    assert.ok(out.includes("custom_tool_call"), "custom_tool_call item reaches the client in text-protocol");
    assert.ok(out.includes('"shell"'), "code_mode tool name preserved");
    assert.ok(out.includes("Running ls."), "assistant text still emitted");
    assert.ok(out.includes("response.completed"), "completion emitted");
});

test("compressLoopResponsesStream: empty upstream response (no content/usage) yields response.failed for client retry", async () => {
    const events = [
        sse("response.created", { response: { id: "resp_empty", status: "in_progress" } }),
        sse("response.completed", { response: { id: "resp_empty", status: "completed", output: [] } }),
    ].join("");
    const ctx = { ...makeCtx(() => {}), textProtocol: true };
    const out = await drain(
        new Response(events).body!,
        ctx,
        { model: "gpt-5", input: [{ type: "message", role: "user", content: "hi" }], stream: true },
        { url: "http://unused", headers: {} },
    );
    assert.ok(out.includes("response.failed"), "empty upstream response yields response.failed");
    assert.ok(!out.includes("response.completed"), "no fake completion for empty response");
    assert.ok(out.includes("empty response"), "error message included");
});

test("compressLoopResponsesStream: read-only acp_status executes once and completes WITHOUT upstream re-request (regression for 炸锅 loop)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_st_1", status: "in_progress" } }),
        sse("response.output_item.added", {
            item: { type: "function_call", id: "fc_st", call_id: "call_st", name: "acp_status" },
            output_index: 0,
        }),
        sse("response.function_call_arguments.delta", { item_id: "fc_st", delta: "{}" }),
        sse("response.output_item.done", {
            item: { type: "function_call", id: "fc_st", call_id: "call_st", name: "acp_status", arguments: "{}" },
            output_index: 0,
        }),
        sse("response.completed", { response: { id: "resp_st_1", status: "completed", output: [] } }),
    ].join("");
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(round1, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const logs: string[] = [];
    try {
        const out = await drain(
            new Response(round1, { status: 200, headers: { "content-type": "text/event-stream" } }).body!,
            makeCtx((m) => logs.push(m)),
            { model: "gpt-4o", input: [{ type: "message", role: "user", content: "status?" }], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 0, "read-only acp_status must NOT trigger an upstream re-request");
        assert.ok(out.includes("[ACP]"), "acp_status visibility marker emitted to client");
        assert.ok(out.includes("response.completed"), "turn completes instead of looping or being discarded");
        assert.ok(!out.includes("compress loop limit"), "loop limit must not be hit for a read-only tool");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("compressLoopResponsesStream: mixed mutating + read-only round still re-requests (only MUTATING tools drive the loop)", async () => {
    const round1 = [
        sse("response.created", { response: { id: "resp_mx_1", status: "in_progress" } }),
        sse("response.output_item.added", {
            item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress" },
            output_index: 0,
        }),
        sse("response.function_call_arguments.delta", {
            item_id: "fc_c",
            delta: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "sum" }] }),
        }),
        sse("response.output_item.done", {
            item: { type: "function_call", id: "fc_c", call_id: "call_c", name: "compress", arguments: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "sum" }] }) },
            output_index: 0,
        }),
        sse("response.output_item.added", {
            item: { type: "function_call", id: "fc_s", call_id: "call_s", name: "acp_status" },
            output_index: 1,
        }),
        sse("response.function_call_arguments.delta", { item_id: "fc_s", delta: "{}" }),
        sse("response.output_item.done", {
            item: { type: "function_call", id: "fc_s", call_id: "call_s", name: "acp_status", arguments: "{}" },
            output_index: 1,
        }),
        sse("response.completed", { response: { id: "resp_mx_1", status: "completed", output: [] } }),
    ].join("");
    const round2 = [
        sse("response.created", { response: { id: "resp_mx_2", status: "in_progress" } }),
        sse("response.output_text.delta", { item_id: "msg_mx", output_index: 0, delta: "Done." }),
        sse("response.completed", { response: { id: "resp_mx_2", status: "completed", output: [] } }),
    ].join("");
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
        fetchCalls++;
        return new Response(fetchCalls === 1 ? round2 : round1, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
        const out = await drain(
            new Response(round1, { status: 200, headers: { "content-type": "text/event-stream" } }).body!,
            makeCtx(() => {}),
            { model: "gpt-4o", input: [{ type: "message", role: "user", content: "go" }], stream: true },
            { url: "http://mock", headers: {} },
        );
        assert.equal(fetchCalls, 1, "a round containing a MUTATING tool (compress) must re-request exactly once");
        assert.ok(out.includes("[ACP]"), "visibility markers emitted");
        assert.ok(out.includes("Done."), "round 2 real content emitted");
        assert.ok(out.includes("response.completed"), "final completion emitted");
    } finally {
        globalThis.fetch = originalFetch;
    }
});
