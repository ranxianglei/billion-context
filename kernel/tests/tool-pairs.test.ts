import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjustBoundariesForToolPairs } from "../src/tool-pairs.js";
import type { CoreMessage } from "../src/types.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";

function msg(
  id: string,
  contentType: CoreMessage["contentType"],
  extra: Partial<CoreMessage> = {},
): CoreMessage {
  return { id, role: "user", contentType, text: `msg-${id}`, ...extra };
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

function textMsg(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: `text-${id}` };
}

describe("adjustBoundariesForToolPairs", () => {
  it("no-op when range has no tool messages", () => {
    const messages = [textMsg("a"), textMsg("b"), textMsg("c"), textMsg("d")];
    const result = adjustBoundariesForToolPairs(0, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 2 });
  });

  it("extends forward to include tool-result after range", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "call1"),
      textMsg("c"),
      toolResult("d", "call1"),
      textMsg("e"),
    ];
    const result = adjustBoundariesForToolPairs(0, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 3 });
  });

  it("extends backward to include tool-call before range", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "call1"),
      textMsg("c"),
      toolResult("d", "call1"),
      textMsg("e"),
    ];
    const result = adjustBoundariesForToolPairs(2, 3, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 3 });
  });

  it("extends both directions when two pairs straddle the range", () => {
    const messages = [
      toolCall("a", "call1"),
      toolResult("b", "call1"),
      toolCall("c", "call2"),
      textMsg("d"),
      toolResult("e", "call2"),
    ];
    const result = adjustBoundariesForToolPairs(1, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 4 });
  });

  it("skips compress tool (force-protected)", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "comp1", "compress"),
      textMsg("c"),
      toolResult("d", "comp1", "compress"),
      textMsg("e"),
    ];
    const result = adjustBoundariesForToolPairs(0, 2, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 2 });
  });

  it("stop-at-first-gap: stops after finding match then hitting gap", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "call1"),
      toolResult("c", "call1"),
      textMsg("d"),
      toolResult("e", "call1"),
    ];
    const result = adjustBoundariesForToolPairs(0, 1, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 2 });
  });

  it("does not pull result beyond maxScan distance", () => {
    const messages: CoreMessage[] = [toolCall("a", "call1")];
    for (let i = 0; i < 25; i++) {
      messages.push(textMsg(`gap${i}`));
    }
    messages.push(toolResult("result", "call1"));
    const result = adjustBoundariesForToolPairs(0, 0, messages, 5);
    assert.deepEqual(result, { startIndex: 0, endIndex: 0 });
  });

  it("handles multiple pairs in range", () => {
    const messages = [
      textMsg("a"),
      toolCall("b", "call1"),
      toolResult("c", "call1"),
      toolCall("d", "call2"),
      textMsg("e"),
      toolResult("f", "call2"),
    ];
    const result = adjustBoundariesForToolPairs(1, 4, messages);
    assert.deepEqual(result, { startIndex: 1, endIndex: 5 });
  });
});

