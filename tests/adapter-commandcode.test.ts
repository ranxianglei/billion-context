import test from "node:test";
import assert from "node:assert/strict";
import { createCommandcodeAdapter } from "../src/loop/adapter-commandcode.ts";
import { buildVisibilityMarker } from "../src/compress-loop.ts";
import type { ParsedStreamEvent } from "../src/loop/core.ts";

const jsonl = (body: string): ReadableStream<Uint8Array> => new Response(body, { status: 200 }).body!;

async function collect(round: number, body: string): Promise<ParsedStreamEvent[]> {
    const adapter = createCommandcodeAdapter({ model: "m", messages: [], stream: true });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(jsonl(body), round)) events.push(ev);
    return events;
}

test("parseStream: basic event sequence maps to text/reasoning/usage/done", async () => {
    const events = await collect(1, [
        '{"type":"text-delta","text":"hel"}',
        '{"type":"reasoning-delta","text":"thinking"}',
        '{"type":"text-delta","text":"lo"}',
        '{"type":"finish","finishReason":"stop","totalUsage":{"inputTokens":10,"outputTokens":5,"inputTokenDetails":{"cacheReadTokens":3}}}',
    ].join("\n"));
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ["text", "reasoning", "text", "usage", "done"]);
    assert.equal((events[0] as any).delta, "hel");
    assert.equal((events[1] as any).delta, "thinking");
    assert.equal((events[2] as any).delta, "lo");
    assert.deepEqual((events[3] as any), { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 3 });
    assert.equal((events[4] as any).finishReason, "stop");
    assert.equal((events[4] as any).thinking, true);
    assert.ok(!(events[4] as any).suppressCompletion);
});

test("parseStream: every raw byte stays a bare JSONL line (no SSE framing)", async () => {
    const events = await collect(1, '{"type":"text-delta","text":"x"}\n');
    const raw = (events.find((e) => e.kind === "text") as any).raw as Buffer;
    const s = raw.toString("utf8");
    assert.ok(!s.includes("data:"), "must not contain SSE framing");
    assert.ok(s.endsWith("\n"));
    assert.equal(JSON.parse(s.slice(0, -1)).type, "text-delta");
});

test("parseStream: model-emitted render tags are stripped from prose", async () => {
    const events = await collect(1, [
        '{"type":"text-delta","text":"hello <acp tokens=\\"2\\" type=\\"text\\">m00001</acp> world"}',
        '{"type":"finish","finishReason":"stop"}',
    ].join("\n"));
    const texts = events.filter((e) => e.kind === "text").map((e) => (e as any).delta);
    const joined = texts.join("");
    assert.ok(joined.includes("hello") && joined.includes("world"));
    assert.ok(!joined.includes("<acp"), "render tag must be stripped from the delta");
});

test("parseStream: mixed real+proxy turn replays the real call verbatim and executes the proxy call", async () => {
    const bashLine = '{"type":"tool-call","toolCallId":"c1","toolName":"bash","input":{"cmd":"ls"}}';
    const compressLine = '{"type":"tool-call","toolCallId":"c2","toolName":"compress","input":{}}';
    const events = await collect(1, [bashLine, compressLine, '{"type":"finish","finishReason":"tool_calls"}'].join("\n"));
    const calls = events.filter((e) => e.kind === "tool_call") as any[];
    assert.equal(calls.length, 2);
    const bash = calls.find((c) => c.name === "bash");
    const compress = calls.find((c) => c.name === "compress");
    assert.equal(bash.passthrough, true);
    assert.equal(bash.callId, "c1");
    assert.equal(bash.arguments, '{"cmd":"ls"}');
    assert.equal(compress.passthrough, undefined);
    const metas = events.filter((e) => e.kind === "meta") as any[];
    const replayed = metas.map((m) => m.chunk.toString("utf8")).filter((s) => s.includes("tool-call"));
    assert.equal(replayed.length, 1, "only the real call's original line is replayed");
    assert.equal(replayed[0], bashLine + "\n");
    assert.equal((events[events.length - 1] as any).suppressCompletion, true);
});

