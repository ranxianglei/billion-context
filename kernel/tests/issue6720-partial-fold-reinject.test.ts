import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, STALL_HARVEST_RATIO } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6720: the partial-fold ratchet. A weak model answers a T1 nudge with a
// PARTIAL fold (harvests < STALL_HARVEST_RATIO of the offered pending), leaving
// the remainder on the table. That remainder rides along, the tail grows 10-20K
// by the next nudge, and the post-fold floor rises monotonically — because the
// next T1 re-offer waits for a FULL growth floor (50K) of new tokens before it
// can fire again, and a low-usage long session (1M window, usage <= 24%) never
// crosses minContextLimitPct, so the first-sight/backlog bypasses never fire
// either. The fix arms a ONE-SHOT re-inject on a partial fold: the next request
// re-offers T1 without the full growth wait, and the receipt names the
// unharvested remainder. These tests pin the whole chain:
//   (A) partial fold arms the flag + reports remainingPending; the NEXT request
//       (no growth, low usage) re-injects T1 via the re-inject branch;
//   (B) the re-inject is NOT gated on usage (fires at 30% < minContextLimitPct);
//   (C) the re-inject is one-shot: once displayed, the flag clears and the next
//       no-growth request does NOT re-fire (no loop on an ignored re-offer);
//   (D) a compliant FULL fold never arms the flag (negative direction, #3617).
//
// The scenarios deliberately run at LOW usage (below minContextLimitPct): after
// a fold the baselines clear, so at HIGH usage the first-sight mass bypass would
// fire T1 through the normal growth path and mask the re-inject branch. Low
// usage is exactly the 1M-window shape the issue reports.
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

// Drive a session to a T1 fire at LOW usage (below minContextLimitPct) and
// return the state + the offered pending, ready for a fold.
function toT1Fire(core: ReturnType<typeof createCore>, config: Config, messages: CoreMessage[]) {
  let state = createInitialState();
  // Turn 1: stamp the baseline at low usage (20% < 45% minContextLimitPct).
  state = core.processTurn({ messages, state, config, tokenCount: 20_000 }).state;
  // Turn 2: growth 10k >= floor 5k — the growth leg fires T1 (no usage gate).
  const turn = core.processTurn({ messages, state, config, tokenCount: 30_000 });
  state = turn.state;
  assert.equal(turn.nudge.shouldInject, true, `reason: ${turn.nudge.reason}`);
  assert.equal(turn.nudge.tier, 1, `reason: ${turn.nudge.reason}`);
  const offered = turn.state.nudge.lastT1FirePending ?? 0;
  assert.ok(offered > 0, "the T1 fire banks its offered pending");
  return { state, offered };
}

test("#6720 (A): partial fold arms the re-inject; the next no-growth request re-offers T1", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  const { state: fired, offered } = toT1Fire(core, config, messages);

  // The model answers with a PARTIAL fold: one tiny range of a huge offer
  // (the #6720 log shape: 4-17K delivered against ~50K offered).
  const folded = core.applyCompression({
    ranges: [
      { startRef: refOf(fired, "m0"), endRef: refOf(fired, "m0"), summary: "s".repeat(2000) },
    ],
    messages,
    state: fired,
    config,
  });
  assert.equal(folded.result.errors.length, 0, JSON.stringify(folded.result));
  const state = folded.state;
  assert.ok(
    folded.result.tokensCompressed < STALL_HARVEST_RATIO * offered,
    `precondition: harvest ${folded.result.tokensCompressed} is partial vs offered ${offered}`,
  );
  assert.equal(state.nudge.partialFoldReinjectArmed, true, "partial fold arms the re-inject");
  assert.equal(state.nudge.t1HarvestStall, true, "partial fold also sets the stall");
  // The receipt surface: the unharvested remainder is reported.
  assert.ok(
    folded.result.remainingPending !== undefined && folded.result.remainingPending > 0,
    `remainingPending reported: ${JSON.stringify(folded.result)}`,
  );
  assert.equal(
    folded.result.remainingPending,
    Math.max(0, offered - folded.result.tokensCompressed),
    "remainingPending = offered - harvested",
  );

  // Next request: NO growth (same tokenCount), low usage. The normal growth
  // gate is blocked (growth 0 < floor 5k; first-sight off at low usage) — only
  // the re-inject branch can fire T1.
  const next = core.processTurn({ messages, state, config, tokenCount: 30_000 });
  assert.equal(next.nudge.shouldInject, true, `reason: ${next.nudge.reason}`);
  assert.equal(next.nudge.tier, 1, `reason: ${next.nudge.reason}`);
  assert.match(next.nudge.reason ?? "", /partial-fold re-inject/);
});

