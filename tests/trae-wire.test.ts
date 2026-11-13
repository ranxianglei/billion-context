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

test("unwrap: multiple text parts collapse to a newline-joined string", () => {
    const out = unwrapTraeBody(body({
        messages: [{ role: "user", content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }],
    }));
    assert.ok(out);
    // A real newline, not a literal backslash-n: the commandcode sibling
    // (commandcode-wire.ts) collapses parts the same way.
    assert.deepEqual(out.body.messages, [{ role: "user", content: "A\nB" }]);
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
    // images are OpenAI-vocabulary parts and now survive the round trip
    assert.ok(unwrapTraeBody(body({
        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] }],
    })));
    assert.equal(unwrapTraeBody(body({
        messages: [{ role: "user", content: [{ type: "audio", audio: {} }] }],
    })), undefined);
    assert.equal(unwrapTraeBody(body({ messages: [{ role: "developer", content: [{ type: "text", text: "x" }] }] })), undefined);
    assert.equal(unwrapTraeBody(body({
        messages: [{ role: "tool", content: [{ type: "text", text: "x" }] }],
    })), undefined);
    assert.equal(unwrapTraeBody(body({ messages: [] })), undefined);
});

test("rewrap: pipeline cache directives survive the round trip (#5713)", () => {
    const unwrapped = unwrapTraeBody(body());
    assert.ok(unwrapped);
    // prepare-openai stamps the session id into prompt_cache_key and forces
    // usage reporting onto the flat body after the unwrap.
    const back = rewrapTraeBody({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        prompt_cache_key: "ses_abc123",
        stream_options: { include_usage: true },
    }, unwrapped.meta);
    assert.equal(back.prompt_cache_key, "ses_abc123");
    assert.deepEqual(back.stream_options, { include_usage: true });
});

test("unwrap carries client cache directives; rewrap honors a pipeline drop (#5713)", () => {
    const src = body({ prompt_cache_key: "client-key", stream_options: { include_usage: false } });
    const unwrapped = unwrapTraeBody(src);
    assert.ok(unwrapped);
    assert.equal(unwrapped.body.prompt_cache_key, "client-key");
    assert.deepEqual(unwrapped.body.stream_options, { include_usage: false });
    // The pipeline dropped both (ablated upstream / routing decision): they must
    // not resurface from the replayed envelope base.
    const back = rewrapTraeBody({ model: "m", messages: [{ role: "user", content: "hi" }] }, unwrapped.meta);
    assert.equal("prompt_cache_key" in back, false);
    assert.equal("stream_options" in back, false);
});

test("rewrap degrades an unknown role to user text instead of dropping content", () => {
    const src = body();
    const unwrapped = unwrapTraeBody(src);
    assert.ok(unwrapped);
    const back = rewrapTraeBody({ model: "m", messages: [{ role: "developer", content: "policy" }] }, unwrapped.meta);
    assert.deepEqual(back.messages, [{ role: "user", content: [{ type: "text", text: "policy" }] }]);
});
