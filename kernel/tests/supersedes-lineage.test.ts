import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { syncBlocks } from "../src/sync.js";
import type { Config, CoreMessage } from "../src/types.js";

/** Nested-compression lineage: a block consumed by a later fold is deactivated
 *  but nothing recorded WHICH block consumed it — the DB column
 *  supersedes_block_id has no writer anywhere (grep-verified), so orphaned
 *  inactive blocks are indistinguishable from GC/orphan deactivations and the
 *  web SAVED derivation (max(counter, active-block sum)) loses the consumer's
 *  accounting silently. These tests pin the lineage writer at the single
 *  consumption site (applySingleRange) and its storage mapping. */

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

function makeMessages() {
  return [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a2 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
  ];
}

test("a fold that consumes an active block records the consuming block id on it", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = makeMessages();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  // First fold: m00003..m00004 -> block #1.
  const first = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00004", summary: "s".repeat(80) }],
    messages,
    state,
    config: config(),
  });
  assert.equal(first.result.errors.length, 0);
  assert.equal(first.result.blocksCreated, 1);
  const firstBlock = first.state.blocks[0]!;
  assert.equal(firstBlock.active, true);
  // Negative gate (#3617): a plain fold records no lineage.
  assert.equal(firstBlock.supersedesBlockId, undefined);

  // Second fold over the SAME full log spans covered + new content
  // (m00003..m00006): projection splits the span into new direct messages
  // plus the already-active block as consumed input — the nested path.
  const second = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00006", summary: "s".repeat(120) }],
    messages,
    state: first.state,
    config: config(),
  });
  assert.equal(second.result.errors.length, 0);
  assert.equal(second.result.blocksCreated, 1);
  const secondBlock = second.state.blocks[second.state.blocks.length - 1]!;
  assert.deepEqual(secondBlock.directBlockIds, [firstBlock.blockId]);

  const storedFirst = second.state.blocks.find(
    (b) => b.blockId === firstBlock.blockId,
  )!;
  assert.equal(storedFirst.active, false);
  // THE assertion: the deactivated block names its consumer.
  assert.equal(storedFirst.supersedesBlockId, secondBlock.blockId);
});

test("non-consumption deactivation carries no lineage", () => {
  // A block dropped by view reconciliation (orphan GC / expanded / stale)
  // must NOT gain a supersedes id: absence of the field is what separates
  // "consumed by parent" from every other deactivation cause.
  const core = createCore();
  const state = createInitialState();
  const messages = makeMessages();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const applied = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00004", summary: "s".repeat(80) }],
    messages,
    state,
    config: config(),
  });
  const block = applied.state.blocks[0]!;

  // View that no longer represents the block at all (neither originals nor
  // rendered summary) -> reconciliation deactivates it without any consumer.
  const strippedView = [messages[0]!, messages[6]!];
  const { state: synced } = syncBlocks(strippedView, applied.state);
  const syncedBlock = synced.blocks.find((b) => b.blockId === block.blockId)!;
  assert.equal(syncedBlock.active, false);
  assert.equal(syncedBlock.supersedesBlockId, undefined);
});
