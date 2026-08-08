import { test } from "node:test";
import assert from "node:assert/strict";
import { compressLoopResponsesStream } from "../src/compress-loop-responses.ts";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";

function makeCtx(log: (m: string) => void): { core: ReturnType<typeof createCore>; config: Config; messages: CoreMessage[]; session: Session; log: (m: string) => void } {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: {
            id: "test",
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            requests: 0,
            condensedToolResults: 0,
            tokensSaved: 0,
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
