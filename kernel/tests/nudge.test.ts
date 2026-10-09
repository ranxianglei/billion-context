import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { validateConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.9,
      minContextLimitPct: 0.45,
      frequency: 1,
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

function textMessage(
  role: CoreMessage["role"],
  id: string,
  text: string,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) =>
    textMessage(
      i % 2 === 0 ? "user" : "assistant",
      `m${i}`,
      `message ${i} `.repeat(2000),
    ),
  );
}

// nudgeGrowthTokens = resolveAdaptiveGrowth(100000) = max(6000, 5000) = 6000
// growthFloor = max(5000, 0.45*6000) = 5000
// effectiveThreshold (no pending) = 6000
// effectiveThreshold (pending) = 3000

test("nudge: baseline stamped on first turn, no nudge below threshold", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  const state = createInitialState();

  const turn1 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  });
  assert.equal(turn1.nudge.shouldInject, false);
  assert.equal(
    turn1.state.nudge.lastPerMessageNudgeTokens,
    10000,
    "baseline stamped",
  );
  assert.equal(turn1.state.nudge.lastNudgeShownTokens, 0, "no nudge shown");
});

test("nudge: fires when growth exceeds threshold AND usage over min limit", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  const turn2 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 55000,
  });
  assert.equal(
    turn2.nudge.shouldInject,
    true,
    "growth 45000 >= 6000, usage 55% >= 45%",
  );
  assert.equal(
    turn2.state.nudge.lastNudgeShownTokens,
    55000,
    "shown tokens stamped",
  );
});

test("nudge: growth-gating suppresses repeat nudge without sufficient growth", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 55000,
  }).state;

  const turn3 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 58000,
  });
  assert.equal(
    turn3.nudge.shouldInject,
    false,
    "growth 3000 < 6000 effectiveThreshold",
  );
});

test("nudge: pending nudge halves threshold for faster re-nudge", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 55000,
  }).state;
  assert.equal(state.nudge.lastNudgeShownTokens, 55000, "pending nudge set");

  // Halved threshold = floor(6000/2) = 3000. Growth must also pass growthFloor=5000.
  // Growth of 5500 >= 5000 → fires despite being below the unhalved 6000.
  const turn3 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 60500,
  });
  assert.equal(
    turn3.nudge.shouldInject,
    true,
    "pending nudge → growth 5500 >= 5000 floor (would fail unhalved 6000)",
  );
});

test("nudge: growth floor gate suppresses when growth below floor", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: {
      ...buildConfig().nudge,
      minGrowthFloor: 10000,
      minGrowthRatio: 0.9,
    },
  });
  const messages = makeMessages(10);
  let state = createInitialState();

  // nudgeGrowthTokens = 6000, growthFloor = max(10000, 0.9*6000) = max(10000, 5400) = 10000
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // Growth 45000 but growthFloor=10000 → 45000 >= 10000 → passes. Let's test suppression:
  // Growth 7000 >= effectiveThreshold 6000 but < growthFloor 10000 → suppressed
  const turn2 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 17000,
  });
  assert.equal(
    turn2.nudge.shouldInject,
    false,
    "growth 7000 >= 6000 threshold but < 10000 floor",
  );
});

test("nudge: emergency override fires at 98% regardless of growth", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;

  const turn2 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 99000,
  });
  assert.equal(
    turn2.nudge.shouldInject,
    true,
    "emergency: 99% >= 98% override",
  );
  assert.ok(
    turn2.nudge.reason.includes("EMERGENCY"),
    `reason should mention EMERGENCY, got: ${turn2.nudge.reason}`,
  );
});

test("nudge: baseline correction when tokens drop significantly", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 55000,
  }).state;
  assert.equal(
    state.nudge.lastPerMessageNudgeTokens,
    10000,
    "baseline at 10000",
  );

  // Token drops below baseline - nudgeGrowthTokens (10000 - 6000 = 4000)
  // 3000 < 4000 → baseline corrected to 3000
  const turn3 = core.processTurn({ messages, state, config, tokenCount: 3000 });
  assert.equal(
    turn3.state.nudge.lastPerMessageNudgeTokens,
    3000,
    "baseline corrected on significant drop",
  );
  assert.equal(
    turn3.state.nudge.lastNudgeShownTokens,
    0,
    "pending nudge cleared",
  );
});

test("nudge: compress resets baseline, preventing feedback loop", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 55000,
  }).state;

  state = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00003",
        summary: "compressed early msgs",
      },
    ],
    messages,
    state,
    config,
  }).state;

  assert.equal(
    state.nudge.lastPerMessageNudgeTokens,
    0,
    "baseline cleared post-compress",
  );
  assert.equal(
    state.nudge.lastNudgeShownTokens,
    0,
    "shown cleared post-compress",
  );

  const turn = core.processTurn({ messages, state, config, tokenCount: 30000 });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "30% < 45% threshold → no nudge",
  );
  assert.equal(
    turn.state.nudge.lastPerMessageNudgeTokens,
    30000,
    "baseline re-established",
  );
});

