import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCompressArgs } from "../src/parse-compress-input.js";
import { rebuildCompressionState } from "../src/rebuild.js";
import { createInitialState } from "../src/state.js";
import { defaultConfig } from "../src/config.js";
import type { CompressRangeSpec, CoreMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// Input-shape normalization
// ---------------------------------------------------------------------------

test("parseCompressArgs parses a valid object with all fields", () => {
  const input = {
    content: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "intro",
        topic: "setup",
        summaryMaxChars: 5000,
      },
    ],
  };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.invalidItems, 0);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m00001");
  assert.equal(ranges[0]?.endRef, "m00002");
  assert.equal(ranges[0]?.summary, "intro");
  assert.equal(ranges[0]?.topic, "setup");
  assert.equal(ranges[0]?.summaryMaxChars, 5000);
});

test("parseCompressArgs parses a raw JSON document string", () => {
  const input = JSON.stringify({
    content: [{ startRef: "m00001", endRef: "m00002", summary: "intro" }],
  });
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "intro");
  assert.equal(diagnostics.length, input.length);
  assert.equal(diagnostics.rawPrefix, input.slice(0, 800));
});

test("parseCompressArgs unwraps one level of double-stringification", () => {
  const input = JSON.stringify(
    JSON.stringify({
      content: [{ startRef: "m00001", endRef: "m00002", summary: "doubled" }],
    }),
  );
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "doubled");
});

test("parseCompressArgs accepts a stringified content array (vLLM shape)", () => {
  const input = {
    content: JSON.stringify([
      { startRef: "m00001", endRef: "m00002", summary: "vllm" },
    ]),
  };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m00001");
  assert.equal(ranges[0]?.summary, "vllm");
});

test("parseCompressArgs salvages a stringified content array truncated mid-entry", () => {
  const full = [
    { startRef: "m00001", endRef: "m00002", summary: "first entry complete" },
    {
      startRef: "m00003",
      endRef: "m00004",
      summary: "second entry cut off mid",
    },
  ];
  const cut = JSON.stringify(full).slice(0, JSON.stringify(full).length - 12);
  const input = { content: cut };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "truncated");
  assert.equal(diagnostics.ok, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "first entry complete");
  assert.equal(diagnostics.invalidItems, 0);
});

test("parseCompressArgs strips markdown fences (with and without language tag)", () => {
  const doc = JSON.stringify({
    content: [{ startRef: "m00001", endRef: "m00002", summary: "fenced" }],
  });
  for (const input of ["```json\n" + doc + "\n```", "```\n" + doc + "\n```"]) {
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(
      diagnostics.kind,
      "ok",
      "expected ok for: " + input.slice(0, 20),
    );
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.summary, "fenced");
  }
});

test("parseCompressArgs repairs trailing commas", () => {
  const input =
    '{"content": [{"startRef": "m00001", "endRef": "m00002", "summary": "S",}]}';
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "S");
});

test("parseCompressArgs escapes raw newlines inside JSON string values", () => {
  // A provider serialized a real newline inside the summary string.
  const input =
    '{"content": [{"startRef": "m00001", "endRef": "m00002", "summary": "line1\nline2"}]}';
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "line1\nline2");
});

test("parseCompressArgs preserves escaped quotes in salvaged entries", () => {
  const entry = {
    startRef: "m00001",
    endRef: "m00002",
    summary: 'has "quotes" inside',
  };
  const doc = JSON.stringify({
    content: [entry, { startRef: "m00003", endRef: "m00004", summary: "gone" }],
  });
  // Cut after the first entry's closing brace (the comma follows it).
  const firstClose = doc.indexOf("}") + 1;
  const input =
    doc.slice(0, firstClose) + ', {"startRef": "m00003", "endRef": "m0';
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "truncated");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, 'has "quotes" inside');
});

// ---------------------------------------------------------------------------
// Single-quoted JSON salvage (#603 / omp#121: weak local models)
// ---------------------------------------------------------------------------

test("parseCompressArgs salvages single-quoted JSON args (#603)", () => {
  const input = `{'content':[{'startId':'m00010','endId':'m00020','summary':'first'},{'startId':'m00030','endId':'m00040','summary':'second','topic':'mid'}],'topic':'intro'}`;
  const { ranges, diagnostics } = parseCompressArgs(input, {
    callId: "call-q",
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.quoteSalvage, true);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]?.startRef, "m00010");
  assert.equal(ranges[0]?.endRef, "m00020");
  assert.equal(ranges[0]?.summary, "first");
  assert.equal(ranges[0]?.topic, "intro");
  assert.equal(ranges[0]?.compressCallId, "call-q");
  assert.equal(ranges[1]?.startRef, "m00030");
  assert.equal(ranges[1]?.topic, "mid");
});

test("parseCompressArgs salvages mixed single/double quotes, keeps apostrophes in data (#603)", () => {
  const input = `{'content': [{'startId': "m00001", 'endId': "m00009", 'summary': "it's done, really"}]}`;
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.quoteSalvage, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m00001");
  assert.equal(ranges[0]?.endRef, "m00009");
  assert.equal(ranges[0]?.summary, "it's done, really");
});

test("parseCompressArgs salvages truncated single-quoted content array (#603)", () => {
  const input = `{'content':[{'startId':'m00010','endId':'m00020','summary':'first'},{'startId':'m00030','endId':'m00040','summary':'secon`;
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "truncated");
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.quoteSalvage, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m00010");
  assert.equal(ranges[0]?.endRef, "m00020");
  assert.equal(ranges[0]?.summary, "first");
});