describe("compression with tool-pair protection", () => {
  const cfg = {
    ...defaultConfig(100000),
    compress: { ...defaultConfig(100000).compress, minCompressRange: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  };

  it("compression auto-includes orphaned tool-result", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      toolCall("m2", "c1"),
      textMsg("m3"),
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
          startRef: "m00001",
          endRef: "m00003",
          summary:
            "Compressed range with tool-call but not its result — extension should pull the result in.",
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
      block!.effectiveMessageIds.includes("m4"),
      "tool-result m4 should be auto-included",
    );
    assert.ok(
      block!.effectiveMessageIds.includes("m2"),
      "tool-call m2 should be in block",
    );
  });

  it("compression auto-includes orphaned tool-call", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      toolCall("m2", "c1"),
      textMsg("m3"),
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
          startRef: "m00003",
          endRef: "m00004",
          summary:
            "Compressed range with tool-result but not its call — extension pulls the call in.",
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
      "tool-call m2 should be auto-included",
    );
    assert.ok(
      block!.effectiveMessageIds.includes("m4"),
      "tool-result m4 should be in block",
    );
  });

  it("block-boundary range skips tool-pair adjustment (tier detection preserved)", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      toolCall("m2", "c1"),
      toolResult("m3", "c1"),
      textMsg("m4"),
      toolCall("m5", "c2"),
      toolResult("m6", "c2"),
      textMsg("m7"),
    ];
    const state = createInitialState();
    const s1 = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 1000,
    }).state;

    const r1 = core.applyCompression({
      ranges: [
        {
          startRef: "m00001",
          endRef: "m00004",
          summary:
            "First tier-1 block covering initial text and a complete tool pair for reading configuration.",
          topic: "Phase 1",
        },
      ],
      messages,
      state: s1,
      config: cfg,
    });
    assert.equal(r1.result.blocksCreated, 1);
    const b1 = r1.state.blocks.find((b) => b.blockId === "b1");
    assert.ok(b1);
    assert.equal(b1!.tier, 1);

    const r2 = core.applyCompression({
      ranges: [
        {
          startRef: "b1",
          endRef: "b1",
          summary:
            "Tier-2 distillation of the first phase, condensing the initial setup and configuration reads.",
          topic: "Distilled Phase 1",
        },
      ],
      messages,
      state: r1.state,
      config: cfg,
    });
    assert.equal(
      r2.result.blocksCreated,
      1,
      `b1→b1 should create b2, errors: ${JSON.stringify(r2.result.errors)}`,
    );
    const b2 = r2.state.blocks.find((b) => b.blockId === "b2");
    assert.ok(b2, "tier-2 block b2 should be created");
    assert.equal(b2!.tier, 2, "b2 should be tier-2");
    const b1After = r2.state.blocks.find((b) => b.blockId === "b1");
    assert.ok(!b1After!.active, "b1 should be consumed by b2");
    assert.deepEqual(
      b2!.directBlockIds,
      ["b1"],
      "b2 should list b1 as consumed",
    );
  });

  it("tool-pair extension re-scans for nested blocks in adjusted range", () => {
    const core = createCore();
    const messages = [
      toolCall("m1", "c1"),
      toolResult("m2", "c1"),
      textMsg("m3"),
      toolCall("m4", "c2"),
      toolResult("m5", "c2"),
      textMsg("m6"),
    ];
    const state = createInitialState();
    const s1 = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 1000,
    }).state;

    const r1 = core.applyCompression({
      ranges: [
        {
          startRef: "m00001",
          endRef: "m00002",
          summary:
            "Block covering the first complete tool pair for initial file read operations.",
          topic: "Pair 1",
        },
      ],
      messages,
      state: s1,
      config: cfg,
    });
    assert.equal(r1.result.blocksCreated, 1);

    const r2 = core.applyCompression({
      ranges: [
        {
          startRef: "m00004",
          endRef: "m00005",
          summary:
            "Second complete tool pair covering the second file read and its result output.",
          topic: "Pair 2",
        },
      ],
      messages,
      state: r1.state,
      config: cfg,
    });
    assert.equal(r2.result.blocksCreated, 1);
    const b2 = r2.state.blocks.find((b) => b.blockId === "b2");
    assert.ok(b2);
    assert.ok(
      !b2!.directBlockIds.includes("b1"),
      "b1 should NOT be consumed (its anchor is outside the range)",
    );
  });
});

describe("prune stripOrphanedToolCalls (defense-in-depth)", () => {
  const cfg = {
    ...defaultConfig(100000),
    compress: { ...defaultConfig(100000).compress, minCompressRange: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  };

  it("complete pair survives when other pair is compressed", () => {
    const core = createCore();
    const messages = [
      textMsg("m1"),
      toolCall("m2", "c1"),
      toolResult("m3", "c1"),
      toolCall("m4", "c2"),
      toolResult("m5", "c2"),
      textMsg("m6"),
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
          startRef: "m00004",
          endRef: "m00005",
          summary:
            "Second tool pair compressed. First pair should survive intact.",
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
    assert.ok(ids.includes("m2"), "uncompressed tool-call m2 survives");
    assert.ok(ids.includes("m3"), "uncompressed tool-result m3 survives");
    assert.ok(!ids.includes("m4"), "compressed tool-call m4 removed");
    assert.ok(!ids.includes("m5"), "compressed tool-result m5 removed");
  });

  it("orphaned tool-result stripped when its call sits in a pre-gate block (defense-in-depth)", () => {
    // Since the #684 turn-integrity gate, applyCompression can no longer
    // create this orphan itself (a turn folds atomically or not at all). The
    // prune-side strip remains defense-in-depth for states persisted by older
    // builds and for block-boundary rewrites — so construct the split state
    // directly: a block whose coverage contains only the tool-call.
    const core = createCore();
    const messages: CoreMessage[] = [toolCall("m1", "c1")];
    for (let i = 0; i < 25; i++) {
      messages.push(textMsg(`gap${i}`));
    }
    messages.push(toolResult("result", "c1"));

    const state = createInitialState();
    const stateWithRefs = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 5000,
    }).state;
    const refOf = (raw: string) => stateWithRefs.messageRefs.byRaw[raw]!;

    stateWithRefs.blocks.push({
      blockId: "b1",
      runId: "run1",
      tier: 1,
      summary: "Legacy split block covering only the call (pre-#684 state).",
      directMessageIds: ["m1"],
      effectiveMessageIds: ["m1"],
      directBlockIds: [],
      compressedTokens: 10,
      createdAt: Date.now(),
      survivedCount: 0,
      generation: "young",
      active: true,
      startRef: refOf("m1"),
      endRef: refOf("m1"),
    });

    const pruned = core.processTurn({
      messages,
      state: stateWithRefs,
      config: cfg,
      tokenCount: 4000,
    }).messages;

    const ids = pruned.map((m) => m.id);
    assert.ok(!ids.includes("m1"), "blocked tool-call m1 hidden");
    assert.ok(
      !ids.includes("result"),
      "orphaned tool-result stripped by defense-in-depth",
    );
  });
});
