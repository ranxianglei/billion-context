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
  );

  const result = syncBlocks([msg("kept")], state);
  assert.deepEqual(result.deactivated, ["b1"]);
  assert.equal(result.state.blocks[0]!.active, false);
});

// #4592: upstream kept a block alive as long as SOME covered message remained.
// That is exactly the shape a host rewind leaves behind — the survivors are a
// prefix and the newest end is gone, so the summary describes history that no
// longer exists. Coverage SHAPE decides, not existence: see the head-gap and
// holes tests below for the shapes that must KEEP their summary.
test("syncBlocks deactivates a block whose span was partially truncated (rewind)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["kept", "also-gone"] }),
  );
  const result = syncBlocks([msg("kept")], state);
  assert.deepEqual(result.deactivated, ["b1"]);
  assert.equal(result.state.blocks[0]!.active, false);
});

// #4592: the mirror shape of a rewind. The host dropped OLD history from the
// head; the summary is the only record of it, so dropping the summary too is the
// actual loss. This is what makes sliding-window / head-truncating hosts safe.
test("syncBlocks keeps a block whose oldest coverage the host dropped (head gap)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["old-1", "old-2", "kept"] }),
  );
  const result = syncBlocks([msg("kept"), msg("fresh")], state);
  assert.deepEqual(result.deactivated, []);
  assert.equal(result.state.blocks[0]!.active, true);
});

// #4592: interior gaps are the id-churn shape (client re-serialized its
// history), never the rewind shape. Do not guess: keep the summary and let
// fold-reconcile re-key the churned ids.
test("syncBlocks keeps a block with interior id gaps (churn shape)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["a", "churned", "c"] }),
  );
  const result = syncBlocks([msg("a"), msg("c")], state);
  assert.deepEqual(result.deactivated, []);
  assert.equal(result.state.blocks[0]!.active, true);
});

// #4592: nothing id-shaped survives, but a visible message carries a ledger
// position INSIDE the block's interval — the churn / merged-pair shape (a merge
// legitimately covers fewer ids than positions). The positional witness is
// upstream's #4316 rule, unchanged by the shape decision.
test("syncBlocks keeps a fully-gone block with a position inside its interval (churn witness)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: ["gone-1", "gone-2"],
      startSeq: 1,
      endSeq: 2,
    }),
  );
  const visible: CoreMessage[] = [
    { id: "re-minted", role: "user", contentType: "text", text: "merged", ledgerSeq: 2 },
  ];
  const result = syncBlocks(visible, state);
  assert.deepEqual(result.deactivated, []);
  assert.equal(result.state.blocks[0]!.active, true);
});

// #4592: no id and no position survives -> dead (the plain deletion shape).
test("syncBlocks deactivates a fully-gone block with no positional witness", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: ["gone-1"],
      startSeq: 1,
      endSeq: 1,
    }),
  );
  const visible: CoreMessage[] = [
    { id: "newer", role: "user", contentType: "text", text: "newer", ledgerSeq: 9 },
  ];
  const result = syncBlocks(visible, state);
  assert.deepEqual(result.deactivated, ["b1"]);
  assert.equal(result.state.blocks[0]!.active, false);
});

test("syncBlocks leaves blocks intact when every covered message remains", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["a", "b"] }),
  );
  const result = syncBlocks([msg("a"), msg("b")], state);
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
