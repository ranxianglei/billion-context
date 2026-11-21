import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToCore, coreToOpenai } from "acp-kernel/wire";
import type { OpenAIRequestBody } from "acp-kernel/wire";
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

// 1. reasoning_content round-trips through openaiToCore → coreToOpenai.
test("openai: reasoning_content round-trips (content + reasoning preserved)", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "assistant", content: "the answer", reasoning_content: "step 1... step 2..." },
        ],
    };
    const { msgs } = openaiToCore(body);
    const reasoning = msgs.find((m) => m.contentType === "reasoning");
    assert.ok(reasoning, "reasoning coreMessage emitted");
    assert.equal(reasoning?.reasoningContent, "step 1... step 2...", "reasoningContent sidecar stored");
    const text = msgs.find((m) => m.contentType === "text");
    assert.ok(text, "text coreMessage emitted");
    assert.ok(msgs.indexOf(reasoning!) < msgs.indexOf(text!), "reasoning ordered before text");

    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt.length, 1, "single assistant message reconstructed");
    assert.equal(rebuilt[0]?.role, "assistant");
    assert.equal(rebuilt[0]?.content, "the answer", "content preserved");
    assert.equal(rebuilt[0]?.reasoning_content, "step 1... step 2...", "reasoning_content reattached");
});

// 2. reasoning_content + tool_calls both preserved on the same assistant message.
test("openai: reasoning_content + tool_calls both preserved", () => {
    const body: OpenAIRequestBody = {
        messages: [
            {
                role: "assistant",
                content: null,
                reasoning_content: "thinking about tools",
                tool_calls: [
                    { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } },
                ],
            },
        ],
    };
    const { msgs } = openaiToCore(body);
    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt.length, 1, "single assistant message reconstructed");
    assert.equal(rebuilt[0]?.role, "assistant");
    assert.equal(rebuilt[0]?.reasoning_content, "thinking about tools", "reasoning_content preserved");
    assert.equal(rebuilt[0]?.tool_calls?.length, 1, "tool_calls preserved");
    assert.equal(rebuilt[0]?.tool_calls?.[0]?.function?.name, "get_weather");
    assert.equal(rebuilt[0]?.tool_calls?.[0]?.function?.arguments, '{"city":"SF"}');
});

// 3. A normal assistant message (no reasoning_content) is unaffected.
test("openai: assistant without reasoning_content is unaffected", () => {
    const body: OpenAIRequestBody = {
        messages: [{ role: "assistant", content: "plain answer" }],
    };
    const { msgs } = openaiToCore(body);
    assert.ok(!msgs.find((m) => m.contentType === "reasoning"), "no reasoning coreMessage emitted");
    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0]?.content, "plain answer");
    assert.equal(rebuilt[0]?.reasoning_content, undefined, "no reasoning_content key on output");
});

// 4. Multi-turn conversation: reasoning_content on an earlier turn survives
//    alongside a later user/tool exchange.
test("openai: reasoning_content survives in a multi-turn conversation", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "user", content: "what is 2+2?" },
            { role: "assistant", content: "4", reasoning_content: "2+2=4" },
            { role: "user", content: "and 3+3?" },
        ],
    };
    const { msgs } = openaiToCore(body);
    const rebuilt = coreToOpenai(msgs);
    const asst = rebuilt.find((m) => m.role === "assistant");
    assert.ok(asst, "assistant message present");
    assert.equal(asst?.content, "4");
    assert.equal(asst?.reasoning_content, "2+2=4", "earlier-turn reasoning preserved");
});

// 5. parseStream captures delta.reasoning_content as kind:reasoning and still
//    yields content as kind:text.
test("openai adapter: parseStream captures delta.reasoning_content as kind:reasoning", async () => {
    const stream = mockStream(
        sseChunk({ reasoning_content: "thinking..." }),
        sseChunk({ content: "answer" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);

    const reasoning = events.find((e) => e.kind === "reasoning");
    assert.ok(reasoning, "reasoning event yielded from delta.reasoning_content");
    if (reasoning && reasoning.kind === "reasoning") {
        assert.equal(reasoning.delta, "thinking...", "reasoning delta content intact");
        assert.ok(reasoning.raw, "raw buffer attached for client passthrough");
    }
    const text = events.find((e) => e.kind === "text");
    assert.ok(text, "text event still yielded alongside reasoning");
    if (text && text.kind === "text") {
        assert.equal(text.delta, "answer");
    }
});

// 6. emitReasoning produces a well-formed SSE chunk with reasoning_content in
//    the delta, so round-2+ re-request responses reconstruct the client stream.
test("openai adapter: emitReasoning builds reasoning_content delta chunk", () => {
    const adapter = createOpenaiAdapter({ model: "gpt" });
    assert.equal(typeof adapter.emitReasoning, "function", "emitReasoning implemented");
    const buf = adapter.emitReasoning!("chain-of-thought");
    const str = buf.toString("utf8");
    assert.ok(str.includes('"reasoning_content":"chain-of-thought"'), "delta carries reasoning_content");
    assert.ok(str.includes("chat.completion.chunk"), "well-formed SSE chunk");
});

// 7. A reasoning-only assistant message (no content, no tool_calls) still
//    round-trips so the model receives its prior CoT.
test("openai: reasoning-only assistant message round-trips", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "assistant", content: null, reasoning_content: "just thinking" },
        ],
    };
    const { msgs } = openaiToCore(body);
    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt.length, 1, "assistant message emitted (not dropped)");
    assert.equal(rebuilt[0]?.role, "assistant");
    assert.equal(rebuilt[0]?.reasoning_content, "just thinking");
});

