import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteResponsesSseStream } from "../src/stream-responses.ts";
import type { RewriteCtx } from "../src/stream.ts";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";

function makeCtx(log: (m: string) => void): RewriteCtx {
    const core = createCore();
    return {
        core,
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: { id: "test", state: createInitialState(), createdAt: Date.now(), requests: 0 },
        log,
        debug: false,
    };
}

async function drain(stream: ReadableStream<Uint8Array>, ctx: RewriteCtx): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of rewriteResponsesSseStream(stream, ctx)) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("rewriteResponsesSseStream: passes through a plain text response unchanged", async () => {
    const events = [
        sse("response.created", { response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { item: { type: "message", id: "msg_1", role: "assistant", content: [] }, output_index: 0 }),
        sse("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: "Hello" }),
        sse("response.output_text.done", { item_id: "msg_1", output_index: 0, text: "Hello" }),
        sse("response.output_item.done", { item: { type: "message", id: "msg_1" }, output_index: 0 }),
        sse("response.completed", { response: { id: "resp_1", status: "completed", output: [] } }),
    ].join("");
    const stream = new Response(events).body!;
    const out = await drain(stream, makeCtx(() => {}));
    assert.ok(out.includes("Hello"), "plain text delta passes through");
    assert.ok(out.includes("response.completed"), "completion event passes through");
    assert.ok(!out.includes("compress"), "no compress artifacts injected");
});

test("rewriteResponsesSseStream: suppresses compress function_call and rewrites as text", async () => {
    const events = [
        sse("response.created", { response: { id: "resp_2", status: "in_progress" } }),
        sse("response.output_item.added", {
            item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "compress" },
            output_index: 0,
        }),
        sse("response.function_call_arguments.delta", {
            item_id: "fc_1",
            delta: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "sum" }] }).slice(0, 20),
        }),
        sse("response.function_call_arguments.delta", {
            item_id: "fc_1",
            delta: JSON.stringify({ content: [{ startId: "m00001", endId: "m00002", summary: "sum" }] }).slice(20),
        }),
        sse("response.output_item.done", { item: { type: "function_call", id: "fc_1", name: "compress" }, output_index: 0 }),
        sse("response.completed", { response: { id: "resp_2", status: "completed", output: [] } }),
    ].join("");
    const logs: string[] = [];
    const out = await drain(new Response(events).body!, makeCtx((m) => logs.push(m)));
    // Compress call events must be suppressed.
    assert.ok(!out.includes("function_call_arguments.delta"), "compress function_call delta suppressed");
    // Tail must synthesize a visible text delta + clean completion.
    assert.ok(out.includes("response.output_text.delta"), "compress result emitted as text delta");
    assert.ok(/response\.completed/.test(out), "clean completion emitted");
});
