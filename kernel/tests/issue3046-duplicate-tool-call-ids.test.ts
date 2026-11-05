import { test } from "node:test";
import assert from "node:assert/strict";
import { prune } from "../src/prune.js";
import { createInitialState } from "../src/state.js";
import type {
  CoreMessage,
  CompressionState,
  CompressionBlock,
} from "../src/types.js";

// #3046 — the two wire-facing prune guards paired tool calls/results by
// id-SET membership. A set cannot tell two instances apart when a host re-issues
// the same tool-call id for different calls (Agent Teams `name:index` ids), so
// a half-pair whose own partner was folded away survived because a DIFFERENT
// same-id partner was still visible — and the rebuilt request shipped a
// role:"tool" message with no preceding declaration (upstream 400
// "tool_call_id … is not found") or an assistant tool_call with no following
// response ("… did not have response messages"), bricking the session.
//
// These tests pin the ORDER-based pairing: a result needs a same-id call EARLIER
// in the view; a call needs a same-id result LATER. Unique-id sessions behave
// identically to the old set lookup; a single call still answers any number of
// same-id results (precedence is checked, not multiplicity).

function makeBlock(overrides: Partial<CompressionBlock> = {}): CompressionBlock {
  return {
    blockId: "b0",
    runId: "r0",
    tier: 1,
    summary: "Folded.",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

function stateWith(blocks: CompressionBlock[]): CompressionState {
  return { ...createInitialState(), blocks };
}

const text = (id: string): CoreMessage => ({
  id,
  role: "user",
  contentType: "text",
  text: id,
});
const call = (
  id: string,
  toolCallId: string,
  toolName = "send_message",
): CoreMessage => ({
  id,
  role: "assistant",
  contentType: "tool-call",
  toolName,
  toolCallId,
  text: "{}",
});
const result = (
  id: string,
  toolCallId: string,
  toolName = "send_message",
): CoreMessage => ({
  id,
  role: "tool",
  contentType: "tool-result",
  toolName,
  toolCallId,
  text: "ok",
});

/** A rebuilt view is wire-valid iff it carries neither of the two upstream 400
 *  conditions: every tool-result is preceded by an assistant declaring its
 *  tool_call_id, and every non-compress tool-call is followed by a result
 *  answering it (#3046). */
function assertWireValid(messages: CoreMessage[], label: string): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.contentType === "tool-result" && m.toolCallId) {
      const hasPriorCall = messages
        .slice(0, i)
        .some((p) => p.contentType === "tool-call" && p.toolCallId === m.toolCallId);
      assert.ok(
        hasPriorCall,
        `${label}: result ${m.id} (${m.toolCallId}) precedes any call declaring it`,
      );
    }
    if (
      m.contentType === "tool-call" &&
      m.toolCallId &&
      m.toolName !== "compress"
    ) {
      const hasLaterResult = messages
        .slice(i + 1)
        .some((p) => p.contentType === "tool-result" && p.toolCallId === m.toolCallId);
      assert.ok(
        hasLaterResult,
        `${label}: call ${m.id} (${m.toolCallId}) has no following response`,
      );
    }
  }
}

test("primary shape: folding the CALL leaves the stray result orphaned -> stripped", () => {
  // Two send_message:0 calls (host re-issues the id). The fold covers the first
  // call only; its result survives at the earlier position, before the second
  // call declares the id. Set-pairing used to keep that stray result.
  const messages: CoreMessage[] = [
    text("u0"),
    call("a1", "send_message:0"),
    result("a1r", "send_message:0"),
    text("u1"),
    call("a2", "send_message:0"),
    result("a2r", "send_message:0"),
  ];
  const state = stateWith([
    makeBlock({ effectiveMessageIds: ["a1"], directMessageIds: ["a1"] }),
  ]);

  const out = prune(messages, state);
  const ids = out.map((m) => m.id);

  assert.ok(!ids.includes("a1"), "folded call removed");
  assert.ok(
    !ids.includes("a1r"),
    "stray result whose call was folded must be stripped (was shipped unpaired)",
  );
  assert.ok(ids.includes("a2"), "second-instance call kept");
  assert.ok(ids.includes("a2r"), "second-instance result kept");
  assertWireValid(out, "primary");
});

test("mirror shape: folding the RESULT leaves the last call unanswered -> stripped", () => {
  // Same duplicate ids; the fold now covers the LAST result. The second call
  // becomes an assistant tool_call with no following response. Set-pairing used
  // to keep it because an earlier same-id result was still visible.
  const messages: CoreMessage[] = [
    text("u0"),
    call("a1", "send_message:1"),
    result("a1r", "send_message:1"),
    text("u1"),
    call("a2", "send_message:1"),
    result("a2r", "send_message:1"),
  ];
  const state = stateWith([
    makeBlock({ effectiveMessageIds: ["a2r"], directMessageIds: ["a2r"] }),
  ]);

  const out = prune(messages, state);
  const ids = out.map((m) => m.id);

  assert.ok(!ids.includes("a2r"), "folded result removed");
  assert.ok(
    !ids.includes("a2"),
    "unanswered second-instance call must be stripped (was shipped without a response)",
  );
  assert.ok(ids.includes("a1"), "first-instance call kept");
  assert.ok(ids.includes("a1r"), "first-instance result kept");
  assertWireValid(out, "mirror");
});

test("one call with several same-id results stays intact (precedence, not multiplicity)", () => {
  // A single call may legally carry multiple same-id results. Only PRECEDENCE is
  // checked — the extra results must NOT be dropped as if they were orphans.
  const messages: CoreMessage[] = [
    text("u0"),
    call("c1", "list_agents:0"),
    result("o1", "list_agents:0"),
    result("o2", "list_agents:0"),
    text("f9"),
    text("u5"),
  ];
  // Fold a neutral trailing text message so the guards run without touching the
  // pair itself (prune returns early when nothing is covered).
  const state = stateWith([
    makeBlock({ effectiveMessageIds: ["f9"], directMessageIds: ["f9"] }),
  ]);

  const out = prune(messages, state);
  const ids = out.map((m) => m.id);

  assert.ok(ids.includes("c1"), "call kept");
  assert.ok(ids.includes("o1"), "first same-id result kept");
  assert.ok(ids.includes("o2"), "second same-id result kept (not treated as orphan)");
  assertWireValid(out, "many-results");
});

test("a valid duplicate burst survives a fold that does not touch the pairs", () => {
  // Regression net against over-aggressive pairing: when nothing in the visible
  // view is actually orphaned, BOTH duplicate pairs must survive untouched.
  const messages: CoreMessage[] = [
    text("u0"),
    call("a1", "X"),
    result("a1r", "X"),
    text("f1"),
    call("a2", "X"),
    result("a2r", "X"),
    text("uEnd"),
  ];
  const state = stateWith([
    makeBlock({ effectiveMessageIds: ["f1"], directMessageIds: ["f1"] }),
  ]);

  const out = prune(messages, state);
  const ids = out.map((m) => m.id);

  for (const keep of ["a1", "a1r", "a2", "a2r"]) {
    assert.ok(ids.includes(keep), `${keep} must survive (nothing orphaned)`);
  }
  assertWireValid(out, "burst");
});
