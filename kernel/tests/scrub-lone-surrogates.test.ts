// #816 family: a model-authored compress summary can carry an unpaired
// surrogate half (the model copies a literal \uXXXX escape out of tool output
// into the tool-call argument; JSON.parse of that argument yields a real lone
// code unit). Stored verbatim, it poisons every later request body that
// re-serializes the state — strict upstreams reject the WHOLE body with a
// non-retryable 400. These tests pin the ingest scrub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubLoneSurrogates } from "../src/truncate.js";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// Lone surrogate halves built via JSON.parse so the test source itself
// carries no unpaired code units.
const LONE_HIGH = JSON.parse('"\\ud83d"');
const LONE_LOW = JSON.parse('"\\udcca"');
const PAIR = JSON.parse('"\\ud83d\\udcca"');

function hasUnpairedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const p = i > 0 ? s.charCodeAt(i - 1) : 0;
      if (!(p >= 0xd800 && p <= 0xdbff)) return true;
    }
  }
  return false;
}

test("scrubLoneSurrogates: lone halves become U+FFFD, pairs and plain text preserved", () => {
  assert.equal(scrubLoneSurrogates("a" + LONE_HIGH + "b"), "a\ufffdb");
  assert.equal(scrubLoneSurrogates("a" + LONE_LOW + "b"), "a\ufffdb");
  assert.equal(scrubLoneSurrogates(PAIR), PAIR);
  assert.equal(scrubLoneSurrogates(PAIR + PAIR), PAIR + PAIR);
  assert.equal(scrubLoneSurrogates(PAIR + LONE_LOW), PAIR + "\ufffd");
  assert.equal(scrubLoneSurrogates("plain ascii é 中 text"), "plain ascii é 中 text");
  assert.equal(scrubLoneSurrogates(""), "");
});

test("scrubLoneSurrogates: output serializes without unpaired escapes", () => {
  const scrubbed = scrubLoneSurrogates("x" + LONE_HIGH + LONE_LOW + LONE_HIGH + "y" + PAIR);
  assert.ok(!hasUnpairedSurrogate(JSON.stringify(scrubbed)));
  assert.deepEqual(JSON.parse(JSON.stringify(scrubbed)), scrubbed);
});

function msg(id: string, text: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text };
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
  } as Config;
}

test("applyCompression scrubs a lone surrogate out of the stored summary", () => {
  const core = createCore();
  const state = createInitialState();
  const messages = [msg("a", "alpha"), msg("b", "beta"), msg("c", "gamma")];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  const poisoned = "fix report: " + PAIR + " panel " + LONE_LOW + " end";
  const { state: after, result } = core.applyCompression({
    ranges: [{ startRef: "m1", endRef: "m2", summary: poisoned }],
    messages,
    state,
    config: config(),
  });
  assert.equal(result.errors.length, 0, `compress must succeed: ${JSON.stringify(result.errors)}`);

  const block = after.blocks.find((b) => b.active);
  assert.ok(block, "block created");
  assert.ok(!hasUnpairedSurrogate(block.summary), "stored summary carries no unpaired surrogate");
  assert.ok(block.summary.includes(PAIR), "valid pair inside the summary survives verbatim");
  assert.ok(block.summary.includes("\ufffd"), "lone half was replaced with U+FFFD");
});
