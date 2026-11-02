import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import {
  computeIntegrityWithdrawals,
  isSignedThinkingFamily,
} from "../src/turn-integrity.js";
import type { CoreMessage } from "../src/types.js";

/** CoreMessage plus the wire sidecars the codecs attach
 *  (structurally typed — mirrors the MediaSidecar discipline in
 *  protected.ts: core modules/tests do not import from src/wire/). */
type SignedCore = CoreMessage & {
  thinkingSignature?: string;
  rawAnthropicBlock?: unknown;
  reasoningContent?: string;
};

function user(id: string): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "text",
    text: `${id} ` + "x".repeat(200),
  };
}
function asstText(id: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "text",
    text: `prose-${id} ` + "z".repeat(200),
  };
}
function reasoning(id: string, signature?: string): SignedCore {
  return {
    id,
    role: "assistant",
    contentType: "reasoning",
    text: `think-${id} ` + "t".repeat(400),
    ...(signature ? { thinkingSignature: signature } : {}),
  };
}
function redacted(id: string): SignedCore {
  return {
    id,
    role: "assistant",
    contentType: "text",
    text: "[redacted_thinking]",
    rawAnthropicBlock: { type: "redacted_thinking", data: "REDACTED" },
  };
}
function toolCall(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "bash",
    toolCallId: callId,
    text: `call-${callId}`,
  };
}
function toolResult(id: string, callId: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName: "bash",
    toolCallId: callId,
    text: `result-${callId} ` + "r".repeat(200),
  };
}

const config = () => ({
  ...defaultConfig(150000),
  compress: {
    ...defaultConfig(150000).compress,
    minCompressRange: 1,
    minSummaryLength: 1,
    preserveRecentMessages: 0,
  },
});

function fold(messages: SignedCore[], startId: string, endId: string) {
  const core = createCore();
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config: config(),
    tokenCount: (t) => Math.ceil(t.length / 4),
  }).state;
  const refs = state.messageRefs.byRaw;
  const res = core.applyCompression({
    state,
    messages,
    config: config(),
    protectedMessageIds: new Set<string>(),
    ranges: [
      { startRef: refs[startId]!, endRef: refs[endId]!, summary: "s".repeat(400) },
    ],
  });
  const block = res.state.blocks.find((b) => b.active);
  return { res, blockIds: block ? [...block.effectiveMessageIds] : [] };
}

// Reported shape: one assistant message [thinking(sig)][prose][tool_use],
// model targets the tool loop starting AT the tool_use.
const signedShape = (): SignedCore[] => [
  user("u1"),
  user("ulast"),
  reasoning("ra", "sig-A"),
  asstText("tm"),
  toolCall("ca", "call_A"),
  toolResult("tra", "call_A"),
  reasoning("rb", "sig-B"),
  toolCall("cb", "call_B"),
  toolResult("trb", "call_B"),
];

describe("#4885 signed thinking must fold with its tool_use", () => {
  it("pulls signed thinking + prose into a range starting at the tool_use", () => {
    const { res, blockIds } = fold(signedShape(), "ca", "trb");
    assert.deepEqual(res.result.errors, []);
    // Whole wire-message unit folds: thinking A, its prose, and the burst.
    for (const id of ["ra", "tm", "ca", "tra", "rb", "cb", "trb"]) {
      assert.ok(blockIds.includes(id), `${id} must fold (got ${blockIds})`);
    }
  });

  it("same shape with a redacted_thinking separator", () => {
    const msgs: SignedCore[] = [
      user("u1"),
      user("ulast"),
      reasoning("ra", "sig-A"),
      redacted("red"),
      toolCall("ca", "call_A"),
      toolResult("tra", "call_A"),
      reasoning("rb", "sig-B"),
      toolCall("cb", "call_B"),
      toolResult("trb", "call_B"),
    ];
    const { res, blockIds } = fold(msgs, "ca", "trb");
    assert.deepEqual(res.result.errors, []);
    for (const id of ["ra", "red", "ca", "tra"]) {
      assert.ok(blockIds.includes(id), `${id} must fold (got ${blockIds})`);
    }
  });

  it("pulls multiple signed thinking blocks separated by prose (double run)", () => {
    const msgs: SignedCore[] = [
      user("u1"),
      user("ulast"),
      reasoning("ra1", "sig-A1"),
      asstText("tm"),
      reasoning("ra2", "sig-A2"),
      toolCall("ca", "call_A"),
      toolResult("tra", "call_A"),
    ];
    const { res, blockIds } = fold(msgs, "ca", "tra");
    assert.deepEqual(res.result.errors, []);
    for (const id of ["ra1", "tm", "ra2", "ca", "tra"]) {
      assert.ok(blockIds.includes(id), `${id} must fold (got ${blockIds})`);
    }
  });

  it("unsigned control: prose-separated reasoning stays OUT of the fold (#564)", () => {
    const msgs: SignedCore[] = [
      user("u1"),
      user("ulast"),
      reasoning("ra"),
      asstText("tm"),
      toolCall("ca", "call_A"),
      toolResult("tra", "call_A"),
      reasoning("rb"),
      toolCall("cb", "call_B"),
      toolResult("trb", "call_B"),
    ];
    const { res, blockIds } = fold(msgs, "ca", "trb");
    assert.deepEqual(res.result.errors, []);
    // Adjacent (no prose) reasoning still pulls in — legacy behavior intact.
    assert.ok(blockIds.includes("rb"));
    // Prose-separated unsigned reasoning keeps the #564 directional allowance.
    assert.ok(!blockIds.includes("ra"), "unsigned ra must stay visible");
    assert.ok(!blockIds.includes("tm"), "prose must stay visible");
    assert.ok(blockIds.includes("ca"));
    assert.ok(blockIds.includes("tra"));
  });

  it("signed run folding TOGETHER remains ordinary compression", () => {
    const { res, blockIds } = fold(signedShape(), "ra", "trb");
    assert.deepEqual(res.result.errors, []);
    for (const id of ["ra", "tm", "ca", "tra", "rb", "cb", "trb"]) {
      assert.ok(blockIds.includes(id), `${id} must fold (got ${blockIds})`);
    }
  });
});

