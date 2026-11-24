import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { NudgeDecision } from "acp-kernel";
import { emergencyNudge } from "../src/server/budget.ts";

// Mirror of the kernel phantom-pressure guard: when decideNudge deferred the
// pressure band because the meter was estimate-grade (no billing sample this
// cycle), the host early-advertising arm (the `||` next to nudge.shouldInject
// in every prepare lane) must NOT re-arm against the same bad reading.
// Hand-built decisions without the breakdown bit keep pre-fix semantics.

function hotDecision(over: Partial<NudgeDecision["breakdown"]> = {}): NudgeDecision {
  return {
    shouldInject: false,
    reason: "",
    compressibleRanges: [
      { startRef: "m00001", endRef: "m00010", count: 10, tokens: 6000, chars: 24000, toolPct: 0, textPct: 100 },
    ],
    contextUsage: 0.99, // above EMERGENCY_NUDGE_ESCALATION_PCT (0.7)
    tier: null,
    breakdown: {
      usage: 0.99,
      growth: 0,
      growthReference: 0,
      effectiveThreshold: 0,
      nudgeGrowthTokens: 0,
      growthFloor: 0,
      hasPendingNudge: 0,
      overLimit: 1,
      emergencyOverride: 1,
      pendingT1: 6000,
      pendingT2: 0,
      pendingT3: 0,
      maxPending: 6000,
      minPressureBenefit: 5000,
      ...over,
    },
  };
}

test("emergencyNudge arms on a hot usage-grade reading with enough pending", () => {
  assert.equal(emergencyNudge(hotDecision()), true);
});

test("emergencyNudge does not re-arm what the kernel deferred for a missing usage sample", () => {
  const d = hotDecision({ pressureDeferredNoSample: 1 });
  assert.equal(emergencyNudge(d), false);
});

test("emergencyNudge with an explicit deferral bit set to 0 behaves as pre-fix", () => {
  const d = hotDecision({ pressureDeferredNoSample: 0 });
  assert.equal(emergencyNudge(d), true);
});
