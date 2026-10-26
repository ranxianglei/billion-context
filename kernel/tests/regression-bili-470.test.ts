/**
 * Regression: ranxianglei/billion-context-pi#470 — retrying a range a fresh T1
 * block just absorbed produced a misleading "retry with startId/endId set to
 * active block IDs" gate error → redundant compress call + full-block
 * decompress rework. The gate must name the covering block and only suggest
 * tier distillation when it can actually fire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
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
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function makeSession(nMessages: number) {
  const core = createCore();
  const state = createInitialState();
  const messages: CoreMessage[] = [];
  for (let i = 1; i <= nMessages; i++) {
    const id = `msg${String(i).padStart(4, "0")}`;
    messages.push(
      msg(
        id,
        `${id} work content `.repeat(10),
        i % 2 === 1 ? "user" : "assistant",
      ),
    );
  }
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return { core, state, messages };
}

function seedT1Blocks(
  state: ReturnType<typeof createInitialState>,
  count: number,
) {
  for (let i = 1; i <= count; i++) {
    state.blocks.push({
      blockId: `b${i}`,
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: `s${i}`,
      directMessageIds: [`x${i}`],
      effectiveMessageIds: [`x${i}`],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: true,
    });
  }
  state.nextBlockId = count + 1;
}

test("retrying a sub-range of a fresh T1 block names the covering block, not a stale span (billion-context-pi#470)", () => {
  const { core, state, messages } = makeSession(30);

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00020", summary: "work recap" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(after.blocks.length, 1);
  assert.equal(after.blocks[0]!.blockId, "b1");

  const pruned = prune(messages, after);
  const retry = core.applyCompression({
    ranges: [{ startRef: "m00018", endRef: "m00020", summary: "retry slice" }],
    messages: pruned,
    state: after,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.equal(retry.result.errors.length, 1);
  assert.match(
    retry.result.errors[0]!,
    /Requested range\(s\) already compressed \(e\.g\. m00018\.\.m00020\)/,
  );
  assert.match(
    retry.result.errors[0]!,
    /its content is already summarized in active block\(s\) b1/,
  );
  assert.match(
    retry.result.errors[0]!,
    /use search_context or decompress b1 if you need details from it/,
  );
  assert.match(
    retry.result.errors[0]!,
    /Nothing new to compress in that window/,
  );
  assert.match(retry.result.errors[0]!, /Continue the task/);
  assert.doesNotMatch(
    retry.result.errors[0]!,
    /retry with startId\/endId set to active block IDs/,
  );
  assert.doesNotMatch(retry.result.errors[0]!, /Current active blocks span/);
  assert.doesNotMatch(
    retry.result.errors[0]!,
    /Tier distillation is actionable/,
  );
});

test("gate error offers tier distillation only once the trigger count is reached (billion-context-pi#470)", () => {
  const { core, state, messages } = makeSession(30);
  seedT1Blocks(state, 4);

  const { state: after } = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00020", summary: "work recap" }],
    messages,
    state,
    config: config(),
  });
  assert.equal(after.blocks.length, 5);
  assert.equal(after.blocks[4]!.blockId, "b5");

  const pruned = prune(messages, after);
  const retry = core.applyCompression({
    ranges: [{ startRef: "m00018", endRef: "m00020", summary: "retry slice" }],
    messages: pruned,
    state: after,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(retry.result.blocksCreated, 0);
  assert.match(
    retry.result.errors[0]!,
    /Tier distillation is actionable now: compress\(\{ content: \[\{ startId: "b1", endId: "b5", summary: "\.\.\.", topic: "\.\.\." \}\] \}\) merges those tier-1 blocks into one tier-2 block/,
  );
});

test("protected-exclusion warning tells the model not to re-target excluded refs (billion-context-pi#470)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages: CoreMessage[] = [];
  for (let i = 1; i <= 8; i++) {
    messages.push(
      msg(`p${i}`, `body ${i} `.repeat(20), i % 2 === 1 ? "user" : "assistant"),
    );
  }
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00002", endRef: "m00008", summary: "recap" }],
    messages,
    state,
    config: config({ preserveRecentMessages: 2, preserveRecentTokens: 0 }),
  });

  assert.equal(result.result.blocksCreated, 1);
  const warn = result.result.warnings.find((w) => w.startsWith("Excluded"));
  assert.ok(
    warn,
    `expected an exclusion warning, got: ${JSON.stringify(result.result.warnings)}`,
  );
  assert.match(warn!, /Excluded 2 protected message\(s\) m00007, m00008/);
  assert.match(warn!, /do not target them in another compress call/);
});

test("gate error falls back to stale-ref wording when no active block covers the boundary (billion-context-pi#470)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "x"), msg("k", "z")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.blocks.push(
    {
      blockId: "b2",
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: "s2",
      directMessageIds: ["a"],
      effectiveMessageIds: ["a"],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: false,
    },
    {
      blockId: "b110",
      runId: "r1",
      tier: 1,
      topic: "t",
      summary: "s110",
      directMessageIds: ["k"],
      effectiveMessageIds: ["k"],
      directBlockIds: [],
      createdAt: 0,
      survivedCount: 0,
      generation: "young",
      active: false,
    },
  );

  const result = core.applyCompression({
    ranges: [
      { startRef: "b2", endRef: "b110", summary: "distilled span", topic: "t" },
    ],
    messages,
    state,
    config: config({
      compress: {
        minCompressRange: 5000,
        maxSummaryLength: 0,
        minSummaryLength: 0,
      },
    }),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /Requested range\(s\) already compressed \(e\.g\. b2\.\.b110\)/,
  );
  assert.match(
    result.result.errors[0]!,
    /its refs no longer point to directly compressible content \(stale block ref\(s\) distilled or consumed by higher-tier blocks\)/,
  );
  assert.doesNotMatch(
    result.result.errors[0]!,
    /already summarized in active block/,
  );
});
