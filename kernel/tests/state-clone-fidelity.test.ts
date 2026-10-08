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
  imageFullRestored: "imageFullRestored",
  imageShrinks: "imageShrinks",
  hiddenOrphanRefs: "hiddenOrphanRefs",
  lastPassIds: "lastPassIds",
  nextBlockId: "nextBlockId",
  nextRunId: "nextRunId",
};
const ALL_KEYS = Object.keys(FIELD_INVENTORY) as (keyof CompressionState)[];

/** Populate EVERY field so presence is detectable: a clone omits a field iff
 *  out[k] === undefined here. The three fields createInitialState does not seed
 *  get non-empty sentinels so a conditional copy (cloneState's
 *  `hiddenOrphanRefs ? [...] : undefined`) still counts them as carried. */
function fullyPopulated(): CompressionState {
  const s = createInitialState();
  s.terminalStreak = 3;
  s.hiddenOrphanRefs = ["m00001"];
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

// syncBlocks runs every request (pipeline node #3). Its four documented gaps are
// all safe TODAY, which is why they stay omitted rather than being carried:
//   - hiddenOrphanRefs: self-heals — hideCompressCallsNode (buildNodes #10, after
//     syncBlocks #3) re-derives it every pass (compress.ts writes
//     state.hiddenOrphanRefs unconditionally).
//   - lastPassIds: inert — reconcile-live-ids (#1) consumes the host-passed prior
//     pass BEFORE syncBlocks (#3), and processTurn re-stamps result.state.lastPassIds
//     post-pipeline (compress.ts inboundIds snapshot + re-stamp).
//   - imageFullRestored / imageShrinks: consumers are host-called tool fns; carrying
//     them would change untested per-request behavior → deferred eval (#2388 item 3).
test("syncBlocks carries its documented field set", () => {
  const { state } = syncBlocks([], fullyPopulated());
  assertFidelity(
    "syncBlocks (kernel/src/sync.ts)",
    state,
    ["imageFullRestored", "imageShrinks", "hiddenOrphanRefs", "lastPassIds"],
  );
});

// cloneState (only call site: applyCompression) already carries hiddenOrphanRefs.
// Its three gaps have no consumer inside the applyCompression path; same trap
// class, deferred per #2388 item 3.
test("cloneState carries its documented field set", () => {
  assertFidelity(
    "cloneState (kernel/src/compress.ts)",
    cloneState(fullyPopulated()),
    ["imageFullRestored", "imageShrinks", "lastPassIds"],
  );
});

// mergeCompressionState is the forward-compat HYDRATOR for standalone acp-kernel
// consumers. Unlike the pipeline clones above it must carry EVERY field: a real
// consumer's restart must not lose optional state. #2388 added the two fields
// this explicit list was missing (hiddenOrphanRefs, lastPassIds), so its gap set
// is empty.
test("mergeCompressionState carries every field (forward-compat hydrator)", () => {
  assertFidelity(
    "mergeCompressionState (kernel/src/persist/state-merge.ts)",
    mergeCompressionState(fullyPopulated()),
    [],
  );
});
