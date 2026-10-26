import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assignRefs,
  BLOCKED_REF,
  emptyRefMap,
  highestUsedIndex,
  indexToRef,
  rawForRef,
  refForRaw,
  refToIndex,
  rebuildRefIndex,
} from "../src/refs.js";
import type { CoreMessage } from "../src/types.js";

function msg(id: string, role: CoreMessage["role"] = "user"): CoreMessage {
  return { id, role, contentType: "text", text: id };
}

test("indexToRef zero-pads to 5 digits", () => {
  assert.equal(indexToRef(1), "m00001");
  assert.equal(indexToRef(42), "m00042");
  assert.equal(indexToRef(99999), "m99999");
});

test("indexToRef widens naturally beyond the old 99,999 cap (#483)", () => {
  // Byte-stable below the cap, natural width above (pad floor of 5).
  assert.equal(indexToRef(100000), "m100000");
  assert.equal(indexToRef(123456), "m123456");
  assert.equal(indexToRef(9_999_999), "m9999999");
});

test("indexToRef rejects out-of-range indices", () => {
  assert.throws(() => indexToRef(0));
  assert.throws(() => indexToRef(10_000_000));
  assert.throws(() => indexToRef(1.5));
});

test("refToIndex parses and normalizes", () => {
  assert.equal(refToIndex("m00001"), 1);
  assert.equal(refToIndex("m1"), 1);
  assert.equal(refToIndex("M0042"), 42);
  assert.equal(refToIndex("BLOCKED"), null);
  assert.equal(refToIndex("b3"), null);
  assert.equal(refToIndex("xyz"), null);
});

test("refToIndex accepts both widths and enforces the widened cap (#483)", () => {
  assert.equal(refToIndex("m100000"), 100000);
  assert.equal(refToIndex("m0000001"), 1); // leading zeros, 7 digits
  assert.equal(refToIndex("m9999999"), 9_999_999);
  assert.equal(refToIndex("m10000000"), null); // over cap
  assert.equal(refToIndex("m12345678"), null); // 8 digits — not a ref
});

test("assignRefs allocates across the 99,999 → 100,000 boundary (#483)", () => {
  const existing = emptyRefMap();
  existing.byRaw["raw-99999"] = "m99999";
  existing.byRef["m99999"] = "raw-99999";
  const { map, nextIndex, newlyAssigned } = assignRefs(
    [msg("raw-new-1"), msg("raw-new-2")],
    { existing, nextIndex: 99999 },
  );
  assert.equal(map.byRaw["raw-new-1"], "m100000");
  assert.equal(refToIndex(map.byRaw["raw-new-2"]!), 100001);
  assert.equal(nextIndex, 100002);
  assert.equal(newlyAssigned, 2);
});

test("assignRefs assigns sequential refs to new messages", () => {
  const messages = [msg("a"), msg("b"), msg("c")];
  const result = assignRefs(messages, {
    existing: emptyRefMap(),
    nextIndex: 1,
  });

  assert.equal(result.newlyAssigned, 3);
  assert.equal(refForRaw(result.map, "a"), "m00001");
  assert.equal(refForRaw(result.map, "b"), "m00002");
  assert.equal(refForRaw(result.map, "c"), "m00003");
  assert.equal(rawForRef(result.map, "m00002"), "b");
});

test("assignRefs preserves existing refs and continues numbering", () => {
  const existing = emptyRefMap();
  existing.byRaw["a"] = "m00001";
  existing.byRef["m00001"] = "a";

  const messages = [msg("a"), msg("b")];
  const result = assignRefs(messages, { existing, nextIndex: 5 });

  assert.equal(result.newlyAssigned, 1);
  assert.equal(refForRaw(result.map, "a"), "m00001");
  assert.equal(refForRaw(result.map, "b"), "m00005");
});

test("assignRefs marks protected messages as BLOCKED without consuming an index", () => {
  const messages = [msg("a"), msg("b"), msg("c")];
  const result = assignRefs(messages, {
    existing: emptyRefMap(),
    nextIndex: 1,
    isProtected: (m) => m.id === "b",
  });

  assert.equal(refForRaw(result.map, "a"), "m00001");
  assert.equal(refForRaw(result.map, "b"), BLOCKED_REF);
  assert.equal(refForRaw(result.map, "c"), "m00002");
  assert.equal(result.newlyAssigned, 2);
});

test("assignRefs skips messages per shouldSkip", () => {
  const messages = [msg("a"), msg("b"), msg("c")];
  const result = assignRefs(messages, {
    existing: emptyRefMap(),
    nextIndex: 1,
    shouldSkip: (m) => m.id === "b",
  });

  assert.equal(refForRaw(result.map, "b"), null);
  assert.equal(refForRaw(result.map, "a"), "m00001");
  assert.equal(refForRaw(result.map, "c"), "m00002");
});

test("assignRefs skips free indices already taken (no collision)", () => {
  const existing = emptyRefMap();
  existing.byRaw["old"] = "m00002";
  existing.byRef["m00002"] = "old";

  const result = assignRefs([msg("x")], { existing, nextIndex: 1 });
  assert.equal(refForRaw(result.map, "x"), "m00001");
  assert.equal(result.nextIndex, 2);
});

test("rebuildRefIndex drops stale byRef entries and ignores BLOCKED", () => {
  const map = emptyRefMap();
  map.byRaw["a"] = "m00001";
  map.byRaw["b"] = BLOCKED_REF;
  map.byRef["m00099"] = "ghost";

  const rebuilt = rebuildRefIndex(map);
  assert.equal(rawForRef(rebuilt, "m00001"), "a");
  assert.equal(rawForRef(rebuilt, "m00099"), null);
});

test("highestUsedIndex returns max assigned numeric ref", () => {
  const map = emptyRefMap();
  map.byRaw["a"] = "m00003";
  map.byRaw["b"] = "m00010";
  map.byRaw["c"] = BLOCKED_REF;
  assert.equal(highestUsedIndex(map), 10);
});

test("parseBoundary accepts widened refs and keeps block refs unchanged (#483)", async () => {
  const { parseBoundary } = await import("../src/boundaries.js");
  const wide = parseBoundary("m100000");
  assert.ok(wide);
  assert.equal(wide!.kind, "message");
  assert.equal(wide!.numericId, 100000);
  assert.equal(parseBoundary("m9999999")!.numericId, 9_999_999);
  assert.equal(parseBoundary("m10000000"), null); // over the widened cap
  // Legacy-width strings keep resolving (leading-zero tolerant).
  assert.equal(parseBoundary("m00001")!.numericId, 1);
  assert.equal(parseBoundary("m1")!.numericId, 1);
  // Block refs were never width-coupled to message refs.
  assert.equal(parseBoundary("b3")!.kind, "block");
});
