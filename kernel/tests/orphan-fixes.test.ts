import { test } from "node:test";
import assert from "node:assert/strict";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { prune, SUMMARY_HEADER } from "../src/prune.js";
import { computeProtectedRefs } from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import type {
  Config,
  CoreMessage,
  CompressionState,
  CompressionBlock,
} from "../src/types.js";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.9,
      minContextLimitPct: 0.45,
      frequency: 1,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

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

function makeMessages(n: number): CoreMessage[] {
  const msgs: CoreMessage[] = [];
  for (let i = 0; i < n; i++) {
    msgs.push({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      contentType: "text",
      text: `Message ${i}`,
    });
  }
  return msgs;
}

// ─── Bug 1: hideConsumedCompressCalls orphan ──────────────────────────────────

test("hideConsumedCompressCalls: hides BOTH tool-call AND tool-result for consumed compress blocks", () => {
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "hi" },
    {
      id: "a1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-old",
      text: '{"content":[{"startId":"m0","endId":"m2","summary":"old"}]}',
    },
    {
      id: "a1r",
      role: "user",
      contentType: "tool-result",
      toolName: "compress",
      toolCallId: "call-old",
      text: "Compressed",
    },
    { id: "u2", role: "user", contentType: "text", text: "next" },
  ];

  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      makeBlock({
        blockId: "b0",
        active: false,
        compressCallId: "call-old",
      }),
    ],
  };

  const result = hideConsumedCompressCalls(state, messages);

  assert.equal(result.hidden, 2, "should hide both tool-call and tool-result");
  assert.equal(result.messages.length, 2, "only user text messages remain");
  const ids = result.messages.map((m) => m.id);
  assert.ok(ids.includes("u1"), "first user message kept");
  assert.ok(ids.includes("u2"), "second user message kept");
  assert.ok(!ids.includes("a1"), "compress tool-call hidden");
  assert.ok(!ids.includes("a1r"), "compress tool-result hidden");
});

test("hideConsumedCompressCalls: keeps tool-call AND tool-result for active compress blocks", () => {
  const messages: CoreMessage[] = [
    { id: "u1", role: "user", contentType: "text", text: "hi" },
    {
      id: "a1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-active",
      text: '{"content":[{"startId":"m0","endId":"m2","summary":"active"}]}',
    },
    {
      id: "a1r",
      role: "user",
      contentType: "tool-result",
      toolName: "compress",
      toolCallId: "call-active",
      text: "Compressed",
    },
  ];

  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      makeBlock({
        blockId: "b0",
        active: true,
        compressCallId: "call-active",
      }),
    ],
  };

  const result = hideConsumedCompressCalls(state, messages);

  assert.equal(result.hidden, 0, "nothing hidden for active blocks");
  assert.equal(result.messages.length, 3, "all messages kept");
});

// ─── Bug 2: prune stripOrphanedToolResults ────────────────────────────────────

test("prune: strips orphaned tool-result when tool-call is in compression range", () => {
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: "start" },
    { id: "a0", role: "assistant", contentType: "text", text: "ok" },
    { id: "u1", role: "user", contentType: "text", text: "read file" },
    {
      id: "a1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "read",
      toolCallId: "call-1",
      text: '{"path":"foo.ts"}',
    },
    {
      id: "a1r",
      role: "user",
      contentType: "tool-result",
      toolName: "read",
      toolCallId: "call-1",
      text: "file contents here",
    },
    { id: "u2", role: "user", contentType: "text", text: "next task" },
  ];

  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      makeBlock({
        blockId: "b0",
        effectiveMessageIds: ["u1", "a1"],
        directMessageIds: ["u1", "a1"],
      }),
    ],
  };

  const result = prune(messages, state);

  const resultIds = result.map((m) => m.id);
  assert.ok(!resultIds.includes("a1"), "tool-call in range should be pruned");
  assert.ok(
    !resultIds.includes("a1r"),
    "orphaned tool-result should be stripped",
  );
  assert.ok(resultIds.includes("u0"), "first user message preserved");
  assert.ok(resultIds.includes("u2"), "message after range preserved");
});

