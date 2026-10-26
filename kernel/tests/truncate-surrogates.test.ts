import { test } from "node:test";
import assert from "node:assert/strict";
import { clampPrefix, clampWindow } from "../src/truncate.js";
import { hideConsumedCompressCalls } from "../src/hide-consumed.js";
import {
  deriveTopicFromSummary,
  parseCompressArgs,
} from "../src/parse-compress-input.js";
import { buildRecap } from "../src/report.js";
import {
  searchBlocks,
  messageDocs,
  type SearchDoc,
} from "../src/search/index.js";
import { createInitialState } from "../src/state.js";
import { topicFallback } from "../src/panel/topic.js";
import { truncateLargeToolOutputs } from "../src/truncate-tools.js";
import { buildRestoredContentPreview } from "../src/decompress.js";
import { defaultConfig } from "../src/config.js";
import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

const EMOJI = "\u{1F980}";

function assertNoUnpairedSurrogates(s: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      assert.ok(
        n >= 0xdc00 && n <= 0xdfff,
        `lone high surrogate at ${i} in ${JSON.stringify(s.slice(Math.max(0, i - 4), i + 4))}`,
      );
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      assert.fail(
        `lone low surrogate at ${i} in ${JSON.stringify(s.slice(Math.max(0, i - 4), i + 4))}`,
      );
    }
  }
}

test("clampPrefix: ascii and short inputs unchanged", () => {
  assert.equal(clampPrefix("abcdef", 3), "abc");
  assert.equal(clampPrefix("abc", 5), "abc");
  assert.equal(clampPrefix("", 3), "");
});

test("clampPrefix: pair straddling the cut drops the stray high half", () => {
  // units: a b D83E DF80 — cutting at 3 would strand D83E
  assert.equal(clampPrefix(`ab${EMOJI}`, 3), "ab");
  assert.equal(clampPrefix(`ab${EMOJI}`, 4), `ab${EMOJI}`);
});

test("clampWindow: edges snap off surrogate pairs", () => {
  const t = `ab${EMOJI}cd`;
  // start at 3 points at DF80 (low half of the pair at 2-3) -> snap forward
  assert.equal(clampWindow(t, 3, 6), "cd");
  // start at 2 lands exactly on the pair -> kept intact
  assert.equal(clampWindow(t, 2, 6), `${EMOJI}cd`);
  // end at 3 cuts between D83E/DF80 -> snap back
  assert.equal(clampWindow(t, 0, 3), "ab");
  assert.equal(clampWindow(t, 0, 6), t);
  assert.equal(clampWindow("abc", 5, 3), "");
});

test("compactEntry stub: emoji straddling the 200-char clamp leaves no lone surrogate (#816)", () => {
  const state = createInitialState();
  state.blocks.push({
    blockId: "b1",
    runId: "r0",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 1000,
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: "call1",
    startRef: "m00001",
    endRef: "m00050",
  });
  // 198 ascii + astral at units 198-199 + tail: old slice(0,199) ended on D83E
  const summary = "a".repeat(198) + EMOJI + "tail";
  const call: CoreMessage = {
    id: "mc1",
    role: "assistant",
    contentType: "tool-call",
    toolName: "compress",
    toolCallId: "call1",
    text: JSON.stringify({
      content: [{ startId: "m00001", endId: "m00050", summary }],
    }),
  };
  const { messages } = hideConsumedCompressCalls(state, [call]);
  const stub = (
    JSON.parse(messages[0]!.text ?? "") as { content: { summary: string }[] }
  ).content[0]!.summary;
  assert.ok(stub.length <= 200, `stub length ${stub.length}`);
  assert.ok(stub.endsWith("\u2026"));
  assertNoUnpairedSurrogates(stub);
  assertNoUnpairedSurrogates(JSON.stringify(stub));
});

test("compactEntry stub: astral char fully inside the prefix survives intact", () => {
  const state = createInitialState();
  state.blocks.push({
    blockId: "b1",
    runId: "r0",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    createdAt: 1000,
    survivedCount: 0,
    generation: "young",
    active: true,
    compressCallId: "call1",
    startRef: "m00001",
    endId: "m00050",
  });
  const summary = "a".repeat(197) + EMOJI + "b".repeat(10);
  const call: CoreMessage = {
    id: "mc1",
    role: "assistant",
    contentType: "tool-call",
    toolName: "compress",
    toolCallId: "call1",
    text: JSON.stringify({
      content: [{ startId: "m00001", endId: "m00050", summary }],
    }),
  };
  const { messages } = hideConsumedCompressCalls(state, [call]);
  const stub = (
    JSON.parse(messages[0]!.text ?? "") as { content: { summary: string }[] }
  ).content[0]!.summary;
  assert.equal(stub.length, 200);
  assert.ok(stub.includes(EMOJI));
  assertNoUnpairedSurrogates(stub);
});

test("search title: message text straddling the 60-unit title cut stays paired", () => {
  // units 0-58 'h', 59-60 astral, then the query term: old slice(0,60) kept D83E alone
  const text = "h".repeat(59) + EMOJI + " needle details";
  const docs = messageDocs([{ ref: "m00001", role: "user", text }]);
  const r = searchBlocks(docs, "needle");
  assert.equal(r.length, 1);
  assertNoUnpairedSurrogates(r[0]!.title);
  assert.ok(r[0]!.title.startsWith("user: "));
});

