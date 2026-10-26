// #2362: dead-ref tracking — a requested endpoint whose ref is known to the
// session but backs no visible or folded message (client history rewrite /
// host-native compaction) is recorded DEAD, receipts forbid retrying it, and
// the tombstone lifts once the message reappears in the resent view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "assistant",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
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
    compress: { minCompressRange: 10, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

// #2362 repro shape: refs m00001..m00008 are known to the session, but the
// client's resent view carries everything EXCEPT m00005/m00006 (a host-native
// compaction or bulk history rewrite dropped them); no block covers them.
function vanishedScenario(): { state: ReturnType<typeof createInitialState>; visible: CoreMessage[] } {
  const state = createInitialState();
  const visible = [
    msg("v1", "one ".repeat(40)),
    msg("v2", "two ".repeat(40)),
    msg("v3", "three ".repeat(40)),
    msg("v4", "four ".repeat(40)),
    msg("v7", "seven ".repeat(40)),
    msg("v8", "eight ".repeat(40)),
  ];
  state.messageRefs = {
    byRaw: {
      v1: "m00001",
      v2: "m00002",
      v3: "m00003",
      v4: "m00004",
      gone5: "m00005",
      gone6: "m00006",
      v7: "m00007",
      v8: "m00008",
    },
    byRef: {
      m00001: "v1",
      m00002: "v2",
      m00003: "v3",
      m00004: "v4",
      m00005: "gone5",
      m00006: "gone6",
      m00007: "v7",
      m00008: "v8",
    },
  };
  return { state, visible };
}

test("dangling endpoints are recorded DEAD and the receipt forbids retrying (#2362)", () => {
  const core = createCore();
  const { state, visible } = vanishedScenario();
  const result = core.applyCompression({
    ranges: [{ startRef: "m00005", endRef: "m00006", summary: "the vanished pair" }],
    messages: visible,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /cannot be anchored/);
  assert.match(result.result.errors[0]!, /no active block covers them/);
  assert.match(result.result.errors[0]!, /recorded as DEAD/);
  assert.match(result.result.errors[0]!, /Do not retry this range in any form/);
  assert.match(result.result.errors[0]!, /refs m00005, m00006 are known/);
  assert.deepEqual(result.state.deadRefs, ["m00005", "m00006"]);
});

test("retrying the same dead range gives the same verdict and grows nothing (#2362 amplification loop)", () => {
  const core = createCore();
  const { state, visible } = vanishedScenario();
  const ranges = [{ startRef: "m00005", endRef: "m00006", summary: "the vanished pair" }];
  const first = core.applyCompression({ ranges, messages: visible, state, config: config() });
  const second = core.applyCompression({ ranges, messages: visible, state: first.state, config: config() });

  assert.deepEqual(second.state.deadRefs, ["m00005", "m00006"], "dead set is stable, not growing");
  assert.match(second.result.errors[0]!, /recorded as DEAD/);
  assert.equal(second.result.blocksCreated, 0);
});

test("a dead tombstone lifts once the message reappears in the resent view (processTurn)", () => {
  const core = createCore();
  const { state, visible } = vanishedScenario();
  state.deadRefs = ["m00005", "m00006"];
  const revived = [
    ...visible.slice(0, 4),
    msg("gone5", "five ".repeat(40)),
    msg("gone6", "six ".repeat(40)),
    ...visible.slice(4),
  ];

  const turn = core.processTurn({
    messages: revived,
    state,
    config: config(),
    tokenCount: 1000,
    renderTags: "none",
  });

  assert.equal(turn.state.deadRefs, undefined, "both tombstones lifted");
});

test("partially revived refs lift individually; the rest stay dead (processTurn)", () => {
  const core = createCore();
  const { state, visible } = vanishedScenario();
  state.deadRefs = ["m00005", "m00006"];
  const halfBack = [
    ...visible.slice(0, 4),
    msg("gone5", "five ".repeat(40)),
    ...visible.slice(4),
  ];

  const turn = core.processTurn({
    messages: halfBack,
    state,
    config: config(),
    tokenCount: 1000,
    renderTags: "none",
  });

  assert.deepEqual(turn.state.deadRefs, ["m00006"]);
});

test("mixed batch: live range compresses, dead range warns DEAD instead of 'already compressed' (#2362)", () => {
  const core = createCore();
  const { state, visible } = vanishedScenario();
  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00004", summary: "live span recap" },
      { startRef: "m00005", endRef: "m00006", summary: "vanished pair" },
    ],
    messages: visible,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1, `live half should fold: ${JSON.stringify(result.result.errors)}`);
  assert.equal(result.result.errors.length, 0);
  const warn = result.result.warnings.find((w) => w.startsWith("Skipped range (m00005..m00006)"));
  assert.ok(warn, `expected a skip warning for the dead range: ${JSON.stringify(result.result.warnings)}`);
  assert.match(warn!, /its refs m00005, m00006 are DEAD/);
  assert.doesNotMatch(warn!, /already compressed/);
  assert.deepEqual(result.state.deadRefs, ["m00005", "m00006"]);
});

test("covered endpoints keep the 'already compressed' verdict; nothing is marked dead", () => {
  const core = createCore();
  const state = createInitialState();
  const visible = [msg("v3", "three ".repeat(40)), msg("v4", "four ".repeat(40))];
  state.messageRefs = {
    byRaw: { a1: "m00001", a2: "m00002", v3: "m00003", v4: "m00004" },
    byRef: { m00001: "a1", m00002: "a2", m00003: "v3", m00004: "v4" },
  };
  state.blocks.push({
    blockId: "b1",
    runId: "r1",
    tier: 1,
    topic: "t",
    summary: "s",
    directMessageIds: ["a1", "a2"],
    effectiveMessageIds: ["a1", "a2"],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
  });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "refold attempt" }],
    messages: visible,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.match(result.result.errors[0]!, /already compressed/);
  assert.match(result.result.errors[0]!, /b1/);
  assert.doesNotMatch(result.result.errors[0]!, /DEAD/);
  assert.equal(result.state.deadRefs, undefined);
});
