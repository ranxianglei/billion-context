import { test } from "node:test";
import assert from "node:assert/strict";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { createInitialState } from "../src/state.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

// Host-injected predicate mirroring src/config.ts isMcpBiliCompress (#2970).
const isMcp = (name: string): boolean =>
  name === "compress" || name === "mcp__bili__compress";

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

function mcpPair(
  toolCallId: string,
  startId: string,
  endId: string,
  summary = "s",
): [CoreMessage, CoreMessage] {
  const call: CoreMessage = {
    id: `call-${toolCallId}`,
    role: "assistant",
    contentType: "tool-call",
    toolName: "mcp__bili__compress",
    toolCallId,
    text: JSON.stringify({ content: [{ startId, endId, summary }] }),
  };
  const result: CoreMessage = {
    id: `result-${toolCallId}`,
    role: "tool",
    contentType: "tool-result",
    toolCallId,
    text: "ok",
  };
  return [call, result];
}

test("#2970 L1: mcp__bili__compress gets the same inactive cleanup as bare compress", () => {
  const state = createInitialState();
  state.blocks.push(block({ blockId: "b1", compressCallId: "tool1", active: false }));
  const msgs: CoreMessage[] = [];
  for (const id of ["tool1", "tool2", "tool3"]) msgs.push(...mcpPair(id, "m1", "m2"));

  const r = hideConsumedCompressCalls(state, msgs, isMcp);
  assert.equal(r.hidden, 2, "inactive first pair removed");
  assert.equal(r.messages.length, 4, "second/third pairs remain");
  const kept = r.messages.map((m) => m.toolCallId);
  assert.ok(!kept.includes("tool1"), "inactive pair gone");
  assert.ok(kept.includes("tool2") && kept.includes("tool3"), "orphan pairs kept");
});

test("#2970 L2: active synthetic-id carrier survives beyond the orphan window", () => {
  const state = createInitialState();
  // Real MCP fold: block id is a synthetic plugin_<ts>, never equal to the
  // host call id (tool_*). Identity must come from the quoted range.
  state.blocks.push(
    block({
      blockId: "b-live",
      compressCallId: "plugin_live",
      active: true,
      startRef: "m00001",
      endRef: "m00050",
    }),
  );
  const msgs: CoreMessage[] = [];
  msgs.push(...mcpPair("tool_a", "m00001", "m00050")); // active carrier (oldest)
  msgs.push(...mcpPair("tool_b", "m99901", "m99950")); // orphan
  msgs.push(...mcpPair("tool_c", "m99901", "m99950")); // orphan
  msgs.push(...mcpPair("tool_d", "m99901", "m99950")); // orphan

  const r = hideConsumedCompressCalls(state, msgs, isMcp);
  const kept = new Set(r.messages.map((m) => m.toolCallId));
  assert.ok(kept.has("tool_a"), "active synthetic-id carrier must survive");
  assert.equal(r.hidden, 0, "no fold pending -> nothing swept (#3769)");
  assert.ok(
    kept.has("tool_b") && kept.has("tool_c") && kept.has("tool_d"),
    "orphans remain visible until a real fold",
  );
});

test("#2970 L2: inactive synthetic-id carrier is hidden (stale receipt cleanup)", () => {
  const state = createInitialState();
  state.blocks.push(
    block({
      blockId: "b-dead",
      compressCallId: "plugin_dead",
      active: false,
      startRef: "m00001",
      endRef: "m00050",
    }),
  );
  const msgs: CoreMessage[] = [...mcpPair("tool_dead", "m00001", "m00050")];

  const r = hideConsumedCompressCalls(state, msgs, isMcp);
  const kept = r.messages.map((m) => m.toolCallId);
  assert.ok(!kept.includes("tool_dead"), "inactive carrier hidden");
  assert.equal(r.hidden, 2, "call + result removed");
});

test("#2970/#2362: mcp__bili__compress orphans stay visible between folds (#3769)", () => {
  const state = createInitialState();
  const msgs: CoreMessage[] = [];
  for (const id of ["o1", "o2", "o3", "o4"]) {
    msgs.push(...mcpPair(id, `mX${id}`, `mY${id}`));
  }

  const r = hideConsumedCompressCalls(state, msgs, isMcp);
  const kept = new Set(r.messages.map((m) => m.toolCallId));
  assert.equal(r.hidden, 0, "quiet turn sweeps nothing (#3769)");
  assert.ok(
    ["o1", "o2", "o3", "o4"].every((id) => kept.has(id)),
    "all orphans remain visible until a real fold (#3769)",
  );
});

test("#2970: active synthetic-id carrier's long summary is stubbed", () => {
  const longSummary = "x".repeat(5000);
  const state = createInitialState();
  state.blocks.push(
    block({
      blockId: "b-live",
      compressCallId: "plugin_live",
      active: true,
      startRef: "m00001",
      endRef: "m00050",
    }),
  );
  const [call] = mcpPair("tool_a", "m00001", "m00050", longSummary);

  const r = hideConsumedCompressCalls(state, [call], isMcp);
  const kept = r.messages.find((m) => m.toolCallId === "tool_a")!;
  const parsed = JSON.parse(kept.text!) as {
    content: { summary: string }[];
  };
  assert.equal(parsed.content[0]!.summary.length, 200, "live-range reduction applied");
  assert.ok(parsed.content[0]!.summary.endsWith("…"));
});

test("default predicate (no host injection) leaves mcp__bili__compress untouched", () => {
  const state: CompressionState = createInitialState();
  state.blocks.push(block({ blockId: "b1", compressCallId: "tool1", active: false }));
  const msgs: CoreMessage[] = [];
  for (const id of ["tool1", "tool2", "tool3"]) msgs.push(...mcpPair(id, "m1", "m2"));

  const r = hideConsumedCompressCalls(state, msgs);
  assert.equal(r.hidden, 0, "unrecognized name -> nothing hidden (byte-identical)");
  assert.equal(r.messages.length, 6);
});
