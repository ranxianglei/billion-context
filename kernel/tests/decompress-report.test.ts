import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBlockIdArg,
  findBlocksOverlappingMessages,
  findActiveAncestor,
  deactivateBlock,
  buildRestoredContentPreview,
  collectBlockContent,
} from "../src/decompress.js";
import { buildStatusReport, buildRecap } from "../src/report.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
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

test("parseBlockIdArg accepts bN and plain N", () => {
  assert.equal(parseBlockIdArg("b3"), "b3");
  assert.equal(parseBlockIdArg("3"), "b3");
  assert.equal(parseBlockIdArg("b005"), "b5");
  assert.equal(parseBlockIdArg("b5"), "b5");
  assert.equal(parseBlockIdArg("garbage"), null);
});

test("findBlocksOverlappingMessages returns active blocks covering given messages", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({ blockId: "b1", effectiveMessageIds: ["m1", "m2"], active: true }),
      block({ blockId: "b2", effectiveMessageIds: ["m3"], active: true }),
      block({ blockId: "b3", effectiveMessageIds: ["m2"], active: false }),
    ],
  };
  const result = findBlocksOverlappingMessages(state, new Set(["m2"]));
  assert.equal(result.length, 1);
  assert.equal(result[0]!.blockId, "b1");
});

test("findActiveAncestor walks nested lineage to nearest active parent", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({ blockId: "b1", active: true }),
      block({ blockId: "b2", directBlockIds: ["b1"], active: false }),
      block({ blockId: "b3", directBlockIds: ["b2"], active: true }),
    ],
  };
  assert.equal(findActiveAncestor(state, "b3"), "b1");
  assert.equal(findActiveAncestor(state, "b2"), "b1");
});

test("deactivateBlock returns new state with target inactive (immutable)", () => {
  const original: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({ blockId: "b1", active: true }),
      block({ blockId: "b2", active: true }),
    ],
  };
  const updated = deactivateBlock(original, ["b1"]);
  assert.equal(updated.blocks[0]!.active, false);
  assert.equal(updated.blocks[1]!.active, true);
  assert.equal(original.blocks[0]!.active, true);
});

test("deactivateBlock deep cascades through nested lineage", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({ blockId: "b1", active: true }),
      block({ blockId: "b2", directBlockIds: ["b1"], active: true }),
    ],
  };
  const updated = deactivateBlock(state, ["b2"], { deep: true });
  assert.equal(updated.blocks[0]!.active, false);
  assert.equal(updated.blocks[1]!.active, false);
});

test("buildRestoredContentPreview lists messages no longer covered", () => {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "hello world" },
    {
      id: "m2",
      role: "assistant",
      contentType: "tool-result",
      toolName: "bash",
      text: "output",
    },
  ];
  const before = new Set(["m1", "m2"]);
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [],
  };
  const result = buildRestoredContentPreview(messages, before, state);
  assert.equal(result.restoredCount, 2);
  assert.ok(result.preview.includes("hello world"));
});

test("buildStatusReport overview shows breakdown and active blocks", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b1",
        summary: "compressed summary",
        effectiveMessageIds: ["old1"],
        active: true,
        tier: 1,
      }),
    ],
  };
  const messages: CoreMessage[] = [
    {
      id: "live1",
      role: "user",
      contentType: "text",
      text: "visible text message",
    },
  ];
  const report = buildStatusReport(state, messages, defaultCountTokens);
  assert.ok(report.includes("CONTEXT BREAKDOWN"));
  assert.ok(report.includes("COMPRESSED BLOCKS"));
  assert.ok(report.includes("b1"));
});

test("buildStatusReport compressed scope lists blocks with details", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b1",
        summary: "first block",
        topic: "auth",
        active: true,
        survivedCount: 3,
      }),
      block({
        blockId: "b2",
        summary: "second block",
        topic: "deploy",
        active: true,
      }),
    ],
  };
  const report = buildStatusReport(state, [], defaultCountTokens, {
    scope: "compressed",
  });
  assert.ok(report.includes("COMPRESSED — 2 blocks"));
  assert.ok(report.includes('"auth"'));
  assert.ok(report.includes('"deploy"'));
});

test("buildRecap lists all active blocks when no blockId", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({ blockId: "b1", summary: "first summary content", active: true }),
      block({ blockId: "b2", summary: "second", active: true }),
    ],
  };
  const recap = buildRecap(state);
  assert.ok(recap.includes("Active compression blocks (2)"));
  assert.ok(recap.includes("b1"));
  assert.ok(recap.includes("b2"));
});

