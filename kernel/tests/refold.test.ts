import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { indexToRef } from "../src/refs.js";
import {
  markBlockRestoredInline,
  collectBlockContent,
  activeAncestorIds,
} from "../src/decompress.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
  Config,
} from "../src/types.js";

const OLD_SUMMARY = "OLD SUMMARY";
const NEW_SUMMARY = "NEW SUMMARY carrying the re-folded details verbatim.";

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
    compress: {
      minCompressRange: 500,
      maxSummaryLength: 20000,
      minSummaryLength: 10,
    },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function makeMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i + 1}`,
    role: "assistant",
    contentType: "text",
    text: `content ${i + 1} ${"x".repeat(20)}`,
  }));
}

function makeBlock(
  overrides: Partial<CompressionBlock> &
    Pick<CompressionBlock, "blockId" | "effectiveMessageIds">,
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: OLD_SUMMARY,
    directMessageIds: overrides.effectiveMessageIds,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 1758800000000,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

/** Full-history fixture: refs assigned across ALL messages; blocks fold the
 * early ones so they are hidden from the visible view the caller passes. */
function makeState(
  messages: CoreMessage[],
  blocks: CompressionBlock[],
): CompressionState {
  const state = createInitialState();
  state.blocks.push(...blocks);
  messages.forEach((message, i) => {
    const ref = indexToRef(i + 1);
    state.messageRefs.byRaw[message.id] = ref;
    state.messageRefs.byRef[ref] = message.id;
  });
  state.nextBlockId = Math.max(
    state.nextBlockId,
    ...blocks.map((block) => Number(block.blockId.slice(1)) + 1),
  );
  return state;
}

// K1: inline-decompress marker + metadata ------------------------------------

test("markBlockRestoredInline flags the block and reports its span refs", () => {
  const messages = makeMessages(10);
  const ids = messages.map((m) => m.id);
  const state = makeState(messages, [
    makeBlock({ blockId: "b1", effectiveMessageIds: ids }),
  ]);

  const { state: marked, result } = markBlockRestoredInline(state, "b1");

  assert.equal(result?.restored, true);
  assert.equal(result?.blockId, "b1");
  assert.equal(result?.restoredStartRef, "m00001");
  assert.equal(result?.restoredEndRef, "m00010");
  const block = marked.blocks[0]!;
  assert.equal(block.restoredInline, true);
  assert.equal(block.active, true, "inline restore must keep the block active");
});

test("markBlockRestoredInline omits refs when none are derivable and is a no-op for unknown blocks", () => {
  const state = makeState(makeMessages(3), [
    makeBlock({ blockId: "b7", effectiveMessageIds: ["ghost-no-ref"] }),
  ]);
  const { state: marked, result } = markBlockRestoredInline(state, "b7");
  assert.equal(result?.restored, true);
  assert.equal(result?.restoredStartRef, undefined);
  assert.equal(result?.restoredEndRef, undefined);
  assert.equal(marked.blocks[0]!.restoredInline, true);

  const unknown = markBlockRestoredInline(state, "b99");
  assert.equal(unknown.result, null);
  assert.equal(unknown.state, state, "unknown block: state left untouched");
});

test("file/toFile-mode equivalent path stays unmarked: collectBlockContent neither marks nor returns restore metadata", () => {
  const messages = makeMessages(10);
  const block = makeBlock({
    blockId: "b1",
    effectiveMessageIds: messages.map((m) => m.id),
  });
  const state = makeState(messages, [block]);

  const collected = collectBlockContent(state, block, messages, { full: true });

  assert.deepEqual(Object.keys(collected).sort(), ["count", "text"]);
  assert.notEqual("restored" in collected, true);
  assert.notEqual(state.blocks[0]!.restoredInline, true);
});

test("markBlockRestoredInline survives a .acp.json round-trip", () => {
  const messages = makeMessages(4);
  const ids = messages.map((m) => m.id);
  const state = makeState(messages, [
    makeBlock({ blockId: "b3", effectiveMessageIds: ids }),
  ]);
  const { state: marked } = markBlockRestoredInline(state, "b3");
  const persisted = JSON.parse(JSON.stringify(marked)) as CompressionState;
  assert.equal(persisted.blocks[0]!.restoredInline, true);
});

// K2: refold-in-place ---------------------------------------------------------

test("refold updates the block in place: same id, replaced summary, flag cleared, no new block id allocated", () => {
  const core = createCore();
  const messages = makeMessages(10);
  const ids = messages.map((m) => m.id);
  const before = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: ids,
      startRef: "m00001",
      endRef: "m00010",
    }),
  ]);
  const { state: marked } = markBlockRestoredInline(before, "b1");

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00010",
        summary: NEW_SUMMARY,
        topic: "refold",
      },
    ],
    messages: [], // block content hidden from the visible view (post-prune)
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(
    result.state.blocks.length,
    1,
    "no second block created for the same span",
  );
  const block = result.state.blocks[0]!;
  assert.equal(block.blockId, "b1", "block id stays stable");
  assert.equal(block.summary, NEW_SUMMARY, "summary replaced in place");
  assert.equal(block.topic, "refold");
  assert.equal(block.restoredInline, false, "marker cleared after refold");
  assert.equal(block.active, true);
  assert.equal(block.tier, 1, "tier unchanged — refold is not distillation");
  assert.deepEqual(block.directMessageIds, ids);
  assert.deepEqual(block.effectiveMessageIds, ids);
  assert.equal(result.state.nextBlockId, 2, "no new block id allocated");
});

test("partial coverage of a restored block is still rejected, naming the blocking block id", () => {
  const core = createCore();
  const messages = makeMessages(10);
  const ids = messages.map((m) => m.id);
  const { state: marked } = markBlockRestoredInline(
    makeState(messages, [
      makeBlock({ blockId: "b1", effectiveMessageIds: ids }),
    ]),
    "b1",
  );

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00008", summary: NEW_SUMMARY }],
    messages: [],
    state: marked,
    config: config(),
  });

  assert.match(result.result.errors[0]!, /already compressed/);
  assert.match(result.result.errors[0]!, /partially covered b1/);
  const block = result.state.blocks[0]!;
  assert.equal(block.summary, OLD_SUMMARY, "no mutation on rejection");
  assert.equal(block.restoredInline, true, "marker survives rejection");
  assert.equal(result.state.nextBlockId, 2);
});

test("an unrecovered higher-tier folded block above a restored block is rejected, naming the blocker", () => {
  const core = createCore();
  const messages = makeMessages(10);
  const ids = messages.map((m) => m.id);
  const nested = makeState(messages, [
    makeBlock({ blockId: "b1", effectiveMessageIds: ids, active: false }),
    makeBlock({
      blockId: "b2",
      effectiveMessageIds: ids,
      directBlockIds: ["b1"],
      directMessageIds: [],
      tier: 2,
    }),
  ]);
  const { state: marked } = markBlockRestoredInline(nested, "b1");
  assert.deepEqual(activeAncestorIds(marked, "b1"), ["b2"]);

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY }],
    messages: [],
    state: marked,
    config: config(),
  });

  assert.match(result.result.errors[0]!, /already compressed/);
  assert.match(result.result.errors[0]!, /blocked by b2 \(not restored\)/);
  assert.doesNotMatch(
    result.result.errors[0]!,
    /blocked by b2.*blocked by b2/,
    "blocker listed once",
  );
  assert.equal(result.state.blocks[0]!.summary, OLD_SUMMARY);
  assert.equal(result.state.blocks[0]!.restoredInline, true);
});

test("restoring the topmost active tier folds back into exactly that block", () => {
  const core = createCore();
  const messages = makeMessages(10);
  const ids = messages.map((m) => m.id);
  // Production lifecycle: b2 (T2) folded b1 (T1) away — b1 is inactive.
  const nested = makeState(messages, [
    makeBlock({ blockId: "b1", effectiveMessageIds: ids, active: false }),
    makeBlock({
      blockId: "b2",
      effectiveMessageIds: ids,
      directBlockIds: ["b1"],
      directMessageIds: [],
      tier: 2,
    }),
  ]);
  const { state: marked } = markBlockRestoredInline(nested, "b2");

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY }],
    messages: [],
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(
    result.result.blocksCreated,
    1,
    "only the topmost active tier is refolded",
  );
  const b1 = result.state.blocks.find((block) => block.blockId === "b1")!;
  const b2 = result.state.blocks.find((block) => block.blockId === "b2")!;
  assert.equal(b2.summary, NEW_SUMMARY);
  assert.equal(b2.restoredInline, false);
  assert.equal(b1.summary, OLD_SUMMARY, "inactive lower tier left untouched");
  assert.equal(result.state.nextBlockId, 3, "no new block id allocated");
});

test("two sibling restored blocks in one range are both refolded in place", () => {
  const core = createCore();
  const messages = makeMessages(20);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
    }),
    makeBlock({
      blockId: "b3",
      effectiveMessageIds: messages.slice(14, 20).map((m) => m.id),
    }),
  ]);
  const s2 = markBlockRestoredInline(state, "b1").state;
  const s3 = markBlockRestoredInline(s2, "b3").state;

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00020", summary: NEW_SUMMARY }],
    messages: [],
    state: s3,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 2);
  assert.equal(result.state.nextBlockId, 4, "no ids allocated");
  for (const block of result.state.blocks) {
    assert.equal(block.summary, NEW_SUMMARY);
    assert.equal(block.restoredInline, false);
  }
});

// #400: full-log host views (Pi keeps inline-restored originals visible) -----
//
// Full-log hosts (billion-context-pi) always pass the full session projection
// plus summary anchors to applyCompression — inline-restored originals stay in
// `messages`, so a re-compress of their span RESOLVES (status ok) instead of
// classifying as consumed. These variants pin that such requests take the same
// refold path as the pruned-world cases above.

function longMessages(count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i + 1}`,
    role: "assistant",
    contentType: "text",
    text: `content ${i + 1} ${"x".repeat(80)}`,
  }));
}

