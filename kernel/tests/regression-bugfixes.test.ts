import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { renderVisibleRefs } from "../src/render-refs.js";
import { runPipeline, makeIO } from "../src/pipeline.js";
import type { Config, CoreMessage } from "../src/types.js";

// Regression tests for bugs A-F found by the 3-way independent review. Each
// test is structured to FAIL against the pre-fix code and PASS after the fix.

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCall(id: string, toolName: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    text: `call ${toolName}`,
  };
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

// Bug A + E: resolveTargetTier always returned 1, so compressing T2 blocks
// produced another T2 (not T3) and never consumed the nested T2 block.
test("T2->T3 escalation: compressing a T2 block yields T3 and consumes the T2", () => {
  const core = createCore();
  let state = createInitialState();
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

  // T1: compress m00001-m00002 -> b1 (tier 1)
  const t1 = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "t1 a-b" }],
    messages,
    state,
    config: config(),
  });
  state = t1.state;
  assert.equal(state.blocks[0]!.tier, 1);

  // T2: compress b1 -> b2 (tier 2), b1 consumed
  const t2 = core.applyCompression({
    ranges: [{ startRef: "b1", endRef: "b1", summary: "t2 distil b1" }],
    messages,
    state,
    config: config(),
  });
  state = t2.state;
  assert.equal(state.blocks[1]!.tier, 2);
  assert.equal(state.blocks[0]!.active, false);

  // T3: compress b2 -> b3 (tier 3), b2 consumed. Before the fix this produced
  // a tier-2 block and left b2 active (duplicate coverage).
  const t3 = core.applyCompression({
    ranges: [{ startRef: "b2", endRef: "b2", summary: "t3 distil b2" }],
    messages,
    state,
    config: config(),
  });

  const b3 = t3.state.blocks[2]!;
  const b2 = t3.state.blocks[1]!;
  assert.equal(b3.tier, 3, "compressing a T2 block must produce T3");
  assert.equal(b2.active, false, "the consumed T2 block must be deactivated");
  assert.deepEqual(
    b3.effectiveMessageIds.sort(),
    ["a", "b"],
    "T3 inherits the full lineage coverage",
  );
  assert.deepEqual(b3.directBlockIds, ["b2"], "T3 records b2 as consumed");
});

// Bug B: computeCompressibleRanges used refForIndex(i) = m{index+1} instead of
// the actual assigned ref, so ranges were wrong whenever a BLOCKED message
// skipped a number (or refs carried over from earlier turns).
test("compressibleRanges use real assigned refs, not array-index arithmetic", () => {
  const core = createCore();
  const state = createInitialState();
  // A protected tool-call sits in the middle: it gets BLOCKED and skips a
  // number, so c's real ref is m00002 (not m00003 as index arithmetic gives).
  const messages = [
    msg("a", "alpha content"),
    toolCall("p", "skill"),
    msg("c", "gamma content", "assistant"),
    msg("d", "delta content"),
    msg("e", "epsilon content", "assistant"),
    msg("f", "zeta content"),
    msg("g", "eta content", "assistant"),
  ];

  const result = core.processTurn({
    messages,
    state,
    // minPressureBenefitTokens: 0 = legacy any-pending pressure injection; this test exercises ref assignment, not the #198 benefit gate.
    config: config({
      protectedTools: ["skill"],
      preserveRecentMessages: 2,
      nudge: { ...config().nudge, growthRatio: 0, minPressureBenefitTokens: 0 },
    }),
    tokenCount: 99000,
  });

  assert.equal(result.nudge!.shouldInject, true);
  const ranges = result.nudge!.compressibleRanges;
  assert.ok(ranges.length >= 1, "compressible ranges reported");

  // Protected tool messages are classified separately, not into compressibleMsgs.
  // So compressible a,c,d,e,g form ranges with REAL assigned refs:
  // a=m00001, c=m00002, d=m00003, e=m00004. (f=m00005 is last user msg, protected by Rule 3.)
  const range = ranges[0]!;
  assert.equal(
    range.startRef,
    "m00001",
    "startRef must be a's real assigned ref",
  );
  assert.equal(
    range.endRef,
    "m00004",
    "endRef must be e's real assigned ref (f protected)",
  );
});

