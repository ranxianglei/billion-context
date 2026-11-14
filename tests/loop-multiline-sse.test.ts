import assert from "node:assert/strict";
import test from "node:test";
import {
    createAnthropicAdapter, createGoogleAdapter, createOpenaiAdapter, createResponsesAdapter,
    type CompressLoopAdapter, type ParsedStreamEvent,
} from "../src/loop/index.ts";

function frame(value: unknown, event?: string, multiline = true): string {
    const fields = JSON.stringify(value, null, multiline ? 2 : undefined).split("\n")
        .map((line, i) => `${i % 2 === 0 ? "data:" : "data: "}${line}`);
    return [event ? `event: ${event}` : ": gateway", "id: frame-7", fields[0]!,
        ": preserve this comment", ...fields.slice(1), "retry: 1000", "", ""].join("\n");
}

function stream(text: string, bytewise = false): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({ start(controller) {
        if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        else controller.enqueue(bytes);
        controller.close();
    } });
}

async function collect(adapter: CompressLoopAdapter, text: string, round = 1, bytewise = false): Promise<ParsedStreamEvent[]> {
    const out: ParsedStreamEvent[] = [];
    for await (const event of adapter.parseStream(stream(text, bytewise), round)) out.push(event);
    return out;
}

function wire(events: ParsedStreamEvent[]): string {
    return events.map(event => event.kind === "meta" ? event.chunk.toString("utf8")
        : "raw" in event ? event.raw?.toString("utf8") ?? "" : "").join("");
}

function payloads(text: string): Array<Record<string, unknown>> {
    return text.split("\n\n").flatMap(event => {
        const data = event.split("\n").filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        return data.trim() === "" || data.trim() === "[DONE]" ? [] : [JSON.parse(data) as Record<string, unknown>];
    });
}

const openaiText = { id: "chat-7", choices: [{ index: 0, delta: { content: "Hello 你好🔥" }, finish_reason: null }] };
const openaiFinish = { id: "chat-7", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 7 } };
const googleText = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Hello 你好🔥" }] } }] };
const googleFinish = { candidates: [{ index: 0, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 7 } };

for (const eol of ["\n", "\r\n", "\r"]) {
    for (const protocol of ["openai", "google"] as const) {
        test(`${protocol}: multiline data preserves text, usage and raw frame with ${JSON.stringify(eol)} byte splits`, async () => {
            const textFrame = frame(protocol === "openai" ? openaiText : googleText);
            const finishFrame = frame(protocol === "openai" ? openaiFinish : googleFinish);
            const adapter = protocol === "openai" ? createOpenaiAdapter({ model: "test" }) : createGoogleAdapter({});
            const events = await collect(adapter, (textFrame + finishFrame).replaceAll("\n", eol), 1, true);
            assert.equal(events.filter(e => e.kind === "text").map(e => e.delta).join(""), "Hello 你好🔥");
            assert.ok(events.some(e => e.kind === "usage" && e.inputTokens === 42 && e.outputTokens === 7));
            assert.ok(events.some(e => e.kind === "done"));
            assert.ok(wire(events).includes(textFrame), "unedited multiline event retains its data fields and metadata");
        });
    }
}

test("openai: buffered real tool replay preserves complete multiline arguments", async () => {
    const args = '{"content":"  literal \\n \\u4f60 \x3cacp id=\\\"m1\\\"\x3ekeep\x3c/acp\x3e  "}';
    const tool = { id: "chat-7", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-7", type: "function", function: { name: "write_file", arguments: args } }] }, finish_reason: null }] };
    const finish = { id: "chat-7", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };
    const events = await collect(createOpenaiAdapter({}), frame(tool) + frame(finish) + "data: [DONE]\n\n");
    const call = events.find(e => e.kind === "tool_call");
    assert.ok(call && call.kind === "tool_call");
    assert.equal(call.arguments, args);
    assert.equal(call.passthrough, true);
    const frames = payloads(wire(events));
    assert.deepEqual(frames[0], tool, "the client receives valid SSE containing the exact call argument string");
});

test("openai: multiline content sharing a finish frame cannot leak an early finish", async () => {
    const value = { ...openaiText, choices: [{ index: 0, delta: { content: "Final words" }, finish_reason: "stop" }] };
    const events = await collect(createOpenaiAdapter({}), frame(value));
    const text = events.find(e => e.kind === "text");
    assert.ok(text && text.kind === "text" && text.raw);
    const choices = payloads(text.raw.toString("utf8"))[0]!.choices as Array<Record<string, unknown>>;
    assert.equal(choices[0]!.finish_reason, null);
    assert.ok(text.raw.toString("utf8").endsWith("\n\n"), "rewritten frame retains its terminal blank line");
    assert.ok(text.raw.toString("utf8").includes("id: frame-7\n"));
    assert.ok(text.raw.toString("utf8").includes("retry: 1000\n"));
    assert.ok(text.raw.toString("utf8").includes(": preserve this comment\n"));
    assert.ok(events.some(e => e.kind === "done" && e.finishReason === "stop"));
});

for (const mode of ["sse", "array"] as const) {
    test(`google: multiline ${mode} replays real tool arguments and signatures as valid SSE`, async () => {
        const args = { path: "file.txt", content: "  literal \\n 你好 \x3cacp id=\"m1\"\x3ekeep\x3c/acp\x3e  " };
        const tool = { candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { id: "call-7", name: "write_file", args }, thoughtSignature: "opaque/signature+value==" }] } }] };
        const finish = { candidates: [{ index: 0, finishReason: "STOP" }] };
        const body = mode === "sse" ? frame(tool) + frame(finish) : JSON.stringify([tool, finish], null, 2).replaceAll("\n", "\r\n");
        const events = await collect(createGoogleAdapter({}), body, 1, true);
        const call = events.find(e => e.kind === "tool_call");
        assert.ok(call && call.kind === "tool_call");
        assert.equal(call.arguments, JSON.stringify(args));
        assert.equal(call.signature, "opaque/signature+value==");
        assert.equal(call.passthrough, true);
        assert.deepEqual(payloads(wire(events)), [tool, finish]);
    });
}

