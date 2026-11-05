// #3406 item 9: screenRecommendedUnits' catch swallowed EVERY projection
// exception into a silent `return false`. BoundaryNotFoundError is the
// expected dead/consumed-endpoint false (#3371 family) and must stay
// silent, but any OTHER exception is a programming error — before this
// change the unit vanished from the recommendation with no trace at all.
// Behavior is unchanged (still dropped, never advertised); only a
// console.warn diagnostic is added, mirroring the config-validation warn
// in processTurn (compress.ts). These tests pin both halves: the warn
// fires for unexpected errors, stays silent for boundary-not-found, and
// the screening VERDICT (dropped) never changes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import { screenRecommendedUnits } from "../src/recommend.js";
import { defaultConfig } from "../src/config.js";
import type { CompressibleRange, CoreMessage } from "../src/types.js";

function mk(id: string, role: CoreMessage["role"], len = 3000): CoreMessage {
  return { id, role, contentType: "text", text: "x".repeat(len) };
}

function buildSession(): {
  state: ReturnType<typeof createInitialState>;
  all: CoreMessage[];
} {
  const state = createInitialState();
  const all = [
    mk("U0", "user"),
    mk("W1", "assistant"),
    mk("U2", "user"),
    mk("W3", "assistant"),
  ];
  state.messageRefs = assignRefs(all, {
    existing: state.messageRefs,
    nextIndex: 1,
  }).map;
  return { state, all };
}

/** Capture console.warn lines while fn runs (restored in finally). */
function captureWarn<T>(fn: () => T): { result: T; warns: string[] } {
  const warns: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = real;
  }
}

const malformedUnit: CompressibleRange = {
  // Refs that cannot parse hit resolveBoundaries' plain "Invalid boundary
  // ref(s)" Error — a shape the internal recommender can never produce, so
  // inside the screen's catch it represents the programming-error class.
  startRef: "zz-invalid",
  endRef: "m00002",
  count: 2,
  tokens: 6000,
};

test("#3406: an unexpected projection error warns with unit refs + error summary — verdict unchanged (dropped)", () => {
  const { state, all } = buildSession();
  const { result, warns } = captureWarn(() =>
    screenRecommendedUnits(
      [malformedUnit],
      all,
      state,
      defaultConfig(100_000),
      new Set(),
    ),
  );
  assert.equal(result.length, 0, "unit is still dropped (behavior unchanged)");
  assert.equal(warns.length, 1, "exactly one diagnostic line per dropped unit");
  assert.match(warns[0]!, /screenRecommendedUnits dropped unit/);
  assert.match(
    warns[0]!,
    /zz-invalid\.\.m00002/,
    "line names the unit endpoints",
  );
  assert.match(
    warns[0]!,
    /Invalid boundary ref/,
    "line carries the error summary",
  );
});

test("#3406: unknown-endpoint units (BoundaryNotFoundError) drop silently — no warn spam for the expected false", () => {
  const { state, all } = buildSession();
  const unknownUnit: CompressibleRange = {
    startRef: "m09999",
    endRef: "m01000",
    count: 2,
    tokens: 6000,
  };
  const { result, warns } = captureWarn(() =>
    screenRecommendedUnits(
      [unknownUnit],
      all,
      state,
      defaultConfig(100_000),
      new Set(),
    ),
  );
  assert.equal(result.length, 0, "unknown-ref unit is dropped");
  assert.equal(
    warns.length,
    0,
    "the expected dead-endpoint false stays silent",
  );
});

test("#3406: consumed-endpoint units (ref resolves, message not in the screened array) drop silently", () => {
  const { state } = buildSession();
  // m00002 exists in the ref map but its message is absent from the array
  // being screened (the pruned-view / array-class mismatch the comment
  // describes) — BoundaryNotFoundError kind "consumed", expected false.
  const screenedView: CoreMessage[] = [mk("U0", "user"), mk("W3", "assistant")];
  const consumedUnit: CompressibleRange = {
    startRef: "m00002",
    endRef: "m00002",
    count: 1,
    tokens: 3000,
  };
  const { result, warns } = captureWarn(() =>
    screenRecommendedUnits(
      [consumedUnit],
      screenedView,
      state,
      defaultConfig(100_000),
      new Set(),
    ),
  );
  assert.equal(result.length, 0, "consumed-ref unit is dropped");
  assert.equal(
    warns.length,
    0,
    "no diagnostic for the expected consumed false",
  );
});

test("#3406: healthy units still pass screening and emit nothing", () => {
  const { state, all } = buildSession();
  const healthy: CompressibleRange = {
    startRef: "m00001",
    endRef: "m00002",
    count: 2,
    tokens: 6000,
  };
  const { result, warns } = captureWarn(() =>
    screenRecommendedUnits(
      [healthy],
      all,
      state,
      {
        ...defaultConfig(100_000),
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
      },
      new Set(),
    ),
  );
  assert.equal(result.length, 1, "healthy unit stays advertised");
  assert.equal(warns.length, 0, "no diagnostic on the happy path");
});
