import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { buildCompressibleRanges } from "../src/recommend.js";
import { prune } from "../src/prune.js";
import { buildStatusReport } from "../src/report.js";
import type { Config, CoreMessage } from "../src/types.js";

/** Honest span labels (#5508 family): on surface-replacing views the ids an
 *  active block owns leave the array WITHOUT leaving an array slot or a gap
 *  flag, so compressible runs render as one contiguous label spanning folded
 *  territory. A model submitting the literal span then re-folds the block
 *  into a redundant parent (the r3 incident). The classification itself must
 *  not move (KDD #12: the projection/fold gate stays the single source of
 *  truth); the range/ranges must instead NAME the hidden block(s). */

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "user",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

function config(): Config {
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
  };
}

function foldedState() {
  const core = createCore();
  const state = createInitialState();
  const messages = [
    msg("raw-1", "u1 ".repeat(200)),
    msg("raw-2", "a2 ".repeat(200), "assistant"),
    msg("raw-3", "u3 ".repeat(200)),
    msg("raw-4", "a4 ".repeat(200), "assistant"),
    msg("raw-5", "u5 ".repeat(200)),
    msg("raw-6", "a6 ".repeat(200), "assistant"),
    msg("raw-7", "u7 ".repeat(200)),
  ];
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const applied = core.applyCompression({
    ranges: [{ startRef: "m00003", endRef: "m00004", summary: "s".repeat(80) }],
    messages,
    state,
    config: config(),
  });
  assert.equal(applied.result.errors.length, 0);
  return { full: messages, pruned: prune(messages, applied.state), state: applied.state };
}

test("a range spanning a folded block on a pruned view names the hidden block", () => {
  const { pruned, state } = foldedState();
  const { compressible } = buildCompressibleRanges(pruned, state, config());
  // The synthetic summary node carries no ref and consumes no slot, so the
  // run bridges across m00003/m00004 — the shape models were resubmitting
  // blind. segmentGroups still splits at the >=3-message user boundary, so
  // the expected shape is TWO ranges whose FIRST one spans the folded block.
  // Geometry must be UNCHANGED by the annotation:
  assert.equal(compressible.length, 2);
  const span = compressible[0]!;
  assert.equal(span.startRef, "m00001");
  assert.equal(span.endRef, "m00006");
  assert.equal(span.count, 4);
  // ...and the label now carries the hidden block id:
  assert.deepEqual(span.crossesCoveredBy, ["b1"]);
  // The tail range after the user-boundary split hides nothing:
  const tail = compressible[1]!;
  assert.equal(tail.startRef, "m00007");
  assert.equal(tail.crossesCoveredBy, undefined);
});

test("full-log ranges never carry crossesCoveredBy (covered ids leave gap flags)", () => {
  const { full, state } = foldedState();
  const { compressible } = buildCompressibleRanges(full, state, config());
  assert.ok(compressible.length >= 1);
  for (const r of compressible) {
    assert.equal(r.crossesCoveredBy, undefined, `${r.startRef}-${r.endRef}`);
  }
});

test("the uncompressed status rows name the blocks their labels span", () => {
  const { pruned, state } = foldedState();
  const report = buildStatusReport(state, pruned, (t) => Math.ceil(t.length / 4), {
    scope: "uncompressed",
    sort: "size",
  });
  assert.ok(report.includes("UNCOMPRESSED"), report);
  assert.match(report, /spans folded b1/, report);
});
