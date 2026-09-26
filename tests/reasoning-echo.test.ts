import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isStrictReasoningEcho, normalizeStrictEchoReasoning, warnReasoningPairs, warnAnthropicThinkingPairs, warnResponsesReasoningPairs } from "../src/server.js";
import { modelIdOf, normalizeStrictEchoBody } from "../src/strict-echo.js";
import type { Session } from "../src/session.js";
import type { OpenAIMessage } from "acp-kernel/wire";
import { createInitialState } from "acp-kernel";

function fakeSession(over: Record<string, unknown> = {}): Session {
    return {
        id: "s1",
        meta: {},
        state: createInitialState(),
        stats: { requests: 0 },
        metadata: { ...over },
    } as unknown as Session;
}

function collector(): { lines: string[]; log: (level: string, msg: string) => void } {
    const lines: string[] = [];
    return { lines, log: (_level, msg) => lines.push(msg) };
}

describe("#684 strict-echo gate", () => {
    it("static: deepseek origin disables the reasoning drop", () => {
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://api.deepseek.com"), true);
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://api.deepseek.com/v1"), true);
    });

    it("static: other origins do not", () => {
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://dashscope.aliyuncs.com"), false);
        assert.equal(isStrictReasoningEcho(fakeSession(), undefined), false);
    });

    it("learned flag (400 mentioning reasoning_content) wins on any origin", () => {
        assert.equal(isStrictReasoningEcho(fakeSession({ strictReasoningEcho: true }), "https://openrouter.ai"), true);
    });

    it("#1027 static: deepseek model id matches on a non-deepseek origin", () => {
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://opencode.ai", "deepseek-flash"), true);
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://openrouter.ai", "DeepSeek-V4-Pro"), true);
        assert.equal(isStrictReasoningEcho(fakeSession(), undefined, "deepseek-v4-flash"), true);
    });

    it("#1027 static: non-deepseek model ids do not match", () => {
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://opencode.ai", "gpt-5"), false);
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://opencode.ai", "glm-5.2"), false);
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://opencode.ai", ""), false);
        assert.equal(isStrictReasoningEcho(fakeSession(), "https://opencode.ai"), false);
    });
});

describe("#1027 modelIdOf", () => {
    it("extracts the string model id only", () => {
        assert.equal(modelIdOf({ model: "deepseek-flash" }), "deepseek-flash");
        assert.equal(modelIdOf({}), undefined);
        assert.equal(modelIdOf({ model: 42 }), undefined);
        assert.equal(modelIdOf(null), undefined);
        assert.equal(modelIdOf(undefined), undefined);
    });
});

