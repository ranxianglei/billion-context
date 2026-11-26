import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_EXEMPT_ENVELOPES,
    isBackgroundEventText,
    lastUserTextFromParsed,
    isBackgroundEventRequest,
    isBackgroundEventRequestFromParsed,
    lastUserMessageCategory,
    lastUserMessageCategoryFromParsed,
    resolveExemptEnvelopes,
} from "../src/degenerate-retry.ts";

// #7235: background-event exemption for the degenerate-terminal retry. A turn
// whose LAST outgoing user message is a pure background event (a
// task-notification / system-reminder with nothing else) is an intentional
// no-op: the model's empty end_turn is the correct answer. These tests pin the
// probe's 23 shapes × body types and the counter-examples that must NOT be
// exempted.

const ENVELOPES = DEFAULT_EXEMPT_ENVELOPES;
const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

// ── isBackgroundEventText ──────────────────────────────────────────────

test("isBackgroundEventText: pure task-notification is exempt", () => {
    const text = "<task-notification>Workflow completed</task-notification>";
    assert.equal(isBackgroundEventText(text, ENVELOPES), true);
});

test("isBackgroundEventText: pure system-reminder is exempt", () => {
    const text = "<system-reminder>You are in a Claude Code session</system-reminder>";
    assert.equal(isBackgroundEventText(text, ENVELOPES), true);
});

test("isBackgroundEventText: notification + harness tail line is exempt", () => {
    const text = "<task-notification>Done</task-notification>\nIf this event is something the user would act on now, do so.";
    assert.equal(isBackgroundEventText(text, ENVELOPES), true);
});

test("isBackgroundEventText: notification + acp render tags is exempt", () => {
    const text = `${TAG_OPEN}m00155${TAG_CLOSE}<task-notification>Done</task-notification>`;
    assert.equal(isBackgroundEventText(text, ENVELOPES), true);
});

test("isBackgroundEventText: notification + human question is NOT exempt", () => {
    const text = "<task-notification>Done</task-notification>\nWhat should I do next?";
    assert.equal(isBackgroundEventText(text, ENVELOPES), false);
});

test("isBackgroundEventText: teammate message is NOT exempt (not in default envelopes)", () => {
    const text = "<teammate-message>Need help</teammate-message>";
    assert.equal(isBackgroundEventText(text, ENVELOPES), false);
});

test("isBackgroundEventText: plain human message is NOT exempt", () => {
    const text = "Hello, how are you?";
    assert.equal(isBackgroundEventText(text, ENVELOPES), false);
});

test("isBackgroundEventText: empty string is NOT exempt", () => {
    assert.equal(isBackgroundEventText("", ENVELOPES), false);
});

test("isBackgroundEventText: custom envelope list", () => {
    const text = "<teammate-message>Need help</teammate-message>";
    assert.equal(isBackgroundEventText(text, ["teammate-message"]), true);
    assert.equal(isBackgroundEventText(text, ENVELOPES), false);
});

// ── lastUserTextFromParsed ─────────────────────────────────────────────

test("lastUserTextFromParsed: anthropic string content", () => {
    const obj = { messages: [{ role: "user", content: "hello" }] };
    assert.equal(lastUserTextFromParsed("anthropic", obj), "hello");
});

test("lastUserTextFromParsed: anthropic array content (text parts)", () => {
    const obj = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
    assert.equal(lastUserTextFromParsed("anthropic", obj), "hello");
});

test("lastUserTextFromParsed: anthropic tool_result is undefined", () => {
    const obj = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "result" }] }] };
    assert.equal(lastUserTextFromParsed("anthropic", obj), undefined);
});

test("lastUserTextFromParsed: anthropic image is undefined", () => {
    const obj = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] };
    assert.equal(lastUserTextFromParsed("anthropic", obj), undefined);
});

test("lastUserTextFromParsed: anthropic last-is-assistant is undefined", () => {
    const obj = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] };
    assert.equal(lastUserTextFromParsed("anthropic", obj), undefined);
});

