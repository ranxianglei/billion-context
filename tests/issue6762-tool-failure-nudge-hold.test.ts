import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { NudgeDecision } from "acp-kernel";
import { emergencyNudge } from "../src/server/budget.ts";

// #6762 host mirror: when decideNudge held the pressure band because the
// latest tool result FAILED (the model is about to act on a fresh failure, and
// a nudge would make it compress and lose the error context), the host
// early-advertising arm (the `||` next to nudge.shouldInject in every prepare
// lane) must NOT re-arm against the same round. Hand-built decisions without
// the breakdown bit keep pre-fix semantics.

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

test("#6762: emergencyNudge does not re-arm what the kernel held for a failed tool result", () => {
  const d = hotDecision({ toolFailureHold: 1 });
  assert.equal(emergencyNudge(d), false);
});

test("#6762: emergencyNudge with an explicit toolFailureHold 0 behaves as pre-fix", () => {
  const d = hotDecision({ toolFailureHold: 0 });
  assert.equal(emergencyNudge(d), true);
});

test("#6762: hand-built decision without the bit keeps pre-fix semantics", () => {
  // No toolFailureHold key at all — the arm arms (pre-fix behavior).
  assert.equal(emergencyNudge(hotDecision()), true);
});
