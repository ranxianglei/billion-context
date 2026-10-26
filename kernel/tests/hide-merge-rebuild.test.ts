import { test } from "node:test";
import assert from "node:assert/strict";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { rebuildCompressionState } from "../src/rebuild.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

function block(overrides: Partial<CompressionBlock>): CompressionBlock {
  return {
    blockId: "b0",
    runId: "r0",
    tier: 1,
    summary: "summary",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 1000,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("hideConsumedCompressCalls keeps active-block calls and orphans until a fold (#3769)", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({ blockId: "b1", compressCallId: "call-active", active: true }),
    ],
  };
  const messages: CoreMessage[] = [
    {
      id: "m1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-active",
      text: "{}",
    },
    {
      id: "m2",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-consumed",
      text: "{}",
    },
    {
      id: "m3",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-orphan1",
      text: "{}",
    },
    {
      id: "m4",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-orphan2",
      text: "{}",
    },
    { id: "m5", role: "user", contentType: "text", text: "hello" },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(result.hidden, 0, "no fold pending -> nothing swept (#3769)");
  const remainingCallIds = result.messages
    .filter((m) => m.toolName === "compress")
    .map((m) => m.toolCallId);
  assert.ok(remainingCallIds.includes("call-active"), "active carrier kept");
  assert.ok(
    remainingCallIds.includes("call-consumed"),
    "orphan stays visible between folds",
  );
  assert.ok(remainingCallIds.includes("call-orphan1"));
  assert.ok(remainingCallIds.includes("call-orphan2"));
  assert.ok(result.messages.some((m) => m.text === "hello"));
});

test("orphan residue is swept onto a committed fold, not rotated on quiet turns (#3769)", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({ blockId: "b1", compressCallId: "call-active", active: true }),
    ],
  };
  const messages: CoreMessage[] = [
    {
      id: "m1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-active",
      text: "{}",
    },
  ];
  for (let i = 1; i <= 12; i++) {
    messages.push({
      id: `c${i}`,
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: `call-fail${i}`,
      text: "{}",
    });
    messages.push({
      id: `r${i}`,
      role: "user",
      contentType: "tool-result",
      toolName: "compress",
      toolCallId: `call-fail${i}`,
      text: "nothing to compress",
    });
  }
  messages.push({
    id: "mend",
    role: "user",
    contentType: "text",
    text: "tail",
  });

  messages.forEach((m, i) => {
    state.messageRefs.byRaw[m.id] = `m${String(i + 1).padStart(5, "0")}`;
  });
  state.pendingOrphanSweepMinRef = 10;

  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(
    result.hidden,
    16,
    "orphans at/after fold start (ref 10) swept; before it kept (#3769)",
  );
  assert.deepEqual(result.newlySweptCallIds, [
    "call-fail5",
    "call-fail6",
    "call-fail7",
    "call-fail8",
    "call-fail9",
    "call-fail10",
    "call-fail11",
    "call-fail12",
  ]);
  const remainingCallIds = result.messages
    .filter((m) => m.toolName === "compress" && m.contentType === "tool-call")
    .map((m) => m.toolCallId);
  assert.deepEqual(remainingCallIds, [
    "call-active",
    "call-fail1",
    "call-fail2",
    "call-fail3",
    "call-fail4",
  ]);
});

test("a failed compress call and its result stay visible (issue #9 fixed-point precondition removed)", () => {
  const state: CompressionState = { ...createInitialState(), blocks: [] };
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "q" },
    {
      id: "m2",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-fail",
      text: "{}",
    },
    {
      id: "m3",
      role: "user",
      contentType: "tool-result",
      toolName: "compress",
      toolCallId: "call-fail",
      text: "Requested range(s) already compressed; nothing to do",
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(result.hidden, 0);
  assert.ok(
    result.messages.some(
      (m) => m.toolCallId === "call-fail" && m.contentType === "tool-call",
    ),
  );
  assert.ok(
    result.messages.some(
      (m) => m.toolCallId === "call-fail" && m.contentType === "tool-result",
    ),
  );
});

