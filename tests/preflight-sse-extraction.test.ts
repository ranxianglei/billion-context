import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

// #780: validity contract of extractSummaryFromSse — a buffered SSE body either
// provably delivered a complete summary or it did not; anything less than proof
// yields "" so requestSummary routes it into diagnoseEmptySummary + the #726
// halving/cooldown chain instead of persisting a silent partial summary.

import { diagnoseEmptySummary, extractSummaryFromSse } from "../src/preflight.ts";

const R_DELTA = (delta: string): string => `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`;
const R_DONE = (text: string): string => `data: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_1", content_index: 0, text })}\n\n`;
const R_ITEM_DONE = (text: string): string =>
    `data: ${JSON.stringify({ type: "response.output_item.done", item_id: "msg_1", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}\n\n`;
const R_COMPLETED = (text?: string): string =>
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: text === undefined ? [] : [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
const A_DELTA = (text: string): string => `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`;
const O_DELTA = (content: string): string => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

test("#780 responses: complete stream, completed full text is authoritative", () => {
    assert.equal(extractSummaryFromSse("responses", R_DELTA("Hello ") + R_DELTA("world.") + R_COMPLETED("Hello world.")), "Hello world.");
});

test("#780 responses: completed with empty output falls back to accumulated deltas (#727 fixture shape)", () => {
    assert.equal(extractSummaryFromSse("responses", R_DELTA("part one ") + R_DELTA("part two") + R_COMPLETED()), "part one part two");
});

test("#780 responses: mid-frame truncation is rejected, not returned as a partial summary", () => {
    assert.equal(extractSummaryFromSse("responses", R_DELTA("Hello ") + 'data: {"type":"response.output_text.delta","del'), "");
});

test("#780 responses: clean framing without the mandatory completed terminal is rejected", () => {
    assert.equal(extractSummaryFromSse("responses", R_DELTA("a summary that ended cleanly but never said completed")), "");
});

test("#780 responses: delta-less terminals carry the text", () => {
    assert.equal(extractSummaryFromSse("responses", R_DONE("Done-only summary.") + R_COMPLETED("Done-only summary.")), "Done-only summary.");
    assert.equal(extractSummaryFromSse("responses", R_ITEM_DONE("Item-only summary.") + R_COMPLETED()), "Item-only summary.");
});

test("#780 responses: done + delta coexistence must not duplicate text", () => {
    assert.equal(extractSummaryFromSse("responses", R_DELTA("Shared ") + R_DELTA("text") + R_DONE("Shared text") + R_COMPLETED("Shared text")), "Shared text");
});

test("#780 responses: multiple output_text.done parts concatenate", () => {
    assert.equal(extractSummaryFromSse("responses", R_DONE("alpha ") + R_DONE("beta") + R_COMPLETED("alpha beta")), "alpha beta");
});

test("#780 responses: failure terminals invalidate previously accumulated text", () => {
    assert.equal(
        extractSummaryFromSse("responses", R_DELTA("partial ") + `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "boom", message: "nope" } } })}\n\n`),
        "",
    );
    assert.equal(
        extractSummaryFromSse("responses", R_DELTA("partial ") + `data: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete" } })}\n\n`),
        "",
    );
    assert.equal(
        extractSummaryFromSse("responses", R_DELTA("partial ") + `data: ${JSON.stringify({ type: "error", error: { message: "mid-stream" } })}\n\n`),
        "",
    );
    assert.equal(
        extractSummaryFromSse("responses", R_DELTA("partial ") + `data: ${JSON.stringify({ error: { message: "bare" } })}\n\n`),
        "",
    );
});

test("#780 responses: event: header types frames whose payload lacks a type field", () => {
    const body =
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "Header-" })}\n\n` +
        `event: response.completed\ndata: ${JSON.stringify({ response: { id: "resp_h", status: "completed", output: [{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "Header-typed" }] }] } })}\n\n`;
    assert.equal(extractSummaryFromSse("responses", body), "Header-typed");
});

test("#780 responses: event: header must not leak across frame boundaries", () => {
    const body =
        `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "REAL" })}\n\n` +
        `data: ${JSON.stringify({ delta: "LEAKED" })}\n\n` +
        R_COMPLETED();
    assert.equal(extractSummaryFromSse("responses", body), "REAL");
});

test("#780 responses: completed terminal is trusted despite corrupted bytes after it", () => {
    assert.equal(extractSummaryFromSse("responses", R_DELTA("Trust ") + R_DELTA("me") + R_COMPLETED("Trust me") + 'data: {"type":"response.output_text.delta","de'), "Trust me");
});

test("#780 anthropic: complete stream extracts text_deltas", () => {
    const body =
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1" } })}\n\n` +
        A_DELTA("Anthropic ") +
        A_DELTA("summary") +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
    assert.equal(extractSummaryFromSse("anthropic", body), "Anthropic summary");
});

