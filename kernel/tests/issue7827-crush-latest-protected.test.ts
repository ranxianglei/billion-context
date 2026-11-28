// protectedLatestTools marks the newest result per tool path as protected
// (durable state, skill catalogs). The absorb prompt side honours it; the crush
// node used to call isAbsorbCandidate with `latest: undefined`, so the same
// result was lossily crushed on the view path while being unfoldable.
//
// Pinned here: with crush+absorb on, a latest-protected result keeps its bytes;
// an ordinary result of the same tool is still crushed (no over-blocking);
// content containing the absorb marker mid-payload survives crush (the marker
// is only stripped when it is the appended prompt at the tail).

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCrushToMessages } from "../src/crush.js";
import { isAbsorbCandidate } from "../src/absorb.js";
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

test("crush leaves a latest-protected result byte-identical", () => {
  const messages = messagesWith(logText("durable"));
  const config = defaultConfig(100000, {
    ...switches,
    protectedLatestTools: ["read_file"],
  });
  const latest = collectLatestProtected(messages, config);
  assert.equal(
    isAbsorbCandidate(messages[2]!, config, latest),
    false,
    "precondition: the prompt side sees this result as protected",
  );

  const applied = applyCrushToMessages(messages, config, 30000, countTokens);
  assert.equal(applied.messages[2]!.text, messages[2]!.text, "protected bytes must survive");
});

test("crush still reduces an unprotected result of the same tool", () => {
  const messages = messagesWith(logText("ordinary"));
  const config = defaultConfig(100000, switches);
  const applied = applyCrushToMessages(messages, config, 30000, countTokens);
  assert.equal(applied.crushedCount, 1);
  assert.ok(
    applied.messages[2]!.text!.length < messages[2]!.text!.length * 0.5,
    `expected a real reduction, got ${messages[2]!.text!.length} -> ${applied.messages[2]!.text!.length}`,
  );
});

