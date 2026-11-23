// #6056: proxy-owned ACP function calls on the Responses wire must never leak into
// the client's native tool dispatcher. Copilot rotates function_call item ids across
// lifecycle events (added vs done) while call_id and output_index stay stable, so the
// old direct-id lookup missed and the parser forwarded the raw done + a passthrough
// tool_call — Pi then answered "Tool ... not found" while bili ALSO executed the call
// server-side. These cases pin the correlation fallback and the ACP-name safety net.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createResponsesAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/index.ts";

function sseLf(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

async function collectParseEvents(
    adapter: ReturnType<typeof createResponsesAdapter>,
    stream: ReadableStream<Uint8Array>,
    round: number,
): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, round)) events.push(ev);
    return events;
}

function toolCalls(events: ParsedStreamEvent[]): Extract<ParsedStreamEvent, { kind: "tool_call" }>[] {
    return events.filter((e): e is Extract<ParsedStreamEvent, { kind: "tool_call" }> => e.kind === "tool_call");
}

function metaText(events: ParsedStreamEvent[]): string {
    return events
        .filter((e): e is Extract<ParsedStreamEvent, { kind: "meta" }> => e.kind === "meta")
        .map((e) => e.chunk.toString("utf8"))
        .join("\n");
}

test("responses ACP: stable ids withhold the whole lifecycle + emit one proxy tool_call (#6056 baseline)", async () => {
    const s = sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "acp_status", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_a", output_index: 0, delta: '{"scope":"uncompressed"}' })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "acp_status", arguments: '{"scope":"uncompressed"}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 1);
    const tcs = toolCalls(events);
    assert.equal(tcs.length, 1, "exactly one proxy tool_call");
    assert.equal(tcs[0].name, "acp_status");
    assert.equal(tcs[0].callId, "call_a");
    assert.equal(tcs[0].arguments, '{"scope":"uncompressed"}');
    assert.ok(!tcs[0].passthrough, "proxy-handled call is NOT marked passthrough");
    const mt = metaText(events);
    assert.ok(!mt.includes('"id":"fc_a"'), "no raw ACP lifecycle byte reaches the client");
});

test("responses ACP: rotated done id (stable call_id+output_index) still intercepted, no leak (#6056)", async () => {
    const s = sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-original", call_id: "call-same", name: "acp_status", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc-original", output_index: 0, delta: '{"scope":"uncompressed"}' })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc-rotated", call_id: "call-same", name: "acp_status", arguments: '{"scope":"uncompressed"}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_2", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 1);
    const tcs = toolCalls(events);
    assert.equal(tcs.length, 1, "exactly one proxy tool_call");
    assert.equal(tcs[0].name, "acp_status");
    assert.equal(tcs[0].callId, "call-same");
    assert.equal(tcs[0].arguments, '{"scope":"uncompressed"}');
    assert.ok(!tcs[0].passthrough, "must not be passthrough (would dispatch natively)");
    const mt = metaText(events);
    assert.ok(!mt.includes("fc-rotated"), "rotated done id must not leak to the client");
    assert.ok(!mt.includes("fc-original"), "original added id must not leak either");
});

test("responses ACP: rotated argument-event item_id (stable output_index) withheld (#6056)", async () => {
    const s = sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_orig", call_id: "call_x", name: "compress", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_rot_arg", output_index: 0, delta: '{"ranges":["m00007-m00007"]}' })
        + sseLf("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_rot_arg", output_index: 0, arguments: '{"ranges":["m00007-m00007"]}' })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_orig", call_id: "call_x", name: "compress", arguments: '{"ranges":["m00007-m00007"]}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_3", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 1);
    const tcs = toolCalls(events);
    assert.equal(tcs.length, 1);
    assert.equal(tcs[0].name, "compress");
    assert.equal(tcs[0].arguments, '{"ranges":["m00007-m00007"]}');
    assert.ok(!tcs[0].passthrough);
    const mt = metaText(events);
    assert.ok(!mt.includes("fc_rot_arg"), "rotated arg-event id must not leak");
});

