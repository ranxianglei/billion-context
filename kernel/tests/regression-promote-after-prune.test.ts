import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { prune, isSummaryMessageId, summaryMessageId } from "../src/prune.js";
import { syncBlocks } from "../src/sync.js";
import type { CompressionState, Config, CoreMessage } from "../src/types.js";

// Regression tests for dog/billion-context-pi#195: compress cannot promote an
// active block after pruning replaces its raw messages with the synthetic
// `acp_summary_bN` message. Most tests FAIL against the pre-fix code; the
// consumed-semantics test pins behavior that must be preserved (it passed
// pre-fix only by accident — the anchor lookup failed — and must not regress
// now that visibleBlockAnchor makes those anchors resolvable).

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
      tier2GrowthMultiplier: 1.5,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 5,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

interface BlockSpec {
  blockId: string;
  effectiveMessageIds: string[];
  directMessageIds?: string[];
  directBlockIds?: string[];
  tier?: 1 | 2 | 3;
  active?: boolean;
}

function makeState(specs: BlockSpec[], nextBlockId: number): CompressionState {
  const state = createInitialState();
  state.blocks = specs.map((spec) => ({
    blockId: spec.blockId,
    runId: "r1",
    tier: spec.tier ?? 1,
    topic: undefined,
    summary: `T${spec.tier ?? 1} summary for ${spec.blockId}.`,
    directMessageIds: [...(spec.directMessageIds ?? spec.effectiveMessageIds)],
    effectiveMessageIds: [...spec.effectiveMessageIds],
    directBlockIds: [...(spec.directBlockIds ?? [])],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young" as const,
    active: spec.active ?? true,
  }));
  state.nextBlockId = nextBlockId;
  return state;
}

test("promote-after-prune: single T1 block promotes to T2 after its raws were replaced by the summary", () => {
  const core = createCore();
  const cfg = config();
  const messages = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a1 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
  ];
  const state = makeState(
    [{ blockId: "b2", effectiveMessageIds: ["raw-3", "raw-4"] }],
    3,
  );

  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 5000,
  });
  const visibleIds = turn.messages.map((m) => m.id);
  // Prune replaced the covered raws with the synthetic summary…
  assert.ok(
    visibleIds.includes(summaryMessageId("b2")),
    "summary should be visible",
  );
  assert.ok(!visibleIds.includes("raw-3"), "raw-3 should be hidden");
  assert.ok(!visibleIds.includes("raw-4"), "raw-4 should be hidden");
  // …and sync must NOT have deactivated the block just because its raws vanished.
  const b2 = turn.state.blocks.find((b) => b.blockId === "b2")!;
  assert.equal(b2.active, true, "b2 must stay active post-prune");

  const applied = core.applyCompression({
    ranges: [{ startRef: "b2", endRef: "b2", summary: "S".repeat(80) }],
    messages: turn.messages,
    state: turn.state,
    config: cfg,
  });
  assert.deepEqual(
    applied.result.errors,
    [],
    `unexpected errors: ${applied.result.errors.join("; ")}`,
  );
  assert.equal(applied.result.blocksCreated, 1);

  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  assert.equal(newBlock.tier, 2);
  assert.deepEqual(newBlock.directBlockIds, ["b2"]);
  assert.deepEqual(newBlock.effectiveMessageIds.sort(), ["raw-3", "raw-4"]);
  // The synthetic id must never leak into durable coverage.
  for (const list of [
    newBlock.effectiveMessageIds,
    newBlock.directMessageIds,
  ]) {
    for (const id of list) {
      assert.ok(
        !id.startsWith("acp_summary_"),
        `synthetic id leaked into block: ${id}`,
      );
    }
  }
  assert.equal(
    applied.state.blocks.find((b) => b.blockId === "b2")!.active,
    false,
  );
});

test("promote-after-prune: two T1 blocks promote into one T2 consuming both", () => {
  const core = createCore();
  const cfg = config();
  const messages = Array.from({ length: 11 }, (_, i) =>
    msg(
      `raw-${i + 1}`,
      `m${i + 1} `.repeat(200),
      i % 2 === 0 ? "user" : "assistant",
    ),
  );
  const state = makeState(
    [
      { blockId: "b2", effectiveMessageIds: ["raw-3", "raw-4"] },
      { blockId: "b3", effectiveMessageIds: ["raw-5", "raw-6"] },
    ],
    4,
  );

  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 9000,
  });
  const applied = core.applyCompression({
    ranges: [{ startRef: "b2", endRef: "b3", summary: "S".repeat(80) }],
    messages: turn.messages,
    state: turn.state,
    config: cfg,
  });
  assert.deepEqual(
    applied.result.errors,
    [],
    `unexpected errors: ${applied.result.errors.join("; ")}`,
  );
  assert.equal(applied.result.blocksCreated, 1);

  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  assert.equal(newBlock.tier, 2);
  assert.deepEqual(newBlock.directBlockIds, ["b2", "b3"]);
  assert.deepEqual(newBlock.effectiveMessageIds.sort(), [
    "raw-3",
    "raw-4",
    "raw-5",
    "raw-6",
  ]);
});