test("parseCompressArgs salvages object input whose content string is single-quoted (#603)", () => {
  const input = {
    content: `[{'startId':'m00005','endId':'m00006','summary':'ok'}]`,
  };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.quoteSalvage, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m00005");
  assert.equal(ranges[0]?.endRef, "m00006");
  assert.equal(ranges[0]?.summary, "ok");
});

test("parseCompressArgs still rejects prose with apostrophes unchanged (#603)", () => {
  const { ranges, diagnostics } = parseCompressArgs(
    "I couldn't believe {that} would 'work'",
  );
  assert.deepEqual(ranges, []);
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.kind, "malformed-json");
  assert.equal(diagnostics.quoteSalvage, undefined);
});

test("parseCompressArgs leaves valid double-quoted args untouched by salvage (#603)", () => {
  const input = JSON.stringify({
    content: [{ startId: "m00001", endId: "m00002", summary: "don't panic" }],
  });
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.quoteSalvage, undefined);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "don't panic");
});

test("parseCompressArgs repairs single quotes combined with trailing commas and raw newlines", () => {
  const input = `{'content':[{'startId':'m00001','endId':'m00002','summary':'line1\nline2',}]}`;
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.quoteSalvage, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "line1\nline2");
});

test("parseCompressArgs does not fabricate fields for a single-quoted entry missing bounds", () => {
  // Quote repair makes the entry parseable, but validation still applies:
  // no endId/summary means no range — reported, not invented. The retry
  // wins only on strictly more ranges, so first-pass diagnostics stand.
  const input = `{'content':[{'startId':'m00010'}]}`;
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(ranges.length, 0);
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.quoteSalvage, undefined);
});

// ---------------------------------------------------------------------------
// Truncation salvage
// ---------------------------------------------------------------------------

test("parseCompressArgs salvages complete entries from a truncated JSON prefix", () => {
  const doc = JSON.stringify({
    content: [
      { startRef: "m00001", endRef: "m00002", summary: "first entry complete" },
      {
        startRef: "m00003",
        endRef: "m00004",
        summary: "second entry cut off mid",
      },
    ],
  });
  const input = doc.slice(0, doc.length - 12);
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "truncated");
  assert.equal(diagnostics.ok, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "first entry complete");
});

test("parseCompressArgs salvages entries when the closing brackets are missing entirely", () => {
  const entry =
    '{"startRef": "m00001", "endRef": "m00002", "summary": "no brackets after me"}';
  const input = '{"content": [' + entry + ', {"startRef": "m00003"';
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "truncated");
  assert.equal(diagnostics.ok, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "no brackets after me");
});

test("parseCompressArgs reports truncated with no ranges when the first entry is cut", () => {
  const input = '{"content": [{"startRef": "m00001", "endRef": "m0';
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "truncated");
  assert.equal(diagnostics.ok, false);
  assert.equal(ranges.length, 0);
});

test("parseCompressArgs does not fabricate partial entries", () => {
  // startRef present, endRef/summary missing and cut: entry is incomplete, must be dropped.
  const input = '{"content": [{"startRef": "m00001", "summary": "par';
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "truncated");
  assert.equal(ranges.length, 0);
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

test("parseCompressArgs classifies empty inputs", () => {
  for (const input of [null, undefined, "", "   "]) {
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "empty-input", JSON.stringify(input));
    assert.equal(diagnostics.ok, false);
    assert.equal(ranges.length, 0);
  }
});

test("parseCompressArgs classifies non-object parsed values", () => {
  for (const input of [[], 42, '"just a string"', "true"]) {
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "not-object", JSON.stringify(input));
    assert.equal(diagnostics.ok, false);
    assert.equal(ranges.length, 0);
  }
});

test("parseCompressArgs classifies an object without a content key", () => {
  const { diagnostics } = parseCompressArgs({ foo: 1, bar: "x" });
  assert.equal(diagnostics.kind, "missing-content");
  assert.equal(diagnostics.ok, false);
  assert.deepEqual(diagnostics.keys, ["foo", "bar"]);
});

test("parseCompressArgs classifies a content value that is neither array nor array-string", () => {
  const { diagnostics } = parseCompressArgs({ content: "123" });
  assert.equal(diagnostics.kind, "content-not-array");
  assert.equal(diagnostics.ok, false);
});

test("parseCompressArgs classifies balanced garbage as malformed-json", () => {
  const { ranges, diagnostics } = parseCompressArgs("hello");
  assert.equal(diagnostics.kind, "malformed-json");
  assert.equal(diagnostics.ok, false);
  assert.equal(ranges.length, 0);
});

test("parseCompressArgs counts invalid entries and keeps the valid ones", () => {
  const input = {
    content: [
      { startRef: "m00001", endRef: "m00002", summary: "good" },
      { summary: "missing refs" },
      { startRef: "m00003", endRef: "m00004" },
      { startRef: "m00005", endRef: "m00006", summary: 42 },
      "garbage",
      null,
    ],
  };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "good");
  assert.equal(diagnostics.invalidItems, 5);
});

test("parseCompressArgs reports per-entry invalid reasons", () => {
  const input = {
    content: [
      { startRef: "m00001", endRef: "m00002", summary: "good" },
      { summary: "missing refs" },
      { startRef: "m00003", endRef: "m00004" },
      "garbage",
    ],
  };
  const { diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.invalidItems, 3);
  assert.deepEqual(diagnostics.invalidReasons, [
    "entry 1: missing range bounds (need startRef/startId and endRef/endId)",
    "entry 2: missing summary",
    "entry 3: line entry: no mNNNNN/bN refs in header",
  ]);
});

