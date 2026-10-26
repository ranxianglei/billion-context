import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

// #2308: the Responses summary extractor must read ONLY the assistant message
// body. A summary response carrying both a `reasoning` item and the final
// `message` used to concatenate every item's content[].text, so the model's
// thinking leaked into the saved summary (a real-world response carried
// 12,341 chars of reasoning_text alongside 7,054 of output_text). Both entry
// shapes are pinned here: the JSON branch and the SSE terminals
// (response.completed / response.output_item.done) share extractSummaryText.
//
// Contract: an explicitly declared type is authoritative — only `message`
// items and their `output_text` parts are summary body; reasoning-family
// items/parts (reasoning/reasoning_text, summary_text, ...) never leak in.
// Typeless shapes stay accepted for gateways that omit `type`, and the
// top-level output_text compat form is untouched. A reasoning-only response
// yields "" so requestSummary routes it into the existing unusable-summary
// diagnosis chain (#726/#727) instead of persisting thinking as a summary.

import { extractSummaryFromSse, extractSummaryText } from "../src/preflight.ts";

const THOUGHT = "REASONING_MUST_NOT_BE_SAVED. ".repeat(50);
const FINAL = "FINAL SUMMARY: keep the completed changes, outstanding checks, and next action.";

const reasoningItem = { type: "reasoning", id: "rs_1", content: [{ type: "reasoning_text", text: THOUGHT }] };
const messageItem = (text: string): Record<string, unknown> => ({
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
});

const completedSse = (output: unknown[]): string =>
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output } })}\n\n`;

test("#2308 JSON: reasoning + message → only the final body", () => {
    assert.equal(extractSummaryText("responses", { status: "completed", output: [reasoningItem, messageItem(FINAL)] }), FINAL);
});

test("#2308 JSON: reasoning-only → empty (unusable-summary path)", () => {
    assert.equal(extractSummaryText("responses", { status: "completed", output: [reasoningItem] }), "");
});

test("#2308 JSON: typeless gateway shapes are still extracted", () => {
    assert.equal(extractSummaryText("responses", { output: [{ role: "assistant", content: [{ text: FINAL }] }] }), FINAL);
});

test("#2308 JSON: top-level output_text compat wins as before", () => {
    assert.equal(extractSummaryText("responses", { output_text: FINAL, output: [reasoningItem] }), FINAL);
});

test("#2308 JSON: message items concatenate; explicit non-message item types excluded", () => {
    const resp = {
        output: [
            reasoningItem,
            messageItem("part one "),
            { type: "function_call", id: "fc_1", call_id: "call_1", name: "noop", arguments: "{\"x\":1}" },
            messageItem("part two"),
        ],
    };
    assert.equal(extractSummaryText("responses", resp), "part one part two");
});

test("#2308 JSON: an explicit non-output part type inside a typeless item is excluded", () => {
    assert.equal(
        extractSummaryText("responses", { output: [{ content: [{ type: "summary_text", text: THOUGHT }, { text: FINAL }] }] }),
        FINAL,
    );
});

test("#2308 SSE: reasoning + message in response.completed → only the final body", () => {
    assert.equal(extractSummaryFromSse("responses", completedSse([reasoningItem, messageItem(FINAL)])), FINAL);
});

test("#2308 SSE: item.done carrying a reasoning item leaks nothing", () => {
    const wire =
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: reasoningItem })}\n\n` +
        completedSse([]);
    assert.equal(extractSummaryFromSse("responses", wire), "");
});

test("#2308 SSE: valid deltas survive when completed carries only reasoning", () => {
    const delta = (t: string): string => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: t })}\n\n`;
    assert.equal(extractSummaryFromSse("responses", delta("deltas ") + delta("win") + completedSse([reasoningItem])), "deltas win");
});

test("#2308 SSE: reasoning-only stream without deltas → empty", () => {
    assert.equal(extractSummaryFromSse("responses", completedSse([reasoningItem])), "");
});
