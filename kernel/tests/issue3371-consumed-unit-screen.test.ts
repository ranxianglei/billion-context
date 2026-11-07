// #3371: screenRecommendedUnits must not advertise a message-ref unit whose
// entire span is already owned by an active, NOT restored-inline block.
// #4521 note: the apply lane (compress.ts) no longer THROWS on that shape — it
// returns the idempotent no-op outcome (covered-range warning, zero blocks) —
// so the two lanes now agree by both declining to fold it without failing
// the request. Before #3371 the two lanes disagreed: recommend advertised it,
// apply threw, forever. The verdict lives in refold.ts, extracted from
// compress.ts so BOTH lanes consult one definition (projectUnit discipline).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { screenRecommendedUnits } from "../src/recommend.js";
import { markBlockRestoredInline } from "../src/decompress.js";
import type { CompressibleRange, Config, CoreMessage, CompressionState } from "../src/types.js";

function config(): Config {
  return {
    tiers: { enabled: false },
    nudge: {
      maxContextLimitPct: 0.55, minContextLimitPct: 0.45, frequency: 5, iterationThreshold: 15,
      force: "soft", growthRatio: 0.05, growthFloor: 6000, growthCap: 50000,
      minGrowthFloor: 5000, minGrowthRatio: 0.45, emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 500, maxSummaryLength: 20000, minSummaryLength: 1 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  };
}

function mk(id: string, role: CoreMessage["role"], len = 3000): CoreMessage {
  return { id, role, contentType: "text", text: "x".repeat(len) };
}

/** State with an active b1 over m00001..m00002 (fresh fold, nothing
 * restored-inline) plus two fresh uncovered messages m00003..m00004. */
function build(): { state: CompressionState; all: CoreMessage[]; core: ReturnType<typeof createCore> } {
  const core = createCore();
  const cfg = config();
  const state = createInitialState();
  const all = [mk("U0", "user"), mk("W1", "assistant"), mk("U3", "user"), mk("W3", "assistant")];
  state.messageRefs = assignRefs(all, { existing: state.messageRefs, nextIndex: 1 }).map;
  const p1 = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "earlier work" }],
    messages: all,
    state,
    config: cfg,
  });
  assert.equal(p1.result.errors.length, 0, p1.result.errors.join("; "));
  return { state: p1.state, all, core };
}

const consumedUnit: CompressibleRange = { startRef: "m00001", endRef: "m00002", count: 2, tokens: 6000 };
const freshUnit: CompressibleRange = { startRef: "m00003", endRef: "m00004", count: 2, tokens: 6000 };

test("#3371: consumed, not-restored span is screened OUT and apply agrees (no advertise→reject loop)", () => {
  const { state, all, core } = build();
  const cfg = config();

  // the bug: this shape passed screening (filteredIds 0, consumed > 0)
  const screened = screenRecommendedUnits([consumedUnit], all, state, cfg, new Set());
  assert.equal(screened.length, 0, "consumed & not restored-inline must not be advertised");

  // apply-side agreement (#4521): the same range is now the idempotent
  // no-op class — zero errors, zero blocks, guidance in warnings[] (it used
  // to be the livelock-guard throw; refusing it whole-batch is what fed the
  // retry loops). Recommend still never advertises it, so the lanes agree:
  // nothing advertised, nothing folded, nothing failed.
  const applied = core.applyCompression({
    ranges: [{ startRef: consumedUnit.startRef, endRef: consumedUnit.endRef, summary: "nope" }],
    messages: all,
    state: structuredClone(state),
    config: cfg,
  });
  assert.equal(applied.result.errors.length, 0, applied.result.errors.join("; "));
  assert.equal(applied.result.blocksCreated, 0);
  assert.equal(applied.result.noop, true);
  assert.match(
    applied.result.warnings.join("; "),
    /already covered by active block\(s\) b1/,
    "and it must be the covered no-op warning, not some other error",
  );
  assert.match(applied.result.warnings.join("; "), /do not resend this range/);
});

test("#3371: a genuine refold (restored-inline) stays advertised and applies cleanly", () => {
  const { state, all, core } = build();
  const cfg = config();

  const { state: restored } = markBlockRestoredInline(state, "b1");
  assert.equal(restored.blocks.find((b) => b.blockId === "b1")?.restoredInline, true);

  const screened = screenRecommendedUnits([consumedUnit], all, restored, cfg, new Set());
  assert.equal(screened.length, 1, "a genuine #398 refold must stay advertised");

  const applied = core.applyCompression({
    ranges: [{ startRef: consumedUnit.startRef, endRef: consumedUnit.endRef, summary: "refolded work" }],
    messages: all,
    state: structuredClone(restored),
    config: cfg,
  });
  assert.equal(applied.result.errors.length, 0, applied.result.errors.join("; "));
  // in-place #398 refold: b1 updated, no new block, restore marker consumed
  const b1 = applied.state.blocks.find((b) => b.blockId === "b1");
  assert.ok(b1, "refold updates b1 in place");
  assert.equal(b1.summary, "refolded work");
  assert.notEqual(b1.restoredInline, true, "refold clears the restored-inline marker");
  assert.equal(applied.state.blocks.filter((b) => b.active).length, 1, "no second block created");
});

test("#3371: no over-screening — fresh spans stay advertised next to the consumed one", () => {
  const { state, all } = build();
  const screened = screenRecommendedUnits([freshUnit], all, state, config(), new Set());
  assert.equal(screened.length, 1, "fresh content is unaffected by the consumed-shape screen");
});
