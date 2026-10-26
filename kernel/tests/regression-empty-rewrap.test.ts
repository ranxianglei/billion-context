import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { summaryMessageId } from "../src/prune.js";
import { assignRefs } from "../src/refs.js";
import type { CompressionState, Config, CoreMessage } from "../src/types.js";

// Regression tests for billion-context-pi#199: a message-ref range whose
// entire content is already owned by active block(s) — the range spans only
// a rendered summary plus always-protected compress tool pairs — must NOT
// create a block. The real session looped 33 times: each call produced an
// empty same-tier rewrite (directMessageIds: []) that reported
// blocksCreated=1 (fake success) while the model's view stayed identical,
// so it repeated the identical call forever.

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCallMsg(
  id: string,
  toolName: string,
  callId: string,
  args: string,
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: args,
  };
}

function toolResultMsg(id: string, callId: string, text: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolCallId: callId,
    text,
  };
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
    protectedTools: ["compress"],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

function makeState(
  specs: {
    blockId: string;
    effectiveMessageIds: string[];
  }[],
): CompressionState {
  const state = createInitialState();
  state.blocks = specs.map((spec) => ({
    blockId: spec.blockId,
    runId: "r1",
    tier: 1 as const,
    topic: undefined,
    summary: `T1 summary for ${spec.blockId}.`,
    directMessageIds: [...spec.effectiveMessageIds],
    effectiveMessageIds: [...spec.effectiveMessageIds],
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young" as const,
    active: true,
  }));
  state.nextBlockId = specs.length + 1;
  return state;
}

// The looped session's post-prune view shape: the only messages left between
// the two anchors are the rendered summary of the active block and the
// always-protected compress tool-call pairs bracketing it.
function loopedView(): CoreMessage[] {
  return [
    toolCallMsg("raw-1", "compress", "call-1", '{"content":[]}'),
    toolResultMsg("tool-1", "call-1", "▣ ACP | 70K → 12K tokens"),
    msg(summaryMessageId("b1"), "T1 summary for b1.", "system"),
    toolCallMsg("raw-6", "compress", "call-2", '{"content":[]}'),
    toolResultMsg("tool-2", "call-2", "▣ ACP | 57K → 55K tokens"),
  ];
}

function withRefs(
  messages: CoreMessage[],
  state: CompressionState,
): CompressionState {
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

test("#199: message-ref range that only re-wraps an active block is rejected, not fake-success", () => {
  const core = createCore();
  const cfg = config();
  const messages = loopedView();
  const state = withRefs(
    messages,
    makeState([
      {
        blockId: "b1",
        effectiveMessageIds: ["raw-2", "raw-3", "raw-4", "raw-5"],
      },
    ]),
  );
  const startRef = state.messageRefs.byRaw["raw-1"]!;
  const endRef = state.messageRefs.byRaw["tool-2"]!;

  const applied = core.applyCompression({
    ranges: [{ startRef, endRef, summary: "S".repeat(80) }],
    messages,
    state,
    config: cfg,
  });

  assert.equal(applied.result.blocksCreated, 0, "must not create a block");
  assert.equal(applied.result.errors.length, 1);
  assert.match(applied.result.errors[0]!, /no new compressible/i);
  assert.match(applied.result.errors[0]!, /b1/);
  assert.match(applied.result.errors[0]!, /b1\.\.b1|block ID/i);
  assert.equal(applied.state.blocks.length, 1, "no wrapper block appended");
  assert.equal(applied.state.blocks[0]!.active, true, "b1 must stay active");
});

test("#199: promote via block-boundary refs (b1..b1) still works after the guard", () => {
  const core = createCore();
  const cfg = config();
  const messages = loopedView();
  const state = withRefs(
    messages,
    makeState([
      {
        blockId: "b1",
        effectiveMessageIds: ["raw-2", "raw-3", "raw-4", "raw-5"],
      },
    ]),
  );

  const applied = core.applyCompression({
    ranges: [{ startRef: "b1", endRef: "b1", summary: "S".repeat(80) }],
    messages,
    state,
    config: cfg,
  });

  assert.deepEqual(applied.result.errors, []);
  assert.equal(applied.result.blocksCreated, 1);
  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  assert.equal(newBlock.tier, 2);
  assert.deepEqual(newBlock.directBlockIds, ["b1"]);
  assert.equal(
    applied.state.blocks[0]!.active,
    false,
    "b1 consumed by promote",
  );
});

test("#199: message-ref range that pulls in NEW messages plus a nested block is still allowed", () => {
  const core = createCore();
  const cfg = config();
  const messages = [
    ...loopedView().slice(0, 3),
    msg("raw-9", "x".repeat(6000)),
    ...loopedView().slice(3),
  ];
  const state = withRefs(
    messages,
    makeState([
      {
        blockId: "b1",
        effectiveMessageIds: ["raw-2", "raw-3", "raw-4", "raw-5"],
      },
    ]),
  );
  const startRef = state.messageRefs.byRaw["raw-1"]!;
  const endRef = state.messageRefs.byRaw["tool-2"]!;

  const applied = core.applyCompression({
    ranges: [{ startRef, endRef, summary: "S".repeat(80) }],
    messages,
    state,
    config: cfg,
  });

  assert.deepEqual(applied.result.errors, []);
  assert.equal(applied.result.blocksCreated, 1);
  const newBlock = applied.state.blocks[applied.state.blocks.length - 1]!;
  assert.deepEqual(newBlock.directMessageIds, ["raw-9"]);
  assert.deepEqual(newBlock.directBlockIds, ["b1"]);
});