test("parseStream: proxy-only turn yields structured calls, no wire replay", async () => {
    const events = await collect(1, [
        '{"type":"tool-call","toolCallId":"c9","toolName":"compress","input":{}}',
        '{"type":"finish","finishReason":"stop"}',
    ].join("\n"));
    const calls = events.filter((e) => e.kind === "tool_call") as any[];
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "compress");
    assert.equal(calls[0].passthrough, undefined);
    assert.ok(events.every((e) => e.kind !== "meta"), "proxy-only turns must not replay wire bytes");
    assert.ok(!(events[events.length - 1] as any).suppressCompletion);
});

test("parseStream: finish frame rides through verbatim when real tools were seen", async () => {
    const finishLine = '{"type":"finish","finishReason":"tool_calls","totalUsage":{"inputTokens":1,"outputTokens":2}}';
    const events = await collect(1, ['{"type":"tool-call","toolCallId":"c1","toolName":"bash","input":{}}', finishLine].join("\n"));
    const metas = (events.filter((e) => e.kind === "meta") as any[]).map((m) => m.chunk.toString("utf8"));
    assert.ok(metas.includes(finishLine + "\n"));
});

test("parseStream: error event is terminal and carries the message", async () => {
    const events = await collect(1, [
        '{"type":"text-delta","text":"before"}',
        '{"type":"error","error":"rate_limited","message":"slow down"}',
        '{"type":"text-delta","text":"after"}',
    ].join("\n"));
    const err = events.find((e) => e.kind === "error") as any;
    assert.equal(err.message, "slow down");
    assert.ok(events.every((e, i) => i <= events.indexOf(err)), "nothing may follow the error event");
});

test("parseStream: undecodable and unknown-type lines forward verbatim in round 1 only", async () => {
    const body = ["not json at all", '{"type":"reasoning-start"}', '{"type":"finish","finishReason":"stop"}'].join("\n");
    const r1 = (await collect(1, body)).filter((e) => e.kind === "meta") as any[];
    assert.equal(r1.length, 2);
    assert.equal(r1[0].chunk.toString("utf8"), "not json at all\n");
    assert.equal(r1[0].firstRoundOnly, true);
    assert.equal(r1[1].chunk.toString("utf8"), '{"type":"reasoning-start"}\n');
    assert.equal(r1[1].firstRoundOnly, true);
    // Round 2: nothing may reach the wire in later rounds. The adapter gates
    // undecodable lines itself; unknown-type metas carry firstRoundOnly, which
    // core.ts drops for round > 1 (same convention as the sibling adapters).
    const r2 = (await collect(2, body)).filter((e) => e.kind === "meta") as any[];
    for (const m of r2) {
        assert.ok(m.chunk.toString("utf8").includes("reasoning-start"));
        assert.equal(m.firstRoundOnly, true);
    }
    assert.ok(!r2.some((m) => m.chunk.toString("utf8").includes("not json")));
});

test("emit*: every emission is a bare JSONL line of the right event type", () => {
    const adapter = createCommandcodeAdapter({ model: "m", messages: [] });
    const parse = (b: Buffer) => JSON.parse(b.toString("utf8").replace(/\n$/, ""));
    const t = parse(adapter.emitText("hi"));
    assert.deepEqual(t, { type: "text-delta", text: "hi" });
    const r = parse(adapter.emitReasoning("think"));
    assert.deepEqual(r, { type: "reasoning-delta", text: "think" });
    const tc = parse(adapter.emitToolCall({ name: "bash", callId: "id1", arguments: '{"a":1}' }));
    assert.deepEqual(tc, { type: "tool-call", toolCallId: "id1", toolName: "bash", input: { a: 1 } });
    assert.deepEqual(parse(adapter.emitToolCall({ name: "bash", callId: "id2", arguments: "nope" })).input, {});
    const marker = parse(adapter.emitMarker("compress", "ok"));
    assert.equal(marker.type, "text-delta");
    assert.equal(marker.text, buildVisibilityMarker("compress", "ok"));
    const fin = parse(adapter.emitCompletion({ finishReason: "length", usage: { inputTokens: 7, outputTokens: 8, cachedTokens: 9 } }));
    assert.deepEqual(fin, { type: "finish", finishReason: "length", totalUsage: { inputTokens: 7, outputTokens: 8, inputTokenDetails: { cacheReadTokens: 9 } } });
    assert.deepEqual(parse(adapter.emitCompletion()).totalUsage, { inputTokens: 0, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 0 } });
    assert.deepEqual(parse(adapter.emitError("kaput")), { type: "error", error: "acp_proxy_error", message: "kaput" });
});
