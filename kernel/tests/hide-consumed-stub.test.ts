import { test } from "node:test";
import assert from "node:assert/strict";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import { renderVisibleRefs } from "../src/render-refs.js";
import { createInitialState } from "../src/state.js";
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

function callWith(text: string, toolCallId = "call1"): CoreMessage {
  return {
    id: "mc1",
    role: "assistant",
    contentType: "tool-call",
    toolName: "compress",
    toolCallId,
    text,
  };
}

function liveState(
  summary: string,
  startRef: string,
  endRef: string,
): CompressionState {
  const state = createInitialState();
  state.blocks.push(
    block({
      blockId: "b1",
      compressCallId: "call1",
      summary,
      startRef,
      endRef,
    }),
  );
  return state;
}

interface StubEntry {
  startId?: string;
  summary?: string;
  topic?: string;
}

function parsedContent(text: string | undefined): StubEntry[] {
  return (JSON.parse(text ?? "") as { content: StubEntry[] }).content;
}

test("fully-live BARE-name compress call args keep their full summaries (#6965)", () => {
  const longSummary = "x".repeat(5000);
  const callText = JSON.stringify({
    content: [
      { startId: "m00001", endId: "m00050", topic: "T", summary: longSummary },
    ],
  });
  const state = liveState(longSummary, "m00001", "m00050");

  const { messages } = hideConsumedCompressCalls(state, [callWith(callText)]);

  assert.equal(messages.length, 1);
  // #6965: while the originating bare-name call is visible, prune (#4311)
  // suppresses the rendered anchor — the args are the summary's ONLY wire
  // carrier, so the stub must not apply (it used to, deleting the full text).
  assert.equal(messages[0]!.text, callText);
});

test("foreign-name carrier args are still stubbed (rendered anchor dedup, #336)", () => {
  const longSummary = "y".repeat(5000);
  const state = liveState(longSummary, "m00001", "m00050");
  // The block's host call id is NOT in the view (that is why the foreign
  // carrier exists) — prune renders the anchor, so the carrier's args keep
  // the #336 stub.
  const call: CoreMessage = {
    id: "mc9",
    role: "assistant",
    contentType: "tool-call",
    toolName: "acp_compress",
    toolCallId: "call-f",
    text: JSON.stringify({
      content: [
        { startId: "m00001", endId: "m00050", summary: longSummary },
      ],
    }),
  };

  const { messages } = hideConsumedCompressCalls(state, [call], (name) =>
    name === "acp_compress");

  assert.equal(messages.length, 1);
  const content = parsedContent(messages[0]!.text);
  assert.equal(content.length, 1);
  assert.equal(content[0]!.summary!.length, 200);
  assert.ok(content[0]!.summary!.endsWith("…"));
});

test("short summaries are left byte-identical; kept orphans with long summaries are stubbed", () => {
  const shortText = JSON.stringify({
    content: [{ startId: "m00001", endId: "m00050", summary: "short" }],
  });
  const state = liveState("short", "m00001", "m00050");

  const { messages } = hideConsumedCompressCalls(state, [callWith(shortText)]);
  assert.equal(messages[0]!.text, shortText);

  const orphanText = JSON.stringify({
    content: [
      { startId: "m00001", endId: "m00050", summary: "y".repeat(4000) },
    ],
  });
  const { messages: orphanOut } = hideConsumedCompressCalls(
    createInitialState(),
    [callWith(orphanText, "orphan")],
  );
  assert.equal(orphanOut.length, 1);
  assert.equal(parsedContent(orphanOut[0]!.text)[0]!.summary!.length, 200);
});

test("tag-prefixed BARE-name compress call text keeps the full summary (#6965)", () => {
  const longSummary = "z".repeat(3000);
  const state = liveState(longSummary, "m00001", "m00050");
  state.messageRefs.byRaw["mc1"] = "m00010";
  state.messageRefs.byRef["m00010"] = "mc1";
  const callText = JSON.stringify({
    content: [{ startId: "m00001", endId: "m00050", summary: longSummary }],
  });
  const tagged = renderVisibleRefs([callWith(callText)], state)[0]!;
  assert.ok(tagged.text!.startsWith("<acp "));

  const { messages } = hideConsumedCompressCalls(state, [tagged]);
  const text = messages[0]!.text!;
  assert.ok(text.startsWith("<acp "));
  assert.ok(text.includes("m00010"));
  const content = JSON.parse(text.slice(text.indexOf("{"))) as {
    content: { summary: string }[];
  };
  // Bare-name call visible ⇒ #4311 anchor skip ⇒ no stub (#6965).
  assert.equal(content.content[0]!.summary.length, 3000);
});

test("tag-prefixed mixed call: consumed sibling entry is still dropped", () => {
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
  state.messageRefs.byRaw["mc"] = "m00010";
  state.messageRefs.byRef["m00010"] = "mc";
  const call: CoreMessage = {
    id: "mc",
    role: "assistant",
    contentType: "tool-call",
    toolName: "compress",
    toolCallId: "call-batch",
    text: JSON.stringify({
      content: [
        { startId: "m5", endId: "m6", summary: "live entry summary" },
        { startId: "m8", endId: "m9", summary: "c".repeat(300) },
      ],
    }),
  };
  const tagged = renderVisibleRefs([call], state)[0]!;

  const { messages } = hideConsumedCompressCalls(state, [tagged]);
  const kept = messages.find((m) => m.toolCallId === "call-batch")!;
  const text = kept.text!;
  assert.ok(text.startsWith("<acp "));
  const content = JSON.parse(text.slice(text.indexOf("{"))) as {
    content: { startId: string; summary: string }[];
  };
  assert.equal(content.content.length, 1);
  assert.equal(content.content[0]!.startId, "m5");
  assert.equal(content.content[0]!.summary, "live entry summary");
});

test("parseCallText handles stringified content arrays and preserves the string shape (#230)", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      block({
        blockId: "b1",
        compressCallId: "call-str",
        active: true,
        startRef: "m1",
        endRef: "m2",
      }),
      block({
        blockId: "b2",
        compressCallId: "call-str",
        active: false,
        startRef: "m3",
        endRef: "m4",
      }),
    ],
  };
  const inner = JSON.stringify([
    { startId: "m1", endId: "m2", summary: "x".repeat(300) },
    { startId: "m3", endId: "m4", summary: "y".repeat(300) },
  ]);
  const messages: CoreMessage[] = [
    {
      id: "m5",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId: "call-str",
      text: JSON.stringify({ content: inner }),
    },
  ];
  const result = hideConsumedCompressCalls(state, messages);
  const kept = result.messages.find((m) => m.toolCallId === "call-str");
  assert.ok(kept, "live call kept");
  const parsed = JSON.parse(kept!.text!.replace(/^[^{]*/, "")) as {
    content: unknown;
  };
  assert.equal(typeof parsed.content, "string", "string shape preserved");
  const entries = JSON.parse(parsed.content as string) as {
    startId: string;
    summary: string;
  }[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.startId, "m1");
  // Bare-name call: consumed sibling dropped, live entry keeps its full
  // summary (no stub — #4311 anchor skip makes the args the sole carrier).
  assert.equal(entries[0]!.summary, "x".repeat(300));
});