test("lastUserTextFromParsed: openai string content", () => {
    const obj = { messages: [{ role: "user", content: "hello" }] };
    assert.equal(lastUserTextFromParsed("openai", obj), "hello");
});

test("lastUserTextFromParsed: openai array content (text parts)", () => {
    const obj = { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] };
    assert.equal(lastUserTextFromParsed("openai", obj), "hello");
});

test("lastUserTextFromParsed: openai last-is-tool is undefined", () => {
    const obj = { messages: [{ role: "user", content: "hi" }, { role: "tool", content: "result" }] };
    assert.equal(lastUserTextFromParsed("openai", obj), undefined);
});

test("lastUserTextFromParsed: responses string input", () => {
    const obj = { input: "hello" };
    assert.equal(lastUserTextFromParsed("responses", obj), "hello");
});

test("lastUserTextFromParsed: responses array input (user item)", () => {
    const obj = { input: [{ role: "user", content: "hello" }] };
    assert.equal(lastUserTextFromParsed("responses", obj), "hello");
});

test("lastUserTextFromParsed: responses array input (input_text parts)", () => {
    const obj = { input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] };
    assert.equal(lastUserTextFromParsed("responses", obj), "hello");
});

test("lastUserTextFromParsed: responses function_call_output is undefined", () => {
    const obj = { input: [{ role: "assistant", content: [{ type: "function_call", name: "f", arguments: "{}" }] }, { role: "tool", content: [{ type: "function_call_output", call_id: "x", output: "result" }] }] };
    assert.equal(lastUserTextFromParsed("responses", obj), undefined);
});

test("lastUserTextFromParsed: google contents (text parts)", () => {
    const obj = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
    assert.equal(lastUserTextFromParsed("google", obj), "hello");
});

test("lastUserTextFromParsed: google inlineData is undefined", () => {
    const obj = { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] }] };
    assert.equal(lastUserTextFromParsed("google", obj), undefined);
});

test("lastUserTextFromParsed: google functionResponse is undefined", () => {
    const obj = { contents: [{ role: "user", parts: [{ functionResponse: { name: "f", response: {} } }] }] };
    assert.equal(lastUserTextFromParsed("google", obj), undefined);
});

test("lastUserTextFromParsed: no messages array is undefined", () => {
    assert.equal(lastUserTextFromParsed("anthropic", {}), undefined);
});

// ── isBackgroundEventRequest (string body) ─────────────────────────────

test("isBackgroundEventRequest: anthropic task-notification (string body)", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "<task-notification>Done</task-notification>" }] });
    assert.equal(isBackgroundEventRequest("anthropic", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: anthropic system-reminder (string body)", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "<system-reminder>Reminder</system-reminder>" }] });
    assert.equal(isBackgroundEventRequest("anthropic", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: anthropic notification + human question (string body)", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "<task-notification>Done</task-notification>\nWhat next?" }] });
    assert.equal(isBackgroundEventRequest("anthropic", body, ENVELOPES), false);
});

test("isBackgroundEventRequest: anthropic tool_result (string body)", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "result" }] }] });
    assert.equal(isBackgroundEventRequest("anthropic", body, ENVELOPES), false);
});

test("isBackgroundEventRequest: openai task-notification (string body)", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "<task-notification>Done</task-notification>" }] });
    assert.equal(isBackgroundEventRequest("openai", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: responses task-notification (string body)", () => {
    const body = JSON.stringify({ input: [{ role: "user", content: "<task-notification>Done</task-notification>" }] });
    assert.equal(isBackgroundEventRequest("responses", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: responses pure-string input (string body)", () => {
    const body = JSON.stringify({ input: "<task-notification>Done</task-notification>" });
    assert.equal(isBackgroundEventRequest("responses", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: google task-notification (string body)", () => {
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "<task-notification>Done</task-notification>" }] }] });
    assert.equal(isBackgroundEventRequest("google", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: unparseable body is false", () => {
    assert.equal(isBackgroundEventRequest("anthropic", "not json", ENVELOPES), false);
});

// ── isBackgroundEventRequest (Buffer body) ─────────────────────────────

