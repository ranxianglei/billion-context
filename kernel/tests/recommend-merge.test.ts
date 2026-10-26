import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRangesToThreshold } from "../src/recommend.js";
import type { CompressibleRange } from "../src/types.js";

function makeRange(
  overrides: Partial<CompressibleRange> & Pick<CompressibleRange, "tokens">,
): CompressibleRange {
  return {
    startRef: "m00001",
    endRef: "m00005",
    count: 1,
    toolPct: 0,
    textPct: 100,
    ...overrides,
  };
}

test("empty ranges → []", () => {
  assert.deepEqual(mergeRangesToThreshold([], 5000), []);
});

test("minChars <= 0 → ranges unchanged (disabled)", () => {
  const ranges = [
    makeRange({ tokens: 100, startRef: "m00001", endRef: "m00002" }),
    makeRange({ tokens: 200, startRef: "m00003", endRef: "m00004" }),
  ];
  assert.equal(mergeRangesToThreshold(ranges, 0), ranges);
  assert.equal(mergeRangesToThreshold(ranges, -1), ranges);
});

test("single range already >= threshold → returned as one batch unchanged", () => {
  const ranges = [
    makeRange({
      tokens: 1250,
      count: 4,
      toolPct: 50,
      textPct: 50,
      startRef: "m00001",
      endRef: "m00010",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.tokens, 1250);
  assert.equal(out[0]!.count, 4);
  assert.equal(out[0]!.startRef, "m00001");
  assert.equal(out[0]!.endRef, "m00010");
});

test("two small ranges whose sum >= threshold → ONE merged batch", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 2,
      toolPct: 100,
      textPct: 0,
      startRef: "m00001",
      endRef: "m00005",
    }),
    makeRange({
      tokens: 700,
      count: 3,
      toolPct: 0,
      textPct: 100,
      startRef: "m00010",
      endRef: "m00020",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1, "should merge into a single batch");
  assert.equal(out[0]!.count, 5);
  assert.equal(out[0]!.tokens, 1300);
  assert.equal(out[0]!.startRef, "m00001");
  assert.equal(out[0]!.endRef, "m00020", "endRef = second child endRef");
});

test("sub-threshold tail folds into preceding batch (overshoot allowed)", () => {
  // Regression (#309 / billion-context #847): the old trailing flush emitted
  // the 200-char tail as its own batch, which nudge then listed as
  // compressible even though the apply-side gate rejects it standalone.
  const ranges = [
    makeRange({
      tokens: 600,
      count: 1,
      startRef: "m00001",
      endRef: "m00003",
    }),
    makeRange({
      tokens: 700,
      count: 1,
      startRef: "m00004",
      endRef: "m00006",
    }),
    makeRange({
      tokens: 50,
      count: 1,
      startRef: "m00010",
      endRef: "m00011",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1, "tail folded into the preceding batch");
  assert.equal(out[0]!.tokens, 1350, "batch + tail summed");
  assert.equal(out[0]!.count, 3);
  assert.equal(out[0]!.startRef, "m00001");
  assert.equal(out[0]!.endRef, "m00011", "span extended to the tail's endRef");
  assert.ok(
    (out[0]!.chars ?? out[0]!.tokens * 4) >= 5000,
    "folded batch alone clears the gate",
  );
});

test("dangerous: true on a child propagates to merged batch", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 1,
      startRef: "m00001",
      endRef: "m00002",
    }),
    makeRange({
      tokens: 700,
      count: 1,
      startRef: "m00003",
      endRef: "m00004",
      dangerous: true,
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.dangerous, true, "dangerous flag propagates");
});

test("no dangerous children → merged batch omits dangerous", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 1,
      startRef: "m00001",
      endRef: "m00002",
    }),
    makeRange({
      tokens: 700,
      count: 1,
      startRef: "m00003",
      endRef: "m00004",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.dangerous, undefined, "no dangerous flag when none set");
});

test("count-weighted toolPct: A(count2,tool100) + B(count3,tool0) → 40 / 60", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 2,
      toolPct: 100,
      textPct: 0,
      startRef: "m00001",
      endRef: "m00002",
    }),
    makeRange({
      tokens: 700,
      count: 3,
      toolPct: 0,
      textPct: 100,
      startRef: "m00003",
      endRef: "m00004",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.toolPct, 40, "round((100×2 + 0×3)/5) = 40");
  assert.equal(out[0]!.textPct, 60, "textPct = 100 - toolPct");
});

