import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { renderNudgeText } from "../src/nudge-text.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type {
  CompressionBlock,
  CompressionState,
  NudgeDecision,
} from "../src/types.js";

function block(overrides: Partial<CompressionBlock>): CompressionBlock {
  return {
    blockId: "b0",
    runId: "r0",
    tier: 1,
    summary: "summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 1000,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

// Mirrors bcp#330 session 01a07b3c: 41 active blocks (35 T1 + 6 T2) — the
// exact condition under which a tier-2 distillation nudge fires AND the
// overview's 30-entry cap starts hiding active target-tier blocks.
function makeSessionState(): CompressionState {
  const blocks: CompressionBlock[] = [];
  for (let i = 1; i <= 35; i++) {
    blocks.push(
      block({
        blockId: `b${i}`,
        tier: 1,
        summary: `tier-1 summary ${i}`,
        topic: `topic-${i}`,
        compressedTokens: 8000 + i * 100,
        effectiveMessageIds: Array.from({ length: 5 }, (_, j) => `m${i}_${j}`),
        createdAt: 1000 + i,
      }),
    );
  }
  for (let i = 36; i <= 41; i++) {
    blocks.push(
      block({
        blockId: `b${i}`,
        tier: 2,
        summary: `tier-2 summary ${i}`,
        topic: `distilled-${i}`,
        compressedTokens: 40000 + i * 100,
        effectiveMessageIds: Array.from({ length: 40 }, (_, j) => `m${i}_${j}`),
        directBlockIds: [`b${i - 3}`],
        createdAt: 5000 + i,
      }),
    );
  }
  return { ...createInitialState(), blocks };
}

function tier2Decision(state: CompressionState): NudgeDecision {
  const targets = state.blocks.filter((b) => b.active && b.tier === 1);
  return {
    shouldInject: true,
    reason: "tier-2 distillation pending",
    compressibleRanges: [],
    contextUsage: 0.7,
    tier: 2,
    tierTargetBlocks: targets,
    breakdown: {
      usage: 0.7,
      growth: 0,
      growthReference: 0,
      effectiveThreshold: 0,
      nudgeGrowthTokens: 0,
      growthFloor: 0,
      hasPendingNudge: 1,
      overLimit: 0,
      emergencyOverride: 0,
      pendingT1: targets.length,
      pendingT2: 0,
      pendingT3: 0,
    },
  };
}

test("overview announces truncated block lists instead of hiding them (#221)", () => {
  const state = makeSessionState();
  const report = buildStatusReport(state, [], defaultCountTokens);
  assert.ok(report.includes("41 active"), "header keeps the full active count");
  const shownIds = state.blocks
    .filter((b) => b.active)
    .map((b) => b.blockId)
    .filter((id) => report.includes(`${id} (`));
  assert.ok(
    shownIds.length < 41,
    "the list itself is capped below the full count",
  );
  assert.match(
    report,
    /11 more blocks not shown/,
    "states the exact hidden count",
  );
  assert.ok(
    report.includes('scope:"compressed"'),
    "points at the view that shows the full list",
  );
});

test("nudge target list vs status overview reconcile once truncation is announced (#221)", () => {
  const state = makeSessionState();
  const decision = tier2Decision(state);
  const nudge = renderNudgeText(decision);
  assert.ok(
    nudge.text.includes("Target tier-1 blocks to distill (35)"),
    "nudge lists all 35 targets",
  );
  for (const id of ["b1", "b20", "b35"]) {
    assert.ok(nudge.text.includes(`${id} `), `nudge names ${id}`);
  }

  const report = buildStatusReport(state, [], defaultCountTokens);
  const t1Shown = state.blocks.filter(
    (b) => b.active && b.tier === 1 && report.includes(`${b.blockId} (T1)`),
  ).length;
  assert.ok(
    t1Shown < 35,
    "size-sorted cap hides some T1 targets from the overview",
  );
  assert.ok(report.includes("41 active"));
  assert.match(
    report,
    /11 more blocks not shown/,
    "shown + announced-hidden reconciles with the nudge count",
  );
  assert.match(report, /T1: .*\(35 blocks\)/);
  assert.match(report, /T2: .*\(6 blocks\)/);
});

test("overview does not announce truncation when the list fits", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [block({ blockId: "b1" }), block({ blockId: "b2" })],
  };
  const report = buildStatusReport(state, [], defaultCountTokens);
  assert.ok(!report.includes("more blocks not shown"));
});
