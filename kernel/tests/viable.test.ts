import { test } from "node:test";
import assert from "node:assert/strict";
import { VIABLE_RANGE_MIN_TOKENS, viableRanges } from "../src/viable.js";

test("viableRanges drops fragmented ranges below the floor", () => {
  const ranges = [
    { startRef: "m00001", endRef: "m00004", tokens: 57 },
    { startRef: "m00006", endRef: "m00006", tokens: 8 },
    { startRef: "m00119", endRef: "m00128", tokens: 1_000 },
    { startRef: "m00200", endRef: "m00201", tokens: 4_700 },
  ];
  const kept = viableRanges(ranges);
  assert.deepEqual(
    kept.map((r) => r.tokens),
    [1_000, 4_700],
  );
  assert.equal(VIABLE_RANGE_MIN_TOKENS, 200);
});

test("viableRanges boundary: exactly the floor is kept, empty is empty", () => {
  assert.equal(viableRanges([{ tokens: 200 }]).length, 1);
  assert.deepEqual(viableRanges([]), []);
});
