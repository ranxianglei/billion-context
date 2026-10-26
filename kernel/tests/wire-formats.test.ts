import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WIRE_FORMATS,
  detectWireFormat,
  isWireFormat,
} from "../src/wire/formats.js";

test("WIRE_FORMATS lists exactly the codecs shipped by this package", () => {
  assert.deepEqual(
    [...WIRE_FORMATS],
    ["anthropic", "openai", "responses", "google"],
  );
  for (const f of WIRE_FORMATS) {
    assert.equal(isWireFormat(f), true);
  }
  assert.equal(isWireFormat("unknown"), false);
  assert.equal(isWireFormat(42), false);
});

test("detectWireFormat routes anthropic markers", () => {
  assert.equal(
    detectWireFormat({
      model: "claude-x",
      system: "s",
      messages: [{ role: "user", content: "hi" }],
    }),
    "anthropic",
  );
  assert.equal(
    detectWireFormat({
      anthropic_version: "v1",
      messages: [{ role: "user", content: "hi" }],
    }),
    "anthropic",
  );
  assert.equal(
    detectWireFormat({
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "1", name: "f", input: {} }],
        },
      ],
    }),
    "anthropic",
  );
  assert.equal(
    detectWireFormat({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }],
        },
      ],
    }),
    "anthropic",
  );
  assert.equal(
    detectWireFormat({
      messages: [
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
      ],
    }),
    "anthropic",
  );
  assert.equal(
    detectWireFormat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    }),
    "anthropic",
  );
});

test("detectWireFormat routes openai markers", () => {
  assert.equal(
    detectWireFormat({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "t1", function: { name: "f", arguments: "{}" } }],
        },
      ],
    }),
    "openai",
  );
  assert.equal(
    detectWireFormat({
      messages: [{ role: "tool", tool_call_id: "t1", content: "r" }],
    }),
    "openai",
  );
  assert.equal(
    detectWireFormat({ messages: [{ role: "system", content: "s" }] }),
    "openai",
  );
  assert.equal(
    detectWireFormat({ messages: [{ role: "developer", content: "s" }] }),
    "openai",
  );
});

test("detectWireFormat defaults plain role+content chat bodies to openai", () => {
  assert.equal(
    detectWireFormat({
      model: "glm-x",
      messages: [{ role: "user", content: "hi" }],
    }),
    "openai",
  );
});

test("detectWireFormat routes responses bodies by the input array", () => {
  assert.equal(
    detectWireFormat({
      model: "gpt-x",
      input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
    "responses",
  );
});

test("detectWireFormat rejects unparseable payloads", () => {
  assert.equal(detectWireFormat(null), undefined);
  assert.equal(detectWireFormat(42), undefined);
  assert.equal(detectWireFormat({}), undefined);
  assert.equal(detectWireFormat({ foo: 1 }), undefined);
  assert.equal(detectWireFormat({ messages: 42 }), undefined);
});