test("rebuildCompressionState replays historical compress tool calls", () => {
  const compressInput = JSON.stringify({
    content: [
      {
        startId: "m00001",
        endId: "m00002",
        summary: "rebuilt summary of early talk",
        topic: "intro",
      },
    ],
  });
  const messages: CoreMessage[] = [
    {
      id: "raw1",
      role: "user",
      contentType: "text",
      text: "first message content",
    },
    {
      id: "raw2",
      role: "assistant",
      contentType: "text",
      text: "second message content",
    },
    {
      id: "raw3",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call1",
      text: compressInput,
    },
    { id: "raw4", role: "user", contentType: "text", text: "later message" },
  ];
  const config = defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  });
  const result = rebuildCompressionState(
    createInitialState(),
    messages,
    config,
  );
  assert.ok(result.blocksRebuilt >= 1);
  const rebuiltBlock = result.state.blocks.find((b) =>
    b.summary.includes("rebuilt summary"),
  );
  assert.ok(rebuiltBlock);
  assert.equal(rebuiltBlock!.compressCallId, "call1");
  assert.ok(result.state.messageRefs.byRaw["raw1"]);
});

test("rebuildCompressionState returns zero blocks when no compress calls exist", () => {
  const messages: CoreMessage[] = [
    { id: "raw1", role: "user", contentType: "text", text: "plain" },
  ];
  const result = rebuildCompressionState(
    createInitialState(),
    messages,
    defaultConfig(200000, {
      preserveRecentMessages: 0,
      preserveRecentTokens: 0,
    }),
  );
  assert.equal(result.blocksRebuilt, 0);
});

function compressInput(
  entries: Array<{ startId: string; endId: string; summary: string }>,
): string {
  return JSON.stringify({ content: entries });
}

function parseContent(
  text: string | undefined,
): Array<{ startId?: string; endId?: string; summary?: string }> {
  return (
    (
      JSON.parse(text ?? "{}") as {
        content?: Array<{ startId?: string; endId?: string; summary?: string }>;
      }
    ).content ?? []
  );
}

test("batched compress: rewrites kept call to drop consumed sibling entries (issue #288)", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b5",
        compressCallId: "call-batch",
        active: true,
        startRef: "m5",
        endRef: "m6",
      }),
      block({
        blockId: "b8",
        compressCallId: "call-batch",
        active: false,
        startRef: "m8",
        endRef: "m9",
      }),
    ],
  };
  const messages: CoreMessage[] = [
    {
      id: "mc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-batch",
      text: compressInput([
        { startId: "m5", endId: "m6", summary: "live entry summary" },
        { startId: "m8", endId: "m9", summary: "consumed entry summary" },
      ]),
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(result.hidden, 0, "kept batch is not removed");
  const kept = result.messages.find((m) => m.toolCallId === "call-batch");
  assert.ok(kept, "batch call survives (one live sibling)");
  const content = parseContent(kept!.text);
  assert.equal(
    content.length,
    1,
    "consumed entry dropped, live entry retained",
  );
  assert.equal(content[0]!.startId, "m5");
  assert.equal(content[0]!.summary, "live entry summary");
});

test("batched compress: no rewrite when all sibling blocks are live", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b5",
        compressCallId: "call-batch",
        active: true,
        startRef: "m5",
        endRef: "m6",
      }),
      block({
        blockId: "b8",
        compressCallId: "call-batch",
        active: true,
        startRef: "m8",
        endRef: "m9",
      }),
    ],
  };
  const originalText = compressInput([
    { startId: "m5", endId: "m6", summary: "S1" },
    { startId: "m8", endId: "m9", summary: "S2" },
  ]);
  const messages: CoreMessage[] = [
    {
      id: "mc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-batch",
      text: originalText,
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(result.hidden, 0);
  const kept = result.messages.find((m) => m.toolCallId === "call-batch")!;
  assert.equal(
    kept.text,
    originalText,
    "byte-identical: rewrite path did not fire/re-serialize",
  );
  assert.equal(parseContent(kept.text).length, 2, "both live entries retained");
});

