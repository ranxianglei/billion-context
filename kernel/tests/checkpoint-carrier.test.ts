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

/** The #335 shape: a host checkpoint (user-role carrier of a prior block's
 *  summary) sits inside a later plain message-ref range. */
function buildCarrierScenario() {
  const core = createCore();
  let state = createInitialState();
  const messages = [
    msg("1", "user asks to refactor"),
    msg("2", "assistant plan", "assistant"),
    msg("3", "tool result payload"),
    msg("4", "assistant next step", "assistant"),
    msg("5", "tool result payload two"),
    msg("6", "user follow-up"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const first = core.applyCompression({
    ranges: [
      {
        startRef: "m00002",
        endRef: "m00005",
        summary: "block A distills the refactor",
      },
    ],
    messages,
    state,
    config: config(),
  });
  const blockA = first.state.blocks[0]!;
  messages.push({
    ...msg("7", "checkpoint: block A summary text"),
    summaryOfBlockId: blockA.blockId,
  });
  messages.push(msg("8", "user later turn"));
  state = first.state;
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 7,
  }).map;
  return { core, state, messages, blockA };
}

test("plain message-ref range skips a live host checkpoint carrier and keeps it visible (#335)", () => {
  const { core, state, messages, blockA } = buildCarrierScenario();
  const second = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00008",
        summary: "plain range across the checkpoint",
      },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(second.result.blocksCreated, 1);
  assert.equal(second.result.errors.length, 0);
  const blockB = second.state.blocks[second.state.blocks.length - 1]!;
  assert.ok(
    !blockB.effectiveMessageIds.includes("7"),
    "carrier must not be folded into the plain range block",
  );
  assert.ok(!blockB.directMessageIds.includes("7"));
  assert.ok(blockB.effectiveMessageIds.includes("8"));
  assert.ok(
    blockB.effectiveMessageIds.includes("2") &&
      blockB.effectiveMessageIds.includes("5"),
    "the block's own range is still re-covered",
  );
  assert.ok(
    (second.result.warnings ?? []).some((w) => w.includes("checkpoint")),
    "the skip must be reported, not silent",
  );
  const visible = prune(messages, second.state);
  assert.ok(
    visible.some((m) => m.id === "7"),
    "the carrier stays in the visible projection",
  );
});

test("block-ref boundary (bN..bM) folds host checkpoint carriers — distillation path (#335)", () => {
  const core = createCore();
  let state = createInitialState();
  const messages = Array.from({ length: 11 }, (_, i) =>
    msg(`${i + 1}`, `message ${i + 1}`, i % 2 === 0 ? "user" : "assistant"),
  );
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00005", summary: "block one" }],
    messages,
    state,
    config: config(),
  }).state;
  const blockA = state.blocks[0]!;
  messages[5] = {
    ...messages[5]!,
    summaryOfBlockId: blockA.blockId,
  };
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 6,
  }).map;
  state = core.applyCompression({
    ranges: [{ startRef: "m00007", endRef: "m00011", summary: "block two" }],
    messages,
    state,
    config: config(),
  }).state;
  const distilled = core.applyCompression({
    ranges: [
      {
        startRef: "b1",
        endRef: "b2",
        summary: "tier two across both blocks and the carrier",
      },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(distilled.result.blocksCreated, 1);
  assert.equal(distilled.result.errors.length, 0);
  const t2 = distilled.state.blocks[distilled.state.blocks.length - 1]!;
  assert.equal(t2.tier, 2);
  assert.ok(
    t2.effectiveMessageIds.includes("6"),
    "block-boundary distillation folds the carrier",
  );
  assert.ok(
    !(distilled.result.warnings ?? []).some((w) => w.includes("checkpoint")),
    "no checkpoint warning on the distillation path",
  );
});

test("stale carriers (block inactive or unknown) fold like ordinary messages", () => {
  const { core, state, messages, blockA } = buildCarrierScenario();
  state.blocks = state.blocks.map((b) =>
    b.blockId === blockA.blockId ? { ...b, active: false } : b,
  );
  messages.push({
    ...msg("9", "checkpoint of a dead block"),
    summaryOfBlockId: blockA.blockId,
  });
  messages.push({
    ...msg("10", "checkpoint of an unknown block"),
    summaryOfBlockId: "b-nope",
  });
  messages.push(msg("11", "tail"));
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 9,
  }).map;
  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00011",
        summary: "plain range over stale carriers",
      },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.blocksCreated, 1);
  const block = result.state.blocks[result.state.blocks.length - 1]!;
  assert.ok(
    block.effectiveMessageIds.includes("9"),
    "inactive-block carrier folds",
  );
  assert.ok(
    block.effectiveMessageIds.includes("10"),
    "unknown-block carrier folds",
  );
  assert.ok(
    block.effectiveMessageIds.includes("7"),
    "carrier of the now-dead block folds too",
  );
});

test("dsh shape: plain range with tool-pair growth consumes the old block yet skips its carrier (#335 exact scenario)", () => {
  const core = createCore();
  let state = createInitialState();
  const messages: CoreMessage[] = [
    msg("1", "user one"),
    {
      id: "2",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "c1",
      text: "{}",
    },
    {
      id: "2#c1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "c2",
      text: "{}",
    },
    {
      id: "3",
      role: "user",
      contentType: "tool-result",
      toolName: "bash",
      toolCallId: "c1",
      text: "result c1",
    },
    {
      id: "4",
      role: "user",
      contentType: "tool-result",
      toolName: "bash",
      toolCallId: "c2",
      text: "",
    },
    msg("5", "user two"),
    {
      id: "6",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "c3",
      text: "{}",
    },
    {
      id: "7",
      role: "user",
      contentType: "tool-result",
      toolName: "bash",
      toolCallId: "c3",
      text: "",
    },
    msg("8", "user three"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state = core.applyCompression({
    ranges: [
      {
        startRef: "m00002",
        endRef: "m00006",
        summary: "block A distills the tool work",
      },
    ],
    messages,
    state,
    config: config(),
  }).state;
  const blockA = state.blocks[0]!;
  assert.ok(blockA.active);
  const ckpt: CoreMessage = {
    ...msg("9", "checkpoint: block A summary"),
    summaryOfBlockId: blockA.blockId,
  };
  messages.push(ckpt);
  for (let i = 0; i < 8; i++) {
    messages.push(msg(`${10 + i}`, `later turn ${i}`));
  }
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 7,
  }).map;
  const lastRef = `m${String(messages.length).padStart(5, "0")}`;
  const second = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: lastRef,
        summary: "plain range over everything",
      },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(second.result.blocksCreated, 1);
  assert.equal(second.result.errors.length, 0);
  const blockB = second.state.blocks[second.state.blocks.length - 1]!;
  assert.ok(
    !blockB.effectiveMessageIds.includes("9"),
    "carrier of the consumed block must still be skipped",
  );
  assert.ok(!blockB.directMessageIds.includes("9"));
  assert.ok(
    (second.result.warnings ?? []).some((w) => w.includes("checkpoint")),
    "skip is reported",
  );
  const blockACopy = second.state.blocks.find(
    (b) => b.blockId === blockA.blockId,
  )!;
  assert.equal(
    blockACopy.active,
    false,
    "tool-pair growth re-scan consumes the nested block (dsh ledger shape)",
  );
  assert.ok(
    blockB.directBlockIds.includes(blockA.blockId),
    "parents link recorded",
  );
  const visible = prune(messages, second.state);
  assert.ok(
    visible.some((m) => m.id === "9"),
    "carrier stays visible",
  );
});