test("nudge: full growth cycle — baseline → growth → nudge → compress → new baseline → growth → nudge", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(20);
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  assert.equal(state.nudge.lastPerMessageNudgeTokens, 10000);

  let turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(turn.nudge.shouldInject, true, "growth 45000 >= 6000");
  state = turn.state;

  state = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00005", summary: "compressed batch" },
    ],
    messages,
    state,
    config,
  }).state;
  assert.equal(state.nudge.lastPerMessageNudgeTokens, 0);

  turn = core.processTurn({ messages, state, config, tokenCount: 30000 });
  assert.equal(turn.nudge.shouldInject, false, "30% < 45%");
  assert.equal(
    turn.state.nudge.lastPerMessageNudgeTokens,
    30000,
    "new baseline at 30000",
  );
  state = turn.state;

  turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(
    turn.nudge.shouldInject,
    true,
    "growth 25000 >= 6000, usage 55% >= 45%",
  );
});

test("nudge: tier distillation fires when lower-tier blocks accumulate enough", () => {
  const core = createCore();
  // Preserve recent messages so pendingT1 (raw compressible) stays below
  // threshold — we want to isolate the T2 distillation path, not T1.
  const config = buildConfig({
    tiers: { enabled: true, tier2Trigger: 3, tier3Trigger: 10 },
    preserveRecentMessages: 30,
  });
  const messages = makeMessages(30);
  let state = createInitialState();
  // First turn establishes a baseline at a high token count.
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 50000,
  }).state;

  // Inject three active T1 blocks with large summaries so pendingT2 (sum of
  // their summary tokens) exceeds the nudge threshold (buildConfig → 6000).
  state = {
    ...state,
    blocks: [0, 1, 2].map((i) => ({
      blockId: `b${i + 1}`,
      runId: "r1",
      tier: 1 as const,
      summary: `tier-1 summary block ${i} with substantial content `.repeat(
        1200,
      ),
      directMessageIds: [`m${i}`],
      effectiveMessageIds: [`m${i}`],
      directBlockIds: [],
      compressedTokens: 5000,
      createdAt: Date.now(),
      survivedCount: 0,
      generation: "root" as const,
      active: true,
    })),
  };
  assert.equal(
    state.blocks.filter((b) => b.active && b.tier === 1).length,
    3,
    "three T1 blocks present",
  );

  // growth is zero — must NOT inject even though T2 blocks are ready.
  let turn = core.processTurn({ messages, state, config, tokenCount: 50000 });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "no growth → no injection even with T2 ready",
  );

  // Once growth passes the floor (buildConfig floor 5000), the nudge fires
  // WITH tier-2 distillation info (T1 blocked by preserve → T2 wins).
  turn = core.processTurn({ messages, state, config, tokenCount: 60000 });
  assert.equal(turn.nudge.shouldInject, true, "growth past floor → injects");
  assert.equal(
    turn.nudge.tier,
    2,
    "nudge carries tier-2 distillation guidance (T1 blocked by preserve)",
  );
  assert.ok(
    (turn.nudge.tierTargetBlocks?.length ?? 0) >= 1,
    "target T1 blocks listed",
  );
});

test("nudge: production config (preserveRecentMessages > 0) computes compressible ranges", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 5 });
  const messages = makeMessages(15);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;

  const turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(turn.nudge.shouldInject, true);
  assert.ok(
    turn.nudge.compressibleRanges.length > 0,
    "compressible ranges reported",
  );
  for (const range of turn.nudge.compressibleRanges) {
    assert.ok(!range.startRef.startsWith("m0001"), "preserved tail excluded");
  }
});

test("nudge: compressible ranges exclude messages covered by active blocks", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 2 });
  const messages = makeMessages(12);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;

  state = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00005", summary: "covered" }],
    messages,
    state,
    config,
  }).state;

  const turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.ok(turn.nudge.compressibleRanges.length > 0, "ranges reported");
  const lastRef = `m${String(messages.length).padStart(5, "0")}`;
  for (const range of turn.nudge.compressibleRanges) {
    assert.ok(
      range.endRef < lastRef || range.endRef === lastRef,
      `range ${range.endRef} valid`,
    );
  }
});

function t1Blocks(anchorIds: string[][], summaryChars: number) {
  return anchorIds.map((effIds, i) => ({
    blockId: `b${i + 1}`,
    runId: "r1",
    tier: 1 as const,
    summary: "x".repeat(summaryChars),
    directMessageIds: effIds,
    effectiveMessageIds: effIds,
    directBlockIds: [],
    compressedTokens: summaryChars,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young" as const,
    active: true,
  }));
}

