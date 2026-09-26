import test from "node:test";
import assert from "node:assert/strict";
import { unwrapCommandcodeBody, rewrapCommandcodeBody } from "../src/commandcode-wire.ts";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        config: { provider: "commandcode" },
        memory: [],
        threadId: "th_1",
        params: {
            model: "cc-go-1",
            stream: true,
            messages: [
                { role: "user", content: [{ type: "text", text: "hello" }] },
            ],
            ...overrides,
        },
    };
}

test("unwrap: flat body carries model/messages/stream and drops the envelope into meta", () => {
    const out = unwrapCommandcodeBody(envelope({ system: "be brief", max_tokens: 42, temperature: 0.5, top_p: 0.9 }));
    assert.ok(out);
    assert.deepEqual(out.body.messages, [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
    ]);
    assert.equal(out.body.model, "cc-go-1");
    assert.equal(out.body.stream, true);
    assert.equal(out.body.max_tokens, 42);
    assert.equal(out.body.temperature, 0.5);
    assert.equal(out.body.top_p, 0.9);
    assert.deepEqual(out.meta.rest, { config: { provider: "commandcode" }, memory: [], threadId: "th_1" });
    assert.equal(out.meta.systemText, "be brief");
    assert.equal(out.meta.hadSystem, true);
});

test("round-trip: unwrap→rewrap is deep-equal for a rich conversation", () => {
    const src = envelope({
        max_tokens: 100,
        tools: [
            { type: "function", name: "get_weather", description: "d", input_schema: { type: "object", properties: { city: { type: "string" } } } },
        ],
        messages: [
            { role: "system", content: "inline sys" },
            { role: "user", content: [{ type: "text", text: "p1" }, { type: "text", text: "p2" }] },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "checking" },
                    { type: "reasoning", text: "think" },
                    { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", input: { city: "Paris" } },
                ],
            },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "tc1", toolName: "get_weather", output: { type: "error-text", value: "boom" } }] },
            { role: "assistant", content: "done" },
        ],
    });
    const unwrapped = unwrapCommandcodeBody(src);
    assert.ok(unwrapped);
    const flat = unwrapped.body;
    assert.deepEqual(flat.messages, [
        { role: "system", content: "inline sys" },
        { role: "user", content: "p1\np2" },
        {
            role: "assistant",
            content: "checking",
            reasoning_content: "think",
            tool_calls: [{ id: "tc1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }],
        },
        { role: "tool", tool_call_id: "tc1", content: "boom" },
        { role: "assistant", content: "done" },
    ]);
    assert.deepEqual(flat.tools, [
        { type: "function", function: { name: "get_weather", description: "d", parameters: { type: "object", properties: { city: { type: "string" } } } } },
    ]);
    const back = rewrapCommandcodeBody(flat, unwrapped.meta);
    // Normalizations (WIRE-CONTRACTS.md): inline system hoists into the
    // params.system slot; multi-part user text blocks join into one block;
    // assistant content is always re-emitted as a block array.
    const expected = structuredClone(src) as any;
    assert.equal(expected.params.messages[0].role, "system");
    expected.params.messages.shift();
    expected.params.system = "inline sys";
    expected.params.messages[0].content = [{ type: "text", text: "p1\np2" }];
    expected.params.messages[expected.params.messages.length - 1].content = [{ type: "text", text: "done" }];
    assert.deepEqual(back, expected);
});

test("round-trip: params.system merges ahead of inline system messages (single slot on the wire)", () => {
    const src = envelope({
        system: "sys-a\nsys-b",
        messages: [
            { role: "system", content: "inline sys" },
            { role: "user", content: "hi" },
        ],
    });
    const unwrapped = unwrapCommandcodeBody(src);
    assert.ok(unwrapped);
    assert.equal((unwrapped.body.messages[0] as any).content, "sys-a\nsys-b\n\ninline sys");
    const back = rewrapCommandcodeBody(unwrapped.body, unwrapped.meta) as any;
    assert.equal(back.params.system, "sys-a\nsys-b\n\ninline sys");
});

test("round-trip: error-text tool results keep their type across the trip", () => {
    const src = envelope({
        messages: [
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: {} }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: { type: "error-text", value: "exit 1" } }] },
        ],
    });
    const unwrapped = unwrapCommandcodeBody(src);
    assert.ok(unwrapped);
    const back = rewrapCommandcodeBody(unwrapped.body, unwrapped.meta);
    assert.deepEqual(back.params.messages[1].content[0].output, { type: "error-text", value: "exit 1" });
});

