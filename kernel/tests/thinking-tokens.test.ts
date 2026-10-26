import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { countMessageTokens, defaultCountTokens } from "../src/tokenize.js";
import {
  buildCompressibleRanges,
  computeProtectedRefs,
} from "../src/recommend.js";
import { renderVisibleRefs } from "../src/render-refs.js";
import type { Config, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
  thinkingTokens?: number,
): CoreMessage {
  return {
    id,
    role,
    contentType: "text",
    text,
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
  };
}

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
      growthFloor: 6000,
      growthCap: 50000,
      minGrowthFloor: 5000,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
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

test("countMessageTokens sums visible text and projected thinking", () => {
  const text = "hello world";
  assert.equal(countMessageTokens({ text }), defaultCountTokens(text));
  assert.equal(countMessageTokens({}), 0);
  assert.equal(
    countMessageTokens({ text, thinkingTokens: 500 }),
    defaultCountTokens(text) + 500,
  );
});

test("countMessageTokens ignores missing or invalid thinking payloads", () => {
  const text = "hello world";
  const base = defaultCountTokens(text);
  assert.equal(countMessageTokens({ text, thinkingTokens: undefined }), base);
  assert.equal(countMessageTokens({ text, thinkingTokens: NaN }), base);
  assert.equal(countMessageTokens({ text, thinkingTokens: -5 }), base);
  assert.equal(
    countMessageTokens({ text, thinkingTokens: Number.POSITIVE_INFINITY }),
    base,
  );
  assert.equal(countMessageTokens({ text, thinkingTokens: 0 }), base);
});

test("processTurn preserves thinkingTokens on surviving messages", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("a", "first user line"),
    msg("b", "assistant reply", "assistant", 777),
    msg("c", "second user line"),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const turn = core.processTurn({
    messages,
    state,
    config: config(),
    tokenCount: 1000,
  });
  const out = turn.messages.find((m) => m.id === "b");
  assert.ok(out, "message b must survive the pipeline");
  assert.equal(out!.thinkingTokens, 777);
});

test("ref tag token attribute carries the metered total including thinking", () => {
  const state = createInitialState();
  const messages = [msg("a", "some visible text", "assistant", 500)];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const rendered = renderVisibleRefs(messages, state, defaultCountTokens);
  const out = rendered[0]!;
  const match = /tokens="(\d+)"/.exec(out.text ?? "");
  assert.ok(match, "ref tag with tokens attribute expected");
  assert.equal(
    Number(match![1]),
    defaultCountTokens("some visible text") + 500,
  );
});

test("applyCompression records projected thinking in block compressedTokens", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("a", "alpha beta", "user"),
    msg("b", "gamma delta", "assistant", 4321),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const result = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00002",
        summary: "both summarized",
        topic: "t",
      },
    ],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.result.errors.length, 0);
  const block = result.state.blocks[0]!;
  assert.equal(
    block.compressedTokens,
    defaultCountTokens("alpha beta") + defaultCountTokens("gamma delta") + 4321,
  );
});

test("buildCompressibleRanges totals include projected thinking", () => {
  const state = createInitialState();
  const messages = [
    msg("a", "alpha beta", "user"),
    msg("b", "gamma delta", "assistant", 4321),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const cfg = config();
  const ranges = buildCompressibleRanges(
    messages,
    state,
    cfg,
    computeProtectedRefs(messages, state, cfg),
  );
  assert.ok(
    ranges.compressible.length > 0,
    "expected at least one compressible range",
  );
  const charsTotal = ranges.compressible.reduce((s, r) => s + r.chars, 0);
  assert.equal(
    charsTotal,
    "alpha beta".length + "gamma delta".length,
    "chars must stay text-only",
  );
  const total = ranges.compressible.reduce((s, r) => s + r.tokens, 0);
  assert.equal(
    total,
    defaultCountTokens("alpha beta") + defaultCountTokens("gamma delta") + 4321,
  );
});

test("ref tag ignores missing or invalid thinking payloads", () => {
  const state = createInitialState();
  const messages = [msg("a", "some visible text", "assistant", Number.NaN)];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const rendered = renderVisibleRefs(messages, state, defaultCountTokens);
  const out = rendered[0]!;
  const match = /tokens="(\d+)"/.exec(out.text ?? "");
  assert.ok(match, "ref tag with tokens attribute expected");
  assert.equal(Number(match![1]), defaultCountTokens("some visible text"));
});