test("parseCompressArgs reports invalid reasons for no-valid-ranges", () => {
  const input = {
    content: [
      { startRef: "m00001", endRef: "m00002" },
      { summary: "no bounds" },
    ],
  };
  const { diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "no-valid-ranges");
  assert.equal(diagnostics.invalidItems, 2);
  assert.deepEqual(diagnostics.invalidReasons, [
    "entry 0: missing summary",
    "entry 1: missing range bounds (need startRef/startId and endRef/endId)",
  ]);
});

test("parseCompressArgs reports no-valid-ranges for an empty content array", () => {
  const { ranges, diagnostics } = parseCompressArgs({ content: [] });
  assert.equal(diagnostics.kind, "no-valid-ranges");
  assert.equal(diagnostics.ok, false);
  assert.equal(ranges.length, 0);
  assert.equal(diagnostics.invalidItems, 0);
});

test("parseCompressArgs reports no-valid-ranges for an empty stringified content", () => {
  const { ranges, diagnostics } = parseCompressArgs({ content: "" });
  assert.equal(diagnostics.kind, "no-valid-ranges");
  assert.equal(ranges.length, 0);
});

// ---------------------------------------------------------------------------
// Field-name variants and call-id stamping
// ---------------------------------------------------------------------------

test("parseCompressArgs accepts startId/endId and messageId name variants", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: [
      { startId: "m00001", endId: "m00002", summary: "variant-a" },
      { messageId: "m00003", summary: "variant-b" },
    ],
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]?.startRef, "m00001");
  assert.equal(ranges[0]?.endRef, "m00002");
  assert.equal(ranges[1]?.startRef, "m00003");
  assert.equal(ranges[1]?.endRef, "m00003");
});

test("parseCompressArgs stamps compressCallId when a callId is provided", () => {
  const input = {
    content: [{ startRef: "m00001", endRef: "m00002", summary: "stamped" }],
  };
  const stamped = parseCompressArgs(input, { callId: "call-9" });
  assert.equal(stamped.ranges[0]?.compressCallId, "call-9");
  const plain = parseCompressArgs(input);
  assert.equal(plain.ranges[0]?.compressCallId, undefined);
});

// ---------------------------------------------------------------------------
// Diagnostics shape
// ---------------------------------------------------------------------------

test("parseCompressArgs caps rawPrefix at 800 chars and reports full length", () => {
  const input = "x".repeat(1000);
  const { diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "malformed-json");
  assert.equal(diagnostics.length, 1000);
  assert.equal(diagnostics.rawPrefix?.length, 800);
});

test("parseCompressArgs leaves rawPrefix/length undefined for object input", () => {
  const { diagnostics } = parseCompressArgs({ content: [] });
  assert.equal(diagnostics.rawPrefix, undefined);
  assert.equal(diagnostics.length, undefined);
});

// ---------------------------------------------------------------------------
// rebuildCompressionState regression (fork-recovery path)
// ---------------------------------------------------------------------------

function rebuildMessages(
  toolCallText: string,
  toolCallId: string,
): CoreMessage[] {
  const messages: CoreMessage[] = [
    { id: "raw1", role: "user", contentType: "text", text: "first message" },
    {
      id: "raw2",
      role: "assistant",
      contentType: "text",
      text: "second message",
    },
  ];
  if (toolCallText !== "") {
    messages.push({
      id: "raw3",
      role: "assistant",
      contentType: "tool-call",
      toolName: "compress",
      toolCallId,
      text: toolCallText,
    });
  }
  return messages;
}

function rebuildConfig() {
  return defaultConfig(200000, {
    compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  });
}

test("rebuildCompressionState rebuilds from a strict JSON object (pre-existing behavior)", () => {
  const args = JSON.stringify({
    content: [{ startId: "m00001", endId: "m00002", summary: "strict object" }],
  });
  const result = rebuildCompressionState(
    createInitialState(),
    rebuildMessages(args, "call1"),
    rebuildConfig(),
  );
  assert.equal(result.blocksRebuilt, 1);
  const block = result.state.blocks.find((b) =>
    b.summary.includes("strict object"),
  );
  assert.ok(block);
  assert.equal(block.compressCallId, "call1");
});

test("rebuildCompressionState recovers vLLM stringified content (fork-recovery gap fix)", () => {
  // vLLM hosts stringify the nested content array; the old strict
  // Array.isArray check dropped these silently.
  const args = JSON.stringify({
    content: JSON.stringify([
      { startId: "m00001", endId: "m00002", summary: "vllm stringified" },
    ]),
  });
  const result = rebuildCompressionState(
    createInitialState(),
    rebuildMessages(args, "call1"),
    rebuildConfig(),
  );
  assert.equal(result.blocksRebuilt, 1);
  const block = result.state.blocks.find((b) =>
    b.summary.includes("vllm stringified"),
  );
  assert.ok(block);
  assert.equal(block.compressCallId, "call1");
});

test("rebuildCompressionState salvages a truncated compress tool-call text", () => {
  const doc = JSON.stringify({
    content: [
      { startId: "m00001", endId: "m00002", summary: "survives truncation" },
      { startId: "m00003", endId: "m00004", summary: "cut off here" },
    ],
  });
  const result = rebuildCompressionState(
    createInitialState(),
    rebuildMessages(doc.slice(0, doc.length - 12), "call1"),
    rebuildConfig(),
  );
  assert.equal(result.blocksRebuilt, 1);
  assert.ok(
    result.state.blocks.find((b) => b.summary.includes("survives truncation")),
  );
});

test("rebuildCompressionState survives garbage tool-call text without rebuilding", () => {
  const result = rebuildCompressionState(
    createInitialState(),
    rebuildMessages("total garbage not json", "call1"),
    rebuildConfig(),
  );
  assert.equal(result.blocksRebuilt, 0);
  assert.equal(result.state.blocks.length, 0);
});

