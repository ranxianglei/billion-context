import { test } from "node:test";
import assert from "node:assert/strict";
import {
  conversationSignalAnthropic,
  type AnthropicRequestBody,
} from "../src/wire/anthropic.js";
import {
  conversationSignalOpenai,
  type OpenAIRequestBody,
} from "../src/wire/openai.js";
import { hashId } from "../src/wire/util.js";

const DEFAULT = hashId("default");

// Hosts hand these functions whatever JSON.parse produced — including bodies
// with no messages array at all — so the malformed cases below are cast.
const malformedBodies: unknown[] = [{}, [1, 2], null, "str", 42];

test("conversationSignalAnthropic: bodies without a messages array fall back to the default fingerprint (#298)", () => {
  for (const raw of malformedBodies) {
    assert.doesNotThrow(() =>
      conversationSignalAnthropic(raw as AnthropicRequestBody),
    );
    assert.equal(
      conversationSignalAnthropic(raw as AnthropicRequestBody),
      DEFAULT,
    );
  }
});

test("conversationSignalOpenai: bodies without a messages array fall back to the default fingerprint (#298)", () => {
  for (const raw of malformedBodies) {
    assert.doesNotThrow(() =>
      conversationSignalOpenai(raw as OpenAIRequestBody),
    );
    assert.equal(conversationSignalOpenai(raw as OpenAIRequestBody), DEFAULT);
  }
});

test("conversationSignal*: header short-circuit wins even on a malformed body", () => {
  const body = {} as unknown as AnthropicRequestBody & OpenAIRequestBody;
  assert.equal(conversationSignalAnthropic(body, "  s-1  "), "s-1");
  assert.equal(conversationSignalOpenai(body, " s-2 "), "s-2");
});

test("conversationSignal*: non-user and null message elements never crash and fall back to default (#298)", () => {
  const anthropicBody = {
    messages: [null, { role: "assistant", content: "hi" }],
  } as unknown as AnthropicRequestBody;
  assert.equal(conversationSignalAnthropic(anthropicBody), DEFAULT);
  const openaiBody = {
    messages: [null, { role: "system", content: "sys" }],
  } as unknown as OpenAIRequestBody;
  assert.equal(conversationSignalOpenai(openaiBody), DEFAULT);
});

test("conversationSignalAnthropic: first user message content still drives the fingerprint", () => {
  const body = {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "x" },
    ],
  } satisfies AnthropicRequestBody;
  assert.equal(
    conversationSignalAnthropic(body),
    hashId(JSON.stringify("hello")),
  );
  const other = {
    ...body,
    messages: [{ role: "user", content: "world" }],
  } satisfies AnthropicRequestBody;
  assert.notEqual(
    conversationSignalAnthropic(other),
    conversationSignalAnthropic(body),
  );
  assert.match(conversationSignalAnthropic(body), /^[0-9a-f]{16}$/);
});

test("conversationSignalOpenai: first user message content still drives the fingerprint", () => {
  const body = {
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "x" },
    ],
  } satisfies OpenAIRequestBody;
  assert.equal(conversationSignalOpenai(body), hashId("hello"));
  const other = {
    ...body,
    messages: [{ role: "user", content: "world" }],
  } satisfies OpenAIRequestBody;
  assert.notEqual(
    conversationSignalOpenai(other),
    conversationSignalOpenai(body),
  );
  assert.match(conversationSignalOpenai(body), /^[0-9a-f]{16}$/);
});
