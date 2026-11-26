import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// Phantom-pressure guard: pressure band (usage >= maxContextLimitPct /
// emergencyThresholdPct) + an ESTIMATE-grade meter reading (no billing sample
// this cycle — aborted turn, cache-TTL expiry) => injection deferred while
// the estimate-hold backstop (nudge.maxEstimateHoldRounds, default 2)
// allows. Billed readings ("usage") and legacy callers (source omitted) keep
// byte-identical behavior; nudge.requireUsageSampleForPressure = false
// restores estimate-driven pressure injection immediately.
// Non-pressure tiers ignore the source entirely.

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

// 10 messages × ~5.5k est. tokens ≈ 55k pending T1 — comfortably above the
// default minPressureBenefit (max(5000, round(100000 × 0.01)) = 5000).
function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) =>
    textMessage(i % 2 === 0 ? "user" : "assistant", `m${i}`, `message ${i} `.repeat(2000)),
  );
}

function runTurn(
  tokenCount: number,
  tokenCountSource?: "usage" | "estimate",
  config?: Config,
) {
  const core = createCore();
  return core.processTurn({
    messages: makeMessages(10),
    state: createInitialState(),
    config: config ?? buildConfig(),
    tokenCount,
    ...(tokenCountSource !== undefined ? { tokenCountSource } : {}),
  });
}

test("pressure band + estimate meter holds EMERGENCY injection inside the backstop window", () => {
  const turn = runTurn(99000, "estimate"); // >= emergencyThresholdPct 0.98
  assert.equal(turn.nudge.shouldInject, false);
  assert.match(turn.nudge.reason, /estimate-grade/);
  assert.match(turn.nudge.reason, /estimate round 1 of 2/);
  assert.match(turn.nudge.reason, /^EMERGENCY:/);
  assert.equal(turn.nudge.breakdown.pressureDeferredNoSample, 1);
  assert.equal(turn.nudge.breakdown.emergencyOverride, 1);
});

test("pressure band + estimate meter holds OVER-LIMIT too (sub-emergency band)", () => {
  const turn = runTurn(95000, "estimate"); // >= 0.9, < 0.98
  assert.equal(turn.nudge.shouldInject, false);
  assert.match(turn.nudge.reason, /^OVER-LIMIT:/);
  assert.match(turn.nudge.reason, /estimate round 1 of 2/);
  assert.equal(turn.nudge.breakdown.pressureDeferredNoSample, 1);
});

test("same hot reading with a usage-grade meter still injects (byte-identical path)", () => {
  const turn = runTurn(99000, "usage");
  assert.equal(turn.nudge.shouldInject, true);
  assert.match(turn.nudge.reason, /^EMERGENCY/);
  assert.equal(turn.nudge.breakdown.pressureDeferredNoSample, 0);
});

test("legacy caller (source omitted) keeps injecting under pressure", () => {
  const turn = runTurn(99000);
  assert.equal(turn.nudge.shouldInject, true);
  assert.equal(turn.nudge.breakdown.pressureDeferredNoSample, 0);
});

test("nudge.requireUsageSampleForPressure=false restores estimate-driven pressure injection", () => {
  const config = buildConfig();
  config.nudge.requireUsageSampleForPressure = false;
  const turn = runTurn(99000, "estimate", config);
  assert.equal(turn.nudge.shouldInject, true);
  assert.match(turn.nudge.reason, /^EMERGENCY/);
});

test("non-pressure tier decisions are identical for estimate and usage meters", () => {
  const est = runTurn(52000, "estimate"); // 52% — above min band, below pressure
  const usage = runTurn(52000, "usage");
  assert.deepEqual(
    { shouldInject: est.nudge.shouldInject, tier: est.nudge.tier, reason: est.nudge.reason },
    { shouldInject: usage.nudge.shouldInject, tier: usage.nudge.tier, reason: usage.nudge.reason },
  );
  assert.notEqual(est.nudge.breakdown.emergencyOverride, 1);
  assert.equal(est.nudge.breakdown.pressureDeferredNoSample, 0);
});
