/**
 * Regression (#511): the recommend/nudge gate and the apply-side
 * minCompressRange gate must use the SAME unit — tokens. The apply side used
 * to count raw characters (`msg.text.length`) while the rest of the kernel
 * counts tokens; under a CJK-aware tokenizer (≈1 token/char) that made the
 * gate ~4x stricter than for Latin text, so CJK sessions' compressible ranges
 * were dropped wholesale ("Total compressible content too small") even at equal
 * token mass. Both sides now count tokens via countMessageTokens, so the gate
 * is language-neutral.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";
import { mergeRangesToThreshold } from "../src/recommend.js";
import type { CompressibleRange } from "../src/types.js";

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.9,
      minContextLimitPct: 0.45,
      frequency: 1,
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
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 3000,
      minSummaryLength: 100,
    },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
    ...overrides,
  };
}

/** CJK-aware estimator: 1 token per char for CJK text (the kernel's own
 *  estimateTokensFast behaves this way for CJK). Identity for our fixtures. */
const cjkTokenizer = (text: string): number => text.length;

function cjkMessages(charsPerMessage: number, count: number): CoreMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `raw-${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    contentType: "text",
    text: "内容".repeat(charsPerMessage / 2),
  }));
}

test("gate keys on tokens, not chars (language-neutral, #511)", () => {
  // A Latin-style range carries ~4x more chars than tokens; the gate must key
  // on tokens so its verdict matches a CJK range of equal token mass. Pre-fix
  // the gate read chars, so the 4999-token Latin range below cleared 5000
  // (19996 chars) while the equal-token CJK range did not (#511).
  const latin: CompressibleRange = {
    startRef: "m00001",
    endRef: "m00010",
    count: 5,
    tokens: 4999,
    chars: 19996,
    toolPct: 0,
    textPct: 100,
  };
  const cjk: CompressibleRange = {
    startRef: "m00001",
    endRef: "m00010",
    count: 5,
    tokens: 4999,
    chars: 4999,
    toolPct: 0,
    textPct: 100,
  };
  assert.equal(
    mergeRangesToThreshold([latin], 5000).length,
    0,
    "4999 tokens < 5000 despite 19996 chars",
  );
  assert.equal(
    mergeRangesToThreshold([cjk], 5000).length,
    0,
    "equal-token CJK dropped identically",
  );
  assert.equal(
    mergeRangesToThreshold([{ ...latin, tokens: 5000, chars: 20000 }], 5000)
      .length,
    1,
    "5000 tokens clears",
  );
  assert.equal(
    mergeRangesToThreshold([{ ...cjk, tokens: 5000, chars: 5000 }], 5000)
      .length,
    1,
    "equal-token CJK clears identically",
  );
});

test("nudge: CJK session below minCompressRange tokens is NOT offered (apply would reject)", () => {
  const core = createCore({ countTokens: cjkTokenizer });
  const config = buildConfig();
  const messages = cjkMessages(500, 6); // 3000 tokens total < 5000 min
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  // usage 95% >= maxContextLimitPct 0.9 → pressure path
  const turn = core.processTurn({ messages, state, config, tokenCount: 95000 });

  assert.equal(
    turn.nudge.shouldInject,
    false,
    "3000 tokens < minCompressRange 5000 — nudge must not offer it",
  );
  assert.match(
    turn.nudge.reason,
    /no tier has effective compressible content/,
    `reason explains the suppression, got: ${turn.nudge.reason}`,
  );

  // The apply side agrees: the same range is atomically rejected.
  const applied = core.applyCompression({
    ranges: [
      { startRef: "m00001", endRef: "m00006", summary: "s", topic: "t" },
    ],
    messages,
    state: turn.state,
    config,
  });
  assert.equal(applied.result.blocksCreated, 0);
  assert.ok(
    applied.result.errors.some((e) => e.includes("too small")),
    `apply rejects with too-small gate, got: ${JSON.stringify(applied.result.errors)}`,
  );
});

test("nudge: CJK session above minCompressRange tokens IS offered (control)", () => {
  const core = createCore({ countTokens: cjkTokenizer });
  const config = buildConfig();
  const messages = cjkMessages(1000, 6); // 6000 tokens total >= 5000 min
  let state = createInitialState();

  state = core.processTurn({
    messages,
    state,
    config,
    tokenCount: 10000,
  }).state;
  const turn = core.processTurn({ messages, state, config, tokenCount: 95000 });

  assert.equal(
    turn.nudge.shouldInject,
    true,
    "6000 tokens >= 5000 — effective T1 pending exists",
  );
  assert.match(turn.nudge.reason, /T1/);

  // And the apply side accepts the same range — both gates agree on tokens.
  const applied = core.applyCompression({
    ranges: [
      {
        startRef: "m00001",
        endRef: "m00006",
        summary: "总结".repeat(60),
        topic: "t",
      },
    ],
    messages,
    state: turn.state,
    config,
  });
  assert.equal(
    applied.result.blocksCreated,
    1,
    "apply accepts: 6000 tokens >= 5000",
  );
  assert.deepEqual(applied.result.errors, []);
});