test("#6720 (B): the re-inject is not gated on usage (fires at 30% < minContextLimitPct)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  const { state: fired, offered } = toT1Fire(core, config, messages);
  const folded = core.applyCompression({
    ranges: [
      { startRef: refOf(fired, "m0"), endRef: refOf(fired, "m0"), summary: "s".repeat(2000) },
    ],
    messages,
    state: fired,
    config,
  });
  const state = folded.state;
  assert.ok(folded.result.tokensCompressed < STALL_HARVEST_RATIO * offered);
  assert.equal(state.nudge.partialFoldReinjectArmed, true);

  // 30% usage is below minContextLimitPct (45%): the first-sight mass bypass
  // and the backlog drain are both usage-gated OFF. Only the re-inject — which
  // is deliberately NOT usage-gated — can re-offer T1 here.
  const next = core.processTurn({ messages, state, config, tokenCount: 30_000 });
  assert.equal(next.nudge.shouldInject, true, `reason: ${next.nudge.reason}`);
  assert.equal(next.nudge.tier, 1, `reason: ${next.nudge.reason}`);
  assert.match(next.nudge.reason ?? "", /partial-fold re-inject/);
  assert.match(next.nudge.reason ?? "", /usage 30%/);
});

test("#6720 (C): the re-inject is one-shot — an ignored re-offer does not loop", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  const { state: fired } = toT1Fire(core, config, messages);
  const folded = core.applyCompression({
    ranges: [
      { startRef: refOf(fired, "m0"), endRef: refOf(fired, "m0"), summary: "s".repeat(2000) },
    ],
    messages,
    state: fired,
    config,
  });
  const state = folded.state;
  assert.equal(state.nudge.partialFoldReinjectArmed, true);

  // The re-inject fires and is DISPLAYED — the nudge-stamp node consumes the
  // one-shot flag on display (not on fold).
  const reinject = core.processTurn({ messages, state, config, tokenCount: 30_000 });
  assert.equal(reinject.nudge.tier, 1, `reason: ${reinject.nudge.reason}`);
  assert.match(reinject.nudge.reason ?? "", /partial-fold re-inject/);
  assert.equal(
    reinject.state.nudge.partialFoldReinjectArmed,
    false,
    "displaying the re-inject clears the one-shot flag",
  );

  // The model IGNORES the re-offer (no fold). The next no-growth request must
  // NOT re-inject: the flag is cleared and the normal growth gate re-asserts.
  const after = core.processTurn({
    messages,
    state: reinject.state,
    config,
    tokenCount: 30_000,
  });
  assert.doesNotMatch(after.nudge.reason ?? "", /partial-fold re-inject/);
  assert.equal(after.nudge.shouldInject, false, `no loop on an ignored re-offer: ${after.nudge.reason}`);
});

test("#6720 (D): a compliant full fold never arms the re-inject (negative direction)", () => {
  const core = createCore();
  const config = buildConfig();
  const messages = makeMessages(10);
  const { state: fired, offered } = toT1Fire(core, config, messages);

  // Fold EVERYTHING the offer covered (the compliant model).
  const folded = core.applyCompression({
    ranges: [
      { startRef: refOf(fired, "m0"), endRef: refOf(fired, "m9"), summary: "s".repeat(48000) },
    ],
    messages,
    state: fired,
    config,
  });
  assert.equal(folded.result.errors.length, 0, JSON.stringify(folded.result));
  const state = folded.state;
  assert.ok(
    folded.result.tokensCompressed >= STALL_HARVEST_RATIO * offered,
    `precondition: eager harvest ${folded.result.tokensCompressed} vs offered ${offered}`,
  );
  assert.notEqual(
    state.nudge.partialFoldReinjectArmed,
    true,
    "a full fold never arms the re-inject",
  );
  assert.equal(
    folded.result.remainingPending,
    undefined,
    "no remainingPending on a compliant fold",
  );
});
