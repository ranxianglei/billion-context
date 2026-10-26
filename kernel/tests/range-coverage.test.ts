import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompressibleRanges } from "../src/recommend.js";
import { formatRanges } from "../src/nudge-text.js";
import { resolveBoundaries } from "../src/boundaries.js";
import { createInitialState } from "../src/state.js";
import type { Config, CompressibleRange, CoreMessage } from "../src/types.js";

function msg(
  id: string,
  text: string,
  role: CoreMessage["role"] = "assistant",
): CoreMessage {
  return { id, role, contentType: "text", text };
}

const cfg: Config = {
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
};

function assignRaw(messages: CoreMessage[], rawToRef: Record<string, string>) {
  const state = createInitialState();
  const byRaw: Record<string, string> = {};
  const byRef: Record<string, string> = {};
  for (const m of messages) {
    byRaw[m.id] = rawToRef[m.id];
    byRef[rawToRef[m.id]] = m.id;
  }
  state.messageRefs = { byRaw, byRef };
  return state;
}

// Resolve every mNNNNN–mNNNNN span a nudge displays back to its messages.
function resolveDisplayed(
  text: string,
  messages: CoreMessage[],
  state: ReturnType<typeof createInitialState>,
) {
  const ids = new Set<string>();
  let total = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/(m\d{5})–(m\d{5})/);
    if (!m) continue;
    const r = resolveBoundaries({
      startRef: m[1],
      endRef: m[2],
      messages,
      state,
    });
    for (const id of r.messageIds) ids.add(id);
    total += r.messageIds.length;
  }
  return { ids: [...ids].sort(), total };
}

// billion-context #887: when ref order is non-monotonic vs message-array order
// (subagent interleaving / mid-array summary nodes), every range formatRanges
// displays must still resolve back to exactly the messages it counted. Before
// the fix, formatRanges sorted/merged by ref NUMBER, so a low-ref range sitting
// AFTER a high-ref one produced endpoint pairs resolveBoundaries collapsed to a
// tiny slice → "Total compressible content too small".
test("formatRanges preserves coverage under non-monotonic refs (#887)", () => {
  // Position order: A B C D E. Refs non-monotonic: D (low ref) sits AFTER C.
  const A = msg("A", "x".repeat(1000));
  const B = msg("B", "y".repeat(1000));
  const C = msg("C", "z".repeat(1000));
  const D = msg("D", "u".repeat(200), "user"); // user msg → splits the group at D
  const E = msg("E", "w".repeat(1000));
  const messages = [A, B, C, D, E];
  const state = assignRaw(messages, {
    A: "m07522",
    B: "m07990",
    C: "m08040",
    D: "m06185",
    E: "m08089",
  });

  const { compressible } = buildCompressibleRanges(messages, state, cfg);
  assert.equal(
    compressible.length,
    2,
    "user msg at D splits into two positionally-contiguous ranges",
  );
  assert.deepEqual(
    compressible.map((r) => [r.startIndex, r.endIndex]),
    [
      [0, 2],
      [3, 4],
    ],
    "range indices track message-array position, not ref order",
  );

  const { ids, total } = resolveDisplayed(
    formatRanges(compressible, []),
    messages,
    state,
  );
  assert.deepEqual(
    ids,
    ["A", "B", "C", "D", "E"],
    "every compressible message covered by exactly one displayed range",
  );
  assert.equal(
    total,
    5,
    "no under-/over-selection: resolved total equals the 5 source messages",
  );
});

// Guard: the fix must not over-restrict merging for the common dense-monotonic
// case (refs increase with array position) — adjacent ranges still merge.
test("formatRanges still merges adjacent monotonic ranges", () => {
  const A = msg("A", "x".repeat(1000));
  const B = msg("B", "y".repeat(1000));
  const C = msg("C", "z".repeat(1000));
  const D = msg("D", "u".repeat(200), "user");
  const messages = [A, B, C, D];
  const state = assignRaw(messages, {
    A: "m00001",
    B: "m00002",
    C: "m00003",
    D: "m00004",
  });

  const { compressible } = buildCompressibleRanges(messages, state, cfg);
  const { ids, total } = resolveDisplayed(
    formatRanges(compressible, []),
    messages,
    state,
  );
  assert.deepEqual(
    ids,
    ["A", "B", "C", "D"],
    "adjacent monotonic ranges merge into one resolvable span",
  );
  assert.equal(total, 4);
});

// Backwards compat: hand-built ranges carry no positional indices, so
// formatRanges falls back to ref-number ordering (prior behavior preserved).
test("formatRanges falls back to ref-number ordering for hand-built ranges", () => {
  const ranges: CompressibleRange[] = [
    {
      startRef: "m00010",
      endRef: "m00011",
      count: 2,
      tokens: 200,
      toolPct: 50,
      textPct: 50,
    },
    {
      startRef: "m00012",
      endRef: "m00013",
      count: 2,
      tokens: 200,
      toolPct: 50,
      textPct: 50,
    },
  ];
  const text = formatRanges(ranges, []);
  assert.match(
    text,
    /m00010–m00013\s+4 msgs/,
    "adjacent-by-ref hand-built ranges still merge",
  );
});