test("#780 anthropic: mid-frame truncation is rejected", () => {
    assert.equal(extractSummaryFromSse("anthropic", A_DELTA("partial ") + 'data: {"type":"content_block_delta","delt'), "");
});

test("#780 anthropic: cleanly framed stream without message_stop is accepted (#764: gateways omit terminals occasionally)", () => {
    assert.equal(extractSummaryFromSse("anthropic", A_DELTA("lenient gateway text")), "lenient gateway text");
});

test("#780 anthropic: event: header types frames whose payload lacks a type field", () => {
    const body = `event: content_block_delta\ndata: ${JSON.stringify({ index: 0, delta: { type: "text_delta", text: "header-typed" } })}\n\n`;
    assert.equal(extractSummaryFromSse("anthropic", body), "header-typed");
});

test("#780 anthropic: event: header must not leak across frame boundaries", () => {
    const body =
        `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: "text_delta", text: "REAL" } })}\n\n` +
        `data: ${JSON.stringify({ delta: { type: "text_delta", text: "LEAKED" } })}\n\n`;
    assert.equal(extractSummaryFromSse("anthropic", body), "REAL");
});

test("#780 anthropic: in-stream error invalidates accumulated text", () => {
    const body = A_DELTA("partial ") + `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "try again" } })}\n\n`;
    assert.equal(extractSummaryFromSse("anthropic", body), "");
});

test("#780 openai: complete stream with finish_reason and [DONE]", () => {
    const body = O_DELTA("OpenAI ") + O_DELTA("summary") + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` + "data: [DONE]\n\n";
    assert.equal(extractSummaryFromSse("openai", body), "OpenAI summary");
});

test("#780 openai: missing finish_reason/[DONE] is tolerated when framing is clean (#764)", () => {
    assert.equal(extractSummaryFromSse("openai", O_DELTA("tolerated ") + O_DELTA("gateway text")), "tolerated gateway text");
});

test("#780 openai: mid-frame truncation is rejected", () => {
    assert.equal(extractSummaryFromSse("openai", O_DELTA("partial ") + 'data: {"choices":[{"index":0,"delta":{"conten'), "");
});

test("#780 openai: in-stream bare error object invalidates accumulated text", () => {
    const body = O_DELTA("partial ") + `data: ${JSON.stringify({ error: { message: "rate limited" } })}\n\n`;
    assert.equal(extractSummaryFromSse("openai", body), "");
});

// Gemini carries summary text in candidates[0].content.parts[].text, and a
// `thought:true` part is the model's reasoning rather than summary output, so
// it must not reach the summary. The wire reached production with no case here
// at all — every one of these shapes was unverified (#829).
const G_TEXT = (text: string, thought = false): string =>
    `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text, ...(thought ? { thought: true } : {}) }] }, finishReason: "STOP" }] })}\n\n`;

test("#780 google: text parts accumulate and thinking parts are skipped", () => {
    assert.equal(extractSummaryFromSse("google", G_TEXT("weighing the segment", true) + G_TEXT("the ") + G_TEXT("summary")), "the summary");
});

test("#780 google: cleanly framed stream without a finishReason is tolerated (#764)", () => {
    const bare = `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "lenient gemini text" }] } }] })}\n\n`;
    assert.equal(extractSummaryFromSse("google", bare), "lenient gemini text");
});

test("#780 google: mid-frame truncation is rejected", () => {
    assert.equal(extractSummaryFromSse("google", G_TEXT("partial ") + 'data: {"candidates":[{"content":{"parts":[{"tex'), "");
});

test("#780 google: in-stream error object invalidates accumulated text", () => {
    assert.equal(extractSummaryFromSse("google", G_TEXT("kept ") + `data: ${JSON.stringify({ error: { code: 429, message: "quota exceeded" } })}\n\n`), "");
});

test("#780 CRLF-framed bodies are accepted", () => {
    const lf = R_DELTA("crlf ") + R_DELTA("ok") + R_COMPLETED("crlf ok");
    assert.equal(extractSummaryFromSse("responses", lf.replace(/\n/g, "\r\n")), "crlf ok");
});

test("#780 diagnoseEmptySummary names truncation explicitly", () => {
    assert.match(
        diagnoseEmptySummary('data: {"type":"response.output_text.delta","del'),
        /incomplete data line\(s\) and no parseable events \(stream appears truncated\)/,
    );
    assert.match(
        diagnoseEmptySummary(R_DELTA("some text that looks like a summary but was cut") + 'data: {"broken'),
        /stream appears truncated: 1 incomplete data line/,
    );
    assert.match(
        diagnoseEmptySummary(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x" })}\n`),
        /no final frame terminator/,
    );
});