function summaryAnchor(blockId: string): CoreMessage {
  return {
    id: `acp_summary_${blockId}`,
    role: "system",
    contentType: "text",
    text: OLD_SUMMARY,
  };
}

test("full anchor view: refold updates the block in place, identical to the pruned case", () => {
  const core = createCore();
  const messages = makeMessages(10);
  const ids = messages.map((m) => m.id);
  const { state: marked } = markBlockRestoredInline(
    makeState(messages, [
      makeBlock({
        blockId: "b1",
        effectiveMessageIds: ids,
        startRef: "m00001",
        endRef: "m00010",
      }),
    ]),
    "b1",
  );
  const fullView = [summaryAnchor("b1"), ...messages];

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00010",
        summary: NEW_SUMMARY,
        topic: "refold",
      },
    ],
    messages: fullView,
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(
    result.state.blocks.length,
    1,
    "no second block created for the same span",
  );
  const block = result.state.blocks[0]!;
  assert.equal(block.blockId, "b1", "block id stays stable");
  assert.equal(block.summary, NEW_SUMMARY, "summary replaced in place");
  assert.equal(block.topic, "refold");
  assert.equal(block.restoredInline, false, "marker cleared after refold");
  assert.equal(block.active, true);
  assert.equal(block.tier, 1, "tier unchanged — refold is not distillation");
  assert.deepEqual(block.directMessageIds, ids);
  assert.deepEqual(block.effectiveMessageIds, ids);
  assert.equal(result.state.nextBlockId, 2, "no new block id allocated");
});

