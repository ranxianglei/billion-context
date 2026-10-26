import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { collectBlockContent } from "../src/decompress.js";
import { renderNudgeText } from "../src/nudge-text.js";
import type { Config, CoreMessage } from "../src/types.js";

// #442 verification shape (request at m00010, fold m00001-m00100, distill).
// Summary CONTENT is model-produced, so do NOT assert on it — assert the two
// kernel guarantees instead: guidance at every hop mandates the carry-forward,
// and block lineage keeps the original ask recoverable via full decompression.

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 1, tier3Trigger: 2 },
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

function msg(id: string, role: CoreMessage["role"], text: string): CoreMessage {
  return { id, role, contentType: "text", text };
}

const OBJECTIVE = "refactor the research runner into eight independent arms";

function makeSession(): CoreMessage[] {
  const messages: CoreMessage[] = [];
  for (let i = 0; i < 100; i++) {
    const role = i === 9 ? "user" : i % 2 === 0 ? "user" : "assistant";
    const text = i === 9 ? `Please ${OBJECTIVE}.` : `message ${i} `.repeat(30);
    messages.push(msg(`m${i}`, role, text));
  }
  return messages;
}

test("open objective at m00010 survives fold + distillation hops (#442)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeSession();

  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 50_000,
  }).state;

  state = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00100",
        summary:
          "T1 fold.\nOpen objectives: refactor research runner into eight arms (m00010).",
      },
    ],
    messages,
    state,
    config,
  }).state;
  const b1 = state.blocks[0]!;
  assert.equal(b1.blockId, "b1");
  assert.equal(b1.tier, 1);
  assert.ok(b1.effectiveMessageIds.includes("m9"), "fold spans the request");

  // A successful compress clears the growth baselines; the next turn restamps
  // them (growth 0), so the distillation nudge arms on the turn after.
  const rearm = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 60_000,
  });
  assert.equal(
    rearm.nudge.shouldInject,
    false,
    `reason: ${rearm.nudge.reason}`,
  );
  const turn = core.processTurn({
    messages,
    state: rearm.state,
    config,
    tokenCount: 70_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 2, `reason: ${turn.nudge.reason}`);
  assert.deepEqual(
    turn.nudge.tierTargetBlocks?.map((b) => b.blockId),
    ["b1"],
    "distillation targets the block covering the request",
  );
  const rendered = renderNudgeText(turn.nudge);
  assert.ok(
    rendered.text.includes("TIER 2 COMPRESSION"),
    "tier-2 distillation rules reach the model",
  );
  assert.ok(
    rendered.text.includes("Open objectives"),
    "guidance at the distillation hop mandates the Open objectives carry-forward",
  );

  state = core.applyCompression({
    ranges: [
      {
        startRef: "b1",
        endRef: "b1",
        summary:
          "Source: b1 (fold m00001-m00100).\nObjective: refactor runner into eight arms (m00010) — open.",
      },
    ],
    messages,
    state,
    config,
  }).state;
  const b2 = state.blocks[1]!;
  assert.equal(b2.blockId, "b2");
  assert.equal(b2.tier, 2, "block-boundary merge promotes the tier");
  assert.deepEqual(b2.directBlockIds, ["b1"]);
  assert.ok(
    b2.effectiveMessageIds.includes("m9"),
    "lineage spans the request across the merge",
  );

  const restored = collectBlockContent(state, b2, messages, { full: true });
  assert.ok(
    restored.text.includes(OBJECTIVE),
    "full decompress recovers the original objective",
  );
  assert.ok(restored.count >= 100, "all folded messages remain recoverable");
});

test("gentle T1 nudge carries the open-objectives rule too (#442)", () => {
  const core = createCore();
  const config = buildConfig({
    tiers: { enabled: false, tier2Trigger: 1000, tier3Trigger: 2000 },
  });
  const messages = makeSession();

  let state = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 10_000,
  }).state;
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 60_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  const rendered = renderNudgeText(turn.nudge);
  assert.ok(
    rendered.text.includes("Open objectives:"),
    "T1 fold guidance names the mandated entry form",
  );
  assert.ok(
    rendered.text.toLowerCase().includes("open-objective status is current"),
    "softened clause present: quotes historical, status current",
  );
});
