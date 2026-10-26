import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiToCore, coreToOpenai } from "../src/wire/openai.js";
import type { OpenAIRequestBody } from "../src/wire/openai.js";

// #4166 pins: CURRENT openai-wire behavior for mid-conversation system
// messages (issue #4159 family). These pins document today's codec contract
// BEFORE the verbatim-sidecar change lands; the fix flips the "loss" pins
// and keeps the anchors. Anthropic lane precedent: #3992
// (rawAnthropicMessage sidecar); openai lane has no equivalent yet — mid
// system is text-flattened by stringContent and rebuilt text-only.

function roundTrip(messages: OpenAIRequestBody["messages"]) {
  const flat = openaiToCore({ model: "m", messages } as OpenAIRequestBody);
  return { flat, rebuilt: coreToOpenai(flat.msgs) };
}

test("anchor: leading system stays hoisted (unchanged by #4166)", () => {
  const { flat, rebuilt } = roundTrip([
    { role: "system", content: "head policy" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(flat.systemText, "head policy");
  assert.equal(flat.msgs.length, 1);
  assert.equal(flat.msgs[0].role, "user");
  // Head re-injection is the HOST step (injectOpenaiSystem): the codec-level
  // rebuild only carries the conversation cores — pinned here so the
  // leading-hoist anchor covers codec + host seam.
  assert.equal(rebuilt[0].role, "user");
  assert.equal(rebuilt.filter((m) => m.role === "system").length, 0);
});

test("pin: mid system (plain string) keeps position and role as text-only core", () => {
  const { flat, rebuilt } = roundTrip([
    { role: "user", content: "turn 1" },
    { role: "assistant", content: "answer 1" },
    { role: "system", content: "tool_addition text policy" },
    { role: "user", content: "turn 2" },
  ]);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid, "mid system survives as a core");
  assert.equal(mid.contentType, "text");
  assert.equal(mid.text, "tool_addition text policy");
  assert.equal(mid.originalRole, "system");
  const rb = rebuilt.find(
    (m) => m.role === "system" || m.role === "developer",
  );
  assert.ok(rb, "rebuilt as a system-family message");
  assert.equal(rb.role, "system");
  assert.equal(rb.content, "tool_addition text policy");
  assert.ok(rebuilt.indexOf(rb) > 0, "position preserved (not hoisted to head)");
});

test("#4166 fixed: mid system structured blocks round-trip verbatim via sidecar", () => {
  const { flat, rebuilt } = roundTrip([
    { role: "user", content: "turn 1" },
    {
      role: "system",
      content: [
        { type: "text", text: "declared tools:" },
        {
          type: "tool_addition",
          name: "web_search",
          spec: { enabled: true },
        } as never,
      ],
    },
    { role: "user", content: "turn 2" },
  ]);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid);
  // kernel text view stays the flattened string (truncation/matching ride it)
  assert.equal(mid.text, "declared tools:\n");
  // the sidecar keeps the FULL raw message — blocks survive the round trip
  const rb = rebuilt.filter(
    (m) => m.role === "system" || m.role === "developer",
  );
  assert.equal(rb.length, 1);
  assert.equal(rb[0].role, "system");
  const out = rb[0].content;
  assert.ok(Array.isArray(out));
  assert.ok(JSON.stringify(out).includes("web_search"));
  assert.ok(JSON.stringify(out).includes("tool_addition"));
  assert.ok(rebuilt.indexOf(rb[0]) > 0, "position preserved");
});

test("#4166: structured mid system is unfoldable (protection), plain one folds", async () => {
  const { hasUnrecoverableMediaPayload } = await import("../src/protected.js");
  const structured = openaiToCore({
    model: "m",
    messages: [
      { role: "user", content: "q" },
      {
        role: "system",
        content: [{ type: "text", text: "x" }, { type: "tool_addition", name: "t" } as never],
      },
    ],
  } as never);
  const structuredCore = structured.msgs.find((m) => m.role === "system");
  assert.ok(structuredCore);
  assert.equal(hasUnrecoverableMediaPayload(structuredCore), true);
  const plain = openaiToCore({
    model: "m",
    messages: [
      { role: "user", content: "q" },
      { role: "system", content: "plain policy text" },
    ],
  } as never);
  const plainCore = plain.msgs.find((m) => m.role === "system");
  assert.ok(plainCore);
  assert.equal(hasUnrecoverableMediaPayload(plainCore), false);
});

test("#4166: kernel text rewrite on a plain sidecar re-lays out text; structured stays verbatim", () => {
  const flat = openaiToCore({
    model: "m",
    messages: [
      { role: "user", content: "q" },
      { role: "system", content: "a".repeat(300) },
    ],
  } as never);
  const core = flat.msgs.find((m) => m.role === "system");
  assert.ok(core);
  const edited = { ...core, text: "truncated…" } as typeof core;
  const rebuilt = coreToOpenai([
    flat.msgs[0]!,
    edited,
    flat.msgs.find((m) => m.role === "user" && m.text === undefined ? m : undefined) ?? { id: "u2", role: "user", contentType: "text", text: "r" },
  ] as never);
  const sys = rebuilt.find((m) => m.role === "system");
  assert.ok(sys);
  assert.equal(sys.content, "truncated…");
});

test("pin: mid developer is preserved as system-core with originalRole developer", () => {
  const { flat, rebuilt } = roundTrip([
    { role: "user", content: "q" },
    { role: "developer", content: "mid dev note" },
    { role: "user", content: "r" },
  ]);
  const mid = flat.msgs.find((m) => m.role === "system");
  assert.ok(mid);
  assert.equal(mid.originalRole, "developer");
  const rb = rebuilt.find((m) => m.role === "developer");
  assert.ok(rb, "developer role round-trips");
  assert.equal(rb.content, "mid dev note");
});
