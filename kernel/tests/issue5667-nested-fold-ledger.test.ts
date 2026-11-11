import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { syncBlocks } from "../src/sync.js";
import { blocksSpannedByRange } from "../src/block-map.js";
import {
  buildCompressibleRanges,
  mergeRangesToThreshold,
} from "../src/recommend.js";
import { formatRanges } from "../src/nudge-text.js";
import { buildStatusReport, projectionErrorDetail } from "../src/report.js";
import type {
  CompressionBlock,
  Config,
  CompressibleRange,
  CoreMessage,
} from "../src/types.js";

// #5667: three state-ledger distortions exposed by nested folding (a new block
// consuming an active one). Regression pins for the A/B/C fixes. See PR body.

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

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

// ─── Defect A: supersedes_block_id written only at consumption ────────────────

test("A: nested fold stamps consumed children with the consumer's id", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = Array.from({ length: 20 }, (_, i) =>
    msg(`id${i + 1}`, `message ${i + 1}`),
  );
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const r1 = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00010", summary: "first ten" },
      { startRef: "m00011", endRef: "m00020", summary: "next ten" },
    ],
    messages,
    state,
    config: config(),
  });
  const childA = r1.state.blocks.find((b) => b.startRef === "m00001")!;
  const childB = r1.state.blocks.find((b) => b.startRef === "m00011")!;
  const r2 = core.applyCompression({
    ranges: [{ startRef: childA.blockId, endRef: childB.blockId, summary: "distilled" }],
    messages,
    state: r1.state,
    config: config(),
  });
  const consumer = r2.state.blocks[r2.state.blocks.length - 1]!;
  assert.equal(consumer.tier, 2);
  const gotA = r2.state.blocks.find((b) => b.blockId === childA.blockId)!;
  const gotB = r2.state.blocks.find((b) => b.blockId === childB.blockId)!;
  assert.equal(gotA.active, false, "consumed child must be inactive");
  assert.equal(gotB.active, false, "consumed child must be inactive");
  assert.equal(gotA.supersedesBlockId, consumer.blockId);
  assert.equal(gotB.supersedesBlockId, consumer.blockId);
  assert.equal(consumer.supersedesBlockId, undefined, "consumer has no parent");
});

test("A: non-consumptive deactivation leaves supersedesBlockId unset", () => {
  const state = createInitialState();
  // Orphan GC: the block's messages are absent from the resent view.
  const orphan = makeBlock({
    blockId: "b-orphan",
    effectiveMessageIds: ["ghost-1"],
  });
  // Host expand: the block is present but explicitly expanded by the host.
  const expanded = makeBlock({
    blockId: "b-expanded",
    expanded: true,
    effectiveMessageIds: ["live-1"],
  });
  // Reconcile re-mark of an already-recorded lineage edge: the consumer lists
  // the child in directBlockIds, sync re-marks it inactive without restamping.
  const parent = makeBlock({
    blockId: "b-parent",
    directBlockIds: ["b-child"],
    effectiveMessageIds: ["live-2"],
  });
  const child = makeBlock({ blockId: "b-child" });
  state.blocks = [orphan, expanded, parent, child];
  const result = syncBlocks([msg("live-1", "a"), msg("live-2", "b")], state);
  const gotOrphan = result.state.blocks.find((b) => b.blockId === "b-orphan")!;
  const gotExpanded = result.state.blocks.find((b) => b.blockId === "b-expanded")!;
  const gotParent = result.state.blocks.find((b) => b.blockId === "b-parent")!;
  const gotChild = result.state.blocks.find((b) => b.blockId === "b-child")!;
  assert.equal(gotOrphan.active, false, "orphan GC must deactivate");
  assert.ok(
    result.deactivated.includes("b-orphan"),
    "orphan GC must record the deactivation",
  );
  assert.equal(gotExpanded.active, false, "host-expanded stays inactive");
  assert.equal(gotParent.active, true, "present consumer stays active");
  assert.equal(gotChild.active, false, "reconcile keeps consumed child inactive");
  assert.equal(
    gotOrphan.supersedesBlockId,
    undefined,
    "orphan-GC death stamps no lineage",
  );
  assert.equal(
    gotExpanded.supersedesBlockId,
    undefined,
    "host-expand death stamps no lineage",
  );
  assert.equal(
    gotChild.supersedesBlockId,
    undefined,
    "reconcile re-mark does not backfill lineage",
  );
});

// ─── Defect B: display-only annotation for a range spanning a folded block ────

