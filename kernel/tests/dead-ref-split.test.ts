import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCompressibleRanges,
  mergeRangesToThreshold,
} from "../src/recommend.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";

// #3192/#3205: a client-dropped message leaves a hole in the ref map that
// array-adjacency segmentation bridges, so buildCompressibleRanges must break
// groups at recorded-dead refs and emit adjacent live sub-spans — and
// mergeRangesToThreshold must not bridge them back across the hole.

function config(overrides: Partial<Config> = {}): Config {
  return {
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
    ...overrides,
  };
}

function msg(id: string, text: string): CoreMessage {
  return { id, role: "assistant", contentType: "text", text };
}

/** Mint refs m00001.. over the FULL id list, then hand back the state plus the
 *  source messages so a test can drop entries from the visible view. */
function setup(ids: string[]): { messages: CoreMessage[]; state: ReturnType<typeof createInitialState> } {
  const messages = ids.map((id) => msg(id, "x".repeat(2000)));
  const state = createInitialState();
  state.messageRefs = assignRefs(messages, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return { messages, state };
}

function spans(ranges: { startRef: string; endRef: string }[]): [string, string][] {
  return ranges.map((r) => [r.startRef, r.endRef]);
}

test("buildCompressibleRanges splits around an interior dead ref into adjacent live sub-spans", () => {
  const { messages, state } = setup(["a", "b", "c", "d", "e"]); // m00001..m00005
  state.deadRefs = ["m00003"]; // 'c' dropped by the client
  const visible = [messages[0], messages[1], messages[3], messages[4]]; // a,b,d,e
  const { compressible } = buildCompressibleRanges(visible, state, config());
  assert.deepEqual(spans(compressible), [
    ["m00001", "m00002"],
    ["m00004", "m00005"],
  ]);
  assert.equal(compressible[0]!.noMergeBefore, undefined);
  assert.equal(compressible[1]!.noMergeBefore, true);
});

test("control: a NON-dead ref-map hole stays bridged (deadRefs empty → unchanged behavior)", () => {
  const { messages, state } = setup(["a", "b", "c", "d", "e"]);
  // Same drop, but 'c' is NOT recorded dead → array adjacency bridges it as before.
  const visible = [messages[0], messages[1], messages[3], messages[4]];
  const { compressible } = buildCompressibleRanges(visible, state, config());
  assert.deepEqual(spans(compressible), [["m00001", "m00005"]]);
});

test("multiple dead holes → one sub-span per surviving run, none brackets a dead ref", () => {
  const { messages, state } = setup(["a", "b", "c", "d", "e", "f", "g"]); // m1..m7
  state.deadRefs = ["m00003", "m00006"]; // drop c and f
  const visible = [
    messages[0],
    messages[1],
    messages[3],
    messages[4],
    messages[6],
  ]; // a,b,d,e,g
  const { compressible } = buildCompressibleRanges(visible, state, config());
  assert.deepEqual(spans(compressible), [
    ["m00001", "m00002"],
    ["m00004", "m00005"],
    ["m00007", "m00007"],
  ]);
  const dead = new Set([3, 6]);
  for (const r of compressible) {
    const s = Number(r.startRef.slice(1));
    const e = Number(r.endRef.slice(1));
    const [lo, hi] = s < e ? [s, e] : [e, s];
    for (let n = lo + 1; n < hi; n++) {
      assert.ok(!dead.has(n), `span ${r.startRef}–${r.endRef} brackets dead ${n}`);
    }
  }
});

test("trailing dead ref never becomes a span endpoint", () => {
  const { messages, state } = setup(["a", "b", "c", "d", "e"]);
  state.deadRefs = ["m00005"]; // drop 'e'
  const visible = [messages[0], messages[1], messages[2], messages[3]]; // a,b,c,d
  const { compressible } = buildCompressibleRanges(visible, state, config());
  assert.deepEqual(spans(compressible), [["m00001", "m00004"]]);
});

test("mergeRangesToThreshold does NOT re-bridge across a dead-ref hole", () => {
  const { messages, state } = setup(["a", "b", "c", "d", "e"]);
  state.deadRefs = ["m00003"];
  const visible = [messages[0], messages[1], messages[3], messages[4]];
  const { compressible } = buildCompressibleRanges(visible, state, config());
  // Each sub-span is ~4000 chars, well above the 1000 gate — without the
  // noMergeBefore flag these would merge back into one doomed m00001–m00005.
  const merged = mergeRangesToThreshold(compressible, 1000);
  assert.deepEqual(spans(merged), [
    ["m00001", "m00002"],
    ["m00004", "m00005"],
  ]);
});
