import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, STALL_HARVEST_RATIO } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #7464 (direction A, owner-approved 2026-11-22): the T2 default mass gate is
// band-relative — max((t2Pen+t3Pen)/2, nudgeGrowthTokens × 1.5 / 2) — instead
// of the old absolute 1.5 × step (75K at the flat-50K production step).
//
// The defect these tests reproduce: the sick 19.5h session (8421629a) ran a
// tier-1 band that drains as fast as it fills (each T1 fold reclaims its own
// summaries), so t2Pen asymptoted at 45-50K — forever under the 75K absolute
// gate. T2 is the ONLY tier that distills the anchor band itself, so the band
// grew without bound (floor 41K→353K, peak 418K) while T2 never fired once.
//
// All tests below run at PRODUCTION SCALE (the kernel test configs' 100K
// window / 6K step would hide the shape): flat-50K step, 872K window,
// production nudge band, count triggers at their production defaults
// (1000/2000 — disabled at these block counts).
//
// Derived values in buildProdConfig(): nudgeGrowthTokens 50000 → T1 bar
// 50000, T2 floor = round(50000 × 1.5 / 2) = 37500, T3 = 75000, effective
// growth floor max(20000, 0.45 × 50000) = 22500.
//
// Message masses (defaultCountTokens: ASCII len/4): makeMessages message i<10
// = 5000 tokens, i>=10 = 5500 tokens. Block summary mass = summaryChars / 4.

function buildProdConfig(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 1000, tier3Trigger: 2000 },
    nudge: {
      maxContextLimitPct: 0.75,
      minContextLimitPct: 0.45,
      frequency: 1,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 50000,
      growthCap: 50000,
      minGrowthFloor: 20000,
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
    modelContextLimit: 872_000,
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

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) =>
    textMessage(
      i % 2 === 0 ? "user" : "assistant",
      `m${i}`,
      `message ${i} `.repeat(2000),
    ),
  );
}

function t1Blocks(anchorIds: string[], summaryChars: number) {
  return anchorIds.map((anchorId, i) => ({
    blockId: `b${i + 1}`,
    runId: "r1",
    tier: 1 as const,
    summary: "x".repeat(summaryChars),
    directMessageIds: [anchorId],
    effectiveMessageIds: [anchorId],
    directBlockIds: [],
    compressedTokens: summaryChars,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young" as const,
    active: true,
  }));
}

function refOf(
  state: { messageRefs: { byRaw: Record<string, string> } },
  rawId: string,
): string {
  const ref = state.messageRefs.byRaw[rawId];
  assert.ok(ref, `raw id ${rawId} has an assigned ref`);
  return ref;
}

test("#7464 repro: a 45-50K-shaped band distills under the band-relative default", () => {
  const core = createCore();
  const config = buildProdConfig();
  const messages = makeMessages(19);
  let state = createInitialState();

  // Turn 1: stamp the baseline at 340K (39% — under the 45% band).
  state = core.processTurn({ messages, state, config, tokenCount: 340_000 })
    .state;
  // 11 tier-1 blocks × 5000 tok = 55K pending (the sick session's asymptote
  // shape), tail m11..m18 = 8 × 5500 = 44K raw (< the 50K T1 bar).
  state = {
    ...state,
    blocks: t1Blocks(
      ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"],
      20_000,
    ),
  };
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 400_000,
  });
  assert.equal(
    turn.nudge.shouldInject,
    true,
    `band 55K >= gate max(27.5K, 37.5K) and > T1 44K must distill: ${turn.nudge.reason}`,
  );
  assert.equal(turn.nudge.tier, 2, `reason: ${turn.nudge.reason}`);
  // The gate value in the receipt is exact (floor term dominates).
  assert.match(
    turn.nudge.reason ?? "",
    /T2 distill ready: 11 tier-1 blocks \(55000 tokens\) >= 37500 \(band\) and > T1 effective \d+/,
  );
});

test("#7464 counterfactual: the OLD absolute 75K default (pinned) starves the same band", () => {
  const core = createCore();
  const config = buildProdConfig({
    nudge: {
      ...buildProdConfig().nudge,
      tierGrowthTokens: { t2: 75_000 },
    },
  });
  const messages = makeMessages(19);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 340_000 })
    .state;
  state = {
    ...state,
    blocks: t1Blocks(
      ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8", "m9", "m10"],
      20_000,
    ),
  };
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 400_000,
  });
  // 55K < 75K (old default) and T1 44K < 50K → nothing injects: this is the
  // exact starvation the sick session hit all night.
  assert.equal(
    turn.nudge.shouldInject,
    false,
    `old absolute gate must stay the escape hatch: ${turn.nudge.reason}`,
  );
});

