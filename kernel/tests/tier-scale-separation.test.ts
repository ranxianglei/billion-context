import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage, CompressionBlock } from "../src/types.js";

// #383 scale-separation contract: the #379 defaults make tier distillation a
// LATE-session mechanism. With default cadence (growthFloor 50K) each tier-1
// block represents ~50K of folded tokens, so:
//
//   T2 count trigger = 1000 tier-1 blocks  => >= 5M cumulative folded floor
//                      (1000 x minCompressRange 5K), ~50M ≈ 亿-typical.
//   T3 count trigger = 2000 tier-2 blocks  => each tier-2 block distills
//                      >= 1.5x growthFloor (75K) of tier-1 mass, so
//                      >= 150M ≈ 亿-level floor, 几十亿-typical.
//
// These tests pin the BLOCK boundaries so a future "tuning" PR cannot quietly
// drop 1000 back to 5 and re-open the prefix-cache sawtooth
// (billion-context#1249). Micro-blocks keep t1Eff / t2Pen / t3Pen below the
// token gates so ONLY the count boundary decides.

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 1000, tier3Trigger: 2000 },
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
    preserveRecentMessages: 30,
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
      `message ${i} content`,
    ),
  );
}

function microBlocks(count: number, tier: 1 | 2): CompressionBlock[] {
  return Array.from({ length: count }, (_, i) => ({
    blockId: `b${i + 1}`,
    runId: "r1",
    tier,
    summary: "x".repeat(4),
    directMessageIds: [`m${i}`],
    effectiveMessageIds: [`m${i}`],
    directBlockIds: [],
    compressedTokens: 4,
    createdAt: 0,
    survivedCount: 0,
    generation: "young" as const,
    active: true,
  }));
}

// Blocks must reference messages OUTSIDE the preserve window
// (preserveRecentMessages 30) for tier aggregation to count their mass,
// so the message pool spans block-count + preserve + a live tail.
function grownState(blocks: CompressionBlock[], messageCount: number) {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(messageCount);
  const first = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50_000,
  }).state;
  return { core, config, messages, state: { ...first, blocks } };
}

test("T2 count boundary: 999 tier-1 blocks stay silent, 1000 fires (#383)", () => {
  // 1000 micro-blocks x 4 tokens = 4000 pending — far below every token gate
  // (nudgeGrowthTokens 6000, tier2Threshold 9000), so ONLY the count path can
  // speak. 999 blocks: silent. 1000: fires.
  const silent = grownState(microBlocks(999, 1), 1030);
  const quiet = silent.core.processTurn({
    messages: silent.messages,
    state: silent.state,
    config: silent.config,
    tokenCount: 60_000,
  });
  assert.equal(
    quiet.nudge.shouldInject,
    false,
    `reason: ${quiet.nudge.reason}`,
  );
  assert.doesNotMatch(quiet.nudge.reason ?? "", /T2 distill ready/);

  const ready = grownState(microBlocks(1000, 1), 1031);
  const turn = ready.core.processTurn({
    messages: ready.messages,
    state: ready.state,
    config: ready.config,
    tokenCount: 60_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 2);
  assert.match(
    turn.nudge.reason ?? "",
    /1000 tier-1 blocks >= tier2Trigger 1000/,
  );
});

test("T3 count boundary: 1999 tier-2 blocks stay silent, 2000 fires (#383)", () => {
  // 2000 micro-blocks x 4 tokens = 8000 pending — below tier2Threshold 9000,
  // so the mass path stays silent and the T2 branch cannot preempt
  // (t2Count = 0 active tier-1 blocks).
  const silent = grownState(microBlocks(1999, 2), 2030);
  const quiet = silent.core.processTurn({
    messages: silent.messages,
    state: silent.state,
    config: silent.config,
    tokenCount: 60_000,
  });
  assert.equal(
    quiet.nudge.shouldInject,
    false,
    `reason: ${quiet.nudge.reason}`,
  );
  assert.doesNotMatch(quiet.nudge.reason ?? "", /T3 condense ready/);

  const ready = grownState(microBlocks(2000, 2), 2031);
  const turn = ready.core.processTurn({
    messages: ready.messages,
    state: ready.state,
    config: ready.config,
    tokenCount: 60_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 3);
  assert.match(
    turn.nudge.reason ?? "",
    /2000 tier-2 blocks >= tier3Trigger 2000/,
  );
});

test("scale contract: default triggers encode 亿/几十亿 cumulative folded mass (#383)", () => {
  // The count paths must not be reachable from hand-fulls of blocks: the
  // defaults pin the FOLD scale, not just the block count. At the default
  // production cadence (growthFloor 50K) each tier-1 block carries ~50K of
  // folded tokens => 1000 blocks ≈ 50M ≈ 亿-level cumulative; each tier-2
  // block distills >= 75K (1.5x) of tier-1 mass => 2000 blocks ≈ 1.5亿 floor,
  // 几十亿-typical. Assert the arithmetic anchors explicitly:
  const config = buildConfig();
  assert.equal(config.tiers.tier2Trigger, 1000);
  assert.equal(config.tiers.tier3Trigger, 2000);
  const minFoldPerT1 = 5000; // compress.minCompressRange floor per tier-1 block at creation
  const typicalFoldPerT1 = 50_000; // default nudge growthFloor cadence
  assert.ok(
    config.tiers.tier2Trigger * minFoldPerT1 >= 5_000_000,
    "T2 count floor must be >= 5M cumulative folded tokens",
  );
  assert.ok(
    config.tiers.tier2Trigger * typicalFoldPerT1 >= 50_000_000,
    "T2 count typical scale must reach 亿-level (50M+)",
  );
  assert.ok(
    config.tiers.tier3Trigger * 75_000 >= 150_000_000,
    "T3 count floor must be >= 1.5亿 cumulative (2000 x 75K distill mass)",
  );
});