test("batched compress: fully removed when all sibling blocks consumed", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b5",
        compressCallId: "call-batch",
        active: false,
        startRef: "m5",
        endRef: "m6",
      }),
      block({
        blockId: "b8",
        compressCallId: "call-batch",
        active: false,
        startRef: "m8",
        endRef: "m9",
      }),
    ],
  };
  const messages: CoreMessage[] = [
    {
      id: "mc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-batch",
      text: compressInput([
        { startId: "m5", endId: "m6", summary: "S1" },
        { startId: "m8", endId: "m9", summary: "S2" },
      ]),
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(result.hidden, 1, "fully-consumed batch removed");
  assert.equal(
    result.messages.find((m) => m.toolCallId === "call-batch"),
    undefined,
  );
});

test("batched compress: legacy live block (no startRef/endRef) keeps whole part intact", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b5",
        compressCallId: "call-batch",
        active: true,
        startRef: "m5",
        endRef: "m6",
      }),
      block({ blockId: "b8", compressCallId: "call-batch", active: true }),
    ],
  };
  const messages: CoreMessage[] = [
    {
      id: "mc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-batch",
      text: compressInput([
        { startId: "m5", endId: "m6", summary: "S1" },
        { startId: "m8", endId: "m9", summary: "S2" },
      ]),
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(result.hidden, 0);
  const kept = result.messages.find((m) => m.toolCallId === "call-batch")!;
  assert.equal(
    parseContent(kept.text).length,
    2,
    "legacy live block → no rewrite, all entries kept",
  );
});

test("batched compress: message-mode entry matched via messageId fallback", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b1",
        compressCallId: "call-batch",
        active: true,
        startRef: "msg-3",
        endRef: "msg-3",
      }),
      block({
        blockId: "b2",
        compressCallId: "call-batch",
        active: false,
        startRef: "msg-7",
        endRef: "msg-7",
      }),
    ],
  };
  const messages: CoreMessage[] = [
    {
      id: "mc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-batch",
      text: JSON.stringify({
        content: [
          { messageId: "msg-3", summary: "live message-mode summary" },
          { messageId: "msg-7", summary: "consumed message-mode summary" },
        ],
      }),
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(result.hidden, 0);
  const kept = result.messages.find((m) => m.toolCallId === "call-batch")!;
  const content = parseContent(kept.text) as Array<{
    messageId?: string;
    summary?: string;
  }>;
  assert.equal(content.length, 1, "consumed message-mode entry dropped");
  assert.equal(content[0]!.messageId, "msg-3");
  assert.equal(content[0]!.summary, "live message-mode summary");
});

test("batched compress: matching-miss keeps original message intact (no data loss)", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b1",
        compressCallId: "call-batch",
        active: true,
        startRef: "m5",
        endRef: "m6",
      }),
    ],
  };
  const originalText = compressInput([
    { startId: "mx", endId: "my", summary: "unmatched entry" },
    { startId: "mz", endId: "mw", summary: "another unmatched" },
  ]);
  const messages: CoreMessage[] = [
    {
      id: "mc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-batch",
      text: originalText,
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(result.hidden, 0);
  const kept = result.messages.find((m) => m.toolCallId === "call-batch")!;
  assert.equal(
    kept.text,
    originalText,
    "no entries matched live keys → message preserved verbatim",
  );
});

test("batched compress: rewritten batch keeps its tool-result message", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b5",
        compressCallId: "call-batch",
        active: true,
        startRef: "m5",
        endRef: "m6",
      }),
      block({
        blockId: "b8",
        compressCallId: "call-batch",
        active: false,
        startRef: "m8",
        endRef: "m9",
      }),
    ],
  };
  const messages: CoreMessage[] = [
    {
      id: "mc",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-batch",
      text: compressInput([
        { startId: "m5", endId: "m6", summary: "S1" },
        { startId: "m8", endId: "m9", summary: "S2" },
      ]),
    },
    {
      id: "mc-result",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "call-batch",
      text: '{"ok":true}',
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  assert.equal(
    result.hidden,
    0,
    "neither tool-call nor tool-result removed on a kept/rewritten batch",
  );
  assert.ok(
    result.messages.find((m) => m.id === "mc"),
    "rewritten tool-call survives",
  );
  assert.ok(
    result.messages.find((m) => m.id === "mc-result"),
    "tool-result for kept callId survives",
  );
  const kept = result.messages.find((m) => m.id === "mc")!;
  assert.equal(
    parseContent(kept.text).length,
    1,
    "tool-call text rewritten to drop consumed entry",
  );
});