function anthropicRound(text: string, multiline = true): string {
    return [
        { type: "message_start", message: { id: "msg-7", usage: { input_tokens: 42, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
    ].map(value => frame(value, value.type, multiline)).join("");
}

test("anthropic: multiline start usage is neutralized only on the client copy", async () => {
    const events = await collect(createAnthropicAdapter({}), anthropicRound("Hello"));
    const start = payloads(wire(events)).find(value => value.type === "message_start");
    assert.ok(start);
    assert.deepEqual((start.message as Record<string, unknown>).usage, { input_tokens: 0, output_tokens: 0 });
    assert.ok(events.some(e => e.kind === "usage" && e.inputTokens === 42 && e.cachedTokens === 20 && e.creationTokens === 5 && e.outputTokens === 7));
    assert.ok(wire(events).includes("id: frame-7\n"));
    assert.ok(wire(events).includes(": preserve this comment\n"));
});

test("anthropic: multiline starts, deltas and stops get the same fresh index across rounds", async () => {
    const adapter = createAnthropicAdapter({});
    await collect(adapter, anthropicRound("first", false));
    const events = await collect(adapter, anthropicRound("second"), 2);
    const blocks = payloads(wire(events)).filter(value => String(value.type).startsWith("content_block_"));
    assert.equal(blocks.length, 3);
    assert.deepEqual(blocks.map(value => value.index), [1, 1, 1]);
    assert.equal((blocks[1]!.delta as Record<string, unknown>).text, "second");
});

test("anthropic: filtered multiline prose forwards the filtered text with its remapped index", async () => {
    const adapter = createAnthropicAdapter({});
    await collect(adapter, anthropicRound("first", false));
    const events = await collect(adapter, anthropicRound("Hello \x3cacp id=\"m00001\"\x3ehidden\x3c/acp\x3e world"), 2);
    const visible = events.filter(e => e.kind === "text").map(e => e.delta).join("");
    assert.doesNotMatch(visible, /\x3cacp/);
    const deltas = payloads(wire(events)).filter(value => value.type === "content_block_delta");
    assert.equal(deltas.map(value => (value.delta as Record<string, unknown>).text ?? "").join(""), visible);
    assert.ok(deltas.every(value => value.index === 1));
});

for (const protocol of ["openai", "google"] as const) {
    test(`${protocol}: one-line frames remain verbatim`, async () => {
        const value = protocol === "openai" ? openaiText : googleText;
        const textFrame = frame(value, undefined, false);
        const adapter = protocol === "openai" ? createOpenaiAdapter({}) : createGoogleAdapter({});
        const single = await collect(adapter, textFrame);
        assert.equal(wire(single), textFrame);
    });
    test(`${protocol}: malformed multi-data is one invalid event`, async () => {
        const value = protocol === "openai" ? openaiText : googleText;
        const adapter = protocol === "openai" ? createOpenaiAdapter({}) : createGoogleAdapter({});
        const malformed = `data: ${JSON.stringify(value)}\ndata: not-json\n\n`;
        const rejected = await collect(adapter, malformed);
        assert.equal(rejected.filter(e => e.kind === "text").length, 0, "a first data field is never parsed in isolation");
    });
}

test("responses: multiline payload and one-byte Unicode remain supported", async () => {
    const body = frame({ type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [] } }, "response.output_item.added")
        + frame({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "Hello 你好🔥" }, "response.output_text.delta");
    const events = await collect(createResponsesAdapter(), body, 1, true);
    assert.equal(events.filter(e => e.kind === "text").map(e => e.delta).join(""), "Hello 你好🔥");
});