test("responses ACP: nameless added + ACP-named done intercepted by safety net, never forwarded (#6056)", async () => {
    // Degraded stream: the added carries no name (so it is not buffered as bili's
    // surface), but the done names an ACP tool. The safety net must intercept the
    // done server-side instead of forwarding it to the client dispatcher.
    const s = sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_n", call_id: "call_n", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_n", output_index: 0, delta: "{}" })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_n", call_id: "call_n", name: "decompress", arguments: '{"blockId":"b1"}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_4", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 1);
    const dec = toolCalls(events).filter((t) => t.name === "decompress");
    assert.equal(dec.length, 1, "safety net intercepts the ACP-named done");
    assert.ok(!dec[0].passthrough, "intercepted, not dispatched natively");
    assert.equal(dec[0].callId, "call_n");
    assert.equal(dec[0].arguments, '{"blockId":"b1"}');
    const mt = metaText(events);
    assert.ok(!mt.includes('"name":"decompress"'), "ACP-named done must not be forwarded raw");
});

test("responses ACP: interleaved ACP+native with rotated done ids — ACP intercepted, read passes through (#6056)", async () => {
    const s =
        sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_c0", call_id: "call_c", name: "compress", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_c0", output_index: 0, delta: '{"ranges":["m00001-m00003"]}' })
        + sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_r0", call_id: "call_r", name: "read", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_r0", output_index: 1, delta: '{"path":"a.txt"}' })
        + sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_s0", call_id: "call_s", name: "search_context", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_s0", output_index: 2, delta: '{"query":"canary"}' })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_c1", call_id: "call_c", name: "compress", arguments: '{"ranges":["m00001-m00003"]}' } })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_r1", call_id: "call_r", name: "read", arguments: '{"path":"a.txt"}' } })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_s1", call_id: "call_s", name: "search_context", arguments: '{"query":"canary"}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_5", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 1);
    const tcs = toolCalls(events);
    const compress = tcs.find((t) => t.name === "compress");
    const search = tcs.find((t) => t.name === "search_context");
    const read = tcs.find((t) => t.name === "read");
    assert.ok(compress && !compress.passthrough, "compress intercepted (proxy-handled)");
    assert.ok(search && !search.passthrough, "search_context intercepted (proxy-handled)");
    assert.ok(read && read.passthrough === true, "native read passes through to the client");
    const mt = metaText(events);
    assert.ok(!mt.includes("fc_c1"), "rotated compress done id must not leak");
    assert.ok(!mt.includes("fc_s1"), "rotated search_context done id must not leak");
    assert.ok(mt.includes("fc_r1"), "native read done id passes through untouched");
});

test("responses ACP: rotated done id on round 2 still intercepted (#6056)", async () => {
    const s = sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_o", call_id: "call_z", name: "acp_cache", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_o", output_index: 0, delta: '{"detail":"full"}' })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_rot2", call_id: "call_z", name: "acp_cache", arguments: '{"detail":"full"}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_6", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 2);
    const cache = toolCalls(events).find((t) => t.name === "acp_cache");
    assert.ok(cache && !cache.passthrough, "acp_cache intercepted on round 2");
    const mt = metaText(events);
    assert.ok(!mt.includes("fc_rot2"), "rotated done id must not leak on round 2");
});

test("responses native: well-formed native call passes through complete (no unfinished tool call) (#6056 negative)", async () => {
    const s = sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_read", call_id: "call_read", name: "bash", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_read", output_index: 0, delta: '{"cmd":"ls"}' })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_read", call_id: "call_read", name: "bash", arguments: '{"cmd":"ls"}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_7", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 1);
    const bash = toolCalls(events).find((t) => t.name === "bash");
    assert.ok(bash && bash.passthrough === true, "native bash passes through");
    const mt = metaText(events);
    assert.ok(mt.includes("response.output_item.added"), "added forwarded");
    assert.ok(mt.includes("response.output_item.done"), "done forwarded — full lifecycle, no dangling call");
});
