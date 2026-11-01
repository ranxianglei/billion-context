// #5337 option A: the per-turn recommend screen rebuilt its O(n) per-pass
// derivations INSIDE projectUnit for EVERY screened unit — history index maps,
// the carrier scan, the protected/latest/aged collectors, the tool-pair map,
// the last-user anchor, the turn-integrity pre-scan — so screening cost was
// O(units x n) on top of O(n): at 23k core messages a single processTurn took
// ~17s of blocked event loop (#5304 repro, v0.1.209). The fix shares ONE
// buildProjectionShared(messages, state, config) across all units of a pass.
//
// This file pins two things:
//   1. EQUIVALENCE — with vs without the shared context, projectUnit emits
//      byte-identical judgments (every public UnitProjection field plus the
//      warnings channel) across covered/tail/fatal-zone units. This is the
//      #3236 "same judgment" contract: sharing changed how inputs reach the
//      judgment, never the judgment itself.
//   2. SCALE — the real recommend chain at n=20000 stays under a cap ~5x the
//      authoring-machine fixed baseline (572ms best-of-3) and far below the
//      pre-fix baseline measured on the SAME machine (9028ms best-of-3): an
//      O(n^2) resurfacing blows through by an order of magnitude on ANY box.
// Threshold philosophy follows #3406: min-of-3, loose cap, printed record.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import {
  buildCompressibleRanges,
  computeProtectedRefs,
  mergeRangesToThreshold,
  screenRecommendedUnits,
} from "../src/recommend.js";
import {
  buildProjectionShared,
  collectCoverage,
  projectUnit,
} from "../src/unit-projection.js";
import { defaultConfig } from "../src/config.js";
import type {
  CompressibleRange,
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

/** Same turn-shape family as the #3406 scale fixtures (user / reasoning /
 * tool-call / tool-result / assistant filler), so protection zones, pair
 * integrity, carrier detection and block coverage all light up during the
 * equivalence pass. */
function buildSession(n: number): {
  state: CompressionState;
  messages: CoreMessage[];
  config: ReturnType<typeof defaultConfig>;
  protectedRefs: Set<string>;
} {
  const messages: CoreMessage[] = [];
  for (let i = 0; i < n; i++) {
    const slot = i % 10;
    if (slot === 0 || slot === 1) {
      messages.push({
        id: `u${i}`,
        role: "user",
        contentType: "text",
        text: "u".repeat(800),
      });
    } else if (slot === 2) {
      messages.push({
        id: `r${i}`,
        role: "assistant",
        contentType: "reasoning",
        text: "r".repeat(500),
      });
    } else if (slot === 3) {
      messages.push({
        id: `c${i}`,
        role: "assistant",
        contentType: "tool-call",
        toolName: "read",
        toolCallId: `t${i}`,
        text: "{}",
      });
    } else if (slot === 4) {
      messages.push({
        id: `o${i}`,
        role: "tool",
        contentType: "tool-result",
        toolName: "read",
        toolCallId: `t${i}`,
        text: "x".repeat(1200),
      });
    } else {
      messages.push({
        id: `a${i}`,
        role: "assistant",
        contentType: "text",
        text: "a".repeat(700),
      });
    }
  }
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  state.lastPassIds = messages.map((m) => m.id);
  const block = (id: number, ids: string[]): CompressionBlock => ({
    blockId: `b${id}`,
    runId: `r${id}`,
    tier: 1,
    summary: `Summary ${id}`,
    directMessageIds: ids,
    effectiveMessageIds: ids,
    directBlockIds: [],
    compressedTokens: 100,
    createdAt: 0,
    survivedCount: 1,
    generation: "old",
    active: true,
  });
  // 40 tier-1 blocks over the first 800 messages -> both covered (nested
  // consumption) and uncovered (advertised) projection paths get exercised.
  for (let b = 0; b < 40; b++) {
    const ids = messages.slice(b * 20, (b + 1) * 20).map((m) => m.id);
    state.blocks.push(block(b + 1, ids));
  }
  const config = defaultConfig(212_992);
  const protectedRefs = computeProtectedRefs(messages, state, config);
  return { state, messages, config, protectedRefs };
}

/** Flatten a projection to comparable plain data (error objects keep their
 * message — identity would be meaningless across two runs). */
function shapeOf(
  p: ReturnType<typeof projectUnit>,
  warnings: string[],
): unknown {
  return {
    fatalKind: p.fatal?.kind ?? null,
    fatalError: p.fatal ? p.fatal.error.message : null,
    rangeMessageIds: p.rangeMessageIds,
    skippedCarrierIds: p.skippedCarrierIds,
    nestedBlockIds: p.nestedBlockIds,
    consumedBlockIds: p.consumedBlockIds,
    effectiveMessageIds: [...p.effectiveMessageIds].sort(),
    directMessageIds: p.directMessageIds,
    filteredIds: p.filteredIds,
    withdrawnIds: [...p.withdrawnIds].sort(),
    splitTurnCount: p.splitTurnCount,
    splitPairCount: p.splitPairCount,
    targetTier: p.targetTier,
    outputTier: p.outputTier,
    isBlockBoundary: p.isBlockBoundary,
    warnings,
  };
}

describe("#5337 — shared per-pass derivations across screened units", () => {
  it("projectUnit with/without ProjectionShared yields identical judgments", () => {
    const { state, messages, config, protectedRefs } = buildSession(300);
    const coverage = collectCoverage(state);
    const shared = buildProjectionShared(messages, state, config);
    const ref = (rawIndex: number): string =>
      `m${String(rawIndex + 1).padStart(5, "0")}`;
    // Span shapes that light up different branches: fresh tail (advertised
    // path), inside a tier-1 block (consumption path), crossing a block edge,
    // and a span whose tail lands in the soft-protection zone (fatal path).
    const spans: Array<[number, number]> = [
      [0, 19], // wholly inside b1
      [40, 79], // crosses several block edges
      [100, 119], // uncovered fresh tail
      [260, 289], // deep tail incl. recent protected carriers
    ];
    for (const [start, end] of spans) {
      const run = (withShared: boolean) => {
        const warnings: string[] = [];
        const projection = projectUnit({
          messages,
          state,
          config,
          startRef: ref(start),
          endRef: ref(end),
          preExistingCoverage: coverage,
          protectedMessageIds: protectedRefs,
          warnings,
          ...(withShared ? { shared } : {}),
        });
        return shapeOf(projection, warnings);
      };
      assert.deepEqual(
        run(true),
        run(false),
        `shared vs legacy projection diverged for m${String(start + 1).padStart(5, "0")}..m${String(end + 1).padStart(5, "0")}`,
      );
    }
  });

  it("screenRecommendedUnits keeps every surviving unit advertised identically", () => {
    const { state, messages, config, protectedRefs } = buildSession(1200);
    const coverage = collectCoverage(state);
    const shared = buildProjectionShared(messages, state, config);
    const ref = (rawIndex: number): string =>
      `m${String(rawIndex + 1).padStart(5, "0")}`;
    const units: CompressibleRange[] = [];
    for (let k = 0; k < 12; k++) {
      const start = 810 + k * 10;
      units.push({
        startRef: ref(start),
        endRef: ref(start + 9),
        count: 10,
        tokens: 10 * 200,
      });
    }
    const keptShared = screenRecommendedUnits(
      units,
      messages,
      state,
      config,
      protectedRefs,
    );
    // Legacy screen: rebuild via projectUnit-without-shared demotion rules is
    // what the pre-fix screen did; mirror it directly so a regression in the
    // shared lane's KEEP/DEMOTE boundary is caught here, not only by timing.
    const keptLegacy = units.filter((unit) => {
      let ok = true;
      try {
        const p = projectUnit({
          messages,
          state,
          config,
          startRef: unit.startRef,
          endRef: unit.endRef,
          preExistingCoverage: coverage,
          protectedMessageIds: protectedRefs,
        });
        ok =
          !!p &&
          p.fatal === null &&
          !(p.filteredIds.length === 0 && p.consumedBlockIds.length === 0);
      } catch {
        ok = false;
      }
      return ok;
    });
    assert.deepEqual(
      keptShared.map((u) => u.startRef),
      keptLegacy.map((u) => u.startRef),
    );
  });

  it("real recommend chain at n=20000 stays linear-ish (cap well under the pre-fix baseline)", () => {
    const { state, messages, config } = buildSession(20_000);
    const N = 20_000;
    // Fixed code baseline on the authoring machine: 572ms best-of-3. Pre-fix
    // on the SAME machine/harness: 9028ms best-of-3. Cap = 5x fixed baseline.
    const CAP_MS = 3_000;
    const run = () => {
      const protectedRefs = computeProtectedRefs(messages, state, config);
      const ranges = buildCompressibleRanges(
        messages,
        state,
        config,
        protectedRefs,
      );
      const merged = mergeRangesToThreshold(
        ranges.compressible,
        config.compress.minCompressRange,
      );
      return screenRecommendedUnits(
        merged,
        messages,
        state,
        config,
        protectedRefs,
      );
    };
    run(); // warm-up
    let best = Infinity;
    let out: CompressibleRange[] = [];
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      out = run();
      const el = performance.now() - t0;
      if (el < best) best = el;
    }
    assert.ok(out.length > 0, "large session still offers ranges");
    assert.ok(
      best < CAP_MS,
      `full recommend chain n=${N} took ${best.toFixed(0)}ms (cap ${CAP_MS}ms; pre-fix same-machine baseline 9028ms) — quadratic screen resurfaced`,
    );
    console.log(
      `#5337 scale record: real chain n=${N} → ${best.toFixed(0)}ms, ${out.length} units advertised (cap ${CAP_MS}ms)`,
    );
  });
});
