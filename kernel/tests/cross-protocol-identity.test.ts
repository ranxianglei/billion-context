import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, type AnthropicRequestBody } from "../src/wire/anthropic.js";
import { openaiToCore, type OpenAIRequestBody } from "../src/wire/openai.js";
import { responsesToCore, type ResponsesRequestBody } from "../src/wire/responses.js";
import { googleToCore, type GoogleRequestBody } from "../src/wire/google.js";
import { CANONICAL_IMAGE_TEXT } from "../src/wire/identity.js";

/**
 * #3642 protocol-stable core: the same logical conversation, expressed in
 * every wire dialect, must project to the SAME core array — same order, same
 * contentType sequence, same ids. Identity is derived from canonical content
 * (role, contentType, toolName, canonical tool args, verbatim text, image
 * marker), never from transport plumbing (wire tool-call ids, provider item
 * ids, protocol-specific part shapes).
 *
 * This is the cross-protocol golden: if any codec drifts from the canonical
 * granularity or seed, a protocol switch would churn every message id
 * (exactly the #3640 failure mode this file pins shut).
 */

const IMG_DATA = "aGVsbG8=";

const USER_TEXT = "list the files, then read package.json";

function anthropicBody(): AnthropicRequestBody {
  return {
    model: "claude-x",
    system: "be terse",
    messages: [
      { role: "user", content: USER_TEXT },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_a", name: "bash", input: { cmd: "ls" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_a", content: "a.ts\nb.ts" }],
      },
      { role: "assistant", content: "done" },
    ],
  };
}

function openaiBody(): OpenAIRequestBody {
  return {
    model: "gpt-x",
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: USER_TEXT },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_xyz", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"ls\"}" } }],
      },
      { role: "tool", tool_call_id: "call_xyz", content: "a.ts\nb.ts" },
      { role: "assistant", content: "done" },
    ],
  };
}

function responsesBody(): ResponsesRequestBody {
  return {
    model: "gpt-x",
    instructions: "be terse",
    input: [
      { type: "message", role: "user", content: USER_TEXT },
      { type: "function_call", call_id: "fc_9", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
      { type: "function_call_output", call_id: "fc_9", output: "a.ts\nb.ts" },
      { type: "message", role: "assistant", content: "done" },
    ],
  };
}

function googleBody(): GoogleRequestBody {
  return {
    systemInstruction: { parts: [{ text: "be terse" }] },
    contents: [
      { role: "user", parts: [{ text: USER_TEXT }] },
      { role: "model", parts: [{ functionCall: { name: "bash", args: { cmd: "ls" }, id: "call_g" } }] },
      { role: "user", parts: [{ functionResponse: { name: "bash", response: { output: "a.ts\nb.ts" }, id: "call_g" } }] },
      { role: "model", parts: [{ text: "done" }] },
    ],
  };
}

function shapeOf(msgs: { role: string; contentType: string; text?: string; toolName?: string }[]) {
  return msgs.map((m) => `${m.role}/${m.contentType}:${m.toolName ?? ""}`);
}

test("cross-protocol golden: text/tool-call/tool-result conversation yields identical cores and ids", () => {
  const cores = [
    anthropicToCore(anthropicBody()).msgs,
    openaiToCore(openaiBody()).msgs,
    responsesToCore(responsesBody()).msgs,
    googleToCore(googleBody()).msgs,
  ];

  // Same projection shape everywhere (system hoisted out of the fold space).
  for (const msgs of cores) {
    assert.deepEqual(shapeOf(msgs), [
      "user/text:",
      "assistant/tool-call:bash",
      "tool/tool-result:bash",
      "assistant/text:",
    ]);
  }

  // THE invariant: byte-identical ids across all four dialects.
  const ids = cores.map((msgs) => msgs.map((m) => m.id));
  assert.deepEqual(ids[0], ids[1], "anthropic ids == openai ids");
  assert.deepEqual(ids[0], ids[2], "anthropic ids == responses ids");
  assert.deepEqual(ids[0], ids[3], "anthropic ids == google ids");

  // Texts identical (canonical bytes), including tool args/results.
  for (const msgs of cores) {
    assert.equal(msgs[0]!.text, USER_TEXT);
    assert.equal(msgs[3]!.text, "done");
  }
});

test("cross-protocol golden: [text, image] multi-part user content splits to the same core pair", () => {
  const a = anthropicToCore({
    model: "claude-x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: IMG_DATA } },
        ],
      },
    ],
  }).msgs;
  const o = openaiToCore({
    model: "gpt-x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${IMG_DATA}` } },
        ],
      },
    ],
  }).msgs;
  const r = responsesToCore({
    model: "gpt-x",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "see this" },
          { type: "input_image", image_url: `data:image/png;base64,${IMG_DATA}` },
        ],
      },
    ],
  }).msgs;
  const g = googleToCore({
    contents: [
      {
        role: "user",
        parts: [
          { text: "see this" },
          { inlineData: { mimeType: "image/png", data: IMG_DATA } },
        ],
      },
    ],
  }).msgs;

  for (const msgs of [a, o, r, g]) {
    assert.equal(msgs.length, 2, "one core per content part");
    assert.equal(msgs[0]!.text, "see this");
    assert.equal(msgs[1]!.text, CANONICAL_IMAGE_TEXT);
    assert.equal(msgs[1]!.imageMediaType, "image/png");
    assert.equal(msgs[1]!.imageBase64, IMG_DATA);
  }
  const ids = [a, o, r, g].map((msgs) => msgs.map((m) => m.id));
  assert.deepEqual(ids[0], ids[1]);
  assert.deepEqual(ids[0], ids[2]);
  assert.deepEqual(ids[0], ids[3]);
});