test("promote-after-prune: inclusive bN..bM selection consumes every active block in the span, including ones visible only via their summary", () => {
  const core = createCore();
  const cfg = config({ preserveRecentMessages: 3 });
  const messages = Array.from({ length: 9 }, (_, i) =>
    msg(
      `raw-${i + 1}`,
      `m${i + 1} `.repeat(200),
      i % 2 === 0 ? "user" : "assistant",
    ),
  );
  // raw-1 is the first user message (always kept visible by prune), so
  // coverage starts at raw-3.
  const state = makeState(
    [
      { blockId: "b1", effectiveMessageIds: ["raw-3", "raw-4"] },
      { blockId: "b2", effectiveMessageIds: ["raw-5", "raw-6"] },
      { blockId: "b3", effectiveMessageIds: ["raw-7", "raw-8"] },
    ],
    4,
  );

  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 8000,
  });
  const visibleIds = turn.messages.map((m) => m.id);
  for (const id of ["raw-3", "raw-4", "raw-5", "raw-6", "raw-7", "raw-8"]) {
    assert.ok(!visibleIds.includes(id), `${id} should be hidden`);
  }
  for (const id of ["acp_summary_b1", "acp_summary_b2", "acp_summary_b3"]) {
    assert.ok(visibleIds.includes(id), `${id} should be visible`);
  }

  const applied = core.applyCompression({
    ranges: [{ startRef: "b1", endRef: "b3", summary: "S".repeat(80) }],
    messages: turn.messages,
    state: turn.state,
    config: cfg,
  });
  assert.deepEqual(
    applied.result.errors,
    [],
    `unexpected errors: ${applied.result.errors.join("; ")}`,
  );
  assert.equal(applied.result.blocksCreated, 1);

  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  assert.equal(newBlock.tier, 2);
  assert.deepEqual(newBlock.directBlockIds, ["b1", "b2", "b3"]);
  assert.deepEqual(newBlock.effectiveMessageIds.sort(), [
    "raw-3",
    "raw-4",
    "raw-5",
    "raw-6",
    "raw-7",
    "raw-8",
  ]);
  for (const id of ["b1", "b2", "b3"]) {
    assert.equal(
      applied.state.blocks.find((b) => b.blockId === id)!.active,
      false,
    );
  }
});

test("control: compressing a block BEFORE pruning still works (no behavior change)", () => {
  const core = createCore();
  const cfg = config();
  const messages = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a1 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
  ];
  const state = makeState(
    [{ blockId: "b2", effectiveMessageIds: ["raw-3", "raw-4"] }],
    3,
  );

  const applied = core.applyCompression({
    ranges: [{ startRef: "b2", endRef: "b2", summary: "S".repeat(80) }],
    messages,
    state,
    config: cfg,
  });
  assert.deepEqual(applied.result.errors, []);
  assert.equal(applied.result.blocksCreated, 1);
  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  assert.equal(newBlock.tier, 2);
  assert.deepEqual(newBlock.directBlockIds, ["b2"]);
  assert.deepEqual(newBlock.effectiveMessageIds.sort(), ["raw-3", "raw-4"]);
});

test("syncBlocks: a block whose only visible representation is its rendered summary stays active", () => {
  const state = makeState(
    [{ blockId: "b2", effectiveMessageIds: ["raw-3", "raw-4"] }],
    3,
  );
  const prunedView = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a1 ".repeat(200), "assistant"),
    {
      id: summaryMessageId("b2"),
      role: "system" as const,
      contentType: "text" as const,
      text: "[Compressed conversation section]\nsum",
    },
    msg("raw-5", "u5 ".repeat(200)),
  ];
  const { state: synced, deactivated } = syncBlocks(prunedView, state);
  assert.deepEqual(deactivated, []);
  assert.equal(synced.blocks.find((b) => b.blockId === "b2")!.active, true);
});

test("prune idempotency: re-pruning an already-pruned view keeps the summary in place without duplicating it", () => {
  const state = makeState(
    [{ blockId: "b2", effectiveMessageIds: ["raw-3", "raw-4"] }],
    3,
  );
  const full = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a1 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
  ];
  const once = prune(full, state);
  const twice = prune(once, state);
  assert.deepEqual(
    twice.map((m) => m.id),
    once.map((m) => m.id),
  );
  const summaries = twice.filter((m) => m.id === summaryMessageId("b2"));
  assert.equal(summaries.length, 1);
  assert.equal(
    twice.indexOf(summaries[0]!),
    once.indexOf(once.find((m) => m.id === summaryMessageId("b2"))!),
  );
});

