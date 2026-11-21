// #7432: OpenAI-compatible upstreams disagree on the thinking field's name.
// DeepSeek/llama.cpp stream `reasoning_content`; Ollama Cloud, vLLM and Magpie
// stream `reasoning`. The adapter used to read reasoning_content only, so every
// reasoning-only chunk of an alias upstream fell through the dispatch ladder —
// the client kept exactly the ONE frame that also carried `role` (meta
// fallback), i.e. the first token of the whole thinking block.
//
// Two-way pins (#3617 gate discipline): the alias MUST stream as reasoning, and
// the canonical field plus the non-reasoning frames MUST behave exactly as
// before (raw bytes verbatim, no extra events).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenaiAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/index.ts";

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

async function collect(...chunks: string[]): Promise<ParsedStreamEvent[]> {
    const adapter = createOpenaiAdapter({ model: "deepseek-v4.1-flash" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(mockStream(...chunks), 1)) events.push(ev);
    return events;
}

function reasoningDeltas(events: ParsedStreamEvent[]): string[] {
    return events.flatMap((e) => (e.kind === "reasoning" ? [e.delta] : []));
}

function clientBytes(events: ParsedStreamEvent[]): string {
    return events
        .map((e) => (e as { raw?: Buffer; chunk?: Buffer }).raw ?? (e as { chunk?: Buffer }).chunk)
        .filter((b): b is Buffer => b !== undefined)
        .map((b) => b.toString("utf8"))
        .join("");
}

// 1. The trigger: a provider that streams `delta.reasoning` keeps its whole
//    thinking block, one reasoning event per upstream chunk.
test("#7432 openai adapter: every delta.reasoning chunk streams as kind:reasoning", async () => {
    const events = await collect(
        sseChunk({ role: "assistant", content: "", reasoning: "Let" }),
        sseChunk({ content: "", reasoning: " me compute" }),
        sseChunk({ content: "", reasoning: " 17*23." }),
        sseChunk({ content: "391" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    assert.deepEqual(reasoningDeltas(events), ["Let", " me compute", " 17*23."], "no alias chunk is dropped, none is merged");
    const text = events.find((e) => e.kind === "text");
    assert.ok(text && text.kind === "text", "answer text still streams");
    assert.equal(text!.delta, "391");
});

// 2. Client-visible frames speak the canonical field name: the alias key is
//    rewritten away, so a client that saw `reasoning` never echoes it back (an
//    upstream silently discards a replayed `reasoning` field).
test("#7432 openai adapter: alias frames are rewritten to reasoning_content before the client sees them", async () => {
    const events = await collect(
        sseChunk({ role: "assistant", content: "", reasoning: "Let" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    const reasoning = events.find((e) => e.kind === "reasoning");
    assert.ok(reasoning && reasoning.kind === "reasoning" && reasoning.raw, "reasoning event carries client bytes");
    const raw = reasoning!.raw!.toString("utf8");
    assert.ok(raw.includes('"reasoning_content":"Let"'), `canonical field on the wire, got: ${raw}`);
    assert.ok(!/"reasoning":/.test(raw), `alias key dropped, got: ${raw}`);
});

// 3. The non-trigger: `reasoning_content` upstreams are untouched — the raw
//    frame reaches the client byte-verbatim, exactly as before the fix.
test("#7432 openai adapter: delta.reasoning_content frames stay byte-verbatim", async () => {
    const frame = sseChunk({ reasoning_content: "thinking..." });
    const events = await collect(frame, sseChunk({ content: "answer" }), sseChunk({}, "stop"), `data: [DONE]\n\n`);
    assert.deepEqual(reasoningDeltas(events), ["thinking..."]);
    const reasoning = events.find((e) => e.kind === "reasoning");
    assert.equal(reasoning!.raw!.toString("utf8"), frame, "canonical frames are forwarded untouched");
});

// 4. The other non-trigger: a frame with no reasoning field of either name is
//    not promoted into one (role-only frames keep the meta path).
test("#7432 openai adapter: frames without a reasoning field yield no reasoning event", async () => {
    const events = await collect(
        sseChunk({ role: "assistant", content: "" }),
        sseChunk({ content: "hi" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    assert.deepEqual(reasoningDeltas(events), [], "no reasoning invented");
    assert.ok(events.some((e) => e.kind === "meta"), "the role-carrying frame still rides the meta path");
});

// 5. Alias + content in ONE frame: still exactly one client-visible frame, and
//    the reasoning event owns it (same allocation as the #1881 dual-field pin).
test("#7432 openai adapter: a frame with reasoning alias AND content forwards once", async () => {
    const events = await collect(
        sseChunk({ reasoning: "think", content: "say" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    const reasoning = events.find((e) => e.kind === "reasoning");
    const text = events.find((e) => e.kind === "text");
    assert.ok(reasoning && reasoning.kind === "reasoning", "reasoning event yielded");
    assert.ok(text && text.kind === "text", "text event yielded");
    assert.equal(text!.delta, "say");
    assert.equal(text!.raw, undefined, "text event must not duplicate the frame");
    const raw = reasoning!.raw!.toString("utf8");
    assert.ok(raw.includes('"reasoning_content":"think"'), `reasoning rides canonical, got: ${raw}`);
    assert.ok(raw.includes('"content":"say"'), `sibling content rides along once, got: ${raw}`);
});

// 6. The tool-call replay path (#1881 withheld sibling prose) reads the alias
//    too: a proxy-only tool frame must still hand its reasoning to the client.
test("#7432 openai adapter: proxy-only tool frame delivers its alias reasoning prose", async () => {
    const events = await collect(
        sseChunk({ tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "bili_compress", arguments: "{}" } }] }),
        sseChunk({ reasoning: "sibling thought", tool_calls: [{ index: 1, id: "call_p2", type: "function", function: { name: "bili_compress", arguments: "{}" } }] }),
        sseChunk({}, "tool_calls"),
        `data: [DONE]\n\n`,
    );
    const out = clientBytes(events);
    assert.ok(out.includes("sibling thought"), `the withheld reasoning reaches the client, got: ${out}`);
    assert.ok(out.includes('"reasoning_content":"sibling thought"'), `canonical field, got: ${out}`);
    assert.ok(!out.includes("bili_compress"), "the proxy call still never rides along");
});

// 7. The full alias table is pinned, not just `reasoning`: the third entry
//    (`reasoning_text`, same set and order as pi-ai's reasoningFields) streams
//    as reasoning and rides out canonical.
test("#7432 openai adapter: delta.reasoning_text is read and rewritten like the other aliases", async () => {
    const events = await collect(
        sseChunk({ reasoning_text: "third alias" }),
        sseChunk({ content: "answer" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    assert.deepEqual(reasoningDeltas(events), ["third alias"], "reasoning_text chunk streams as reasoning");
    const reasoning = events.find((e) => e.kind === "reasoning");
    const raw = reasoning!.raw!.toString("utf8");
    assert.ok(raw.includes('"reasoning_content":"third alias"'), `canonical field, got: ${raw}`);
    assert.ok(!/"reasoning_text":/.test(raw), `alias key dropped, got: ${raw}`);
});