test("#7464 floor: a tiny band stays silent (negative direction, #3617)", () => {
  const core = createCore();
  const config = buildProdConfig();
  const messages = makeMessages(2);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 340_000 })
    .state;
  // 1 block × 2000 tok < 37500 floor; tail 5000 < 50K T1 bar.
  state = { ...state, blocks: t1Blocks(["m0"], 8_000) };
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 400_000,
  });
  assert.equal(
    turn.nudge.shouldInject,
    false,
    `tiny band must not distill on noise: ${turn.nudge.reason}`,
  );
});

test("#7464 ratio term: a tier-2-heavy band gates T2 out and routes to T3", () => {
  const core = createCore();
  const config = buildProdConfig();
  const messages = makeMessages(14);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 340_000 })
    .state;
  // 8 tier-1 blocks × 5000 = 40K; one tier-2 block at 100K (spread of the
  // first seeded block, #5698-(G) pattern). Gate = max((40K+100K)/2 = 70K,
  // 37.5K) = 70K > 40K → T2 blocked; T3: 100K >= 75K (absolute, unchanged)
  // and > 40K and > 32K → tier 3.
  const t1 = t1Blocks(
    ["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"],
    20_000,
  );
  state = {
    ...state,
    blocks: [
      ...t1,
      {
        ...t1[0],
        blockId: "bT3",
        tier: 2 as const,
        summary: "y".repeat(400_000),
        directMessageIds: [],
        directBlockIds: [t1[0].blockId],
      },
    ],
  };
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 400_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 3, `reason: ${turn.nudge.reason}`);
  assert.match(turn.nudge.reason ?? "", /T3 condense ready: 1 tier-2 blocks/);
});

test("#7464 x #5698: the stall escalation becomes REACHABLE at production scale", () => {
  const core = createCore();
  const config = buildProdConfig();
  const messages = makeMessages(19);
  let state = createInitialState();

  // Turn 1: baseline 340K. Turn 2: T1 fires (raw tail 59.5K >= 50K).
  state = core.processTurn({ messages, state, config, tokenCount: 340_000 })
    .state;
  state = { ...state, blocks: t1Blocks(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"], 20_000) };
  const t1Turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 400_000,
  });
  assert.equal(t1Turn.nudge.tier, 1, `reason: ${t1Turn.nudge.reason}`);
  state = t1Turn.state;
  const offered = state.nudge.lastT1FirePending ?? 0;
  assert.ok(offered > 0, "the T1 fire banks its offered pending");

  // The model answers with a tiny partial fold (the #5671 treadmill shape) →
  // stall set. Band stays at 40K + 500 tok summary = 40.5K: above the new
  // 37.5K floor, below the old 75K default, and t1Eff (~54K) STILL dominates
  // it — so neither the normal T2 path (needs t2Pen > t1Eff) nor the OLD
  // default could ever fire here. Only #5698's stall path + the new gate
  // unblocks it.
  const folded = core.applyCompression({
    ranges: [
      {
        startRef: refOf(state, "m18"),
        endRef: refOf(state, "m18"),
        summary: "s".repeat(2000),
      },
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

  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 460_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 2, `reason: ${turn.nudge.reason}`);
  // Stall-path receipt (no "and > T1" clause — dominance is waived).
  assert.match(
    turn.nudge.reason ?? "",
    /T2 distill ready: 9 tier-1 blocks \(40500 tokens\) >= 37500 \(band\), usage \d+%/,
  );
  assert.match(turn.nudge.reason ?? "", /\[T1 harvest stall\]/);
});

test("#7464 count path untouched: tier2Trigger fires under any mass gate", () => {
  const core = createCore();
  const config = buildProdConfig({
    tiers: { enabled: true, tier2Trigger: 3, tier3Trigger: 2000 },
  });
  const messages = makeMessages(10);
  let state = createInitialState();
  state = core.processTurn({ messages, state, config, tokenCount: 340_000 })
    .state;
  // 3 tiny blocks (1.5K total — far under the 37.5K floor, and under the
  // 35K T1 pending, so the mass leg fails on BOTH the gate and dominance);
  // only the documented block-count trigger can fire.
  state = { ...state, blocks: t1Blocks(["m0", "m1", "m2"], 2_000) };
  const turn = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 400_000,
  });
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 2, `reason: ${turn.nudge.reason}`);
  assert.match(
    turn.nudge.reason ?? "",
    /T2 distill ready: 3 tier-1 blocks >= tier2Trigger 3/,
  );
});
