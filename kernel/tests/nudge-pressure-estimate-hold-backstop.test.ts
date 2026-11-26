import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #5865 estimate-hold backstop: with nudge.requireUsageSampleForPressure on,
// a run of CONSECUTIVE estimate-grade readings may hold the pressure band for
// at most nudge.maxEstimateHoldRounds rounds (default 2). From the following
// round onward the pressure band fires on the estimate again, so an upstream
// that NEVER reports usage (anonymous zero-baseline / silent-backend sessions,
// #728/#553 — where the local estimate is the only pressure signal) cannot be
// starved forever. A usage-grade reading resets the streak. The state field
// nudge.estimateHoldStreak persists across processTurn calls so the bound is
// stable across restarts like the rest of NudgeState.

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

function turn(
  prev: ReturnType<typeof createInitialState> | undefined,
  tokenCount: number,
  tokenCountSource: "usage" | "estimate" | undefined,
  config?: Config,
) {
  const core = createCore();
  return core.processTurn({
    messages: makeMessages(10),
    state: prev ?? createInitialState(),
    config: config ?? buildConfig(),
    tokenCount,
    ...(tokenCountSource !== undefined ? { tokenCountSource } : {}),
  });
}

test("never-reporting backend: held for rounds 1-2, injects on round 3 (default backstop)", () => {
  let prev = undefined;
  const r1 = turn(prev, 99000, "estimate");
  assert.equal(r1.nudge.shouldInject, false);
  assert.equal(r1.nudge.breakdown.pressureDeferredNoSample, 1);
  assert.match(r1.nudge.reason, /estimate round 1 of 2/);
  prev = r1.state;

  const r2 = turn(prev, 99000, "estimate");
  assert.equal(r2.nudge.shouldInject, false);
  assert.equal(r2.nudge.breakdown.pressureDeferredNoSample, 1);
  assert.match(r2.nudge.reason, /estimate round 2 of 2/);
  prev = r2.state;

  // Backstop elapsed: the pressure band acts on the estimate instead of
  // starving this session forever (its only pressure signal).
  const r3 = turn(prev, 99000, "estimate");
  assert.equal(r3.nudge.shouldInject, true);
  assert.match(r3.nudge.reason, /^EMERGENCY/);
  assert.equal(r3.nudge.breakdown.pressureDeferredNoSample, 0);
});

test("a usage-grade reading mid-streak resets the backstop counter", () => {
  let prev = undefined;
  const e1 = turn(prev, 99000, "estimate");
  assert.equal(e1.state.nudge.estimateHoldStreak, 1);
  prev = e1.state;

  // Sample lands: injection fires AND the streak clears.
  const u = turn(prev, 99000, "usage");
  assert.equal(u.nudge.shouldInject, true);
  assert.equal(u.state.nudge.estimateHoldStreak, undefined);
  prev = u.state;

  // A fresh aborted round starts the hold over from round 1.
  const e2 = turn(prev, 99000, "estimate");
  assert.equal(e2.nudge.shouldInject, false);
  assert.equal(e2.state.nudge.estimateHoldStreak, 1);
  assert.match(e2.nudge.reason, /estimate round 1 of 2/);
});

test("maxEstimateHoldRounds=0 disables the hold (fires on the first estimate round)", () => {
  const config = buildConfig();
  config.nudge.maxEstimateHoldRounds = 0;
  const t1 = turn(undefined, 99000, "estimate", config);
  assert.equal(t1.nudge.shouldInject, true);
  assert.match(t1.nudge.reason, /^EMERGENCY/);
  assert.equal(t1.nudge.breakdown.pressureDeferredNoSample, 0);
});

test("larger bound extends the window: maxEstimateHoldRounds=4 holds rounds 1-4, fires on 5", () => {
  const config = buildConfig();
  config.nudge.maxEstimateHoldRounds = 4;
  let prev = undefined;
  for (const round of [1, 2, 3, 4]) {
    const r = turn(prev, 99000, "estimate", config);
    assert.equal(r.nudge.shouldInject, false, `round ${round} must stay held`);
    assert.equal(r.nudge.breakdown.pressureDeferredNoSample, 1);
    prev = r.state;
  }
  const r5 = turn(prev, 99000, "estimate", config);
  assert.equal(r5.nudge.shouldInject, true);
  assert.equal(r5.nudge.breakdown.pressureDeferredNoSample, 0);
});

test("legacy callers (source omitted) are byte-identical and never touch the streak", () => {
  let prev = undefined;
  const r1 = turn(prev, 99000);
  assert.equal(r1.nudge.shouldInject, true);
  assert.equal(r1.nudge.breakdown.pressureDeferredNoSample, 0);
  assert.equal(r1.state.nudge.estimateHoldStreak, undefined);
  prev = r1.state;
  const r2 = turn(prev, 99000);
  assert.equal(r2.nudge.shouldInject, true);
  assert.equal(r2.state.nudge.estimateHoldStreak, undefined);
});