test("promote-after-prune: retrying an m-ref of directly-compressed content still throws consumed on a pruned view", () => {
  const core = createCore();
  const cfg = config();
  const messages = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a1 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
  ];
  const state = makeState(
    [{ blockId: "b2", effectiveMessageIds: ["raw-3", "raw-4"] }],
    3,
  );

  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 5000,
  });
  assert.ok(
    turn.messages.some((m) => m.id === summaryMessageId("b2")),
    "summary should be visible",
  );
  // Refs assigned pre-prune survive pruning — the model can still cite them.
  const ref = turn.state.messageRefs.byRaw["raw-3"];
  assert.ok(ref, "raw-3 must keep its ref even after being pruned");

  const applied = core.applyCompression({
    ranges: [{ startRef: ref!, endRef: ref!, summary: "S".repeat(80) }],
    messages: turn.messages,
    state: turn.state,
    config: cfg,
  });
  // b2 DIRECTLY compressed raw-3 (it is in directMessageIds): no snap, no
  // same-tier duplicate block — the caller must get the bN retry guidance.
  assert.deepEqual(
    applied.result.errors,
    [],
    `unexpected errors: ${applied.result.errors.join("; ")}`,
  );
  assert.equal(applied.result.blocksCreated, 0);
  assert.equal(applied.state.blocks.length, 1);
  assert.equal(
    applied.state.blocks.find((b) => b.blockId === "b2")!.active,
    true,
  );
  assert.ok(
    applied.result.warnings.some((w) => /already compressed/.test(w)),
    `expected consumed guidance, got: ${JSON.stringify(applied.result.warnings)}`,
  );
});

test("promote-after-prune: m-ref range spanning a pruned region consumes the block without leaking synthetic ids", () => {
  const core = createCore();
  const cfg = config({ preserveRecentMessages: 0 });
  const messages = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a1 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
    msg("raw-8", "a8 ".repeat(200), "assistant"),
  ];
  const state = makeState(
    [{ blockId: "b2", effectiveMessageIds: ["raw-3", "raw-4"] }],
    3,
  );

  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 5000,
  });
  const startRef = turn.state.messageRefs.byRaw["raw-2"]!;
  const endRef = turn.state.messageRefs.byRaw["raw-7"]!;

  const applied = core.applyCompression({
    ranges: [{ startRef, endRef, summary: "S".repeat(80) }],
    messages: turn.messages,
    state: turn.state,
    config: cfg,
  });
  assert.deepEqual(
    applied.result.errors,
    [],
    `unexpected errors: ${applied.result.errors.join("; ")}`,
  );
  assert.equal(applied.result.blocksCreated, 1);

  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  // The block under the summary is consumed via its summary anchor…
  assert.deepEqual(newBlock.directBlockIds, ["b2"]);
  // …and its raw coverage is inherited, while the synthetic id never leaks.
  assert.deepEqual(newBlock.effectiveMessageIds.sort(), [
    "raw-2",
    "raw-3",
    "raw-4",
    "raw-5",
    "raw-6",
    "raw-7",
  ]);
  assert.deepEqual(newBlock.directMessageIds.sort(), [
    "raw-2",
    "raw-5",
    "raw-6",
    "raw-7",
  ]);
  for (const id of [
    ...newBlock.effectiveMessageIds,
    ...newBlock.directMessageIds,
  ]) {
    assert.ok(!isSummaryMessageId(id), `synthetic id leaked into block: ${id}`);
  }
  assert.equal(
    applied.state.blocks.find((b) => b.blockId === "b2")!.active,
    false,
  );
});

