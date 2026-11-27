// A tool result that merely CONTAINS the "[ACP absorb]" marker (a transcript, a
// log, this project's own source) used to be sliced at the FIRST occurrence,
// deleting everything after it from the view. The marker is only a stale prompt
// when it is the canonical prompt the kernel APPENDED at the tail.
//
// Pinned here: mid-payload markers keep their trailing data, a real appended
// prompt is still stripped before crushing, and near-miss tails are left alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCrushToMessages, stripTrailingAbsorbPrompt } from "../src/crush.js";
import { ABSORB_PROMPT_MARKER, buildAbsorbPrompt } from "../src/absorb.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { collectLatestProtected } from "../src/protected.js";
import type { CoreMessage } from "../src/types.js";

const countTokens = (text: string) => Math.ceil(text.length / 4);

const logText = (tag: string): string =>
  Array.from({ length: 900 }, (_, i) =>
    i % 50 === 0
      ? `ERROR ${tag} failed step ${i}`
      : `2026-11-27 INFO step ${i} ok ${"p".repeat(20)}`,
  ).join("\n");

function messagesWith(text: string): CoreMessage[] {
  return [
    { id: "u0", role: "user", contentType: "text", text: "go" },
    {
      id: "c0",
      role: "assistant",
      contentType: "tool-call",
      toolName: "read_file",
      toolCallId: "call0",
      text: '{"path":"/state/log"}',
    },
    {
      id: "r0",
      role: "tool",
      contentType: "tool-result",
      toolName: "read_file",
      toolCallId: "call0",
      text,
    },
    { id: "u1", role: "user", contentType: "text", text: "next" },
  ];
}

const switches = {
  crush: { enabled: true, minReduction: 0.1 },
  absorb: {
    enabled: true,
    toolName: "acp_absorb",
    minToolTokens: 4000,
    contextThresholdPct: 0,
    excludeTools: [] as string[],
  },
};

test("a payload that legitimately contains the marker keeps everything after it", () => {
  const body = logText("before") + "\n[ACP absorb] This tool result will be REMOVED from context.\n" + logText("after");
  const messages = messagesWith(body);
  const config = defaultConfig(100000, switches);
  const applied = applyCrushToMessages(messages, config, 30000, countTokens);
  const out = applied.messages[2]!.text!;
  assert.ok(out.includes("ERROR after failed step 0"), "data after a mid-payload marker must survive");
  assert.ok(out.startsWith("ERROR before failed step 0"));
});

test("the appended absorb prompt is still stripped before crushing", () => {
  const payload = logText("plain");
  const prompt = buildAbsorbPrompt("m00003", 9000, "acp_absorb");
  assert.equal(stripTrailingAbsorbPrompt(payload + "\n\n" + prompt), payload);

  const messages = messagesWith(payload + "\n\n" + prompt);
  const config = defaultConfig(100000, switches);
  const applied = applyCrushToMessages(messages, config, 30000, countTokens);
  assert.ok(
    !applied.messages[2]!.text!.includes(ABSORB_PROMPT_MARKER),
    "a stale appended prompt must not survive the view pass",
  );
});

test("marker stripping requires the canonical prompt shape at the tail", () => {
  const payload = "line\n\n[ACP absorb] something else entirely\nmore";
  assert.equal(stripTrailingAbsorbPrompt(payload), payload);
  const trailingJunk = "body\n\n[ACP absorb] This tool result (~9K tokens) will be REMOVED from context. but not the real prompt";
  assert.equal(stripTrailingAbsorbPrompt(trailingJunk), trailingJunk);
});
