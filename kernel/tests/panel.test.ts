import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStatusPanel,
  topicFallback,
  formatCompactTokens,
  cacheHitStats,
  formatHitRate,
} from "../src/panel/index.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { VIABLE_RANGE_MIN_TOKENS } from "../src/viable.js";

test("panel separates session accounting from sent view", () => {
  const nudge = {
    shouldInject: false,
    reason: "idle — max compressible 8106 < threshold 50000",
    compressibleRanges: [
      { startRef: "m00002", endRef: "m00005", tokens: 16 },
      { startRef: "m00010", endRef: "m00040", tokens: 8_106 },
    ],
    contextUsage: 0.43,
    tier: null,
    breakdown: { emergencyOverride: 0 },
    contextBreakdown: {
      system: 0,
      tool: 20_000,
      text: 4_000,
      code: 0,
      summaries: 0,
      total: 24_000,
      growth: 6_100,
    },
  };
  const state = {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {},
    stats: { tokensCompressed: 0 },
    nextBlockId: 1,
    nextRunId: 1,
  };
  const text = buildStatusPanel({
    version: "acp-kernel@0.0.36 (test)",
    tokenCount: 430_000,
    systemPromptTokens: 0,
    state: state as never,
    nudge: nudge as never,
    modelContextLimit: 1_000_000,
  });

  assert.match(
    text,
    /Context \(session accounting, host footer scale\): 43% \(430k \/ 1\.0M\) — includes compressed originals; shrinks slower than the sent view/,
  );
  assert.match(
    text,
    /Sent to LLM \(after compression, est\.\): 24k \(2% of limit\)/,
  );
  assert.doesNotMatch(
    text,
    /Session-only/,
    "omitted without unprunedTokens — no cross-scale subtraction",
  );
  assert.match(text, /Token Breakdown \(sent view\):/);
  assert.doesNotMatch(text, /Framework/, "no fake Framework bucket");
  const toolLine = text.split("\n").find((l) => l.trim().startsWith("Tool"))!;
  assert.match(
    toolLine,
    / 83%/,
    `bar percentages must use the sent view: ${toolLine}`,
  );
  assert.doesNotMatch(
    text,
    /m00002\.\.m00005/,
    "sub-viability ranges must not be listed",
  );
});

test("panel renders blocks with topic fallback and version line", () => {
  const state = {
    blocks: [
      {
        blockId: "b1",
        tier: 1,
        active: true,
        summary: "Plugin discovery and registration walkthrough.",
        compressedTokens: 25_000,
        effectiveMessageIds: [],
        coveredRawIds: [],
        createdAt: 1,
      },
    ],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {},
    stats: { tokensCompressed: 25_000 },
    nextBlockId: 2,
    nextRunId: 1,
  };
  const text = buildStatusPanel({
    tokenCount: 1_000,
    systemPromptTokens: 0,
    state: state as never,
    nudge: undefined,
    modelContextLimit: 200_000,
  });
  assert.match(
    text,
    /Blocks: 1 active \/ 1 total \(25k tokens compressed, cumulative\)/,
  );
  assert.match(text, /\[b1\] T1 25k→\d+.*Plugin discovery and registrat…/);
  assert.doesNotMatch(text, /acp-kernel@/, "no version line when omitted");
});

test("viability floor constant stays coupled to kernel summary rules", () => {
  assert.equal(VIABLE_RANGE_MIN_TOKENS, 200);
});

test("session-only derives on the estimation scale, never cross-scale", () => {
  // 430k provider-scale footer vs 24k sent view (chars/4). With the full
  // projection estimated at 134k on the SAME chars/4 scale, session-only
  // must read 110k — not 430k − 24k = 406k (issue #18).
  const nudge = {
    shouldInject: false,
    reason: "idle",
    contextBreakdown: {
      system: 0,
      tool: 20_000,
      text: 4_000,
      code: 0,
      summaries: 0,
      total: 24_000,
      growth: 0,
    },
  };
  const state = {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {},
    stats: { tokensCompressed: 0 },
    nextBlockId: 1,
    nextRunId: 1,
  };
  const text = buildStatusPanel({
    tokenCount: 430_000,
    systemPromptTokens: 0,
    state: state as never,
    nudge: nudge as never,
    modelContextLimit: 1_000_000,
    unprunedTokens: 134_000,
  });
  assert.match(
    text,
    /Session-only \(compressed originals, est\.\): 110k — pruned from every request/,
  );
});