function t2Blocks(count: number, summaryChars: number, effIds: string[]) {
  return Array.from({ length: count }, (_, i) => ({
    blockId: `t2-${i + 1}`,
    runId: "r2",
    tier: 2 as const,
    summary: "x".repeat(summaryChars),
    directMessageIds: [],
    // syncBlocks deactivates blocks whose effectiveMessageIds are all absent
    // from the message list — tier-2 blocks must carry transitive ids to stay
    // active. directBlockIds point to fake sources (not real block ids) so the
    // tier-1 source blocks are NOT marked consumed/deactivated.
    effectiveMessageIds: [...effIds],
    directBlockIds: [`t2-src-${i + 1}`],
    compressedTokens: summaryChars,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young" as const,
    active: true,
  }));
}

test("arbitration: non-emergency T1 effective >= threshold → tier 1", () => {
  const core = createCore();
  // minCompressRange > 0 so merge + effective filter actually engage — without
  // this, pendingByTier bypasses the filter (minCompressRange > 0 ? filter : merged)
  // and the test exercises the OLD T1 definition.
  const config = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(
    turn.nudge.tier,
    1,
    "T1 effective (~50K) >= 6000 → tier 1, no T2 blocks present",
  );
});

test("arbitration: non-emergency T2 >= 1.5x threshold AND > T1 effective → tier 2", () => {
  const core = createCore();
  // minCompressRange > 0 so the effective filter engages (see test above).
  const config = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 9,
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 50000,
  }).state;
  // Two T1 blocks anchored to real messages (m1, m2) with ~6K-token summaries
  // each → T2 ~12K >= 9000 (1.5x); T1 effective is ~0 (preserve + blocks cover
  // all visible messages).
  state = { ...state, blocks: t1Blocks([["m1"], ["m2"]], 24000) };
  const turn = core.processTurn({ messages, state, config, tokenCount: 60000 });
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(
    turn.nudge.tier,
    2,
    "T2 ~12K >= 9000 (1.5x) and > T1 effective → tier 2",
  );
});

test("arbitration: non-emergency T2 large but T1 effective >= threshold → tier 1 wins", () => {
  const core = createCore();
  // minCompressRange > 0 so the effective filter engages.
  const config = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // Large T2 pending (blocks anchored to m0, m1), but T1 effective (~40K from
  // m2..m9) still dominates the threshold.
  state = { ...state, blocks: t1Blocks([["m0"], ["m1"]], 40000) };
  const turn = core.processTurn({ messages, state, config, tokenCount: 55000 });
  assert.equal(
    turn.nudge.tier,
    1,
    "T1 effective >= threshold wins even when T2 is large",
  );
});

// Per-tier thresholds (#2376): nudge.tierGrowthTokens.{t1,t2,t3} pin each
// mass trigger independently; unset tiers keep their derived defaults.
// Mass model here: each makeMessages message ≈ 5000 tokens (20000 chars / 4);
// block summary mass = summaryChars / 4. Derived defaults under buildConfig:
// T1 = 6000, T2/T3 = 9000 (1.5x).

test("tier thresholds: lowered t2 fires T2 below the derived 1.5x mass", () => {
  const core = createCore();
  const base = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    // Preserve 9 → only m0 (~5000 tokens) is T1-effective, below the T1 bar.
    preserveRecentMessages: 9,
  });
  const messages = makeMessages(10);

  // One tier-1 block, summary 28000 chars → T2 mass 7000: above T1 effective
  // (5000) but BELOW the derived 9000 → default config must not inject.
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config: base,
    tokenCount: 50000,
  }).state;
  state = { ...state, blocks: t1Blocks([["m1"]], 28000) };
  const defaultTurn = core.processTurn({
    messages,
    state,
    config: base,
    tokenCount: 60000,
  });
  assert.equal(
    defaultTurn.nudge.shouldInject,
    false,
    "default: T2 mass 7000 < derived 9000 → no nudge",
  );

  // Same state, t2 pinned to 6000: 7000 >= 6000 and > T1 effective → tier 2.
  const lowered = buildConfig({
    ...base,
    nudge: { ...base.nudge, tierGrowthTokens: { t2: 6000 } },
  });
  state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config: lowered,
    tokenCount: 50000,
  }).state;
  state = { ...state, blocks: t1Blocks([["m1"]], 28000) };
  const turn = core.processTurn({
    messages,
    state,
    config: lowered,
    tokenCount: 60000,
  });
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(turn.nudge.tier, 2, "lowered t2 lets T2 distill early");
});

