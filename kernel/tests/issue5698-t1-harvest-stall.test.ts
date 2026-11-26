import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, STALL_HARVEST_RATIO } from "../src/compress.js";
import { validateConfig } from "../src/config.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #5698: the T1 harvest-stall escalation. The treadmill (#5671): the model
// answers a T1 nudge offering ~450K effective pending with a 3-6K fold, every
// turn, forever — t1Eff never drops below the T1 threshold, so the T2/T3
// mass legs (which sit in an else-if BEHIND the T1 leg and additionally
// require t2Pen > t1Eff) can never fire. One distill call would reclaim
// 91.6% of the floor (measured). These tests pin the whole chain:
//   (A) fire → partial fold → stall set → T2 fires AHEAD of T1 → distill
//       clears the stall;
//   (B) an eager fold (harvests the whole offer) never sets the stall;
//   (C) pressure band takes T1 out of the running when a distill tier can
//       pay the minimum benefit;
//   (D) tiers disabled ⇒ the flag is never consulted;
//   (E) fire-pending stamping is consume-once (only the first fold after a
//       fire is judged);
//   (F) stalled but distill mass sub-threshold ⇒ NO escalation (T1 keeps
//       firing, no marker) — the gate's negative direction (#3617);
//   (G) tier-3 condense escalates ahead of T1/T2 while stalled; without the
//       flag the same pre-decision state falls back to T1 (normal ladder).
function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
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

function textMessage(
  role: CoreMessage["role"],
  id: string,
  text: string,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function refOf(state: { messageRefs: { byRaw: Record<string, string> } }, rawId: string): string {
  const ref = state.messageRefs.byRaw[rawId];
  assert.ok(ref, `raw id ${rawId} has an assigned ref`);
  return ref;
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) =>
    textMessage(
      i % 2 === 0 ? "user" : "assistant",
      `m${i}`,
      `message ${i} `.repeat(2000),
    ),
  );
}

function t1Blocks(anchorIds: string[][], summaryChars: number) {
  return anchorIds.map((effIds, i) => ({
    blockId: `b${i + 1}`,
    runId: "r1",
    tier: 1 as const,
    summary: "x".repeat(summaryChars),
    directMessageIds: effIds,
    effectiveMessageIds: effIds,
    directBlockIds: [],
    compressedTokens: summaryChars,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young" as const,
    active: true,
  }));
}

test("#5698 (A): partial fold sets the stall; T2 fires ahead of T1; distill clears it", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();

  // Turn 1: stamp the baseline (no nudge yet).
  state = core.processTurn({ messages, state, config, tokenCount: 50_000 })
    .state;

  // Turn 2: growth 10k >= floor, usage 60% — T1 fires and banks the offer.
  let turn = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  state = turn.state;
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 1);
  const offered = turn.state.nudge.lastT1FirePending ?? 0;
  assert.ok(offered > 0, "the T1 fire banks its offered pending");
  assert.equal(offered, turn.nudge.breakdown.pendingT1);

  // The model answers with a PARTIAL fold: one tiny range of a huge offer
  // (the #5671 log shape: 3-6K delivered against ~450K offered).
  const folded = core.applyCompression({
    ranges: [
      { startRef: refOf(state, "m0"), endRef: refOf(state, "m0"), summary: "s".repeat(48000) },
    ],
    messages,
    state,
    config,
  });
  assert.equal(folded.result.errors.length, 0, JSON.stringify(folded.result));
  state = folded.state;
  assert.ok(
    folded.result.tokensCompressed < STALL_HARVEST_RATIO * offered,
    `precondition: harvest ${folded.result.tokensCompressed} is partial vs offered ${offered}`,
  );
  assert.equal(state.nudge.t1HarvestStall, true, "partial fold stalls");
  assert.equal(
    state.nudge.lastT1FirePending,
    undefined,
    "the fire stamp is consumed exactly once",
  );

  // Next decision: the stall lets the mass-qualified T2 fire AHEAD of T1
  // (t1Eff is still huge — the raw pile barely shrank — so the normal
  // `t2Pen > t1Eff` path could never fire).
  turn = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  state = turn.state;
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 2, `reason: ${turn.nudge.reason}`);
  assert.match(turn.nudge.reason ?? "", /T2 distill ready: 1 tier-1 blocks/);
  assert.match(turn.nudge.reason ?? "", /\[T1 harvest stall\]/);

  // The model distills the block pile — a working channel clears the stall.
  const first = state.blocks.find((b) => b.active && b.tier === 1)!;
  const distilled = core.applyCompression({
    ranges: [
      { startRef: first.blockId, endRef: first.blockId, summary: "distilled" },
    ],
    messages,
    state,
    config,
  });
  assert.equal(distilled.result.errors.length, 0, JSON.stringify(distilled.result));
  state = distilled.state;
  assert.equal(state.nudge.t1HarvestStall, false, "distill clears the stall");

  turn = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  state = turn.state;
  assert.doesNotMatch(
    turn.nudge.reason ?? "",
    /\[T1 harvest stall\]/,
    `no escalation marker after a cleared stall: ${turn.nudge.reason}`,
  );
});

