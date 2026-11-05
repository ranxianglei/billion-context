import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "../src/types.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { adjustBoundariesForToolPairs } from "../src/tool-pairs.js";

/**
 * #5751: fold boundaries splitting tool_use/tool_result pairs.
 *
 * A long tool-dense session (parallel tool bursts, interleaved host
 * messages) legally interleave far more than 20 messages between a call and
 * its result. The old distance-capped widening (maxScan=20, stop-on-gap,
 * break-on-empty) missed the mate, the turn-integrity gate then withdrew the
 * pair from every candidate range — and in tool-dense regions NO legal range
 * remained ("folding stuck", #5746) — or the split reached the wire as a
 * persistent upstream 400 that never self-heals (#5751). Pairing must be
 * id-exact over the whole array, never distance-scanned.
 */

function toolCall(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "read",
    toolCallId: callId,
    text: `call-${callId}`,
  };
}

function toolResult(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "tool-result",
    toolName: "read",
    toolCallId: callId,
    text: `result-${callId}`,
  };
}

function textMsg(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: `text-${id}` };
}

describe("adjustBoundariesForToolPairs id-exact widening (#5751)", () => {
  it("chains interleaved pairs to a fixed point", () => {
    const messages: CoreMessage[] = [toolCall("a", "c1"), toolCall("b", "c2")];
    for (let i = 0; i < 28; i++) messages.push(textMsg(`gap1-${i}`));
    messages.push(toolResult("r1", "c1"));
    for (let i = 0; i < 29; i++) messages.push(textMsg(`gap2-${i}`));
    messages.push(toolResult("r2", "c2"));

    const result = adjustBoundariesForToolPairs(0, 0, messages);
    assert.deepEqual(result, {
      startIndex: 0,
      endIndex: messages.length - 1,
    });
  });

  it("sparse array (undefined holes) does not stop pairing", () => {
    const messages: CoreMessage[] = [
      toolCall("a", "c1"),
      textMsg("x"),
      undefined as unknown as CoreMessage,
      textMsg("y"),
    ];
    for (let i = 0; i < 25; i++) messages.push(textMsg(`gap${i}`));
    messages.push(toolResult("b", "c1"));

    const result = adjustBoundariesForToolPairs(0, 0, messages);
    assert.deepEqual(result, {
      startIndex: 0,
      endIndex: messages.length - 1,
    });
  });

  it("gap-break heuristic no longer strands an interleaved mate", () => {
    // Old scanner: matched result for c1 at end+1, then broke at the first
    // non-matching message — result for c2 at end+3 stayed out.
    const messages = [
      toolCall("a", "c1"),
      toolCall("b", "c2"),
      toolResult("r1", "c1"),
      textMsg("gap"),
      toolResult("r2", "c2"),
    ];
    const result = adjustBoundariesForToolPairs(0, 1, messages);
    assert.deepEqual(result, { startIndex: 0, endIndex: 4 });
  });
});

describe("applyCompression with distant pairs (#5751 / #5746)", () => {
  const cfg = {
    ...defaultConfig(100000),
    compress: { ...defaultConfig(100000).compress, minCompressRange: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  };

  it("a straddling range folds the WHOLE pair together (>20 distance) and rebuilds clean", () => {
    const core = createCore();
    const messages: CoreMessage[] = [textMsg("m0"), toolCall("m1", "c1")];
    for (let i = 2; i < 30; i++) messages.push(textMsg(`m${i}`));
    messages.push(toolResult("m30", "c1"), textMsg("m31"));

    const state = createInitialState();
    const s1 = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 5000,
    }).state;

    // Model's range ends inside the pair (call in, result 29 messages out).
    // Old behavior: widening missed the result -> integrity gate withdrew the
    // call -> tiny block, call left visible, result folded => split. New:
    // both halves fold together.
    const r = core.applyCompression({
      ranges: [
        {
          startRef: "m00001",
          endRef: "m00002",
          summary:
            "Fold the first exchange including its late-arriving result.",
        },
      ],
      messages,
      state: s1,
      config: cfg,
    });
    assert.equal(r.result.blocksCreated, 1);
    const block = r.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(block!.effectiveMessageIds.includes("m1"), "tool-call folds");
    assert.ok(
      block!.effectiveMessageIds.includes("m30"),
      "distant tool-result folds together with its call",
    );

    const pruned = core.processTurn({
      messages,
      state: r.state,
      config: cfg,
      tokenCount: 4000,
    }).messages;
    const ids = pruned.map((m) => m.id);
    assert.ok(!ids.includes("m1"), "call not visible after fold");
    assert.ok(!ids.includes("m30"), "result not visible after fold");
  });

  it("tool-dense region: every candidate range lands (no folding-stuck loop)", () => {
    const core = createCore();
    // 8 pairs, each separated by 24 filler messages — every short range
    // straddles a distant mate under the old cap.
    const messages: CoreMessage[] = [];
    for (let p = 0; p < 8; p++) {
      messages.push(toolCall(`call${p}`, `cc${p}`));
      for (let i = 0; i < 24; i++) messages.push(textMsg(`f${p}-${i}`));
      messages.push(toolResult(`res${p}`, `cc${p}`));
    }

    const state = createInitialState();
    const s1 = core.processTurn({
      messages,
      state,
      config: cfg,
      tokenCount: 20000,
    }).state;

    const r = core.applyCompression({
      ranges: [
        {
          startRef: "m00001",
          endRef: "m00025",
          summary:
            "First exchanges of the tool-dense region: the opening reads, their late results, and filler turns.",
        },
      ],
      messages,
      state: s1,
      config: cfg,
    });
    assert.equal(r.result.blocksCreated, 1);
    const block = r.state.blocks.find((b) => b.active);
    assert.ok(block);
    assert.ok(block!.effectiveMessageIds.includes("call0"));
    assert.ok(block!.effectiveMessageIds.includes("res0"));
    assert.equal(
      r.result.errors.length,
      0,
      `no fatal split: ${JSON.stringify(r.result.errors)}`,
    );
    // No half-split residue: warnings may exist, but no withdrawn pair.
    const pruned = core.processTurn({
      messages,
      state: r.state,
      config: cfg,
      tokenCount: 15000,
    }).messages;
    const visible = new Set(pruned.map((m) => m.id));
    for (const id of ["call0", "res0"]) {
      assert.ok(!visible.has(id), `${id} folded with its mate`);
    }
    assert.ok(visible.has("call1"), "later pairs stay visible");
    assert.ok(visible.has("res1"), "later pairs stay visible");
  });

  it("block-boundary ranges still skip adjustment (tier detection preserved)", () => {
    const core = createCore();
    const messages: CoreMessage[] = [
      textMsg("m0"),
      toolCall("m1", "c1"),
      toolResult("m2", "c1"),
      textMsg("m3"),
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
          endRef: "m00003",
          summary:
            "First block covering a complete exchange: the call, its result, and filler.",
        },
      ],
      messages,
      state: s1,
      config: cfg,
    });
    assert.equal(r1.result.blocksCreated, 1);
    // b1..b1 must not widen past its own coverage.
    const r2 = core.applyCompression({
      ranges: [
        {
          startRef: "b1",
          endRef: "b1",
          summary:
            "Distill the first block into its tier-2 essence, keeping the exchange facts.",
        },
      ],
      messages,
      state: r1.state,
      config: cfg,
    });
    assert.equal(r2.result.blocksCreated, 1);
    const b2 = r2.state.blocks.find((b) => b.blockId === "b2");
    assert.ok(b2);
    assert.deepEqual(b2!.directBlockIds, ["b1"]);
  });
});
