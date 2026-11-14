import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

// #5891: a signed reasoning run whose companion Read tool-call/result sits
// outside the recent zone (neverPreserveRecentTools) may be folded while the
// signature-verified thinking stays visible — the orphan desynchronizes the
// signature and every later Anthropic request 400s ("thinking ... blocks
// cannot be modified"). Symptom invariant pinned here: a fold may never take
// the companion act without taking (or withdrawing) the signed run.
type SignedCore = CoreMessage & { thinkingSignature?: string };

const config = () => defaultConfig(100_000);

function buildMessages(): SignedCore[] {
  return [
    {
      id: "u",
      role: "user",
      contentType: "text",
      text: "Read data.log and report record 42",
    },
    {
      id: "th1",
      role: "assistant",
      contentType: "reasoning",
      text: "thinking-a ",
      thinkingSignature: "sig-1",
    },
    {
      id: "c1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "Read",
      toolCallId: "t1",
      text: "{}",
    },
    {
      id: "r1",
      role: "tool",
      contentType: "tool-result",
      toolName: "Read",
      toolCallId: "t1",
      text: "x".repeat(40_000),
    },
    {
      id: "th2",
      role: "assistant",
      contentType: "reasoning",
      text: "thinking-b ",
      thinkingSignature: "sig-2",
    },
    {
      id: "c2",
      role: "assistant",
      contentType: "tool-call",
      toolName: "Grep",
      toolCallId: "t2",
      text: "{}",
    },
    {
      id: "r2",
      role: "tool",
      contentType: "tool-result",
      toolName: "Grep",
      toolCallId: "t2",
      text: "42",
    },
  ];
}

function foldRange(startId: string, endId: string) {
  const messages = buildMessages();
  const core = createCore();
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config: config(),
    tokenCount: (t) => Math.ceil(t.length / 4),
  }).state;
  const refs = state.messageRefs.byRaw;
  const res = core.applyCompression({
    state,
    messages,
    config: config(),
    ranges: [{ startRef: refs[startId]!, endRef: refs[endId]!, summary: "s".repeat(400) }],
  });
  return res.state.blocks.filter((b) => b.active).map((b) => new Set(b.effectiveMessageIds));
}

describe("issue5891 recent-zone signed-thinking orphan", () => {
  it("folding the Read exchange alone must not strand its signed thinking", () => {
    for (const ids of foldRange("c1", "r1")) {
      assert.ok(
        !ids.has("c1") || ids.has("th1"),
        `orphaned signed thinking: block ${[...ids].join(",")} folded c1 without th1`,
      );
    }
  });

  it("a range spanning the signed run plus the exchange must not carve the run out", () => {
    for (const ids of foldRange("th1", "r1")) {
      assert.ok(
        !ids.has("c1") || ids.has("th1"),
        `orphaned signed thinking: block ${[...ids].join(",")} folded c1 without th1`,
      );
    }
  });
});
