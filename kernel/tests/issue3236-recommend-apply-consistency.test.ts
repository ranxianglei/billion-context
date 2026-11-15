import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { buildStatusReport } from "../src/report.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type { Config, CoreMessage, CompressionState } from "../src/types.js";

// #3236: the eligibility side (recommend/nudge/acp_status) judged turn
// integrity over a different folded set than the execution side
// (per-submitted-range), so it advertised ranges the apply side rejected
// wholesale ("Range would split N turn(s)") in a permanent retry loop. Both
// sides now run the SAME projection (unit-projection.ts): every advertised
// range must apply cleanly, doomed ranges stop being advertised while the
// apply-side gate keeps rejecting them on manual submit, and healthy
// complete turns stay advertised. Geometries below mirror the field shapes
// (async tool results arriving far after their burst) that diverged on 0.1.196.

function config(): Config {
  return {
    tiers: { enabled: false },
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
    compress: {
      minCompressRange: 5000,
      maxSummaryLength: 20000,
      minSummaryLength: 1,
    },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: 100000,
  };
}

function mk(
  id: string,
  role: CoreMessage["role"],
  ct: CoreMessage["contentType"],
  toolName?: string,
  toolCallId?: string,
  len = 1500,
): CoreMessage {
  return {
    id,
    role,
    contentType: ct,
    toolName,
    toolCallId,
    text: "x".repeat(len),
  };
}

interface Scenario {
  state: CompressionState;
  all: CoreMessage[];
}

