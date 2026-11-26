import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { buildStatusReport } from "../src/report.js";
import type { Config, CoreMessage } from "../src/types.js";

/** Flag-detail honesty (#5508 family / #3406): when an uncompressed row's
 *  endpoints cannot be mapped onto the apply array class (stale, BLOCKED or
 *  surface-drift refs), flagFor used to catch the projection throw and render
 *  one flat verdict — "refs unresolvable" — for every possible cause. That
 *  verdict reads like ledger corruption and sent agents into dead-end
 *  theories instead of naming the failing endpoint. The flag must carry the
 *  underlying reason. */

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

test("a doomed row surfaces the projection failure reason, not a flat verdict", () => {
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
  const st = applied.state;

  // A ref assigned by the ledger but ABSENT from the array class apply runs
  // on (the production shape of every "refs unresolvable" row): visible in
  // the render view, unresolvable against `original`.
  const late = msg("late-1", "x8 ".repeat(200));
  st.messageRefs.byRaw["late-1"] = "m00008";
  st.messageRefs.byRef["m00008"] = "late-1";

  const report = buildStatusReport(st, [
    ...messages.slice(0, 2),
    late,
    ...messages.slice(4),
  ], (t) => Math.ceil(t.length / 4), {
    scope: "uncompressed",
    sort: "size",
    config: config(),
    originalMessages: messages,
  });

  assert.match(report, /\u26a0 not foldable: projection failed \(/);
  // Exactly the doomed row carries it — cleanly-resolving rows stay clean.
  assert.equal(report.split("projection failed").length - 1, 1);
  assert.ok(
    !report.includes("not foldable: refs unresolvable"),
    report,
  );
  // The detail names the failing endpoint so the next reader can act on it.
  const flagLine = report
    .split("\n")
    .find((l) => l.includes("projection failed"))!;
  assert.ok(flagLine.includes("m00008") || flagLine.includes("late-1"), flagLine);
});
