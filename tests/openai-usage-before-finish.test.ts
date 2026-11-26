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

test("openai emitCompletion: no real usage fields → usage field omitted (null)", () => {
    const adapter = createOpenaiAdapter({ model: "m", stream: true, messages: [] });
    // Empty usage object (the core.ts:880 init shape) must NOT produce an
    // all-zero usage report — it must omit the field entirely.
    const buf = adapter.emitCompletion({ finishReason: "stop", usage: {} });
    const text = buf.toString("utf8");
    const finishLine = text.split("\n").find((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    assert.ok(finishLine, "finish frame present");
    const parsed = JSON.parse(finishLine.slice("data: ".length));
    assert.equal(parsed.usage, undefined, "usage field must be absent, not all-zeros");
    assert.equal(parsed.choices[0].finish_reason, "stop");
});

test("openai emitCompletion: real usage fields → usage field present", () => {
    const adapter = createOpenaiAdapter({ model: "m", stream: true, messages: [] });
    const buf = adapter.emitCompletion({
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 50 },
    });
    const text = buf.toString("utf8");
    const finishLine = text.split("\n").find((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    assert.ok(finishLine, "finish frame present");
    const parsed = JSON.parse(finishLine.slice("data: ".length));
    assert.ok(parsed.usage, "usage field present");
    assert.equal(parsed.usage.prompt_tokens, 100);
    assert.equal(parsed.usage.completion_tokens, 10);
    assert.equal(parsed.usage.total_tokens, 110);
    assert.equal(parsed.usage.prompt_tokens_details.cached_tokens, 50);
});

test("openai emitCompletion: no usage arg at all → usage field omitted", () => {
    const adapter = createOpenaiAdapter({ model: "m", stream: true, messages: [] });
    const buf = adapter.emitCompletion({ finishReason: "stop" });
    const text = buf.toString("utf8");
    const finishLine = text.split("\n").find((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    assert.ok(finishLine, "finish frame present");
    const parsed = JSON.parse(finishLine.slice("data: ".length));
    assert.equal(parsed.usage, undefined, "usage field must be absent when no usage arg");
});
