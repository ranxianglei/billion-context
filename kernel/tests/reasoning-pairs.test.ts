import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjustBoundariesForReasoningPairs } from "../src/reasoning-pairs.js";
import type { CoreMessage } from "../src/types.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { prune } from "../src/prune.js";
import { createInitialState as emptyState } from "../src/state.js";

function reasoning(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "reasoning",
    text: `reasoning-${id}`,
  };
}
function assistantText(id: string): CoreMessage {
  return { id, role: "assistant", contentType: "text", text: `text-${id}` };
}
function toolCall(id: string, callId: string, toolName = "read"): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: `call-${callId}`,
  };
}
function toolResult(
  id: string,
  callId: string,
  toolName = "read",
): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "tool-result",
    toolName,
    toolCallId: callId,
    text: `result-${callId}`,
  };
}
function textMsg(id: string, role: "user" | "assistant" = "user"): CoreMessage {
  return { id, role, contentType: "text", text: `text-${id}` };
}

describe("adjustBoundariesForReasoningPairs", () => {
  it("no-op when range has no reasoning", () => {
    const messages = [textMsg("a"), textMsg("b"), textMsg("c"), textMsg("d")];
    const result = adjustBoundariesForReasoningPairs(0, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 2 });
  });

  it("extends forward to include companion text after reasoning in range", () => {
    const messages = [
      textMsg("a"),
      reasoning("b"),
      assistantText("c"),
      textMsg("d"),
    ];
    const result = adjustBoundariesForReasoningPairs(1, 1, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 2 });
  });

  it("extends backward to include reasoning before companion text in range", () => {
    const messages = [
      textMsg("a"),
      reasoning("b"),
      assistantText("c"),
      textMsg("d"),
    ];
    const result = adjustBoundariesForReasoningPairs(2, 2, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 2 });
  });

  it("extends both directions when two pairs straddle the range", () => {
    const messages = [
      reasoning("a"),
      assistantText("b"),
      textMsg("c"),
      reasoning("d"),
      assistantText("e"),
    ];
    const result = adjustBoundariesForReasoningPairs(1, 3, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 4 });
  });

  it("treats a tool-call as the companion of preceding reasoning", () => {
    const messages = [
      textMsg("a"),
      reasoning("b"),
      toolCall("c", "call1"),
      toolResult("d", "call1"),
      textMsg("e"),
    ];
    const result = adjustBoundariesForReasoningPairs(1, 1, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 2 });
  });

  it("does not extend when reasoning is followed by a non-assistant message (no companion)", () => {
    const messages = [textMsg("a"), reasoning("b"), textMsg("c")];
    const result = adjustBoundariesForReasoningPairs(1, 1, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 1 });
  });

  it("handles a multi-message reasoning run as one unit", () => {
    const messages = [
      textMsg("a"),
      reasoning("r1"),
      reasoning("r2"),
      assistantText("c"),
      textMsg("d"),
    ];
    const result = adjustBoundariesForReasoningPairs(1, 1, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 3 });
  });
});