test("tier thresholds: raised t1 suppresses T1 while nothing else is ready", () => {
  const core = createCore();
  const base = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
  });
  const messages = makeMessages(10);
  // All 10 messages visible → T1 effective ~50000 tokens.
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config: base,
    tokenCount: 10000,
  }).state;
  const defaultTurn = core.processTurn({
    messages,
    state,
    config: base,
    tokenCount: 55000,
  });
  assert.equal(defaultTurn.nudge.shouldInject, true);
  assert.equal(defaultTurn.nudge.tier, 1, "default: T1 ~50K >= 6000");

  // Pin t1 above the ready mass → no tier has enough → no injection.
  const raised = buildConfig({
    ...base,
    nudge: { ...base.nudge, tierGrowthTokens: { t1: 100000 } },
  });
  state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config: raised,
    tokenCount: 10000,
  }).state;
  const turn = core.processTurn({
    messages,
    state,
    config: raised,
    tokenCount: 55000,
  });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "raised t1: T1 ~50K < 100000 and no T2/T3 blocks → suppressed",
  );
});

test("tier thresholds: pinning one tier leaves the others on derived defaults", () => {
  const core = createCore();
  const config = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 9,
    // Only t1 pinned (high); t2 stays on its derived 1.5x threshold.
    nudge: { ...buildConfig().nudge, tierGrowthTokens: { t1: 100000 } },
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 50000,
  }).state;
  // Two tier-1 blocks → T2 mass 12000 >= derived 9000 and > T1 effective.
  state = { ...state, blocks: t1Blocks([["m1"], ["m2"]], 24000) };
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 60000,
  });
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(
    turn.nudge.tier,
    2,
    "unset t2 keeps the derived 1.5x threshold despite t1 being pinned",
  );
});

test("validateConfig: nudge.tierGrowthTokens values must be positive numbers", () => {
  const base = buildConfig();
  assert.deepEqual(validateConfig(base), []);
  for (const bad of [0, -1, NaN, Infinity]) {
    const cfg = {
      ...base,
      nudge: { ...base.nudge, tierGrowthTokens: { t2: bad } },
    };
    assert.ok(
      validateConfig(cfg).some((e) =>
        e.includes("nudge.tierGrowthTokens.t2"),
      ),
      `expected an error for t2=${String(bad)}`,
    );
  }
  const ok = {
    ...base,
    nudge: { ...base.nudge, tierGrowthTokens: { t1: 1 } },
  };
  assert.ok(
    !validateConfig(ok).some((e) => e.includes("tierGrowthTokens")),
    "valid value produces no tierGrowthTokens error",
  );
});

test("arbitration: emergency T2 > T1 effective → tier 2 with emergencyOverride", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // One T1 block covering ALL messages → compressible empty (T1 effective 0),
  // with a large summary → T2 pending ~10K dominates.
  state = {
    ...state,
    blocks: [
      {
        blockId: "b1",
        runId: "r1",
        tier: 1 as const,
        summary: "x".repeat(40000),
        directMessageIds: messages.map((m) => m.id),
        effectiveMessageIds: messages.map((m) => m.id),
        directBlockIds: [],
        compressedTokens: 50000,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young" as const,
        active: true,
      },
    ],
  };
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(
    turn.nudge.tier,
    2,
    "emergency picks T2 (max pending) when T2 > T1 effective",
  );
  assert.equal(turn.nudge.breakdown.emergencyOverride, 1);
});

test("arbitration: emergency T1 effective largest → tier 1", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // No blocks → T2/T3 = 0; T1 effective ~50K is the max.
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(
    turn.nudge.tier,
    1,
    "emergency picks T1 when its effective pending is max",
  );
  assert.equal(turn.nudge.breakdown.emergencyOverride, 1);
});

test("arbitration: T2 boundary — must NOT fire when pending ∈ [nudgeGrowthTokens, 1.5×)", () => {
  const core = createCore();
  // OLD code fired T2 at >= nudgeGrowthTokens; NEW requires >= 1.5× — this
  // range (T2 pending ~7500 ∈ [6000, 9000)) proves the boundary. Diverges from
  // master, which injected T2 here.
  const config = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 10,
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // preserveRecentMessages:10 → no compressible msgs → T1 effective = 0.
  // 1 T1 block, summary 'x'.repeat(30000) → 7500 tokens ∈ [6000, 9000).
  state = { ...state, blocks: t1Blocks([["m0"]], 30000) };
  const turn = core.processTurn({ messages, state, config, tokenCount: 35000 });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "T2 pending 7500 < 9000 (1.5×) and T1 effective 0 < 6000 → no injection",
  );
});

test("arbitration: non-emergency T3 >= 1.5× threshold AND > T2 AND > T1 effective → tier 3", () => {
  const core = createCore();
  // Validates FIX 1: master had no T3 non-emergency branch → tier would be
  // null here. NEW code injects T3.
  const config = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 10,
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // T1 effective = 0 (preserveRecentMessages:10).
  // T2 pending: 1 small T1 block, summary 4000 chars → 1000 tokens (< 9000).
  // T3 pending: 2 T2 blocks × 20000-char summaries → 5000 tokens each = 10000 (>= 9000).
  state = {
    ...state,
    blocks: [...t1Blocks([["m0"]], 4000), ...t2Blocks(2, 20000, ["m0"])],
  };
  const turn = core.processTurn({ messages, state, config, tokenCount: 35000 });
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(
    turn.nudge.tier,
    3,
    "T3 10000 >= 9000 (1.5×) and > T2 1000 and > T1 effective 0 → tier 3",
  );
  assert.match(turn.nudge.reason ?? "", /T3 condense/);
});

