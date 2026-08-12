import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

const enc = new TextEncoder();
const sseChunk = (delta: Record<string, unknown>, finishReason?: string) =>
    enc.encode(
        `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            created: 1,
            model: "gpt",
            choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
        })}\n\n`,
    );

const mockStream = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.enqueue(enc.encode(`data: [DONE]\n\n`));
            controller.close();
        },
    });

const collect = async (stream: ReadableStream<Uint8Array>) => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);
    return events;
};

// 1. Non-compliant upstream: tool_calls + finish_reason="stop" → bili rewrites to "tool_calls".
test("openai adapter: tool_calls with finish_reason=stop rewritten to tool_calls", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({
            tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
            ],
        }),
        sseChunk({}, "stop"),
    );
    const events = await collect(stream);
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done", "done event present");
    assert.equal(done!.finishReason, "tool_calls", "finish_reason corrected to tool_calls");
    const toolCall = events.find((e) => e.kind === "tool_call");
    assert.ok(toolCall, "tool_call event still emitted");
});

// 2. Compliant upstream: tool_calls + finish_reason="tool_calls" → unchanged.
test("openai adapter: compliant finish_reason=tool_calls left unchanged", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({
            tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
            ],
        }),
        sseChunk({}, "tool_calls"),
    );
    const events = await collect(stream);
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls");
});

// 3. No tool_calls + finish_reason="stop" → unchanged (normal text completion).
test("openai adapter: text-only finish_reason=stop left unchanged", async () => {
    const stream = mockStream(sseChunk({ role: "assistant" }), sseChunk({ content: "hello" }), sseChunk({}, "stop"));
    const events = await collect(stream);
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "stop");
});
