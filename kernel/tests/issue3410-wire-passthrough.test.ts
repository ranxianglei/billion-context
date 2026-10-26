import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToCore, coreToAnthropic } from "../src/wire/anthropic.js";
import {
  hasMediaPayload,
  hasUnrecoverableMediaPayload,
} from "../src/protected.js";

// #3410: unknown top-level block types (in the wild today: document/PDF)
// fell out of anthropicToCore's switch silently — the payload vanished on
// every rebuild with no warning. The fix rides them on rawAnthropicBlock
// like image/redacted_thinking; these tests pin the round-trip fidelity and
// the fold protection that keeps the payload from being destroyed by a
// later compression.

const DOCUMENT = {
  type: "document",
  source: {
    type: "base64",
    media_type: "application/pdf",
    data: "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoK",
  },
  cache_control: { type: "ephemeral" },
};

function userBody(content: object[]) {
  return { messages: [{ role: "user", content }] };
}

function coreFields(m: { [k: string]: unknown }) {
  return {
    id: m.id,
    role: m.role,
    contentType: m.contentType,
    text: m.text,
    rawAnthropicBlock: m.rawAnthropicBlock,
  };
}

test("round-trips an unknown document block byte-exact (#3410)", () => {
  const body = userBody([{ type: "text", text: "summarize this pdf" }, DOCUMENT]);
  const parsed = anthropicToCore(body as never);
  assert.equal(parsed.msgs.length, 2);
  const doc = parsed.msgs[1] as { [k: string]: unknown };
  assert.equal(doc.contentType, "text");
  assert.equal(doc.text, "[document]");
  assert.deepEqual(doc.rawAnthropicBlock, DOCUMENT);

  const rebuilt = coreToAnthropic(parsed.msgs as never);
  assert.equal(rebuilt.length, 1);
  // The label text never reaches the wire; the original block goes out
  // verbatim, cache_control included.
  assert.deepEqual(rebuilt[0], {
    role: "user",
    content: [{ type: "text", text: "summarize this pdf" }, DOCUMENT],
  });
});

test("preserves block order when the unknown block leads", () => {
  const body = userBody([DOCUMENT, { type: "text", text: "and this" }]);
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  assert.deepEqual(rebuilt[0]!.content, [DOCUMENT, { type: "text", text: "and this" }]);
});

test("keeps multiple unknown block types verbatim", () => {
  const future = { type: "future_block", foo: 1 };
  const body = userBody([
    { type: "text", text: "t" },
    DOCUMENT,
    future,
  ]);
  const rebuilt = coreToAnthropic(anthropicToCore(body as never).msgs as never);
  assert.deepEqual(rebuilt[0]!.content, [
    { type: "text", text: "t" },
    DOCUMENT,
    future,
  ]);
});

test("preserves unknown blocks on assistant messages", () => {
  const serverTool = { type: "server_tool_use", id: "st_1", name: "web_search" };
  const body = { messages: [{ role: "assistant", content: [serverTool] }] };
  const parsed = anthropicToCore(body as never);
  assert.equal((parsed.msgs[0] as { [k: string]: unknown }).role, "assistant");
  const rebuilt = coreToAnthropic(parsed.msgs as never);
  assert.deepEqual(rebuilt[0], { role: "assistant", content: [serverTool] });
});

test("unknown-block cores are media AND unrecoverable — folding would destroy them", () => {
  const parsed = anthropicToCore(userBody([DOCUMENT]) as never);
  assert.equal(hasMediaPayload(parsed.msgs[0] as never), true);
  assert.equal(hasUnrecoverableMediaPayload(parsed.msgs[0] as never), true);
});

test("known sidecar classifications stay unchanged (parity pins)", () => {
  const base64Img = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QQ==" },
  };
  const urlImg = {
    type: "image",
    source: { type: "url", url: "https://example.com/x.png" },
  };
  const redacted = { type: "redacted_thinking", data: "REDACTED==" };
  const cores = anthropicToCore(
    userBody([base64Img, urlImg, redacted, { type: "text", text: "plain" }]) as never,
  ).msgs as { [k: string]: unknown }[];
  // archivable base64 image: media yes, unrecoverable no (host spills to disk)
  assert.equal(hasMediaPayload(cores[0] as never), true);
  assert.equal(hasUnrecoverableMediaPayload(cores[0] as never), false);
  // URL image: unrecoverable (no local archive)
  assert.equal(hasMediaPayload(cores[1] as never), true);
  assert.equal(hasUnrecoverableMediaPayload(cores[1] as never), true);
  // redacted_thinking: existing parity — not media-classified here
  assert.equal(hasMediaPayload(cores[2] as never), false);
  assert.equal(hasUnrecoverableMediaPayload(cores[2] as never), false);
  // plain text: neither
  assert.equal(hasMediaPayload(cores[3] as never), false);
  assert.equal(hasUnrecoverableMediaPayload(cores[3] as never), false);
});

test("ids are deterministic across repeated parses; duplicates stay distinct and stable", () => {
  const body = userBody([DOCUMENT, { type: "text", text: "t" }, DOCUMENT]);
  const once = anthropicToCore(body as never).msgs.map(coreFields);
  const twice = anthropicToCore(body as never).msgs.map(coreFields);
  assert.deepEqual(twice, once);
  const docIds = [once[0]!.id, once[2]!.id] as string[];
  assert.notEqual(docIds[0], docIds[1]);
});

test("parse is a structural fixed point over rebuild", () => {
  const body = userBody([
    { type: "text", text: "before" },
    DOCUMENT,
    { type: "text", text: "after" },
  ]);
  const first = anthropicToCore(body as never).msgs.map(coreFields);
  const rebuilt = coreToAnthropic(
    anthropicToCore(body as never).msgs as never,
  );
  const second = anthropicToCore({ messages: rebuilt } as never).msgs.map(coreFields);
  assert.deepEqual(second, first);
});
