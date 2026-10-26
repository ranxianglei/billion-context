import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mirrorAnthropicMessages,
  mirrorAnthropicToCore,
  mirrorOpenaiMessages,
  mirrorOpenaiToCore,
  mirrorResponsesInput,
  mirrorResponsesToCore,
  type MirrorMessage,
} from "../src/wire/mirror.js";
import { openaiToCore, type OpenAIRequestBody } from "../src/wire/openai.js";
import { anthropicToCore } from "../src/wire/anthropic.js";
import {
  responsesToCore,
  type ResponsesRequestBody,
} from "../src/wire/responses.js";

const ids = (msgs: Array<{ id: string; contentType: string }>) =>
  msgs.map((m) => `${m.contentType}:${m.id}`);

const view: MirrorMessage[] = [
  { role: "user", blocks: [{ type: "text", text: "Q" }] },
  {
    role: "assistant",
    blocks: [
      { type: "thinking", thinking: "each." },
      { type: "text", text: "\n\n两个 PR：" },
    ],
  },
  {
    role: "assistant",
    blocks: [
      { type: "thinking", thinking: "plan" },
      {
        type: "toolCall",
        id: "call_1",
        name: "compress",
        arguments: { ranges: ["m00001..m00002"] },
      },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call_1",
    blocks: [{ type: "text", text: "done" }],
  },
  { role: "meta", text: "note" },
];

// --- openai mirror ---------------------------------------------------------

test("mirrorOpenaiMessages emits the completions wire layout", () => {
  const messages = mirrorOpenaiMessages(view, "SYS");
  assert.deepEqual(messages[0], { role: "system", content: "SYS" });
  assert.deepEqual(messages[1], { role: "user", content: "Q" });
  assert.deepEqual(messages[2], {
    role: "assistant",
    content: "\n\n两个 PR：",
    reasoning_content: "each.",
  });
  assert.deepEqual(messages[3], {
    role: "assistant",
    content: "",
    reasoning_content: "plan",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: {
          name: "compress",
          arguments: '{"ranges":["m00001..m00002"]}',
        },
      },
    ],
  });
  assert.deepEqual(messages[4], {
    role: "tool",
    tool_call_id: "call_1",
    content: "done",
  });
  assert.deepEqual(messages[5], { role: "developer", content: "note" });
  assert.equal(messages.length, 6);
});

test("mirrorOpenaiMessages drops empty turns and keeps whitespace-only text", () => {
  const out = mirrorOpenaiMessages(
    [
      { role: "user", blocks: [{ type: "text", text: "" }] }, // empty → dropped
      { role: "assistant", blocks: [] }, // nothing at all → dropped
      { role: "assistant", blocks: [{ type: "text", text: "   " }] }, // whitespace-only → kept
      { role: "meta", text: "" }, // empty meta → dropped
    ],
    "SYS",
  );
  assert.deepEqual(out, [
    { role: "system", content: "SYS" },
    { role: "assistant", content: "   " },
  ]);
});

test("openai mirror ids match the live reasoning_content wire (issue #103)", () => {
  const live: OpenAIRequestBody = {
    model: "glm-x",
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "Q" },
      {
        role: "assistant",
        content: "\n\n两个 PR：",
        reasoning_content: "each.",
      },
      {
        role: "assistant",
        content: "",
        reasoning_content: "plan",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "compress",
              arguments: '{"ranges":["m00001..m00002"]}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
      { role: "developer", content: "note" },
    ],
  };
  assert.deepEqual(
    ids(mirrorOpenaiToCore(view, "SYS")),
    ids(openaiToCore(live).msgs),
  );
});

test("openai mirror ids match the live inline-<think> wire (issue #64 demoted)", () => {
  // A host that demotes thinking INLINE (glm/qwen/deepseek dialect via the
  // pi host encoder) puts the same turn on the wire as one text blob; the
  // kernel codec normalizes it into the same identity space as the mirror.
  const live: OpenAIRequestBody = {
    model: "glm-x",
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "Q" },
      { role: "assistant", content: "<think>\neach.\n</think>\n\n\n两个 PR：" },
      {
        role: "assistant",
        content: "<think>\nplan\n</think>\n",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "compress",
              arguments: '{"ranges":["m00001..m00002"]}',
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
      { role: "developer", content: "note" },
    ],
  };
  assert.deepEqual(
    ids(mirrorOpenaiToCore(view, "SYS")),
    ids(openaiToCore(live).msgs),
  );
});