test("arbitration: emergency argmax picks T3 when T3 > T2 > T1 effective", () => {
  const core = createCore();
  const config = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // T1 block covers ALL messages → compressible empty → T1 effective = 0.
  // Its summary 'x'.repeat(20000) → 5000 tokens = T2 pending.
  // 3 T2 blocks × 20000-char summaries → 5000 each = T3 pending 15000 (largest).
  state = {
    ...state,
    blocks: [
      {
        blockId: "cover",
        runId: "r1",
        tier: 1 as const,
        summary: "x".repeat(20000),
        directMessageIds: messages.map((m) => m.id),
        effectiveMessageIds: messages.map((m) => m.id),
        directBlockIds: [],
        compressedTokens: 50000,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young" as const,
        active: true,
      },
      ...t2Blocks(
        3,
        20000,
        messages.map((m) => m.id),
      ),
    ],
  };
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(
    turn.nudge.tier,
    3,
    "emergency argmax: T3 15000 > T2 5000 > T1 effective 0",
  );
  assert.equal(turn.nudge.breakdown.emergencyOverride, 1);
});

test("arbitration: sub-threshold tail folds into preceding batch (pendingT1 spans full remainder)", () => {
  const core = createCore();
  // With minCompressRange > 0, mergeRangesToThreshold guarantees every emitted
  // batch alone clears the gate (#309). 10 short msgs (200 tokens each, raw
  // sum 2000 tokens). Merge (token gate, min 1500) closes the leading portion
  // once it reaches 1500; the sub-threshold tail folds into it → ONE range
  // m0..m9 (2000 tokens) that clears 1500 on its own → pendingT1 = 2000 and
  // nudge lists exactly that one range.
  const config = buildConfig({
    compress: {
      minCompressRange: 1500,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
  });
  const messages = Array.from({ length: 10 }, (_, i) =>
    textMessage(i % 2 === 0 ? "user" : "assistant", `m${i}`, "x".repeat(800)),
  );
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 35000 });
  assert.equal(
    turn.nudge.breakdown.pendingT1,
    2000,
    "tail folded into the preceding batch → the whole 8000-char remainder counts",
  );
  assert.equal(
    turn.nudge.compressibleRanges.length,
    1,
    "#309: only gate-clearing ranges are listed",
  );
  assert.equal(turn.nudge.compressibleRanges[0]!.tokens, 2000);
});

test("over-limit fires force-nudge when compressible content exists", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: { ...buildConfig().nudge, maxContextLimitPct: 0.75 },
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 0,
  });
  const messages = makeMessages(10);
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 80000,
  });
  assert.equal(
    turn.nudge.shouldInject,
    true,
    "force-nudge should fire with compressible content",
  );
  assert.equal(turn.nudge.breakdown!.overLimit, 1, "overLimit flag set");
  assert.ok(
    turn.nudge.reason.includes("OVER-LIMIT"),
    `reason: ${turn.nudge.reason}`,
  );
});

test("over-limit does NOT inject when nothing is compressible (MAJOR-1 fix)", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: { ...buildConfig().nudge, maxContextLimitPct: 0.75 },
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 5,
  });
  const messages = [
    textMessage("user", "a", "hello"),
    textMessage("assistant", "b", "world"),
  ];
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 80000,
  });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "no spam when nothing to compress",
  );
  assert.equal(
    turn.nudge.breakdown!.overLimit,
    1,
    "overLimit flag still set for reporting",
  );
  assert.ok(
    turn.nudge.reason.includes("OVER-LIMIT"),
    `reason: ${turn.nudge.reason}`,
  );
});

test("emergency suppresses nudge when only sub-minCompressRange tail ranges remain", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: {
      ...buildConfig().nudge,
      emergencyThresholdPct: 0.95,
      maxContextLimitPct: 0.75,
    },
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 0,
  });
  // Compressible content exists but every range is far below minCompressRange
  // (min 5000 chars = 1250 tokens; these sum to ~300). Recommending them
  // would guarantee atomic rejection — the exact failure mode the endurance
  // report showed at 60% failure rate.
  const messages = ["a", "b", "c"].map((t, i) =>
    textMessage(
      i % 2 === 0 ? "user" : "assistant",
      `m${i}`,
      `tiny ${t} `.repeat(10),
    ),
  );
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 96000,
  });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "no emergency spam when nothing is effectively compressible",
  );
  assert.equal(
    turn.nudge.breakdown!.emergencyOverride,
    1,
    "emergency flag still set for reporting",
  );
  assert.ok(
    turn.nudge.reason.includes("EMERGENCY"),
    `reason: ${turn.nudge.reason}`,
  );
  assert.ok(
    turn.nudge.reason.includes("minCompressRange"),
    `reason explains the suppression: ${turn.nudge.reason}`,
  );
});

