import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeBlocks,
  allocateBlockId,
  allocateRunId,
  blockById,
  coveredMessageIds,
  createInitialState,
  highestActiveTier,
  advanceSurvival,
} from "../src/state.js";
import { SUMMARY_HEADER, prune } from "../src/prune.js";
import { createCore, defaultConfig } from "../src/index.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

function msg(id: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text: id };
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
    createdAt: 0,
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("createInitialState returns empty state with id counters at 1", () => {
  const state = createInitialState();
  assert.deepEqual(state.blocks, []);
  assert.equal(state.nextBlockId, 1);
  assert.equal(state.nextRunId, 1);
  assert.equal(state.stats.tokensCompressed, 0);
});

test("allocateBlockId issues sequential ids and advances counter", () => {
  const state = createInitialState();
  assert.equal(allocateBlockId(state), "b1");
  assert.equal(allocateBlockId(state), "b2");
  assert.equal(state.nextBlockId, 3);
});

test("allocateRunId issues sequential ids", () => {
  const state = createInitialState();
  assert.equal(allocateRunId(state), "r1");
  assert.equal(allocateRunId(state), "r2");
});

test("blockById finds block by string id", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b3" }));
  assert.equal(blockById(state, "b3")?.blockId, "b3");
  assert.equal(blockById(state, "b9"), undefined);
});

test("activeBlocks filters inactive", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", active: true }));
  state.blocks.push(makeBlock({ blockId: "b2", active: false }));
  assert.equal(activeBlocks(state).length, 1);
});

test("coveredMessageIds unions active blocks' effective ids", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["m1", "m2"] }),
    makeBlock({ blockId: "b2", active: false, effectiveMessageIds: ["m3"] }),
    makeBlock({ blockId: "b3", effectiveMessageIds: ["m2", "m4"] }),
  );
  assert.deepEqual([...coveredMessageIds(state)].sort(), ["m1", "m2", "m4"]);
});

test("highestActiveTier returns max tier among active blocks", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", tier: 1 }),
    makeBlock({ blockId: "b2", tier: 2, active: false }),
    makeBlock({ blockId: "b3", tier: 3 }),
  );
  assert.equal(highestActiveTier(state), 3);
});

test("advanceSurvival increments survivedCount and promotes past threshold", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", survivedCount: 4 }),
    makeBlock({ blockId: "b2", survivedCount: 1, active: false }),
  );
  advanceSurvival(state, 5);
  assert.equal(state.blocks[0]!.survivedCount, 5);
  assert.equal(state.blocks[0]!.generation, "old");
  assert.equal(state.blocks[1]!.survivedCount, 1);
});

test("prune returns messages unchanged when nothing is covered", () => {
  const state = createInitialState();
  const messages = [msg("a"), msg("b")];
  assert.deepEqual(prune(messages, state), messages);
});

test("prune removes covered messages and injects summary at anchor", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      summary: "the summary",
      effectiveMessageIds: ["m2", "m3"],
    }),
  );
  const messages = [msg("m1"), msg("m2"), msg("m3"), msg("m4")];
  const result = prune(messages, state);

  assert.equal(result.length, 3);
  assert.equal(result[0]!.id, "m1");
  assert.equal(result[1]!.id, "acp_summary_b1");
  assert.ok(result[1]!.text!.startsWith(SUMMARY_HEADER));
  assert.ok(result[1]!.text!.includes("the summary"));
  assert.equal(result[2]!.id, "m4");
});

test("prune preserves first user message even when covered", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["m1", "m2"] }),
  );
  const messages = [msg("m1", "user"), msg("m2"), msg("m3")];
  const result = prune(messages, state, { injectSummaries: false });

  assert.equal(result.length, 2);
  assert.equal(result[0]!.id, "m1");
  assert.equal(result[1]!.id, "m3");
});