test("#5698 (B): an eager fold (harvests the whole offer) never sets the stall", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 50_000 })
    .state;
  let turn = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  state = turn.state;
  assert.equal(turn.nudge.tier, 1);
  const offered = turn.state.nudge.lastT1FirePending ?? 0;

  // Fold EVERYTHING the offer covered (the compliant model).
  const folded = core.applyCompression({
    ranges: [
      { startRef: refOf(state, "m0"), endRef: refOf(state, "m9"), summary: "s".repeat(48000) },
    ],
    messages,
    state,
    config,
  });
  assert.equal(folded.result.errors.length, 0, JSON.stringify(folded.result));
  state = folded.state;
  assert.ok(
    folded.result.tokensCompressed >= STALL_HARVEST_RATIO * offered,
    `precondition: eager harvest ${folded.result.tokensCompressed} vs offered ${offered}`,
  );
  assert.notEqual(state.nudge.t1HarvestStall, true, "eager fold never stalls");
  turn = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  state = turn.state;
  assert.doesNotMatch(
    turn.nudge.reason ?? "",
    /\[T1 harvest stall\]/,
    `no escalation marker on a compliant lane: ${turn.nudge.reason}`,
  );
});

test("#5698 (C): pressure band routes to distillation while T1 is stalled", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(30);
  // T1 raw pending ~390k uncovered vs T2 summary pending 10x10k = 100k —
  // max-pending would pick T1 without the stall. minPressureBenefit for a
  // 100k window is max(5000, 1%) = 5000, so T2 can pay.
  const blocks = t1Blocks(
    [["m0"], ["m1"], ["m2"], ["m3"], ["m4"]],
    10_000,
  );
  // m0..m4 are covered by the blocks; m5..m29 stay raw T1 pending.
  const stalled = {
    ...createInitialState(),
    blocks,
    nudge: { ...createInitialState().nudge, t1HarvestStall: true },
  };
  const turn = core.processTurn({
    messages,
    state: stalled,
    config,
    tokenCount: 92_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 2, `reason: ${turn.nudge.reason}`);
  assert.match(turn.nudge.reason ?? "", /OVER-LIMIT T2 distill/);
  assert.match(turn.nudge.reason ?? "", /\[T1 harvest stall\]/);

  // Counterfactual: the SAME shape without the stall flag picks T1
  // (max-pending arbitration, byte-identical pre-#5698 behavior).
  const unstalled = core.processTurn({
    messages,
    state: { ...stalled, nudge: { ...stalled.nudge, t1HarvestStall: false } },
    config,
    tokenCount: 92_000,
  });
  assert.equal(unstalled.nudge.tier, 1, `reason: ${unstalled.nudge.reason}`);
  assert.doesNotMatch(unstalled.nudge.reason ?? "", /\[T1 harvest stall\]/);
});

