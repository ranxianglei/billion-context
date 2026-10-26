import { test } from "node:test";
import assert from "node:assert/strict";
import { segmentGroups } from "../src/segment.js";
import type { SegmentItem } from "../src/segment.js";

function item(ref: string, isUser = false, gapBefore = false): SegmentItem {
  return { ref, isUser, gapBefore };
}

test("segmentGroups: empty input yields no groups", () => {
  assert.deepEqual(segmentGroups([]), []);
});

test("segmentGroups: single item yields one group", () => {
  assert.deepEqual(segmentGroups([item("m00001")]), [[item("m00001")]]);
});

test("segmentGroups: contiguous non-user items stay in one group", () => {
  const items = [
    item("m00001"),
    item("m00002"),
    item("m00003"),
    item("m00004"),
  ];
  assert.deepEqual(segmentGroups(items), [items]);
});

test("segmentGroups: user message splits once the current group holds >= 3 items", () => {
  const items = [
    item("m00001"),
    item("m00002"),
    item("m00003"),
    item("m00004", true),
  ];
  const groups = segmentGroups(items);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], items.slice(0, 3));
  assert.deepEqual(groups[1], [items[3]!]);
});

test("segmentGroups: user message does not split a group of < 3 items", () => {
  const items = [
    item("m00001"),
    item("m00002"),
    item("m00003", true),
    item("m00004"),
  ];
  assert.deepEqual(segmentGroups(items), [items]);
});

test("segmentGroups: gapBefore always starts a new group", () => {
  const items = [item("m00001"), item("m00005", false, true)];
  const groups = segmentGroups(items);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], [items[0]!]);
  assert.deepEqual(groups[1], [items[1]!]);
});

test("segmentGroups: consecutive gaps keep splitting", () => {
  const items = [
    item("m00001"),
    item("m00005", false, true),
    item("m00009", false, true),
  ];
  assert.equal(segmentGroups(items).length, 3);
});

test("segmentGroups: leading gapBefore has no predecessor group to split from", () => {
  const groups = segmentGroups([item("m00001", false, true), item("m00002")]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], [item("m00001", false, true), item("m00002")]);
});

test("segmentGroups: extra fields pass through untouched (generic T)", () => {
  const items = [
    { ref: "m00001", isUser: false, gapBefore: false, tokens: 7 },
    { ref: "m00002", isUser: false, gapBefore: false, tokens: 9 },
  ];
  const groups = segmentGroups(items);
  assert.equal(groups[0]![0]!.tokens, 7);
});
