import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompressibleRanges } from "../src/recommend.js";
import { buildStatusReport } from "../src/report.js";
import type { StatusReportOptions } from "../src/report.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type {
  Config,
  CompressionBlock,
  CoreMessage,
  CompressionState,
} from "../src/types.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.55,
      minContextLimitPct: 0.45,
      frequency: 5,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.05,
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

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function toolMsg(id: string, toolName: string): CoreMessage {
  return {
    id,
    role: "assistant",
    contentType: "tool-call",
    toolName,
    text: `call ${toolName}`,
  };
}

function assignAll(
  messages: CoreMessage[],
  state = createInitialState(),
): CompressionState {
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

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

interface ParsedRange {
  startRef: string;
  endRef: string;
  count: number;
}

// Parses the range lines of an uncompressed-ranges report:
//   "  m00001\u2013m00009  (9 msgs, 1.2K (80/msg)) bash" / "  m00010  (1 msgs, 3) text"
function parseRanges(report: string): ParsedRange[] {
  return [
    ...report.matchAll(/^  (m\d+)(?:\u2013(m\d+))?\s+\((\d+) msgs,/gm),
  ].map((m) => ({
    startRef: m[1]!,
    endRef: m[2] ?? m[1]!,
    count: Number(m[3]),
  }));
}

function uncompressedRanges(
  state: CompressionState,
  messages: CoreMessage[],
  options: Partial<StatusReportOptions> = {},
): ParsedRange[] {
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    ...options,
  });
  return parseRanges(report);
}

// ─── Cross-view consistency (#413): shared segmentation ────────────────────────

test("cross-view: append-only host — uncompressed view splits identically to compressible ranges", () => {
  // Dense refs across multiple user turns used to collapse into ONE giant
  // range in the uncompressed view (ref-arithmetic merge only). Both views now
  // run the same segmentGroups primitive over their base sets, so on a clean
  // append-only host (no blocks, no zone, no protected tools) their base sets
  // coincide and the ranges must match exactly.
  const messages = [
    msg("u1", "question one"),
    msg("a1", "answer one", "assistant"),
    toolMsg("c1", "bash"),
    msg("r1", "output one", "tool"),
    msg("u2", "question two"),
    msg("a2", "answer two", "assistant"),
    msg("u3", "question three"),
    msg("a3", "answer three", "assistant"),
    toolMsg("c3", "bash"),
    msg("r3", "output three", "tool"),
    msg("a4", "follow-up", "assistant"),
  ];
  const state = assignAll(messages);
  const cfg = config();

  const recommended = buildCompressibleRanges(
    messages,
    state,
    cfg,
    undefined,
    defaultCountTokens,
  ).compressible.map((r) => ({
    startRef: r.startRef,
    endRef: r.endRef,
    count: r.count,
  }));
  // sort:"time" puts both views in chronological order so the SPLIT is compared
  // (the default size-descending display order is asserted separately below).
  const reported = uncompressedRanges(state, messages, { sort: "time" });

  assert.deepEqual(
    reported,
    recommended,
    "both views must segment the same session identically",
  );
  assert.deepEqual(reported, [
    { startRef: "m00001", endRef: "m00004", count: 4 },
    { startRef: "m00005", endRef: "m00011", count: 7 },
  ]);
  assert.ok(
    reported.length > 1,
    "turn-aware splitting must not collapse dense refs into one range",
  );
});

test("cross-view: coverage gap splits both views at the same place", () => {
  // A message covered by an active block leaves the visible set but keeps its
  // numbered ref — it opens a gap in BOTH views (skipped entry in
  // buildCompressibleRanges, pendingGap in collectVisible).
  const messages = [
    msg("a", "x".repeat(500), "assistant"),
    msg("b", "y".repeat(500), "assistant"),
    msg("c", "z".repeat(500), "assistant"),
    msg("d", "w".repeat(500), "assistant"),
    msg("e", "v".repeat(500), "assistant"),
  ];
  const state = assignAll(messages);
  state.blocks.push(block({ effectiveMessageIds: ["c"] }));
  const cfg = config();

  const recommended = buildCompressibleRanges(
    messages,
    state,
    cfg,
    undefined,
    defaultCountTokens,
  ).compressible.map((r) => ({
    startRef: r.startRef,
    endRef: r.endRef,
    count: r.count,
  }));
  // sort:"time" puts both views in chronological order so the SPLIT is compared
  // (the default size-descending display order is asserted separately below).
  const reported = uncompressedRanges(state, messages, { sort: "time" });

  assert.deepEqual(reported, recommended);
  assert.deepEqual(reported, [
    { startRef: "m00001", endRef: "m00002", count: 2 },
    { startRef: "m00004", endRef: "m00005", count: 2 },
  ]);
});

// ─── Surface-replace hosts (#413): array adjacency, never ref arithmetic ──────

test("uncompressed view: ref-map holes do NOT fragment ranges (surface-replace host)", () => {
  // b..d left the array after compression; their refs stay assigned. Ref
  // arithmetic saw 5 !== 1+1 and emitted two singletons; array adjacency sees
  // a and e as neighbors and emits one range.
  const a = msg("a", "x".repeat(2000), "assistant");
  const e = msg("e", "v".repeat(2000), "assistant");
  const state = assignAll([a, msg("b", "y"), msg("c", "z"), msg("d", "w"), e]);
  const reported = uncompressedRanges(state, [a, e]);
  assert.deepEqual(reported, [
    { startRef: "m00001", endRef: "m00005", count: 2 },
  ]);
});

