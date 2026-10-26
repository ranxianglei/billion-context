import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { defaultCountTokens, estimateTokensFast } from "../src/tokenize.js";
import type { Config, CompressionState, CoreMessage } from "../src/types.js";

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

function withRefs(messages: CoreMessage[]): CompressionState {
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return state;
}

function breakdownLine(report: string): string {
  const line = report.split("\n").find((l) => l.includes("tool ("));
  assert.ok(line, `no breakdown line in:\n${report}`);
  return line;
}

test("breakdown counts tool-results in the tool bucket (issue #390)", () => {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "run the build" },
    {
      id: "m2",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "c1",
      text: "npm test",
    },
    // wire converters never set toolName on the result side
    {
      id: "m3",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "c1",
      text: "x".repeat(51_361),
    },
  ];
  const state = withRefs(messages);
  const report = buildStatusReport(state, messages, defaultCountTokens);
  // tool = ceil(51361/4) + ceil(8/4) = 12843, text = ceil(13/4) = 4
  assert.match(breakdownLine(report), /12\.8K tool \(100%\)/);
  assert.match(breakdownLine(report), /4 text \(0%\)/);
  assert.match(report, /Top tools: bash \(100%\)/);
});

test("breakdown tool split corroborates compressible-range toolPct (issue #390)", () => {
  const messages: CoreMessage[] = [
    {
      id: "m1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "c1",
      text: "ls",
    },
    {
      id: "m2",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "c1",
      text: "y".repeat(40_000),
    },
  ];
  const state = withRefs(messages);
  const ranges = buildCompressibleRanges(
    messages,
    state,
    config(),
    new Set(),
    defaultCountTokens,
  );
  assert.equal(ranges.compressible.length, 1);
  const range = ranges.compressible[0]!;
  // same message set, both surfaces must agree: all-tool
  assert.equal(range.toolPct, 100);
  assert.equal(range.textPct, 0);
  assert.match(
    breakdownLine(buildStatusReport(state, messages, defaultCountTokens)),
    /100%\)/,
  );
});

test("pct has no 1% floor — tiny buckets print 0% and sums stay <= 100 (issue #390)", () => {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "z".repeat(4000) }, // 1000 tokens
    {
      id: "m2",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "c1",
      text: "ls",
    }, // 1 token
  ];
  const state = withRefs(messages);
  const line = breakdownLine(
    buildStatusReport(state, messages, defaultCountTokens),
  );
  assert.match(line, /1 tool \(0%\)/);
  assert.match(line, /1\.0K text \(100%\)/);
  const pcts = [...line.matchAll(/(\d+)%/g)].map((m) => Number(m[1]!));
  assert.ok(
    pcts.reduce((s, n) => s + n, 0) <= 100,
    `bucket percents must not exceed 100: ${line}`,
  );
});

test("breakdown uses the injected estimator — CJK is not 4x-underestimated (issue #390)", () => {
  const messages: CoreMessage[] = [
    { id: "m1", role: "user", contentType: "text", text: "中".repeat(4000) },
  ];
  const state = withRefs(messages);
  assert.match(
    breakdownLine(buildStatusReport(state, messages, defaultCountTokens)),
    /4\.0K text \(100%\)/,
  );
  assert.match(
    breakdownLine(buildStatusReport(state, messages, estimateTokensFast)),
    /1\.0K text \(100%\)/,
  );
});

test("tool-result without a resolvable call stays in the tool bucket", () => {
  const messages: CoreMessage[] = [
    {
      id: "m1",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "orphan",
      text: "w".repeat(4000),
    },
  ];
  const state = withRefs(messages);
  const report = buildStatusReport(state, messages, defaultCountTokens);
  assert.match(breakdownLine(report), /1\.0K tool \(100%\)/);
  assert.match(report, /Top tools: tool \(100%\)/);
});

test("message drilldown filters results by resolved tool name", () => {
  const messages: CoreMessage[] = [
    {
      id: "m1",
      role: "assistant",
      contentType: "tool-call",
      toolName: "bash",
      toolCallId: "c1",
      text: "ls",
    },
    {
      id: "m2",
      role: "tool",
      contentType: "tool-result",
      toolCallId: "c1",
      text: "y".repeat(4000),
    },
  ];
  const state = withRefs(messages);
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "messages",
    tool: "bash",
  });
  assert.match(report, /bash: .* \| 2 msgs/);
});
