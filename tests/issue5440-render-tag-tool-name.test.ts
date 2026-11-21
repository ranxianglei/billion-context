import { test } from "node:test";
import assert from "node:assert/strict";
import { isRenderTagToolName, ECHOED_TOOL_RESULT_TEXT } from "../src/loop/tag-echo-filter.ts";
import { appendEchoedToolExchange } from "../src/wire-body.ts";

// #5440: a model can echo a render tag into a tool call's NAME (attested:
// `acp tokens=`, args {}, deepseek via DSH). No host has such a tool, so
// forwarding it guarantees an UNKNOWN_TOOL failure and a full-context recovery
// step. The loop answers the call in-proxy with a canned result and re-requests
// (exactly like a proxy tool); the client never sees the bogus call. This test
// pins the two pieces that make that safe: the NAME-channel predicate (the loop
// branch is driven by it) and the wire continuation that rebuilds the re-request.

test("#5440: isRenderTagToolName matches echoed render-tag names", () => {
    const echoed = [
        "acp tokens=", // attested shape: name + attrs
        "acp", // bare name
        "ACP", // case drift (#1731)
        "\x3cacp tokens=\"2\" type=\"text\">m00001\x3c/acp>", // full tag as the name
        "acb", // attested 3-letter drift
        "accessp", // attested drift
        "acpi", // 4-letter insertion drift
        "  acp tokens=", // leading whitespace
    ];
    for (const name of echoed) {
        assert.equal(isRenderTagToolName(name), true, `should be an echo: ${JSON.stringify(name)}`);
    }
});

test("#5440: isRenderTagToolName does NOT match real tool names", () => {
    const real = [
        "acp_status", // underscore is not a tag boundary -> stops the match
        "bash",
        "read",
        "write",
        "grep",
        "caption", // contains core "cap" but the next char is a word char
        "acpfoo", // word char immediately after the name
        "acpx", // excluded drift (not in the vocabulary)
    ];
    for (const name of real) {
        assert.equal(isRenderTagToolName(name), false, `should NOT be an echo: ${JSON.stringify(name)}`);
    }
});

test("#5440: isRenderTagToolName is false for an empty name (the nameless path owns it)", () => {
    assert.equal(isRenderTagToolName(""), false);
});

test("#5440: ECHOED_TOOL_RESULT_TEXT is a canned non-executing continuation", () => {
    assert.ok(ECHOED_TOOL_RESULT_TEXT.length > 0);
    assert.match(ECHOED_TOOL_RESULT_TEXT, /nothing was executed/i);
});

test("#5440: appendEchoedToolExchange appends assistant turn + tool result (openai/anthropic)", () => {
    const assistant = [{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "acp tokens=", arguments: "{}" } }] }];
    const toolResult = [{ role: "tool", tool_call_id: "call_1", content: ECHOED_TOOL_RESULT_TEXT }];
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const out = appendEchoedToolExchange("openai", body, assistant, toolResult);
    assert.ok(out !== null);
    const parsed = JSON.parse(out as string) as { messages: Record<string, unknown>[] };
    assert.equal(parsed.messages.length, 3);
    assert.equal(parsed.messages[0].role, "user");
    assert.equal(parsed.messages[1].role, "assistant");
    const fn = (parsed.messages[1].tool_calls as { function: { name: string } }[])[0].function;
    assert.equal(fn.name, "acp tokens=");
    assert.equal(parsed.messages[2].role, "tool");
    assert.equal(parsed.messages[2].content, ECHOED_TOOL_RESULT_TEXT);
});

test("#5440: appendEchoedToolExchange uses contents for the google wire", () => {
    const assistant = [{ role: "model", parts: [] }];
    const toolResult = [{ role: "user", parts: [] }];
    const body = JSON.stringify({ contents: [{ role: "user", parts: [] }] });
    const out = appendEchoedToolExchange("google", body, assistant, toolResult);
    assert.ok(out !== null);
    const parsed = JSON.parse(out as string) as { contents: unknown[] };
    assert.equal(parsed.contents.length, 3);
});

test("#5440: appendEchoedToolExchange returns null for the responses wire (no echo lane)", () => {
    const body = JSON.stringify({ input: [{ role: "user", content: "hi" }] });
    assert.equal(appendEchoedToolExchange("responses", body, [{ role: "assistant" }], [{ role: "tool" }]), null);
});

test("#5440: appendEchoedToolExchange returns null for an unparseable body or missing turn array", () => {
    assert.equal(appendEchoedToolExchange("openai", "not json", [{ role: "assistant" }], []), null);
    assert.equal(appendEchoedToolExchange("openai", JSON.stringify({ model: "m" }), [{ role: "assistant" }], []), null);
});
