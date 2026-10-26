import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coreToOpenai,
  openaiToCore,
  type OpenAIRequestBody,
} from "../src/wire/openai.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { prune } from "../src/prune.js";

// A thinking-mode host replays assistant turns whose `reasoning_content` is
// present but BLANK (the model emitted no chain of thought for that turn).
// Strict-echo upstreams — DeepSeek thinking mode: "The `reasoning_content` in
// the thinking mode must be passed back to the API" — reject a rebuilt request
// that lost the key while accepting a blank one, so the core round-trip must
// not turn "blank" into "absent".

const BASH_CALL = {
  id: "call_bash",
  type: "function",
  function: { name: "bash", arguments: '{"cmd":"ls"}' },
} as const;
const GREP_CALL = {
  id: "call_grep",
  type: "function",
  function: { name: "grep", arguments: '{"q":"x"}' },
} as const;

const roundTrip = (messages: OpenAIRequestBody["messages"]) =>
  coreToOpenai(openaiToCore({ model: "deepseek-v4-flash", messages }).msgs);

test("a blank reasoning_content field survives the round-trip", () => {
  const wire = roundTrip([
    {
      role: "assistant",
      content: ".",
      reasoning_content: "",
      tool_calls: [BASH_CALL],
    },
    { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
  ]);
  const assistant = wire[0]!;
  assert.equal(assistant.role, "assistant");
  assert.ok("reasoning_content" in assistant, "the key must be re-emitted");
  assert.strictEqual(assistant.reasoning_content, "");
  assert.deepStrictEqual(
    assistant.tool_calls?.map((call) => call.id),
    [BASH_CALL.id],
  );
});

test("an absent reasoning_content field is not invented", () => {
  const wire = roundTrip([
    { role: "assistant", content: ".", tool_calls: [BASH_CALL] },
    { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
  ]);
  assert.ok(!("reasoning_content" in wire[0]!), "no field, no echo");
});

test("an inline thinking block still wins over a blank field", () => {
  const wire = roundTrip([
    {
      role: "assistant",
      content: "<think>\nreasoned about it\n</think>\n\n\nanswer",
      reasoning_content: "",
    },
  ]);
  assert.strictEqual(wire[0]!.reasoning_content, "reasoned about it");
  assert.strictEqual(wire[0]!.content, "\n\nanswer");
});

test("a text-only assistant turn keeps its blank field", () => {
  const wire = roundTrip([
    { role: "assistant", content: "hello", reasoning_content: "" },
    { role: "user", content: "again" },
  ]);
  assert.strictEqual(wire[0]!.reasoning_content, "");
  assert.strictEqual(wire[0]!.content, "hello");
});

test("a blank field does not leak onto a turn that never carried it", () => {
  const wire = roundTrip([
    {
      role: "assistant",
      content: ".",
      reasoning_content: "",
      tool_calls: [BASH_CALL],
    },
    { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
    { role: "assistant", content: "done" },
  ]);
  assert.strictEqual(wire[0]!.reasoning_content, "");
  assert.ok(
    !("reasoning_content" in wire[2]!),
    "the second turn keeps the key absent",
  );
});

test("the presence marker does not enter core identity", () => {
  const blank = openaiToCore({
    model: "deepseek-v4-flash",
    messages: [
      {
        role: "assistant",
        content: ".",
        reasoning_content: "",
        tool_calls: [BASH_CALL],
      },
      { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
    ],
  }).msgs;
  const absent = openaiToCore({
    model: "deepseek-v4-flash",
    messages: [
      { role: "assistant", content: ".", tool_calls: [BASH_CALL] },
      { role: "tool", tool_call_id: BASH_CALL.id, content: "ok" },
    ],
  }).msgs;
  assert.deepStrictEqual(
    blank.map((m) => m.id),
    absent.map((m) => m.id),
  );
});

test("parallel calls keep their call order and their results keep theirs", () => {
  const wire = roundTrip([
    {
      role: "assistant",
      content: ".",
      reasoning_content: "",
      tool_calls: [BASH_CALL, GREP_CALL],
    },
    { role: "tool", tool_call_id: GREP_CALL.id, content: "grep out" },
    { role: "tool", tool_call_id: BASH_CALL.id, content: "bash out" },
    { role: "user", content: "next" },
  ]);
  assert.strictEqual(wire[0]!.reasoning_content, "");
  assert.deepStrictEqual(
    wire[0]!.tool_calls?.map((call) => call.id),
    [BASH_CALL.id, GREP_CALL.id],
  );
  assert.deepStrictEqual(
    wire.slice(1, 3).map((m) => m.tool_call_id),
    [GREP_CALL.id, BASH_CALL.id],
  );
});

test("a blank echo survives the full pipeline and a history fold", () => {
  // #289 post-fold shape: summary ahead, open blank-echo turn followed only by its result.
  const core = createCore();
  const state = createInitialState();
  const base = defaultConfig(200000);
  const config = {
    ...base,
    compress: { ...base.compress, minCompressRange: 0, minSummaryLength: 0 },
  };
  const body: OpenAIRequestBody = {
    model: "deepseek-v4-flash",
    messages: [
      { role: "user", content: "step one" },
      {
        role: "assistant",
        content: ".",
        reasoning_content: "",
        tool_calls: [BASH_CALL],
      },
      { role: "tool", tool_call_id: BASH_CALL.id, content: "done one" },
      { role: "user", content: "step two" },
      { role: "assistant", content: "ok two" },
      { role: "user", content: "step three" },
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: [GREP_CALL],
      },
      { role: "tool", tool_call_id: GREP_CALL.id, content: "done three" },
    ],
  };

  const turn = core.processTurn({
    messages: openaiToCore(body).msgs,
    state,
    config,
    tokenCount: 4000,
    renderTags: "none",
  });

  const tailCall = turn.messages.find(
    (m) => m.contentType === "tool-call" && m.toolCallId === GREP_CALL.id,
  );
  assert.ok(tailCall?.reasoningPresent, "marker must survive the pipeline");

  const anchor = turn.messages.find(
    (m) => m.role === "user" && m.text === "step three",
  );
  assert.ok(anchor, "anchor user message present");
  const anchorRef = Number(turn.state.messageRefs.byRaw[anchor!.id]!.slice(1));
  const applied = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: `m${String(anchorRef - 1).padStart(5, "0")}`,
        summary: "steps one and two recap",
      },
    ],
    messages: turn.messages,
    state: turn.state,
    config,
  });
  assert.equal(applied.result.errors.length, 0);

  const rebuilt = coreToOpenai(prune(turn.messages, applied.state));
  assert.ok(
    rebuilt.some((m) => m.role === "system"),
    "fold injected a summary message",
  );
  const tailWire = rebuilt.find(
    (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
  );
  assert.ok(tailWire, "tail assistant turn still present");
  assert.ok(
    "reasoning_content" in tailWire!,
    "blank key must survive the fold rebuild",
  );
  assert.strictEqual(tailWire!.reasoning_content, "");
});