test("panel session-only stays on the core's estimator scale for CJK (issue #390)", () => {
  // unpruned must be estimated with the SAME estimator the nudge breakdown
  // uses (defaultCountTokens, CJK 1:1) — not chars/4. 1000 CJK chars of
  // compressed originals = 1000 tokens on that scale (250 on chars/4).
  const sentTotal = 24_000;
  const unpruned = sentTotal + defaultCountTokens("中".repeat(1_000));
  const nudge = {
    shouldInject: false,
    reason: "idle",
    contextBreakdown: {
      system: 0,
      tool: 20_000,
      text: 4_000,
      code: 0,
      summaries: 0,
      total: 24_000,
      growth: 0,
    },
  };
  const state = {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {},
    stats: { tokensCompressed: 0 },
    nextBlockId: 1,
    nextRunId: 1,
  };
  const text = buildStatusPanel({
    tokenCount: 430_000,
    systemPromptTokens: 0,
    state: state as never,
    nudge: nudge as never,
    modelContextLimit: 1_000_000,
    unprunedTokens: unpruned,
  });
  assert.match(
    text,
    /Session-only \(compressed originals, est\.\): 1\.0k — pruned from every request/,
  );
});

test("topicFallback takes the first sentence segment, ≤30 chars", () => {
  assert.equal(
    topicFallback("Database migration steps failed twice."),
    "Database migration steps faile…",
  );
  assert.equal(topicFallback('He said "hello". More text.'), 'He said "hello"');
  assert.equal(topicFallback("Short."), "Short");
});

test("topicFallback truncates long segments at 30 chars with ellipsis", () => {
  const out = topicFallback("A".repeat(50));
  assert.equal(out.length, 31);
  assert.ok(out.endsWith("…"));
});

test("formatCompactTokens matches host footer thresholds", () => {
  assert.equal(formatCompactTokens(999), "999");
  assert.equal(formatCompactTokens(9_500), "9.5k");
  assert.equal(formatCompactTokens(430_000), "430k");
  assert.equal(formatCompactTokens(1_500_000), "1.5M");
});

test("cacheHitStats weights the session average by billed prompt tokens", () => {
  const out = cacheHitStats([
    { input: 1_000, cacheRead: 99_000, cacheWrite: 0 }, // 99% of 100k billed
    { input: 10_000, cacheRead: 0, cacheWrite: 90_000 }, // cold write, 0% served
  ]);
  assert.equal(out.requests, 2);
  assert.equal(out.cacheRead, 99_000);
  assert.equal(out.billedPrompt, 200_000);
  assert.equal(out.session, 99_000 / 200_000);
  assert.equal(out.last, 0); // write-only request still counts as last
});

test("cacheHitStats excludes requests without provider cache reporting", () => {
  const out = cacheHitStats([
    { input: 5_000, cacheRead: 0, cacheWrite: 0 }, // no cache signal → excluded
    { input: 0, cacheRead: 80_000, cacheWrite: 0 },
  ]);
  assert.equal(out.requests, 1);
  assert.equal(out.session, 1);
  assert.equal(out.last, 1);
  const none = cacheHitStats([{ input: 5_000, cacheRead: 0, cacheWrite: 0 }]);
  assert.equal(none.requests, 0);
  assert.equal(none.session, undefined);
  assert.equal(none.last, undefined);
});

test("formatHitRate clamps and formats one decimal", () => {
  assert.equal(formatHitRate(0.923), "92.3%");
  assert.equal(formatHitRate(1), "100.0%");
  assert.equal(formatHitRate(1.2), "100.0%");
  assert.equal(formatHitRate(0), "0.0%");
});

test("panel renders prompt cache line and omits it without cache signal", () => {
  const state = {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    nudge: {},
    stats: { tokensCompressed: 0 },
    nextBlockId: 1,
    nextRunId: 1,
  };
  const base = {
    tokenCount: 430_000,
    systemPromptTokens: 0,
    state: state as never,
    nudge: undefined,
    modelContextLimit: 1_000_000,
  };
  const withCache = buildStatusPanel({
    ...base,
    cacheUsages: [
      { input: 1_000, cacheRead: 99_000, cacheWrite: 0 },
      { input: 0, cacheRead: 180_000, cacheWrite: 20_000 },
    ],
  });
  // session = (99k + 180k) / (100k + 200k) = 93.0%; last = 180k/200k = 90.0%
  assert.match(
    withCache,
    /Prompt cache \(provider-reported\): 90\.0% last · 93\.0% session avg — 279k of 300k billed prompt tokens served from cache \(2 req\)/,
  );
  const noSignal = buildStatusPanel({
    ...base,
    cacheUsages: [{ input: 5_000, cacheRead: 0, cacheWrite: 0 }],
  });
  assert.doesNotMatch(
    noSignal,
    /Prompt cache/,
    "omitted when no request reported cache activity",
  );
  const omitted = buildStatusPanel(base);
  assert.doesNotMatch(
    omitted,
    /Prompt cache/,
    "omitted without cacheUsages field",
  );
});
