// #4466: some OpenAI-compatible gateways (Tencent CodeBuddy,
// copilot.tencent.com) stamp `tool_calls: []` on EVERY chunk of a normal
// text response. An empty array is truthy, so the adapter's bare truthiness
// check classified every text frame as a tool-call frame — the client's raw
// bytes were withheld for a tool settle that never comes, and the user got
// an empty stream ("Model returned no valid response"). Both directions:
// [] must be treated as absent (text flows), a NON-empty tool_calls array
// keeps the real tool-call path intact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/index.ts";
import type { CompressLoopAdapter } from "../src/loop/index.ts";

function sse(obj: unknown): Buffer {
    return Buffer.from("data: " + JSON.stringify(obj) + "\n\n", "utf8");
}

function streamOf(chunks: Buffer[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) controller.enqueue(new Uint8Array(chunks[i++]!));
            else controller.close();
        },
    });
}

const adapter = (): CompressLoopAdapter =>
    createOpenaiAdapter({ model: "m", messages: [], stream: true });

async function collect(adapter: CompressLoopAdapter, chunks: Buffer[]) {
    const text = [];
    const rawBytes: Buffer[] = [];
    const toolCalls: { name: string; args: string }[] = [];
    for await (const ev of adapter.parseStream(streamOf(chunks), 1)) {
        if (ev.kind === "text") {
            text.push((ev as { delta: string }).delta);
            const raw = (ev as { raw?: Buffer }).raw;
            if (raw) rawBytes.push(raw);
        } else if (ev.kind === "meta") {
            rawBytes.push((ev as { chunk: Buffer }).chunk);
        } else if (ev.kind === "tool_call") {
            toolCalls.push({
                name: (ev as { name: string }).name,
                args: (ev as { arguments: string }).arguments,
            });
        }
    }
    return { text: text.join(""), raw: Buffer.concat(rawBytes).toString("utf8"), toolCalls };
}

test("#4466: text chunks carrying an empty tool_calls array flow to the client", async () => {
    const chunks = [
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "HELLO", tool_calls: [] }, finish_reason: "" }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
    ];
    const out = await collect(adapter(), chunks);
    assert.equal(out.text, "HELLO");
    assert.ok(out.raw.includes("HELLO"), `client-visible bytes must carry HELLO, got: ${out.raw}`);
    assert.deepEqual(out.toolCalls, []);
});

test("#4466 both-direction: a real tool-call stream still absorbs and replays", async () => {
    const chunks = [
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "" }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":" } }] },
                finish_reason: "",
            }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }] },
                finish_reason: "",
            }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
    ];
    const out = await collect(adapter(), chunks);
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "get_weather");
    assert.equal(out.toolCalls[0]!.args, '{"city":"Paris"}');
});

test("#4466: mixed stream — empty-array chunk then real tool calls", async () => {
    const chunks = [
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: { content: "let me check", tool_calls: [] }, finish_reason: "" }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{
                index: 0,
                delta: { tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "search", arguments: "{}" } }] },
                finish_reason: "",
            }],
        }),
        sse({
            id: "x", object: "chat.completion.chunk", created: 1, model: "m",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
    ];
    const out = await collect(adapter(), chunks);
    assert.equal(out.text, "let me check");
    assert.ok(out.raw.includes("let me check"));
    assert.equal(out.toolCalls.length, 1);
    assert.equal(out.toolCalls[0]!.name, "search");
});
