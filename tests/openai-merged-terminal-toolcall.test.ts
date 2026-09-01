import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

// #431 — a tool_call that arrives in a MERGED terminal chunk (delta.tool_calls
// + finish_reason in the SAME chunk) was silently dropped: the finishReason
// block's settleToolCalls() ran BEFORE the chunk's own tool_calls were
// accumulated, so the settle never saw them and no one settled them again.
// Invariant: the settle must see every call in the round, so a call whose first
// (or only) fragment lands in the terminal chunk is still forwarded to the
// client (real tool) or executed server-side (proxy tool) — never lost.

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

const toolCallEvents = (events: ParsedStreamEvent[]) =>
    events.filter((ev): ev is Extract<ParsedStreamEvent, { kind: "tool_call" }> => ev.kind === "tool_call");

// CORE BUG — a single real tool call whose entire body lands in the merged
// terminal chunk. Before the fix the finishReason block's settle ran on an
// EMPTY pending (the call was not yet accumulated), so it was not settled
// there; it was only replayed at [DONE], which emitted a SECOND done. Result:
// two completion signals (a non-suppress "tool_calls" done plus a suppress
// "stop" done) instead of one authoritative suppress-completion done.
test("single real tool call in a merged terminal chunk: forwarded once, single authoritative done", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk(
            { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
            "tool_calls",
        ),
    );
    const events = await collect(stream);
    const wire = wireBytes(events);
    const withCall = wire.filter((s) => s.includes('"call_a"'));
    assert.equal(withCall.length, 1, `terminal chunk carrying the tool call written ${withCall.length}x (expected 1):\n${wire.join("")}`);
    assert.ok(toolCallEvents(events).length >= 1, "settle must emit a structured tool_call event for the call");
    assert.equal(finishCount(wire), 1, `expected exactly one authoritative finish, got ${finishCount(wire)}:\n${wire.join("")}`);
    const dones = events.filter((e): e is Extract<ParsedStreamEvent, { kind: "done" }> => e.kind === "done");
    assert.equal(dones.length, 1, `expected exactly one done event (no double-completion), got ${dones.length}`);
    assert.equal(dones[0].finishReason, "tool_calls", "the done must carry the upstream finish_reason");
    assert.equal(dones[0].suppressCompletion, true, "a real-tool round must be the suppress-completion done");
});

// ISSUE REPRO — two calls, the second entirely in the merged terminal chunk.
// Before the fix only the earlier call (from a prior chunk) survived.
test("two calls: prior chunk + merged terminal chunk — both survive (issue #431 repro)", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] }),
        sseChunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "grep", arguments: '"foo"' } }] }, "tool_calls"),
    );
    const events = await collect(stream);
    const wire = wireBytes(events);
    const joined = wire.join("");
    assert.ok(joined.includes('"call_a"'), `call_a (prior chunk) missing from wire:\n${joined}`);
    assert.ok(joined.includes('"call_b"'), `call_b (merged terminal chunk) missing from wire:\n${joined}`);
    // Both calls are real → the settle must have seen both (two passthrough events).
    assert.equal(toolCallEvents(events).length, 2, `expected 2 structured tool_call events, got ${toolCallEvents(events).length}`);
    assert.equal(finishCount(wire), 1, `expected exactly one authoritative finish, got ${finishCount(wire)}:\n${joined}`);
});

// PROXY TOOL — a compress call in the merged terminal chunk must be executed
// server-side, not forwarded verbatim, and must not leak finish_reason to the
// wire (emitCompletion is the single authoritative finish for a proxy round).
test("proxy tool (compress) in a merged terminal chunk is handled server-side, not forwarded, no finish leak", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk(
            { tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "compress", arguments: '{"content":[]}' } }] },
            "tool_calls",
        ),
    );
    const events = await collect(stream);
    const wire = wireBytes(events);
    assert.equal(wire.filter((s) => s.includes('"call_c"')).length, 0, `proxy tool chunk leaked to the wire:\n${wire.join("")}`);
    assert.equal(finishCount(wire), 0, `finish_reason leaked to the wire on a proxy-tool round:\n${wire.join("")}`);
    const compressEvents = toolCallEvents(events).filter((e) => e.name === "compress");
    assert.ok(compressEvents.length >= 1, "structured tool_call event for the proxy tool must still be emitted for core to execute it");
    assert.notEqual(compressEvents[0].passthrough, true, "a proxy tool must not be flagged passthrough (only real tools are)");
});

// NAME SPLIT — the function name completes in the merged terminal chunk. The
// fix must not break the existing name-accumulation path: both fragments reach
// the wire and the settle sees the completed (real) name.
test("name-split where the final fragment lands in the merged terminal chunk still forwards correctly", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ tool_calls: [{ index: 0, id: "call_n", type: "function", function: { name: "ba", arguments: "" } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { name: "sh", arguments: '{"command":"ls"}' } }] }, "tool_calls"),
    );
    const events = await collect(stream);
    const wire = wireBytes(events);
    const joined = wire.join("");
    assert.ok(joined.includes('"ba"'), `first name fragment missing from wire:\n${joined}`);
    assert.ok(joined.includes('"sh"'), `final name fragment (terminal chunk) missing from wire:\n${joined}`);
    const names = toolCallEvents(events).map((e) => e.name);
    assert.ok(names.includes("bash"), `settle must see the completed name "bash", got ${JSON.stringify(names)}`);
    assert.equal(finishCount(wire), 1, `expected exactly one authoritative finish, got ${finishCount(wire)}:\n${joined}`);
});

// CONTENT ORDERING — the merged terminal chunk carries content + tool_call +
// finish_reason together. The terminal chunk is written exactly once (no
// double-yield of the content) and the tool call is not dropped.
test("merged terminal chunk with content + tool_call + finish: call survives, content written once", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant" }),
        sseChunk({ content: "working" }),
        sseChunk(
            { content: "done", tool_calls: [{ index: 0, id: "call_d", type: "function", function: { name: "bash", arguments: "{}" } }] },
            "tool_calls",
        ),
    );
    const events = await collect(stream);
    const wire = wireBytes(events);
    const withDone = wire.filter((s) => s.includes('"done"'));
    assert.equal(withDone.length, 1, `terminal chunk (content) written ${withDone.length}x (expected 1):\n${wire.join("")}`);
    const withCall = wire.filter((s) => s.includes('"call_d"'));
    assert.equal(withCall.length, 1, `terminal chunk (tool call) written ${withCall.length}x (expected 1):\n${wire.join("")}`);
    assert.equal(finishCount(wire), 1, `expected exactly one authoritative finish, got ${finishCount(wire)}:\n${wire.join("")}`);
});
