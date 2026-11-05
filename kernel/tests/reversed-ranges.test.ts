import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
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

// ─── #5680: per-turn statusLine + apply path under mixed-era refs ─────────────

// After a session-generation reset the ledger mixes eras: early messages keep
// previous-generation refs while newer ones mint from m00001, so a positional
// group straddling the boundary stores startRef > endRef. The armed-but-silent
// nudge window prints those pairs into the model's context every turn — they
// must read ascending like every other surface (#5680 production shape:
// "compressible now: m00512–m00187").

const STATUS_LIMIT = 872_000;

function statusConfig(): Config {
  return {
    tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
    nudge: {
      maxContextLimitPct: 0.75,
      minContextLimitPct: 0.05,
      frequency: 1,
      iterationThreshold: 15,
      force: "soft",
      growthRatio: 0.06,
      growthFloor: 50_000,
      growthCap: 50_000,
      minGrowthFloor: 22_500,
      minGrowthRatio: 0.45,
      emergencyThresholdPct: 0.98,
    },
    promotionThreshold: 5,
    truncate: { threshold: 1 },
    merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
    compress: { minCompressRange: 100, maxSummaryLength: 20000, minSummaryLength: 1 },
    protectedTools: [],
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
    modelContextLimit: STATUS_LIMIT,
  };
}

test("processTurn statusLine offers ascending refs across a generation boundary (#5680)", () => {
  const core = createCore();
  const cfg = statusConfig();
  // 40 alternating user/assistant messages; the first six keep old-generation
  // refs (m00501..m00506), the rest mint from m00001 — the post-reset ledger
  // shape. Group [i4..i7] then straddles the boundary: stored m00505–m00002.
  const messages = Array.from({ length: 40 }, (_, i) =>
    msg(`s${i}`, "x".repeat(24_000), i % 2 === 0 ? "user" : "assistant"),
  );
  const rawToRef: Record<string, string> = {};
  messages.forEach((m, i) => {
    rawToRef[m.id] = i < 6 ? `m${String(501 + i).padStart(5, "0")}` : `m${String(i - 6 + 1).padStart(5, "0")}`;
  });
  let state = assignRaw(messages, rawToRef);

  const warm = core.processTurn({ messages, state, config: cfg, tokenCount: 600_000 });
  assert.equal(warm.nudge?.shouldInject, true, "first-sight mass injects");
  assert.equal(warm.statusLine, undefined, "no status line beside a delivered banner");
  state = warm.state;

  const idle = core.processTurn({ messages, state, config: cfg, tokenCount: 610_000 });
  assert.equal(idle.nudge?.shouldInject, false, `armed-but-silent window, got reason: ${idle.nudge?.reason}`);
  const ranges = idle.nudge?.compressibleRanges ?? [];
  assert.ok(ranges.length > 0, "plan carries offered ranges");
  assert.ok(
    ranges.some((r) => Number(r.startRef.slice(1)) > Number(r.endRef.slice(1))),
    "fixture must produce a stored inverted pair (non-vacuity)",
  );
  assert.ok(idle.statusLine, "status line emitted in the armed-but-silent window");
  assert.match(idle.statusLine!, /highest allocated ref m00506/);
  assert.match(idle.statusLine!, /m00002–m00505/, "boundary-straddling pair printed ascending");
  assertAllSpansAscending(idle.statusLine!);
});

test("applyCompression folds the exact offered span for either label order (#5680)", () => {
  // Host-side normalizeRangeOrder (#1001) swaps a reversed spec before it
  // reaches the kernel; resolveBoundaries (#310) swaps back positionally. The
  // composition must fold exactly the offered positional span — pin it in BOTH
  // label orders so neither half of the double swap regresses alone.
  const A = msg("A", "x".repeat(1000));
  const B = msg("B", "y".repeat(1000));
  const C = msg("C", "z".repeat(1000));
  const D = msg("D", "u".repeat(1000));
  const E = msg("E", "w".repeat(1000));
  const messages = [A, B, C, D, E];
  const refs = { A: "m00760", B: "m00755", C: "m00651", D: "m00650", E: "m00649" };
  const core = createCore();
  const cfg = statusConfig();

  for (const [startRef, endRef] of [
    ["m00760", "m00649"], // model echoes the offered (inverted) span verbatim
    ["m00649", "m00760"], // host-normalized shape
  ] as const) {
    const r = core.applyCompression({
      ranges: [{ startRef, endRef, summary: "work recap" }],
      messages,
      state: assignRaw(messages, refs),
      config: cfg,
    });
    assert.equal(r.result.errors.length, 0, `${startRef}–${endRef}: ${r.result.errors.join("; ")}`);
    assert.equal(r.result.blocksCreated, 1, `${startRef}–${endRef}: one block`);
    const block = r.state.blocks.find((b) => b.active);
    assert.ok(block, "a block was created");
    assert.deepEqual(
      [...block.directMessageIds].sort(),
      ["A", "B", "C", "D", "E"],
      `${startRef}–${endRef}: exactly the offered positional span`,
    );
  }
});
