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

// 1. Non-compliant upstream: tool_calls + finish_reason="stop" → passthrough
//    (real tool_call chunks are forwarded verbatim as meta; finish_reason kept as-is).
test("openai adapter: real tool_calls passed through verbatim (meta)", async () => {
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
    const metas = events.filter((e) => e.kind === "meta");
    assert.ok(metas.length >= 2, "tool_call + finish_reason chunks passed through as meta");
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done", "done event present");
    assert.equal(done!.finishReason, "stop", "finish_reason preserved as-is from upstream");
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