// Bug C: processTurn mutated the caller's state.nudge because syncBlocks only
// shallow-spread state, sharing the nudge object by reference.
test("processTurn does not mutate the caller's input state.nudge", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "hello"), msg("b", "world")];

  const baselineBefore = state.nudge.lastPerMessageNudgeTokens;
  const shownBefore = state.nudge.lastNudgeShownTokens;
  assert.equal(baselineBefore, 0);
  assert.equal(shownBefore, 0);

  // minPressureBenefitTokens: 0 = legacy any-pending pressure injection; this test exercises input-state immutability, not the #198 benefit gate.
  const result = core.processTurn({
    messages,
    state,
    config: config({
      nudge: { ...config().nudge, growthRatio: 0, minPressureBenefitTokens: 0 },
    }),
    tokenCount: 99000,
  });

  // The RETURNED state must carry the stamped baseline ...
  assert.equal(result.state.nudge.lastNudgeShownTokens, 99000);
  assert.equal(result.state.nudge.lastPerMessageNudgeTokens, 99000);
  // ... but the INPUT state must be untouched.
  assert.equal(
    state.nudge.lastPerMessageNudgeTokens,
    baselineBefore,
    "input state.nudge baseline must not be mutated",
  );
  assert.equal(
    state.nudge.lastNudgeShownTokens,
    shownBefore,
    "input state.nudge shown must not be mutated",
  );
  assert.notEqual(
    result.state.nudge,
    state.nudge,
    "returned nudge must be a separate object",
  );
});

// Bug D: applySingleRange called advanceSurvival once per range inside the
// batch loop, so a 3-range compress inflated every block's survivedCount by 3
// (plus the per-turn advance). Survival must advance once per turn only.
test("batch applyCompression does not advance survival per range", () => {
  const core = createCore();
  let state = createInitialState();
  const messages = Array.from({ length: 12 }, (_, i) =>
    msg(`m${i}`, `content ${i}`),
  );
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  // Pre-existing block b1 at survivedCount 0.
  const pre = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00001", summary: "pre-existing" }],
    messages,
    state,
    config: config(),
  });
  state = pre.state;
  const b1 = state.blocks[0]!;
  assert.equal(b1.survivedCount, 0);

  // Batch 3 disjoint ranges in one applyCompression call.
  const batch = core.applyCompression({
    ranges: [
      { startRef: "m00003", endRef: "m00004", summary: "range 1" },
      { startRef: "m00006", endRef: "m00007", summary: "range 2" },
      { startRef: "m00009", endRef: "m00010", summary: "range 3" },
    ],
    messages,
    state,
    config: config(),
  });

  const after = batch.state;
  // Before the fix b1.survivedCount would be 3 (one advanceSurvival per range).
  assert.equal(
    after.blocks[0]!.survivedCount,
    0,
    "applyCompression must not advance survival at all",
  );
  // Every newly created block also starts at 0, not 1/2/3.
  for (const block of after.blocks) {
    assert.equal(
      block.survivedCount,
      0,
      `block ${block.blockId} must not have inflated survivedCount`,
    );
  }

  // And processTurn advances survival exactly once.
  const turn = core.processTurn({
    messages,
    state: after,
    config: config(),
    tokenCount: 1000,
  });
  for (const block of turn.state.blocks) {
    if (block.active) {
      assert.equal(
        block.survivedCount,
        1,
        `processTurn must advance each active block exactly once (${block.blockId})`,
      );
    }
  }
});