test("#3642: the first-user pin spans the opening wire message's whole core run", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["m1", "m2", "m3"] }),
  );
  // Canonical granularity splits one wire message into one core per part:
  // the opening message is a text + image core RUN sharing wireIndex 0;
  // m3 is a DIFFERENT wire user message. Everything is covered — the pin
  // must keep the whole opening run (image bytes included) and still let
  // the unrelated m3 fold away.
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "m1", wireIndex: 0 },
    {
      id: "m2",
      role: "user",
      contentType: "text",
      text: "m2",
      wireIndex: 0,
    },
    { id: "m3", role: "user", contentType: "text", text: "m3", wireIndex: 1 },
    { id: "m4", role: "assistant", contentType: "text", text: "m4" },
  ].map((m) => m as CoreMessage);
  const result = prune(messages, state, { injectSummaries: false });

  assert.deepEqual(
    result.map((m) => m.id),
    ["m1", "m2", "m4"],
  );
});

test("#3642: kernel-rendered cores (no wireIndex) never extend the pin run", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["m1", "m2"] }),
  );
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "m1", wireIndex: 0 },
    { id: "m2", role: "user", contentType: "text", text: "m2" },
    { id: "m3", role: "assistant", contentType: "text", text: "m3" },
  ].map((m) => m as CoreMessage);
  const result = prune(messages, state, { injectSummaries: false });

  assert.deepEqual(
    result.map((m) => m.id),
    ["m1", "m3"],
  );
});

test("prune without summary injection only removes covered messages", () => {
  const state = createInitialState();
  state.blocks.push(makeBlock({ blockId: "b1", effectiveMessageIds: ["m2"] }));
  const messages = [msg("m1"), msg("m2"), msg("m3")];
  const result = prune(messages, state, { injectSummaries: false });

  assert.deepEqual(
    result.map((m) => m.id),
    ["m1", "m3"],
  );
});

test("prune without summary injection keeps rendered copies of consumed blocks (#2733)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", active: false, effectiveMessageIds: ["m2"] }),
    makeBlock({
      blockId: "b2",
      effectiveMessageIds: ["m3"],
      directBlockIds: ["b1"],
    }),
  );
  const rendered = msg("acp_summary_b1");
  const messages = [msg("m1"), rendered, msg("m4")];
  const result = prune(messages, state, { injectSummaries: false });

  // No fresh render exists when injection is off, so the already-rendered
  // copy stays instead of being silently deleted.
  assert.deepEqual(
    result.map((m) => m.id),
    ["m1", "acp_summary_b1", "m4"],
  );
});

test("prune covers plain base id when block recorded sub-id projections (#231)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      summary: "subid summary",
      effectiveMessageIds: ["h_abc#r0", "h_abc#call1"],
    }),
  );
  const messages = [msg("h_pre"), msg("h_abc"), msg("h_post")];
  const result = prune(messages, state);

  assert.deepEqual(
    result.map((m) => m.id),
    ["h_pre", "acp_summary_b1", "h_post"],
  );
});

test("prune covers sub-id projections when block recorded plain base id (#231)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc"] }),
  );
  const messages = [
    msg("h_pre"),
    msg("h_abc#r0"),
    msg("h_abc#call1"),
    msg("h_post"),
  ];
  const result = prune(messages, state, { injectSummaries: false });

  assert.deepEqual(
    result.map((m) => m.id),
    ["h_pre", "h_post"],
  );
});

test("prune covers sibling sub-id projections of the same base (#231)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc#r0"] }),
  );
  const messages = [msg("h_abc#call1", "assistant"), msg("h_post")];
  const result = prune(messages, state, { injectSummaries: false });

  assert.deepEqual(
    result.map((m) => m.id),
    ["h_post"],
  );
});

test("prune does not cover a distinct id that extends a covered base (#231)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", effectiveMessageIds: ["h_abc#r0"] }),
  );
  const messages = [msg("h_abcde"), msg("h_post")];
  const result = prune(messages, state, { injectSummaries: false });

  assert.deepEqual(
    result.map((m) => m.id),
    ["h_abcde", "h_post"],
  );
});

