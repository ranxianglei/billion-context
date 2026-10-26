import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { computeTurnGroups } from "../src/turn-integrity.js";
import { adjustBoundariesForReasoningPairs } from "../src/reasoning-pairs.js";
import type { CoreMessage } from "../src/types.js";

function user(id: string, text = "u"): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "text",
    text: `${text}-${id} ` + "x".repeat(200),
  };
}
function reasoning(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "reasoning",
    text: `think-${id} ` + "t".repeat(400),
  };
}
function toolCall(id: string, callId: string, toolName = "pwsh"): CoreMessage {
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
  toolName = "pwsh",
): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "tool-result",
    toolName,
    toolCallId: callId,
    text: `result-${callId} ` + "r".repeat(200),
  };
}

function buildMessages(): CoreMessage[] {
  return [
    user("m00001"),
    user("m00002"),
    reasoning("m00003"),
    toolCall("m00004", "call_00_x"),
    toolCall("m00005", "call_01_x"),
    toolResult("m00006", "call_00_x"),
    toolResult("m00007", "call_01_x"),
    user("m00008"),
    user("m00009"),
  ];
}

const config = (over: Record<string, unknown> = {}) => ({
  ...defaultConfig(150000),
  compress: {
    ...defaultConfig(150000).compress,
    minCompressRange: 1,
    minSummaryLength: 1,
    ...over,
  },
});

describe("computeTurnGroups", () => {
  it("groups reasoning + multi-call burst + all results as one atomic turn", () => {
    const groups = computeTurnGroups(buildMessages());
    const big = groups.find((g) => g.includes("m00003"))!;
    assert.deepEqual(
      new Set(big),
      new Set(["m00003", "m00004", "m00005", "m00006", "m00007"]),
    );
  });

  it("groups a no-reasoning burst with its results", () => {
    const msgs = [
      user("m1"),
      toolCall("m2", "c1"),
      toolResult("m3", "c1"),
      user("m4"),
    ];
    const groups = computeTurnGroups(msgs);
    assert.deepEqual(groups, [["m2", "m3"]]);
  });

  it("leaves orphan reasoning ungrouped", () => {
    const msgs = [user("m1"), reasoning("m2"), user("m3")];
    assert.deepEqual(computeTurnGroups(msgs), []);
  });
});

describe("adjustBoundariesForReasoningPairs (#684 whole-burst pull)", () => {
  it("forward pull covers the entire multi-call burst, not just the first companion", () => {
    const msgs = buildMessages();
    const r = adjustBoundariesForReasoningPairs(0, 2, msgs);
    assert.equal(r.endIndex, 4);
  });
});

describe("#684 regression: protected carve must not split a turn", () => {
  it("withdraws the whole turn when the carve keeps one call alive", () => {
    const core = createCore();
    let state = createInitialState();
    const messages = buildMessages();
    const out = core.processTurn({
      messages,
      state,
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    state = out.state;
    const refs = state.messageRefs.byRaw;
    // recent-zone protection covers call_01 + its result (as in the snapshot)
    const protectedRefs = new Set([refs["m00005"]!, refs["m00007"]!]);
    const res = core.applyCompression({
      state,
      messages,
      config: config(),
      protectedMessageIds: protectedRefs,
      ranges: [
        { startRef: "m00001", endRef: "m00007", summary: "s".repeat(400) },
      ],
    });
    const block = res.state.blocks.find((b) => b.active);
    assert.ok(block, "block created for the non-split part");
    for (const id of ["m00003", "m00004", "m00005", "m00006", "m00007"]) {
      assert.ok(
        !block.effectiveMessageIds.includes(id),
        `${id} must not fold (turn split by protected zone)`,
      );
    }
    assert.ok(
      res.result.warnings.some((w) => /turn/.test(w)),
      JSON.stringify(res.result.warnings),
    );
    // the surviving view keeps the WHOLE turn visible: reasoning + both calls + results
    const view = core.processTurn({
      messages,
      state: res.state,
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const visibleIds = new Set(
      view.messages.map((m) => (m as { id?: string }).id).filter(Boolean),
    );
    for (const id of ["m00003", "m00004", "m00005", "m00006", "m00007"]) {
      assert.ok(visibleIds.has(id), `${id} must stay visible`);
    }
  });

  it("fails with a clear error when the range is exactly the split turn", () => {
    const core = createCore();
    let state = createInitialState();
    const messages = buildMessages();
    const out = core.processTurn({
      messages,
      state,
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    state = out.state;
    const refs = state.messageRefs.byRaw;
    const res = core.applyCompression({
      state,
      messages,
      config: config(),
      protectedMessageIds: new Set([refs["m00005"]!, refs["m00007"]!]),
      ranges: [
        { startRef: "m00003", endRef: "m00007", summary: "s".repeat(400) },
      ],
    });
    assert.equal(res.result.blocksCreated, 0);
    assert.equal(res.result.errors.length, 1);
    assert.match(res.result.errors[0]!, /split 1 turn/);
  });

  it("#564 shape stays allowed: fold call+result, keep reasoning+text (directional)", () => {
    const core = createCore();
    const state = createInitialState();
    const messages: CoreMessage[] = [
      user("m1"),
      reasoning("m2"),
      {
        id: "m3",
        role: "assistant",
        contentType: "text",
        text: "TEXT-A " + "x".repeat(200),
      },
      toolCall("m4", "ca"),
      toolResult("m5", "ca"),
      user("m6"),
      user("m7"),
    ];
    const out = core.processTurn({
      messages,
      state,
      config: config(),
      tokenCount: (t) => Math.ceil(t.length / 4),
    });
    const res = core.applyCompression({
      state: out.state,
      messages,
      config: config(),
      protectedMessageIds: new Set(),
      ranges: [
        { startRef: "m00004", endRef: "m00005", summary: "s".repeat(400) },
      ],
    });
    assert.equal(
      res.result.blocksCreated,
      1,
      `call+result must fold; errors=${JSON.stringify(res.result.errors)}`,
    );
    const block = res.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(block.effectiveMessageIds.includes("m4"));
    assert.ok(block.effectiveMessageIds.includes("m5"));
    assert.ok(
      !res.result.warnings.some((w) => /turn/.test(w)),
      JSON.stringify(res.result.warnings),
    );
  });
});
