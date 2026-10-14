import { test } from "node:test";
import assert from "node:assert/strict";
import { prune } from "../src/prune.js";
import { createInitialState } from "../src/state.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

/**
 * Regression: duplicate tool-call ids defeat id-set pairing in the two
 * defense-in-depth strip guards. A host may re-issue the same tool-call id on a
 * later turn (`name:index` style), so "a call with this id is visible" does not
 * mean "THIS result's call is visible" — the fold only has to cover one of the
 * two instances for a half whose partner is gone to survive, and the outgoing
 * request then violates the upstream pairing contract
 * ("an assistant message with 'tool_calls' must be followed by tool messages
 * responding to each 'tool_call_id'") and the whole turn fails with HTTP 400.
 */

function makeBlock(
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId: "b0",
    runId: "r0",
    tier: 1,
    summary: "Test summary",
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

function stateWith(block: CompressionBlock): CompressionState {
  return { ...createInitialState(), blocks: [block] };
}

function call(id: string, toolCallId: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName: "send_message",
    toolCallId,
    text: "{}",
  };
}

function result(id: string, toolCallId: string): CoreMessage {
  return {
    id,
    role: "user",
    contentType: "tool-result",
    toolName: "send_message",
    toolCallId,
    text: "delivered",
  };
}

function text(id: string, role: CoreMessage["role"]): CoreMessage {
  return { id, role, contentType: "text", text: id };
}

/** Every surviving tool-result must be preceded by a call declaring its id, and
 * every declared id must be answered exactly once. */
function assertPairsOrdered(messages: CoreMessage[]): void {
  const declared = new Map<string, number>();
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId) {
      declared.set(m.toolCallId, (declared.get(m.toolCallId) ?? 0) + 1);
    }
    if (m.contentType === "tool-result" && m.toolCallId) {
      const open = declared.get(m.toolCallId) ?? 0;
      assert.ok(
        open > 0,
        `tool-result ${m.id} (${m.toolCallId}) has no earlier unanswered call`,
      );
      declared.set(m.toolCallId, open - 1);
    }
  }
  for (const [id, open] of declared) {
    assert.equal(open, 0, `call id ${id} left unanswered`);
  }
}

test("duplicate tool-call ids: a result whose own call was folded is stripped even though a same-id call survives", () => {
  const messages: CoreMessage[] = [
    text("u0", "user"),
    call("a1", "send_message:0"),
    result("a1r", "send_message:0"),
    text("u1", "user"),
    call("a2", "send_message:0"),
    result("a2r", "send_message:0"),
  ];
  // The fold covers the FIRST call only: its result stays visible while a
  // second call carrying the same id is still in the request.
  const state = stateWith(
    makeBlock({ effectiveMessageIds: ["a1"], directMessageIds: ["a1"] }),
  );

  const out = prune(messages, state);
  const ids = out.map((m) => m.id);

  assert.ok(!ids.includes("a1"), "covered call is pruned");
  assert.ok(
    !ids.includes("a1r"),
    "result of the covered call is stripped (id-set pairing kept it)",
  );
  assert.ok(ids.includes("a2") && ids.includes("a2r"), "intact pair survives");
  assertPairsOrdered(out);
});

test("duplicate tool-call ids: a call whose own result was folded is stripped even though a same-id result survives", () => {
  const messages: CoreMessage[] = [
    text("u0", "user"),
    result("a0r", "send_message:1"),
    text("u1", "user"),
    call("a1", "send_message:1"),
    result("a1r", "send_message:1"),
  ];
  // The fold covers the LAST result only: the call above it is left without an
  // answer while an earlier result carrying the same id stays visible.
  const state = stateWith(
    makeBlock({ effectiveMessageIds: ["a1r"], directMessageIds: ["a1r"] }),
  );

  const out = prune(messages, state);
  const ids = out.map((m) => m.id);

  assert.ok(!ids.includes("a1r"), "covered result is pruned");
  assert.ok(
    !ids.includes("a0r"),
    "result with no visible call is stripped (id-set pairing kept it)",
  );
  assertPairsOrdered(out);
});

test("duplicate tool-call ids: complete pairs are left untouched", () => {
  const messages: CoreMessage[] = [
    text("u0", "user"),
    call("a1", "send_message:0"),
    result("a1r", "send_message:0"),
    text("u1", "user"),
    call("a2", "send_message:0"),
    result("a2r", "send_message:0"),
  ];
  const state: CompressionState = { ...createInitialState() };

  const out = prune(messages, state);

  assert.deepEqual(
    out.map((m) => m.id),
    messages.map((m) => m.id),
    "no message is dropped or reordered",
  );
  assertPairsOrdered(out);
});