test("promote-after-prune: compressing a consumed block's bN ref snaps to its active ancestor and distills to T3", () => {
  const core = createCore();
  const cfg = config();
  const messages = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a1 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
  ];
  const state = makeState(
    [
      { blockId: "b2", effectiveMessageIds: ["raw-3", "raw-4"], active: false },
      { blockId: "b3", effectiveMessageIds: ["raw-5", "raw-6"], active: false },
      {
        blockId: "b5",
        effectiveMessageIds: ["raw-3", "raw-4", "raw-5", "raw-6"],
        directMessageIds: [],
        directBlockIds: ["b2", "b3"],
        tier: 2,
      },
    ],
    6,
  );

  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 5000,
  });
  assert.ok(
    turn.messages.some((m) => m.id === summaryMessageId("b5")),
    "b5 summary should be visible",
  );

  const applied = core.applyCompression({
    ranges: [{ startRef: "b2", endRef: "b2", summary: "S".repeat(80) }],
    messages: turn.messages,
    state: turn.state,
    config: cfg,
  });
  assert.deepEqual(
    applied.result.errors,
    [],
    `unexpected errors: ${applied.result.errors.join("; ")}`,
  );
  assert.ok(
    applied.result.warnings.some((w) =>
      /was consumed by a higher-tier block/.test(w),
    ),
    `expected ancestor-snap guidance, got: ${JSON.stringify(applied.result.warnings)}`,
  );
  assert.equal(applied.result.blocksCreated, 1);

  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  assert.equal(newBlock.tier, 3);
  assert.deepEqual(newBlock.directBlockIds, ["b5"]);
  assert.deepEqual(newBlock.directMessageIds, []);
  assert.deepEqual(newBlock.effectiveMessageIds.sort(), [
    "raw-3",
    "raw-4",
    "raw-5",
    "raw-6",
  ]);
  for (const id of newBlock.effectiveMessageIds) {
    assert.ok(!isSummaryMessageId(id), `synthetic id leaked into block: ${id}`);
  }
  assert.equal(
    applied.state.blocks.find((b) => b.blockId === "b5")!.active,
    false,
  );
});

test("promote-after-prune: m-ref range consumes a block that covers the first user message (summary anchor precedes the surviving raw)", () => {
  const core = createCore();
  const cfg = config({ preserveRecentMessages: 0 });
  const messages = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a2 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
    msg("raw-8", "a8 ".repeat(200), "assistant"),
    msg("raw-9", "u9 ".repeat(200)),
    msg("raw-10", "a10 ".repeat(200), "assistant"),
    msg("raw-11", "u11 ".repeat(200)),
    msg("raw-12", "a12 ".repeat(200), "assistant"),
    msg("raw-13", "u13 ".repeat(200)),
  ];
  const state = makeState(
    [
      {
        blockId: "b1",
        effectiveMessageIds: ["raw-1", "raw-2", "raw-3", "raw-4", "raw-5"],
      },
    ],
    2,
  );

  const turn = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: 5000,
  });
  const visibleIds = turn.messages.map((m) => m.id);
  // Prune keeps the first user message (the #2733 pin — provider
  // prefix-cache head) and inserts the summary AFTER it, so the summary
  // index differs from the raw's index. b1's anchor resolution still finds
  // raw-1 (the block covers the pin), which is what the consumption checks
  // below exercise.
  assert.ok(visibleIds.includes(summaryMessageId("b1")));
  assert.ok(visibleIds.includes("raw-1"), "first user message survives prune");
  assert.ok(!visibleIds.includes("raw-5"), "covered raws are hidden");
  assert.ok(
    visibleIds.indexOf(summaryMessageId("b1")) > visibleIds.indexOf("raw-1"),
    "summary sits after the pinned first user message (#2733 head-stability)",
  );

  const startRef = turn.state.messageRefs.byRaw["raw-1"]!;
  const endRef = turn.state.messageRefs.byRaw["raw-13"]!;

  const applied = core.applyCompression({
    ranges: [{ startRef, endRef, summary: "S".repeat(80) }],
    messages: turn.messages,
    state: turn.state,
    config: cfg,
  });
  assert.deepEqual(
    applied.result.errors,
    [],
    `unexpected errors: ${applied.result.errors.join("; ")}`,
  );
  assert.equal(applied.result.blocksCreated, 1);

  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  // b1 must be consumed via its surviving raw even though its summary anchor
  // sits outside the resolved range.
  assert.deepEqual(newBlock.directBlockIds, ["b1"]);
  assert.deepEqual(newBlock.effectiveMessageIds.sort(), [
    "raw-1",
    "raw-10",
    "raw-11",
    "raw-12",
    "raw-13",
    "raw-2",
    "raw-3",
    "raw-4",
    "raw-5",
    "raw-6",
    "raw-7",
    "raw-8",
    "raw-9",
  ]);
  assert.deepEqual(newBlock.directMessageIds.sort(), [
    "raw-10",
    "raw-11",
    "raw-12",
    "raw-13",
    "raw-6",
    "raw-7",
    "raw-8",
    "raw-9",
  ]);
  for (const id of [
    ...newBlock.effectiveMessageIds,
    ...newBlock.directMessageIds,
  ]) {
    assert.ok(!isSummaryMessageId(id), `synthetic id leaked into block: ${id}`);
  }
  assert.equal(
    applied.state.blocks.find((b) => b.blockId === "b1")!.active,
    false,
  );
});