test("cross-protocol golden: identical logical tool args in different key order yield the same id", () => {
  const a = anthropicToCore({
    model: "claude-x",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "edit", input: { file: "a.ts", line: 3 } }],
      },
    ],
  }).msgs;
  const o = openaiToCore({
    model: "gpt-x",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "edit", arguments: "{\"line\":3,\"file\":\"a.ts\"}" } },
        ],
      },
    ],
  }).msgs;
  const callA = a.find((m) => m.contentType === "tool-call")!;
  const callO = o.find((m) => m.contentType === "tool-call")!;
  assert.equal(callA.id, callO.id, "canonical args are key-sorted: wire key order is plumbing");
});

test("cross-protocol golden: deleting one of two sibling tool calls only renumbers its sibling suffix", () => {
  // IDENTICAL logical calls (same name+args) collide on the same base id and
  // are disambiguated by cluster suffix (_2, _3 …) in wire order.
  const call = (id: string) =>
    ({ type: "tool_use", id, name: "grep", input: { q: "same" } }) as never;
  const both = anthropicToCore({
    model: "claude-x",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [call("t1"), call("t2")] },
    ],
  }).msgs;
  const onlySecond = anthropicToCore({
    model: "claude-x",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [call("t2")] },
    ],
  }).msgs;
  const bothCalls = both.filter((m) => m.contentType === "tool-call").map((m) => m.id);
  const soloCall = onlySecond.filter((m) => m.contentType === "tool-call").map((m) => m.id);
  assert.match(bothCalls[0]!, /^h_[0-9a-f]+$/, "first twin takes the bare base id");
  assert.match(bothCalls[1]!, /_1$/, "second twin takes the _1 suffix");
  // Deleting the FIRST twin: the survivor's base id is unchanged; only its
  // suffix renumbers (_1 → bare). A deleted sibling is local damage, never a
  // global re-key of the conversation.
  assert.equal(bothCalls[1]!.replace(/_1$/, ""), soloCall[0]!);
  assert.notEqual(bothCalls[1], soloCall[0], "suffix renumbers when the earlier twin disappears");
});

/**
 * #3751 — payload-addressed image ids. Pre-#3751 every image shared one
 * base id (the "[image]" marker hash) and ClusterCounter `_N` ordinals told
 * them apart positionally: one image changing re-minted the whole family.
 * Now the seed carries the image's own fingerprint (bytes hash, URL
 * fallback), so family ordinals only disambiguate true duplicates.
 */

test("#3751: one image changing re-mints only its own core, never the sibling", () => {
  const conv = (imgB: string) =>
    openaiToCore({
      model: "gpt-x",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${IMG_DATA}` } },
            { type: "image_url", image_url: { url: `data:image/png;base64,${imgB}` } },
          ],
        },
      ],
    }).msgs;

  const before = conv("c2hvcA==");
  const after = conv("c2hvcEch");
  assert.equal(before.length, 2);
  assert.equal(after.length, 2);
  assert.equal(before[0]!.imageBase64, IMG_DATA);
  // THE invariant: the untouched sibling keeps its id byte-identical.
  assert.equal(after[0]!.id, before[0]!.id, "sibling image id stable");
  assert.notEqual(after[1]!.id, before[1]!.id, "changed image re-mints only itself");
  // No ordinals in either family (distinct fingerprints ⇒ distinct bases).
  for (const m of [...before, ...after]) assert.match(m.id, /^h_[0-9a-f]+$/);
});

test("#3751: byte-identical images share the base id and split via the _N ordinal", () => {
  const msgs = anthropicToCore({
    model: "claude-x",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: IMG_DATA } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: IMG_DATA } },
        ],
      },
    ],
  }).msgs;
  assert.equal(msgs.length, 2);
  assert.match(msgs[0]!.id, /^h_[0-9a-f]+$/, "first duplicate: bare base");
  assert.match(msgs[1]!.id, /^h_[0-9a-f]+_1$/, "second duplicate: _1 ordinal");
});

test("#3751: URL-referenced images degrade to the URL fingerprint (stable, distinct)", () => {
  const conv = (url: string) =>
    openaiToCore({
      model: "gpt-x",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }],
    }).msgs;
  const a1 = conv("https://cdn.example.com/a.png");
  const a2 = conv("https://cdn.example.com/a.png");
  const b = conv("https://cdn.example.com/b.png");
  assert.equal(a1[0]!.id, a2[0]!.id, "same URL ⇒ same id across turns");
  assert.notEqual(a1[0]!.id, b[0]!.id, "different URL ⇒ different id");
  // And a URL image never collides with the same-name data image (no bytes
  // on the wire — the URL is the only identity we have).
  const data = openaiToCore({
    model: "gpt-x",
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${IMG_DATA}` } }] },
    ],
  }).msgs;
  assert.notEqual(a1[0]!.id, data[0]!.id);
});

test("#3751: responses legacy single-image shape and split shape share one id", () => {
  const legacy = responsesToCore({
    model: "gpt-x",
    input: [
      { type: "message", role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${IMG_DATA}` }] },
    ],
  }).msgs;
  const split = responsesToCore({
    model: "gpt-x",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "" },
          { type: "input_image", image_url: `data:image/png;base64,${IMG_DATA}` },
        ],
      },
    ],
  }).msgs;
  assert.equal(legacy.length, 1);
  assert.equal(split.length, 1, "empty text part folds away");
  assert.equal(legacy[0]!.id, split[0]!.id, "same logical image ⇒ same id via both paths");
});
