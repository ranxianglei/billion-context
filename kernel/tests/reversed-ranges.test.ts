import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCompressibleRanges } from "../src/recommend.js";
import { formatRanges } from "../src/nudge-text.js";
import { resolveBoundaries } from "../src/boundaries.js";
import { buildStatusReport } from "../src/report.js";
import { orderedRefPair } from "../src/refs.js";
import {
  resolveBlockSpan,
  activeBlockSpans,
  formatCreatedBlocks,
} from "../src/block-map.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import type { CompressionBlock, Config, CoreMessage } from "../src/types.js";

// billion-context #2168 (evidence from #2165): acp_status listed a REVERSED
// compressible range (m0760–m00651, start > end). Root cause: non-monotonic
// refs vs message-array order (#1001 client history rewrite, subagent
// interleaving) make a positional span's endpoint labels numerically
// descending, and every render site printed them verbatim. Direction is
// notational — resolveBoundaries swaps reversed pairs — so the fix canonicalizes
// DISPLAY order at the render sites (formatRanges / status report / block
// spans), never the generation side: swapping there would detach endpoint
// labels from their positions and break formatRanges' position-based merging
// (the #887 coverage invariant). These tests pin both properties: no rendered
// span may read reversed, AND every rendered span must still resolve back to
// exactly the messages it counted.

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

/** Every mNNNNN–mNNNNN span in the text must be numerically ascending. */
function assertAllSpansAscending(text: string): void {
  for (const m of text.matchAll(/(m\d{1,7})–(m\d{1,7})/g)) {
    assert.ok(
      Number(m[1].slice(1)) <= Number(m[2].slice(1)),
      `rendered span ${m[1]}–${m[2]} reads reversed`,
    );
  }
}

/** Resolve every displayed mNNNNN–mNNNNN span back to its messages. */
function resolveDisplayed(
  text: string,
  messages: CoreMessage[],
  state: ReturnType<typeof createInitialState>,
) {
  const ids = new Set<string>();
  let total = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/(m\d{1,7})–(m\d{1,7})/);
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

// ─── orderedRefPair ───────────────────────────────────────────────────────────

test("orderedRefPair sorts reversed pairs, keeps everything else", () => {
  assert.deepEqual(orderedRefPair("m00760", "m00651"), ["m00651", "m00760"]);
  assert.deepEqual(orderedRefPair("m00651", "m00760"), ["m00651", "m00760"]);
  assert.deepEqual(orderedRefPair("m00010", "m00010"), ["m00010", "m00010"]);
  // Unparseable sides ("BLOCKED" protected refs, bN specs) pass through.
  assert.deepEqual(orderedRefPair("BLOCKED", "m00010"), ["BLOCKED", "m00010"]);
  assert.deepEqual(orderedRefPair("b1", "b2"), ["b1", "b2"]);
});

// ─── formatRanges: single reversed group (the production shape) ──────────────

test("formatRanges renders a reversed group ascending and resolvable (#2168)", () => {
  // One contiguous group whose refs DESCEND toward the array tail — the
  // #2165 production shape (m00760–m00651) after a client history rewrite.
  const A = msg("A", "x".repeat(1000));
  const B = msg("B", "y".repeat(1000));
  const C = msg("C", "z".repeat(1000));
  const D = msg("D", "u".repeat(1000));
  const E = msg("E", "w".repeat(1000));
  const messages = [A, B, C, D, E];
  const state = assignRaw(messages, {
    A: "m00760",
    B: "m00755",
    C: "m00651",
    D: "m00650",
    E: "m00649",
  });

  const { compressible } = buildCompressibleRanges(messages, state, cfg);
  assert.equal(compressible.length, 1);
  assert.equal(compressible[0]!.startRef, "m00760");
  assert.equal(compressible[0]!.endRef, "m00649");

  const text = formatRanges(compressible, []);
  assert.match(text, /m00649–m00760/, "displayed pair is ascending");
  assertAllSpansAscending(text);
  const { ids, total } = resolveDisplayed(text, messages, state);
  assert.deepEqual(ids, ["A", "B", "C", "D", "E"]);
  assert.equal(total, 5);
});

// ─── formatRanges: merge must keep full coverage when groups invert ──────────

test("formatRanges merge stays ascending AND covers the union (#2168/#887)", () => {
  // Two positionally adjacent groups, EACH internally reversed (refs descend
  // with array position). formatRanges merges them into one line whose
  // endpoints are the first group's start label and the last group's end
  // label — the true positional extremes of the merged span. A naive
  // generation-side swap would relabel those endpoints (min/max within each
  // group) and the merged line would collapse to a tiny slice (#887 mode).
  const A = msg("A", "x".repeat(1000));
  const B = msg("B", "y".repeat(1000));
  const C = msg("C", "z".repeat(1000));
  const D = msg("D", "u".repeat(200), "user");
  const E = msg("E", "v".repeat(1000));
  const F = msg("F", "w".repeat(1000));
  const messages = [A, B, C, D, E, F];
  const state = assignRaw(messages, {
    A: "m00800",
    B: "m00790",
    C: "m00780",
    D: "m00770",
    E: "m00760",
    F: "m00750",
  });

  const { compressible } = buildCompressibleRanges(messages, state, cfg);
  assert.equal(compressible.length, 2, "user msg splits into two groups");
  assert.ok(
    Number(compressible[0]!.startRef.slice(1)) >
      Number(compressible[0]!.endRef.slice(1)),
  );
  assert.ok(
    Number(compressible[1]!.startRef.slice(1)) >
      Number(compressible[1]!.endRef.slice(1)),
  );

  const text = formatRanges(compressible, []);
  const rangeLines = text.split("\n").filter((l) => l.includes("msgs"));
  assert.equal(rangeLines.length, 1, "adjacent groups merge into one line");
  assert.match(text, /m00750–m00800/, "merged line is ascending");
  assertAllSpansAscending(text);
  const { ids, total } = resolveDisplayed(text, messages, state);
  assert.deepEqual(ids, ["A", "B", "C", "D", "E", "F"], "full union resolved");
  assert.equal(total, 6, "no under-selection after the merge");
});

// ─── acp_status report path ───────────────────────────────────────────────────

test("buildStatusReport uncompressed view renders no reversed spans (#2168)", () => {
  const A = msg("A", "x".repeat(1000));
  const B = msg("B", "y".repeat(1000));
  const C = msg("C", "z".repeat(1000));
  const messages = [A, B, C];
  const state = assignRaw(messages, {
    A: "m00760",
    B: "m00755",
    C: "m00651",
  });
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
  });
  assert.match(report, /UNCOMPRESSED/, "uncompressed section present");
  assertAllSpansAscending(report);
});

// ─── block spans (same mechanism: positional span, descending labels) ────────

function makeBlock(
  overrides: Partial<CompressionBlock> = {},
): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    summary: "s",
    directMessageIds: [],
    effectiveMessageIds: [],
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: Date.now(),
    survivedCount: 0,
    generation: "young",
    active: true,
    ...overrides,
  };
}

test("resolveBlockSpan canonicalizes stored reversed spans (#2168)", () => {
  const block = makeBlock({ startRef: "m00760", endRef: "m00651" });
  assert.deepEqual(resolveBlockSpan(block, {}), {
    startRef: "m00651",
    endRef: "m00760",
  });
  const state = createInitialState();
  state.blocks = [block];
  assert.deepEqual(activeBlockSpans(state), [
    { blockId: "b1", tier: 1, startRef: "m00651", endRef: "m00760" },
  ]);
  assert.equal(formatCreatedBlocks(state, [block]), "blocks: b1=m00651–m00760");
});
