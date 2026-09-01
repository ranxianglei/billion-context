import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

// #429 "OpenAI Chat received content after the finish reason". Invariant: a
// verbatim passthrough chunk must NEVER carry finish_reason and must be written
// at most once; the sole authoritative completion is the final round's
// emitCompletion, EXCEPT a real-tool-call round (suppressCompletion) where the
// verbatim terminal chunk IS the completion and keeps finish_reason.

const enc = new TextEncoder();
const dec = new TextDecoder();

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

const wireBytes = (events: ParsedStreamEvent[]): string[] =>
    events
        .filter((ev) => ev.kind === "meta" || (ev.kind === "text" && "raw" in ev) || (ev.kind === "reasoning" && "raw" in ev))
        .map((ev) => dec.decode((ev as { chunk?: Uint8Array; raw?: Uint8Array }).chunk ?? (ev as { raw: Uint8Array }).raw));

const finishCount = (wire: string[]) =>
    wire.filter((s) => {
        const m = /^data: (.*)\n\n$/s.exec(s);
        if (!m) return false;
        try {
            return typeof JSON.parse(m[1]).choices?.[0]?.finish_reason === "string";
        } catch {
            return false;
        }
    }).length;

// DEFECT 1 — merged terminal chunk (content + finish_reason in ONE chunk) with a
// real tool call: the finish block yielded the raw chunk as meta without
// `continue`, so the text branch re-wrote the same bytes. Client set finish on
// copy 1, saw content on copy 2. The single write keeps finish_reason.
test("merged content+finish chunk with real tool call is written once, keeping finish_reason", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ content: "working" }),
        sseChunk({
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
        }),
        sseChunk({ content: "done" }, "tool_calls"),
    );
    const wire = wireBytes(await collect(stream));
    const merged = wire.filter((s) => s.includes('"done"'));
    assert.equal(merged.length, 1, `terminal chunk written ${merged.length}x:\n${wire.join("")}`);
    assert.equal(finishCount(wire), 1, `expected exactly one authoritative finish, got ${finishCount(wire)}:\n${wire.join("")}`);
});

// DEFECT 2 — a proxy-tool round is followed by another upstream round (core.ts
// reRequest) with no completion in between. If round 1's merged chunk leaks
// finish_reason to the wire, round 2's text lands after the finish reason.
test("passthrough chunk from a proxy-tool round must not leak finish_reason", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ content: "compressing" }),
        sseChunk({
            tool_calls: [
                { index: 0, id: "call_c1", type: "function", function: { name: "compress", arguments: '{"content":[]}' } },
            ],
        }),
        sseChunk({ content: "please hold" }, "tool_calls"),
    );
    const wire = wireBytes(await collect(stream));
    assert.equal(finishCount(wire), 0, `finish_reason leaked to wire on a proxy-tool round:\n${wire.join("")}`);
});

// REGRESSION — text-only terminal round, merged chunk, no tool call: passthrough
// finish stripped (emitCompletion is the single finish), done event intact.
test("text-only merged terminal round strips passthrough finish but keeps the done event", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ content: "hello" }, "stop"),
    );
    const events = await collect(stream);
    const wire = wireBytes(events);
    assert.equal(finishCount(wire), 0, `passthrough chunk leaked finish_reason:\n${wire.join("")}`);
    const done = events.find((e) => e.kind === "done");
    assert.ok(done && done.kind === "done", "done event present");
    assert.equal(done!.finishReason, "stop", "done carries the upstream finish_reason");
    assert.notEqual(done!.suppressCompletion, true, "non-suppressed: the loop emits the completion");
});

// REGRESSION — reasoning chunk merged with finish_reason must not leak either.
test("reasoning chunk merged with finish_reason must not leak finish_reason", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ reasoning_content: "thinking" }, "stop"),
    );
    const wire = wireBytes(await collect(stream));
    assert.equal(finishCount(wire), 0, `reasoning chunk leaked finish_reason:\n${wire.join("")}`);
});