test("prune: keeps tool-result when tool-call is OUTSIDE compression range", () => {
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: "start" },
    { id: "a0", role: "assistant", contentType: "text", text: "ok" },
    {
      id: "a1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "read",
      toolCallId: "call-1",
      text: '{"path":"foo.ts"}',
    },
    {
      id: "a1r",
      role: "user",
      contentType: "tool-result",
      toolName: "read",
      toolCallId: "call-1",
      text: "file contents",
    },
  ];

  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      makeBlock({
        blockId: "b0",
        effectiveMessageIds: ["u0"],
        directMessageIds: ["u0"],
      }),
    ],
  };

  const result = prune(messages, state);

  const resultIds = result.map((m) => m.id);
  assert.ok(resultIds.includes("a1"), "tool-call kept (not in range)");
  assert.ok(resultIds.includes("a1r"), "tool-result kept (not orphaned)");
});

// ─── Protection tests ─────────────────────────────────────────────────────────

test("computeProtectedRefs: last visible user message is protected when preserveRecentMessages > 0", () => {
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: "first user" },
    ...makeMessages(20),
    {
      id: "uLast",
      role: "user",
      contentType: "text",
      text: "most recent user",
    },
    { id: "a1", role: "assistant", contentType: "text", text: "reply" },
    { id: "a2", role: "assistant", contentType: "text", text: "reply2" },
  ];

  const state: CompressionState = {
    ...createInitialState(),
    blocks: [],
    messageRefs: {
      byRaw: { u0: "m00001", uLast: "m00024", a1: "m00025", a2: "m00026" },
      byRef: {
        m00001: "u0",
        m00024: "uLast",
        m00025: "a1",
        m00026: "a2",
      },
      nextNum: 27,
    },
  };

  // Rule 3 follows preserveRecentMessages: with it > 0 the last user message
  // is protected regardless of distance from the tail.
  const config = buildConfig({
    preserveRecentMessages: 5,
    preserveRecentTokens: 0,
  });

  const protected_ = computeProtectedRefs(messages, state, config);

  assert.ok(
    protected_.has("m00024"),
    "last user message is protected when preserveRecentMessages > 0",
  );
});

test("computeProtectedRefs: first user message also gets protected by token zone when close", () => {
  const messages: CoreMessage[] = [
    { id: "u0", role: "user", contentType: "text", text: "first" },
    { id: "a0", role: "assistant", contentType: "text", text: "reply" },
  ];

  const state: CompressionState = {
    ...createInitialState(),
    blocks: [],
    messageRefs: {
      byRaw: { u0: "m00001", a0: "m00002" },
      byRef: { m00001: "u0", m00002: "a0" },
      nextNum: 3,
    },
  };

  const config = buildConfig({ preserveRecentTokens: 5000 });

  const protected_ = computeProtectedRefs(messages, state, config);

  assert.ok(protected_.has("m00001"), "first user message protected");
  assert.ok(protected_.has("m00002"), "assistant message protected");
});

test("prune: first user message pruned when covered (no duplication)", () => {
  const messages: CoreMessage[] = [
    {
      id: "u0",
      role: "user",
      contentType: "text",
      text: "critical first prompt",
    },
    { id: "a0", role: "assistant", contentType: "text", text: "reply" },
    { id: "u1", role: "user", contentType: "text", text: "second" },
    { id: "a1", role: "assistant", contentType: "text", text: "reply2" },
  ];

  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      makeBlock({
        blockId: "b0",
        effectiveMessageIds: ["u0", "a0", "u1"],
        directMessageIds: ["u0", "a0", "u1"],
      }),
    ],
  };

  const result = prune(messages, state);

  const resultIds = result.map((m) => m.id);
  assert.ok(
    resultIds.includes("u0"),
    "first user message always survives (even when covered — some providers reject 0-user)",
  );
  assert.ok(!resultIds.includes("a0"), "covered assistant message is pruned");
  assert.ok(!resultIds.includes("u1"), "covered second user message is pruned");
  assert.ok(
    resultIds.some((id) => id.startsWith("acp_summary_")),
    "summary is inserted",
  );
});
