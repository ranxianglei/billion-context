import { test } from "node:test";
import assert from "node:assert/strict";
import { syncBlocks } from "../src/sync.js";
import { defaultConfig, validateConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

function msg(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: id };
}

function makeBlock(
  overrides: Partial<CompressionBlock> & { blockId: string },
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("syncBlocks deactivates blocks whose messages are all gone", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["gone1", "gone2"] }),
    makeBlock({ blockId: "b2", effectiveMessageIds: ["kept", "also-gone"] }),
  );

  const result = syncBlocks([msg("kept")], state);
  assert.deepEqual(result.deactivated, ["b1"]);
  assert.equal(result.state.blocks[0]!.active, false);
  assert.equal(result.state.blocks[1]!.active, true);
});

test("syncBlocks leaves blocks intact when at least one message remains", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["a", "b"] }),
  );
  const result = syncBlocks([msg("a")], state);
  assert.deepEqual(result.deactivated, []);
  assert.equal(result.state.blocks[0]!.active, true);
});

test("syncBlocks keeps expanded (user-decompressed) blocks deactivated when present", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: ["a", "b"],
      active: false,
      expanded: true,
    }),
  );
  const result = syncBlocks([msg("a"), msg("b")], state);
  assert.equal(
    result.state.blocks[0]!.active,
    false,
    "expanded block must stay deactivated",
  );
  assert.deepEqual(
    result.deactivated,
    [],
    "expanded block is not reported as orphaned",
  );
});

test("syncBlocks re-activates a deactivated (non-expanded) block when its messages return", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: ["a", "b"],
      active: false,
    }),
  );
  const result = syncBlocks([msg("a"), msg("b")], state);
  assert.equal(
    result.state.blocks[0]!.active,
    true,
    "legacy resurrection preserved for non-expanded blocks",
  );
});

test("syncBlocks keeps block active when view emits base id for sub-id block (#231)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: ["h_abc#r0", "h_abc#call1"],
    }),
  );
  const result = syncBlocks([msg("h_abc")], state);
  assert.deepEqual(result.deactivated, []);
  assert.equal(result.state.blocks[0]!.active, true);
});

test("syncBlocks keeps block active when view emits sub-ids for base-id block (#231)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] }),
  );
  const result = syncBlocks([msg("h_abc#r0")], state);
  assert.deepEqual(result.deactivated, []);
  assert.equal(result.state.blocks[0]!.active, true);
});

test("syncBlocks still deactivates when the base is truly gone (#231)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc#r0"] }),
  );
  const result = syncBlocks([msg("h_other")], state);
  assert.deepEqual(result.deactivated, ["b1"]);
});

test("syncBlocks does not mutate input state", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["x"] }));
  syncBlocks([], state);
  assert.equal(state.blocks[0]!.active, true);
});

test("defaultConfig provides sensible production defaults", () => {
  const cfg = defaultConfig(200000);
  assert.equal(cfg.modelContextLimit, 200000);
  assert.equal(cfg.promotionThreshold, 5);
  assert.equal(cfg.truncate.threshold, 0.95);
  assert.equal(cfg.nudge.maxContextLimitPct, 0.75);
  assert.equal(cfg.nudge.emergencyThresholdPct, 0.95);
  assert.ok(cfg.tiers.tier3Trigger > cfg.tiers.tier2Trigger);
  assert.equal(cfg.tiers.tier2Trigger, 1000);
  assert.equal(cfg.tiers.tier3Trigger, 2000);
});

test("defaultConfig has no gc namespace (GC removed)", () => {
  const cfg = defaultConfig(200000) as unknown as Record<string, unknown>;
  assert.equal(cfg["gc"], undefined, "gc config namespace must not exist");
});

test("defaultConfig applies overrides", () => {
  const cfg = defaultConfig(200000, { preserveRecentMessages: 20 });
  assert.equal(cfg.preserveRecentMessages, 20);
  assert.equal(cfg.modelContextLimit, 200000);
});

test("validateConfig flags invalid limits", () => {
  const cfg = defaultConfig(200000, { modelContextLimit: -1 } as never);
  assert.ok(validateConfig(cfg).some((e) => e.includes("modelContextLimit")));
});

test("validateConfig flags min > max nudge thresholds", () => {
  const base = defaultConfig(200000);
  base.nudge.minContextLimitPct = 0.8;
  base.nudge.maxContextLimitPct = 0.5;
  assert.ok(validateConfig(base).some((e) => e.includes("minContextLimitPct")));
});

test("validateConfig flags negative or non-finite minPressureBenefitTokens", () => {
  const base = defaultConfig(200000);
  base.nudge.minPressureBenefitTokens = -1;
  assert.ok(
    validateConfig(base).some((e) => e.includes("minPressureBenefitTokens")),
  );
  base.nudge.minPressureBenefitTokens = Number.NaN;
  assert.ok(
    validateConfig(base).some((e) => e.includes("minPressureBenefitTokens")),
  );
});

test("validateConfig accepts explicit minPressureBenefitTokens override", () => {
  const cfg = defaultConfig(200000, { nudge: { minPressureBenefitTokens: 0 } });
  assert.deepEqual(validateConfig(cfg), []);
});

test("validateConfig passes for default config", () => {
  assert.deepEqual(validateConfig(defaultConfig(200000)), []);
});