// 8. When a single streaming chunk carries BOTH reasoning_content and content,
//    the raw buffer is attached only to the reasoning event — not duplicated on
//    the text event — so the client never receives the same chunk twice.
test("openai adapter: chunk with reasoning+content forwards raw once", async () => {
    const stream = mockStream(
        sseChunk({ reasoning_content: "think", content: "say" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);

    const reasoning = events.find((e) => e.kind === "reasoning");
    const text = events.find((e) => e.kind === "text");
    assert.ok(reasoning && reasoning.kind === "reasoning", "reasoning event yielded");
    assert.ok(text && text.kind === "text", "text event yielded");
    assert.equal(text!.delta, "say", "text delta intact");
    assert.ok(reasoning!.raw, "raw attached to reasoning event (carries full chunk)");
    assert.equal(text!.raw, undefined, "raw NOT duplicated on text event (no double-forwarding)");
});

// 9. #7432 TRIGGER: a provider that streams the thinking under `delta.reasoning`
//    (Ollama Cloud) is captured as kind:reasoning, and the client-visible raw
//    frame is normalized to `reasoning_content` (the alias field is gone).
test("openai adapter: delta.reasoning alias captured + raw normalized to reasoning_content", async () => {
    const stream = mockStream(
        sseChunk({ role: "assistant", content: "", reasoning: "The" }),
        sseChunk({ content: "", reasoning: " need answer" }),
        sseChunk({ content: "answer" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);

    const reasoningEvents = events.filter((e) => e.kind === "reasoning");
    assert.equal(reasoningEvents.length, 2, "both delta.reasoning frames captured as reasoning");
    const deltas = reasoningEvents.map((e) => (e.kind === "reasoning" ? e.delta : ""));
    assert.deepEqual(deltas, ["The", " need answer"], "reasoning deltas intact");

    for (const ev of reasoningEvents) {
        if (ev.kind === "reasoning" && ev.raw) {
            const str = ev.raw.toString("utf8");
            assert.ok(str.includes('"reasoning_content"'), "raw frame normalized to reasoning_content");
            assert.ok(!str.includes('"reasoning":'), "alias field removed from raw frame");
        }
    }

    const text = events.find((e) => e.kind === "text");
    assert.ok(text && text.kind === "text", "text event still yielded");
    if (text && text.kind === "text") assert.equal(text.delta, "answer");
});

// 10. #7432 NON-TRIGGER: the standard `delta.reasoning_content` path is
//     unchanged — captured as kind:reasoning, raw frame keeps reasoning_content.
test("openai adapter: delta.reasoning_content unchanged (non-trigger)", async () => {
    const stream = mockStream(
        sseChunk({ reasoning_content: "think" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);

    const reasoning = events.find((e) => e.kind === "reasoning");
    assert.ok(reasoning && reasoning.kind === "reasoning", "reasoning event yielded");
    if (reasoning && reasoning.kind === "reasoning") {
        assert.equal(reasoning.delta, "think");
        assert.ok(reasoning.raw, "raw buffer attached");
        const str = reasoning.raw!.toString("utf8");
        assert.ok(str.includes('"reasoning_content":"think"'), "raw frame keeps reasoning_content");
    }
});

// 11. #7432 NON-TRIGGER: a frame with no reasoning field produces no reasoning
//     event (a plain text frame is not reshaped into reasoning).
test("openai adapter: plain text frame produces no reasoning event", async () => {
    const stream = mockStream(
        sseChunk({ content: "plain" }),
        sseChunk({}, "stop"),
        `data: [DONE]\n\n`,
    );
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, 1)) events.push(ev);

    assert.ok(!events.find((e) => e.kind === "reasoning"), "no reasoning event from a plain text frame");
    const text = events.find((e) => e.kind === "text");
    assert.ok(text && text.kind === "text", "text event yielded");
    if (text && text.kind === "text") assert.equal(text.delta, "plain");
});

// 12. #7432 KERNEL TRIGGER: openaiToCore reads the `reasoning` alias (the
//     client echoes history under `reasoning`), and coreToOpenai re-emits it as
//     `reasoning_content` (write side stays standard).
test("openai: `reasoning` alias read by openaiToCore, echoed as reasoning_content", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "assistant", content: "the answer", reasoning: "step 1... step 2..." },
        ],
    };
    const { msgs } = openaiToCore(body);
    const reasoning = msgs.find((m) => m.contentType === "reasoning");
    assert.ok(reasoning, "reasoning coreMessage emitted from the `reasoning` alias");
    assert.equal(reasoning?.reasoningContent, "step 1... step 2...");

    const rebuilt = coreToOpenai(msgs);
    assert.equal(rebuilt.length, 1);
    assert.equal(rebuilt[0]?.content, "the answer");
    assert.equal(rebuilt[0]?.reasoning_content, "step 1... step 2...", "write side stays reasoning_content");
    assert.equal("reasoning" in (rebuilt[0] as Record<string, unknown>), false, "no `reasoning` key on output");
});

// 13. #7432 KERNEL NON-TRIGGER: `reasoning_content` (standard) still wins when
//     both fields are present (first non-empty in the chain).
test("openai: reasoning_content wins over reasoning alias (non-trigger)", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "assistant", content: "a", reasoning_content: "from rc", reasoning: "from r" },
        ],
    };
    const { msgs } = openaiToCore(body);
    const reasoning = msgs.find((m) => m.contentType === "reasoning");
    assert.equal(reasoning?.reasoningContent, "from rc", "reasoning_content (first in chain) wins");
});
