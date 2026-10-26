import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultConfig } from "../src/config.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolCall(
  id: string,
  toolName: string,
  callId: string,
  args: string,
): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    toolCallId: callId,
    text: args,
  };
}

function toolResult(id: string, callId: string, text: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolCallId: callId,
    text,
  };
}

function setupRefs(messages: CoreMessage[]) {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

const longText = "x".repeat(6000);
const validSummary =
  "A meaningful summary that captures the key information of the compressed range including file paths and decisions.";

function cfg(overrides: Partial<Config> = {}): Config {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    ...overrides,
  });
}

test("Feature 2: protected tool-call is excluded from compression range", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "skill", "call1", '{"name":"git-master"}'),
    toolResult("c", "call1", "skill output"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ protectedTools: ["skill"] });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  assert.equal(result.result.blocksCreated, 1);
  assert.equal(result.result.errors.length, 0);

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "tool-call 'b' should be excluded",
  );
  assert.ok(
    !block.directMessageIds.includes("c"),
    "tool-result 'c' should be excluded",
  );
  assert.ok(
    block.directMessageIds.includes("a"),
    "regular msg 'a' should remain",
  );
  assert.ok(
    block.directMessageIds.includes("d"),
    "regular msg 'd' should remain",
  );
  // Bug 39 regression: effectiveMessageIds must also exclude protected tool
  // messages, otherwise the block would mark them as covered and hide them.
  assert.ok(
    !block.effectiveMessageIds.includes("b"),
    "tool-call 'b' excluded from effective coverage",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("c"),
    "tool-result 'c' excluded from effective coverage",
  );
  assert.ok(
    block.effectiveMessageIds.includes("a"),
    "regular msg 'a' in effective coverage",
  );
  assert.ok(
    block.effectiveMessageIds.includes("d"),
    "regular msg 'd' in effective coverage",
  );
});

test("Feature 2: protected tool messages are filtered out, not appended", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "skill", "call1", '{"name":"git-master"}'),
    toolResult("c", "call1", "skill output"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ protectedTools: ["skill"] });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "protected skill tool-call excluded from compressed set",
  );
  assert.ok(
    !block.directMessageIds.includes("c"),
    "protected skill tool-result excluded",
  );
  // Bug 39 regression: effectiveMessageIds must match directMessageIds here
  // (no consumed blocks), so protected messages are excluded from both.
  assert.ok(
    !block.effectiveMessageIds.includes("b"),
    "protected skill tool-call excluded from effective coverage",
  );
  assert.ok(
    !block.effectiveMessageIds.includes("c"),
    "protected skill tool-result excluded from effective coverage",
  );
  assert.ok(
    !block.summary.includes("Protected:"),
    "no protected content folded into summary",
  );
  assert.ok(
    !block.summary.includes('{"name":"git-master"}'),
    "protected tool content not leaked into summary",
  );
  assert.equal(
    block.summary,
    validSummary,
    "summary is exactly what the author wrote",
  );
});

test("Feature 2: non-protected tool-call is NOT excluded", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "bash", "call1", '{"command":"ls"}'),
    toolResult("c", "call1", "file1\nfile2"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ protectedTools: ["skill"] });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    block.directMessageIds.includes("b"),
    "non-protected bash tool-call should be compressed",
  );
  assert.ok(
    block.directMessageIds.includes("c"),
    "non-protected bash tool-result should be compressed",
  );
  assert.ok(
    !block.summary.includes("Protected:"),
    "no protected content appended for non-protected tools",
  );
});

test("Feature 2: compress tool itself is always protected", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall(
      "b",
      "compress",
      "call1",
      '{"content":[{"startId":"m00001","endId":"m00001","summary":"test"}]}',
    ),
    toolResult("c", "call1", "compressed"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ protectedTools: ["compress"] });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "compress tool-call should be excluded",
  );
  assert.ok(
    !block.directMessageIds.includes("c"),
    "compress tool-result should be excluded",
  );
});

