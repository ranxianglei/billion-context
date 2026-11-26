import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/index.ts";

// #7694: the reasoning-string drop (delta.reasoning / reasoning_content /
// reasoning_text) is fixed by #7432's alias table. The residual gap this file
// pins: a delta whose ONLY field is one bili does not track (here
// delta.reasoning_details, with no thinking-string field) still matched no
// branch of the dispatch ladder and was dropped as "empty", losing the
// thinking metadata. It must be forwarded verbatim.

function mockStream(...chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const enc = new TextEncoder();
            for (const c of chunks) controller.enqueue(enc.encode(c));
            controller.close();
        },
    });
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return `data: ${JSON.stringify({
        id: "c1",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
}

// Collect the client-visible raw bytes parseStream would forward: reasoning /
// text events carry `raw`, meta events carry `chunk`.
function forwardedBytes(events: ParsedStreamEvent[]): string {
    return events
        .map((e) => {
            if (e.kind === "reasoning" || e.kind === "text") return e.raw?.toString("utf8") ?? "";
            if (e.kind === "meta") return e.chunk.toString("utf8");
            return "";
        })
        .join("");
}

async function parse(stream: ReadableStream<Uint8Array>): Promise<ParsedStreamEvent[]> {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);
    return events;
}

// A reasoning_details-only delta (no reasoning/reasoning_content/content/role)
// is not empty from the client's view — forward it verbatim.
test("#7694: reasoning_details-only delta is forwarded, not dropped", async () => {
    const events = await parse(mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ reasoning_details: [{ type: "reasoning.text", text: "RD" }] }),
        sseChunk({ content: "x" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    ));
    const bytes = forwardedBytes(events);
    assert.ok(bytes.includes("reasoning_details"), "reasoning_details-only frame is not dropped");
    assert.ok(bytes.includes('"content":"x"'), "content frame still reaches the client");
});

// An unknown-field-only delta (a field bili has no notion of) is likewise
// forwarded verbatim — the conservative "any non-empty field" expectation.
test("#7694: unknown-field-only delta is forwarded verbatim", async () => {
    const events = await parse(mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ some_custom_field: "v" }),
        sseChunk({ content: "x" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    ));
    const bytes = forwardedBytes(events);
    assert.ok(bytes.includes('"some_custom_field":"v"'), "unknown-field-only frame is not dropped");
    assert.ok(bytes.includes('"content":"x"'), "content frame still reaches the client");
});

// Negative: a role-only delta is still a first-round-only meta frame — the new
// fall-through must not turn structural frames into every-round content frames.
test("#7694: role-only delta stays a first-round-only meta frame", async () => {
    const events = await parse(mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ content: "x" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    ));
    const roleMeta = events.find((e) => e.kind === "meta" && e.chunk.toString("utf8").includes('"role":"assistant"'));
    assert.ok(roleMeta && roleMeta.kind === "meta", "role frame is a meta event");
    assert.equal(roleMeta!.firstRoundOnly, true, "role frame stays first-round-only");
});

// Negative: an empty-delta finish frame is still dropped (the client gets the
// finish via the done event) — the fall-through must not forward it.
test("#7694: empty-delta finish frame is not forwarded by the fall-through", async () => {
    const events = await parse(mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ content: "x" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    ));
    const bytes = forwardedBytes(events);
    // The finish frame (empty delta + finish_reason) must not appear as a
    // forwarded meta/text/reasoning frame.
    assert.ok(!bytes.includes('"finish_reason":"stop"'), "empty-delta finish frame is not forwarded");
});