test("full anchor view: single restored block with a live tail refolds only that block (#400 repro shape)", () => {
  const core = createCore();
  const messages = makeMessages(8);
  const { state: marked } = markBlockRestoredInline(
    makeState(messages, [
      makeBlock({
        blockId: "b1",
        effectiveMessageIds: [messages[0]!.id],
        startRef: "m00001",
        endRef: "m00001",
      }),
    ]),
    "b1",
  );
  const fullView = [summaryAnchor("b1"), ...messages];

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00001", summary: NEW_SUMMARY }],
    messages: fullView,
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.state.blocks.length, 1, "live tail left untouched");
  const block = result.state.blocks[0]!;
  assert.equal(block.blockId, "b1");
  assert.equal(block.summary, NEW_SUMMARY);
  assert.equal(block.restoredInline, false);
  assert.deepEqual(block.effectiveMessageIds, [messages[0]!.id]);
  assert.equal(result.state.nextBlockId, 2);
});

test("full anchor view: two adjacent restored blocks in one range are both refolded in place", () => {
  const core = createCore();
  const messages = makeMessages(20);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
    }),
    makeBlock({
      blockId: "b3",
      effectiveMessageIds: messages.slice(10, 20).map((m) => m.id),
    }),
  ]);
  const s2 = markBlockRestoredInline(state, "b1").state;
  const s3 = markBlockRestoredInline(s2, "b3").state;
  const fullView = [summaryAnchor("b1"), summaryAnchor("b3"), ...messages];

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00020", summary: NEW_SUMMARY }],
    messages: fullView,
    state: s3,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 2, "both blocks counted");
  assert.equal(result.state.nextBlockId, 4, "no ids allocated");
  for (const block of result.state.blocks) {
    assert.equal(block.summary, NEW_SUMMARY);
    assert.equal(block.restoredInline, false);
  }
});

