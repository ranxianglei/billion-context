import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic, type AnthropicRequestBody } from "../src/wire/anthropic.js";
import { openaiToCore, type OpenAIRequestBody } from "../src/wire/openai.js";
import { coreToResponses } from "../src/wire/responses.js";
import { coreToGoogle } from "../src/wire/google.js";
import type { BiliMessage } from "../src/wire/bili-message.js";

/**
 * Cross-lane egress fidelity (egress-plane follow-up, discussion #7439).
 *
 * When a pinned session switches protocol (e.g. pi moving a session from an
 * openai-wire model to an anthropic-wire model), the egress flow rows were
 * recorded in the ORIGINAL lane's shape — the serving lane's raw sidecars
 * are foreign and must not be used. The codecs then have to render the
 * stored cores from the CANONICAL fields alone. This file pins the
 * pi-parity degradation policy for that path (pi-stable
 * packages/ai/src/api/*):
 *
 *   - thinking WITHOUT a signature of the serving lane → plain text
 *     (Anthropic rejects unsigned thinking blocks; Gemini 3 validates
 *     thought signatures; pi degrades the same way);
 *   - signed thinking stays a thinking block (same-lane behavior unchanged);
 *   - images rebuild natively from the imageBase64/imageMediaType sidecars
 *     in every lane (never the literal "[image]" text);
 *   - tool calls / tool results keep name, args and text;
 *   - external reasoning is NEVER dropped silently (responses lane used to
 *     drop any reasoning core without its raw item).
 */

const IMG_B64 = "aGVsbG8td29ybGQ="; // "hello-world"
const REASONING = "first inspect both files, then compare";

/** An agentic conversation in the OPENAI lane: the recorded flow shape.
 *  Deliberately exercises every split shape: [text, image] user content,
 *  an assistant turn with reasoning + text + TWO tool calls (N+1 cores for
 *  one wire message — the canonical #3642 granularity). */
function openaiCores(): BiliMessage[] {
  const body: OpenAIRequestBody = {
    model: "gpt-x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "see the diagram" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${IMG_B64}` } },
        ],
      },
      {
        role: "assistant",
        reasoning_content: REASONING,
        content: "reading now",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read", arguments: "{\"path\":\"a\"}" } },
          { id: "c2", type: "function", function: { name: "read", arguments: "{\"path\":\"b\"}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "A" },
      { role: "tool", tool_call_id: "c2", content: "B" },
      { role: "assistant", content: "both read" },
    ],
  };
  return openaiToCore(body).msgs;
}

type AnyBlock = Record<string, any>;
const blocksOf = (wire: AnyBlock[]): AnyBlock[] =>
  wire.flatMap((w) => (Array.isArray(w.content) ? w.content : []));

test("coreToAnthropic: openai-recorded cores render with pi-parity degradation", () => {
  const wire = coreToAnthropic(openaiCores());
  const blocks = blocksOf(wire as AnyBlock[]);

  // 1) No unsigned thinking block may ever reach the wire: every
  //    thinking block carries a non-empty signature.
  const thinking = blocks.filter((b) => b.type === "thinking");
  for (const b of thinking) assert.ok(typeof b.signature === "string" && b.signature.length > 0);

  // 2) The reasoning TEXT survives (degraded to a plain text block).
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text as string).join("\n");
  assert.ok(text.includes(REASONING), `reasoning text lost: ${text}`);
  assert.ok(text.includes("reading now"));
  assert.ok(text.includes("both read"));

  // 3) The image rebuilds natively from the sidecars.
  const img = blocks.find((b) => b.type === "image");
  assert.ok(img, "no image block emitted");
  assert.deepEqual(img.source, { type: "base64", media_type: "image/png", data: IMG_B64 });

  // 4) Tool calls keep name + parsed args; tool results keep their text.
  const toolUse = blocks.filter((b) => b.type === "tool_use");
  assert.equal(toolUse.length, 2);
  assert.deepEqual(toolUse.map((b) => b.name), ["read", "read"]);
  assert.deepEqual(toolUse[0].input, { path: "a" });
  assert.deepEqual(toolUse[1].input, { path: "b" });
  const toolResult = blocks.filter((b) => b.type === "tool_result");
  assert.deepEqual(toolResult.map((b) => b.content), ["A", "B"]);
});

