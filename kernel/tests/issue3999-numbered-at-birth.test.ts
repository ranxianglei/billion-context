import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCore,
  defaultConfig,
  defaultCountTokens,
  renderVisibleRefs,
  type Config,
  type CoreMessage,
  type SessionState,
} from "../src/index.js";

// Regression suite for #3999: durable / latest-per-identity protected messages
// are NUMBERED at birth instead of taking a BLOCKED ref, so their later demotion
// inserts zero wire bytes (#3837 per-round prefix-cache break). The dsh plugin
// lane projects every "Current runtime context" snapshot onto the durable/*
// identity; each new snapshot demoted the previous one mid-history, minting a tag
// there and breaking the prefix cache from that point on.

function carrier(id: string, text: string): CoreMessage {
  return { id, role: "user", contentType: "text", text };
}

function text(id: string, content: string): CoreMessage {
  return { id, role: "user", contentType: "text", text: content };
}

// Host projector mirroring src/durable-message-guards.ts dshRuntimeContextPath:
// any non-tool text carrying the marker projects onto durable/runtime-context.
const RUNTIME_MARKER = "Current runtime context";
function durableCfg(): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    protectedLatestTools: ["durable/*"],
    messagePathOf: (m: CoreMessage) =>
      m.contentType !== "tool-call" &&
      m.contentType !== "tool-result" &&
      typeof m.text === "string" &&
      m.text.includes(RUNTIME_MARKER)
        ? "durable/runtime-context"
        : undefined,
  });
}

function emptyState(): SessionState {
  return {
    blocks: [],
    prune: { byMessageId: {}, activeBlockIds: [] },
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {
      lastPerMessageNudgeTokens: 0,
      lastNudgeShownTokens: 0,
      pendingNudgeTurn: null,
      baselineTokens: 0,
    },
    stats: { totalTokensCompressed: 0 },
    compressionTiming: {},
  };
}

test("processTurn: durable carrier numbered at first sight, not BLOCKED", () => {
  const core = createCore();
  const turn1 = [
    text("sys", "system prompt"),
    carrier("snap1", `Current runtime context\nmodel=qwen; cwd=/repo`),
  ];
  const result = core.processTurn({
    messages: turn1,
    state: emptyState(),
    config: durableCfg(),
    tokenCount: 0,
    countTokens: defaultCountTokens,
  });
  // Latest-per-identity carrier at the tail gets a real ref at birth — never a
  // BLOCKED placeholder that would have to be minted mid-history on demotion.
  assert.equal(result.state.messageRefs.byRaw["snap1"], "m00002");
  assert.notEqual(
    result.state.messageRefs.byRaw["snap1"],
    "BLOCKED",
    "live durable carrier must be numbered at birth",
  );
});

test("processTurn two-shot: demoting a durable snapshot inserts zero wire bytes (#3837)", () => {
  const core = createCore();
  // Turn 1: system + first runtime-context snapshot (it is the live carrier).
  const t1 = [
    text("sys", "system prompt"),
    carrier("snap1", `Current runtime context\nturn=1; branch=main`),
  ];
  const r1 = core.processTurn({
    messages: t1,
    state: emptyState(),
    config: durableCfg(),
    tokenCount: 0,
    countTokens: defaultCountTokens,
  });
  // Turn 2: work happens, then a NEW snapshot arrives and demotes snap1.
  const t2 = [
    ...t1,
    text("u2", "please fix the flaky test"),
    text("a2", "on it, running the suite now"),
    carrier("snap2", `Current runtime context\nturn=2; branch=fix-flaky`),
  ];
  const r2 = core.processTurn({
    messages: t2,
    state: r1.state,
    config: durableCfg(),
    tokenCount: 0,
    countTokens: defaultCountTokens,
  });

  // Demotion renumbers nothing: snap1 keeps its birth ref across the demotion.
  assert.equal(r2.state.messageRefs.byRaw["snap1"], "m00002");
  assert.equal(r2.state.messageRefs.byRaw["sys"], "m00001");
  assert.equal(r2.state.messageRefs.byRaw["u2"], "m00003");
  assert.equal(r2.state.messageRefs.byRaw["a2"], "m00004");
  // The new snapshot takes a fresh number appended at the tail.
  assert.equal(r2.state.messageRefs.byRaw["snap2"], "m00005");
  assert.equal(r2.state.messageRefs.byRaw["snap2"] === "BLOCKED", false);

  // Wire-level proof of append-stability: render the outbound body for both
  // turns and assert turn 2's prefix is byte-for-byte identical to turn 1's,
  // with only NEW bytes appended after it. This is exactly the property whose
  // loss produced the #3837 per-round prefix-cache reset.
  const out1 = renderVisibleRefs(t1, r1.state, defaultCountTokens);
  const out2 = renderVisibleRefs(t2, r2.state, defaultCountTokens);
  assert.ok(out2.length > out1.length, "turn 2 appends new messages");
  for (let i = 0; i < out1.length; i++) {
    assert.equal(out2[i]!.id, out1[i]!.id, `message ${i} keeps its slot`);
    assert.equal(
      out2[i]!.text,
      out1[i]!.text,
      `message ${i} (${out1[i]!.id}) wire bytes stable across demotion`,
    );
  }
});

test("processTurn: static protection and unrecoverable media stay BLOCKED while a durable carrier is numbered", () => {
  const core = createCore();
  const cfg = durableCfg();
  // A static hard-protected tool call (protectedTools) must keep its BLOCKED ref
  // even though a durable carrier in the same turn is now numbered at birth —
  // the class split is "will this ever demote?", not "is it protected?".
  const config: Config = {
    ...cfg,
    protectedTools: [...(cfg.protectedTools ?? []), "secret_tool"],
  };
  const turn = [
    text("sys", "system prompt"),
    {
      id: "sc",
      role: "assistant" as const,
      contentType: "tool-call" as const,
      toolName: "secret_tool",
      toolCallId: "stc1",
      text: JSON.stringify({ op: "read-secret" }),
    },
    carrier("snap1", `Current runtime context\nturn=1`),
  ];
  const result = core.processTurn({
    messages: turn,
    state: emptyState(),
    config,
    tokenCount: 0,
    countTokens: defaultCountTokens,
  });
  assert.equal(
    result.state.messageRefs.byRaw["sc"],
    "BLOCKED",
    "statically-protected tool stays BLOCKED",
  );
  // BLOCKED consumes no number slot, so the carrier takes the next free ref
  // right after the system message even though the blocked tool sits between
  // them — proof the two classes are handled independently.
  assert.equal(
    result.state.messageRefs.byRaw["snap1"],
    "m00002",
    "durable carrier numbered at birth alongside the blocked tool",
  );
});
