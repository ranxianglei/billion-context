import test from "node:test";
import assert from "node:assert/strict";
import { resolvePrompts } from "../src/prompts.js";
import { renderNudgeText } from "../src/nudge-text.js";

const decision = (
  opts: { emergency?: boolean; tier?: 2 | 3 | null } = {},
): Parameters<typeof renderNudgeText>[0] => ({
  shouldInject: true,
  reason: "test",
  compressibleRanges: [],
  protectedRanges: [],
  activeBlockSpans: [],
  contextUsage: 0.5,
  tier: opts.tier ?? null,
  breakdown: {
    usage: 0.5,
    growth: 100,
    growthReference: 1,
    effectiveThreshold: 0.75,
    nudgeGrowthTokens: 500,
    growthFloor: 200,
    hasPendingNudge: 0,
    overLimit: opts.emergency ? 1 : 0,
    emergencyOverride: 0,
    pendingT1: 0,
    pendingT2: 0,
    pendingT3: 0,
  },
  contextBreakdown: {
    system: 1000,
    tool: 2000,
    summaries: 0,
    code: 500,
    text: 300,
    growth: 100,
  },
  tierTargetBlocks: opts.tier
    ? [
        {
          blockId: "b1",
          tier: 1,
          effectiveMessageIds: ["m1", "m2"],
          compressedTokens: 2000,
          summary: "x".repeat(400),
          topic: "t",
        },
      ]
    : undefined,
});

test("default renders keep guidance sections (omitted overrides)", () => {
  const gentle = renderNudgeText(decision());
  assert.ok(gentle.text.includes("This is an efficiency nudge"));
  const emergency = renderNudgeText(decision({ emergency: true }));
  assert.ok(emergency.text.includes("⚠️ Context limit reached"));
  const t2 = renderNudgeText(decision({ tier: 2 }));
  assert.ok(
    t2.text.includes("Your tier-1 compression summaries have accumulated"),
  );
  const t3 = renderNudgeText(decision({ tier: 3 }));
  assert.ok(
    t3.text.includes("Your tier-2 compression summaries have accumulated"),
  );
});

test("string override replaces the whole section including its framing", () => {
  const gentle = renderNudgeText(decision(), undefined, {
    efficiencyNote: "SHORT.",
  });
  assert.ok(gentle.text.includes("SHORT."));
  assert.ok(!gentle.text.includes("efficiency nudge"));
  assert.ok(!gentle.text.includes("Compression Philosophy"));
  const emergency = renderNudgeText(decision({ emergency: true }), undefined, {
    emergencyHeader: "NOW!",
  });
  assert.ok(emergency.text.includes("NOW!"));
  assert.ok(!emergency.text.includes("⚠️ Context limit reached"));
});

test("null override removes the section without leaving blank-line artifacts", () => {
  const t2 = renderNudgeText(decision({ tier: 2 }), undefined, {
    t2Guidance: null,
  });
  assert.ok(!t2.text.includes("tier-1 compression summaries have accumulated"));
  assert.ok(!t2.text.includes("\n\n\n"));
  assert.ok(t2.text.includes("TIER 2 DISTILLATION"));
  assert.ok(t2.text.includes("Target tier-1 blocks"));
  const gentle = renderNudgeText(decision(), undefined, {
    efficiencyNote: null,
  });
  assert.ok(!gentle.text.includes("efficiency nudge"));
  assert.ok(gentle.text.startsWith("Context breakdown:"));
});

test("t3 null and t2 replace are independent", () => {
  const t3 = renderNudgeText(decision({ tier: 3 }), undefined, {
    t3Guidance: null,
  });
  assert.ok(!t3.text.includes("ultra-condensed summary"));
  const t2 = renderNudgeText(decision({ tier: 2 }), undefined, {
    t2Guidance: "CUSTOM-T2",
  });
  assert.ok(t2.text.includes("CUSTOM-T2"));
  assert.ok(!t2.text.includes("Distill them into a single denser"));
});

test("custom prompts still flow through default framings", () => {
  const prompts = resolvePrompts(
    {
      compressPhilosophy: "MY-PHILOSOPHY",
      howToCompressRules: "MY-RULES",
      tier2DistillRules: "MY-T2-RULES",
      tier3CondenseRules: "MY-T3-RULES",
    },
    { acknowledgeRisk: true },
  );
  const gentle = renderNudgeText(decision(), prompts);
  assert.ok(gentle.text.includes("MY-PHILOSOPHY"));
  assert.ok(gentle.text.includes("MY-RULES"));
});
