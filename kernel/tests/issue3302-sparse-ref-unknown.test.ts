import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CompressionState, CoreMessage } from "../src/types.js";

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
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
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

/** Session with `n` visible messages, refs m00001..m000N assigned. */
function sessionWith(n: number) {
  const core = createCore();
  const state = createInitialState();
  const messages = Array.from({ length: n }, (_, i) => msg(`u${i + 1}`, `content ${i + 1}`));
  state.messageRefs = assignRefs(messages, { existing: state.messageRefs, nextIndex: 1 }).map;
  return { core, state, messages };
}

/** Simulate the host-side prune (session.ts pruneRefsToLiveIds): drop the ref
 *  pair for a message that left the resent view. Returns the raw id. */
function hostPrune(state: CompressionState, ref: string): string {
  const rawId = state.messageRefs.byRef[ref];
  assert.ok(rawId, `${ref} must be allocated`);
  delete state.messageRefs.byRef[ref];
  delete state.messageRefs.byRaw[rawId];
  return rawId;
}

test("in-band gap without tombstone reports sparse-space hole, not cross-session (billion-context#3302)", () => {
  const { core, state, messages } = sessionWith(10);
  const droppedRaw = hostPrune(state, "m00007");
  const view = messages.filter((m) => m.id !== droppedRaw);

  const result = core.applyCompression({
    ranges: [{ startRef: "m00005", endRef: "m00007", summary: "s" }],
    messages: view,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /^range m00005\.\.m00007: /);
  // The reporter's case: endId below the highest allocated ref. The old text
  // asserted "(typo or wrong session)" — false when the gap is a pruned hole.
  assert.match(result.result.errors[0]!, /endId="m00007" was never allocated in this session or was pruned after allocation/);
  assert.match(result.result.errors[0]!, /the ref space is sparse/);
  assert.match(result.result.errors[0]!, /this is not a cross-session ref/);
  assert.doesNotMatch(result.result.errors[0]!, /typo or wrong session/);
});

test("ref above the highest allocated reports stale-generation, names the highest (billion-context#3302)", () => {
  const { core, state, messages } = sessionWith(10);

  const result = core.applyCompression({
    ranges: [{ startRef: "m00099", endRef: "m00100", summary: "s" }],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.match(
    result.result.errors[0]!,
    /startId="m00099" is above this session's highest allocated ref \(m00010\)/,
  );
  assert.match(result.result.errors[0]!, /stale artifact from an earlier generation, or a typo/);
  assert.doesNotMatch(result.result.errors[0]!, /ref space is sparse/);
});

test("tombstoned dead endId snaps to nearest visible message instead of failing (billion-context#3302 Ask 5)", () => {
  const { core, state, messages } = sessionWith(10);
  const droppedRaw = hostPrune(state, "m00007");
  const view = messages.filter((m) => m.id !== droppedRaw);
  state.deadRefs = ["m00007"];

  const result = core.applyCompression({
    ranges: [{ startRef: "m00005", endRef: "m00007", summary: "s" }],
    messages: view,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1, result.result.errors.join("; "));
  assert.ok(
    result.result.warnings.some((w) => w.includes('endId="m00007" no longer backs any visible message')),
    `snapped note missing: ${result.result.warnings.join("; ")}`,
  );
  const block = result.state.blocks[0]!;
  assert.deepEqual(block.effectiveMessageIds.sort(), [messages[4]!.id, messages[5]!.id].sort());
});

test("tombstoned dead startId snaps forward to next visible message (billion-context#3302 Ask 5)", () => {
  const { core, state, messages } = sessionWith(10);
  const droppedRaw = hostPrune(state, "m00007");
  const view = messages.filter((m) => m.id !== droppedRaw);
  state.deadRefs = ["m00007"];

  const result = core.applyCompression({
    ranges: [{ startRef: "m00007", endRef: "m00009", summary: "s" }],
    messages: view,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1, result.result.errors.join("; "));
  assert.ok(
    result.result.warnings.some((w) => w.includes('startId="m00007" no longer backs any visible message')),
    `snapped note missing: ${result.result.warnings.join("; ")}`,
  );
  const block = result.state.blocks[0]!;
  assert.deepEqual(block.effectiveMessageIds.sort(), [messages[7]!.id, messages[8]!.id].sort());
});

test("tombstoned dead ref with no visible neighbor classifies DEAD, not unknown (billion-context#3302 Ask 5)", () => {
  const { core, state, messages } = sessionWith(5);
  // m00006 was allocated in an earlier view and pruned; nothing visible beyond it.
  state.deadRefs = ["m00006"];

  const result = core.applyCompression({
    ranges: [{ startRef: "m00006", endRef: "m00009", summary: "s" }],
    messages,
    state,
    config: config({ compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 } }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /cannot be anchored/);
  assert.match(result.result.errors[0]!, /refs m00006 are known to this session but no longer back any visible or folded message/);
  assert.match(result.result.errors[0]!, /recorded as DEAD/);
  assert.doesNotMatch(result.result.errors[0]!, /unknown to this session/);
  assert.deepEqual(result.state.deadRefs, ["m00006"]);
});

test("all-unknown gate names the failing endpoint per range (billion-context#3302 Ask 2)", () => {
  const { core, state, messages } = sessionWith(10);
  const droppedRaw = hostPrune(state, "m00007");
  const view = messages.filter((m) => m.id !== droppedRaw);

  const result = core.applyCompression({
    ranges: [{ startRef: "m00005", endRef: "m00007", summary: "s" }],
    messages: view,
    state,
    config: config({ compress: { minCompressRange: 5000, maxSummaryLength: 0, minSummaryLength: 0 } }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 2);
  assert.match(result.result.errors[0]!, /None of the 1 requested range\(s\) resolved — every ref is unknown to this session/);
  assert.match(result.result.errors[0]!, /failing endpoints: endId=m00007/);
  assert.match(result.result.errors[0]!, /Do not probe for valid numbers/);
  assert.doesNotMatch(result.result.errors[0]!, /cannot come from an earlier compress in this session/);
  assert.match(result.result.errors[1]!, /endId="m00007" was never allocated in this session or was pruned after allocation/);
});