describe("#684 exit sentinels", () => {
    it("openai wire: split turn warns", () => {
        const c = collector();
        warnReasoningPairs([
            { role: "user", content: "u" },
            { role: "assistant", content: "a1", reasoning_content: "think" },
            { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "compress", arguments: "{}" } }] },
        ], c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /reasoning-pair-violated/);
    });

    it("openai wire: consistent sessions stay silent", () => {
        const c = collector();
        warnReasoningPairs([
            { role: "assistant", content: "a1", reasoning_content: "t" },
            { role: "assistant", content: "", tool_calls: [] },
        ], c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("anthropic wire: tool_use that lost its inbound thinking warns", () => {
        const c = collector();
        const inbound = [
            { role: "user", content: "u" },
            { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", id: "tu1", name: "n", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "r" }] },
        ];
        const outbound = [
            { role: "user", content: "u" },
            { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "n", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "r" }] },
        ];
        warnAnthropicThinkingPairs(inbound, outbound, c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /thinking-pair-violated/);
    });

    it("#1327 anthropic wire: pre-existing asymmetry (turns that never thought) stays silent", () => {
        const c = collector();
        const msgs = [
            { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", id: "tu1", name: "n", input: {} }] },
            { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "n", input: {} }] },
        ];
        warnAnthropicThinkingPairs(msgs, msgs, c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("#1327 anthropic wire: non-thinking session stays silent", () => {
        const c = collector();
        const msgs = [
            { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "n", input: {} }] },
            { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "n", input: {} }] },
        ];
        warnAnthropicThinkingPairs(msgs, msgs, c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("#1327 anthropic wire: counts only blocks bili actually lost, not pre-existing gaps", () => {
        const c = collector();
        const inbound = [
            { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", id: "tu1", name: "n", input: {} }] },
            { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "n", input: {} }] },
        ];
        const outbound = [
            { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "n", input: {} }] },
            { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "n", input: {} }] },
        ];
        warnAnthropicThinkingPairs(inbound, outbound, c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /thinking-pair-violated: 1 tool_use block/);
        assert.match(c.lines[0]!, /tu1/);
        assert.doesNotMatch(c.lines[0]!, /tu2/);
    });

    it("#1327 anthropic wire: fully folded turn (no preserved tool_use) stays silent", () => {
        const c = collector();
        const inbound = [
            { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", id: "tu1", name: "n", input: {} }] },
            { role: "assistant", content: [{ type: "text", text: "later" }] },
        ];
        const outbound = [
            { role: "assistant", content: [{ type: "text", text: "later" }] },
        ];
        warnAnthropicThinkingPairs(inbound, outbound, c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("responses wire: function_call without preceding reasoning warns", () => {
        const c = collector();
        warnResponsesReasoningPairs([
            { type: "message", role: "user", content: "u" },
            { type: "reasoning", content: "r" },
            { type: "message", role: "assistant", content: "a" },
            { type: "function_call", name: "compress", arguments: "{}", call_id: "c1" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /reasoning-pair-violated/);
    });
});

describe("#762 sentinel precision: presence, not emptiness", () => {
    const tc = (id: string) => [{ id, type: "function" as const, function: { name: "f", arguments: "{}" } }];

    it("openai wire: blank reasoning_content counts as present — no chronic noise", () => {
        const c = collector();
        warnReasoningPairs([
            { role: "assistant", content: "a1", reasoning_content: "think" },
            { role: "assistant", content: "", tool_calls: tc("c1"), reasoning_content: "" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("openai wire: all-blank thinking session stays silent", () => {
        const c = collector();
        warnReasoningPairs([
            { role: "assistant", content: "", tool_calls: tc("c1"), reasoning_content: "" },
            { role: "assistant", content: "", tool_calls: tc("c2"), reasoning_content: "" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("openai wire: absent field still warns while a sibling carries any echo", () => {
        const c = collector();
        warnReasoningPairs([
            { role: "assistant", content: "", tool_calls: tc("c1"), reasoning_content: "" },
            { role: "assistant", content: "", tool_calls: tc("c2") },
        ], c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /reasoning-pair-violated/);
    });

    it("openai wire: no echoes at all stays silent (non-thinking session)", () => {
        const c = collector();
        warnReasoningPairs([
            { role: "assistant", content: "", tool_calls: tc("c1") },
            { role: "assistant", content: "", tool_calls: tc("c2") },
        ], c.log, "s1");
        assert.equal(c.lines.length, 0);
    });
});

describe("#762 strict-echo normalization", () => {
    const tc = (id: string) => ({ id, type: "function" as const, function: { name: "f", arguments: "{}" } });

    it("disabled: returns the input array untouched", () => {
        const msgs: OpenAIMessage[] = [
            { role: "user", content: "u" },
            { role: "assistant", content: "", tool_calls: [tc("c1")] },
        ];
        const c = collector();
        assert.equal(normalizeStrictEchoReasoning(msgs, false, c.log, "s1"), msgs);
        assert.equal(c.lines.length, 0);
    });

    it("enabled: injects blank rc only on assistant tool-call messages lacking the field", () => {
        const user: OpenAIMessage = { role: "user", content: "u" };
        const tool: OpenAIMessage = { role: "tool", tool_call_id: "c1", content: "r" };
        const textOnly: OpenAIMessage = { role: "assistant", content: "a" };
        const blank: OpenAIMessage = { role: "assistant", content: "", tool_calls: [tc("c1")], reasoning_content: "" };
        const full: OpenAIMessage = { role: "assistant", content: "a", tool_calls: [tc("c2")], reasoning_content: "think" };
        const missing: OpenAIMessage = { role: "assistant", content: "", tool_calls: [tc("c3")] };
        const input = [user, tool, textOnly, blank, full, missing];
        const c = collector();
        const out = normalizeStrictEchoReasoning(input, true, c.log, "s1");
        assert.notEqual(out, input);
        assert.equal(out[0], user);
        assert.equal(out[1], tool);
        assert.equal(out[2], textOnly);
        assert.equal(out[3], blank);
        assert.equal(out[4], full);
        assert.notEqual(out[5], missing);
        assert.deepEqual(out[5]!.tool_calls, [tc("c3")]);
        assert.equal(out[5]!.reasoning_content, "");
        assert.equal(missing.reasoning_content, undefined);
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /injected blank reasoning_content on 1 assistant tool-call message/);
    });

    it("enabled: nothing to patch returns the input array unchanged", () => {
        const msgs: OpenAIMessage[] = [
            { role: "assistant", content: "", tool_calls: [tc("c1")], reasoning_content: "" },
        ];
        const c = collector();
        assert.equal(normalizeStrictEchoReasoning(msgs, true, c.log, "s1"), msgs);
        assert.equal(c.lines.length, 0);
    });
});

describe("#762 strict-echo body normalization (loop re-request path)", () => {
    it("disabled: returns the same body object", () => {
        const body = { model: "m", messages: [{ role: "assistant" as const, content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "compress", arguments: "{}" } }] }] };
        const c = collector();
        assert.equal(normalizeStrictEchoBody(body, false, c.log, "s1"), body);
        assert.equal(c.lines.length, 0);
    });

    it("no messages array (Responses-shaped body): returns the same body object", () => {
        const body = { model: "m", input: [] };
        const c = collector();
        assert.equal(normalizeStrictEchoBody(body, true, c.log, "s1"), body);
        assert.equal(c.lines.length, 0);
    });

    it("enabled: patches missing fields, preserves every other key, no mutation", () => {
        const tcCall = { id: "c1", type: "function", function: { name: "compress", arguments: "{}" } };
        const body = {
            model: "m",
            stream: true,
            messages: [
                { role: "user" as const, content: "u" },
                { role: "assistant" as const, content: "", tool_calls: [tcCall] },
            ],
        };
        const c = collector();
        const out = normalizeStrictEchoBody(body, true, c.log, "s1");
        assert.notEqual(out, body);
        assert.equal(out.model, "m");
        assert.equal(out.stream, true);
        const outMsgs = out.messages as Record<string, unknown>[];
        assert.equal(outMsgs[0], body.messages[0]);
        assert.notEqual(outMsgs[1], body.messages[1]);
        assert.deepEqual(outMsgs[1]!.tool_calls, [tcCall]);
        assert.equal(outMsgs[1]!.reasoning_content, "");
        assert.equal((body.messages[1] as Record<string, unknown>).reasoning_content, undefined);
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /injected blank reasoning_content on 1 assistant tool-call message/);
    });

    it("enabled: nothing to patch returns the same body object", () => {
        const body = { model: "m", messages: [{ role: "assistant" as const, content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "compress", arguments: "{}" } }], reasoning_content: "" }] };
        const c = collector();
        assert.equal(normalizeStrictEchoBody(body, true, c.log, "s1"), body);
        assert.equal(c.lines.length, 0);
    });
});