test("rewrap: tool results without a known tool name fall back to \"unknown\"", () => {
    const unwrapped = unwrapCommandcodeBody(envelope());
    assert.ok(unwrapped);
    const flat: Record<string, unknown> = {
        ...unwrapped.body,
        messages: [
            { role: "user", content: "hi" },
            { role: "tool", tool_call_id: "ghost", content: "result" },
        ],
    };
    const back = rewrapCommandcodeBody(flat, unwrapped.meta) as any;
    assert.equal(back.params.messages[1].content[0].toolName, "unknown");
});

test("rewrap: tool results without an explicit name derive it from the paired call", () => {
    const src = envelope({
        messages: [
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "t9", toolName: "bash", input: {} }] },
            { role: "tool", content: [{ type: "tool-result", toolCallId: "t9", output: { type: "text", value: "ok" } }] },
        ],
    });
    const unwrapped = unwrapCommandcodeBody(src);
    assert.ok(unwrapped);
    const back = rewrapCommandcodeBody(unwrapped.body, unwrapped.meta) as any;
    assert.equal(back.params.messages[1].content[0].toolName, "bash");
});

test("rewrap: unknown roles degrade to user text instead of being dropped (WC-2)", () => {
    const unwrapped = unwrapCommandcodeBody(envelope());
    assert.ok(unwrapped);
    const flat: Record<string, unknown> = {
        ...unwrapped.body,
        messages: [
            { role: "user", content: "hi" },
            { role: "developer", content: "steered note" },
        ],
    };
    const back = rewrapCommandcodeBody(flat, unwrapped.meta) as any;
    const last = back.params.messages[back.params.messages.length - 1];
    assert.deepEqual(last, { role: "user", content: [{ type: "text", text: "steered note" }] });
});

test("rewrap: absent system slot stays absent when no system messages exist", () => {
    const unwrapped = unwrapCommandcodeBody(envelope());
    assert.ok(unwrapped);
    const back = rewrapCommandcodeBody(unwrapped.body, unwrapped.meta) as any;
    assert.ok(!("system" in back.params));
});

test("rewrap: present-but-empty system slot is preserved as empty string", () => {
    const unwrapped = unwrapCommandcodeBody(envelope({ system: "" }));
    assert.ok(unwrapped);
    const back = rewrapCommandcodeBody(unwrapped.body, unwrapped.meta) as any;
    assert.equal(back.params.system, "");
});

test("rewrap: max_tokens/temperature fall back to meta when stripped from flat body", () => {
    const unwrapped = unwrapCommandcodeBody(envelope({ max_tokens: 77, temperature: 0.25 }));
    assert.ok(unwrapped);
    const flat = { model: "m", messages: [{ role: "user", content: "x" }] };
    const back = rewrapCommandcodeBody(flat, unwrapped.meta) as any;
    assert.equal(back.params.max_tokens, 77);
    assert.equal(back.params.temperature, 0.25);
});

test("unwrap rejects: non-object / missing params / non-streaming (WC-6) / empty model / empty messages", () => {
    assert.equal(unwrapCommandcodeBody({}), undefined);
    assert.equal(unwrapCommandcodeBody({ params: "nope" }), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ stream: false }) as any), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ model: "" }) as any), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ messages: [] }) as any), undefined);
});

test("unwrap rejects: unknown roles and malformed message shapes", () => {
    assert.equal(unwrapCommandcodeBody(envelope({ messages: [{ role: "weird", content: "x" }] }) as any), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ messages: [{ role: "user", content: [{ type: "image", url: "u" }] }] }) as any), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ messages: [{ role: "tool", content: "not an array" }] }) as any), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ messages: [{ role: "tool", content: [{ type: "tool-result", output: { type: "text", value: "v" } }] }] }) as any), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ messages: [{ role: "assistant", content: [{ type: "image", text: "" }] }] }) as any), undefined);
});

test("unwrap rejects: malformed tools entries", () => {
    assert.equal(unwrapCommandcodeBody(envelope({ tools: "nope" }) as any), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ tools: [{ type: "custom", name: "f" }] }) as any), undefined);
    assert.equal(unwrapCommandcodeBody(envelope({ tools: [{ type: "function", input_schema: [] }] }) as any), undefined);
});

test("unwrap: only-system messages yield no conversation", () => {
    assert.equal(unwrapCommandcodeBody(envelope({ messages: [{ role: "system", content: "s" }] }) as any), undefined);
});
