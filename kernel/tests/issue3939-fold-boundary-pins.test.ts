import { test } from "node:test";
import assert from "node:assert/strict";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { assignRefs } from "../src/refs.js";
import { createInitialState } from "../src/state.js";
import { truncateLargeToolOutputs } from "../src/truncate-tools.js";
import { createCore } from "../src/compress.js";
import type {
  CompressionBlock,
  Config,
  CoreMessage,
} from "../src/types.js";

// Characterization pins for issue #3939 (打桩): these tests freeze CURRENT
// behavior — including behavior #3938/#3939 plan to change (non-fold rewriters,
// per-request view oscillation, non-atomic multi-range landing). When PR-B
// (fold-boundary transactions) or the truncation latch lands, update the
// affected pins IN THE SAME PR — a red pin here is the intended diff signal.

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
    truncate: { threshold: 0.95 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function orphanHistory(): CoreMessage[] {
  const messages: CoreMessage[] = [];
  for (const id of ["c1", "c2", "c3", "c4"]) {
    messages.push({
      id: `raw-${id}`,
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: id,
      text: JSON.stringify({
        content: [
          { startId: "m00001", endId: "m00002", topic: "t", summary: "s" },
        ],
      }),
    });
    messages.push({
      id: `raw-${id}-r`,
      role: "tool",
      contentType: "tool-result",
      toolCallId: id,
      text: "done",
    });
  }
  return messages;
}

function liveBlockState(): { state: ReturnType<typeof createInitialState> } {
  const state = createInitialState();
  const block: CompressionBlock = {
    blockId: "b1",
    runId: "r0",
    tier: 1,
    summary: "live-summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 1000,
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: "c1",
    startRef: "m00001",
    endRef: "m00002",
  };
  state.blocks.push(block);
  return { state };
}

test("pin: between folds no orphan is swept — quiet turns keep every failed compress call visible (#3769 fold gate)", () => {
  const messages = orphanHistory();
  const res = hideConsumedCompressCalls(createInitialState(), messages);

  const keptCalls = res.messages
    .filter((m) => m.contentType === "tool-call")
    .map((m) => m.toolCallId);
  // The pre-#3769 keep-last-two rotation hid the oldest failures on EVERY
  // turn, rewriting the still-cached prefix for a few hundred chars. Now the
  // window only sweeps once a committed fold stamps pendingOrphanSweepMinRef.
  assert.deepEqual(keptCalls, ["c1", "c2", "c3", "c4"]);
  assert.equal(res.messages.length, 8);
  assert.equal(res.hidden, 0);
  assert.deepEqual(res.newlySweptCallIds, []);
});

test("pin: a pending fold sweep hides orphans at/after its min ref and reports their refs (#3769)", () => {
  const messages = orphanHistory();
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.pendingOrphanSweepMinRef = 1;

  const res = hideConsumedCompressCalls(state, messages);

  assert.equal(res.hidden, 8);
  assert.deepEqual(
    res.hiddenOrphanRefs,
    ["m00001", "m00002", "m00003", "m00004", "m00005", "m00006", "m00007", "m00008"],
  );
  assert.deepEqual(res.newlySweptCallIds, ["c1", "c2", "c3", "c4"]);
});

test("pin: active compress call keeps only block-live ranges (dead entries stripped from args)", () => {
  const { state } = liveBlockState();
  const callText = JSON.stringify({
    content: [
      { startId: "m00001", endId: "m00002", topic: "T", summary: "live" },
      { startId: "m00003", endId: "m00004", topic: "D", summary: "dead" },
    ],
  });
  const messages: CoreMessage[] = [
    {
      id: "raw-c1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "c1",
      text: callText,
    },
    {
      id: "raw-c1-r",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "c1",
      text: "ok",
    },
  ];

  const res = hideConsumedCompressCalls(state, messages);
  const kept = res.messages.find((m) => m.contentType === "tool-call")!;

  assert.deepEqual(JSON.parse(kept.text!).content, [
    { startId: "m00001", endId: "m00002", topic: "T", summary: "live" },
  ]);
});

test("pin: active call whose ranges are all dead keeps its entries verbatim (stub only applies >200 chars)", () => {
  const { state } = liveBlockState();
  const callText = JSON.stringify({
    content: [
      { startId: "m00003", endId: "m00004", topic: "D", summary: "short" },
    ],
  });
  const messages: CoreMessage[] = [
    {
      id: "raw-c1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "c1",
      text: callText,
    },
    {
      id: "raw-c1-r",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "c1",
      text: "ok",
    },
  ];

  const res = hideConsumedCompressCalls(state, messages);
  const kept = res.messages.find((m) => m.contentType === "tool-call")!;

  assert.deepEqual(JSON.parse(kept.text!).content, [
    { startId: "m00003", endId: "m00004", topic: "D", summary: "short" },
  ]);
});

test("pin: assignRefs BLOCKED->numeric migration re-mints a ref for the same raw id once protection lifts", () => {
  const media: CoreMessage = {
    id: "media-1",
    role: "user",
    contentType: "text",
    text: "[image]",
    imagePart: true,
  };
  const state = createInitialState();

  const pass1 = assignRefs([media], {
    existing: state.messageRefs,
    nextIndex: 1,
    isProtected: () => true,
  });
  assert.equal(pass1.map.byRaw["media-1"], "BLOCKED");

  const pass2 = assignRefs([media], {
    existing: pass1.map,
    nextIndex: pass1.nextIndex,
    isProtected: () => false,
  });
  assert.equal(pass2.map.byRaw["media-1"], "m00001");
});

test("pin: emergency truncation fires at >=95% water level with the exact marker format", () => {
  const bigTool: CoreMessage = {
    id: "t1",
    role: "tool",
    contentType: "tool-result",
    toolCallId: "x1",
    toolName: "read",
    text: "A".repeat(400000),
  };
  const messages: CoreMessage[] = [
    bigTool,
    { id: "p1", role: "user", contentType: "text", text: "q1" },
    { id: "p2", role: "user", contentType: "text", text: "q2" },
    { id: "p3", role: "user", contentType: "text", text: "q3" },
  ];
  const countTokens = (text: string) => Math.ceil(text.length / 4);

  const high = truncateLargeToolOutputs(messages, 96000, config(), countTokens);

  assert.equal(high.truncatedCount, 1);
  assert.ok(high.savedTokens > 0);
  const text = high.messages[0]!.text!;
  assert.ok(
    text.includes(
      "...[truncated for context space] — original ~100000 tokens]...",
    ),
  );
  assert.equal(text.length, 4066);
});

test("pin: the SAME history passes through untouched below the water level (per-request view oscillation, #3691 shape)", () => {
  const bigTool: CoreMessage = {
    id: "t1",
    role: "tool",
    contentType: "tool-result",
    toolCallId: "x1",
    toolName: "read",
    text: "A".repeat(400000),
  };
  const messages: CoreMessage[] = [
    bigTool,
    { id: "p1", role: "user", contentType: "text", text: "q1" },
    { id: "p2", role: "user", contentType: "text", text: "q2" },
    { id: "p3", role: "user", contentType: "text", text: "q3" },
  ];
  const countTokens = (text: string) => Math.ceil(text.length / 4);

  const low = truncateLargeToolOutputs(messages, 94000, config(), countTokens);

  assert.equal(low.truncatedCount, 0);
  assert.equal(low.messages[0]!.text!.length, 400000);
});

test("pin: already-truncated text is skipped on the next pass (marker idempotency)", () => {
  const bigTool: CoreMessage = {
    id: "t1",
    role: "tool",
    contentType: "tool-result",
    toolCallId: "x1",
    toolName: "read",
    text: "A".repeat(400000),
  };
  const messages: CoreMessage[] = [
    bigTool,
    { id: "p1", role: "user", contentType: "text", text: "q1" },
    { id: "p2", role: "user", contentType: "text", text: "q2" },
    { id: "p3", role: "user", contentType: "text", text: "q3" },
  ];
  const countTokens = (text: string) => Math.ceil(text.length / 4);
  const first = truncateLargeToolOutputs(messages, 96000, config(), countTokens);

  const second = truncateLargeToolOutputs(
    first.messages,
    96000,
    config(),
    countTokens,
  );

  assert.equal(second.truncatedCount, 0);
});

test("pin: unknown-ref sibling errors do not poison valid ranges (classification-level partial report)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages: CoreMessage[] = [
    { id: "a", role: "user", contentType: "text", text: "alpha" },
    { id: "b", role: "user", contentType: "text", text: "beta" },
    { id: "c", role: "user", contentType: "text", text: "gamma" },
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "s1", topic: "t1" },
      { startRef: "m00009", endRef: "m00010", summary: "s2", topic: "t2" },
    ],
    messages,
    state,
    config: config(),
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.state.blocks.length, 1);
  assert.equal(result.result.errors.length, 1);
  assert.match(
    result.result.errors[0]!,
    /m00009.*above this session's highest allocated ref/,
  );
});

test("pin: a range that dies DURING application rejects the whole batch all-or-nothing (#3939 ④, closes the #3003 double-seam)", () => {
  const core = createCore();
  const state = createInitialState();
  const messages: CoreMessage[] = [
    { id: "a", role: "user", contentType: "text", text: "alpha" },
    { id: "b", role: "user", contentType: "text", text: "beta" },
    { id: "c", role: "user", contentType: "text", text: "gamma" },
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00002", summary: "s1", topic: "t1" },
      { startRef: "m00003", endRef: "m00003", summary: "s2", topic: "t2" },
    ],
    messages,
    state,
    config: config(),
    protectedMessageIds: new Set(["m00003"]),
  });

  assert.equal(result.result.blocksCreated, 0);
  assert.equal(result.state.blocks.length, 0);
  assert.equal(result.state.stats.compressionCount, 0);
  assert.match(
    result.result.errors[0]!,
    /Batch rejected before folding any range.*entirely within the protected zone/s,
  );
});