test("full anchor view: range mixing a restored block with live tail creates a fresh block consuming it (refold only when zero new messages)", () => {
  const core = createCore();
  const messages = longMessages(12);
  const { state: marked } = markBlockRestoredInline(
    makeState(messages, [
      makeBlock({
        blockId: "b1",
        effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
      }),
    ]),
    "b1",
  );
  const fullView = [summaryAnchor("b1"), ...messages];

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00012", summary: NEW_SUMMARY }],
    messages: fullView,
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 1);
  const b1 = result.state.blocks.find((block) => block.blockId === "b1")!;
  assert.equal(b1.active, false, "restored block consumed by the fresh fold");
  assert.equal(b1.summary, OLD_SUMMARY, "its own summary left intact");
  const fresh = result.state.blocks.find((block) => block.blockId !== "b1")!;
  assert.equal(fresh.active, true);
  assert.deepEqual(
    fresh.directMessageIds,
    messages.slice(10).map((m) => m.id),
    "only the live tail becomes direct content",
  );
  assert.equal(result.state.nextBlockId, 3, "exactly one new id allocated");
});

test("full anchor view: unmarked block keeps the legacy livelock rejection verbatim", () => {
  const core = createCore();
  const messages = longMessages(10);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.map((m) => m.id),
      startRef: "m00001",
      endRef: "m00010",
    }),
  ]);
  const fullView = [summaryAnchor("b1"), ...messages];

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY }],
    messages: fullView,
    state,
    config: config(),
  });

  assert.match(
    result.result.errors[0]!,
    /Range m00001\.\.m00010 contains no new compressible messages — every message in it is already covered by active block\(s\) b1/,
  );
  assert.match(
    result.result.errors[0]!,
    /reference them by block ID \(b1\.\.b1\)/,
  );
  assert.equal(result.state.blocks.length, 1, "nothing applied");
  assert.equal(result.state.blocks[0]!.summary, OLD_SUMMARY);
  assert.equal(result.state.nextBlockId, 2);
});

test("full anchor view: sub-threshold span over an unmarked block names the blocker in the size-gate error (#402)", () => {
  const core = createCore();
  // Short messages (~30 chars each → ~300 total < minCompressRange 500), so
  // the size gate fires BEFORE the per-range loop could reach the livelock
  // error that names b1 — the diagnostic must carry the blocker itself.
  const messages = makeMessages(10);
  const state = makeState(messages, [
    makeBlock({
      blockId: "b1",
      effectiveMessageIds: messages.map((m) => m.id),
      startRef: "m00001",
      endRef: "m00010",
    }),
  ]);
  const fullView = [summaryAnchor("b1"), ...messages];

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY }],
    messages: fullView,
    state,
    config: config(),
  });

  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /Total compressible content too small/,
  );
  assert.match(result.result.errors[0]!, /blocked by b1 \(not restored\)/);
  assert.match(result.result.errors[0]!, /decompress with inline:true/);
  assert.ok(
    result.result.errors[0]!.indexOf("too small") <
      result.result.errors[0]!.indexOf("Refold blocked"),
    "blocker detail appended to the too-small branch",
  );
  assert.equal(result.state.blocks.length, 1, "nothing applied");
  assert.equal(result.state.blocks[0]!.summary, OLD_SUMMARY);
  assert.equal(result.state.nextBlockId, 2);
});

test("full anchor view: batch of a refoldable span plus a qualifying fresh part applies both", () => {
  const core = createCore();
  const messages = longMessages(20);
  const { state: marked } = markBlockRestoredInline(
    makeState(messages, [
      makeBlock({
        blockId: "b1",
        effectiveMessageIds: messages.slice(0, 10).map((m) => m.id),
      }),
    ]),
    "b1",
  );
  const fullView = [summaryAnchor("b1"), ...messages];

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY },
      { startRef: "m00011", endRef: "m00020", summary: NEW_SUMMARY },
    ],
    messages: fullView,
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 2);
  const b1 = result.state.blocks.find((block) => block.blockId === "b1")!;
  assert.equal(b1.summary, NEW_SUMMARY, "refolded in place");
  assert.equal(b1.restoredInline, false);
  const fresh = result.state.blocks.filter((block) => block.blockId !== "b1");
  assert.equal(fresh.length, 1, "fresh part compressed into one new block");
  assert.equal(fresh[0]!.active, true);
  assert.deepEqual(
    fresh[0]!.effectiveMessageIds,
    messages.slice(10).map((m) => m.id),
  );
  assert.equal(result.state.nextBlockId, 3, "exactly one new id allocated");
});

// Backward compatibility ------------------------------------------------------

