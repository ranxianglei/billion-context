import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionState } from "../src/types.js";
import { createInitialState } from "../src/state.js";
import { syncBlocks } from "../src/sync.js";
import { cloneState } from "../src/compress.js";
import { mergeCompressionState } from "../src/persist/state-merge.js";

/**
 * Clone-fidelity guard (#2388).
 *
 * CompressionState's clone/hydrate points rebuild the object with EXPLICIT
 * field lists. Every time a new OPTIONAL field lands, any point whose list did
 * not keep up silently drops it — no compile error, no log, no runtime warning;
 * `deadRefs` (#2362/#2370) hit three such points. This suite makes that drift
 * RED instead of silent, with two independent layers:
 *
 *  1. COMPILE-TIME — FIELD_INVENTORY is a mapped type over `keyof
 *     CompressionState` with optionality stripped (`-?`). Adding a field (esp.
 *     an optional one) without listing it here is a TYPE ERROR, so the omission
 *     surfaces at `tsc` before any test runs.
 *  2. RUNTIME — each point runs on a fully-populated reference state and its
 *     actually-missing keys are compared for EXACT equality against the
 *     documented EXPECTED_MISSING set below. A point silently dropping or
 *     gaining a field flips one of those sets and fails, naming the field.
 *
 * EXPECTED_MISSING therefore doubles as the LIVING DOCUMENTATION of each
 * point's known gap list + why it is safe today. Keep it exact: when a gap is
 * fixed (or a new field added), update the set in the SAME change.
 */

/** Compile-time inventory: every CompressionState field, listed exactly once.
 *  `-?` strips optionality so omitting even an optional field is a type error. */
type FieldInventory = { [K in keyof CompressionState]-?: K };
const FIELD_INVENTORY: FieldInventory = {
  blocks: "blocks",
  messageRefs: "messageRefs",
  tokenSnapshot: "tokenSnapshot",
  nudge: "nudge",
  stats: "stats",
  absorbed: "absorbed",
  terminalStreak: "terminalStreak",
  rules: "rules",
  nextRuleId: "nextRuleId",
  hiddenOrphanRefs: "hiddenOrphanRefs",
  sweptOrphanCallIds: "sweptOrphanCallIds",
  pendingOrphanSweepMinRef: "pendingOrphanSweepMinRef",
  emergencyTruncateLatch: "emergencyTruncateLatch",
  refLedgerAligned: "refLedgerAligned",
  timestampsHighWaterRefSeq: "timestampsHighWaterRefSeq",
  suppressMintingOnce: "suppressMintingOnce",
  renderDeferredRefs: "renderDeferredRefs",
  viewLatches: "viewLatches",
  viewLatchConfigDigest: "viewLatchConfigDigest",
  deadRefs: "deadRefs",
  tsStamps: "tsStamps",
  lastPassIds: "lastPassIds",
  nextBlockId: "nextBlockId",
  nextRunId: "nextRunId",
};
const ALL_KEYS = Object.keys(FIELD_INVENTORY) as (keyof CompressionState)[];

/** Populate EVERY field so presence is detectable: a clone omits a field iff
 *  out[k] === undefined here. Every optional field createInitialState does not
 *  seed gets a non-empty sentinel so a conditional copy (cloneState's
 *  `hiddenOrphanRefs ? [...] : undefined`) still counts it as carried. */
function fullyPopulated(): CompressionState {
  const s = createInitialState();
  s.terminalStreak = 3;
  s.hiddenOrphanRefs = ["m00001"];
  s.sweptOrphanCallIds = ["call-1"];
  s.pendingOrphanSweepMinRef = 7;
  s.emergencyTruncateLatch = [{ ref: "m00003", text: "clipped" }];
  s.refLedgerAligned = true;
  s.timestampsHighWaterRefSeq = 0;
  s.suppressMintingOnce = true;
  s.renderDeferredRefs = ["m00004"];
  s.viewLatches = { "m00005": { text: "latched" } };
  s.viewLatchConfigDigest = "digest";
  s.deadRefs = ["m00002"];
  s.tsStamps = { "m00006": 1_700_000_000_000 };
  s.lastPassIds = ["rawA"];
  return s;
}

function missingKeys(out: CompressionState): Set<keyof CompressionState> {
  const missing = new Set<keyof CompressionState>();
  for (const k of ALL_KEYS) if (out[k] === undefined) missing.add(k);
  return missing;
}

function assertFidelity(
  point: string,
  out: CompressionState,
  expectedMissing: readonly (keyof CompressionState)[],
): void {
  const expected = new Set(expectedMissing);
  const actual = missingKeys(out);
  const droppedUndocumented = [...actual].filter((k) => !expected.has(k));
  const carriedStaleAllowlist = [...expected].filter((k) => !actual.has(k));
  assert.equal(
    droppedUndocumented.length + carriedStaleAllowlist.length,
    0,
    `${point} clone-fidelity drift:\n` +
      `  dropped but not documented here: ${JSON.stringify(droppedUndocumented)}\n` +
      `  now carried but still listed as expected-missing: ${JSON.stringify(carriedStaleAllowlist)}`,
  );
}

test("field inventory covers every populated-state key", () => {
  const extra = Object.keys(fullyPopulated()).filter(
    (k) => !(ALL_KEYS as readonly string[]).includes(k),
  );
  assert.deepEqual(extra, [], `fullyPopulated() has keys outside FIELD_INVENTORY: ${extra.join(", ")}`);
});

// syncBlocks runs every request (pipeline node #4). Its one documented gap is
// safe TODAY, which is why it stays omitted rather than being carried:
//   - lastPassIds: inert — reconcile-live-ids (#1) consumes the host-passed prior
//     pass BEFORE syncBlocks (#4), and processTurn re-stamps result.state.lastPassIds
//     post-pipeline (compress.ts inboundIds snapshot + re-stamp).
// (hiddenOrphanRefs and deadRefs are carried by syncBlocks, so they are not gaps.)
test("syncBlocks carries its documented field set", () => {
  const { state } = syncBlocks([], fullyPopulated());
  assertFidelity(
    "syncBlocks (kernel/src/sync.ts)",
    state,
    ["lastPassIds"],
  );
});

// cloneState (only call sites: applyCompression) copies EVERY field, including
// the conditional optional refs (hiddenOrphanRefs/deadRefs/lastPassIds) and the
// #3939 latch family (emergencyTruncateLatch/renderDeferredRefs/viewLatches/
// viewLatchConfigDigest — the post-fold reset retires them only when a fold
// lands, so a non-folding call must return them intact), so its gap set is empty.
test("cloneState carries its documented field set", () => {
  assertFidelity(
    "cloneState (kernel/src/compress.ts)",
    cloneState(fullyPopulated()),
    [],
  );
});

// mergeCompressionState is the forward-compat HYDRATOR for standalone acp-kernel
// consumers. Unlike the pipeline clones above it must carry EVERY field: a real
// consumer's restart must not lose optional state. Its explicit list carries all
// optional fields as bare passthrough (plus the conditional-spread
// timestampsHighWaterRefSeq), so its gap set is the one DELIBERATE exclusion:
// suppressMintingOnce — re-arming honest-NULL after a restart would eat genuine
// first-sight mints of truly new messages; dropping it is the safe default
// (same decision as the host's mergeState, src/state-hydration.ts).
test("mergeCompressionState carries every field (forward-compat hydrator)", () => {
  assertFidelity(
    "mergeCompressionState (kernel/src/persist/state-merge.ts)",
    mergeCompressionState(fullyPopulated()),
    ["suppressMintingOnce"],
  );
});
