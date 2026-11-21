import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6730: the batch-rejection remediation text must point the SAME direction as
// the length failure that fired. The old single generic string said "shorten
// or split each offending range's summary to fit its cap" for EVERY length
// failure — so a too-short summary was told to shorten, which made it shorter,
// and the model retried into a guaranteed-fail loop (full context re-read each
// round) until the circuit breaker fired. Now the remediation is direction-
// aware: too-short/empty → "expand / do NOT shorten", too-long → "shorten or
// split", mixed → both. These tests pin BOTH directions (#3617): the too-short
// case must NOT carry the backwards "shorten to fit its cap" advice, and the
// too-long case must still carry it.

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

function refs(state: ReturnType<typeof createInitialState>, n: number) {
  const messages = Array.from({ length: n }, (_, i) =>
    msg(`m${i}`, `text ${i}`),
  );
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return messages;
}

test("a too-short summary's rejection advises GROW, not shorten (#6730)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = refs(state, 2);

  // Solo candidate, summary below the 50-char floor -> "Summary too short".
  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "tiny", topic: "t" }],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 50 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.match(result.result.errors[0]!, /Batch rejected before folding any range/);
  assert.match(result.result.errors[0]!, /Summary too short \(4 chars, min 50\)/);
  // The backwards advice must be GONE for the too-short case.
  assert.doesNotMatch(result.result.errors[0]!, /shorten or split/);
  assert.doesNotMatch(result.result.errors[0]!, /to fit its cap/);
  // The correct direction must be present.
  assert.match(result.result.errors[0]!, /expand each too-short\/empty summary/);
  assert.match(result.result.errors[0]!, /do NOT shorten it/);
  // The drop exit is still offered.
  assert.match(result.result.errors[0]!, /drop the offending range\(s\) and resend only the rest/);
});

test("a too-long summary's rejection STILL advises shorten-or-split (#6730 control)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = refs(state, 2);

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "x".repeat(40), topic: "t" }],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 0 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.match(result.result.errors[0]!, /Summary too long \(40 chars, max 20\)/);
  // The too-long direction keeps its advice.
  assert.match(result.result.errors[0]!, /shorten or split each too-long summary to fit its cap/);
  // And must NOT carry the grow advice.
  assert.doesNotMatch(result.result.errors[0]!, /expand each too-short/);
  assert.doesNotMatch(result.result.errors[0]!, /do NOT shorten it/);
});

test("a mixed batch (one too-short + one too-long) carries BOTH directions (#6730)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = refs(state, 4);

  // Range A too long (40 > max 20); range B too short (4 < min 50). Both are
  // fold candidates, so the batch is rejected all-or-nothing with a mixed set
  // of length failures.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "x".repeat(40), topic: "long" },
      { startRef: "m00003", endRef: "m00004", summary: "tiny", topic: "short" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 20, minSummaryLength: 50 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.match(result.result.errors[0]!, /Summary too long \(40 chars, max 20\)/);
  // Multi-candidate path waives the per-range min (skipMin) and judges the
  // COMBINED total, so the too-short direction here is the batch-total failure
  // (40 + 4 = 44 < 50), not a per-range "Summary too short".
  assert.match(result.result.errors[0]!, /Batch summary too short \(44 chars across 2 ranges, min 50\)/);
  // BOTH directions must be present so each offending range gets the right advice.
  assert.match(result.result.errors[0]!, /expand each too-short\/empty summary/);
  assert.match(result.result.errors[0]!, /shorten or split each too-long summary to fit its cap/);
});

test("a batch whose combined total is too short advises GROW (#6730 batch-floor)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = refs(state, 4);

  // Two candidates, each individually over the (waived) per-range min, but the
  // COMBINED total (5 + 5 = 10) is below the 50-char floor -> "Batch summary
  // too short". The remediation must point GROW, not shorten.
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "aaaaa", topic: "a" },
      { startRef: "m00003", endRef: "m00004", summary: "bbbbb", topic: "b" },
    ],
    messages,
    state,
    config: config({
      compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 50 },
    }),
  });

  assert.equal(result.result.blocksCreated, 0, "nothing may commit");
  assert.match(result.result.errors[0]!, /Batch summary too short \(10 chars across 2 ranges, min 50\)/);
  assert.doesNotMatch(result.result.errors[0]!, /shorten or split/);
  assert.match(result.result.errors[0]!, /expand each too-short\/empty summary/);
  assert.match(result.result.errors[0]!, /do NOT shorten it/);
});
