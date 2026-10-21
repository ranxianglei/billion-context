import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openaiToCore,
  coreToOpenai,
  injectOpenaiSystem,
} from "../src/wire/openai.js";
import type { OpenAIRequestBody, OpenAIMessage } from "../src/wire/openai.js";

// #4201: kernel text-rewrite re-lay dropped extra keys on text parts
// (e.g. gateway-stamped cache_control). Both directions pinned: the rewrite
// path preserves part-level extras AND the verbatim path stays byte-exact;
// injectOpenaiSystem keeps parts-array heads' shape and metadata instead of
// collapsing them to a plain string. Anthropic wire precedent:
// rebuildSystemMessage's harvest-last mark discipline.

function flatOf(messages: OpenAIRequestBody["messages"]) {
  return openaiToCore({ model: "m", messages } as OpenAIRequestBody);
}

test("#4201 fixed: re-lay of a rewritten system preserves part-level extras", () => {
  const flat = flatOf([
    { role: "user", content: "q" },
    {
      role: "system",
      content: [
        { type: "text", text: "policy", cache_control: { type: "ephemeral" } },
      ],
    },
    { role: "user", content: "r" },
  ]);
  const core = flat.msgs.find((m) => m.role === "system");
  assert.ok(core);
  const edited = { ...core, text: "truncated policy" } as typeof core;
  const rebuilt = coreToOpenai([...flat.msgs.slice(0, 1), edited]);
  const sys = rebuilt.find((m) => m.role === "system");
  assert.ok(sys);
  assert.deepEqual(sys.content, [
    {
      type: "text",
      text: "truncated policy",
      cache_control: { type: "ephemeral" },
    },
  ]);
});

test("#4201: multi-part re-lay unions extra keys, later parts win per key", () => {
  const flat = flatOf([
    { role: "user", content: "q" },
    {
      role: "system",
      content: [
        { type: "text", text: "a", k1: 1, k2: "first" },
        { type: "text", text: "b", k2: "second" },
      ],
    },
  ]);
  const core = flat.msgs.find((m) => m.role === "system");
  assert.ok(core);
  assert.equal(core.text, "a\nb");
  const edited = { ...core, text: "rewritten" } as typeof core;
  const sys = coreToOpenai([edited]).find((m) => m.role === "system");
  assert.ok(sys);
  assert.deepEqual(sys.content, [
    { type: "text", text: "rewritten", k1: 1, k2: "second" },
  ]);
});

test("#4201 guard: string-content re-lay still emits a plain string", () => {
  const flat = flatOf([
    { role: "user", content: "q" },
    { role: "system", content: "plain policy" },
  ]);
  const core = flat.msgs.find((m) => m.role === "system");
  assert.ok(core);
  const edited = { ...core, text: "shortened" } as typeof core;
  const sys = coreToOpenai([flat.msgs[0]!, edited]).find(
    (m) => m.role === "system",
  );
  assert.ok(sys);
  assert.equal(sys.content, "shortened");
});

test("#4201 guard: unrewritten sidecar stays verbatim (no over-fix)", () => {
  const flat = flatOf([
    { role: "user", content: "q" },
    {
      role: "system",
      content: [
        { type: "text", text: "policy", cache_control: { type: "ephemeral" } },
        { type: "text", text: "more" },
      ],
    },
  ]);
  const rebuilt = coreToOpenai(flat.msgs);
  const sys = rebuilt.find((m) => m.role === "system");
  assert.ok(sys);
  assert.deepEqual(sys.content, [
    { type: "text", text: "policy", cache_control: { type: "ephemeral" } },
    { type: "text", text: "more" },
  ]);
});

test("#4201: developer-role re-lay keeps its role and its extras", () => {
  const flat = flatOf([
    { role: "user", content: "q" },
    {
      role: "developer",
      content: [
        {
          type: "text",
          text: "dev note",
          cache_control: { type: "ephemeral" },
        },
      ],
    },
  ]);
  const core = flat.msgs.find((m) => m.role === "system");
  assert.ok(core);
  assert.equal(core.originalRole, "developer");
  const edited = { ...core, text: "trimmed note" } as typeof core;
  const dev = coreToOpenai([flat.msgs[0]!, edited]).find(
    (m) => m.role === "developer",
  );
  assert.ok(dev);
  assert.deepEqual(dev.content, [
    {
      type: "text",
      text: "trimmed note",
      cache_control: { type: "ephemeral" },
    },
  ]);
});

test("#4201 fixed: injectOpenaiSystem keeps a parts-array head's parts and extras", () => {
  const head: OpenAIMessage = {
    role: "system",
    content: [
      {
        type: "text",
        text: "client policy",
        cache_control: { type: "ephemeral" },
      },
    ],
  };
  const out = injectOpenaiSystem(
    [head, { role: "user", content: "hi" }],
    ["compress prompt"],
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].content, [
    {
      type: "text",
      text: "client policy",
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: "compress prompt" },
  ]);
  assert.equal(out[1].role, "user");
});

test("#4201 fixed: injectOpenaiSystem keeps structured head blocks (client data, #4166)", () => {
  const head: OpenAIMessage = {
    role: "system",
    content: [
      { type: "text", text: "declared tools:" },
      {
        type: "tool_addition",
        name: "web_search",
        spec: { enabled: true },
      } as never,
    ],
  };
  const out = injectOpenaiSystem(
    [head, { role: "user", content: "hi" }],
    ["compress prompt"],
  );
  assert.deepEqual(out[0].content, [
    { type: "text", text: "declared tools:" },
    { type: "tool_addition", name: "web_search", spec: { enabled: true } },
    { type: "text", text: "compress prompt" },
  ]);
});

test("pin: injectOpenaiSystem merges into a STRING head with the --- separator", () => {
  const out = injectOpenaiSystem(
    [
      { role: "system", content: "base" },
      { role: "user", content: "hi" },
    ],
    ["extra"],
  );
  assert.equal(out[0].content, "base\n\n---\n\nextra");
});

test("pin: injectOpenaiSystem prepends a system message when none exists", () => {
  const out = injectOpenaiSystem(
    [{ role: "user", content: "hi" }],
    ["extra rules"],
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "system");
  assert.equal(out[0].content, "extra rules");
  assert.equal(out[1].role, "user");
});

test("pin: injectOpenaiSystem is a no-op with empty parts", () => {
  const msgs: OpenAIMessage[] = [{ role: "user", content: "hi" }];
  assert.deepEqual(injectOpenaiSystem(msgs, []), msgs);
});