test("uncompressed view: mid-array summary node extends the range, never a descending pair", () => {
  // The host inserts its summary node mid-array; assignRefs gives it a fresh
  // HIGH ref (m00006) while the trailing message keeps m00005. Ref arithmetic
  // flushed the head and emitted the nonsense pair m00006\u2013m00005; array
  // adjacency treats the node as a regular entry: one ascending range.
  const a = msg("a", "x".repeat(2000), "assistant");
  const d = msg("d", "w".repeat(2000), "assistant");
  const e = msg("e", "v".repeat(2000), "assistant");
  const summary = msg(
    "s",
    "Summary of the compressed span: did the work.",
    "assistant",
  );
  const s1 = assignAll([a, msg("b", "y"), msg("c", "z"), d, e]);
  const state = assignAll([a, summary, d, e], s1);
  assert.equal(
    state.messageRefs.byRaw["s"],
    "m00006",
    "summary node gets a fresh high ref",
  );

  const reported = uncompressedRanges(state, [a, summary, d, e]);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.startRef, "m00001");
  assert.equal(reported[0]!.endRef, "m00005");
  assert.equal(reported[0]!.count, 4);
  assert.ok(
    Number(reported[0]!.endRef.slice(1)) >=
      Number(reported[0]!.startRef.slice(1)),
    "startRef must never exceed endRef",
  );
});

test("uncompressed view: synthetic node WITH a ref stays visible (documented divergence)", () => {
  // Deliberate view-specific semantics (#413 req 3): the compressible view
  // SKIPS synthetic "[Compressed conversation section]" nodes (they are not
  // compression candidates, so they open a gap), while the uncompressed view
  // SHOWS them — they consume visible context and triage must see them. Both
  // views still share the same grouping primitive and gap principle; only the
  // per-view membership predicate differs.
  const a = msg("a", "x".repeat(2000), "assistant");
  const e = msg("e", "v".repeat(2000), "assistant");
  const synthetic = msg(
    "s",
    "[Compressed conversation section] earlier work summarized.",
    "assistant",
  );
  const s1 = assignAll([a, msg("b", "y"), msg("c", "z"), msg("d", "w"), e]);
  const state = assignAll([a, synthetic, e], s1);
  const cfg = config();

  const recommended = buildCompressibleRanges(
    [a, synthetic, e],
    state,
    cfg,
    undefined,
    defaultCountTokens,
  ).compressible.map((r) => ({
    startRef: r.startRef,
    endRef: r.endRef,
    count: r.count,
  }));
  assert.deepEqual(recommended, [
    { startRef: "m00001", endRef: "m00001", count: 1 },
    { startRef: "m00005", endRef: "m00005", count: 1 },
  ]);

  const reported = uncompressedRanges(state, [a, synthetic, e]);
  assert.deepEqual(reported, [
    { startRef: "m00001", endRef: "m00005", count: 3 },
  ]);
});

// ─── Display enhancements preserved from PR #165 (#413 req 2) ─────────────────

function displaySession(): {
  state: CompressionState;
  messages: CoreMessage[];
} {
  const messages = [
    msg("u1", "q".repeat(10)),
    msg("a1", "a".repeat(10), "assistant"),
    toolMsg("c1", "bash"),
    msg("x1", "t".repeat(10), "assistant"),
    msg("u2", "Q".repeat(100)),
    msg("a2", "A".repeat(100), "assistant"),
    msg("a3", "B".repeat(100), "assistant"),
    msg("a4", "C".repeat(100), "assistant"),
    msg("a5", "D".repeat(100), "assistant"),
    msg("a6", "E".repeat(100), "assistant"),
    msg("a7", "F".repeat(100), "assistant"),
    msg("u3", "q".repeat(10)),
    msg("a8", "a".repeat(10), "assistant"),
  ];
  return { state: assignAll(messages), messages };
}

test("uncompressed view: default sort is size-descending with a Sorted-by header", () => {
  const { state, messages } = displaySession();
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
  });
  assert.ok(report.includes("Sorted by size"));
  // Ranges: m00001\u2013m00004 (small), m00005\u2013m00011 (large), m00012\u2013m00013 (small)
  assert.ok(
    report.indexOf("m00005\u2013m00011") < report.indexOf("m00001\u2013m00004"),
  );
  assert.ok(
    report.indexOf("m00001\u2013m00004") < report.indexOf("m00012\u2013m00013"),
  );
});

test("uncompressed view: sort:'time' restores chronological order", () => {
  const { state, messages } = displaySession();
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    sort: "time",
  });
  assert.ok(report.includes("Sorted by time"));
  assert.ok(
    report.indexOf("m00001\u2013m00004") < report.indexOf("m00005\u2013m00011"),
  );
  assert.ok(
    report.indexOf("m00005\u2013m00011") < report.indexOf("m00012\u2013m00013"),
  );
});

test("uncompressed view: limit truncates and reports remaining ranges", () => {
  const { state, messages } = displaySession();
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    limit: 2,
  });
  assert.equal(parseRanges(report).length, 2);
  assert.ok(report.includes("... and 1 more ranges"));
});
