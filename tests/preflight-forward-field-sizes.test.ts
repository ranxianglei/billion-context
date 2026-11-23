import { strict as assert } from "node:assert";
import { test } from "node:test";
import { formatForwardFieldSizes, PROMPT_BODY_KEYS } from "../src/preflight.js";

// #7589: per-top-level-field byte sizes for the forward log, so a body bloated
// by a non-prompt field (DSH's dsh_session_log) is attributable at a glance.

test("#7589 non-object bodies return null (nothing to break down)", () => {
    assert.equal(formatForwardFieldSizes(null, "anthropic"), null);
    assert.equal(formatForwardFieldSizes(undefined, "anthropic"), null);
    assert.equal(formatForwardFieldSizes("a string", "anthropic"), null);
    assert.equal(formatForwardFieldSizes(42, "anthropic"), null);
    assert.equal(formatForwardFieldSizes([1, 2, 3], "anthropic"), null);
});

test("#7589 empty object returns null", () => {
    assert.equal(formatForwardFieldSizes({}, "anthropic"), null);
});

test("#7589 anthropic: prompt fields unmarked, non-prompt fields marked", () => {
    const line = formatForwardFieldSizes({
        messages: "x".repeat(100),          // JSON.stringify → 102 bytes → 102B
        system: "y".repeat(100),            // 102B
        tools: [1, 2, 3],                   // [1,2,3] → 7B
        dsh_session_log: "z".repeat(100),   // 102B (non-prompt)
    }, "anthropic");
    assert.equal(line, "messages=102B, system=102B, tools=7B, dsh_session_log=102B (non-prompt)");
});

test("#7589 openai: 'system' is non-prompt (not in openai's prompt set)", () => {
    const line = formatForwardFieldSizes({
        messages: "x".repeat(100),
        system: "y".repeat(100),
    }, "openai");
    assert.equal(line, "messages=102B, system=102B (non-prompt)");
});

test("#7589 google: contents/systemInstruction/tools are prompt, rest non-prompt", () => {
    const line = formatForwardFieldSizes({
        contents: "x".repeat(100),
        systemInstruction: "y".repeat(100),
        tools: [1],
        metadata: "w".repeat(100),
    }, "google");
    assert.equal(line, "contents=102B, systemInstruction=102B, tools=3B, metadata=102B (non-prompt)");
});

test("#7589 responses: input/instructions/tools are prompt", () => {
    const line = formatForwardFieldSizes({
        input: "x".repeat(100),
        instructions: "y".repeat(100),
        tools: [1],
        metadata: "w".repeat(100),
    }, "responses");
    assert.equal(line, "input=102B, instructions=102B, tools=3B, metadata=102B (non-prompt)");
});

test("#7589 scalar and null field values stringify to their JSON form", () => {
    const line = formatForwardFieldSizes({
        count: 42,        // "42" → 2B
        flag: true,       // "true" → 4B
        nothing: null,    // "null" → 4B
    }, "anthropic");
    assert.equal(line, "count=2B (non-prompt), flag=4B (non-prompt), nothing=4B (non-prompt)");
});

test("#7589 field order follows Object.entries (insertion) order", () => {
    const line = formatForwardFieldSizes({ b: 1, a: 2 }, "anthropic");
    assert.equal(line, "b=1B (non-prompt), a=1B (non-prompt)");
});

test("#7589 larger fields use KiB/MiB units via formatBytes", () => {
    const line = formatForwardFieldSizes({
        messages: "x".repeat(2048),            // 2048 + 2 quotes = 2050 bytes → 2.0KiB
        dsh_session_log: "z".repeat(1024 * 1024),  // 1MiB + 2 = 1048578 bytes → 1.0MiB
    }, "anthropic");
    assert.equal(line, "messages=2.0KiB, dsh_session_log=1.0MiB (non-prompt)");
});

test("#7589 PROMPT_BODY_KEYS is the per-protocol prompt-field table", () => {
    assert.deepEqual([...PROMPT_BODY_KEYS.anthropic].sort(), ["messages", "system", "tools"]);
    assert.deepEqual([...PROMPT_BODY_KEYS.openai].sort(), ["messages", "tools"]);
    assert.deepEqual([...PROMPT_BODY_KEYS.responses].sort(), ["input", "instructions", "tools"]);
    assert.deepEqual([...PROMPT_BODY_KEYS.google].sort(), ["contents", "systemInstruction", "tools"]);
});