test("coreToResponses: external reasoning is text, never dropped; image rebuilds", () => {
  const items = coreToResponses(openaiCores()) as AnyBlock[];
  const assistantText = items
    .filter((i) => i.type === "message" && i.role === "assistant")
    .map((i) => (typeof i.content === "string" ? i.content : ""))
    .join("\n");
  // Previously the whole reasoning core vanished (only raw items were kept).
  assert.ok(assistantText.includes(REASONING), `reasoning dropped: ${assistantText}`);
  assert.ok(assistantText.includes("reading now"));
  assert.ok(assistantText.includes("both read"));

  const img = items
    .flatMap((i) => (Array.isArray(i.content) ? i.content : []))
    .find((p: AnyBlock) => p.type === "input_image");
  assert.ok(img, "no input_image part emitted");
  assert.equal(img.image_url, `data:image/png;base64,${IMG_B64}`);

  const calls = items.filter((i) => i.type === "function_call");
  assert.deepEqual(calls.map((c) => c.name), ["read", "read"]);
});

test("coreToGoogle: unsigned reasoning degrades to plain text; image rebuilds", () => {
  const contents = coreToGoogle(openaiCores()) as AnyBlock[];
  const parts = contents.flatMap((c) => c.parts);

  // Gemini 3 validates thought signatures — an unsigned thought part is a
  // rejected request; the text must survive as a plain part instead.
  const thought = parts.filter((p) => p.thought === true);
  assert.equal(thought.length, 0, "unsigned thought part emitted");
  const text = parts.filter((p) => typeof p.text === "string").map((p) => p.text).join("\n");
  assert.ok(text.includes(REASONING), `reasoning text lost: ${text}`);

  const img = parts.find((p) => p.inlineData);
  assert.ok(img, "no inlineData part emitted");
  assert.deepEqual(img.inlineData, { mimeType: "image/png", data: IMG_B64 });

  const fc = parts.filter((p) => p.functionCall).map((p) => p.functionCall.name);
  assert.deepEqual(fc, ["read", "read"]);
});

test("same-lane regression: signed anthropic thinking stays a thinking block", () => {
  const body: AnthropicRequestBody = {
    model: "claude-x",
    messages: [
      { role: "user", content: "think" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "deep thought", signature: "sig_123" },
          { type: "text", text: "done" },
        ],
      },
    ],
  };
  const wire = coreToAnthropic(anthropicToCore(body).msgs);
  const blocks = blocksOf(wire as AnyBlock[]);
  const thinking = blocks.find((b) => b.type === "thinking");
  assert.ok(thinking, "signed thinking block missing");
  assert.equal(thinking.thinking, "deep thought");
  assert.equal(thinking.signature, "sig_123");
});

test("same-lane regression: unsigned anthropic thinking relays verbatim as a thinking block (#5495)", () => {
  // An upstream that does NOT sign (DeepSeek's /anthropic endpoint) accepted
  // this block without a signature and REQUIRES it passed back verbatim
  // ("content[].thinking ... must be passed back"). The anthropicToCore parse
  // marks the core, so coreToAnthropic re-emits the thinking block — it must
  // NOT degrade to text (degradation is the cross-lane rule only).
  const body: AnthropicRequestBody = {
    model: "deepseek-x",
    messages: [
      { role: "user", content: "think" },
      { role: "assistant", content: [{ type: "thinking", thinking: "no sig" }] },
    ],
  };
  const wire = coreToAnthropic(anthropicToCore(body).msgs);
  const blocks = blocksOf(wire as AnyBlock[]);
  const thinking = blocks.find((b) => b.type === "thinking");
  assert.ok(thinking, "same-lane unsigned thinking block missing from the re-render");
  assert.equal(thinking.thinking, "no sig");
  assert.ok(!("signature" in thinking) || thinking.signature === "", "no signature invented");
  assert.equal(blocks.filter((b) => b.type === "text" && b.text === "no sig").length, 0, "same-lane reasoning must not degrade to text");
});