test("#5698 (D): tiers disabled — the stall flag is never consulted", () => {
  const core = createCore();
  const config = buildConfig({ tiers: { enabled: false, tier2Trigger: 5, tier3Trigger: 10 } });
  const messages = makeMessages(30);
  const blocks = t1Blocks([["m0"], ["m1"]], 10_000);
  const stalled = {
    ...createInitialState(),
    blocks,
    nudge: { ...createInitialState().nudge, t1HarvestStall: true },
  };
  const turn = core.processTurn({
    messages,
    state: stalled,
    config,
    tokenCount: 92_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 1, `reason: ${turn.nudge.reason}`);
});

test("#5698 (E): only the first fold after a fire is judged (consume-once)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 50_000 })
    .state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  state = turn.state;
  assert.equal(turn.nudge.tier, 1);

  // First fold consumes the stamp and stalls; a SECOND partial fold with no
  // outstanding fire must not re-judge (no denominator → flag untouched).
  const first = core.applyCompression({
    ranges: [{ startRef: refOf(state, "m0"), endRef: refOf(state, "m0"), summary: "s".repeat(5000) }],
    messages,
    state,
    config,
  });
  state = first.state;
  assert.equal(state.nudge.t1HarvestStall, true);

  // Simulate the flag being cleared by a distill, then a partial fold
  // happens again with NO new T1 fire — no stamp → stall stays cleared.
  state = { ...state, nudge: { ...state.nudge, t1HarvestStall: false, lastT1FirePending: undefined } };
  const second = core.applyCompression({
    ranges: [{ startRef: refOf(state, "m1"), endRef: refOf(state, "m1"), summary: "s".repeat(5000) }],
    messages,
    state,
    config,
  });
  assert.equal(second.state.nudge.t1HarvestStall, false);
});

test("#5698 (F): stalled but distill mass sub-threshold — no escalation", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 50_000 })
    .state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  state = turn.state;
  assert.equal(turn.nudge.tier, 1);

  // Tiny partial fold: harvests far less than STALL_HARVEST_RATIO of the offer
  // (stall set) AND the new tier-1 block's summary mass (~250 tokens) stays
  // below the T2 threshold (7500), so no distill tier qualifies.
  const folded = core.applyCompression({
    ranges: [{ startRef: refOf(state, "m0"), endRef: refOf(state, "m0"), summary: "s".repeat(1000) }],
    messages,
    state,
    config,
  });
  state = folded.state;
  assert.equal(state.nudge.t1HarvestStall, true, "tiny partial fold stalls");

  // Negative direction (#3617): a stalled T1 channel must NOT escalate to a
  // distill tier whose own mass is sub-threshold — T1 keeps firing, no marker.
  const next = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  assert.equal(next.nudge.tier, 1, `reason: ${next.nudge.reason}`);
  assert.doesNotMatch(next.nudge.reason ?? "", /\[T1 harvest stall\]/);
});

test("#5698 (G): tier-3 condense escalates ahead of T1/T2 while stalled", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 50_000 })
    .state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 60_000 });
  state = turn.state;
  assert.equal(turn.nudge.tier, 1);

  // Tiny partial fold sets the stall (same shape as F).
  const folded = core.applyCompression({
    ranges: [{ startRef: refOf(state, "m0"), endRef: refOf(state, "m0"), summary: "s".repeat(1000) }],
    messages,
    state,
    config,
  });
  state = folded.state;
  assert.equal(state.nudge.t1HarvestStall, true, "tiny partial fold stalls");

  // Seed an active tier-2 block whose summary mass qualifies for T3
  // (10k tokens >= 7500) and dominates the tier-1 pile — the normal T3 leg
  // can never win (it additionally requires t3Pen > t1Eff ~49k), so only the
  // stall path routes here. syncBlocks only evicts blocks whose anchor ids
  // vanish from the messages, so the seeded block survives the next turn.
  const t1 = state.blocks.find((b) => b.active && b.tier === 1)!;
  const preDecision = {
    ...state,
    blocks: [
      ...state.blocks,
      {
        ...t1,
        blockId: "bT3",
        tier: 2 as const,
        summary: "y".repeat(40_000),
        directMessageIds: [],
        directBlockIds: [t1.blockId],
      },
    ],
  };

  const escalated = core.processTurn({ messages, state: preDecision, config, tokenCount: 60_000 });
  assert.equal(escalated.nudge.tier, 3, `expected T3 escalation: ${escalated.nudge.reason}`);
  assert.match(escalated.nudge.reason ?? "", /T3 condense ready: 1 tier-2 blocks/);
  assert.match(escalated.nudge.reason ?? "", /\[T1 harvest stall\]/);

  // Counterfactual: the SAME pre-decision state without the stall flag falls
  // back to T1 on the normal ladder (t3Pen 10k never exceeds t1Eff).
  const unstalled = core.processTurn({
    messages,
    state: { ...preDecision, nudge: { ...preDecision.nudge, t1HarvestStall: false } },
    config,
    tokenCount: 60_000,
  });
  assert.equal(unstalled.nudge.tier, 1, `reason: ${unstalled.nudge.reason}`);
  assert.doesNotMatch(unstalled.nudge.reason ?? "", /\[T1 harvest stall\]/);
});