test("merges across ref gaps (non-adjacent refs)", () => {
  const ranges = [
    makeRange({
      tokens: 600,
      count: 1,
      startRef: "m00001",
      endRef: "m00002",
    }),
    makeRange({
      tokens: 700,
      count: 1,
      startRef: "m00050",
      endRef: "m00060",
    }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1, "non-adjacent refs still merge");
  assert.equal(out[0]!.startRef, "m00001");
  assert.equal(out[0]!.endRef, "m00060");
});

test("all content below threshold → [] (nothing can clear the gate)", () => {
  // Total = 3×400 = 1200 chars < 5000: no selection of this content can pass
  // the apply-side gate, so offering a merged sub-threshold range would only
  // produce guaranteed-rejected calls (#309). Offer nothing instead.
  const ranges = [
    makeRange({ tokens: 100, count: 1, startRef: "m00001", endRef: "m00002" }),
    makeRange({ tokens: 100, count: 1, startRef: "m00003", endRef: "m00004" }),
    makeRange({ tokens: 100, count: 1, startRef: "m00005", endRef: "m00006" }),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.deepEqual(out, [], "sub-threshold remainder is not offered");
});

test("invariant: every emitted batch alone clears minChars", () => {
  // #309: nudge lists recommendedRanges verbatim; any entry below the gate's
  // char floor is a guaranteed-rejected call. Check across shapes: clean
  // flushes, a foldable tail, and real `chars` fields under a CJK-like
  // tokenizer where tokens ≈ chars.
  const cjk = (n: number): CompressibleRange =>
    makeRange({ tokens: n, chars: n, count: Math.max(1, Math.round(n / 50)) });
  for (const [ranges, minChars] of [
    [[cjk(600), cjk(700), cjk(50)], 5000],
    [[cjk(3000), cjk(3000)], 5000],
    [[cjk(6000), cjk(2000), cjk(2000)], 5000],
    [[cjk(100), cjk(100)], 5000],
  ] as Array<[CompressibleRange[], number]>) {
    const out = mergeRangesToThreshold(ranges, minChars);
    for (const r of out) {
      assert.ok(
        r.chars >= minChars,
        `batch ${r.startRef}–${r.endRef} (${r.chars} chars) must clear ${minChars}`,
      );
    }
  }
});

// Ranges carrying array positions (as buildCompressibleRanges always emits).
// A physical gap between endIndex+1 and the next startIndex marks a block /
// protected / pruned boundary that batching must never bridge (#498).
function indexedRange(
  chars: number,
  startIdx: number,
  endIdx: number,
  startRef: string,
  endRef: string,
): CompressibleRange {
  return makeRange({
    tokens: Math.round(chars / 4),
    chars,
    count: endIdx - startIdx + 1,
    startRef,
    endRef,
    startIndex: startIdx,
    endIndex: endIdx,
  });
}

test("does not bridge an array-index gap even when the sum clears the threshold (#498)", () => {
  // Pre-gap region is contiguous but sub-threshold (4000 < 5000); a block owns
  // array slots 4..9; the post-gap region clears the gate on its own.
  const ranges = [
    indexedRange(2000, 0, 1, "m00001", "m00002"),
    indexedRange(2000, 2, 3, "m00003", "m00004"),
    indexedRange(3000, 10, 12, "m00011", "m00013"),
    indexedRange(3000, 13, 15, "m00014", "m00016"),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1, "only the post-gap region qualifies");
  assert.equal(out[0]!.startRef, "m00011");
  assert.equal(out[0]!.endRef, "m00016");
  assert.deepEqual([out[0]!.startIndex, out[0]!.endIndex], [10, 15]);
});

test("two gapped regions each clearing the gate stay separate batches (#498)", () => {
  const ranges = [
    indexedRange(3000, 0, 1, "m00001", "m00002"),
    indexedRange(3000, 2, 3, "m00003", "m00004"),
    indexedRange(3000, 10, 11, "m00011", "m00012"),
    indexedRange(3000, 12, 13, "m00013", "m00014"),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 2, "each side of the block is its own batch");
  assert.deepEqual([out[0]!.startIndex, out[0]!.endIndex], [0, 3]);
  assert.deepEqual([out[1]!.startIndex, out[1]!.endIndex], [10, 13]);
});

test("sub-threshold tail separated by a gap is dropped, not folded across the block (#498)", () => {
  const ranges = [
    indexedRange(3000, 0, 1, "m00001", "m00002"),
    indexedRange(3000, 2, 3, "m00003", "m00004"),
    indexedRange(2000, 10, 11, "m00011", "m00012"),
  ];
  const out = mergeRangesToThreshold(ranges, 5000);
  assert.equal(out.length, 1, "the sub-threshold post-gap tail is dropped");
  assert.deepEqual([out[0]!.startIndex, out[0]!.endIndex], [0, 3]);
});