// --- anthropic mirror ------------------------------------------------------

test("mirrorAnthropicMessages emits the messages wire layout", () => {
  const out = mirrorAnthropicMessages([
    { role: "user", blocks: [{ type: "text", text: "Q" }] },
    {
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "sig'd", signature: "sig-1" },
        { type: "thinking", thinking: "unsigned" },
        { type: "text", text: "   " }, // whitespace-only → dropped
        { type: "text", text: "\n\n答案" },
        { type: "toolCall", id: "tu_1", name: "compress", arguments: { a: 1 } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "tu_1",
      blocks: [{ type: "text", text: "done" }],
    },
    { role: "meta", text: "note" },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: [{ type: "text", text: "Q" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "sig'd", signature: "sig-1" },
        { type: "thinking", thinking: "unsigned" },
        { type: "text", text: "\n\n答案" },
        { type: "tool_use", id: "tu_1", name: "compress", input: { a: 1 } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done" }],
    },
    { role: "user", content: [{ type: "text", text: "note" }] },
  ]);
  // unsigned thinking carries no signature field at all
  assert.equal(
    "signature" in
      (out[1] as { content: Array<Record<string, unknown>> }).content[1],
    false,
  );
});

test("anthropic mirror folds into reasoning pieces (issue #103)", () => {
  const msgs = mirrorAnthropicToCore([
    { role: "user", blocks: [{ type: "text", text: "Q" }] },
    {
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "think A", signature: "sig" },
        { type: "text", text: "answer" },
      ],
    },
  ]);
  assert.deepEqual(
    msgs.map((m) => m.contentType),
    ["text", "reasoning", "text"],
  );
  const live = anthropicToCore({
    model: "claude-x",
    messages: [
      { role: "user", content: [{ type: "text", text: "Q" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think A", signature: "sig" },
          { type: "text", text: "answer" },
        ],
      },
    ],
  } as Parameters<typeof anthropicToCore>[0]);
  assert.deepEqual(ids(msgs), ids(live.msgs));
});

// --- responses mirror ------------------------------------------------------

test("mirrorResponsesInput emits items in content order", () => {
  const out = mirrorResponsesInput([
    { role: "user", blocks: [{ type: "text", text: "Q" }] },
    {
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "  " }, // whitespace-only → dropped
        { type: "text", text: "answer" },
        {
          type: "toolCall",
          id: "call_1",
          name: "compress",
          arguments: { a: 1 },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      blocks: [{ type: "text", text: "done" }],
    },
    { role: "meta", text: "note" },
  ]);
  assert.deepEqual(out, [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Q" }],
    },
    { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "answer" }],
    },
    {
      type: "function_call",
      call_id: "call_1",
      name: "compress",
      arguments: '{"a":1}',
    },
    { type: "function_call_output", call_id: "call_1", output: "done" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "note" }],
    },
  ]);
});

test("responses mirror ids match the live reasoning-item wire (issue #64 responses variant)", () => {
  const live: ResponsesRequestBody = {
    model: "qwen-x",
    instructions: "SYS",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Q" }],
      },
      { type: "reasoning", summary: [{ type: "summary_text", text: "plan" }] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
    ],
  };
  const view2: MirrorMessage[] = [
    { role: "user", blocks: [{ type: "text", text: "Q" }] },
    {
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "answer" },
      ],
    },
  ];
  assert.deepEqual(
    ids(mirrorResponsesToCore(view2, "SYS")),
    ids(responsesToCore(live).msgs),
  );
});

test("responses mirror keeps thinking-only turns as reasoning items", () => {
  const msgs = mirrorResponsesToCore(
    [
      {
        role: "assistant",
        blocks: [{ type: "thinking", thinking: "only think" }],
      },
    ],
    "SYS",
  );
  assert.deepEqual(
    msgs.map((m) => m.contentType),
    ["reasoning"],
  );
});