describe("#4885 INV3 gate (computeIntegrityWithdrawals)", () => {
  const unit = (): SignedCore[] => [
    reasoning("ra", "sig-A"),
    asstText("tm"),
    toolCall("ca", "call_A"),
    toolResult("tra", "call_A"),
    user("u9"),
  ];

  it("withdraws a partially folded signed run wholesale", () => {
    const { withdrawn, splitTurnCount } = computeIntegrityWithdrawals(
      unit(),
      new Set(["ca", "tra"]),
    );
    for (const id of ["ra", "tm", "ca", "tra"]) {
      assert.ok(withdrawn.has(id), `${id} must be withdrawn`);
    }
    assert.ok(splitTurnCount >= 1);
  });

  it("leaves a fully folded signed run alone (ordinary compression)", () => {
    const { withdrawn } = computeIntegrityWithdrawals(
      unit(),
      new Set(["ra", "tm", "ca", "tra"]),
    );
    assert.equal(withdrawn.size, 0);
  });

  it("re-checks a signed run after INV2 withdraws its call (fixpoint)", () => {
    const msgs: SignedCore[] = [
      reasoning("ra", "sig-A"),
      toolCall("ca", "call_A"),
      toolResult("tra", "call_A"),
      user("u9"),
    ];
    // Fold covers thinking + call but NOT the result: INV2 must withdraw
    // the call first, and the NEXT fixpoint iteration must catch the now
    // partially folded signed run and withdraw the thinking too — a
    // signature is never folded alone.
    const { withdrawn } = computeIntegrityWithdrawals(
      msgs,
      new Set(["ra", "ca"]),
    );
    assert.ok(withdrawn.has("ca"), "call withdrawn (split pair)");
    assert.ok(withdrawn.has("tra"), "result recorded with its pair");
    assert.ok(withdrawn.has("ra"), "thinking withdrawn on re-check");
  });

  it("keeps the #564 reverse split allowed for UNSIGNED runs", () => {
    const unsigned: SignedCore[] = [
      reasoning("ra"),
      asstText("tm"),
      toolCall("ca", "call_A"),
      toolResult("tra", "call_A"),
      user("u9"),
    ];
    const { withdrawn } = computeIntegrityWithdrawals(
      unsigned,
      new Set(["ca", "tra"]),
    );
    assert.equal(withdrawn.size, 0);
  });

  it("isSignedThinkingFamily: signature and redacted sidecar only", () => {
    assert.ok(isSignedThinkingFamily(reasoning("a", "sig")));
    assert.ok(isSignedThinkingFamily(redacted("r")));
    assert.ok(!isSignedThinkingFamily(reasoning("plain")));
    assert.ok(
      !isSignedThinkingFamily({
        id: "oe",
        role: "assistant",
        contentType: "reasoning",
        text: "cot",
        // OpenAI reasoning_content echo lane: unsigned by definition.
        reasoningContent: "x",
      }),
    );
    assert.ok(!isSignedThinkingFamily(asstText("t")));
  });
});