test("prune anchors summary at base id when block recorded sub-ids (#231)", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({
      blockId: "b1",
      summary: "anchored",
      effectiveMessageIds: ["h_abc#r0"],
    }),
  );
  const messages = [msg("h_pre"), msg("h_abc"), msg("h_post")];
  const result = prune(messages, state);

  assert.deepEqual(
    result.map((m) => m.id),
    ["h_pre", "acp_summary_b1", "h_post"],
  );
  assert.ok(result[1]!.text!.includes("anchored"));
});

test("prune orders multiple summaries by their anchor position", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", summary: "later", effectiveMessageIds: ["x"] }),
    makeBlock({
      blockId: "b2",
      summary: "earlier",
      effectiveMessageIds: ["w"],
    }),
  );
  const messages = [msg("u", "user"), msg("w"), msg("x"), msg("z")];
  const result = prune(messages, state);

  assert.equal(result[0]!.id, "u");
  assert.equal(result[1]!.id, "acp_summary_b2");
  assert.ok(result[1]!.text!.includes("earlier"));
  assert.equal(result[2]!.id, "acp_summary_b1");
  assert.ok(result[2]!.text!.includes("later"));
  assert.equal(result[3]!.id, "z");
});

// ─── #421: id-less host-shaped messages must not crash the pipeline ────────

test("processTurn tolerates id-less host-shaped messages (pre-#233 lenience, #421)", () => {
  // 0.0.90's syncBlocks fed message.id straight into baseIdOf → TypeError
  // for entries that every earlier release silently digested. Subid
  // coverage only applies to messages that actually carry a string id.
  const core = createCore();
  const config = defaultConfig(200000);
  const messages = Array.from({ length: 12 }, (_, i) =>
    i % 2 === 0
      ? {
          role: "user",
          content: { type: "text", text: `u${i} ${"lorem ".repeat(i % 7)}` },
        }
      : {
          role: "assistant",
          content: [{ type: "text", text: `a${i} ${"ipsum ".repeat(i % 5)}` }],
        },
  ) as never as Parameters<typeof core.processTurn>[0]["messages"];
  const turn = core.processTurn({
    messages,
    state: createInitialState(config),
    config,
    tokenCount: 90_000,
  });
  assert.ok(Array.isArray(turn.messages), "turn completes without throwing");
  assert.equal(turn.state.blocks.length, 0, "no blocks from a crash-free pass");
});

// #3641/#3640: unresolved summary anchors — the covered substrate is off the
// wire (host-native compaction, truncation, offload churn) — must never park
// at the very tail riding AFTER the user's newest question. The insertion
// point is the renovation zone (messages every upcoming turn rewrites
// anyway), so cache is unharmed, and the model answers the question first.
test("#3640: unresolved anchor parks BEFORE the newest user message, never at the tail", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", summary: "orphaned history summary", effectiveMessageIds: ["gone1", "gone2"] }),
  );
  const messages = [
    msg("keep1", "assistant"),
    msg("keep2", "assistant"),
    msg("q", "user"), // the newest question
  ];
  const result = prune(messages, state);
  const anchorIdx = result.findIndex((m) => m.id === "acp_summary_b1");
  const qIdx = result.findIndex((m) => m.id === "q");
  assert.ok(anchorIdx >= 0, "the orphaned summary still renders (snapshot survives)");
  assert.ok(qIdx > anchorIdx, `summary (idx ${anchorIdx}) must precede the newest user turn (idx ${qIdx})`);
});

test("#3641: no user turn on the wire → legacy tail placement preserved", () => {
  const state = createInitialState();
  state.blocks.push(
    makeBlock({ blockId: "b1", summary: "s", effectiveMessageIds: ["gone1"] }),
  );
  const messages = [msg("a1", "assistant"), msg("a2", "assistant")];
  const result = prune(messages, state);
  assert.equal(result[result.length - 1]!.id, "acp_summary_b1",
    "assistant-only history keeps the pre-doctrine tail placement");
});
