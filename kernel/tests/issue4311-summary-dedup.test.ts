// #4311: the summary text of a fold reaches the model TWICE — the block's
// acp_summary render AND the originating compress call's arguments (the
// exchange is permanently protected). The fix: when the originating call is
// visible in the view being composed, SKIP the block render (the call is the
// model-visible recap); when it is not (folded away / never existed — system
// folds, forged-summary lanes), keep the render so the summary never
// disappears.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { prune } from "../src/prune.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";

const longText = "x".repeat(6000);
const validSummary =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

function user(id: string, text = longText): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function call(id: string, callId: string, args: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "compress",
    toolCallId: callId,
    text: args,
  };
}

function result(id: string, callId: string, text: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolName: "compress",
    toolCallId: callId,
    text,
  };
}

function cfg(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    protectedTools: ["nomatch-*"],
    ...overrides,
  });
}

const args = JSON.stringify({
  content: [{ startId: "m00001", endId: "m00001", summary: validSummary }],
});

function summaryRenderCount(messages: CoreMessage[]): number {
  return messages.filter((m) => m.id.startsWith("acp_summary_")).length;
}

test("#4311 visible originating call suppresses the block summary render", () => {
  const core = createCore();
  const turn = core.processTurn({
    messages: [user("u1"), user("u2")],
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });
  const startRef = turn.state.messageRefs.byRaw["u1"];
  assert.ok(typeof startRef === "string" && startRef.startsWith("m"));
  const applied = core.applyCompression({
    ranges: [{ startRef, endRef: startRef, summary: validSummary, compressCallId: "call-ok" }],
    messages: [user("u1"), user("u2")],
    state: turn.state,
    config: cfg(),
  });
  assert.equal(applied.result.blocksCreated, 1);
  assert.equal(applied.state.blocks[0]!.compressCallId, "call-ok");

  // The view still carries the originating exchange.
  const view = [
    user("u1"),
    call("sc1", "call-ok", args),
    result("sr1", "call-ok", "[Compressed m00001–m00001 → 1 block(s), ~1234 tokens saved.]"),
    user("u2"),
  ];
  const pruned = prune(view, applied.state, {});
  assert.equal(summaryRenderCount(pruned), 0, "no acp_summary render when the call is visible");
  assert.ok(pruned.some((m) => m.id === "sc1"), "the originating call stays visible");
  assert.ok(pruned.some((m) => m.id === "sr1"), "the receipt stays visible");
});

test("#4311 call gone from the view → render returns (summary never disappears)", () => {
  const core = createCore();
  const turn = core.processTurn({
    messages: [user("u1"), user("u2")],
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });
  const startRef = turn.state.messageRefs.byRaw["u1"];
  const applied = core.applyCompression({
    ranges: [{ startRef, endRef: startRef, summary: validSummary, compressCallId: "call-ok" }],
    messages: [user("u1"), user("u2")],
    state: turn.state,
    config: cfg(),
  });

  // The call+receipt were folded/off-wire (e.g. gateway dropped them).
  const view = [user("u1"), user("u2")];
  const pruned = prune(view, applied.state, {});
  assert.equal(summaryRenderCount(pruned), 1, "the render comes back when the call is gone");
  assert.ok(
    pruned.some((m) => m.id.startsWith("acp_summary_")),
    "the rendered summary is present",
  );
});

test("#4311 block without compressCallId always renders (system/forged lanes)", () => {
  const core = createCore();
  const turn = core.processTurn({
    messages: [user("u1"), user("u2")],
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });
  const startRef = turn.state.messageRefs.byRaw["u1"];
  // No compressCallId: pre-field legacy block / system-authored fold.
  const applied = core.applyCompression({
    ranges: [{ startRef, endRef: startRef, summary: validSummary }],
    messages: [user("u1"), user("u2")],
    state: turn.state,
    config: cfg(),
  });

  const view = [
    user("u1"),
    call("sc1", "call-ok", args),
    result("sr1", "call-ok", "[Compressed m00003–m00004 → 1 block(s), ~1234 tokens saved.]"),
    user("u2"),
  ];
  const pruned = prune(view, applied.state, {});
  assert.equal(summaryRenderCount(pruned), 1, "unrelated visible call never suppresses this block");
});

test("#4311 stale render from a previously-pruned view is dropped, not re-injected", () => {
  const core = createCore();
  const turn = core.processTurn({
    messages: [user("u1"), user("u2")],
    state: createInitialState(),
    config: cfg(),
    tokenCount: 1000,
  });
  const startRef = turn.state.messageRefs.byRaw["u1"];
  const applied = core.applyCompression({
    ranges: [{ startRef, endRef: startRef, summary: validSummary, compressCallId: "call-ok" }],
    messages: [user("u1"), user("u2")],
    state: turn.state,
    config: cfg(),
  });

  // A view that still carries the OLD rendered summary plus the call.
  const view = [
    user("u1"),
    {
      id: `acp_summary_${applied.state.blocks[0]!.blockId}`,
      role: "system",
      contentType: "text",
      text: `[Compressed conversation section] — stale copy`,
    },
    call("sc1", "call-ok", args),
    result("sr1", "call-ok", "[Compressed m00001–m00001 → 1 block(s), ~1234 tokens saved.]"),
    user("u2"),
  ];
  const pruned = prune(view, applied.state, {});
  assert.equal(summaryRenderCount(pruned), 0, "stale render dropped and not re-injected while the call is visible");
});
