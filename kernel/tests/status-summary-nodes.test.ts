import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { SUMMARY_HEADER, summaryMessageId } from "../src/prune.js";
import type {
  Config,
  CompressionBlock,
  CoreMessage,
  CompressionState,
} from "../src/types.js";

/**
 * Rendered block-summary nodes (id acp_summary_bN, role system) are already
 * compressed mass: the injected nudge table never offers them as plain
 * compressible ranges (it skips them and splits there), and the only fold
 * that consumes them is tier distillation with block-ID boundaries. The
 * uncompressed status view must align with that nudge logic:
 *   - no per-range row may list or bridge over a summary node;
 *   - their mass shows in a labeled section pointing at distillation;
 *   - their mass is not double-counted (overview "text" bucket + summary
 *     ledger both claimed it before);
 *   - the view carries the exact compress() call shape for the raw ranges.
 */

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

function summaryNode(blockId: string, body: string): CoreMessage {
  return {
    id: summaryMessageId(blockId),
    role: "system",
    contentType: "text",
    text: `${SUMMARY_HEADER}\n${body}`,
  };
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

function assignAll(
  messages: CoreMessage[],
  state: CompressionState = createInitialState(),
): CompressionState {
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

interface ParsedRange {
  startRef: string;
  endRef: string;
  count: number;
}

function parseRanges(report: string): ParsedRange[] {
  return [
    ...report.matchAll(/^  (m\d+)(?:\u2013(m\d+))?\s+\((\d+) msgs,/gm),
  ].map((m) => ({
    startRef: m[1]!,
    endRef: m[2] ?? m[1]!,
    count: Number(m[3]),
  }));
}

function uncompressed(
  state: CompressionState,
  messages: CoreMessage[],
  options: Parameters<typeof buildStatusReport>[3] = {},
): string {
  return buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    ...options,
  });
}

// raw a, b — covered c, d left the array — node b1 — raw e, f
function splitFixture(): { state: CompressionState; view: CoreMessage[] } {
  const a = msg("a", "x".repeat(100), "assistant");
  const b = msg("b", "y".repeat(200), "assistant");
  const node = summaryNode("b1", "body");
  const e = msg("e", "e".repeat(50), "user");
  const f = msg("f", "f".repeat(150), "user");
  const state = assignAll([a, b, node, e, f]);
  state.blocks.push(
    block({
      blockId: "b1",
      tier: 1,
      summary: "S".repeat(300),
      effectiveMessageIds: ["c", "d"],
    }),
  );
  return { state, view: [a, b, node, e, f] };
}

test("ranges view: rendered summary nodes are excluded from rows and split the listing", () => {
  const { state, view } = splitFixture();
  const report = uncompressed(state, view, { sort: "time" });
  const ranges = parseRanges(report);
  assert.deepEqual(ranges, [
    { startRef: "m00001", endRef: "m00002", count: 2 },
    { startRef: "m00004", endRef: "m00005", count: 2 },
  ]);
  assert.ok(!report.includes("m00003  ("), "node ref must not carry a range row");
  assert.ok(
    report.includes("| 4 visible messages"),
    `header counts raw messages only, got: ${report.split("\n")[0]}`,
  );
});

test("ranges view: node mass is listed in a labeled distillation section, not as raw", () => {
  const { state, view } = splitFixture();
  const cfg = config();
  const report = uncompressed(state, view, { config: cfg, originalMessages: view });
  assert.match(report, /ALREADY-COMPRESSED SUMMARY NODES \u2014 1 node\(s\)/);
  assert.match(report, /b1 \(T1\)/);
  assert.match(
    report,
    /plain m-ref ranges do not fold them; only tier distillation \(block-ID boundaries\) does/,
  );
  assert.ok(
    report.includes("Tier distillation is not armed yet"),
    "single T1 block below tier2Trigger announces the nudge-gated path",
  );
});

test("ranges view: distillation section reuses the byte-identical tierActionHint once armed", () => {
  const n1 = summaryNode("b1", "one");
  const n2 = summaryNode("b2", "two");
  const r = msg("r", "r".repeat(80), "assistant");
  const state = assignAll([n1, n2, r]);
  state.blocks.push(
    block({ blockId: "b1", tier: 1, summary: "s1", effectiveMessageIds: ["c1"] }),
    block({ blockId: "b2", tier: 1, summary: "s2", effectiveMessageIds: ["c2"] }),
  );
  const report = uncompressed(state, [n1, n2, r], {
    config: config({ tiers: { enabled: true, tier2Trigger: 2, tier3Trigger: 10 } }),
    originalMessages: [n1, n2, r],
  });
  assert.ok(
    report.includes("Tier distillation is actionable now:"),
    report,
  );
  assert.ok(report.includes("b1\u2013b2 optional topic"), report);
});

test("ranges view: carries the static compress call shape for the raw ranges", () => {
  const { state, view } = splitFixture();
  const report = uncompressed(state, view);
  assert.ok(
    report.includes(
      'To fold one of the ranges above: compress({ content: "m00150\u2013m00220 optional topic\\n<summary markdown>" })',
    ),
    report,
  );
});

test("alignment: ranges view splits exactly where the nudge compressible table splits", () => {
  const { state, view } = splitFixture();
  const cfg = config();
  const recommended = buildCompressibleRanges(
    view,
    state,
    cfg,
    undefined,
    defaultCountTokens,
  ).compressible.map((r) => ({
    startRef: r.startRef,
    endRef: r.endRef,
    count: r.count,
  }));
  const reported = parseRanges(uncompressed(state, view, { sort: "time" }));
  assert.deepEqual(reported, recommended);
});

test("overview: summary-node mass is no longer double-counted in the text bucket", () => {
  const { state, view } = splitFixture();
  // char-exact tokenizer so the buckets are assertable: raw 100+200+50+150,
  // b1.summary 300.
  const charCount = (t: string) => t.length;
  const report = buildStatusReport(state, view, charCount);
  assert.ok(
    report.includes("0 tool (0%) | 500 text (63%) | 300 summaries (38%)"),
    report,
  );
  assert.ok(
    report.includes(
      'Tip: call again with scope:"uncompressed" for the compressible-ranges listing (view:"messages" drills into individual refs)',
    ),
    report,
  );
});

test("messages view: rendered summary nodes are not listed as per-ref rows", () => {
  const { state, view } = splitFixture();
  const report = buildStatusReport(state, view, defaultCountTokens, {
    scope: "uncompressed",
    view: "messages",
  });
  assert.ok(!/^  m00003 /m.test(report), report);
  assert.ok(report.includes("4 msgs"), report);
});

test("ranges view: only nodes, no raw — labeled empty section, no usage line", () => {
  const n1 = summaryNode("b1", "body");
  const state = assignAll([n1]);
  state.blocks.push(
    block({ blockId: "b1", summary: "s", effectiveMessageIds: ["c"] }),
  );
  const report = uncompressed(state, [n1]);
  assert.ok(report.includes("(no raw uncompressed messages)"), report);
  assert.match(report, /ALREADY-COMPRESSED SUMMARY NODES \u2014 1 node\(s\)/);
  assert.ok(
    !report.includes("To fold one of the ranges above"),
    "usage line only appears next to actual raw ranges",
  );
});