test("isBackgroundEventRequest: anthropic task-notification (Buffer body)", () => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "<task-notification>Done</task-notification>" }] }));
    assert.equal(isBackgroundEventRequest("anthropic", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: openai task-notification (Buffer body)", () => {
    const body = Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "<task-notification>Done</task-notification>" }] }));
    assert.equal(isBackgroundEventRequest("openai", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: responses task-notification (Buffer body)", () => {
    const body = Buffer.from(JSON.stringify({ input: [{ role: "user", content: "<task-notification>Done</task-notification>" }] }));
    assert.equal(isBackgroundEventRequest("responses", body, ENVELOPES), true);
});

test("isBackgroundEventRequest: google task-notification (Buffer body)", () => {
    const body = Buffer.from(JSON.stringify({ contents: [{ role: "user", parts: [{ text: "<task-notification>Done</task-notification>" }] }] }));
    assert.equal(isBackgroundEventRequest("google", body, ENVELOPES), true);
});

// ── isBackgroundEventRequestFromParsed (object body) ───────────────────

test("isBackgroundEventRequestFromParsed: anthropic task-notification (object body)", () => {
    const obj = { messages: [{ role: "user", content: "<task-notification>Done</task-notification>" }] };
    assert.equal(isBackgroundEventRequestFromParsed("anthropic", obj, ENVELOPES), true);
});

test("isBackgroundEventRequestFromParsed: anthropic notification + image (object body)", () => {
    const obj = { messages: [{ role: "user", content: [{ type: "text", text: "<task-notification>Done</task-notification>" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }] }] };
    assert.equal(isBackgroundEventRequestFromParsed("anthropic", obj, ENVELOPES), false);
});

test("isBackgroundEventRequestFromParsed: anthropic tool_result + notification (object body)", () => {
    const obj = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "result" }, { type: "text", text: "<task-notification>Done</task-notification>" }] }] };
    assert.equal(isBackgroundEventRequestFromParsed("anthropic", obj, ENVELOPES), false);
});

test("isBackgroundEventRequestFromParsed: responses function_call_output (object body)", () => {
    const obj = { input: [{ role: "tool", content: [{ type: "function_call_output", call_id: "x", output: "result" }] }] };
    assert.equal(isBackgroundEventRequestFromParsed("responses", obj, ENVELOPES), false);
});

test("isBackgroundEventRequestFromParsed: google inlineData (object body)", () => {
    const obj = { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] }] };
    assert.equal(isBackgroundEventRequestFromParsed("google", obj, ENVELOPES), false);
});

// ── lastUserMessageCategory ────────────────────────────────────────────

test("lastUserMessageCategory: background event", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "<task-notification>Done</task-notification>" }] });
    assert.equal(lastUserMessageCategory("anthropic", body, ENVELOPES), "background-event");
});

test("lastUserMessageCategory: non-text (tool_result)", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "result" }] }] });
    assert.equal(lastUserMessageCategory("anthropic", body, ENVELOPES), "non-text");
});

test("lastUserMessageCategory: human", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "Hello" }] });
    assert.equal(lastUserMessageCategory("anthropic", body, ENVELOPES), "human");
});

test("lastUserMessageCategory: unparseable body is other", () => {
    assert.equal(lastUserMessageCategory("anthropic", "not json", ENVELOPES), "other");
});

test("lastUserMessageCategoryFromParsed: background event", () => {
    const obj = { messages: [{ role: "user", content: "<system-reminder>Reminder</system-reminder>" }] };
    assert.equal(lastUserMessageCategoryFromParsed("anthropic", obj, ENVELOPES), "background-event");
});

test("lastUserMessageCategoryFromParsed: human", () => {
    const obj = { messages: [{ role: "user", content: "Hello" }] };
    assert.equal(lastUserMessageCategoryFromParsed("anthropic", obj, ENVELOPES), "human");
});

// ── resolveExemptEnvelopes ─────────────────────────────────────────────

test("resolveExemptEnvelopes: returns default when no config", () => {
    const envelopes = resolveExemptEnvelopes();
    assert.deepEqual(envelopes, ["task-notification", "system-reminder"]);
});