test("emergency with effective pending routes to the max-pending tier (post-fix regression)", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: {
      ...buildConfig().nudge,
      emergencyThresholdPct: 0.95,
      maxContextLimitPct: 0.75,
    },
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 0,
  });
  const messages = makeMessages(10);
  const turn = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 96000,
  });
  assert.equal(
    turn.nudge.shouldInject,
    true,
    "emergency fires when effective content exists",
  );
  assert.equal(turn.nudge.tier, 1, "T1 has the max pending here");
  assert.ok(
    turn.nudge.reason.includes("EMERGENCY"),
    `reason: ${turn.nudge.reason}`,
  );
});

test("re-baseline after a tokenCount scale drop also resets per-tier cadence stamps", () => {
  const core = createCore();
  const config = buildConfig();
  // A session carried over from an adapter that fed session-tree accounting:
  // stamps recorded at 366K while the real (sent-view) tokenCount is 40K.
  // lastPerMessageNudgeTokens triggers the re-baseline branch (drop far
  // below baseline - nudgeGrowthTokens); lastShownByTier at the old scale
  // would make `tokenCount - lastShownByTier[t] >= growthFloor` unreachable
  // (negative forever), suppressing mid-band nudges until the absolute
  // overLimit band fires.
  const state = createInitialState();
  state.nudge.lastPerMessageNudgeTokens = 366_000;
  state.nudge.lastNudgeShownTokens = 366_000;
  state.nudge.lastShownByTier = { 1: 366_000, 2: 366_000 };

  const messages = makeMessages(10);
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 40_000,
  });
  const stamped = turn.state.nudge;
  assert.equal(
    stamped.lastPerMessageNudgeTokens,
    40_000,
    "baseline re-anchored at the new scale",
  );
  assert.equal(
    stamped.lastNudgeShownTokens,
    0,
    "shared cadence baseline cleared",
  );
  assert.deepEqual(
    stamped.lastShownByTier,
    {},
    "per-tier cadence stamps must not survive a scale drop",
  );
});

test("downward reset re-anchors when count drops below the shown reference even if still above baseline (#478)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  // turn1: baseline stamped at 10000. turn2: T1 injected at 55000 → shown=55000.
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10_000,
  }).state;
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 55_000,
  }).state;
  assert.equal(
    state.nudge.lastNudgeShownTokens,
    55_000,
    "shown reference stamped at inject",
  );

  // Real usage settles far below the shown reference but still ABOVE
  // baseline - interval (10000 - 6000 = 4000): the old baseline-keyed reset
  // never fires while growthReference stays pinned at 55000 → growth negative
  // forever → every non-pressure inject dead until context regrows past 55000.
  const turn3 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 9_000,
  });
  assert.equal(
    turn3.state.nudge.lastPerMessageNudgeTokens,
    9_000,
    "baseline re-anchored at the settled level",
  );
  assert.equal(
    turn3.state.nudge.lastNudgeShownTokens,
    0,
    "stale shown reference cleared",
  );
  assert.deepEqual(
    turn3.state.nudge.lastShownByTier,
    {},
    "per-tier stamps cleared with the shown reference",
  );

  // Cadence must be alive again: growth 6000 >= floor 5000 from the fresh reference.
  const turn4 = core.processTurn({
    messages,
    state: turn3.state,
    config,
    tokenCount: 15_000,
  });
  assert.equal(
    turn4.nudge.shouldInject,
    true,
    `re-anchored cadence re-fires after regrowth, got reason: ${turn4.nudge.reason}`,
  );
});

test("arbitration: 5 summary blocks stay silent with default triggers (#379 — count path default-off)", () => {
  const core = createCore();
  const config = buildConfig({
    preserveRecentMessages: 30,
    tiers: { enabled: true, tier2Trigger: 1000, tier3Trigger: 2000 },
  });
  const messages = makeMessages(30);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50_000,
  }).state;
  state = {
    ...state,
    blocks: t1Blocks([["m1"], ["m2"], ["m3"], ["m4"], ["m5"]], 400),
  };
  // The billion-context#1249 repro shape: five condensed-summary blocks at 40%
  // usage. Under default triggers the count path is OFF — no nudge, no hint.
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 40_000,
  });
  assert.equal(turn.nudge.shouldInject, false, `reason: ${turn.nudge.reason}`);
  assert.doesNotMatch(turn.nudge.reason ?? "", /T2 distill ready/);
  assert.doesNotMatch(
    turn.nudge.reason ?? "",
    /T2 \d+ blocks \(count\)/,
    "5 blocks must not read as count-ready under default triggers",
  );
});

