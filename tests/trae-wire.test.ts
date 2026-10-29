import test from "node:test";
import assert from "node:assert/strict";
import { unwrapTraeBody, rewrapTraeBody } from "../src/trae-wire.ts";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        model: "deepseek-v4.1-flash",
        stream: true,
        messages: [
            { role: "system", content: [{ type: "text", text: "be brief" }] },
            { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        max_tokens: 64000,
        reasoning_effort: "extra_high",
        model_auto_selection: { strategy: "max", fallback_to_advance_model: null, entitlement_id: null },
        model_selection_strategy: "max",
        mode_type: 1,
        context_window_size: 1000000,
        prompt_max_tokens: 936000,
        function: "solo_agent",
        config_name: "deepseek-v4.1-flash",
        ...overrides,
    };
}

test("unwrap: text parts become strings, envelope keys drop into meta", () => {
    const out = unwrapTraeBody(body());
    assert.ok(out);
    assert.deepEqual(out.body.messages, [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
    ]);
    assert.equal(out.body.model, "deepseek-v4.1-flash");
    assert.equal(out.body.stream, true);
    assert.equal(out.body.max_tokens, 64000);
    assert.equal(out.body.reasoning_effort, "extra_high");
    assert.equal((out.meta.envelope as Record<string, unknown>).function, "solo_agent");
    assert.equal((out.meta.envelope as Record<string, unknown>).mode_type, 1);
});

test("unwrap: function_call reduces to function and tool results flatten", () => {
    const out = unwrapTraeBody(body({
        messages: [
            { role: "user", content: [{ type: "text", text: "weather?" }] },
            {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_1", type: "function", function_call: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }],
            },
            { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "{\"temp\":12}" }] },
        ],
    }));
    assert.ok(out);
    assert.deepEqual(out.body.messages, [
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "{\"temp\":12}" },
    ]);
});

test("rewrap: restores the trae envelope and message shapes", () => {
    const src = body();
    const unwrapped = unwrapTraeBody(src);
    assert.ok(unwrapped);
    const back = rewrapTraeBody(unwrapped.body, unwrapped.meta);
    assert.equal(back.function, "solo_agent");
    assert.equal(back.config_name, "deepseek-v4.1-flash");
    assert.equal(back.mode_type, 1);
    assert.equal(back.context_window_size, 1000000);
    assert.equal(back.prompt_max_tokens, 936000);
    assert.equal(back.stream, true);
    assert.deepEqual(back.messages, [
        { role: "system", content: [{ type: "text", text: "be brief" }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
});

test("round-trip: a tool conversation survives unwrap→rewrap", () => {
    const src = body({
        tools: [{ type: "function", function: { name: "run_code", parameters: { type: "object", properties: {} } } }],
        messages: [
            { role: "system", content: [{ type: "text", text: "sys" }] },
            { role: "user", content: [{ type: "text", text: "go" }] },
            {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "call_9", type: "function", function_call: { name: "run_code", arguments: "{\"code\":\"1\"}" } }],
            },
            { role: "tool", tool_call_id: "call_9", content: [{ type: "text", text: "ok" }] },
            { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
    });
    const unwrapped = unwrapTraeBody(src);
    assert.ok(unwrapped);
    const back = rewrapTraeBody(unwrapped.body, unwrapped.meta);
    assert.deepEqual(back.messages, src.messages);
    assert.deepEqual(back.tools, src.tools);
});

test("rewrap: an assistant tool turn keeps content null and renames the payload key", () => {
    const src = body();
    const unwrapped = unwrapTraeBody(src);
    assert.ok(unwrapped);
    const back = rewrapTraeBody({
        model: "m",
        messages: [{
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_2", type: "function", function: { name: "compress", arguments: "{}" } }],
        }],
    }, unwrapped.meta);
    assert.deepEqual(back.messages, [{
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_2", type: "function", function_call: { name: "compress", arguments: "{}" } }],
    }]);
});

test("unwrap rejects: non-streaming, missing model, non-text part, unknown role, tool without id", () => {
    assert.equal(unwrapTraeBody(body({ stream: false })), undefined);
    assert.equal(unwrapTraeBody(body({ model: "" })), undefined);
    assert.equal(unwrapTraeBody(body({
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] }],
    })), undefined);
    assert.equal(unwrapTraeBody(body({ messages: [{ role: "developer", content: [{ type: "text", text: "x" }] }] })), undefined);
    assert.equal(unwrapTraeBody(body({
        messages: [{ role: "tool", content: [{ type: "text", text: "x" }] }],
    })), undefined);
    assert.equal(unwrapTraeBody(body({ messages: [] })), undefined);
});

test("rewrap degrades an unknown role to user text instead of dropping content", () => {
    const src = body();
    const unwrapped = unwrapTraeBody(src);
    assert.ok(unwrapped);
    const back = rewrapTraeBody({ model: "m", messages: [{ role: "developer", content: "policy" }] }, unwrapped.meta);
    assert.deepEqual(back.messages, [{ role: "user", content: [{ type: "text", text: "policy" }] }]);
});
