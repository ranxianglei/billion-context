import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeProtectedRefs,
  buildCompressibleRanges,
  mergeRangesToThreshold,
} from "../src/recommend.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type {
  Config,
  CompressionState,
  CompressibleRange,
  CoreMessage,
} from "../src/types.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function userMsg(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function textMsg(
  id: string,
  text: string,
  role: CoreMessage["role"],
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function reasoningMsg(id: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "reasoning", text };
}

function callMsg(
  id: string,
  toolName: string,
  toolCallId: string,
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId,
    text: `call ${toolName}`,
  };
}

function resultMsg(
  id: string,
  toolName: string,
  toolCallId: string,
): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName,
    toolCallId,
    text: `${toolName} output`,
  };
}

function assignAll(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

/** The live shape: a head that folds first, then a residual turn whose result
 *  half sits inside the protected zone. `preserveRecentMessages: 4` protects
 *  m00005..m00008, leaving the turn's reasoning (m00003) and call (m00004)
 *  compressible while its result (m00005) is not. */
function splitTurnFixture(): {
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
} {
  const messages = [
    userMsg("u0", "task"),
    textMsg("a0", "ack", "assistant"),
    reasoningMsg("r1", "thinking about the task"),
    callMsg("c1", "edit", "call_1"),
    resultMsg("t1", "edit", "call_1"),
    textMsg("a1", "summarized the read", "assistant"),
    userMsg("u1", "next"),
    textMsg("a2", "reply", "assistant"),
  ];
  const state = assignAll(messages);
  const configWithZone = config({ preserveRecentMessages: 4 });
  const head = createCore().applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "head recap" }],
    messages,
    state,
    config: configWithZone,
  });
  assert.deepEqual(head.result.errors, []);
  return { messages, state: head.state, config: configWithZone };
}

function recommend(
  messages: CoreMessage[],
  state: CompressionState,
  cfg: Config,
): CompressibleRange[] {
  const protectedRefs = computeProtectedRefs(messages, state, cfg);
  const ranges = buildCompressibleRanges(messages, state, cfg, protectedRefs);
  return mergeRangesToThreshold(
    ranges.compressible,
    cfg.compress.minCompressRange,
  );
}

test("recommended ranges are foldable: a turn split by the protected zone is not advertised", () => {
  const { messages, state, config: cfg } = splitTurnFixture();
  const recommended = recommend(messages, state, cfg);

  // Every range acp_status advertises must compress without error. Before the
  // integrity-aware filter this range was m00003-m00004 and the fold withdrew
  // both halves (call folded, result kept) leaving nothing to compress, so the
  // tool reported "Range would split 1 tool call/result pair(s)".
  for (const r of recommended) {
    const res = createCore().applyCompression({
      ranges: [{ startRef: r.startRef, endRef: r.endRef, summary: "fold it" }],
      messages,
      state,
      config: cfg,
    });
    assert.deepEqual(
      res.result.errors,
      [],
      `advertised range ${r.startRef}..${r.endRef} must fold`,
    );
  }

  assert.equal(
    recommended.length,
    0,
    "residue that the fold gate always withdraws must not be advertised as compressible",
  );
});

test("recommended ranges are foldable: a wholly compressible turn is still advertised", () => {
  const messages = [
    userMsg("u0", "task"),
    textMsg("a0", "ack", "assistant"),
    reasoningMsg("r1", "thinking about the task"),
    callMsg("c1", "edit", "call_1"),
    resultMsg("t1", "edit", "call_1"),
    textMsg("a1", "summarized the read", "assistant"),
    userMsg("u1", "next"),
    textMsg("a2", "reply", "assistant"),
  ];
  // Zone protects only the last two messages: the whole turn stays compressible.
  const cfg = config({ preserveRecentMessages: 2 });
  const state = assignAll(messages);
  const recommended = recommend(messages, state, cfg);

  assert.ok(
    recommended.length > 0,
    "a fully compressible turn must stay advertised",
  );
  const covering = recommended.find(
    (r) => r.startRef <= "m00003" && r.endRef >= "m00006",
  );
  assert.ok(
    covering,
    `expected a range covering the whole turn, got ${recommended
      .map((r) => `${r.startRef}..${r.endRef}`)
      .join(", ")}`,
  );
  const res = createCore().applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00006", summary: "turn recap" }],
    messages,
    state,
    config: cfg,
  });
  assert.deepEqual(res.result.errors, []);
  assert.equal(res.result.blocksCreated, 1);
});
