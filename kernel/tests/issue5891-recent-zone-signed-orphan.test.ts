import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CoreMessage } from "../src/types.js";

// #5891: a signed reasoning run whose companion Read tool-call/result sits
// outside the recent zone (neverPreserveRecentTools) may be folded while the
// signature-verified thinking stays visible — the orphan desynchronizes the
// signature and every later Anthropic request 400s ("thinking ... blocks
// cannot be modified"). Symptom invariant pinned here: a fold may never take
// the companion act without taking (or withdrawing) the signed run.
type SignedCore = CoreMessage & { thinkingSignature?: string };

const config = () => defaultConfig(100_000);

function buildMessages(): SignedCore[] {
  return [
    {
      id: "u",
      role: "user",
      contentType: "text",
      text: "Read data.log and report record 42",
    },
    {
      id: "th1",
      role: "assistant",
      contentType: "reasoning",
      text: "thinking-a ",
      thinkingSignature: "sig-1",
    },
    {
      id: "c1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "Read",
      toolCallId: "t1",
      text: "{}",
    },
    {
      id: "r1",
      role: "tool",
      contentType: "tool-result",
      toolName: "Read",
      toolCallId: "t1",
      text: "x".repeat(40_000),
    },
    {
      id: "th2",
      role: "assistant",
      contentType: "reasoning",
      text: "thinking-b ",
      thinkingSignature: "sig-2",
    },
    {
      id: "c2",
      role: "assistant",
      contentType: "tool-call",
      toolName: "Grep",
      toolCallId: "t2",
      text: "{}",
    },
    {
      id: "r2",
      role: "tool",
      contentType: "tool-result",
      toolName: "Grep",
      toolCallId: "t2",
      text: "42",
    },
  ];
}

function foldRange(startId: string, endId: string) {
  const messages = buildMessages();
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
    ranges: [{ startRef: refs[startId]!, endRef: refs[endId]!, summary: "s".repeat(400) }],
  });
  return res.state.blocks.filter((b) => b.active).map((b) => new Set(b.effectiveMessageIds));
}

function foldFull(
  messages: SignedCore[],
  startId: string,
  endId: string,
  configOverride?: Partial<ReturnType<typeof defaultConfig>["compress"]>,
) {
  const cfg = {
    ...defaultConfig(100_000),
    compress: { ...defaultConfig(100_000).compress, ...configOverride },
  };
  const core = createCore();
  let state = createInitialState();
  state = core.processTurn({
    messages,
    state,
    config: cfg,
    tokenCount: (t) => Math.ceil(t.length / 4),
  }).state;
  const refs = state.messageRefs.byRaw;
  return core.applyCompression({
    state,
    messages,
    config: cfg,
    ranges: [{ startRef: refs[startId]!, endRef: refs[endId]!, summary: "s".repeat(400) }],
  });
}

describe("issue5891 recent-zone signed-thinking orphan", () => {
  it("folding the Read exchange alone must not strand its signed thinking", () => {
    for (const ids of foldRange("c1", "r1")) {
      assert.ok(
        !ids.has("c1") || ids.has("th1"),
        `orphaned signed thinking: block ${[...ids].join(",")} folded c1 without th1`,
      );
    }
  });

  it("a range spanning the signed run plus the exchange must not carve the run out", () => {
    for (const ids of foldRange("th1", "r1")) {
      assert.ok(
        !ids.has("c1") || ids.has("th1"),
        `orphaned signed thinking: block ${[...ids].join(",")} folded c1 without th1`,
      );
    }
  });

  it("a range starting INSIDE the recent zone must not sieve out the signed thinking", () => {
    // 2026-11-11 field report (billion-context#4885 thread, 0.1.213): every
    // 400 followed a compress whose range reached into the recent protected
    // zone, logged as "Excluded N protected message(s) ..." WITHOUT the
    // "Range truncated at that boundary" suffix. That is the
    // firstProtectedIdx === 0 fallthrough: the #3953 truncation is skipped
    // and the per-id sieve keeps the zone-protected signed thinking visible
    // while the unprotected bash pair (built-in neverPreserveRecentTools)
    // folds — orphaning the signature.
    const messages: SignedCore[] = [
      { id: "u0", role: "user", contentType: "text", text: "old task " + "x".repeat(200) },
      { id: "thA", role: "assistant", contentType: "reasoning", text: "plan-a ", thinkingSignature: "sig-A" },
      { id: "cA", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "tA", text: "{}" },
      { id: "rA", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tA", text: "ok " + "r".repeat(200) },
      { id: "thB", role: "assistant", contentType: "reasoning", text: "plan-b ", thinkingSignature: "sig-B" },
      { id: "cB", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "tB", text: "{}" },
      { id: "rB", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "tB", text: "ok " + "r".repeat(40_000) },
    ];
    const res = foldFull(messages, "thB", "rB", { preserveRecentMessages: 3 });
    for (const b of res.state.blocks.filter((x) => x.active)) {
      const ids = new Set(b.effectiveMessageIds);
      assert.ok(
        !ids.has("cB") || ids.has("thB"),
        `orphaned signed thinking: block ${[...ids].join(",")} folded cB without thB (sieve path)`,
      );
    }
    // Non-vacuity: the range folded NOTHING — the degradable split fatal
    // degrades to a "folded nothing" warning (#4521 no-op success), not an
    // error and not a block. The only compressible content in the range is
    // the bash pair, and folding it orphans thB.
    assert.ok(res.state.blocks.length === 0, "expected no block for the sieved range");
    assert.match(res.result.warnings.join(" "), /folded nothing|integrity gate/i);
  });
});