test("rebuildCompressionState skips compress calls with no valid ranges", () => {
  const result = rebuildCompressionState(
    createInitialState(),
    rebuildMessages(JSON.stringify({ content: [] }), "call1"),
    rebuildConfig(),
  );
  assert.equal(result.blocksRebuilt, 0);
  assert.equal(result.state.blocks.length, 0);
});

test("parseCompressArgs returns ranges typed as CompressRangeSpec", () => {
  // Compile-time contract: ranges feed core.applyCompression directly.
  const { ranges } = parseCompressArgs({
    content: [{ startRef: "m00001", endRef: "m00002", summary: "typed" }],
  });
  const spec: CompressRangeSpec | undefined = ranges[0];
  assert.ok(spec);
  assert.equal(typeof spec.startRef, "string");
});

// --- top-level shapes the adapters observe (single range, topic, summaryMaxChars) ---

test("parseCompressArgs accepts a single range at the top level (no content array)", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    startRef: "m00001",
    endRef: "m00002",
    summary: "single",
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.startRef, "m00001");
  assert.equal(ranges[0]!.endRef, "m00002");
  assert.equal(ranges[0]!.summary, "single");
});

test("parseCompressArgs accepts a top-level single range with startId/endId variants", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    startId: "m00001",
    endId: "m00002",
    summary: "single",
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.startRef, "m00001");
});

test("parseCompressArgs reports missing-content when there is no content and no valid single range", () => {
  const { ranges, diagnostics } = parseCompressArgs({ foo: "bar" });
  assert.equal(diagnostics.kind, "missing-content");
  assert.equal(ranges.length, 0);
});

test("parseCompressArgs applies a top-level topic to ranges without their own", () => {
  const { ranges } = parseCompressArgs({
    topic: "Top",
    content: [
      { startRef: "m00001", endRef: "m00002", summary: "a" },
      { startRef: "m00003", endRef: "m00004", summary: "b", topic: "Own" },
    ],
  });
  assert.equal(ranges[0]!.topic, "Top");
  assert.equal(ranges[1]!.topic, "Own");
});

test("parseCompressArgs applies a top-level summaryMaxChars to ranges without their own", () => {
  const { ranges } = parseCompressArgs({
    summaryMaxChars: 5000,
    content: [
      { startRef: "m00001", endRef: "m00002", summary: "a" },
      {
        startRef: "m00003",
        endRef: "m00004",
        summary: "b",
        summaryMaxChars: 999,
      },
    ],
  });
  assert.equal(ranges[0]!.summaryMaxChars, 5000);
  assert.equal(ranges[1]!.summaryMaxChars, 999);
});

// --- line-form entries (#non-strict-tool providers) ------------------------

test("line form: array of strings — refs header, optional topic, verbatim markdown summary", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: [
      'm00150–m00220 debug part 1\n## Fixed the loop\nbody with | pipes | and "quotes" and \\backslashes\\',
      "m00300-m00350\nplain summary without heading",
    ],
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.startRef, "m00150");
  assert.equal(ranges[0]!.endRef, "m00220");
  assert.equal(ranges[0]!.topic, "debug part 1");
  assert.equal(
    ranges[0]!.summary,
    '## Fixed the loop\nbody with | pipes | and "quotes" and \\backslashes\\',
  );
  assert.equal(ranges[1]!.startRef, "m00300");
  assert.equal(ranges[1]!.endRef, "m00350");
  assert.equal(ranges[1]!.topic, "plain summary without heading");
});

test("line form: topic derived from first markdown heading, else first line, truncated to 60", () => {
  const { ranges } = parseCompressArgs({
    content: [
      "m00010–m00020\n## The Heading Wins\ndetail",
      "m00030–m00040\nfirst plain line is the topic\nmore",
      "m00050–m00060\n" + "x".repeat(80) + "\ntail",
    ],
  });
  assert.equal(ranges[0]!.topic, "The Heading Wins");
  assert.equal(ranges[1]!.topic, "first plain line is the topic");
  assert.equal(ranges[2]!.topic!.length, 60);
});

test("line form: mixed with legacy object entries — each validated independently", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: [
      "m00001–m00002\nstring entry summary",
      {
        startId: "m00003",
        endId: "m00004",
        summary: "object entry",
        topic: "Obj",
      },
      "no refs here at all\nsummary",
      { startId: "m00005" },
    ],
  });
  assert.equal(ranges.length, 2);
  assert.equal(diagnostics.invalidItems, 2);
  assert.equal(ranges[0]!.summary, "string entry summary");
  assert.equal(ranges[1]!.topic, "Obj");
});

test("line form: single string entry (header + summary) and single bare-ref entry", () => {
  const a = parseCompressArgs({ content: ["m00007—m00009\nsummary here"] });
  assert.equal(a.ranges.length, 1);
  assert.equal(a.ranges[0]!.startRef, "m00007");
  assert.equal(a.ranges[0]!.endRef, "m00009");
  const b = parseCompressArgs({ content: ["m00042 lone ref line\nsummary"] });
  assert.equal(b.ranges[0]!.startRef, "m00042");
  assert.equal(b.ranges[0]!.endRef, "m00042");
});