test("arbitration: count-triggered T3 fires below the old usage band when explicitly configured (#379 — #238 gate deleted)", () => {
  const core = createCore();
  const config = buildConfig({
    tiers: { enabled: true, tier2Trigger: 2, tier3Trigger: 3 },
    preserveRecentMessages: 30,
  });
  const messages = makeMessages(30);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 25_000,
  }).state;
  state = {
    ...state,
    blocks: t1Blocks([["m1"], ["m2"], ["m3"], ["m4"], ["m5"]], 400).map(
      (b) => ({ ...b, tier: 2 }),
    ),
  };
  // 40k / 100k = 40% < the old minContextLimitPct 45% band; growth 15k >=
  // floor 6000. With the #238 usage gate deleted, explicit count triggers
  // fire on pure count — percentages no longer gate compression.
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 40_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 3);
  assert.match(
    turn.nudge.reason ?? "",
    /T3 condense ready: 5 tier-2 blocks >= tier3Trigger 3/,
  );
});

test("arbitration: T2 fires on tier-1 block COUNT (tier2Trigger) even when summary tokens are small", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 30 });
  const messages = makeMessages(30);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50000,
  }).state;
  // 5 blocks x ~100-token summaries = ~500 pending tokens, far below the
  // 9000 token gate — only the count path (5 >= tier2Trigger 5) can fire,
  // and raw T1 is fully preserved so t1Eff cannot dominate.
  state = {
    ...state,
    blocks: t1Blocks([["m1"], ["m2"], ["m3"], ["m4"], ["m5"]], 400),
  };
  const turn = core.processTurn({ messages, state, config, tokenCount: 60000 });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 2);
  assert.match(turn.nudge.reason ?? "", /5 tier-1 blocks >= tier2Trigger 5/);
  assert.equal(turn.nudge.tierTargetBlocks?.length, 5);
});

test("arbitration: below tier2Trigger count and below token gate -> no T2 nudge", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 30 });
  const messages = makeMessages(30);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50000,
  }).state;
  state = { ...state, blocks: t1Blocks([["m1"], ["m2"], ["m3"], ["m4"]], 400) };
  const turn = core.processTurn({ messages, state, config, tokenCount: 60000 });
  assert.equal(turn.nudge.shouldInject, false, `reason: ${turn.nudge.reason}`);
  assert.match(
    turn.nudge.reason ?? "",
    /max compressible 400 < threshold 6000/,
  );
  assert.doesNotMatch(turn.nudge.reason ?? "", /tier2Trigger/);
});

test("arbitration: count-triggered T2 does not preempt ready T1 raw compression", () => {
  const core = createCore();
  const config = buildConfig({
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 0,
      minSummaryLength: 0,
    },
    preserveRecentMessages: 0,
  });
  const messages = makeMessages(10);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50000,
  }).state;
  state = {
    ...state,
    blocks: t1Blocks([["m1"], ["m2"], ["m3"], ["m4"], ["m5"]], 400),
  };
  const turn = core.processTurn({ messages, state, config, tokenCount: 60000 });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(
    turn.nudge.tier,
    1,
    "T1 raw pending still has priority over count-ready T2",
  );
  assert.match(turn.nudge.reason ?? "", /T1 effective/);
});

test("arbitration: count-triggered T2 still respects the growthFloor cadence", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 30 });
  const messages = makeMessages(30);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50000,
  }).state;
  state = {
    ...state,
    blocks: t1Blocks([["m1"], ["m2"], ["m3"], ["m4"], ["m5"]], 400),
  };
  const first = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 60000,
  });
  assert.equal(first.nudge.tier, 2, `reason: ${first.nudge.reason}`);
  const second = core.processTurn({
    messages,
    state: first.state,
    config,
    tokenCount: 61000,
  });
  assert.equal(
    second.nudge.shouldInject,
    false,
    `reason: ${second.nudge.reason}`,
  );
  assert.match(second.nudge.reason ?? "", /T2 \(cadence\)/);
});

test("arbitration: T3 fires on tier-2 block COUNT (tier3Trigger) even when summary tokens are small", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 30 });
  const messages = makeMessages(30);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50000,
  }).state;
  // 2 tier-1 blocks (below tier2Trigger) + 10 tier-2 blocks with ~100-token
  // summaries: t3Pen ~1000 << 9000 token gate — only the count path fires.
  state = {
    ...state,
    blocks: [...t1Blocks([["m1"], ["m2"]], 400), ...t2Blocks(10, 400, ["m3"])],
  };
  const turn = core.processTurn({ messages, state, config, tokenCount: 60000 });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 3);
  assert.match(turn.nudge.reason ?? "", /10 tier-2 blocks >= tier3Trigger 10/);
  assert.equal(turn.nudge.tierTargetBlocks?.length, 10);
});

