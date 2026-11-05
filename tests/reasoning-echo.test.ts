import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { _resetReasoningViolationReportsForTest, isStrictReasoningEcho, normalizeStrictEchoReasoning, warnReasoningPairs, warnAnthropicThinkingPairs, warnResponsesReasoningPairs, withReasoningDrop } from "../src/server.js";
import { modelIdOf, normalizeStrictEchoBody, normalizeStrictEchoResponsesInput } from "../src/strict-echo.js";
import { dropCompressReasoning } from "../src/reasoning-drop.js";
import type { Session } from "../src/session.js";
import { anthropicToCore, coreToAnthropic, type AnthropicMessage, type BiliMessage } from "acp-kernel/wire";
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
    beforeEach(() => _resetReasoningViolationReportsForTest());

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

    it("#1479 responses wire: healthy [reasoning, message, function_call] run stays silent (was chronic false positive)", () => {
        const c = collector();
        warnResponsesReasoningPairs([
            { type: "message", role: "user", content: "u" },
            { type: "reasoning", summary: [{ type: "summary_text", text: "r" }] },
            { type: "message", role: "assistant", content: "a" },
            { type: "function_call", name: "compress", arguments: "{}", call_id: "c1" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("#1479 responses wire: multi-call run with one leading reasoning stays silent", () => {
        const c = collector();
        warnResponsesReasoningPairs([
            { type: "reasoning", summary: [{ type: "summary_text", text: "r" }] },
            { type: "function_call", name: "f1", arguments: "{}", call_id: "c1" },
            { type: "function_call_output", call_id: "c1", output: "ok" },
            { type: "function_call", name: "f2", arguments: "{}", call_id: "c2" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("#1479 responses wire: interleaved custom_tool_call_output stays in the run (canary/repair/WC-009 parity)", () => {
        const c = collector();
        warnResponsesReasoningPairs([
            { type: "reasoning", summary: [{ type: "summary_text", text: "r" }] },
            { type: "function_call", name: "f1", arguments: "{}", call_id: "c1" },
            { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
            { type: "function_call", name: "f2", arguments: "{}", call_id: "c2" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("#1479 responses wire: orphaned run warns and names the orphaned call_id", () => {
        const c = collector();
        warnResponsesReasoningPairs([
            { type: "reasoning", summary: [{ type: "summary_text", text: "r" }] },
            { type: "message", role: "assistant", content: "a" },
            { type: "message", role: "user", content: "u2" },
            { type: "function_call", name: "compress", arguments: "{}", call_id: "c-orphan" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /reasoning-pair-violated/);
        assert.match(c.lines[0]!, /c-orphan/);
    });

    it("#1479 responses wire: two orphaned runs count every call in both", () => {
        const c = collector();
        warnResponsesReasoningPairs([
            { type: "reasoning", summary: [{ type: "summary_text", text: "r" }] },
            { type: "message", role: "assistant", content: "a" },
            { type: "message", role: "user", content: "u2" },
            { type: "function_call", name: "f1", arguments: "{}", call_id: "c1" },
            { type: "function_call", name: "f2", arguments: "{}", call_id: "c2" },
            { type: "message", role: "user", content: "u3" },
            { type: "custom_tool_call", name: "compress", arguments: "{}", call_id: "c3" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /3 tool-call item\(s\) in 2 assistant run\(s\)/);
        assert.match(c.lines[0]!, /c1/);
        assert.match(c.lines[0]!, /c2/);
        assert.match(c.lines[0]!, /c3/);
    });

    it("#1479 responses wire: non-thinking session (no reasoning anywhere) stays silent", () => {
        const c = collector();
        warnResponsesReasoningPairs([
            { type: "message", role: "user", content: "u" },
            { type: "function_call", name: "f1", arguments: "{}", call_id: "c1" },
            { type: "function_call_output", call_id: "c1", output: "ok" },
            { type: "function_call", name: "f2", arguments: "{}", call_id: "c2" },
        ], c.log, "s1");
        assert.equal(c.lines.length, 0);
    });
});

describe("#1479 responses-wire strict-echo repair", () => {
    function items(): Record<string, unknown>[] {
        return [
            { type: "message", role: "user", content: "what is the weather" },
            { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "thinking about it" }] },
            { type: "message", role: "assistant", content: "let me check" },
            { type: "message", role: "user", content: "and tomorrow?" },
            { type: "function_call", id: "fc-c1", call_id: "call-c1", name: "get_weather", arguments: "{}" },
            { type: "function_call_output", call_id: "call-c1", output: "sunny" },
            { type: "message", role: "assistant", content: "sunny tomorrow too" },
        ];
    }

    it("disabled: returns the same array untouched", () => {
        const input = items();
        const c = collector();
        assert.equal(normalizeStrictEchoResponsesInput(input as never, false, c.log, "s1"), input);
        assert.equal(c.lines.length, 0);
    });

    it("non-thinking session (no reasoning item anywhere): returns the same array", () => {
        const input = items().filter((it) => it.type !== "reasoning");
        const c = collector();
        assert.equal(normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1"), input);
        assert.equal(c.lines.length, 0);
    });

    it("healthy run order: returns the same array, no log", () => {
        const input: Record<string, unknown>[] = [
            { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "t" }] },
            { type: "message", role: "assistant", content: "a" },
            { type: "function_call", id: "fc-1", call_id: "c1", name: "f", arguments: "{}" },
        ];
        const c = collector();
        assert.equal(normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1"), input);
        assert.equal(c.lines.length, 0);
    });

    it("interleaved custom_tool_call_output stays in the run: no false orphan split (inRun completeness)", () => {
        const input: Record<string, unknown>[] = [
            { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "t" }] },
            { type: "function_call", id: "fc-1", call_id: "c1", name: "f", arguments: "{}" },
            { type: "custom_tool_call_output", id: "co-1", call_id: "c1", output: "ok" },
            { type: "function_call", id: "fc-2", call_id: "c2", name: "g", arguments: "{}" },
        ];
        const c = collector();
        assert.equal(normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1"), input);
        assert.equal(c.lines.length, 0);
    });

    it("orphaned run: injects exactly one blank reasoning at the run start, preserves everything else, no mutation", () => {
        const input = items();
        const c = collector();
        const out = normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1");
        assert.notEqual(out, input);
        assert.equal(out.length, input.length + 1);
        const fcIdx = out.findIndex((it) => it.type === "function_call");
        assert.deepEqual(out[fcIdx - 1], { type: "reasoning", summary: [{ type: "summary_text", text: "" }] });
        let k = 0;
        for (let i = 0; i < out.length; i++) {
            if (i === fcIdx - 1) continue;
            assert.equal(out[i], input[k++]);
        }
        assert.deepEqual(out.find((it) => it.id === "rs-1"), input.find((it) => it.id === "rs-1"));
        assert.equal(input.length, 7);
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /strict-echo-responses: injected 1 blank reasoning item\(s\)/);
        assert.match(c.lines[0]!, /\(#1479\)/);
    });

    it("multiple orphaned runs: one blank per run", () => {
        const input: Record<string, unknown>[] = [
            { type: "reasoning", id: "rs-1", summary: [{ type: "summary_text", text: "t" }] },
            { type: "message", role: "assistant", content: "a" },
            { type: "message", role: "user", content: "u2" },
            { type: "function_call", id: "fc-1", call_id: "c1", name: "f1", arguments: "{}" },
            { type: "message", role: "user", content: "u3" },
            { type: "custom_tool_call", id: "ct-1", call_id: "c2", name: "compress", arguments: "{}" },
        ];
        const c = collector();
        const out = normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1");
        assert.equal(out.length, input.length + 2);
        assert.match(c.lines[0]!, /injected 2 blank reasoning item\(s\)/);
        const blanks = out.filter((it) => it.type === "reasoning" && JSON.stringify(it.summary) === JSON.stringify([{ type: "summary_text", text: "" }]));
        assert.equal(blanks.length, 2);
    });

    it("normalizeStrictEchoBody patches Responses input[] bodies (the loop re-request path)", () => {
        const body = { model: "m", stream: true, input: items() };
        const c = collector();
        const out = normalizeStrictEchoBody(body, true, c.log, "s1");
        assert.notEqual(out, body);
        assert.equal(out.model, "m");
        assert.equal(out.stream, true);
        const outInput = out.input as Record<string, unknown>[];
        assert.equal(outInput.length, (body.input as unknown[]).length + 1);
        const fcIdx = outInput.findIndex((it) => it.type === "function_call");
        assert.deepEqual(outInput[fcIdx - 1], { type: "reasoning", summary: [{ type: "summary_text", text: "" }] });
        assert.match(c.lines[0]!, /strict-echo-responses/);
    });

    it("normalizeStrictEchoBody: chat messages[] and Responses input[] still each handled independently", () => {
        const body = {
            model: "m",
            messages: [{ role: "assistant" as const, content: "", tool_calls: [{ id: "c1", type: "function" as const, function: { name: "f", arguments: "{}" } }] }],
            input: items(),
        };
        const c = collector();
        const out = normalizeStrictEchoBody(body, true, c.log, "s1");
        assert.notEqual(out, body);
        assert.equal((out.messages as Record<string, unknown>[])[0].reasoning_content, "");
        assert.equal((out.input as Record<string, unknown>[]).length, (body.input as unknown[]).length + 1);
    });
});

describe("#2169 responses-wire blank reasoning content sanitize", () => {
    const BLANK_PARTS = [{ type: "reasoning_text", text: " " }];

    it("enabled: clears whitespace-only content, keeps every other key, no mutation of the input item", () => {
        const blank = { type: "reasoning", id: "rs-blank", content: BLANK_PARTS, summary: [{ type: "summary_text", text: "" }] };
        const input = [
            { type: "message", role: "user", content: "u" },
            blank,
            { type: "function_call", id: "fc-1", call_id: "c1", name: "f", arguments: "{}" },
        ];
        const c = collector();
        const out = normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1");
        assert.notEqual(out, input);
        assert.equal(out.length, input.length);
        const r = out[1]!;
        assert.notEqual(r, blank);
        assert.equal(r.type, "reasoning");
        assert.equal(r.id, "rs-blank");
        assert.equal("content" in r, false);
        assert.deepEqual(r.summary, [{ type: "summary_text", text: "" }]);
        assert.equal("content" in blank, true, "input item must not be mutated in place");
        assert.equal(out[0], input[0]);
        assert.equal(out[2], input[2]);
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /cleared whitespace-only reasoning content on 1 item\(s\)/);
        assert.match(c.lines[0]!, /\(#2169\)/);
    });

    it("enabled: multiple whitespace parts all blank → cleared once per item", () => {
        const two = { type: "reasoning", id: "rs-2", content: [{ type: "reasoning_text", text: " " }, { type: "reasoning_text", text: "\t\n" }] };
        const input = [two];
        const c = collector();
        const out = normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1");
        assert.notEqual(out, input);
        assert.equal("content" in out[0]!, false);
        assert.match(c.lines[0]!, /cleared whitespace-only reasoning content on 1 item\(s\)/);
    });

    it("enabled: non-blank content stays byte-exact (same reference, no log)", () => {
        const real = { type: "reasoning", id: "rs-1", content: [{ type: "reasoning_text", text: "encrypted blob" }], summary: [{ type: "summary_text", text: "s" }] };
        const input = [real];
        const c = collector();
        assert.equal(normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1"), input);
        assert.equal(c.lines.length, 0);
    });

    it("enabled: mixed parts (one with real text) stay untouched", () => {
        const mixed = { type: "reasoning", id: "rs-mix", content: [{ type: "reasoning_text", text: " " }, { type: "reasoning_text", text: "real" }] };
        const input = [mixed];
        const c = collector();
        assert.equal(normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1"), input);
        assert.equal(c.lines.length, 0);
    });

    it("enabled: unknown part shapes stay untouched (empty array / missing text / non-string text / foreign part type / null)", () => {
        for (const content of [
            [],
            [{ type: "reasoning_text" }],
            [{ type: "reasoning_text", text: 42 }],
            [{ type: "other_part", text: "x" }],
            [null],
        ]) {
            const input = [{ type: "reasoning", id: "rs-x", content, summary: [] }];
            const c = collector();
            assert.equal(normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1"), input, JSON.stringify(content));
            assert.equal(c.lines.length, 0);
        }
    });

    it("disabled: blank content passes through untouched", () => {
        const blank = { type: "reasoning", id: "rs-blank", content: BLANK_PARTS };
        const input = [blank];
        const c = collector();
        assert.equal(normalizeStrictEchoResponsesInput(input as never, false, c.log, "s1"), input);
        assert.equal(c.lines.length, 0);
    });

    it("combined: orphaned run (later turn) + blank-content item (earlier turn) → both repairs, both logs, order preserved", () => {
        const blank = { type: "reasoning", id: "rs-blank", content: BLANK_PARTS, summary: [{ type: "summary_text", text: "" }] };
        const input = [
            { type: "message", role: "user", content: "u" },
            blank,
            { type: "message", role: "assistant", content: "a" },
            { type: "message", role: "user", content: "u2" },
            { type: "function_call", id: "fc-1", call_id: "c1", name: "f", arguments: "{}" },
        ];
        const c = collector();
        const out = normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1");
        assert.equal(out.length, input.length + 1);
        assert.equal("content" in out[1]!, false, "blank item sanitized at its position");
        const fcIdx = out.findIndex((it) => it.type === "function_call");
        assert.deepEqual(out[fcIdx - 1], { type: "reasoning", summary: [{ type: "summary_text", text: "" }] });
        assert.equal(c.lines.length, 2);
        assert.match(c.lines[0]!, /cleared whitespace-only reasoning content on 1 item\(s\)/);
        assert.match(c.lines[1]!, /injected 1 blank reasoning item\(s\)/);
    });

    it("normalizeStrictEchoBody: Responses body carrying a blank-content item is sanitized", () => {
        const blank = { type: "reasoning", id: "rs-blank", content: BLANK_PARTS, summary: [] };
        const body = { model: "m", input: [blank] };
        const c = collector();
        const out = normalizeStrictEchoBody(body, true, c.log, "s1");
        assert.notEqual(out, body);
        const outInput = out.input as Record<string, unknown>[];
        assert.equal("content" in outInput[0]!, false);
        assert.equal("content" in blank, true, "no mutation of the inbound body");
    });

    // Provenance: redacted real-world outbound body from #2169 (issue author's gist).
    // All text except the 5 blank echoes below is length placeholders; order/types/call_ids unchanged.
    it("redacted #2169 body (89 items): the 5 blank echoes are cleared, everything else stays byte-exact, no injection needed", () => {
        const raw = readFileSync(fileURLToPath(new URL("./fixtures/responses-2169-redacted-input.json", import.meta.url)), "utf-8");
        const input = JSON.parse(raw) as Record<string, unknown>[];
        assert.equal(input.length, 89);
        const BLANK_IDX = [30, 52, 64, 70, 86];
        for (const i of BLANK_IDX) {
            const content = (input[i]! as { content?: unknown }).content;
            assert.ok(Array.isArray(content) && content.length > 0, `fixture item ${i} must start with whitespace content`);
        }
        const c = collector();
        const out = normalizeStrictEchoResponsesInput(input as never, true, c.log, "s1");
        assert.notEqual(out, input);
        assert.equal(out.length, 89, "this body has no orphaned run → no #1479 injection");
        for (const i of BLANK_IDX) {
            const r = out[i]! as Record<string, unknown>;
            assert.notEqual(r, input[i]!, `blank item ${i} replaced by a copy`);
            assert.equal(r.type, "reasoning");
            assert.equal("content" in r, false, `blank item ${i} content removed`);
            assert.deepEqual(r.summary, [{ type: "summary_text", text: "" }]);
            assert.equal("content" in (input[i]! as Record<string, unknown>), true, "inbound item unmutated");
        }
        for (let i = 0; i < input.length; i++) {
            if (BLANK_IDX.includes(i)) continue;
            assert.equal(out[i], input[i], `non-blank item ${i} stays the same reference`);
        }
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /cleared whitespace-only reasoning content on 5 item\(s\)/);
    });
});

describe("#762 sentinel precision: presence, not emptiness", () => {
    beforeEach(() => _resetReasoningViolationReportsForTest());

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

describe("#1658 anthropic signed-thinking gate (#651 drop vs #684 pair invariant)", () => {
    beforeEach(() => _resetReasoningViolationReportsForTest());

    const SIGNED = (text = "x".repeat(3000), id = "r"): BiliMessage => ({ id, role: "assistant", contentType: "reasoning", text, thinkingSignature: "sig_test_123" });
    const CALL = (toolName = "compress", toolCallId = "t1"): BiliMessage => ({ id: "c", role: "assistant", contentType: "tool-call", toolName, toolCallId, text: "{}" });
    const RESULT = (toolCallId = "t1"): BiliMessage => ({ id: "res", role: "user", contentType: "tool-result", toolName: "compress", toolCallId, text: "ok" });
    const USER = (text = "next"): BiliMessage => ({ id: "u", role: "user", contentType: "text", text });

    it("signed thinking in view disables the #651 drop even without strictEcho", () => {
        const msgs = [SIGNED(), CALL(), RESULT(), USER()];
        const c = collector();
        assert.equal(withReasoningDrop(msgs, undefined, c.log, "s1", false), msgs);
        assert.equal(c.lines.length, 0);
    });

    it("unsigned reasoning still drops (non-thinking claude sessions keep #651)", () => {
        const msgs: BiliMessage[] = [{ id: "r", role: "assistant", contentType: "reasoning", text: "x".repeat(3000) }, CALL(), RESULT(), USER()];
        const c = collector();
        const out = withReasoningDrop(msgs, undefined, c.log, "s1", false);
        assert.equal(out.length, 3);
        assert.ok(!out.some((m) => m.contentType === "reasoning"));
        assert.equal(c.lines.length, 1);
    });

    it("redacted_thinking in view disables the #651 drop (#1960)", () => {
        // The redacted carrier must sit BEFORE the reasoning run: coreToAnthropic merges same-role messages into one assistant message, so dropping the run rewrites the message carrying the redacted block. Placed after the run it would break contiguity and the drop never fires at all (test would pass without the fix).
        const redacted: BiliMessage = { id: "rd", role: "assistant", contentType: "text", text: "[redacted_thinking]", rawAnthropicBlock: { type: "redacted_thinking", data: "ZGF0YQ==" } };
        const msgs: BiliMessage[] = [redacted, { id: "r", role: "assistant", contentType: "reasoning", text: "x".repeat(3000) }, CALL(), RESULT(), USER()];
        const c = collector();
        assert.equal(withReasoningDrop(msgs, undefined, c.log, "s1", false), msgs);
        assert.equal(c.lines.length, 0);
    });

    const reproInboundRedacted: AnthropicMessage[] = [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "ZGF0YQ==" }, { type: "thinking", thinking: "x".repeat(3000) }, { type: "tool_use", id: "tu1", name: "compress", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
        { role: "user", content: "next" },
    ];

    it("regression: unsigned thinking beside a redacted block no longer drops (#1960 wire shape)", () => {
        const { msgs } = anthropicToCore({ model: "claude-opus-4-5", messages: reproInboundRedacted });
        assert.ok(msgs.some((m) => m.rawAnthropicBlock !== undefined && (m.rawAnthropicBlock as { type?: string }).type === "redacted_thinking"));
        const c = collector();
        const out = withReasoningDrop(msgs, undefined, c.log, "s1", false);
        assert.equal(out, msgs);
        assert.equal(c.lines.length, 0);
        const outbound = coreToAnthropic(out);
        const assistantOut = outbound[1]!;
        assert.ok(Array.isArray(assistantOut.content));
        assert.equal(assistantOut.content.length, 3);
    });

    it("empty-string signature does not arm the gate", () => {
        const msgs: BiliMessage[] = [{ id: "r", role: "assistant", contentType: "reasoning", text: "x".repeat(3000), thinkingSignature: "" }, CALL(), RESULT(), USER()];
        const c = collector();
        const out = withReasoningDrop(msgs, undefined, c.log, "s1", false);
        assert.equal(out.length, 3);
        assert.ok(!out.some((m) => m.contentType === "reasoning"));
    });

    const reproInbound: AnthropicMessage[] = [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(3000), signature: "sig_test_123" }, { type: "tool_use", id: "tu1", name: "compress", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
        { role: "user", content: "next" },
    ];

    it("regression: reported repro shape no longer trips the sentinel", () => {
        const { msgs } = anthropicToCore({ model: "claude-opus-4-5", messages: reproInbound });
        assert.ok(msgs.some((m) => m.contentType === "reasoning" && m.thinkingSignature === "sig_test_123"));
        const c = collector();
        const dropped = withReasoningDrop(msgs, undefined, c.log, "s1", false);
        assert.equal(dropped, msgs);
        const outbound = coreToAnthropic(dropped);
        warnAnthropicThinkingPairs(reproInbound, outbound, c.log, "s1");
        assert.equal(c.lines.length, 0);
    });

    it("negative control: dropping the run by hand still trips the sentinel (test has teeth)", () => {
        const { msgs } = anthropicToCore({ model: "claude-opus-4-5", messages: reproInbound });
        const manualDrop = dropCompressReasoning(msgs);
        assert.ok(manualDrop.length < msgs.length);
        const c = collector();
        warnAnthropicThinkingPairs(reproInbound, coreToAnthropic(manualDrop), c.log, "s1");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /thinking-pair-violated/);
    });
});

describe("#2864 sentinel dedup: per-identity episode reporting", () => {
    beforeEach(() => _resetReasoningViolationReportsForTest());

    const tc = (id: string) => ({ id, type: "function" as const, function: { name: "f", arguments: "{}" } });
    const openaiHistory = (extraViolators: string[] = []) => [
        { role: "assistant", content: "a1", reasoning_content: "think" },
        { role: "assistant", content: "", tool_calls: [tc("c1")] },
        ...extraViolators.map((id) => ({ role: "assistant", content: "", tool_calls: [tc(id)] })),
    ];

    it("the same persistent violation across 100 repeated requests warns exactly once", () => {
        const c = collector();
        for (let i = 0; i < 100; i++) warnReasoningPairs(openaiHistory(), c.log, "s-dedup");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /reasoning-pair-violated/);
        assert.match(c.lines[0]!, /first seen: c1/);
    });

    it("a newly appearing violator warns again, naming only the new identity, with the repeat count of the ongoing one", () => {
        const c = collector();
        warnReasoningPairs(openaiHistory(), c.log, "s-dedup");
        warnReasoningPairs(openaiHistory(["c2"]), c.log, "s-dedup");
        warnReasoningPairs(openaiHistory(["c2"]), c.log, "s-dedup");
        assert.equal(c.lines.length, 2);
        assert.match(c.lines[1]!, /first seen: c2/);
        assert.doesNotMatch(c.lines[1]!, /first seen: c1/);
        assert.match(c.lines[1]!, /; 1 already reported \(up to ×2 repeats\)/);
        assert.match(c.lines[1]!, /\(window: since this proxy started\)/);
    });

    it("concurrent sessions do not suppress each other", () => {
        const cA = collector();
        const cB = collector();
        warnReasoningPairs(openaiHistory(), cA.log, "sA");
        warnReasoningPairs(openaiHistory(), cB.log, "sB");
        warnReasoningPairs(openaiHistory(), cA.log, "sA");
        warnReasoningPairs(openaiHistory(), cB.log, "sB");
        assert.equal(cA.lines.length, 1);
        assert.equal(cB.lines.length, 1);
    });

    it("wires are independent trackers even for the same session and ids", () => {
        const cO = collector();
        const cR = collector();
        warnReasoningPairs(openaiHistory(), cO.log, "sX");
        warnResponsesReasoningPairs([
            { type: "reasoning", summary: [{ type: "summary_text", text: "r" }] },
            { type: "message", role: "assistant", content: "a" },
            { type: "message", role: "user", content: "u2" },
            { type: "function_call", name: "f", arguments: "{}", call_id: "c1" },
        ], cR.log, "sX");
        assert.equal(cO.lines.length, 1);
        assert.equal(cR.lines.length, 1);
    });

    it("a recovered message that violates again reports a new episode", () => {
        const healed = [
            { role: "assistant", content: "a1", reasoning_content: "think" },
            { role: "assistant", content: "", tool_calls: [tc("c1")], reasoning_content: "" },
        ];
        const c = collector();
        warnReasoningPairs(openaiHistory(), c.log, "s-dedup");
        warnReasoningPairs(healed, c.log, "s-dedup");
        warnReasoningPairs(healed, c.log, "s-dedup");
        warnReasoningPairs(openaiHistory(), c.log, "s-dedup");
        assert.equal(c.lines.length, 2);
        assert.match(c.lines[1]!, /re-violating after recovery/);
        assert.match(c.lines[1]!, /first seen: c1/);
    });

    it("anthropic wire: repeated loss of the same tool_use warns once; a new loss warns again", () => {
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
        const c = collector();
        warnAnthropicThinkingPairs(inbound, outbound, c.log, "s-dedup");
        warnAnthropicThinkingPairs(inbound, outbound, c.log, "s-dedup");
        assert.equal(c.lines.length, 1);
        assert.match(c.lines[0]!, /thinking-pair-violated/);
        assert.match(c.lines[0]!, /first seen: tu1/);

        const inbound2 = [
            ...inbound,
            { role: "assistant", content: [{ type: "thinking", thinking: "t2" }, { type: "tool_use", id: "tu2", name: "n", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "r" }] },
        ];
        const outbound2 = [
            ...outbound,
            { role: "assistant", content: [{ type: "tool_use", id: "tu2", name: "n", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2", content: "r" }] },
        ];
        warnAnthropicThinkingPairs(inbound2, outbound2, c.log, "s-dedup");
        assert.equal(c.lines.length, 2);
        assert.match(c.lines[1]!, /first seen: tu2/);
        assert.doesNotMatch(c.lines[1]!, /first seen: tu1/);
        assert.match(c.lines[1]!, /; 1 already reported \(up to ×3 repeats\)/);
    });
});