test("line form: all spec separators — tilde, to, unicode ellipsis, three dots", () => {
  for (const header of [
    "m00150~m00220",
    "m00150 to m00220",
    "m00150…m00220",
    "m00150...m00220",
  ]) {
    const { ranges, diagnostics } = parseCompressArgs({
      content: [`${header}\nsum`],
    });
    assert.equal(
      diagnostics.kind,
      "ok",
      `separator in ${JSON.stringify(header)}`,
    );
    assert.equal(
      ranges[0]!.startRef,
      "m00150",
      `separator in ${JSON.stringify(header)}`,
    );
    assert.equal(
      ranges[0]!.endRef,
      "m00220",
      `separator in ${JSON.stringify(header)}`,
    );
  }
});

test("line form: header line with no summary after it is dropped, others survive", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: ["m00001–m00005 topic\nfirst summary", "m00010–m00012"],
  });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.summary, "first summary");
  assert.equal(diagnostics.invalidItems, 1);
  assert.ok(diagnostics.invalidReasons?.[0]?.includes("missing summary"));
});

test("line form: bare string content (not JSON) splits on ref-pair header lines", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content:
      "m00100–m00110 part A\n## A\nsummary A\nm00200–m00220 part B\nsummary B",
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.topic, "part A");
  assert.equal(ranges[0]!.summary, "## A\nsummary A");
  assert.equal(ranges[1]!.summary, "summary B");
});

test("line form: stringified array of line-form strings salvages through the string path", () => {
  const { ranges } = parseCompressArgs(
    JSON.stringify({
      content: ["m00111–m00122\nsum one", "m00333–m00344 t2\nsum two"],
    }),
  );
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.summary, "sum one");
  assert.equal(ranges[1]!.topic, "t2");
});

test("line form: an empty string entry is invalid, not a crash", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: ["", "m00001–m00002\nok"],
  });
  assert.equal(ranges.length, 1);
  assert.equal(diagnostics.invalidItems, 1);
});

test("line form: bN block refs (multi-tier folds) with short ids", () => {
  const { ranges } = parseCompressArgs({
    content: [
      "b3–b15 tier fold\n## Folded\nsummary of blocks",
      "b2 lone block\nsummary",
    ],
  });
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]!.startRef, "b3");
  assert.equal(ranges[0]!.endRef, "b15");
  assert.equal(ranges[1]!.startRef, "b2");
  assert.equal(ranges[1]!.endRef, "b2");
});

test("line form: m refs zero-pad like the object form", () => {
  const { ranges } = parseCompressArgs({ content: ["m150–m220 pad\nsummary"] });
  assert.equal(ranges[0]!.startRef, "m00150");
  assert.equal(ranges[0]!.endRef, "m00220");
});

test("line form: refs cited inside the summary body never become the range", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: [
      "m00042 lone ref line\nEarlier I compressed m00300–m00400 for the auth work.\nDetails here.",
    ],
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.startRef, "m00042");
  assert.equal(ranges[0]!.endRef, "m00042");
  assert.equal(
    ranges[0]!.summary,
    "Earlier I compressed m00300–m00400 for the auth work.\nDetails here.",
  );
});

test("line form: entry whose first line has no refs is dropped, not salvaged from later lines", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: [
      "Summary of work\nm00150–m00220 were discussed before\nmore detail",
      "m00001–m00002 ok entry\nfine",
    ],
  });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.startRef, "m00001");
  assert.equal(diagnostics.invalidItems, 1);
  assert.ok(
    diagnostics.invalidReasons?.[0]?.includes("no mNNNNN/bN refs in header"),
  );
});

test("line form: header matches on the first line only — body ref citations cannot hijack the range", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: [
      "## Auth exploration\nFound token in m00042. Decisions made:\n- chose X because Y",
      "Explored the range m00150–m00220 earlier.\nSummary body here",
      "m00007–m00009 real header\ncites m00065 and m00150–m00220 in the body",
    ],
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(diagnostics.invalidItems, 2);
  assert.ok(
    diagnostics.invalidReasons?.every((r) =>
      r.includes("no mNNNNN/bN refs in header"),
    ),
  );
  assert.equal(ranges[0]!.startRef, "m00007");
  assert.equal(ranges[0]!.endRef, "m00009");
  assert.equal(
    ranges[0]!.summary,
    "cites m00065 and m00150–m00220 in the body",
  );
});

test("line form: CRLF header line parses; trailing \\r trimmed from topic", () => {
  const { ranges } = parseCompressArgs({
    content: ["m00001–m00005 crlf topic\r\nbody line"],
  });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]!.topic, "crlf topic");
  assert.equal(ranges[0]!.summary, "body line");
});

// ---------------------------------------------------------------------------
// Parser-position repair: compound damage (raw control chars + invalid escapes)
// ---------------------------------------------------------------------------

test("parseCompressArgs repairs compound damage: raw newlines + invalid escapes in one stringified payload", () => {
  // Production shape (01a09a0b): vLLM-stringified content array whose summary
  // has REAL raw newlines AND markdown backslash-escapes, unescaped.
  const summary =
    "m00066-m00081 Investigation reads: exact pre-edit code\n\n" +
    "## Files to modify (`src/x.ts`)\n" +
    "and some \\*markdown\\* with a \\`tick\\`";
  const arrStr =
    '[{"startRef": "m00066", "endRef": "m00081", "summary": "' +
    summary +
    '"}]';
  const { ranges, diagnostics } = parseCompressArgs({ content: arrStr });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.ok, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m00066");
  assert.equal(ranges[0]?.endRef, "m00081");
  assert.equal(ranges[0]?.summary, summary);
});

test("parseCompressArgs repairs multiple scattered control chars in one pass", () => {
  const summary = "line one\ttabbed\rreturn\nnewline then a \\*star\\*";
  const doc =
    '{"content": [{"startRef": "m00001", "endRef": "m00002", "summary": "' +
    summary +
    '"}]}';
  const { ranges, diagnostics } = parseCompressArgs(doc);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, summary);
});