// Bug C generalization (3-way review): nudgeNode mutated io.state.nudge in
// place; the default pipeline hid it because sync-blocks deep-clones first, but
// a composable host excluding sync-blocks leaked the stamp to caller input.
test("composable pipeline excluding sync-blocks must not leak nudge mutations to caller state", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "hello"), msg("b", "world")];
  // minPressureBenefitTokens: 0 = legacy any-pending pressure injection; this test exercises pipeline composition, not the #198 benefit gate.
  const cfg = config({
    nudge: { ...config().nudge, growthRatio: 0, minPressureBenefitTokens: 0 },
  });

  const nodes = core.defaultNodes().filter((n) => n.name !== "sync-blocks");
  const initial = makeIO(messages, state);
  const ctx = {
    config: cfg,
    tokenCount: 99000,
  };

  const baselineBefore = state.nudge.lastPerMessageNudgeTokens;
  const shownBefore = state.nudge.lastNudgeShownTokens;

  const result = runPipeline(nodes, initial, ctx);

  assert.equal(result.state.nudge.lastNudgeShownTokens, 99000);
  assert.equal(result.state.nudge.lastPerMessageNudgeTokens, 99000);
  assert.equal(
    state.nudge.lastPerMessageNudgeTokens,
    baselineBefore,
    "input state.nudge baseline must not be mutated without sync-blocks",
  );
  assert.equal(
    state.nudge.lastNudgeShownTokens,
    shownBefore,
    "input state.nudge shown must not be mutated without sync-blocks",
  );
  assert.notEqual(result.state.nudge, state.nudge);
});