test("search preview: centered window splitting both surrogate edges stays paired", () => {
  // layout: x*19 | EMOJI@19-20 | y*9 | needle@30-35 | w*23 | EMOJI@59-60 | v*20
  const text =
    "x".repeat(19) +
    EMOJI +
    "y".repeat(9) +
    "needle" +
    "w".repeat(23) +
    EMOJI +
    "v".repeat(20);
  const docs: SearchDoc[] = [
    { kind: "block", ref: "b1", text, title: "t", blockId: "b1", tier: 1 },
  ];
  const r = searchBlocks(docs, "needle", { previewLength: 40 });
  assert.equal(r.length, 1);
  const p = r[0]!.preview;
  assert.ok(p.startsWith("\u2026"), "window has a head ellipsis");
  assert.ok(p.endsWith("\u2026"), "window has a tail ellipsis");
  assertNoUnpairedSurrogates(p);
});

test("buildRecap: block summary straddling the 200-unit preview cut stays paired", () => {
  const state: CompressionState = {
    ...createInitialState(),
    blocks: [
      {
        blockId: "b1",
        runId: "r0",
        tier: 1,
        summary: "a".repeat(198) + EMOJI + "tail",
        directMessageIds: [],
        effectiveMessageIds: ["m1"],
        directBlockIds: [],
        createdAt: 1000,
        survivedCount: 0,
        generation: "young",
        active: true,
      },
    ],
  };
  const recap = buildRecap(state);
  assert.ok(recap.includes("..."), "long summary gets an ellipsis marker");
  assertNoUnpairedSurrogates(recap);
});

test("deriveTopicFromSummary: heading straddling the 60-unit cut stays paired", () => {
  const summary = `# ${"h".repeat(59)}${EMOJI} rest\nbody`;
  const topic = deriveTopicFromSummary(summary);
  assert.ok(topic !== undefined);
  assert.ok(topic!.length <= 60);
  assertNoUnpairedSurrogates(topic!);
});

test("topicFallback: astral char straddling the 30-unit cut stays paired", () => {
  // units 0-28 'h', 29-30 astral: old slice(0,30) kept D83E alone
  const out = topicFallback(`h${"h".repeat(28)}${EMOJI}rest of the sentence`);
  assert.ok(out.endsWith("\u2026"));
  assert.ok(!out.includes(EMOJI));
  assertNoUnpairedSurrogates(out);
});

test("topicFallback: short topics pass through untouched", () => {
  assert.equal(topicFallback(`ok ${EMOJI}`), `ok ${EMOJI}`);
});

test("truncateLargeToolOutputs: prefix/suffix cuts straddling pairs stay paired", () => {
  // x*9 | EMOJI@9-10 | m*300 | EMOJI@311-312 | q*9 (len 322):
  // the prefix cut at 10 splits the first pair; the suffix start at len-10=312 lands on a low half
  const text = "x".repeat(9) + EMOJI + "m".repeat(300) + EMOJI + "q".repeat(9);
  const messages: CoreMessage[] = [
    {
      id: "t1",
      role: "tool",
      contentType: "tool-result",
      toolName: "bash",
      toolCallId: "c1",
      text,
    },
    { id: "u1", role: "user", contentType: "text", text: "go" },
  ];
  const config = defaultConfig(1000);
  const r = truncateLargeToolOutputs(
    messages,
    config.modelContextLimit,
    config,
    (t) => Math.max(1, t.length),
    {
      minOutputTokens: 1,
      keepPrefixChars: 10,
      keepSuffixChars: 10,
      protectRecentMessages: 0,
    },
  );
  assert.equal(r.truncatedCount, 1);
  const out = r.messages[0]!.text ?? "";
  assert.ok(out.includes("[truncated for context space]"));
  assert.ok(out.startsWith("x".repeat(9)));
  assert.ok(out.endsWith("q".repeat(9)));
  assertNoUnpairedSurrogates(out);
});

test("buildRestoredContentPreview: per-message 200-unit cut straddling a pair stays paired", () => {
  const state = createInitialState();
  // z*199 | EMOJI@199-200 | tail: old slice(0,200) kept D83E alone
  const messages: CoreMessage[] = [
    {
      id: "m1",
      role: "assistant",
      contentType: "text",
      text: "z".repeat(199) + EMOJI + "tail",
    },
  ];
  const { preview, restoredCount } = buildRestoredContentPreview(
    messages,
    new Set(["m1"]),
    state,
  );
  assert.equal(restoredCount, 1);
  assert.ok(preview.startsWith("[assistant] z"));
  assert.ok(preview.includes("..."));
  assertNoUnpairedSurrogates(preview);
});

test("parse diagnostics: rawPrefix 800-unit cut straddling a pair stays paired", () => {
  // j*799 | EMOJI@799-800 | k*50: old slice(0,800) kept D83E alone
  const raw = "j".repeat(799) + EMOJI + "k".repeat(50);
  const r = parseCompressArgs(raw);
  assert.equal(r.diagnostics.rawPrefix?.length, 799);
  assertNoUnpairedSurrogates(r.diagnostics.rawPrefix ?? "");
});
