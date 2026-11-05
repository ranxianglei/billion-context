import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// #3003: PARTIAL fold double-seam cost. When a multi-range compress batch has
// one length-class failure (summary over/under cap) among otherwise-valid
// folds, the old per-range commit landed the valid siblings FIRST (opening a
// seam) and the model then retried the bad range into a SECOND seam. The kernel
// now screens summary LENGTH all-or-nothing BEFORE any block commits: any
// length-class failure rejects the WHOLE batch (0 commits, 0 seams), so one
// retry pays once. Content-class failures (protected-zone / turn-integrity /
// no-new-messages) stay per-range. These tests pin both directions of the gate
// (#3617): it fires on a candidate's length failure, and it does NOT fire for
// a non-candidate range whose summary merely happens to be out of range.

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
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

test("a too-long summary in a multi-range batch rejects the WHOLE batch (#3003)", () => {
  const core = createCore();
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

  // Range A's summary exceeds maxSummaryLength (20); range B is within range.
  // Without the pre-check, B would land (seam #1) and A would retry (seam #2).
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "x".repeat(40), topic: "too long" },
      { startRef: "m00003", endRef: "m00004", summary: "ok", topic: "fine" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 0 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.equal(result.state.blocks.length, 0, "no block may exist after rejection");
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /Batch rejected before folding any range/);
  assert.match(
    result.result.errors[0]!,
    /range m00001\.\.m00002: Summary too long \(40 chars, max 20\)/,
  );
  assert.match(result.result.errors[0]!, /Nothing was folded, so no prefix was rewritten/);
  // Both actionable exits must be offered.
  assert.match(result.result.errors[0]!, /shorten or split/);
  assert.match(result.result.errors[0]!, /drop the offending range\(s\) and resend only the rest/);
});

test("a too-short summary in a multi-range batch rejects the WHOLE batch (#3003)", () => {
  const core = createCore();
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

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "y".repeat(60), topic: "fine" },
      { startRef: "m00003", endRef: "m00004", summary: "x".repeat(5), topic: "too short" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 50 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "the valid sibling must NOT land either");
  assert.equal(result.state.blocks.length, 0);
  assert.match(result.result.errors[0]!, /Batch rejected before folding any range/);
  assert.match(
    result.result.errors[0]!,
    /range m00003\.\.m00004: Summary too short \(5 chars, min 50\)/,
  );
});

test("a multi-range batch whose summaries all validate still commits every range (#3003 control)", () => {
  const core = createCore();
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

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "ok-a", topic: "a" },
      { startRef: "m00003", endRef: "m00004", summary: "ok-b", topic: "b" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 0 },
    }),
  });

  assert.equal(result.result.blocksCreated, 2, "both valid ranges commit");
  assert.equal(result.state.blocks.length, 2);
  assert.equal(result.result.errors.length, 0);
});

test("a non-candidate range with an oversized summary does NOT reject a valid fresh fold (#3003 scoping)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  // m00099..m00100 are valid-format but never allocated -> status "unknown",
  // never a fold candidate. Its oversized summary must be ignored by the
  // all-or-nothing length screen (checking it would wrongly kill the batch).
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00099", endRef: "m00100", summary: "z".repeat(500) },
      { startRef: "m00001", endRef: "m00002", summary: "ok", topic: "fine" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 0 },
    }),
  });

  assert.equal(result.result.blocksCreated, 1, "the valid candidate still commits");
  assert.equal(result.state.blocks.length, 1);
  assert.doesNotMatch(
    result.result.errors.join("\n"),
    /Batch rejected before folding any range/,
  );
  // The unknown ref is still reported per-range (content-class, unchanged).
  assert.match(result.result.errors.join("\n"), /m00099/);
});

test("a too-long refold summary rejects the WHOLE batch incl. a fresh sibling (#3003 refold direction)", () => {
  const core = createCore();
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

  // First fold m00001..m00002 into a block.
  const first = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "first fold", topic: "t" },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(first.result.blocksCreated, 1);
  const blockId = first.state.blocks[0]!.blockId;

  // Restore it inline so re-requesting its span classifies as a refold candidate.
  first.state.blocks.find((b) => b.blockId === blockId)!.restoredInline = true;

  // Second call: refold with an OVERSIZED new summary + a fresh valid sibling.
  // Without the pre-check the fresh sibling would land first (seam #1) and the
  // refold retry would pay seam #2; the gate must reject before either commits.
  const second = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "z".repeat(400) },
      { startRef: "m00003", endRef: "m00004", summary: "fresh ok", topic: "sib" },
    ],
    messages,
    state: first.state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 0 },
    }),
  });

  assert.equal(second.result.blocksCreated, 0, "nothing may commit");
  assert.equal(second.state.blocks.length, 1, "only the pre-existing block remains");
  assert.match(second.result.errors[0]!, /Batch rejected before folding any range/);
  assert.match(
    second.result.errors[0]!,
    /range m00001\.\.m00002: Summary too long \(400 chars, max 20\)/,
  );
  // Refold atomicity: the restored block keeps its old summary (no partial
  // in-place update may precede the batch rejection).
  const b1 = second.state.blocks.find((b) => b.blockId === blockId)!;
  assert.equal(b1.summary, "first fold");
});