test("old persisted format without restoredInline reads as false: refold rejected until marked", () => {
  const core = createCore();
  const messages = makeMessages(10);
  const ids = messages.map((m) => m.id);
  const fresh = makeState(messages, [
    makeBlock({ blockId: "b1", effectiveMessageIds: ids }),
  ]);
  // Simulate loading an .acp.json written before #398: optional field absent.
  const loaded = JSON.parse(JSON.stringify(fresh)) as CompressionState;
  assert.equal(loaded.blocks[0]!.restoredInline, undefined);

  const rejected = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY }],
    messages: [],
    state: loaded,
    config: config(),
  });
  assert.match(rejected.result.errors[0]!, /already compressed/);
  assert.match(rejected.result.errors[0]!, /blocked by b1 \(not restored\)/);
  assert.equal(rejected.state.blocks[0]!.summary, OLD_SUMMARY);

  // Same load, then marked inline: refold now succeeds.
  const { state: marked } = markBlockRestoredInline(loaded, "b1");
  const accepted = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY }],
    messages: [],
    state: marked,
    config: config(),
  });
  assert.deepEqual(accepted.result.errors, []);
  assert.equal(accepted.state.blocks[0]!.summary, NEW_SUMMARY);
});

// Batch semantics -------------------------------------------------------------

test("a batch mixing a too-small live range with a restorable range keeps the legacy gate (no partial application)", () => {
  const core = createCore();
  const messages = makeMessages(12);
  const ids = messages.slice(0, 10).map((m) => m.id);
  const { state: marked } = markBlockRestoredInline(
    makeState(messages, [
      makeBlock({ blockId: "b1", effectiveMessageIds: ids }),
    ]),
    "b1",
  );
  const visible = messages.slice(10);

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY },
      { startRef: "m00011", endRef: "m00012", summary: NEW_SUMMARY },
    ],
    messages: visible,
    state: marked,
    config: config(),
  });

  assert.equal(result.result.errors.length, 1);
  assert.match(result.result.errors[0]!, /already compressed/);
  assert.equal(result.state.blocks.length, 1);
  assert.equal(
    result.state.blocks[0]!.summary,
    OLD_SUMMARY,
    "nothing applied when the batch gate rejects",
  );
});

test("a batch whose fresh part meets minCompressRange applies the refold AND compresses the fresh part", () => {
  const core = createCore();
  const longMessages: CoreMessage[] = Array.from({ length: 20 }, (_, i) => ({
    id: `msg-${i + 1}`,
    role: "assistant",
    contentType: "text",
    text: `content ${i + 1} ${"x".repeat(80)}`,
  }));
  const ids = longMessages.slice(0, 10).map((m) => m.id);
  const { state: marked } = markBlockRestoredInline(
    makeState(longMessages, [
      makeBlock({ blockId: "b1", effectiveMessageIds: ids }),
    ]),
    "b1",
  );
  const visible = longMessages.slice(10);

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00010", summary: NEW_SUMMARY },
      { startRef: "m00011", endRef: "m00020", summary: NEW_SUMMARY },
    ],
    messages: visible,
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 2);
  const b1 = result.state.blocks.find((block) => block.blockId === "b1")!;
  assert.equal(b1.summary, NEW_SUMMARY, "refolded in place");
  assert.equal(b1.restoredInline, false);
  const fresh = result.state.blocks.filter((block) => block.blockId !== "b1");
  assert.equal(fresh.length, 1, "fresh part compressed into one new block");
  assert.equal(fresh[0]!.active, true);
  assert.deepEqual(
    fresh[0]!.effectiveMessageIds,
    visible.map((m) => m.id),
  );
  assert.equal(result.state.nextBlockId, 3, "exactly one new id allocated");
});

test("a block-ref range (b1..b1) over a restored hidden block refolds in place", () => {
  const core = createCore();
  const messages = makeMessages(10);
  const ids = messages.map((m) => m.id);
  const { state: marked } = markBlockRestoredInline(
    makeState(messages, [
      makeBlock({
        blockId: "b1",
        effectiveMessageIds: ids,
        startRef: "m00001",
        endRef: "m00010",
      }),
    ]),
    "b1",
  );

  const result = core.applyCompression({
    ranges: [{ startRef: "b1", endRef: "b1", summary: NEW_SUMMARY }],
    messages: [],
    state: marked,
    config: config(),
  });

  assert.deepEqual(result.result.errors, []);
  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.state.blocks.length, 1);
  const block = result.state.blocks[0]!;
  assert.equal(block.blockId, "b1");
  assert.equal(block.summary, NEW_SUMMARY);
  assert.equal(block.restoredInline, false);
  assert.equal(result.state.nextBlockId, 2, "no new block id allocated");
});
