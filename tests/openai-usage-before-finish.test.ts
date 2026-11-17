import test from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/adapter-openai.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

const sse = (...frames: string[]): ReadableStream<Uint8Array> =>
    new Response(frames.map((f) => `data: ${f}\n\n`).join(""), { status: 200 }).body!;

async function collect(body: ReadableStream<Uint8Array>): Promise<ParsedStreamEvent[]> {
    const adapter = createOpenaiAdapter({ model: "m", stream: true, messages: [] });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(body, 1)) events.push(ev);
    return events;
}

test("openai parseStream: usage on a separate frame BEFORE the finish frame is preserved", async () => {
    // Upstream (e.g. trae/deepseek) sends usage on a frame with empty choices,
    // then a separate finish frame with no usage. The finish frame must not
    // overwrite the real usage with an all-undefined event.
    const events = await collect(sse(
        '{"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]',
        '{"choices":[],"usage":{"prompt_tokens":4231,"completion_tokens":20,"total_tokens":4251}}',
        '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
    ));
    const usageEvents = events.filter((e) => e.kind === "usage") as any[];
    assert.equal(usageEvents.length, 1, "exactly one usage event (the real one)");
    assert.equal(usageEvents[0].inputTokens, 4231);
    assert.equal(usageEvents[0].outputTokens, 20);
    const done = events.find((e) => e.kind === "done") as any;
    assert.ok(done, "done event present");
    assert.equal(done.finishReason, "stop");
});

test("openai parseStream: finish frame WITH usage yields a real usage event", async () => {
    // Standard OpenAI shape: usage rides on the finish frame.
    const events = await collect(sse(
        '{"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]',
        '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}',
        '[DONE]',
    ));
    const usageEvents = events.filter((e) => e.kind === "usage") as any[];
    assert.equal(usageEvents.length, 1);
    assert.equal(usageEvents[0].inputTokens, 100);
    assert.equal(usageEvents[0].outputTokens, 10);
});

test("openai parseStream: no usage anywhere yields no usage event", async () => {
    const events = await collect(sse(
        '{"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]',
        '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '[DONE]',
    ));
    const usageEvents = events.filter((e) => e.kind === "usage");
    assert.equal(usageEvents.length, 0, "no usage event when upstream sends none");
});
