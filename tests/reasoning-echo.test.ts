import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isStrictReasoningEcho, warnReasoningPairs, warnAnthropicThinkingPairs, warnResponsesReasoningPairs } from "../src/server.js";
import type { Session } from "../src/session.js";
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

    it("anthropic wire: tool_use without thinking warns", () => {
        const c = collector();
        warnAnthropicThinkingPairs([
            { role: "assistant", content: [{ type: "thinking", thinking: "t" }] },
            { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "n", input: {} }] },
        ], c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /thinking-pair-violated/);
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
