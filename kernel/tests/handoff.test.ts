import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "../src/state.js";
import { renderHandoff, renderMessage, matchSession } from "../src/handoff.js";
import type { CompressionBlock, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  role: CoreMessage["role"] = "user",
  text: string = id,
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function makeBlock(
  overrides: Partial<CompressionBlock> & { blockId: string },
): CompressionBlock {
  return {
    runId: "r1",
    tier: 1,
    summary: "summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens: 0,
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("renderMessage renders each content type", () => {
  assert.equal(
    renderMessage({
      id: "a",
      role: "user",
      contentType: "text",
      text: "hello",
    }),
    "hello\n",
  );
  assert.equal(
    renderMessage({
      id: "b",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "t1",
      text: "ls",
    }),
    "`bash(t1)` args: ls\n",
  );
  assert.equal(
    renderMessage({
      id: "c",
      role: "tool",
      contentType: "tool-result",
      toolName: "bash",
      toolCallId: "t1",
      text: "ok",
    }),
    "`bash(t1)` → ok\n",
  );
  assert.equal(
    renderMessage({
      id: "d",
      role: "assistant",
      contentType: "reasoning",
      text: "thinking",
    }),
    "_reasoning_: thinking\n",
  );
  assert.equal(
    renderMessage({ id: "e", role: "user", contentType: "text", text: "" }),
    "_(empty)_",
  );
  assert.equal(
    renderMessage({ id: "f", role: "assistant", contentType: "tool-call" }),
    "`?()` args:\n",
  );
  assert.equal(
    renderMessage({
      id: "g",
      role: "tool",
      contentType: "tool-result",
      toolName: "bash",
    }),
    "`bash()` →\n",
  );
});

test("renderHandoff full view shows every original message", () => {
  const messages = [
    msg("m1", "user", "hello"),
    msg("m2", "assistant", "world"),
  ];
  const state = createInitialState();
  const out = renderHandoff({
    coreMessages: messages,
    state,
    full: true,
    meta: { sessionId: "s1", title: "T" },
  });
  assert.match(out, /## Full conversation \(2 messages\)/);
  assert.match(out, /### user/);
  assert.match(out, /hello/);
  assert.match(out, /### assistant/);
  assert.match(out, /world/);
});

test("renderHandoff folded view injects the block summary and drops the covered message", () => {
  const messages = [
    msg("m1", "user", "hello"),
    msg("m2", "user", "secret-covered"),
    msg("m3", "assistant", "hi"),
  ];
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      summary: "COVERED SUMMARY",
      effectiveMessageIds: ["m2"],
    }),
  );
  const folded = renderHandoff({
    coreMessages: messages,
    state,
    full: false,
    meta: { sessionId: "s1" },
  });
  assert.match(
    folded,
    /## Conversation \(folded view as the model saw it, 3 client messages\)/,
  );
  assert.match(folded, /COVERED SUMMARY/);
  assert.doesNotMatch(folded, /secret-covered/);
  assert.match(folded, /hello/);
  assert.match(folded, /hi/);
  const full = renderHandoff({
    coreMessages: messages,
    state,
    full: true,
    meta: { sessionId: "s1" },
  });
  assert.match(full, /secret-covered/);
});

test("renderHandoff renders metadata bullets in order and omits optionals", () => {
  const messages = [msg("m1", "user", "hi")];
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", summary: "s", effectiveMessageIds: [] }),
  );
  state.blocks.push(
    makeBlock({
      blockId: "b2",
      summary: "s",
      effectiveMessageIds: [],
      active: false,
    }),
  );
  const out = renderHandoff({
    coreMessages: messages,
    state,
    full: true,
    meta: {
      sessionId: "abc",
      title: "My Title",
      label: "my-label",
      contextTokens: 1234,
      extraBullets: ["- requests: 7"],
    },
  });
  assert.match(out, /- title: My Title/);
  assert.match(out, /- label: my-label/);
  assert.match(out, /- session id: abc/);
  assert.match(out, /- requests: 7/);
  assert.match(out, /- last context tokens: ~1234/);
  assert.match(out, /- compression blocks: 2 \(active 1\)/);
  const idxTitle = out.indexOf("- title:");
  const idxLabel = out.indexOf("- label:");
  const idxId = out.indexOf("- session id:");
  const idxReq = out.indexOf("- requests:");
  const idxTok = out.indexOf("- last context tokens:");
  const idxBlocks = out.indexOf("- compression blocks:");
  assert.ok(
    idxTitle < idxLabel &&
      idxLabel < idxId &&
      idxId < idxReq &&
      idxReq < idxTok &&
      idxTok < idxBlocks,
  );
  const noOptional = renderHandoff({
    coreMessages: messages,
    state,
    full: true,
    meta: { sessionId: "abc" },
  });
  assert.doesNotMatch(noOptional, /- label:/);
  assert.doesNotMatch(noOptional, /- last context tokens:/);
  assert.match(noOptional, /- title: \(untitled\)/);
  const zeroTokens = renderHandoff({
    coreMessages: messages,
    state,
    full: true,
    meta: { sessionId: "abc", contextTokens: 0 },
  });
  assert.doesNotMatch(zeroTokens, /- last context tokens:/);
});

test("renderHandoff empty conversation shows a placeholder", () => {
  const out = renderHandoff({
    coreMessages: [],
    state: createInitialState(),
    full: true,
    meta: { sessionId: "s" },
  });
  assert.match(out, /No conversation messages to export\./);
});

test("matchSession matches by exact id, label, and prefix", () => {
  const sessions = [
    { id: "sess-aaa-111", label: "alpha" },
    { id: "sess-bbb-222", label: "beta" },
  ];
  const labelOf = (s: { id: string; label?: string }) => s.label;
  assert.deepEqual(
    matchSession(sessions, "sess-aaa-111", labelOf).map((s) => s.id),
    ["sess-aaa-111"],
  );
  assert.deepEqual(
    matchSession(sessions, "beta", labelOf).map((s) => s.id),
    ["sess-bbb-222"],
  );
  assert.deepEqual(
    matchSession(sessions, "sess-aaa", labelOf).map((s) => s.id),
    ["sess-aaa-111"],
  );
  assert.deepEqual(
    matchSession(sessions, "alpha", labelOf).map((s) => s.id),
    ["sess-aaa-111"],
  );
  assert.deepEqual(
    matchSession(sessions, "alp", labelOf).map((s) => s.id),
    ["sess-aaa-111"],
  );
  assert.deepEqual(
    matchSession(sessions, "sess", labelOf).map((s) => s.id),
    ["sess-aaa-111", "sess-bbb-222"],
  );
  assert.deepEqual(matchSession(sessions, "nope", labelOf), []);
});

test("renderHandoff folded snapshot renders as-is without re-pruning", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b0",
      effectiveMessageIds: ["m1", "m2"],
      directMessageIds: ["m1", "m2"],
    }),
  );
  // Folded persisted snapshot: covered ids already replaced by a summary
  // anchor; ids m1/m2 gone. Re-pruning must not resurrect them.
  const snapshot = [
    msg("m3", "assistant", "hi"),
    msg("m4", "user", "final question"),
  ];
  const out = renderHandoff({
    coreMessages: snapshot,
    state,
    full: false,
    folded: true,
    meta: { sessionId: "s1" },
  });
  assert.match(
    out,
    /## Conversation \(persisted folded snapshot, 2 messages\)/,
  );
  assert.match(out, /final question/);
  assert.doesNotMatch(out, /summary/);
});

