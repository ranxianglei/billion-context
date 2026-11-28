import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupeViolation, _resetViolationDedupeForTest } from "../src/invariant-judge.js";

test("violation dedupe: first sighting logs, repeats stay quiet until a power of two", () => {
  _resetViolationDedupeForTest();
  const seen = Array.from({ length: 9 }, () => dedupeViolation("s1|1|mid-history-drop|9|x"));
  assert.deepEqual(seen.map((r) => r.log), [true, true, false, true, false, false, false, true, false]);
  assert.deepEqual(seen.filter((r) => r.log).map((r) => r.count), [1, 2, 4, 8]);
});

test("NEG: a different finding or session is a new sighting and logs", () => {
  _resetViolationDedupeForTest();
  assert.equal(dedupeViolation("s1|1|mid-history-drop|9|x").log, true);
  assert.equal(dedupeViolation("s1|1|mid-history-drop|9|y").log, true);
  assert.equal(dedupeViolation("s2|1|mid-history-drop|9|x").log, true);
});

test("dedupe table is bounded and evicts the oldest key", () => {
  _resetViolationDedupeForTest();
  for (let i = 0; i < 3000; i++) dedupeViolation(`k${i}`);
  assert.equal(dedupeViolation("k0").log, true);
});
