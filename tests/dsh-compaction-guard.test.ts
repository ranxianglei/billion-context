import test from "node:test";
import assert from "node:assert/strict";
import {
    DSH_COMPACTION_INSTRUCTION_PREFIX,
    DSH_COMPACTION_MAX_MESSAGES,
    dshCompactionRefusal,
    isDshCompactionCall,
} from "../src/server/dsh-compaction-guard.ts";

// #1729: the guard must recognize dsh-compaction-basic's summarize envelope
// (replayed prefix + COMPACTION_INSTRUCTION as the final user message) and
// refuse it, while a normal multi-message turn — even one QUOTING the
// template — must pass untouched.

/** First line of the real COMPACTION_INSTRUCTION, verbatim from
 * @deepseek-ai/dsh-compaction-basic (tracked per dsh release). */
const INSTRUCTION =
    "You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.";

function openaiBody(messages: unknown[]) {
    return { model: "qwen-3.8-27b", messages, stream: true };
}

const giantPrefix = "x".repeat(600_000); // ~150K tokens of replayed prefix

test("identifies the observed production shape: 2-msg openai replay + directive", () => {
    const body = openaiBody([
        { role: "system", content: "you are dsh" },
        { role: "user", content: giantPrefix },
        { role: "user", content: INSTRUCTION },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 3), true);
});

test("identifies the collapsed shape: system + directive only", () => {
    const body = openaiBody([
        { role: "system", content: "you are dsh" },
        { role: "user", content: INSTRUCTION },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 2), true);
});

test("directive as content-parts array still matches", () => {
    const body = openaiBody([
        { role: "user", content: giantPrefix },
        { role: "user", content: [{ type: "text", text: "  " + INSTRUCTION }] },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 2), true);
});

test("multi-message turn quoting the template mid-history is NOT intercepted", () => {
    const msgs = Array.from({ length: 107 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `msg ${i}` }));
    msgs.push({ role: "user", content: INSTRUCTION });
    const body = openaiBody(msgs);
    assert.equal(isDshCompactionCall("openai", body, msgs.length), false);
});

test("message count above the shape bar is never intercepted", () => {
    const body = openaiBody([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: INSTRUCTION },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 5), false);
    assert.ok(5 > DSH_COMPACTION_MAX_MESSAGES);
});

test("directive text NOT at the head of the final user message is not intercepted", () => {
    const body = openaiBody([
        { role: "user", content: giantPrefix },
        { role: "user", content: `What does this template mean?\n\n${INSTRUCTION}` },
    ]);
    assert.equal(isDshCompactionCall("openai", body, 2), false);
});

test("anthropic messages shape is covered", () => {
    const body = { model: "m", system: "s", max_tokens: 8192, messages: [
        { role: "user", content: giantPrefix },
        { role: "user", content: [{ type: "text", text: INSTRUCTION }] },
    ] };
    assert.equal(isDshCompactionCall("anthropic", body, 2), true);
});

test("out-of-scope protocols and missing shapes never intercept", () => {
    const body = openaiBody([{ role: "user", content: INSTRUCTION }]);
    assert.equal(isDshCompactionCall("google", body, 1), false);
    assert.equal(isDshCompactionCall("responses", body, 1), false);
    assert.equal(isDshCompactionCall(null, body, 1), false);
    assert.equal(isDshCompactionCall("openai", { input: [{ type: "message", role: "user", content: INSTRUCTION }] }, null), false);
    assert.equal(isDshCompactionCall("openai", null, 1), false);
});

test("refusal bodies carry the marker reason and are non-retryable", () => {
    const openai = dshCompactionRefusal("openai") as { status: number; body: { error: { retryable: boolean; message: string } } };
    assert.equal(openai.status, 403);
    assert.equal(openai.body.error.retryable, false);
    assert.match(openai.body.error.message, /#1729/);
    const anthropic = dshCompactionRefusal("anthropic") as { status: number; body: { error: { message: string } } };
    assert.equal(anthropic.status, 403);
    assert.match(anthropic.body.error.message, /durably/);
});

test("the versioned marker prefix matches the live dsh template", () => {
    assert.ok(INSTRUCTION.startsWith(DSH_COMPACTION_INSTRUCTION_PREFIX));
});