test("re-pruning the same snapshot without folded resurrects the summary at index 0", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b0",
      effectiveMessageIds: ["m1", "m2"],
      directMessageIds: ["m1", "m2"],
    }),
  );
  const snapshot = [
    msg("m3", "assistant", "hi"),
    msg("m4", "user", "final question"),
  ];
  const out = renderHandoff({
    coreMessages: snapshot,
    state,
    full: false,
    meta: { sessionId: "s1" },
  });
  assert.match(
    out,
    /## Conversation \(folded view as the model saw it, 2 client messages\)/,
  );
  assert.match(out, /\[Compressed conversation section\]/);
  assert.ok(
    out.indexOf("[Compressed conversation section]") <
      out.indexOf("### assistant"),
    "resurrected summary must land before the first surviving message",
  );
});

test("renderHandoff full+folded appends block originals after the tail", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b0", topic: "investigation", summary: "summary" }),
  );
  const snapshot = [msg("m3", "assistant", "hi")];
  const out = renderHandoff({
    coreMessages: snapshot,
    state,
    full: true,
    folded: true,
    blocksFull: [
      {
        blockId: "b0",
        topic: "investigation",
        count: 7,
        fullText: "hello proxy\n778899",
      },
      { blockId: "b1", count: 2, fullText: "tail content\n\n" },
    ],
    meta: { sessionId: "s1" },
  });
  assert.match(
    out,
    /## Conversation \(persisted folded snapshot, 1 messages\)/,
  );
  assert.match(out, /## Block b0 — investigation/);
  assert.match(out, /### Original messages \(7\)/);
  assert.match(out, /778899/);
  assert.match(out, /^## Block b1$/m);
  assert.doesNotMatch(out, /## Block b1 —/);
  assert.match(out, /### Original messages \(2\)/);
  assert.doesNotMatch(out, /tail content\n\n/);
  assert.ok(
    out.indexOf("## Block b0") > out.indexOf("hi"),
    "blocks must follow the conversation",
  );
});

test("renderHandoff folded flag is ignored for block append when not full", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b0", topic: "t" }));
  const out = renderHandoff({
    coreMessages: [msg("m1", "user", "x")],
    state,
    full: false,
    folded: true,
    blocksFull: [{ blockId: "b0", count: 1, fullText: "ORIGINALS" }],
    meta: { sessionId: "s1" },
  });
  assert.doesNotMatch(out, /ORIGINALS/);
});
