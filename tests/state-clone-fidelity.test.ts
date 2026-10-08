import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionState } from "acp-kernel";
import { createInitialState } from "acp-kernel";
import { mergeState } from "../src/persist.js";

/**
 * Clone-fidelity guard — HOST side (#2388). Companion to
 * kernel/tests/state-clone-fidelity.test.ts (which covers the kernel's own
 * clone/hydrate points). Same two-layer idea: a compile-time field inventory
 * (mapped over `keyof CompressionState`, optionality stripped, so adding a
 * field without listing it is a TYPE ERROR) plus a runtime EXACT match between
 * the fields a point actually carries and the documented expected set.
 */

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

// mergeState is the host restart hydrator (src/persist.ts). It already carries
// every field — #2370 added deadRefs here when it landed. Its expected-missing
// set is therefore empty; this pins that completeness against regression.
test("mergeState carries every field (host hydrator)", () => {
  const out = mergeState(fullyPopulated());
  const expectedMissing: readonly (keyof CompressionState)[] = [];
  const expected = new Set(expectedMissing);
  const actual = missingKeys(out);
  const droppedUndocumented = [...actual].filter((k) => !expected.has(k));
  const carriedStaleAllowlist = [...expected].filter((k) => !actual.has(k));
  assert.equal(
    droppedUndocumented.length + carriedStaleAllowlist.length,
    0,
    `mergeState (src/persist.ts) clone-fidelity drift:\n` +
      `  dropped but not documented: ${JSON.stringify(droppedUndocumented)}\n` +
      `  now carried but still listed as expected-missing: ${JSON.stringify(carriedStaleAllowlist)}`,
  );
});

/**
 * NOT auto-guarded here: the subagent fork (src/plugin.ts, the sub-agent
 * branch handler) is TARGETED inheritance, not a full-state clone — it
 * deliberately skips fields (imageFullRestored / imageShrinks / terminalStreak /
 * tokenSnapshot / nudge-conditionally) and recomputes others. Its failure mode
 * is different: every NEW CompressionState field needs a conscious
 * inherit-or-skip decision at that site, and an unmade decision = silent skip.
 * Driving the handler requires the full session/lock/snapshot harness, so it is
 * documented rather than asserted here. If the owner wants it covered, extract
 * the parent→child state mapping into a pure function and add it to this suite.
 */