describe("compression with reasoning-pair protection", () => {
  const cfg = {
    ...defaultConfig(100000),
    compress: { ...defaultConfig(100000).compress, minCompressRange: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  };

  it("compression auto-includes companion text after reasoning", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      reasoning("m2"),
      assistantText("m3"),
      textMsg("m4"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 1000,
    }).state;

    const result = core.applyCompression({
      ranges: [
        {
          startRef: "m00002",
          endRef: "m00002",
          summary:
            "Compress just the reasoning; its companion text must be auto-included to keep the pair atomic.",
        },
      ],
      messages,
      state: stateWithRefs,
      config: cfg,
    });

    assert.equal(result.result.blocksCreated, 1);
    const block = result.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(
      block!.effectiveMessageIds.includes("m2"),
      "reasoning m2 should be in block",
    );
    assert.ok(
      block!.effectiveMessageIds.includes("m3"),
      "companion text m3 should be auto-included",
    );
  });

  it("compression auto-includes reasoning before companion text", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      reasoning("m2"),
      assistantText("m3"),
      textMsg("m4"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 1000,
    }).state;

    const result = core.applyCompression({
      ranges: [
        {
          startRef: "m00003",
          endRef: "m00003",
          summary:
            "Compress just the companion text; its preceding reasoning must be auto-included.",
        },
      ],
      messages,
      state: stateWithRefs,
      config: cfg,
    });

    assert.equal(result.result.blocksCreated, 1);
    const block = result.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(
      block!.effectiveMessageIds.includes("m2"),
      "reasoning m2 should be auto-included",
    );
    assert.ok(
      block!.effectiveMessageIds.includes("m3"),
      "companion text m3 should be in block",
    );
  });

  it("reasoning + tool-call pair also pulls the tool-result (composed adjustment)", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      reasoning("m2"),
      toolCall("m3", "c1"),
      toolResult("m4", "c1"),
      textMsg("m5"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 1000,
    }).state;

    const result = core.applyCompression({
      ranges: [
        {
          startRef: "m00002",
          endRef: "m00002",
          summary:
            "Compress just the reasoning; fixpoint pulls in the tool-call then its result.",
        },
      ],
      messages,
      state: stateWithRefs,
      config: cfg,
    });

    assert.equal(result.result.blocksCreated, 1);
    const block = result.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(
      block!.effectiveMessageIds.includes("m2"),
      "reasoning m2 in block",
    );
    assert.ok(
      block!.effectiveMessageIds.includes("m3"),
      "tool-call m3 pulled by reasoning companion",
    );
    assert.ok(
      block!.effectiveMessageIds.includes("m4"),
      "tool-result m4 pulled by tool-pair fixpoint",
    );
  });

  it("uncompressed reasoning pair survives intact when another range is compressed", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      reasoning("m2"),
      assistantText("m3"),
      textMsg("m4"),
      reasoning("m5"),
      assistantText("m6"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 1000,
    }).state;

    const result = core.applyCompression({
      ranges: [
        {
          startRef: "m00005",
          endRef: "m00006",
          summary:
            "Compress the second reasoning pair. The first pair must survive intact.",
        },
      ],
      messages,
      state: stateWithRefs,
      config: cfg,
    });

    const pruned = core.processTurn({
      messages,
      state: result.state,
      config: cfg,
      tokenCount: 500,
    }).messages;

    const ids = pruned.map((m) => m.id);
    assert.ok(ids.includes("m2"), "uncompressed reasoning m2 survives");
    assert.ok(ids.includes("m3"), "uncompressed companion text m3 survives");
    assert.ok(!ids.includes("m5"), "compressed reasoning m5 removed");
    assert.ok(!ids.includes("m6"), "compressed companion text m6 removed");
  });
});

