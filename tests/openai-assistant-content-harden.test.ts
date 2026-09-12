import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToCore, coreToOpenai } from "acp-kernel/wire";
import type { OpenAIRequestBody } from "acp-kernel/wire";
import { hardenOpenaiAssistantContent } from "../src/util.ts";
import { createOpenaiAdapter } from "../src/loop/index.ts";

// #719: a reasoning-only assistant turn (upstream stream truncated before any
// completion event) rebuilds as content:null via coreToOpenai; DeepSeek rejects
// that with 400 "Invalid assistant message: content or tool_calls must be set".
// hardenOpenaiAssistantContent normalizes it to "" at the proxy forward boundary.

test("harden: reasoning-only assistant turn becomes content '' (issue #719 repro)", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "", reasoning_content: "let me think about this..." },
            { role: "user", content: "say ok" },
        ],
    };
    const { msgs } = openaiToCore(body);
    const raw = coreToOpenai(msgs);
    const rawAsst = raw.find((m) => m.role === "assistant");
    assert.equal(rawAsst?.content, null, "kernel emits content:null for reasoning-only turns");

    const out = hardenOpenaiAssistantContent(raw);
    const asst = out.find((m) => m.role === "assistant");
    assert.equal(asst?.content, "", "null normalized to empty string");
    assert.equal(asst?.reasoning_content, "let me think about this...", "reasoning preserved");
    const users = out.filter((m) => m.role === "user").map((u) => u.content);
    assert.deepEqual(users, ["hi", "say ok"], "user messages untouched");
});

test("harden: content:null input (vs '') also rebuilds to ''", () => {
    const body: OpenAIRequestBody = {
        messages: [{ role: "assistant", content: null, reasoning_content: "just thinking" }],
    };
    const { msgs } = openaiToCore(body);
    const out = hardenOpenaiAssistantContent(coreToOpenai(msgs));
    assert.equal(out.length, 1);
    assert.equal(out[0]?.role, "assistant");
    assert.equal(out[0]?.content, "");
    assert.equal(out[0]?.reasoning_content, "just thinking");
});

test("harden: tool_calls branch null content normalized too, tool_calls preserved", () => {
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
    const out = hardenOpenaiAssistantContent(coreToOpenai(msgs));
    assert.equal(out.length, 1);
    assert.equal(out[0]?.content, "", "null -> '' even when tool_calls present");
    assert.equal(out[0]?.tool_calls?.length, 1);
    assert.equal(out[0]?.tool_calls?.[0]?.function?.name, "get_weather");
    assert.equal(out[0]?.tool_calls?.[0]?.function?.arguments, '{"city":"SF"}');
    assert.equal(out[0]?.reasoning_content, "thinking about tools");
});

test("harden: no-op (same object identity) for string/array content and non-assistant roles", () => {
    const msgs = [
        { role: "user" as const, content: "hello" },
        { role: "assistant" as const, content: "plain answer" },
        { role: "assistant" as const, content: [{ type: "text", text: "parted" }] },
        { role: "tool" as const, content: "tool result", tool_call_id: "call_1" },
    ];
    const out = hardenOpenaiAssistantContent(msgs);
    assert.equal(out[0], msgs[0], "user untouched");
    assert.equal(out[1], msgs[1], "string assistant untouched");
    assert.equal(out[2], msgs[2], "array assistant untouched");
    assert.equal(out[3], msgs[3], "tool untouched");
});

test("harden: empty list stays empty", () => {
    assert.deepEqual(hardenOpenaiAssistantContent([]), []);
});

test("adapter.buildRequest: every rebuilt assistant message carries string content end-to-end", () => {
    const body: OpenAIRequestBody = {
        messages: [
            { role: "system", content: "you are helpful" },
            { role: "user", content: "hi" },
            { role: "assistant", content: "", reasoning_content: "truncated reasoning..." },
            { role: "user", content: "continue" },
        ],
    };
    const { msgs } = openaiToCore(body);
    const adapter = createOpenaiAdapter({ model: "gpt" });
    const req = adapter.buildRequest(msgs, "", { model: "gpt" });
    const messages = req.messages as Array<{ role: string; content?: unknown; reasoning_content?: string }>;
    const asst = messages.filter((m) => m.role === "assistant");
    assert.equal(asst.length, 1, "reasoning-only turn not dropped");
    assert.equal(typeof asst[0]?.content, "string", "assistant content is a string on the wire");
    assert.equal(asst[0]?.content, "");
    assert.equal(asst[0]?.reasoning_content, "truncated reasoning...");
});