test("Feature 3: isToolProtected custom predicate excludes matching tools", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "write", "call1", '{"path":"/secret/.env"}'),
    toolResult("c", "call1", "written"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({
    protectedTools: [],
    isToolProtected: (toolName, toolInputText) => {
      if (toolName === "write" && toolInputText?.includes(".env")) return true;
      return false;
    },
  });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "write to .env should be excluded by predicate",
  );
  assert.ok(
    !block.directMessageIds.includes("c"),
    "write result should be excluded too",
  );
  assert.ok(
    !block.summary.includes("Protected:"),
    "no protected content folded into summary",
  );
});

test("Feature 3: wildcard pattern in protectedTools works", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "skill-git-master", "call1", "{}"),
    toolResult("c", "call1", "done"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ protectedTools: ["skill-*"] });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "skill-* pattern should match skill-git-master",
  );
});

test("Feature 3: predicate returning false does not protect", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "bash", "call1", '{"command":"ls"}'),
    toolResult("c", "call1", "output"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({
    protectedTools: [],
    isToolProtected: () => false,
  });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    block.directMessageIds.includes("b"),
    "predicate=false should not protect",
  );
});

test("Feature 2+3: both protectedTools and isToolProtected work together", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "skill", "call1", "{}"),
    toolResult("c", "call1", "skill out"),
    toolCall("d", "edit", "call2", '{"path":"secrets/key.pem"}'),
    toolResult("e", "call2", "edited"),
    msg("f", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({
    protectedTools: ["skill"],
    isToolProtected: (name, input) =>
      name === "edit" && !!input?.includes(".pem"),
  });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00006", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "skill excluded by protectedTools",
  );
  assert.ok(!block.directMessageIds.includes("c"), "skill result excluded");
  assert.ok(
    !block.directMessageIds.includes("d"),
    "edit excluded by predicate",
  );
  assert.ok(!block.directMessageIds.includes("e"), "edit result excluded");
  assert.ok(block.directMessageIds.includes("a"), "regular msg remains");
  assert.ok(block.directMessageIds.includes("f"), "regular msg remains");
  assert.ok(
    !block.summary.includes("Protected: skill"),
    "skill content NOT folded into summary",
  );
  assert.ok(
    !block.summary.includes("Protected: edit"),
    "edit content NOT folded into summary",
  );
});

test("compress tool is ALWAYS protected, even with empty protectedTools", () => {
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall(
      "b",
      "compress",
      "call1",
      JSON.stringify({
        content: [
          { startId: "m00001", endId: "m00001", summary: "x".repeat(60) },
        ],
      }),
    ),
    toolResult("c", "call1", "compressed"),
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  // No protectedTools configured at all — compress must still be protected.
  const config = cfg({ protectedTools: [] });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "compress tool-call excluded regardless of config",
  );
  assert.ok(
    !block.directMessageIds.includes("c"),
    "compress tool-result excluded regardless of config",
  );
  assert.ok(block.directMessageIds.includes("a"), "regular msg remains");
  assert.ok(block.directMessageIds.includes("d"), "regular msg remains");
});

test("compress tool-result is protected by toolCallId pairing even without toolName", () => {
  // Hosts often project a tool-result with only toolCallId (no toolName).
  // The result half of a compress call must still be protected via pairing.
  const core = createCore();
  const messages = [
    msg("a", longText),
    toolCall("b", "compress", "callX", "{}"),
    {
      id: "c",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "callX",
      text: "result".repeat(50),
    },
    msg("d", longText),
  ];
  const state = setupRefs(messages);
  const config = cfg({ protectedTools: [] });

  const result = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00004", summary: validSummary }],
    messages,
    state,
    config,
  });

  const block = result.state.blocks[0]!;
  assert.ok(
    !block.directMessageIds.includes("b"),
    "compress tool-call excluded",
  );
  assert.ok(
    !block.directMessageIds.includes("c"),
    "compress tool-result (no toolName) excluded via pairing",
  );
  assert.ok(block.directMessageIds.includes("a"), "regular msg remains");
  assert.ok(block.directMessageIds.includes("d"), "regular msg remains");
});