describe("prune stripOrphanedReasoning (defense-in-depth)", () => {
  it("strips a dangling reasoning whose companion was removed", () => {
    const messages: CoreMessage[] = [
      { id: "u0", role: "user", contentType: "text", text: "ask" },
      {
        id: "r1",
        role: "assistant",
        contentType: "reasoning",
        text: "thinking",
      },
      { id: "a1", role: "assistant", contentType: "text", text: "answer" },
      { id: "u1", role: "user", contentType: "text", text: "next" },
    ];

    // Degenerate straddle: the companion text a1 is covered but the reasoning
    // r1 is not. After rebuild r1 is followed by a user message → dangling.
    const state = {
      ...emptyState(),
      blocks: [
        {
          blockId: "b0",
          runId: "r0",
          tier: 1 as const,
          summary: "covered the answer",
          directMessageIds: ["a1"],
          effectiveMessageIds: ["a1"],
          directBlockIds: [],
          compressedTokens: 10,
          createdAt: 0,
          survivedCount: 0,
          generation: "young" as const,
          active: true,
          compressCallId: undefined,
          startRef: undefined,
          endRef: undefined,
        },
      ],
    };

    const result = prune(messages, state);
    const ids = result.map((m) => m.id);
    assert.ok(!ids.includes("r1"), "dangling reasoning r1 stripped");
    assert.ok(!ids.includes("a1"), "covered companion a1 pruned");
    assert.ok(ids.includes("u0"), "first user message preserved");
    assert.ok(ids.includes("u1"), "trailing user message preserved");
  });

  it("keeps a reasoning pair when neither half is covered", () => {
    const messages: CoreMessage[] = [
      { id: "u0", role: "user", contentType: "text", text: "ask" },
      {
        id: "r1",
        role: "assistant",
        contentType: "reasoning",
        text: "thinking",
      },
      { id: "a1", role: "assistant", contentType: "text", text: "answer" },
    ];

    const result = prune(messages, emptyState());
    const ids = result.map((m) => m.id);
    assert.ok(ids.includes("r1"), "reasoning kept (companion present)");
    assert.ok(ids.includes("a1"), "companion text kept");
  });
});

describe("regression: DeepSeek split-compress does not orphan a reasoning pair (#133)", () => {
  // Reproduces ranxianglei/billion-context#133. An assistant turn is emitted as
  // two core messages — reasoning then text. A compress range that covers only
  // ONE half must not leave the other half orphaned in the rebuilt stream.
  // DeepSeek-thinking returns HTTP 400 ("reasoning_content must be passed back
  // to the API") when an assistant turn loses its reasoning_content, so the
  // pair must compress atomically. These tests would FAIL on master (pre-fix):
  // without adjustBoundariesForReasoningPairs the companion survives as an
  // orphaned assistant message with no reasoning_content.

  const cfg = {
    ...defaultConfig(100000),
    compress: { ...defaultConfig(100000).compress, minCompressRange: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  };

  it("compressing only the reasoning does not orphan the companion assistant text", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      reasoning("m2"),
      assistantText("m3"),
      textMsg("m4"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 1000,
    }).state;

    const result = core.applyCompression({
      ranges: [
        {
          startRef: "m00002",
          endRef: "m00002",
          summary:
            "Compress just the reasoning; its companion text must compress with it.",
        },
      ],
      messages,
      state: stateWithRefs,
      config: cfg,
    });

    const rebuilt = core.processTurn({
      messages,
      state: result.state,
      config: cfg,
      tokenCount: 500,
    }).messages;
    const ids = rebuilt.map((m) => m.id);

    assert.ok(
      !ids.includes("m2"),
      "reasoning m2 must be compressed (not survive as orphan)",
    );
    assert.ok(
      !ids.includes("m3"),
      "companion text m3 must compress WITH its reasoning — an orphaned assistant message with no reasoning_content is the DeepSeek 400 trigger",
    );
  });

  it("compressing only the companion text does not orphan the reasoning", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      reasoning("m2"),
      assistantText("m3"),
      textMsg("m4"),
    ];
    const state = createInitialState();
    const stateWithRefs = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 1000,
    }).state;

    const result = core.applyCompression({
      ranges: [
        {
          startRef: "m00003",
          endRef: "m00003",
          summary:
            "Compress just the text; its preceding reasoning must compress with it.",
        },
      ],
      messages,
      state: stateWithRefs,
      config: cfg,
    });

    const rebuilt = core.processTurn({
      messages,
      state: result.state,
      config: cfg,
      tokenCount: 500,
    }).messages;
    const ids = rebuilt.map((m) => m.id);

    assert.ok(
      !ids.includes("m2"),
      "reasoning m2 must compress with its companion — an orphaned reasoning with no following assistant text is meaningless",
    );
    assert.ok(
      !ids.includes("m3"),
      "companion text m3 must be compressed (not survive as orphan)",
    );
  });
});