test("buildRecap returns full summary for a specific block", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b1",
        summary: "the full detailed summary text",
        topic: "research",
        active: true,
      }),
    ],
  };
  const recap = buildRecap(state, "b1");
  assert.ok(recap.includes("the full detailed summary text"));
  assert.ok(recap.includes("research"));
});

test("buildRecap reports missing and inactive blocks", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [block({ blockId: "b1", active: false })],
  };
  const missing = buildRecap(state, "b9");
  assert.ok(missing.includes("not found"));
  const inactive = buildRecap(state, "b1");
  assert.ok(inactive.includes("inactive"));
});

test("collectBlockContent: full=false shows nested active child summary + direct messages", () => {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "hello" },
    {
      id: "m2",
      role: "assistant",
      contentType: "tool-result",
      toolName: "read",
      text: "file a",
    },
    { id: "m3", role: "assistant", contentType: "text", text: "found bug" },
    { id: "m4", role: "user", contentType: "text", text: "direct message" },
  ];
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      // T1 child covering m1,m2 — stays folded, its summary shown
      block({
        blockId: "b1",
        effectiveMessageIds: ["m1", "m2"],
        active: true,
        summary: "child summary",
        topic: "intro",
      }),
      // T2 parent covering m1..m4, consumes b1
      block({
        blockId: "b2",
        effectiveMessageIds: ["m1", "m2", "m3", "m4"],
        directBlockIds: ["b1"],
        active: true,
      }),
    ],
  };
  const parent = state.blocks.find((b) => b.blockId === "b2")!;
  const result = collectBlockContent(state, parent, messages);
  assert.ok(result.count > 0);
  // child summary rendered with topic label
  assert.match(result.text, /\[Compressed conversation section\] — b1: intro/);
  assert.ok(result.text.includes("child summary"));
  // m1,m2 NOT shown (covered by active child); m3,m4 shown in full
  assert.ok(!result.text.includes("hello"));
  assert.ok(!result.text.includes("file a"));
  assert.ok(result.text.includes("found bug"));
  assert.ok(result.text.includes("direct message"));
});

test("collectBlockContent: full=true recurses to all original messages", () => {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "hello" },
    {
      id: "m2",
      role: "assistant",
      contentType: "tool-result",
      toolName: "read",
      text: "file a",
    },
    { id: "m3", role: "assistant", contentType: "text", text: "found bug" },
  ];
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b1",
        effectiveMessageIds: ["m1", "m2"],
        active: true,
        summary: "child summary",
      }),
      block({
        blockId: "b2",
        effectiveMessageIds: ["m1", "m2", "m3"],
        directBlockIds: ["b1"],
        active: true,
      }),
    ],
  };
  const parent = state.blocks.find((b) => b.blockId === "b2")!;
  const result = collectBlockContent(state, parent, messages, { full: true });
  assert.equal(result.count, 3);
  // ALL original messages shown, no summary
  assert.ok(result.text.includes("hello"));
  assert.ok(result.text.includes("file a"));
  assert.ok(result.text.includes("found bug"));
  assert.ok(!result.text.includes("child summary"));
  assert.ok(!result.text.includes("[Compressed"));
});

test("collectBlockContent: full=false with inactive nested child shows child's messages directly", () => {
  // If the nested child is inactive (e.g. already decompressed), its messages
  // are NOT considered covered and are shown in full — only ACTIVE children fold.
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "hello" },
    { id: "m2", role: "assistant", contentType: "text", text: "world" },
  ];
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b1",
        effectiveMessageIds: ["m1"],
        active: false,
        summary: "inactive child",
      }),
      block({
        blockId: "b2",
        effectiveMessageIds: ["m1", "m2"],
        directBlockIds: ["b1"],
        active: true,
      }),
    ],
  };
  const parent = state.blocks.find((b) => b.blockId === "b2")!;
  const result = collectBlockContent(state, parent, messages);
  assert.equal(result.count, 2);
  assert.ok(result.text.includes("hello"));
  assert.ok(result.text.includes("world"));
  assert.ok(!result.text.includes("inactive child"));
});

test("collectBlockContent: does not mutate state", () => {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "hello" },
  ];
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({ blockId: "b1", effectiveMessageIds: ["m1"], active: true }),
    ],
  };
  const before = JSON.stringify(state);
  collectBlockContent(state, state.blocks[0]!, messages, { full: true });
  const after = JSON.stringify(state);
  assert.equal(after, before, "state must not be mutated");
});

test("collectBlockContent: empty block returns empty", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [block({ blockId: "b1", effectiveMessageIds: [], active: true })],
  };
  const result = collectBlockContent(state, state.blocks[0]!, []);
  assert.equal(result.count, 0);
  assert.equal(result.text, "");
});
