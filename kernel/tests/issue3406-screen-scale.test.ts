// #3406 item 11: the per-turn recommendation screen is a full-projection
// hot path — screenRecommendedUnits runs projectUnit over EVERY recommended
// unit, and each projection rescans the message array (carrier scan,
// protected-tool filter, media check), so the cost is O(n·m): n messages ×
// m units. Nothing pinned that curve: a regression that adds one more
// full-array pass inside projectUnit would silently slow every turn of
// every large session. This test does NOT optimize anything (that is a
// separate issue by design) — it only pins the curve so an
// order-of-magnitude regression cannot land silently.
//
// Thresholds are deliberately loose to stay flake-free on slow CI runners:
// each rung is measured as the MIN of 3 runs (noise only ever adds time),
// and the cap is ~10x the authoring-machine baseline with an absolute
// floor (see #3406: "阈值放宽,只防数量级退化,防 flake"). Baselines recorded
// at authoring time (warm, 1 run): m=10 → ~7.5ms, m=40 → ~24ms, m=120 →
// ~63ms, full chain n=2000 → ~54ms. Measured times are printed to the test
// output on every run for the record.

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
import { defaultConfig } from "../src/config.js";
import type {
  CompressibleRange,
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "../src/types.js";

/** Loose per-rung caps: ~10x the recorded baseline, floored so a slow-but-
 * healthy CI machine (several times slower than the authoring box) never
 * flakes. A real O(n·m)→O(n²·m) regression blows through these by 10-100x
 * on ANY machine. */
const CAP_SMALL_MS = 750;
const CAP_LARGE_MS = 1_000;

const N_MESSAGES = 2_000;
const SPAN = 10;

/** Deterministic synthetic session: a 10-message turn pattern (user /
 * reasoning / tool call / tool result / assistant filler) — the same shape
 * family as the #498 scale fixtures — with 40 active tier-1 blocks covering
 * the first 800 messages, so screening exercises BOTH the covered
 * (directMessageIds empty) and uncovered (advertised) projection paths. */
function buildSession(): {
  state: CompressionState;
  messages: CoreMessage[];
  config: ReturnType<typeof defaultConfig>;
  protectedRefs: Set<string>;
} {
  const messages: CoreMessage[] = [];
  for (let i = 0; i < N_MESSAGES; i++) {
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
  for (let b = 0; b < 40; b++) {
    const ids = messages.slice(b * 20, (b + 1) * 20).map((m) => m.id);
    state.blocks.push(block(b + 1, ids));
  }
  const config = defaultConfig(212_992);
  const protectedRefs = computeProtectedRefs(messages, state, config);
  return { state, messages, config, protectedRefs };
}

/** `count` non-overlapping fresh units over the UNCOVERED tail (from raw
 * message 801 on), span SPAN each — every unit must survive screening, so
 * each runs the projection to completion (the advertised path). */
function tailUnits(count: number): CompressibleRange[] {
  const out: CompressibleRange[] = [];
  for (let k = 0; k < count; k++) {
    const start = 800 + k * SPAN;
    const end = start + SPAN - 1;
    out.push({
      startRef: `m${String(start + 1).padStart(5, "0")}`,
      endRef: `m${String(end + 1).padStart(5, "0")}`,
      count: SPAN,
      tokens: SPAN * 200,
    });
  }
  return out;
}

/** min of `runs` wall-time measurements (noise only ever adds time). */
function timedMin<T>(runs: number, fn: () => T): { out: T; ms: number } {
  let ms = Infinity;
  let out: T | undefined;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    out = fn();
    const el = performance.now() - t0;
    if (el < ms) ms = el;
  }
  return { out: out as T, ms };
}

describe("#3406 item 11 — full-projection screen scale (n=2000, unit gradient)", () => {
  it("hand-built unit gradient: m=10 / 40 / 120 stays within the recorded cap", () => {
    const { state, messages, config, protectedRefs } = buildSession();

    // JIT warm-up, not measured.
    screenRecommendedUnits(
      tailUnits(10),
      messages,
      state,
      config,
      protectedRefs,
    );

    for (const [m, cap] of [
      [10, CAP_SMALL_MS],
      [40, CAP_SMALL_MS],
      [120, CAP_LARGE_MS],
    ] as const) {
      const units = tailUnits(m);
      const { out, ms } = timedMin(3, () =>
        screenRecommendedUnits(units, messages, state, config, protectedRefs),
      );
      // Functional pin: the timing is only meaningful if the units really
      // run the full advertised projection (kept === m), not a vacuous
      // early-drop path.
      assert.equal(
        out.length,
        m,
        `m=${m}: every fresh tail unit stays advertised`,
      );
      assert.ok(
        ms < cap,
        `screenRecommendedUnits n=${N_MESSAGES} m=${m} took ${ms.toFixed(1)}ms (cap ${cap}ms) — order-of-magnitude regression in the projection hot path`,
      );
      console.log(
        `#3406 scale record: n=${N_MESSAGES} m=${m} → ${ms.toFixed(1)}ms (${(ms / m).toFixed(2)}ms/unit, cap ${cap}ms)`,
      );
    }
  });

  it("real recommend chain at n=2000 (buildCompressibleRanges → merge → screen) within cap", () => {
    const { state, messages, config } = buildSession();
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
    const { out, ms } = timedMin(3, run);
    assert.ok(out.length > 0, "large session still offers ranges");
    assert.ok(
      ms < CAP_LARGE_MS,
      `full recommend chain n=${N_MESSAGES} took ${ms.toFixed(1)}ms (cap ${CAP_LARGE_MS}ms)`,
    );
    console.log(
      `#3406 scale record: real chain n=${N_MESSAGES} → ${ms.toFixed(1)}ms, ${out.length} units advertised (cap ${CAP_LARGE_MS}ms)`,
    );
  });
});
