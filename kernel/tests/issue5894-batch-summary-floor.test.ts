import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// #5894 (batch compression failed on one short paragraph): the summary FLOOR
// used to be judged PER RANGE inside a batch, and #3003's all-or-nothing
// pre-check turned one short paragraph into a whole-batch rejection — whose
// own error text advised dropping the offender, which then failed ALONE
// against the same floor and spun. The floor now judges the BATCH: a call
// with >= 2 fold candidates passes when their COMBINED summaries reach
// minSummaryLength; a single folding candidate still guards its own summary.
// EMPTY and MAX stay per-range in every shape (#3617 both directions).

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

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
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 50 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function fourMsgState(): { state: ReturnType<typeof createInitialState>; messages: CoreMessage[] } {
  const state = createInitialState();
  const messages = [
    msg("a", "alpha"),
    msg("b", "beta"),
    msg("c", "gamma"),
    msg("d", "delta"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return { state, messages };
}

test("the issue shape: a 7-char paragraph in a 2-range batch lands when the total meets the floor", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "y".repeat(60), topic: "substance" },
      { startRef: "m00003", endRef: "m00004", summary: "no new info", topic: "trivial" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 2);
  assert.equal(result.state.blocks.length, 2);
  assert.equal(result.result.errors.length, 0);
  // The honest short summary is stored VERBATIM — no padding to the floor.
  const trivial = result.state.blocks.find((b) => b.topic === "trivial")!;
  assert.equal(trivial.summary, "no new info");
});

test("total exactly at the floor passes (boundary: < not <=)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "x".repeat(25) },
      { startRef: "m00003", endRef: "m00004", summary: "y".repeat(25) },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 2, "25 + 25 = 50 meets the floor");
  assert.equal(result.result.errors.length, 0);
});

test("a multi-range batch whose TOTAL is below the floor still rejects everything (#3003 atomicity kept)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "x".repeat(20) },
      { startRef: "m00003", endRef: "m00004", summary: "y".repeat(20) },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.equal(result.state.blocks.length, 0);
  assert.match(result.result.errors[0]!, /Batch rejected before folding any range/);
  assert.match(
    result.result.errors[0]!,
    /Batch summary too short \(40 chars across 2 ranges, min 50\)/,
  );
  assert.match(result.result.errors[0]!, /Nothing was folded, so no prefix was rewritten/);
});

test("a SINGLE folding range below the floor is still rejected with the legacy per-range message", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00004", summary: "tiny" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.state.blocks.length, 0);
  assert.match(
    result.result.errors.join("\n"),
    /range m00003\.\.m00004: Summary too short \(4 chars, min 50\)/,
  );
});

test("a resubmitted covered range counts as a candidate — its summary joins the batch total (#4521 no-op shape)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const first = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "y".repeat(60), topic: "t" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(first.result.blocksCreated, 1);

  // Full-log hosts classify a covered span as "ok", never "consumed" (#4521):
  // the resubmit stays a fold candidate in the pre-check even though it ends
  // as a no-op at apply time. Its summary therefore joins the batch total, so
  // the short fresh range lands (60 + 4 >= 50) with a no-op warning instead
  // of a whole-batch rejection.
  const second = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "y".repeat(60), topic: "again" },
      { startRef: "m00003", endRef: "m00004", summary: "tiny" },
    ],
    messages,
    state: first.state,
    config: config(),
  });

  assert.equal(second.result.blocksCreated, 1, "only the fresh range folds");
  assert.equal(second.state.blocks.length, 2, "pre-existing block + the new short one");
  assert.equal(second.result.errors.length, 0);
  assert.match(second.result.warnings.join("\n"), /folded nothing/);
});

test("an EMPTY summary is still rejected per range even when the sibling total is large", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "y".repeat(60) },
      { startRef: "m00003", endRef: "m00004", summary: "" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0, "empty means nothing recorded for that span — no total rescue");
  assert.equal(result.state.blocks.length, 0);
  assert.match(result.result.errors[0]!, /Batch rejected before folding any range/);
  assert.match(
    result.result.errors[0]!,
    /range m00003\.\.m00004: Summary is empty/,
  );
});

test("an OVERSIZED summary still rejects the whole batch under the batch-total rule (MAX stays per-range)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "z".repeat(40) },
      { startRef: "m00003", endRef: "m00004", summary: "y".repeat(60) },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 50 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.state.blocks.length, 0);
  assert.match(result.result.errors[0]!, /Batch rejected before folding any range/);
  assert.match(
    result.result.errors[0]!,
    /range m00001\.\.m00002: Summary too long \(40 chars, max 20\)/,
  );
});

test("a non-candidate (unknown-ref) range neither counts toward nor poisons the batch total (#3003 scoping kept)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00099", endRef: "m00100", summary: "zzz" },
      { startRef: "m00001", endRef: "m00002", summary: "y".repeat(60) },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1, "the valid candidate still commits alone");
  assert.equal(result.state.blocks.length, 1);
  assert.doesNotMatch(
    result.result.errors.join("\n"),
    /Batch rejected before folding any range/,
  );
  assert.match(result.result.errors.join("\n"), /m00099/);
});

test("a short REFOLD summary lands alongside a long fresh sibling (flag threads through applyRefolds)", () => {
  const core = createCore();
  const { state, messages } = fourMsgState();

  const first = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "f".repeat(60), topic: "t" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(first.result.blocksCreated, 1);
  first.state.blocks.find((b) => b.blockId === first.state.blocks[0]!.blockId)!.restoredInline = true;

  // Refold (5-char summary) + fresh sibling (60): combined 65 >= 50. Without
  // the flag threading, applyRefolds' own per-range min would re-fire at
  // apply time and reject the whole batch after the pre-check passed.
  const second = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "x".repeat(5), topic: "refolded" },
      { startRef: "m00003", endRef: "m00004", summary: "y".repeat(60), topic: "sib" },
    ],
    messages,
    state: first.state,
    config: config(),
  });

  assert.equal(second.result.blocksCreated, 2, "refold (1 updated) + fresh (1 new)");
  assert.equal(second.state.blocks.length, 2);
  assert.equal(second.result.errors.length, 0);
  const refolded = second.state.blocks.find((b) => b.topic === "refolded")!;
  assert.equal(refolded.summary, "x".repeat(5));
});