test("parseCompressArgs keeps an invalid escape's backslash literally in the value", () => {
  // `\X` is invalid JSON; repair doubles it so the parsed value keeps `\X`.
  const doc =
    '{"content": [{"startRef": "m00001", "endRef": "m00002", "summary": "a \\* b"}]}';
  const { ranges, diagnostics } = parseCompressArgs(doc);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges[0]?.summary, "a \\* b");
});

test("parseCompressArgs leaves valid JSON and structural garbage untouched by the repair", () => {
  const valid = JSON.stringify({
    content: [{ startRef: "m00001", endRef: "m00002", summary: "clean" }],
  });
  assert.equal(parseCompressArgs(valid).diagnostics.kind, "ok");
  const garbage =
    '{"content": [{"startRef": "m00001", "summary": "unterminated';
  const g = parseCompressArgs(garbage);
  assert.ok(
    g.diagnostics.kind === "truncated" ||
      g.diagnostics.kind === "malformed-json",
  );
  assert.equal(g.ranges.length, 0);
});

test("parseCompressArgs maps non-named control chars through \\uXXXX escapes", () => {
  const summary = "a\u0001b";
  const doc =
    '{"content": [{"startRef": "m00001", "endRef": "m00002", "summary": "' +
    summary +
    '"}]}';
  const { ranges, diagnostics } = parseCompressArgs(doc);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges[0]?.summary, summary);
});

// ---------------------------------------------------------------------------
// #1001 problem 3: split-element line form — refs header and summary as
// SIBLING array elements instead of one multi-line string. The header-only
// entry must adopt the following refless string(s) as its summary body.
// ---------------------------------------------------------------------------

test("parseCompressArgs coalesces a split line-form entry (header + summary siblings) (#1001)", () => {
  const input = {
    content: [
      "m01588\u2013m01712 走bili UI move + proxy 调试",
      "## TASK AS OF THIS BLOCK\n- user goal\n- decisions with reasons",
    ],
  };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.invalidItems, 0);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m01588");
  assert.equal(ranges[0]?.endRef, "m01712");
  assert.equal(
    ranges[0]?.summary,
    "## TASK AS OF THIS BLOCK\n- user goal\n- decisions with reasons",
  );
  assert.equal(ranges[0]?.topic, "走bili UI move + proxy 调试");
});

test("parseCompressArgs coalesces multiple summary siblings onto one header-only entry (#1001)", () => {
  const input = {
    content: ["m00150\u2013m00220", "first summary chunk", "second chunk"],
  };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "first summary chunk\nsecond chunk");
});

test("parseCompressArgs keeps a stray refless string invalid after a complete line entry (#1001)", () => {
  const input = {
    content: [
      "m00001\u2013m00002 topic\nreal summary",
      "## stray with no pending header",
    ],
  };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "real summary");
  assert.equal(diagnostics.invalidItems, 1);
});

test("parseCompressArgs still rejects a header-only entry with nothing to adopt (#1001)", () => {
  const input = { content: ["m00001\u2013m00002 topic"] };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(ranges.length, 0);
  assert.equal(diagnostics.kind, "no-valid-ranges");
  assert.match(
    String(diagnostics.invalidReasons?.[0] ?? ""),
    /missing summary/,
  );
});

test("parseCompressArgs resets the adoption pairing at an object entry (#1001)", () => {
  const input = {
    content: [
      { startRef: "m00001", endRef: "m00002", summary: "good" },
      "orphan summary body",
    ],
  };
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "good");
  assert.equal(diagnostics.invalidItems, 1);
});

// ---------------------------------------------------------------------------
// #470: content given as a single entry OBJECT instead of a one-element array
// (retry drift observed via billion-context #1494/#1495). The top level already
// recovers a bare entry object without content; the SAME shape inside content
// used to hard-fail with content-not-array. Both lanes (proxy normalizer
// billion-context#1497 and plugin-mode bundled kernel) must agree here.
// ---------------------------------------------------------------------------

test("parseCompressArgs wraps a single entry object in the content slot (#470)", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: {
      startId: "m04083",
      endId: "m04092",
      summary: "lost range retry",
    },
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.contentSalvage, true);
  assert.equal(diagnostics.invalidItems, 0);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m04083");
  assert.equal(ranges[0]?.endRef, "m04092");
  assert.equal(ranges[0]?.summary, "lost range retry");
});

test("parseCompressArgs keeps per-entry topic/summaryMaxChars on a wrapped entry (#470)", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: {
      startRef: "m00001",
      endRef: "m00002",
      summary: "s",
      topic: "Own",
      summaryMaxChars: 1234,
    },
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.topic, "Own");
  assert.equal(ranges[0]?.summaryMaxChars, 1234);
});

test("parseCompressArgs applies a top-level topic to a wrapped single entry (#470)", () => {
  const { ranges } = parseCompressArgs({
    topic: "Top",
    content: { startRef: "m00001", endRef: "m00002", summary: "s" },
  });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.topic, "Top");
});

test("parseCompressArgs stamps compressCallId through the wrap (#470)", () => {
  const { ranges } = parseCompressArgs(
    { content: { startRef: "m00001", endRef: "m00002", summary: "s" } },
    { callId: "call-470" },
  );
  assert.equal(ranges[0]?.compressCallId, "call-470");
});

test("parseCompressArgs recovers string-encoded single-object content (#470)", () => {
  const input = JSON.stringify({
    content: { startId: "m04083", endId: "m04092", summary: "str" },
  });
  const { ranges, diagnostics } = parseCompressArgs(input);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.contentSalvage, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m04083");
  assert.equal(ranges[0]?.summary, "str");
});