// 3-way review: render-refs must preserve user content that starts with
// ref-like tokens from the OLD format. With XML tags, [mNNNNN] is just text.
test("render-refs preserves user content that starts with a ref-like token", () => {
  const state = createInitialState();
  const messages = [
    msg("a", "[m1] is my first point"),
    msg("b", "[m00005] please review"),
    msg("c", "[m00003] [m00003] dup tags"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const rendered = renderVisibleRefs(messages, state);

  assert.match(
    rendered[0]!.text!,
    /^<acp tokens="\d+" type="text">m00001<\/acp>\n\[m1\] is my first point$/,
  );
  assert.match(
    rendered[1]!.text!,
    /^<acp tokens="\d+" type="text">m00002<\/acp>\n\[m00005\] please review$/,
  );
  assert.match(
    rendered[2]!.text!,
    /^<acp tokens="\d+" type="text">m00003<\/acp>\n\[m00003\] \[m00003\] dup tags$/,
  );
});

test("render-refs is idempotent across repeated renders", () => {
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "[m00002] beta")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const once = renderVisibleRefs(messages, state);
  const twice = renderVisibleRefs(once, state);
  assert.deepEqual(
    once.map((m) => m.text),
    twice.map((m) => m.text),
  );
  assert.match(
    once[0]!.text!,
    /^<acp tokens="\d+" type="text">m00001<\/acp>\nalpha$/,
  );
  assert.match(
    once[1]!.text!,
    /^<acp tokens="\d+" type="text">m00002<\/acp>\n\[m00002\] beta$/,
  );
});

test("batch: overlapping ranges warn and skip (earliest wins) instead of failing", () => {
  const core = createCore();
  const messages = [
    msg("a", "x".repeat(2000)),
    msg("b", "x".repeat(2000)),
    msg("c", "x".repeat(2000)),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "ab summary" },
      { startRef: "m00002", endRef: "m00003", summary: "bc summary" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(
    result.result.errors.length,
    0,
    "overlap is non-fatal — no errors",
  );
  assert.equal(
    result.result.blocksCreated,
    1,
    "the earlier range is still compressed",
  );
  assert.ok(
    result.result.warnings.some((w) => /overlaps an earlier range/i.test(w)),
    "a warning is recorded for the skipped range",
  );
});

test("batch: non-overlapping ranges all succeed", () => {
  const core = createCore();
  const messages = [
    msg("a", "x".repeat(2000)),
    msg("b", "x".repeat(2000)),
    msg("c", "x".repeat(2000)),
    msg("d", "x".repeat(2000)),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "ab summary" },
      { startRef: "m00003", endRef: "m00004", summary: "cd summary" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 2);
  assert.equal(result.result.errors.length, 0);
});

test("batch: disjoint range still compresses when two others overlap", () => {
  const core = createCore();
  const messages = [
    msg("a", "x".repeat(2000)),
    msg("b", "x".repeat(2000)),
    msg("c", "x".repeat(2000)),
    msg("d", "x".repeat(2000)),
    msg("e", "x".repeat(2000)),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "ab summary" },
      {
        startRef: "m00002",
        endRef: "m00003",
        summary: "bc summary (overlaps ab)",
      },
      {
        startRef: "m00004",
        endRef: "m00005",
        summary: "de summary (disjoint)",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.errors.length, 0);
  assert.equal(result.result.blocksCreated, 2);
  assert.ok(
    result.result.warnings.some((w) => /overlaps an earlier range/i.test(w)),
    "an overlap warning is recorded",
  );
});

test("batch: overlap resolved deterministically regardless of input order", () => {
  const core = createCore();
  const messages = [
    msg("a", "x".repeat(2000)),
    msg("b", "x".repeat(2000)),
    msg("c", "x".repeat(2000)),
    msg("d", "x".repeat(2000)),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const run = (
    ranges: Parameters<typeof core.applyCompression>[0]["ranges"],
  ) => {
    const fresh = createInitialState();
    fresh.messageRefs = state.messageRefs;
    return core.applyCompression({
      ranges,
      messages,
      state: fresh,
      config: config(),
    });
  };

  const sorted = run([
    { startRef: "m00001", endRef: "m00002", summary: "ab summary" },
    {
      startRef: "m00002",
      endRef: "m00003",
      summary: "bc summary (overlaps ab)",
    },
    {
      startRef: "m00003",
      endRef: "m00004",
      summary: "cd summary (disjoint from ab)",
    },
  ]);
  const shuffled = run([
    {
      startRef: "m00003",
      endRef: "m00004",
      summary: "cd summary (disjoint from ab)",
    },
    {
      startRef: "m00002",
      endRef: "m00003",
      summary: "bc summary (overlaps ab)",
    },
    { startRef: "m00001", endRef: "m00002", summary: "ab summary" },
  ]);

  for (const [label, result] of [
    ["sorted", sorted],
    ["shuffled", shuffled],
  ] as const) {
    assert.equal(result.result.errors.length, 0, `${label}: no errors`);
    assert.equal(
      result.result.blocksCreated,
      2,
      `${label}: earliest range + disjoint range compressed`,
    );
    assert.ok(
      result.result.warnings.some((w) => /overlaps an earlier range/i.test(w)),
      `${label}: overlap warning present`,
    );
  }
});

test("block-boundary distillation counts consumed block tokens", () => {
  const core = createCore();
  const messages = [
    msg("a", "x".repeat(2000)),
    msg("b", "x".repeat(2000)),
    msg("c", "x".repeat(2000)),
    msg("d", "x".repeat(2000)),
  ];
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const t1 = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "first block summary with enough detail",
      },
    ],
    messages,
    state,
    config: config(),
  });

  assert.ok(
    t1.result.tokensCompressed > 0,
    "T1 should count compressed tokens",
  );

  const t2 = core.applyCompression({
    ranges: [
      { startRef: "b1", endRef: "b1", summary: "distilled tier 2 summary" },
    ],
    messages,
    state: t1.state,
    config: config(),
  });

  assert.equal(t2.result.blocksCreated, 1);
  assert.ok(
    t2.result.tokensCompressed > 0,
    "T2 distillation should count consumed block tokens",
  );
});
