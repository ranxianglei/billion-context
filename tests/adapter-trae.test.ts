import test from "node:test";
import assert from "node:assert/strict";
import { createTraeAdapter } from "../src/loop/adapter-trae.ts";
import { buildVisibilityMarker } from "../src/loop/core.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

const frame = (event: string, data: unknown): string => `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
const sse = (body: string): ReadableStream<Uint8Array> => new Response(body, { status: 200 }).body!;

async function collect(round: number, body: string): Promise<ParsedStreamEvent[]> {
    const adapter = createTraeAdapter({ model: "m", messages: [], stream: true });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(sse(body), round)) events.push(ev);
    return events;
}

function field<T>(e: ParsedStreamEvent, key: string): T {
    return (e as unknown as Record<string, T>)[key];
}

test("parseStream: output/token_usage/done map to text/usage/done", async () => {
    const events = await collect(1, [
        frame("metadata", { model: "", session_id: "s1" }),
        frame("timing_cost", { name: "llm_raw_chat_v2" }),
        frame("output", { response: "hel", reasoning_content: null, tool_calls: null }),
        frame("output", { response: "", reasoning_content: "thinking", tool_calls: null }),
        frame("output", { response: "lo", reasoning_content: null, tool_calls: null }),
        frame("token_usage", { prompt_tokens: 10, completion_tokens: 5, cache_read_input_tokens: 3 }),
        frame("done", { finish_reason: "stop" }),
    ].join(""));
    assert.deepEqual(events.map((e) => e.kind), ["meta", "meta", "text", "reasoning", "text", "usage", "done"]);
    assert.equal(field<string>(events[2], "delta"), "hel");
    assert.equal(field<string>(events[3], "delta"), "thinking");
    assert.deepEqual(events[5], { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 3 });
    assert.equal(field<string>(events[6], "finishReason"), "stop");
    assert.equal(field<boolean>(events[6], "thinking"), true);
    assert.ok(!field<boolean>(events[6], "suppressCompletion"));
});

test("parseStream: provider frames ride through in round 1 only", async () => {
    const body = [
        frame("metadata", { session_id: "s1" }),
        frame("output", { response: "x", reasoning_content: null, tool_calls: null }),
        frame("done", { finish_reason: "stop" }),
    ].join("");
    const first = await collect(1, body);
    assert.equal(first.filter((e) => e.kind === "meta").length, 1);
    const later = await collect(2, body);
    assert.equal(later.filter((e) => e.kind === "meta").length, 0);
});

test("parseStream: two-phase tool_call deltas assemble into one real call", async () => {
    const events = await collect(1, [
        frame("output", {
            response: "",
            tool_calls: [{ index: 0, id: "call_1", type: "function", function_call: { name: "run_code", arguments: "", partial_arguments: null, namespace: null } }],
        }),
        frame("output", {
            response: "",
            tool_calls: [{ index: 0, id: "", type: "", function_call: { name: "", arguments: "{\"code\":\"1\"}" } }],
        }),
        frame("done", { finish_reason: "stop" }),
    ].join(""));
    const calls = events.filter((e) => e.kind === "tool_call");
    assert.equal(calls.length, 1);
    assert.equal(field<string>(calls[0], "name"), "run_code");
    assert.equal(field<string>(calls[0], "callId"), "call_1");
    assert.equal(field<string>(calls[0], "arguments"), "{\"code\":\"1\"}");
    assert.equal(field<boolean>(events[events.length - 1], "suppressCompletion"), true);
});

test("parseStream: a proxy tool call does not suppress the completion", async () => {
    const events = await collect(1, [
        frame("output", {
            response: "",
            tool_calls: [{ index: 0, id: "call_2", type: "function", function_call: { name: "compress", arguments: "{}" } }],
        }),
        frame("done", { finish_reason: "stop" }),
    ].join(""));
    const calls = events.filter((e) => e.kind === "tool_call");
    assert.equal(calls.length, 1);
    assert.equal(field<string>(calls[0], "name"), "compress");
    assert.ok(!field<boolean>(events[events.length - 1], "suppressCompletion"));
});

test("parseStream: model-emitted render tags are stripped from prose only", async () => {
    const events = await collect(1, [
        frame("output", { response: "hello <acp tokens=\"2\" type=\"text\">m00001</acp> world", reasoning_content: null, tool_calls: null }),
        frame("done", { finish_reason: "stop" }),
    ].join(""));
    const joined = events.filter((e) => e.kind === "text").map((e) => field<string>(e, "delta")).join("");
    assert.ok(joined.includes("hello") && joined.includes("world"));
    assert.ok(!joined.includes("<acp"));
    const raw = field<Buffer>(events.find((e) => e.kind === "text")!, "raw").toString("utf8");
    assert.ok(raw.startsWith("event:output\ndata:"));
    assert.ok(!raw.includes("<acp"));
});

test("parseStream: an undecodable frame forwards verbatim in round 1 only", async () => {
    const body = `event:output\ndata:{not json}\n\n${frame("done", { finish_reason: "stop" })}`;
    const first = await collect(1, body);
    assert.equal(first.filter((e) => e.kind === "meta").length, 1);
    const later = await collect(2, body);
    assert.equal(later.filter((e) => e.kind === "meta").length, 0);
});

test("parseStream: an error frame ends the stream", async () => {
    const events = await collect(1, [
        frame("output", { response: "partial", reasoning_content: null, tool_calls: null }),
        frame("error", { message: "boom" }),
    ].join(""));
    assert.deepEqual(events.map((e) => e.kind), ["text", "error"]);
    assert.equal(field<string>(events[1], "message"), "boom");
});

test("emit: text, reasoning and tool calls use the trae SSE dialect", () => {
    const adapter = createTraeAdapter({ model: "m", messages: [], stream: true });
    const text = adapter.emitText("hi").toString("utf8");
    assert.ok(text.startsWith("event:output\ndata:{"), "no space after the colon");
    assert.equal(JSON.parse(text.split("data:")[1]).response, "hi");
    assert.ok(adapter.emitReasoning, "the trae adapter streams reasoning");
    const reasoning = adapter.emitReasoning("hmm").toString("utf8");
    assert.equal(JSON.parse(reasoning.split("data:")[1]).reasoning_content, "hmm");
    const call = JSON.parse(adapter.emitToolCall({ name: "run_code", callId: "c1", arguments: "{}" }).toString("utf8").split("data:")[1]);
    assert.deepEqual(call.tool_calls, [{
        index: 0,
        id: "c1",
        type: "function",
        function_call: { name: "run_code", arguments: "{}", partial_arguments: null, namespace: null },
    }]);
});

test("emit: completion emits token_usage then done with numeric usage fields", () => {
    const adapter = createTraeAdapter({ model: "m", messages: [], stream: true });
    const out = adapter.emitCompletion({ finishReason: "tool_calls", usage: { inputTokens: 7, outputTokens: 2, cachedTokens: 1 } }).toString("utf8");
    const parts = out.split("\n\n").filter((s) => s.length > 0);
    assert.equal(parts.length, 2);
    assert.ok(parts[0].startsWith("event:token_usage\ndata:"));
    const usage = JSON.parse(parts[0].split("data:")[1]);
    assert.equal(usage.prompt_tokens, 7);
    assert.equal(usage.completion_tokens, 2);
    assert.equal(usage.total_tokens, 9);
    assert.equal(usage.cache_read_input_tokens, 1);
    assert.ok(parts[1].startsWith("event:done\ndata:"));
    assert.equal(JSON.parse(parts[1].split("data:")[1]).finish_reason, "tool_calls");
});

test("emit: the visibility marker rides as prose inside an output frame", () => {
    const adapter = createTraeAdapter({ model: "m", messages: [], stream: true });
    const out = adapter.emitMarker("compress", "ok").toString("utf8");
    assert.ok(out.startsWith("event:output\ndata:"));
    assert.equal(JSON.parse(out.split("data:")[1]).response, buildVisibilityMarker("compress", "ok"));
});

test("emit: errors use an error frame", () => {
    const adapter = createTraeAdapter({ model: "m", messages: [], stream: true });
    const out = adapter.emitError("upstream said no").toString("utf8");
    assert.ok(out.startsWith("event:error\ndata:"));
    assert.equal(JSON.parse(out.split("data:")[1]).message, "upstream said no");
});
