import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectUnit } from "../src/unit-projection.js";
import type { CoreMessage } from "../src/types.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import { assignRefs } from "../src/refs.js";

// #4197: applyPairBoundaryAdjustments capped its composition loop at 2
// passes, but each pass only sees pairs of messages already inside the
// range AT PASS START — an interleaved tool/thinking chain needs one pass
// per link. Truncation left a boundary cutting through a pair: the rebuilt
// conversation shipped an orphan half outside the fold (reasoning without
// its response → DeepSeek/R1/QwQ 400 "reasoning_content ... must be passed
// back"; or a tool_call/result split → every OpenAI-wire provider 400).
// These tests pin the TRUE fixpoint through the public projectUnit entry —
// the single definition of "can this range fold" (#3236) that compress /
// recommend / report all share.

function reasoning(id: string): CoreMessage {
  return { id, role: "assistant", contentType: "reasoning", text: `r-${id}` };
}
function userText(id: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: `u-${id}` };
}
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

/** Project a single-message range [index..index] through projectUnit and
 *  return the projection plus the raw ids of the whole array. */
function projectSingle(messages: CoreMessage[], index: number) {
  const state = createInitialState();
  const { map } = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  });
  state.messageRefs = map;
  const rawId = messages[index]!.id!;
  const ref = map.byRaw[rawId];
  assert.ok(ref, `expected a resolvable ref for ${rawId}`);
  const warnings: string[] = [];
  const projection = projectUnit({
    messages,
    state,
    config: {
      ...defaultConfig(100_000),
      preserveRecentMessages: 0,
      preserveRecentTokens: 0,
    },
    startRef: ref,
    endRef: ref,
    preExistingCoverage: new Set(),
    warnings,
  });
  return { projection, warnings, allIds: messages.map((m) => m.id!) };
}

describe("issue #4197: pair-boundary adjustment converges to a true fixpoint", () => {
  it("folds the full 3-link interleaved chain (orphan-reasoning shape)", () => {
    // Delta-debugged minimal repro from the issue. Request folding the LAST
    // result (idx 6); convergence needs 3 changing passes:
    //   pass0 [6,6]→[4,6]  (TR(c1) pulls in its call TC(c1))
    //   pass1 [4,6]→[1,6]  (swept band carries TR(c0) → pulls in TC(c0))
    //   pass2 [1,6]→[0,6]  (TC(c0) pulls in its preceding reasoning R)
    // The old ≤2-pass cap stopped at [1,6]: R@0 stayed visible while its
    // response TC(c0)@1 folded → orphaned reasoning → provider 400.
    const messages = [
      reasoning("m0"),
      toolCall("m1", "c0"),
      toolResult("m2", "c0"),
      userText("m3"),
      toolCall("m4", "c1"),
      toolResult("m5", "c0"),
      toolResult("m6", "c1"),
      userText("m7"),
      userText("m8"),
    ];
    const { projection } = projectSingle(messages, 6);
    assert.equal(projection.fatal, null);
    assert.equal(projection.withdrawnIds.size, 0);
    assert.deepEqual(projection.rangeMessageIds, [
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
  });

  it("folds the same chain with unique toolCallIds (late result arrival)", () => {
    // Same interleaving, realistic pairing: each toolCallId has exactly one
    // result, c0's result arriving AFTER c1's call. Still 3 changing passes;
    // the 2-pass cap again stranded R@0 outside.
    const messages = [
      reasoning("n0"),
      toolCall("n1", "c0"),
      userText("n2"),
      userText("n3"),
      toolCall("n4", "c1"),
      toolResult("n5", "c0"),
      toolResult("n6", "c1"),
      userText("n7"),
      userText("n8"),
    ];
    const { projection } = projectSingle(messages, 6);
    assert.equal(projection.fatal, null);
    assert.equal(projection.withdrawnIds.size, 0);
    assert.deepEqual(projection.rangeMessageIds, [
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      "n6",
    ]);
  });

  it("converges beyond three passes on a 4-link chain (split-pair shape)", () => {
    // 10 messages needing FOUR changing passes:
    //   pass0 [8,8]→[6,8]  (TR(c) pulls in TC(c); sweep passes TR(b))
    //   pass1 [6,8]→[4,8]  (swept TR(b) pulls in TC(b))
    //   pass2 [4,8]→[1,8]  (swept TR(a) pulls in TC(a)+TR(a))
    //   pass3 [1,8]→[0,8]  (TC(a) pulls in its preceding reasoning R)
    // The old cap stopped at [4,8]: TR(a)@5 folded while its call TC(a)@1
    // stayed visible → split tool_call/result pair → provider 400.
    const messages = [
      reasoning("a0"),
      toolCall("a1", "ca"),
      toolResult("a2", "ca"),
      userText("a3"),
      toolCall("a4", "cb"),
      toolResult("a5", "ca"),
      toolCall("a6", "cc"),
      toolResult("a7", "cb"),
      toolResult("a8", "cc"),
      userText("a9"),
    ];
    const { projection } = projectSingle(messages, 8);
    assert.equal(projection.fatal, null);
    assert.equal(projection.withdrawnIds.size, 0);
    assert.deepEqual(projection.rangeMessageIds, [
      "a0",
      "a1",
      "a2",
      "a3",
      "a4",
      "a5",
      "a6",
      "a7",
      "a8",
    ]);
  });

  it("still converges immediately for a plain single-message range (no over-widen)", () => {
    // Negative control: a range with no pairs to protect must stay exactly
    // where requested — the fixpoint loop must not widen beyond pairs.
    const messages = [userText("p0"), userText("p1"), userText("p2")];
    const { projection } = projectSingle(messages, 1);
    assert.equal(projection.fatal, null);
    assert.deepEqual(projection.rangeMessageIds, ["p1"]);
  });
});