test("parseCompressArgs recovers fenced double-stringified single-object content (#470)", () => {
  const inner = JSON.stringify(
    JSON.stringify({
      content: { startId: "m00001", endId: "m00002", summary: "solo" },
    }),
  );
  const { ranges, diagnostics } = parseCompressArgs(
    "```json\n" + inner + "\n```",
  );
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.contentSalvage, true);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.summary, "solo");
});

test("parseCompressArgs unwraps a nested ranges array in the content slot (#470)", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: {
      ranges: [
        { startRef: "m00001", endRef: "m00002", summary: "a" },
        { startRef: "m00003", endRef: "m00004", summary: "b" },
      ],
    },
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.contentSalvage, true);
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0]?.summary, "a");
  assert.equal(ranges[1]?.summary, "b");
});

test("parseCompressArgs degrades a wrapped garbage object to per-entry reasons, not opaque content-not-array (#470)", () => {
  const { ranges, diagnostics } = parseCompressArgs({ content: { foo: 1 } });
  assert.equal(ranges.length, 0);
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.kind, "no-valid-ranges");
  assert.equal(diagnostics.contentSalvage, true);
  assert.equal(diagnostics.invalidItems, 1);
  assert.ok(
    diagnostics.invalidReasons?.[0]?.includes("missing range bounds"),
    JSON.stringify(diagnostics),
  );
});

test("parseCompressArgs reports missing fields on an incomplete wrapped entry (#470)", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: { startId: "m00001", endId: "m00002" },
  });
  assert.equal(ranges.length, 0);
  assert.equal(diagnostics.kind, "no-valid-ranges");
  assert.equal(diagnostics.invalidItems, 1);
  assert.ok(
    diagnostics.invalidReasons?.[0]?.includes("missing summary"),
    JSON.stringify(diagnostics),
  );
});

test("parseCompressArgs drops a truncated single-object content entry without guessing (#470)", () => {
  const { ranges, diagnostics } = parseCompressArgs(
    '{"content": {"startId": "m00001", "endId": "m0',
  );
  assert.equal(ranges.length, 0);
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.kind, "truncated");
});

test("parseCompressArgs keeps content-not-array for non-object content values (#470)", () => {
  for (const input of [{ content: 42 }, { content: null }, { content: true }]) {
    const { ranges, diagnostics } = parseCompressArgs(input);
    assert.equal(diagnostics.kind, "content-not-array", JSON.stringify(input));
    assert.equal(diagnostics.ok, false);
    assert.equal(diagnostics.contentSalvage, undefined, JSON.stringify(input));
    assert.equal(ranges.length, 0);
  }
});

test("parseCompressArgs leaves canonical array inputs unmarked by contentSalvage (#470)", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: [{ startRef: "m00001", endRef: "m00002", summary: "clean" }],
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.contentSalvage, undefined);
  assert.equal(ranges.length, 1);
});

test("rebuildCompressionState rebuilds from a single-object content tool-call (#470)", () => {
  const args = JSON.stringify({
    content: { startId: "m00001", endId: "m00002", summary: "single object" },
  });
  const result = rebuildCompressionState(
    createInitialState(),
    rebuildMessages(args, "call1"),
    rebuildConfig(),
  );
  assert.equal(result.blocksRebuilt, 1);
  assert.ok(
    result.state.blocks.find((b) => b.summary.includes("single object")),
  );
});

test("one bare string may carry a whole batch: every tool surface recommends it (#472)", () => {
  // The default/lean packs + the nudge hint now teach this form as the
  // gateway-robust way to batch — pin the parse so it cannot regress.
  const { ranges, diagnostics } = parseCompressArgs({
    content:
      "m00001–m00005 topic one\nsummary one line.\nm00006–m00008\ntopic-less summary.",
  });
  assert.equal(diagnostics.kind, "ok");
  assert.equal(diagnostics.invalidItems, 0);
  assert.equal(ranges.length, 2);
  assert.deepEqual(
    {
      start: ranges[0]?.startRef,
      end: ranges[0]?.endRef,
      topic: ranges[0]?.topic,
      summary: ranges[0]?.summary,
    },
    {
      start: "m00001",
      end: "m00005",
      topic: "topic one",
      summary: "summary one line.",
    },
  );
  assert.deepEqual(
    {
      start: ranges[1]?.startRef,
      end: ranges[1]?.endRef,
      summary: ranges[1]?.summary,
    },
    { start: "m00006", end: "m00008", summary: "topic-less summary." },
  );
});

// ---------------------------------------------------------------------------
// Line-form fallback: linear-time split (ReDoS regression)
// ---------------------------------------------------------------------------

test("line-form split stays linear on a long whitespace run", () => {
  for (const content of [
    "x" + "\n".repeat(50_000) + "x",
    'x\n",' + " ".repeat(50_000) + "x",
    "x" + " ".repeat(50_000) + "y]",
  ]) {
    const started = performance.now();
    const { diagnostics } = parseCompressArgs({ content });
    const elapsed = performance.now() - started;
    assert.equal(diagnostics.kind, "content-not-array");
    assert.ok(elapsed < 2000, `line-form parse took ${elapsed.toFixed(0)}ms`);
  }
});

test("line-form split still breaks on headers after blank lines and element residue", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content:
      'm00001-m00005 first\nsummary one.\n\n  "m00006-m00008 second\nsummary two."\n\t\n"m00009-m00010\nsummary three.',
  });
  assert.equal(diagnostics.kind, "ok");
  assert.deepEqual(
    ranges.map((r) => [r.startRef, r.endRef, r.summary]),
    [
      ["m00001", "m00005", "summary one."],
      ["m00006", "m00008", "summary two."],
      ["m00009", "m00010", "summary three."],
    ],
  );
});