function buildHeadFold(
  core: ReturnType<typeof createCore>,
  cfg: Config,
): Scenario {
  const state = createInitialState();
  const all: CoreMessage[] = [
    mk("U0", "user", "text", undefined, undefined, 3000),
    mk("W1", "assistant", "text", undefined, undefined, 3000),
  ];
  state.messageRefs = assignRefs(all, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  const p1 = core.applyCompression({
    ranges: [{ startRef: "m00001", endRef: "m00002", summary: "earlier work" }],
    messages: all,
    state,
    config: cfg,
  });
  assert.equal(p1.result.errors.length, 0, p1.result.errors.join("; "));
  return { state: p1.state, all };
}

// Burst [R, C1..C5] with the FIRST result immediate, six filler turns, then
// the remaining four results arriving far beyond the apply side's pair-widen
// window (>20 slots, or cut off by the first non-match after a match). The
// old selector advertised the burst span itself; apply withdrew the whole
// turn and threw.
function buildDelayedResults(
  core: ReturnType<typeof createCore>,
  cfg: Config,
  interleave: boolean,
): Scenario {
  const { state, all } = buildHeadFold(core, cfg);
  all.push(
    mk("R", "assistant", "reasoning", undefined, undefined, 2000),
    mk("C1", "assistant", "tool-call", "bash", "c1"),
    mk("C2", "assistant", "tool-call", "read", "c2"),
    mk("C3", "assistant", "tool-call", "bash", "c3"),
    mk("C4", "assistant", "tool-call", "read", "c4"),
    mk("C5", "assistant", "tool-call", "bash", "c5"),
    mk("RS1", "tool", "tool-result", "read", "c1", 300),
  );
  const late = [
    mk("RS2", "tool", "tool-result", "read", "c2", 300),
    mk("RS3", "tool", "tool-result", "bash", "c3", 300),
    mk("RS4", "tool", "tool-result", "read", "c4", 300),
    mk("RS5", "tool", "tool-result", "bash", "c5", 300),
  ];
  for (let f = 0; f < 6; f++) {
    all.push(mk(`UF${f}`, "user", "text", undefined, undefined, 200));
    all.push(mk(`RF${f}`, "assistant", "reasoning", undefined, undefined, 300));
    all.push(mk(`CF${f}`, "assistant", "tool-call", "bash", `cf${f}`, 300));
    if (interleave && f === 2) all.push(late[0]!);
    all.push(mk(`RSF${f}`, "tool", "tool-result", "bash", `cf${f}`, 300));
    if (interleave && f === 4) all.push(late[1]!);
  }
  if (interleave) all.push(late[2]!, late[3]!);
  else all.push(...late);
  state.messageRefs = assignRefs(all, {
    existing: state.messageRefs,
    nextIndex: 3,
  }).map;
  return { state, all };
}

// Two bursts interleaved (RA, CA1..CA3, RA_RS1, RB, CB1..CB3, RB_RS1) with
// each burst's late results appended after six filler turns. The old
// selector batched both bursts into ONE advertised range; apply reported
// "Range would split 2 turn(s) and 4 tool call/result pair(s)".
function buildTwoBursts(
  core: ReturnType<typeof createCore>,
  cfg: Config,
): Scenario {
  const { state, all } = buildHeadFold(core, cfg);
  all.push(
    mk("RA", "assistant", "reasoning", undefined, undefined, 2000),
    mk("CA1", "assistant", "tool-call", "bash", "a1"),
    mk("CA2", "assistant", "tool-call", "read", "a2"),
    mk("CA3", "assistant", "tool-call", "bash", "a3"),
    mk("RA_RS1", "tool", "tool-result", "bash", "a1", 300),
    mk("RB", "assistant", "reasoning", undefined, undefined, 2000),
    mk("CB1", "assistant", "tool-call", "read", "b1"),
    mk("CB2", "assistant", "tool-call", "bash", "b2"),
    mk("CB3", "assistant", "tool-call", "read", "b3"),
    mk("RB_RS1", "tool", "tool-result", "read", "b1", 300),
  );
  for (let f = 0; f < 6; f++) {
    all.push(mk(`UF${f}`, "user", "text", undefined, undefined, 200));
    all.push(mk(`RF${f}`, "assistant", "reasoning", undefined, undefined, 300));
    all.push(mk(`CF${f}`, "assistant", "tool-call", "bash", `cf${f}`, 300));
    all.push(mk(`RSF${f}`, "tool", "tool-result", "bash", `cf${f}`, 300));
  }
  all.push(
    mk("LA2", "tool", "tool-result", "read", "a2", 300),
    mk("LA3", "tool", "tool-result", "bash", "a3", 300),
    mk("LB2", "tool", "tool-result", "bash", "b2", 300),
    mk("LB3", "tool", "tool-result", "read", "b3", 300),
  );
  state.messageRefs = assignRefs(all, {
    existing: state.messageRefs,
    nextIndex: 3,
  }).map;
  return { state, all };
}

function refIndexMap(
  state: CompressionState,
  all: CoreMessage[],
): Map<string, number> {
  const map = new Map<string, number>();
  all.forEach((m, i) => {
    const ref = state.messageRefs.byRaw[m.id];
    if (ref) map.set(ref, i);
  });
  return map;
}

// THE contract (#2638/#2663 lineage): every advertised range applies cleanly
// against the very state it was advertised from.
function assertAdvertisedApplyCleanly(
  core: ReturnType<typeof createCore>,
  cfg: Config,
  state: CompressionState,
  all: CoreMessage[],
  label: string,
): void {
  const processed = core.processTurn({
    messages: all,
    state,
    config: cfg,
    tokenCount: 70000,
  });
  const ranges = processed.nudge?.compressibleRanges ?? [];
  assert.ok(ranges.length > 0, `${label}: fresh content must be advertised`);
  for (const r of ranges) {
    const applied = core.applyCompression({
      ranges: [
        {
          startRef: r.startRef,
          endRef: r.endRef,
          summary: "steady-state fold",
        },
      ],
      messages: all,
      state: structuredClone(state),
      config: cfg,
    });
    assert.equal(
      applied.result.errors.length,
      0,
      `${label}: advertised ${r.startRef}-${r.endRef} failed to apply: ${applied.result.errors.join("; ")}`,
    );
  }
}

test("#3236 A/A2: burst with delayed results folds atomically at any distance (#5751); every advertised unit applies cleanly", () => {
  const core = createCore();
  const cfg = config();
  for (const interleave of [false, true]) {
    const label = interleave ? "A2" : "A";
    const { state, all } = buildDelayedResults(core, cfg, interleave);
    const refIdx = refIndexMap(state, all);

    const processed = core.processTurn({
      messages: all,
      state,
      config: cfg,
      tokenCount: 70000,
    });
    const ranges = processed.nudge?.compressibleRanges ?? [];
    assert.ok(ranges.length > 0, `${label}: content must still be advertised`);

    // #5751: pair widening is id-exact over the whole array, so delayed
    // results at ANY distance pull in — Scenario A's "no projection can
    // fold the burst" is gone. Both interleave modes fold the burst
    // atomically now, so the old "must not span the burst" pin is retired;
    // the advertised-applies-cleanly contract below is the guard that matters.
    for (const r of ranges) {
      const applied = core.applyCompression({
        ranges: [
          {
            startRef: r.startRef,
            endRef: r.endRef,
            summary: "steady-state fold",
          },
        ],
        messages: all,
        state: structuredClone(state),
        config: cfg,
      });
      assert.equal(
        applied.result.errors.length,
        0,
        `${label}: advertised ${r.startRef}-${r.endRef} failed to apply: ${applied.result.errors.join("; ")}`,
      );
    }

    // Manual submit of the raw burst span: #5751's id-exact widening pulls
    // the delayed results in from any distance (A2's window rationale is
    // gone), so A and A2 fold identically now — the span folds whole.
    const doomed = core.applyCompression({
      ranges: [
        {
          startRef: state.messageRefs.byRaw["R"]!,
          endRef: state.messageRefs.byRaw["RS1"]!,
          summary: "manual burst span",
        },
      ],
      messages: all,
      state: structuredClone(state),
      config: cfg,
    });
    assert.equal(
      doomed.result.errors.length,
      0,
      `${label}: burst span should fold atomically with its delayed results, got: ${doomed.result.errors.join("; ")}`,
    );
    assert.equal(doomed.result.blocksCreated, 1);
  }
});

test("#3236 B: two interleaved bursts — advertised clean, gate intact on manual submit", () => {
  const core = createCore();
  const cfg = config();
  const { state, all } = buildTwoBursts(core, cfg);
  const refIdx = refIndexMap(state, all);
  const burstLo = refIdx.get(state.messageRefs.byRaw["RA"]!)!;
  const burstHi = refIdx.get(state.messageRefs.byRaw["RB_RS1"]!)!;

  const processed = core.processTurn({
    messages: all,
    state,
    config: cfg,
    tokenCount: 70000,
  });
  const ranges = processed.nudge?.compressibleRanges ?? [];
  assert.ok(ranges.length > 0, "content must still be advertised");
  for (const r of ranges) {
    const s = refIdx.get(r.startRef);
    const e = refIdx.get(r.endRef);
    assert.notEqual(s, undefined, `start ${r.startRef} resolvable`);
    assert.notEqual(e, undefined, `end ${r.endRef} resolvable`);
    const applied = core.applyCompression({
      ranges: [
        {
          startRef: r.startRef,
          endRef: r.endRef,
          summary: "steady-state fold",
        },
      ],
      messages: all,
      state: structuredClone(state),
      config: cfg,
    });
    assert.equal(
      applied.result.errors.length,
      0,
      `advertised ${r.startRef}-${r.endRef} failed to apply: ${applied.result.errors.join("; ")}`,
    );
  }

  // #5751: the double burst folds atomically — the id-exact widening pulls
  // both bursts' delayed results (LA2..LB3) in from any distance.
  const doomed = core.applyCompression({
    ranges: [
      {
        startRef: state.messageRefs.byRaw["RA"]!,
        endRef: state.messageRefs.byRaw["RB_RS1"]!,
        summary: "manual double-burst span",
      },
    ],
    messages: all,
    state: structuredClone(state),
    config: cfg,
  });
  assert.equal(
    doomed.result.errors.length,
    0,
    `double-burst span should fold atomically, got: ${doomed.result.errors.join("; ")}`,
  );
  assert.equal(doomed.result.blocksCreated, 1);
});

test("#3236: healthy complete turns remain advertised and apply cleanly (no over-screening)", () => {
  const core = createCore();
  const cfg = config();
  const state = createInitialState();
  const all: CoreMessage[] = [
    mk("U", "user", "text", undefined, undefined, 1000),
    mk("R", "assistant", "reasoning", undefined, undefined, 1000),
    mk("C", "assistant", "tool-call", "bash", "c1"),
    mk("RS", "tool", "tool-result", "bash", "c1", 3000),
  ];
  state.messageRefs = assignRefs(all, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;

  assertAdvertisedApplyCleanly(core, cfg, state, all, "complete-turn");

  const processed = core.processTurn({
    messages: all,
    state,
    config: cfg,
    tokenCount: 70000,
  });
  const ranges = processed.nudge?.compressibleRanges ?? [];
  const refIdx = refIndexMap(state, all);
  const turnLo = refIdx.get(state.messageRefs.byRaw["R"]!)!;
  const turnHi = refIdx.get(state.messageRefs.byRaw["RS"]!)!;
  assert.ok(
    ranges.some((r) => {
      const s = refIdx.get(r.startRef);
      const e = refIdx.get(r.endRef);
      return s !== undefined && e !== undefined && s <= turnLo && e >= turnHi;
    }),
    `the complete turn must still be advertised: ${JSON.stringify(ranges.map((r) => `${r.startRef}-${r.endRef}`))}`,
  );
});

test("#3236: acp_status uncompressed rows keep spans visible, flag only what stays doomed", () => {
  const core = createCore();
  const cfg = config();
  const { state, all } = buildTwoBursts(core, cfg);

  const report = buildStatusReport(state, all, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    config: cfg,
    originalMessages: all,
  });
  const lines = report.split("\n");
  const burstLine = lines.find(
    (l) =>
      l.includes(state.messageRefs.byRaw["RA"]!) &&
      l.includes(state.messageRefs.byRaw["RB_RS1"]!),
  );
  assert.ok(burstLine, "burst row must stay listed");
  // #5751: id-exact widening reaches the delayed results at any distance, so
  // the double burst is foldable — the row loses its doom flag.
  assert.ok(
    !burstLine!.includes("\u26a0"),
    `burst row must be unflagged now: ${burstLine}`,
  );

  const fillerLine = lines.find(
    (l) =>
      l.includes(state.messageRefs.byRaw["UF0"]!) &&
      l.includes(state.messageRefs.byRaw["RSF0"]!),
  );
  assert.ok(
    fillerLine !== undefined && !fillerLine.includes("\u26a0"),
    `healthy complete-turn row must be unflagged: ${fillerLine}`,
  );

  // Legacy call (no config/originalMessages) keeps the byte-stable surface.
  const legacy = buildStatusReport(state, all, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.ok(!legacy.includes("\u26a0"), "legacy output gains no flags");
});

// #3617 gate discipline: the doom flag must be pinned in BOTH directions.
// The re-pin above only asserts the unflagged direction (#5751 made those
// spans foldable), so keep one genuinely un-foldable row — the whole tail
// inside the soft-protected zone — and assert the flag still fires.
test("#3236: acp_status doom flag still fires for a genuinely doomed row", () => {
  const core = createCore();
  const cfg = config();
  const { state, all } = buildHeadFold(core, cfg);
  all.push(
    mk("X1", "user", "text", undefined, undefined, 200),
    mk("X2", "assistant", "text", undefined, undefined, 200),
  );
  state.messageRefs = assignRefs(all, {
    existing: state.messageRefs,
    nextIndex: 3,
  }).map;

  // Both tail messages sit in the soft-protected zone, so no projection of
  // their row can fold — the doom flag must fire.
  const zoned = { ...cfg, preserveRecentMessages: 2 };
  const report = buildStatusReport(state, all, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    config: zoned,
    originalMessages: all,
  });
  const lines = report.split("\n");
  for (const id of ["X1", "X2"]) {
    const ref = state.messageRefs.byRaw[id]!;
    const line = lines.find((l) => l.includes(ref));
    assert.ok(line, `${id} row must stay listed`);
    assert.ok(
      line!.includes("\u26a0 not foldable"),
      `zoned ${id} row must carry the doom flag: ${line}`,
    );
  }
});
