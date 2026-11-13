import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCore,
  createInitialState,
  defaultConfig,
  BLOCKED_REF,
} from "../src/index.js";
import type { CoreMessage } from "../src/types.js";

const toolName = "mcp__bili__acp_rule";
const originalArgs = '{"action":"remove","id":"rule1"}';
const longResult = "OLD_RECEIPT_BEGIN " + "long result content ".repeat(1000);
const config = {
  ...defaultConfig(10000),
  preserveRecentMessages: 3,
  isToolProtected: (name: string) => name === toolName,
};

function history(): CoreMessage[] {
  return [
    { id: "user1", role: "user", contentType: "text", text: "Start" },
    {
      id: "call1",
      role: "assistant",
      contentType: "tool-call",
      text: '{"action":"list"}',
      toolCallId: "tc1",
      toolName,
    },
    {
      id: "result1",
      role: "tool",
      contentType: "tool-result",
      text: longResult,
      toolCallId: "tc1",
      toolName,
    },
    {
      id: "call2",
      role: "assistant",
      contentType: "tool-call",
      text: originalArgs,
      toolCallId: "tc2",
      toolName,
    },
    {
      id: "result2",
      role: "tool",
      contentType: "tool-result",
      text: '{"ok":true}',
      toolCallId: "tc2",
      toolName,
    },
    ...Array.from({ length: 6 }, (_, index): CoreMessage => ({
      id: `tail${index}`,
      role: index % 2 ? "assistant" : "user",
      contentType: "text",
      text: `Recent message ${index}`,
    })),
  ];
}

test("#5101: truncating a protected result cannot seed a shared latch or corrupt another call", () => {
  const core = createCore();
  const messages = history();
  const first = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 9800,
    renderTags: "none",
  });
  assert.equal(first.state.messageRefs.byRaw.result1, BLOCKED_REF);
  assert.ok(
    first.messages
      .find((m) => m.id === "result1")!
      .text!.includes("[truncated for context space]"),
  );
  assert.ok(
    !first.state.emergencyTruncateLatch?.some(
      (entry) => entry.ref === BLOCKED_REF,
    ),
  );
  const second = core.processTurn({
    messages,
    state: first.state,
    config,
    tokenCount: 100,
    renderTags: "none",
  });
  assert.equal(
    second.messages.find((m) => m.id === "call2")!.text,
    originalArgs,
  );
  assert.equal(
    second.messages.find((m) => m.id === "result2")!.text,
    '{"ok":true}',
  );
});

for (const tokenCount of [100, 9800]) {
  test(`#5101: discard persisted duplicate BLOCKED entries at tokenCount=${tokenCount}`, () => {
    const core = createCore();
    const messages = history();
    const initial = core.processTurn({
      messages,
      state: createInitialState(),
      config,
      tokenCount: 100,
      renderTags: "none",
    });
    const persisted = JSON.parse(
      JSON.stringify(initial.state),
    ) as typeof initial.state;
    persisted.emergencyTruncateLatch = [
      { ref: BLOCKED_REF, text: "wrong receipt one" },
      { ref: BLOCKED_REF, text: "wrong receipt two" },
    ];
    const turn = core.processTurn({
      messages,
      state: persisted,
      config,
      tokenCount,
      renderTags: "none",
    });
    assert.equal(
      turn.messages.find((m) => m.id === "call2")!.text,
      originalArgs,
    );
    assert.equal(
      turn.messages.find((m) => m.id === "result2")!.text,
      '{"ok":true}',
    );
    assert.ok(
      !turn.state.emergencyTruncateLatch?.some(
        (entry) => entry.ref === BLOCKED_REF,
      ),
    );
  });
}

test("#5101: clean old BLOCKED entries while retaining a valid unique-ref clip", () => {
  const core = createCore();
  const messages = history();
  messages.unshift({
    id: "ordinary-large",
    role: "user",
    contentType: "text",
    text: longResult,
  });
  const initial = core.processTurn({
    messages,
    state: createInitialState(),
    config,
    tokenCount: 100,
    renderTags: "none",
  });
  const ref = initial.state.messageRefs.byRaw["ordinary-large"]!;
  assert.notEqual(ref, BLOCKED_REF);
  initial.state.emergencyTruncateLatch = [
    { ref, text: "valid unique clip" },
    { ref: BLOCKED_REF, text: "wrong shared clip" },
  ];
  const turn = core.processTurn({
    messages,
    state: initial.state,
    config,
    tokenCount: 100,
    renderTags: "none",
  });
  assert.equal(
    turn.messages.find((m) => m.id === "ordinary-large")!.text,
    "valid unique clip",
  );
  assert.equal(turn.messages.find((m) => m.id === "call2")!.text, originalArgs);
  assert.deepEqual(turn.state.emergencyTruncateLatch, [
    { ref, text: "valid unique clip" },
  ]);
});