test("B: blocksSpannedByRange flags strictly-interior blocks only", () => {
  const spans = [
    { blockId: "b1", tier: 1, startRef: "m00002", endRef: "m00004" },
    { blockId: "b2", tier: 1, startRef: "m00007", endRef: "m00009" },
    { blockId: "b3", tier: 1, startRef: "m00001", endRef: "m00005" },
    { blockId: "b4", tier: 1, startRef: "m00009", endRef: "m00015" },
  ];
  assert.deepEqual(blocksSpannedByRange("m00001", "m00015", spans), [
    "b1",
    "b2",
  ]);
  assert.deepEqual(blocksSpannedByRange("m00005", "m00005", spans), []);
  assert.deepEqual(blocksSpannedByRange("m00015", "m00001", spans), [
    "b1",
    "b2",
  ]);
});

test("B: bridged surface-replace range records the folded interior it spans", () => {
  const a = msg("a", "x".repeat(2000));
  const e = msg("e", "v".repeat(2000));
  const state = createInitialState();
  state.messageRefs = assignRefs(
    [a, msg("b", "y"), msg("c", "z"), msg("d", "w"), e],
    { existing: state.messageRefs, nextIndex: 1 },
  ).map;
  state.blocks.push(
    makeBlock({
      blockId: "bFolded",
      startRef: "m00002",
      endRef: "m00004",
      effectiveMessageIds: ["b", "c", "d"],
    }),
  );
  const ranges = buildCompressibleRanges([a, e], state, config()).compressible;
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.startRef, "m00001");
  assert.equal(ranges[0]!.endRef, "m00005");
  assert.deepEqual(ranges[0]!.crossesCoveredBy, ["bFolded"]);
});

test("B: a range that does not span a block carries no crossesCoveredBy", () => {
  const a = msg("a", "x".repeat(2000));
  const e = msg("e", "v".repeat(2000));
  const state = createInitialState();
  state.messageRefs = assignRefs(
    [a, msg("b", "y"), msg("c", "z"), msg("d", "w"), e],
    { existing: state.messageRefs, nextIndex: 1 },
  ).map;
  const ranges = buildCompressibleRanges([a, e], state, config()).compressible;
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.crossesCoveredBy, undefined);
});

test("B: formatRanges appends 'spans folded' only when the field is set", () => {
  const crossed: CompressibleRange = {
    startRef: "m00001",
    endRef: "m00005",
    count: 2,
    tokens: 1000,
    chars: 4000,
    toolPct: 0,
    textPct: 100,
    crossesCoveredBy: ["bFolded"],
  };
  assert.match(formatRanges([crossed], []), / · spans folded bFolded/);
  const plain: CompressibleRange = {
    startRef: "m00001",
    endRef: "m00005",
    count: 2,
    tokens: 1000,
    chars: 4000,
    toolPct: 0,
    textPct: 100,
  };
  assert.doesNotMatch(formatRanges([plain], []), /spans folded/);
});

test("B: mergeRangesToThreshold carries crossesCoveredBy across a batch", () => {
  const base = { count: 2, chars: 400, toolPct: 50, textPct: 50, tokens: 500 };
  const ranges: CompressibleRange[] = [
    { startRef: "m00001", endRef: "m00002", crossesCoveredBy: ["bX"], ...base },
    { startRef: "m00003", endRef: "m00004", ...base },
  ];
  const merged = mergeRangesToThreshold(ranges, 600);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.crossesCoveredBy, ["bX"]);
});

// ─── Defect C: projection exceptions surface their detail ─────────────────────

test("C: an unresolvable endpoint surfaces the real reason, not a flat verdict", () => {
  const u1 = msg("u1", "please do the thing");
  const t1 = msg("t1", "call skill", "assistant");
  const state = createInitialState();
  // t1's stored ref is BLOCKED (protected tool) — a valid-looking range whose
  // tail endpoint cannot be resolved, so projectUnit throws on it.
  state.messageRefs = {
    byRaw: { u1: "m00001", t1: "BLOCKED" },
    byRef: { m00001: "u1" },
  };
  const out = buildStatusReport(state, [u1, t1], defaultCountTokens, {
    scope: "uncompressed",
    config: config({ protectedTools: ["skill"] }),
    originalMessages: [u1, t1],
  });
  assert.match(out, /not foldable:/);
  assert.doesNotMatch(out, /refs unresolvable/);
  assert.match(out, /Invalid boundary ref/);
});

test("C: projectionErrorDetail falls back when the error carries no message", () => {
  assert.equal(projectionErrorDetail(new Error("")), "no error detail");
  assert.equal(projectionErrorDetail(new Error(" \t\n ")), "no error detail");
  assert.equal(projectionErrorDetail("plain reason"), "plain reason");
  assert.equal(
    projectionErrorDetail(new Error("x".repeat(500))).length,
    120,
    "long details stay truncated",
  );
});