test("arbitration: tiers disabled -> count trigger cannot fire T2", () => {
  const core = createCore();
  const config = buildConfig({
    tiers: { enabled: false, tier2Trigger: 5, tier3Trigger: 10 },
    preserveRecentMessages: 30,
  });
  const messages = makeMessages(30);
  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50000,
  }).state;
  state = {
    ...state,
    blocks: t1Blocks(
      [["m1"], ["m2"], ["m3"], ["m4"], ["m5"], ["m6"], ["m7"]],
      400,
    ),
  };
  const turn = core.processTurn({ messages, state, config, tokenCount: 60000 });
  assert.equal(turn.nudge.shouldInject, false, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, null);
  assert.doesNotMatch(turn.nudge.reason ?? "", /tier2Trigger/);
});

// #194 first-sight mass bypass: a session that ARRIVES with a huge ready mass
// (stateless full-history ingest) must not wait a full growth floor of NEW
// tokens for its first compress. #351: growthReference seeded to the ingest
// tokenCount → growth stayed 0 → 934K-ready sat idle until the session died.
test("nudge: first-sight mass bypass fires on big ingest despite growth 0 (#194)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  const state = createInitialState();

  // One-shot ingest: usage 47% (inside the 45% band), growth 0 from the
  // tokenCount-seeded reference, T1 effective ~55K >= 6000 ready.
  const turn1 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 47000,
  });
  assert.equal(
    turn1.nudge.shouldInject,
    true,
    "first sight with ready mass >= threshold and usage in band nudges immediately",
  );
  assert.match(turn1.nudge.reason, /\[first-sight mass\]/);
});

test("nudge: first-sight bypass stays off below the min usage band (#194)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  const state = createInitialState();

  // 44% < 45% minContextLimitPct: a fresh session below the band still waits
  // (the bypass must not turn first-turn compression on for small sessions).
  const turn1 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 44000,
  });
  assert.equal(turn1.nudge.shouldInject, false, "below min band → no bypass");
});

test("nudge: first-sight bypass paces normally after the first nudge (#194)", () => {
  const config = buildConfig({
    nudge: {
      ...buildConfig().nudge,
      minGrowthFloor: 10000,
      minGrowthRatio: 0.9,
    },
  });
  // growthFloor = max(10000, 0.9*6000) = 10000
  const core = createCore();
  const messages = makeMessages(10);
  let state = createInitialState();

  const turn1 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 46000,
  });
  assert.equal(
    turn1.nudge.shouldInject,
    true,
    "bypass fires in band (growth 0)",
  );
  assert.match(turn1.nudge.reason, /\[first-sight mass\]/);

  state = turn1.state;
  const turn2 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 50000,
  });
  assert.equal(
    turn2.nudge.shouldInject,
    false,
    "post-nudge growth 4000 < floor 10000 → paced again, no bypass",
  );
});

// #194 regression: the bypass must keep draining a backlog across compressions.
// The reviewer on PR #196 caught that the one-shot wording hid this path:
// applyCompression success clears the shown stamp and baseline, so a session
// still in band with ready mass over the threshold nudges AGAIN without
// waiting for a fresh growth floor of new tokens. This is the load-bearing
// behavior for #351 (934K backlog needs several compressions to drain).
test("nudge: first-sight bypass re-arms after a successful compression while still in band (#194)", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: {
      ...buildConfig().nudge,
      minGrowthFloor: 10000,
      minGrowthRatio: 0.9,
    },
  });
  const messages = makeMessages(20);
  let state = createInitialState();

  const turn1 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 47000,
  });
  assert.equal(turn1.nudge.shouldInject, true, "big ingest in band fires");
  assert.match(turn1.nudge.reason, /\[first-sight mass\]/);

  // Model executes the compress → success clears baseline + shown stamps.
  state = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00005",
        summary: "drained a slice of the backlog",
      },
    ],
    messages,
    state: turn1.state,
    config,
  }).state;
  assert.equal(
    state.nudge.lastNudgeShownTokens,
    0,
    "shown cleared by the compression",
  );

  // Still in band (48%) with growth 0 post-compress: the backlog is not yet
  // drained, so the bypass must fire again — NOT wait for 10000 new tokens.
  const turn2 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 48000,
  });
  assert.equal(
    turn2.nudge.shouldInject,
    true,
    "post-compress, still in band + ready mass → nudge again (drain semantics)",
  );
  assert.match(turn2.nudge.reason, /\[first-sight mass\]/);
});

// Companion: once the drain gets usage below the band, the bypass goes quiet
// even though growth is still 0 — it must not become an always-on compressor.
test("nudge: first-sight bypass falls silent once usage drops below the band (#194)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(20);
  let state = createInitialState();

  const turn1 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 55000,
  });
  assert.equal(turn1.nudge.shouldInject, true);

  state = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00005",
        summary: "drained most of the backlog",
      },
    ],
    messages,
    state: turn1.state,
    config,
  }).state;

  const turn2 = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 20000,
  });
  assert.equal(
    turn2.nudge.shouldInject,
    false,
    "20% < 45% band → drain complete, pacing resumes",
  );
});
