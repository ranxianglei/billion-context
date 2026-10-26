import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNudgeText } from "acp-kernel";
import type { NudgeDecision } from "acp-kernel";

// The Anthropic Messages lane (top-level `system`, `thinking` blocks,
// `tool_use` blocks) primes the model for the Claude-Code compaction
// envelope: it writes `<analysis>...</analysis><summary>...</summary>` as its
// reply text instead of putting the summary in the `compress` tool's
// `content` argument. A reply with no tool call ends the turn, so the
// session stalls until the user types "continue". The lane note names both
// the failure and the required delivery shape.

const NOTE =
  "Write the summary ONLY as the `compress` tool's `content` argument";

const BASE_BREAKDOWN = {
  usage: 0.5,
  growth: 0,
  growthReference: 0,
  effectiveThreshold: 0,
  nudgeGrowthTokens: 50_000,
  growthFloor: 50_000,
  hasPendingNudge: 0,
  overLimit: 0,
  emergencyOverride: 0,
  pendingT1: 0,
  pendingT2: 0,
  pendingT3: 0,
  maxPending: 0,
};

function decision(overrides: Partial<NudgeDecision> = {}): NudgeDecision {
  return {
    shouldInject: true,
    reason: "test",
    compressibleRanges: [],
    protectedRanges: [],
    activeBlockSpans: [],
    contextUsage: 0.5,
    tier: null,
    breakdown: { ...BASE_BREAKDOWN },
    contextBreakdown: {
      system: 1000,
      tool: 2000,
      summaries: 0,
      code: 500,
      text: 300,
      total: 3900,
      growth: 100,
    },
    ...overrides,
  };
}

test("anthropic lane: growth nudge carries the anti-envelope note", () => {
  const rendered = renderNudgeText(decision(), undefined, {}, "anthropic");
  assert.ok(rendered.text.includes(NOTE), "states the required delivery shape");
  assert.ok(
    rendered.text.includes("Never emit `<analysis>` or `<summary>` tags"),
    "names the envelope the model must not emit",
  );
  assert.ok(
    rendered.text.includes("a reply without a tool call ends the turn"),
    "explains why the envelope breaks the turn",
  );
});

test("anthropic lane: emergency and tier nudges carry the same note", () => {
  const emergency = renderNudgeText(
    decision({ contextUsage: 0.95, breakdown: { ...BASE_BREAKDOWN, emergencyOverride: 1 } }),
    undefined,
    {},
    "anthropic",
  );
  assert.ok(emergency.text.includes(NOTE));

  for (const tier of [2, 3] as const) {
    const distilled = renderNudgeText(
      decision({ tier, tierTargetBlocks: [] }),
      undefined,
      {},
      "anthropic",
    );
    assert.ok(distilled.text.includes(NOTE), `tier-${tier} nudge carries it`);
  }
});

test("non-anthropic lanes and the protocol-neutral default stay unchanged", () => {
  for (const protocol of ["openai", "responses", "google"] as const) {
    const rendered = renderNudgeText(decision(), undefined, {}, protocol);
    assert.ok(
      !rendered.text.includes(NOTE),
      `${protocol} lane keeps its own wording`,
    );
  }
  const neutral = renderNudgeText(decision());
  assert.ok(
    !neutral.text.includes(NOTE),
    "omitted protocol stays protocol-neutral",
  );
});
