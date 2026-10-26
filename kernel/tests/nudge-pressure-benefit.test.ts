import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CompressionBlock, CoreMessage } from "../src/types.js";

// #198: the pressure band (usage >= maxContextLimitPct / emergencyThresholdPct)
// used to inject an EMERGENCY nudge for ANY bestPending > 0. Micro pending
// (232 / 120 tokens in production) triggered rewrites that reclaimed ~nothing;
// each success reset the nudge baselines and the still-hot band re-injected
// next turn — a continuous zero-yield compression loop. These tests pin the
// minimum-benefit gate: default max(5000, round(limit * 0.01)), overridable via
// nudge.minPressureBenefitTokens, 0 = legacy any-pending behavior.

function buildConfig(overrides: Partial<Config> = {}): Config {
  const base = {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.9,
      minContextLimitPct: 0.45,
      frequency: 1,
      iterationThreshold: 15,
      force: "soft" as const,
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
  };
  return { ...base, ...overrides };
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

// T1 block whose effective ids cover EVERY message → no compressible raw range
// remains (T1 effective = 0); its summary is the only pending mass (T2).
function coverAllBlock(
  messages: CoreMessage[],
  summaryChars: number,
): CompressionBlock {
  const ids = messages.map((m) => m.id);
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "x".repeat(summaryChars),
    directMessageIds: ids,
    effectiveMessageIds: ids,
    directBlockIds: [],
    compressedTokens: summaryChars,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
  };
}

test("pressure: EMERGENCY with only micro T2 pending (232 tokens) is suppressed (#198)", () => {
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
  // Mirrors production: "EMERGENCY T2 distill: max pending 232 (T1 effective 0,
  // T2 232, T3 0)" — 928-char summary → 232 tokens at chars/4.
  state = { ...state, blocks: [coverAllBlock(messages, 928)] };

  let turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(
    turn.nudge.breakdown.emergencyOverride,
    1,
    "usage 99% >= 98% → emergency band active",
  );
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "232 < default floor 5000 → no injection",
  );
  assert.equal(
    turn.nudge.breakdown.minPressureBenefit,
    5000,
    "default = max(5000, round(1e5*0.01))",
  );
  assert.match(turn.nudge.reason, /EMERGENCY/);
  assert.match(turn.nudge.reason, /232/);
  assert.match(turn.nudge.reason, /suppressed/i);

  // The loop: next turn must stay suppressed with nothing stamped.
  turn = core.processTurn({
    messages,
    state: turn.state,
    config,
    tokenCount: 99500,
  });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "suppression persists — no re-arm loop",
  );
  assert.equal(
    turn.state.nudge.lastNudgeShownTokens,
    0,
    "no shown stamp on suppression",
  );
});

test("pressure: EMERGENCY with only micro T3 pending (120 tokens) is suppressed (#198)", () => {
  const core = createCore();
  const config = buildConfig({ preserveRecentMessages: 10 });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // Tier-2 block (→ T3 pending) with a 480-char summary → 120 tokens, mirroring
  // production "EMERGENCY T3 condense: max pending 120". preserveRecentMessages
  // zeroes T1 effective; fake directBlockIds keep any tier-1 sources alive.
  state = {
    ...state,
    blocks: [
      {
        blockId: "t2-1",
        runId: "r2",
        tier: 2 as const,
        summary: "x".repeat(480),
        directMessageIds: [],
        effectiveMessageIds: messages.map((m) => m.id),
        directBlockIds: ["t2-src-1"],
        compressedTokens: 480,
        createdAt: Date.now(),
        survivedCount: 0,
        generation: "young" as const,
        active: true,
      },
    ],
  };
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn.nudge.breakdown.emergencyOverride, 1);
  assert.equal(turn.nudge.shouldInject, false, "120 < 5000 → suppressed");
  assert.match(turn.nudge.reason, /EMERGENCY/);
  assert.match(turn.nudge.reason, /120/);
});

test("pressure: pending exactly at the benefit floor still injects (boundary inclusive)", () => {
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
  // 20000-char summary → 5000 tokens = exactly the default floor.
  state = { ...state, blocks: [coverAllBlock(messages, 20000)] };
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(turn.nudge.shouldInject, true, "5000 >= 5000 → injects");
  assert.equal(turn.nudge.tier, 2, "argmax routes to T2");
  assert.match(turn.nudge.reason, /EMERGENCY T2 distill: max pending 5000/);
});

test("pressure: window scaling — 1M limit raises the floor to 10000", () => {
  const core = createCore();
  const config = buildConfig({ modelContextLimit: 1000000 });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 100000,
  }).state;
  // 24000-char summary → 6000 tokens < round(1e6 * 0.01) = 10000 → suppressed.
  state = { ...state, blocks: [coverAllBlock(messages, 24000)] };
  let turn = core.processTurn({ messages, state, config, tokenCount: 990000 });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    "6000 < 10000 (1% of 1M window) → suppressed",
  );
  assert.equal(turn.nudge.breakdown.minPressureBenefit, 10000);

  // 40000-char summary → 10000 tokens = floor → injects again.
  state = { ...turn.state, blocks: [coverAllBlock(messages, 40000)] };
  turn = core.processTurn({ messages, state, config, tokenCount: 990000 });
  assert.equal(turn.nudge.shouldInject, true, "10000 >= 10000 → injects");
  assert.equal(turn.nudge.tier, 2);
});

test("pressure: explicit minPressureBenefitTokens lowers the gate", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: { ...buildConfig().nudge, minPressureBenefitTokens: 100 },
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  state = { ...state, blocks: [coverAllBlock(messages, 928)] };
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(
    turn.nudge.breakdown.minPressureBenefit,
    100,
    "override honored",
  );
  assert.equal(
    turn.nudge.shouldInject,
    true,
    "232 >= 100 → injects despite micro pending",
  );
  assert.equal(turn.nudge.tier, 2);
});

test("pressure: minPressureBenefitTokens 0 restores legacy any-pending behavior", () => {
  const core = createCore();
  const config = buildConfig({
    nudge: { ...buildConfig().nudge, minPressureBenefitTokens: 0 },
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  state = { ...state, blocks: [coverAllBlock(messages, 928)] };
  const turn = core.processTurn({ messages, state, config, tokenCount: 99000 });
  assert.equal(
    turn.nudge.shouldInject,
    true,
    "legacy: any pending > 0 under pressure",
  );
  assert.equal(turn.nudge.tier, 2);
});
