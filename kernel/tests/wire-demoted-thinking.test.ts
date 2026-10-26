import { test } from "node:test";
import assert from "node:assert/strict";

import { splitDemotedThinking } from "../src/wire/demoted-thinking.js";
import {
  coreToOpenai,
  openaiToCore,
  type OpenAIRequestBody,
} from "../src/wire/openai.js";
import {
  responsesToCore,
  type ResponsesRequestBody,
} from "../src/wire/responses.js";

// --- splitDemotedThinking unit -------------------------------------------------

test("splitDemotedThinking reverses each dialect form byte-exactly", () => {
  assert.deepStrictEqual(
    splitDemotedThinking("<think>\nA\n</think>\n\n\n两个 PR："),
    {
      reasoning: "A",
      text: "\n\n两个 PR：",
    },
  );
  assert.deepStrictEqual(
    splitDemotedThinking("<thinking>\nB\n</thinking>\ntail"),
    {
      reasoning: "B",
      text: "tail",
    },
  );
  assert.deepStrictEqual(splitDemotedThinking("```thinking\nC\n```\ntail"), {
    reasoning: "C",
    text: "tail",
  });
});

test("splitDemotedThinking handles stacked blocks and glue", () => {
  assert.deepStrictEqual(
    splitDemotedThinking("<think>\nA\n</think>\n<think>\nB\n</think>\n\ntext"),
    {
      reasoning: "A\nB",
      text: "\ntext",
    },
  );
  // thinking-only turn: glue consumed, text empty
  assert.deepStrictEqual(splitDemotedThinking("<think>\nA\n</think>"), {
    reasoning: "A",
    text: "",
  });
});

test("splitDemotedThinking refuses malformed / non-tag content", () => {
  assert.strictEqual(splitDemotedThinking(""), null);
  assert.strictEqual(splitDemotedThinking("plain answer"), null);
  assert.strictEqual(splitDemotedThinking("pre <think>\nA\n</think>"), null); // tag must open at offset 0
  assert.strictEqual(splitDemotedThinking("<think>\nA\n</thin>"), null); // unterminated
  assert.strictEqual(splitDemotedThinking("<think>x"), null); // renderer always breaks after the open tag
  assert.strictEqual(splitDemotedThinking("<think>\n</think>"), null); // empty block
});

// --- openaiToCore invariance ----------------------------------------------------

const INLINE_TURN =
  "<think>\nThe user asks.\n</think>\n\n\n两个 PR：内核与代理。";
const FIELD_TEXT = "\n\n两个 PR：内核与代理。";
const FIELD_REASONING = "The user asks.";

const inlineBody: OpenAIRequestBody = {
  model: "glm-x",
  messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: INLINE_TURN },
    { role: "user", content: "r" },
  ],
};
const fieldBody: OpenAIRequestBody = {
  model: "glm-x",
  messages: [
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: FIELD_TEXT,
      reasoning_content: FIELD_REASONING,
    },
    { role: "user", content: "r" },
  ],
};

test("openaiToCore: inline <think> and reasoning_content field share one identity space", () => {
  const inline = openaiToCore(inlineBody).msgs;
  const field = openaiToCore(fieldBody).msgs;
  assert.strictEqual(inline.length, 4);
  // Same ids, same order, same contentTypes — one fingerprint space.
  assert.deepStrictEqual(
    inline.map((m) => ({
      id: m.id,
      role: m.role,
      contentType: m.contentType,
      text: m.text,
    })),
    field.map((m) => ({
      id: m.id,
      role: m.role,
      contentType: m.contentType,
      text: m.text,
    })),
  );
  const reasoning = inline[1];
  assert.strictEqual(reasoning.contentType, "reasoning");
  assert.strictEqual(reasoning.text, FIELD_REASONING);
  assert.strictEqual(inline[2].text, FIELD_TEXT);
});

test("openaiToCore: reasoning_content field wins; tagged content is not double-split", () => {
  const body: OpenAIRequestBody = {
    model: "glm-x",
    messages: [
      {
        role: "assistant",
        content: "<think>\nA\n</think>text",
        reasoning_content: "R",
      },
    ],
  };
  const msgs = openaiToCore(body).msgs;
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].text, "R");
  assert.strictEqual(msgs[1].text, "<think>\nA\n</think>text");
});

test("openaiToCore: thinking-only turn yields reasoning with no empty text piece", () => {
  const msgs = openaiToCore({
    model: "glm-x",
    messages: [{ role: "assistant", content: "<think>\nonly\n</think>" }],
  }).msgs;
  assert.deepStrictEqual(
    msgs.map((m) => m.contentType),
    ["reasoning"],
  );
});

test("openaiToCore: user content starting with a tag is never split", () => {
  const msgs = openaiToCore({
    model: "glm-x",
    messages: [{ role: "user", content: "<think>\nA\n</think>q" }],
  }).msgs;
  assert.deepStrictEqual(
    msgs.map((m) => m.contentType),
    ["text"],
  );
  assert.strictEqual(msgs[0].text, "<think>\nA\n</think>q");
});

test("coreToOpenai round-trip normalizes inline form to the field form", () => {
  const wire = coreToOpenai(openaiToCore(inlineBody).msgs);
  const assistant = wire.find((m) => m.role === "assistant");
  assert.ok(assistant);
  assert.strictEqual(assistant.reasoning_content, FIELD_REASONING);
  assert.strictEqual(assistant.content, FIELD_TEXT);
});

// --- responsesToCore invariance -------------------------------------------------

const inlineResponsesBody = (): ResponsesRequestBody => ({
  model: "resp-x",
  input: [
    { type: "message", role: "user", content: "q" },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: INLINE_TURN }],
    },
    { type: "message", role: "user", content: "r" },
  ] as ResponsesRequestBody["input"],
});
const itemResponsesBody = (): ResponsesRequestBody => ({
  model: "resp-x",
  input: [
    { type: "message", role: "user", content: "q" },
    {
      type: "reasoning",
      summary: [{ type: "summary_text", text: FIELD_REASONING }],
    },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: FIELD_TEXT }],
    },
    { type: "message", role: "user", content: "r" },
  ] as ResponsesRequestBody["input"],
});

test("responsesToCore: inline <think> message and reasoning item share one identity space", () => {
  const inline = responsesToCore(inlineResponsesBody()).msgs;
  const item = responsesToCore(itemResponsesBody()).msgs;
  assert.strictEqual(inline.length, 4);
  assert.strictEqual(item.length, 4);
  assert.deepStrictEqual(
    inline.map((m) => ({
      id: m.id,
      role: m.role,
      contentType: m.contentType,
      text: m.text,
    })),
    item.map((m) => ({
      id: m.id,
      role: m.role,
      contentType: m.contentType,
      text: m.text,
    })),
  );
});

test("responsesToCore: thinking-only message yields reasoning with no empty text piece", () => {
  const proj = responsesToCore({
    model: "resp-x",
    input: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "<think>\nonly\n</think>" }],
      },
    ] as ResponsesRequestBody["input"],
  });
  assert.deepStrictEqual(
    proj.msgs.map((m) => m.contentType),
    ["reasoning"],
  );
});

test("responsesToCore: user content starting with a tag is never split", () => {
  const proj = responsesToCore({
    model: "resp-x",
    input: [
      { type: "message", role: "user", content: "<think>\nA\n</think>q" },
    ] as ResponsesRequestBody["input"],
  });
  assert.deepStrictEqual(
    proj.msgs.map((m) => m.contentType),
    ["text"],
  );
  assert.strictEqual(proj.msgs[0].text, "<think>\nA\n</think>q");
});