// ---------------------------------------------------------------------------
// Flat single-range: summary text in the content STRING + top-level bounds
// ({content, startId, endId, topic?}) — the two schema-advertised shapes
// merged into one call. Observed live as repeated kind=content-not-array
// rejections while the model retried the same valid-intent compress.
// ---------------------------------------------------------------------------

test("parseCompressArgs recovers a flat single-range call with summary text in content", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: "Summary of the folded range.\nSecond line of the summary.",
    startId: "m00150",
    endId: "m00168",
  });
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.flatSummarySalvage, true);
  assert.equal(diagnostics.kind, "ok");
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m00150");
  assert.equal(ranges[0]?.endRef, "m00168");
  assert.equal(ranges[0]?.summary, "Summary of the folded range.\nSecond line of the summary.");
});

test("parseCompressArgs flat single-range keeps top-level topic and ref variants", () => {
  const { ranges } = parseCompressArgs({
    content: "The summary text.",
    startRef: "m00002",
    endRef: "m00009",
    topic: "repro loop",
  });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.startRef, "m00002");
  assert.equal(ranges[0]?.endRef, "m00009");
  assert.equal(ranges[0]?.topic, "repro loop");
});

test("parseCompressArgs flat single-range unwraps a JSON-encoded {summary,topic} in content", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: JSON.stringify({ summary: "encoded summary", topic: "inner topic" }),
    startId: "m00001",
    endId: "m00004",
  });
  assert.equal(diagnostics.flatSummarySalvage, true);
  assert.equal(ranges[0]?.summary, "encoded summary");
  assert.equal(ranges[0]?.topic, "inner topic");
});

test("parseCompressArgs flat single-range prefers an explicit top-level summary over content text", () => {
  const { ranges } = parseCompressArgs({
    content: "ignored prose",
    summary: "explicit summary wins",
    startId: "m00001",
    endId: "m00002",
  });
  assert.equal(ranges[0]?.summary, "explicit summary wins");
});

test("parseCompressArgs does NOT apply flat single-range when content carries refs headers", () => {
  // Line-form material keeps its line-form reading even with top-level refs:
  // valid headers parse as ranges...
  const ok = parseCompressArgs({
    content: "m00010–m00020 topic\nsummary text.",
    startId: "m00001",
    endId: "m00099",
  });
  assert.equal(ok.ranges.length, 1);
  assert.equal(ok.ranges[0]?.startRef, "m00010");
  assert.equal(ok.diagnostics.flatSummarySalvage, undefined);
  // ...and header-only entries report the missing summary, not a salvage.
  const bad = parseCompressArgs({
    content: "m00010–m00020 topic only",
    startId: "m00001",
    endId: "m00099",
  });
  assert.equal(bad.diagnostics.ok, false);
  assert.equal(bad.diagnostics.flatSummarySalvage, undefined);
  assert.equal(bad.diagnostics.kind, "no-valid-ranges");
  assert.match(bad.diagnostics.invalidReasons?.[0] ?? "", /missing summary/);
});

test("parseCompressArgs keeps headerless prose without top-level refs as content-not-array", () => {
  const { diagnostics } = parseCompressArgs({ content: "just prose, no refs, no bounds" });
  assert.equal(diagnostics.kind, "content-not-array");
  assert.equal(diagnostics.flatSummarySalvage, undefined);
});

test("parseCompressArgs reports header-only line entries as no-valid-ranges with reasons", () => {
  const { diagnostics } = parseCompressArgs({
    content: "m00010–m00020 topic one\nsummary ok.\nm00030–m00040 topic two",
  });
  assert.equal(diagnostics.kind, "ok"); // 1 valid + 1 invalid
  assert.equal(diagnostics.invalidItems, 1);
  assert.match(diagnostics.invalidReasons?.[0] ?? "", /missing summary/);
  const none = parseCompressArgs({ content: "m00010–m00020 topic only" });
  assert.equal(none.diagnostics.kind, "no-valid-ranges");
  assert.match(none.diagnostics.invalidReasons?.[0] ?? "", /missing summary/);
});

// ---------------------------------------------------------------------------
// Refs separator variants: a pair divider outside the recognized dash class
// must never silently narrow the range to its first ref.
// ---------------------------------------------------------------------------

test("parseCompressArgs accepts U+2212 minus and fullwidth hyphen as range separators", () => {
  const minus = parseCompressArgs({ content: "m00150−m00168 topic\nsummary." });
  assert.equal(minus.ranges[0]?.startRef, "m00150");
  assert.equal(minus.ranges[0]?.endRef, "m00168");
  const fw = parseCompressArgs({ content: "m00150－m00168 topic\nsummary." });
  assert.equal(fw.ranges[0]?.startRef, "m00150");
  assert.equal(fw.ranges[0]?.endRef, "m00168");
});

test("parseCompressArgs refuses to narrow a ref pair with an unrecognized separator", () => {
  const { ranges, diagnostics } = parseCompressArgs({
    content: "m00150 => m00168 topic\nsummary.",
  });
  assert.equal(ranges.length, 0);
  assert.equal(diagnostics.kind, "no-valid-ranges");
  assert.match(diagnostics.invalidReasons?.[0] ?? "", /separator not recognized/);
  // A legit single-ref header with a punctuation topic still parses.
  const single = parseCompressArgs({ content: "m00150 — intro notes\nsummary." });
  assert.equal(single.ranges[0]?.startRef, "m00150");
  assert.equal(single.ranges[0]?.endRef, "m00150");
});
