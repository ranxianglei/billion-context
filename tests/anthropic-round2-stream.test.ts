import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicAdapter } from "../src/loop/adapter-anthropic.ts";

interface ParsedEvent {
    kind: string;
    delta?: string;
    raw?: Buffer;
    chunk?: Buffer;
    firstRoundOnly?: boolean;
    signature?: string;
    blockEnd?: boolean;
}

function sse(events: string[]): string {
    return events.map((e) => e + "\n\n").join("");
}

function toStream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });
}

const ROUND2_STREAM = sse([
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_r2", usage: { input_tokens: 10 } } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
]);

test("anthropic round-2 streaming: deltas carry raw + block start/stop forwarded (regression: vertical-text bug)", async () => {
    const adapter = createAnthropicAdapter({ model: "claude-1" });
    const events: ParsedEvent[] = [];
    for await (const ev of adapter.parseStream(toStream(ROUND2_STREAM), 2) as AsyncIterable<ParsedEvent>) {
        events.push(ev);
    }
    const textEvents = events.filter((e) => e.kind === "text");
    const metaChunks = events.filter((e) => e.kind === "meta").map((e) => e.chunk?.toString("utf8") ?? "");

    assert.equal(textEvents.length, 2, "two text deltas parsed");
    assert.ok(
        textEvents.every((e) => Buffer.isBuffer(e.raw)),
        "round-2 text deltas carry raw (the actual content_block_delta event) so core.ts forwards them inline",
    );
    assert.ok(
        textEvents.every((e) => !/content_block_start|content_block_stop/.test(e.raw!.toString("utf8"))),
        "raw is a pure delta (NOT a full block) — OLD code wrapped each delta via emitText/buildTextBlock → one block per chunk → vertical text",
    );
    const hasStart = metaChunks.some((c) => c.includes("content_block_start"));
    const hasStop = metaChunks.some((c) => c.includes("content_block_stop"));
    assert.ok(hasStart, "content_block_start forwarded in round 2 (opens the text block)");
    assert.ok(hasStop, "content_block_stop forwarded in round 2 (closes the text block)");
});

// #1455: suppression is keyed on ACTUAL forwarding state, not the round number —
// a truncated round's blind retry re-parses at the SAME round, so a round-keyed
// guard would emit a second response identity. The real invariant: at most ONE
// message_start per adapter (per logical response), regardless of how many
// upstream streams it parsed.
const ROUND1_STREAM = sse([
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_r1", usage: { input_tokens: 9 } } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
]);

test("anthropic message_start is emitted at most once per adapter — across rounds AND across re-parsed streams", async () => {
    const adapter = createAnthropicAdapter({ model: "claude-1" });
    const allMeta: string[] = [];
    for await (const ev of adapter.parseStream(toStream(ROUND1_STREAM), 1) as AsyncIterable<ParsedEvent>) {
        if (ev.kind === "meta") allMeta.push(ev.chunk?.toString("utf8") ?? "");
    }
    for await (const ev of adapter.parseStream(toStream(ROUND2_STREAM), 2) as AsyncIterable<ParsedEvent>) {
        if (ev.kind === "meta") allMeta.push(ev.chunk?.toString("utf8") ?? "");
    }
    const starts = allMeta.filter((c) => c.includes("message_start")).length;
    assert.equal(starts, 1, "exactly one message_start across both parses — the second parse (next round or truncation retry) must not emit a second response identity");
});

const ROUND2_THINKING = sse([
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_r2t", usage: { input_tokens: 10 } } })}`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " ac" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "p_status" } })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
]);

test("anthropic round-2 thinking: deltas carry raw + signature forwarded — ONE block, not per-delta fragments (regression: zcode duplicate thinking)", async () => {
    const adapter = createAnthropicAdapter({ model: "claude-1" });
    const events: ParsedEvent[] = [];
    for await (const ev of adapter.parseStream(toStream(ROUND2_THINKING), 2) as AsyncIterable<ParsedEvent>) {
        events.push(ev);
    }
    const reasoning = events.filter((e) => e.kind === "reasoning");
    const thinkingDeltas = reasoning.filter((e) => (e.delta ?? "").length > 0);
    assert.equal(thinkingDeltas.length, 3, "three thinking deltas parsed");
    assert.ok(
        thinkingDeltas.every((e) => Buffer.isBuffer(e.raw)),
        "round-2 thinking deltas carry raw — OLD code withheld raw and core.ts re-wrapped EACH delta via emitReasoning (start+delta+stop per chunk → one thinking block per token → clients replay them as duplicate '思考过程' entries)",
    );
    assert.ok(
        thinkingDeltas.every((e) => !/content_block_start|content_block_stop/.test(e.raw!.toString("utf8"))),
        "raw is a pure delta (NOT a full block)",
    );
    const sig = reasoning.find((e) => e.signature === "sig-abc");
    assert.ok(sig && Buffer.isBuffer(sig.raw), "signature_delta forwarded with raw in round 2 (signatures must survive or replayed thinking 400s)");

    const metaChunks = events.filter((e) => e.kind === "meta").map((e) => e.chunk?.toString("utf8") ?? "");
    const thinkingStarts = metaChunks.filter((c) => c.includes('"thinking"'));
    const stops = metaChunks.filter((c) => c.includes("content_block_stop"));
    assert.equal(thinkingStarts.length, 1, "exactly one content_block_start for the thinking block");
    assert.equal(stops.length, 1, "exactly one content_block_stop — block closes once");
    assert.ok(
        reasoning.some((e) => e.blockEnd),
        "segment seal event still emitted for the server-side accumulator",
    );
});
