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
    const toolCallMetas = metas.filter((m) => m.kind === "meta" && m.chunk.toString().includes("get_weather"));
    assert.ok(toolCallMetas.length >= 1, "the raw tool_call chunk itself is replayed verbatim");
    const passthrough = events.find((e) => e.kind === "tool_call");
    assert.ok(passthrough?.kind === "tool_call" && passthrough.name === "get_weather" && passthrough.passthrough === true, "structured passthrough event so the loop counts it as a real call");
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done", "done event present");
    assert.equal(done!.finishReason, "stop", "finish_reason preserved as-is from upstream");
    assert.equal(done!.suppressCompletion, true, "no regenerated completion after the verbatim replay");
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

// 4. REGRESSION (SGLang/vLLM name-splitting): the tool NAME arrives in the
//    first delta and continuation deltas carry EMPTY names. A proxy tool
//    (compress) split this way must be accumulated and handed to the compress
//    loop as a structured event — the client must never see an empty-name
//    fragment (hermes: "Unknown tool ''" → retry loop → partial stop).
test("openai adapter: name-split proxy tool never leaks to the client", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({
            tool_calls: [
                { index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: "" } },
            ],
        }),
        sseChunk({
            tool_calls: [
                { index: 0, function: { name: "", arguments: '{"content":[{"startId":"m2"' } },
            ],
        }),
        sseChunk({
            tool_calls: [
                { index: 0, function: { name: "", arguments: ',"endId":"m9"}]}' } },
            ],
        }),
        sseChunk({}, "tool_calls"),
    );
    const events = await collect(stream);
    const structured = events.filter((e) => e.kind === "tool_call");
    assert.equal(structured.length, 1, "exactly one structured tool_call for the compress loop");
    const tc = structured[0];
    assert.ok(tc?.kind === "tool_call");
    assert.equal(tc.name, "compress", "name accumulated across the split deltas");
    assert.equal(tc.callId, "call_c");
    assert.equal(tc.arguments, '{"content":[{"startId":"m2","endId":"m9"}]}', "arguments concatenated");
    const leaked = events.filter((e) => e.kind === "meta" && e.chunk.toString().includes("compress"));
    assert.equal(leaked.length, 0, "no raw fragment carrying the proxy tool leaks to the client");
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls");
    assert.notEqual(done?.kind === "done" && done.suppressCompletion, true, "proxy round: completion NOT suppressed (loop re-requests)");
});

// 5. Name-split REAL tool: fragments must accumulate and replay with the
//    original chunk order/ids, exactly like the single-fragment case.
test("openai adapter: name-split real tool accumulates and replays verbatim", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_r", type: "function", function: { name: "get_wea", arguments: "" } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { name: "ther", arguments: "{}" } }] }),
        sseChunk({}, "tool_calls"),
    );
    const events = await collect(stream);
    const structured = events.filter((e) => e.kind === "tool_call");
    const tc = structured[0];
    assert.ok(tc?.kind === "tool_call");
    assert.equal(tc.name, "get_weather", "name fragments concatenated");
    assert.equal(tc.passthrough, true);
    const replay = events.filter((e) => e.kind === "meta" && e.chunk.toString().includes("tool_calls"));
    assert.ok(replay.length >= 2, "both raw fragments replayed to the client");
    const done = events.find((e) => e.kind === "done");
    assert.equal(done?.kind === "done" && done.finishReason, "tool_calls");
});

// 6. Mixed round (compress + real bash in the same turn): the replay must
//    contain ONLY the real call's fragments; the compress call goes to the
//    loop as a structured event for server-side execution.
test("openai adapter: mixed proxy+real round strips proxy fragments from the replay", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: "{}" } }] }),
        sseChunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "bash", arguments: "{\"c\":\"ls\"}" } }] }),
        sseChunk({}, "tool_calls"),
    );
    const events = await collect(stream);
    const structured = events.filter((e) => e.kind === "tool_call");
    assert.equal(structured.length, 2);
    const byName = new Map(structured.map((e) => (e.kind === "tool_call" ? [e.name, e] : ["", e])));
    const compress = byName.get("compress");
    const bash = byName.get("bash");
    assert.ok(compress?.kind === "tool_call" && compress.passthrough !== true, "compress handled server-side (no passthrough)");
    assert.ok(bash?.kind === "tool_call" && bash.passthrough === true, "bash forwarded to the client");
    const replayText = events
        .filter((e) => e.kind === "meta")
        .map((e) => (e.kind === "meta" ? e.chunk.toString() : ""))
        .join("");
    assert.ok(replayText.includes("bash"), "bash fragment replayed");
    assert.ok(!replayText.includes("compress"), "compress fragment stripped from the replay");
});
