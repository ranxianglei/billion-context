import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

// Regression: a plain-text OpenAI turn with stream_options.include_usage must
// forward the trailing usage-only frame to the client. bili used to swallow it
// unless a tool call was seen, so clients that price the turn from that frame
// (IBM Bob) reported cost 0 while the account was still charged.

const enc = new TextEncoder();
const dec = new TextDecoder();

const frame = (obj: Record<string, unknown>) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

const textTurn = (...extra: Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(frame({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
            controller.enqueue(frame({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] }));
            controller.enqueue(frame({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            for (const e of extra) controller.enqueue(e);
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });

const usageFrame = (prompt: number, completion: number) =>
    frame({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt",
        choices: [],
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    });

const collect = async (body: Record<string, unknown>, stream: ReadableStream<Uint8Array>) => {
    const adapter = createOpenaiAdapter(body);
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);
    return events;
};

const wire = (events: ParsedStreamEvent[]): string =>
    events
        .filter((ev) => ev.kind === "meta")
        .map((ev) => dec.decode((ev as { chunk: Uint8Array }).chunk))
        .join("");

test("include_usage client receives the trailing usage-only frame on a text turn", async () => {
    const events = await collect(
        { model: "gpt", stream: true, stream_options: { include_usage: true } },
        textTurn(usageFrame(123, 4)),
    );
    const out = wire(events);
    assert.match(out, /"usage":\{"prompt_tokens":123/);
    assert.match(out, /"completion_tokens":4/);
});

test("client that did not opt in does not receive the usage-only frame", async () => {
    const events = await collect({ model: "gpt", stream: true }, textTurn(usageFrame(123, 4)));
    assert.doesNotMatch(wire(events), /"prompt_tokens"/);
});

test("tool-call round still forwards the usage frame verbatim", async () => {
    const toolCall = frame({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
    });
    const events = await collect({ model: "gpt", stream: true }, textTurn(toolCall, usageFrame(50, 2)));
    assert.match(wire(events), /"prompt_tokens":50/);
});

test("synthesized completion preserves provider-specific usage fields (credits)", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt", stream: true, stream_options: { include_usage: true } });
    const usageWithCredits = frame({
        choices: [{ delta: {}, index: 0 }],
        created: 1,
        id: "c1",
        model: "gpt",
        object: "chat.completion.chunk",
        usage: { prompt_tokens: 123, completion_tokens: 4, total_tokens: 127, credits: 0.42, cache_validity: false },
    });
    for await (const _ of adapter.parseStream(textTurn(usageWithCredits), 1)) { /* drain */ }
    const completion = adapter.emitCompletion({ usage: { inputTokens: 123, outputTokens: 4, cachedTokens: 0 } }).toString("utf8");
    assert.match(completion, /"credits":0.42/);
    assert.match(completion, /"prompt_tokens":123/);
});

test("a round without usage does not inherit the previous round's credits", async () => {
    const adapter = createOpenaiAdapter({ model: "gpt", stream: true, stream_options: { include_usage: true } });
    const withCredits = frame({
        choices: [{ delta: {}, index: 0 }], created: 1, id: "c1", model: "gpt", object: "chat.completion.chunk",
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, credits: 0.42 },
    });
    for await (const _ of adapter.parseStream(textTurn(withCredits), 1)) { /* drain */ }
    for await (const _ of adapter.parseStream(textTurn(), 2)) { /* drain, no usage frame */ }
    const completion = adapter.emitCompletion({ usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0 } }).toString("utf8");
    assert.doesNotMatch(completion, /"credits"/);
});
