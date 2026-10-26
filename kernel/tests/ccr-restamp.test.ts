import assert from "node:assert/strict";
import test from "node:test";

import {
  createContentStore,
  restampContentStore,
  retrieveByRef,
  storeOriginal,
  type MessageContentStore,
} from "../src/content-store.js";

// #4733: restampRefsToLedger renumbers messageRefs (ref = seq+1) but the CCR
// content store's byRef keys stay frozen at store-time refs. After a restamp
// the two disagree: the stored original for message A sits under the number
// the ref map now vends to message B (silent misattribution on retrieveByRef),
// and host consistency gates that assert byRaw[entry.rawId] === ref reject
// the whole session (plugin fork 409). restampContentStore re-keys the store
// onto the post-restamp map: live raw ids move to their new refs, dead ids
// keep their frozen aliases, and a dead id's alias never shadows a live
// mapping that now owns that number.

function spec(ref: string, rawId: string, text: string) {
  return { ref, rawId, kind: "shell output", tokens: Math.ceil(text.length / 4), text, head: text.slice(0, 24) };
}

test("restampContentStore re-keys live entries and never misattributes", () => {
  let store: MessageContentStore = createContentStore();
  // Store-time aliases: rawA→m00002, rawB→m00003, rawD→m00004 (rawD dies later)
  store = storeOriginal(store, spec("m00002", "rawA", "AAA original"));
  store = storeOriginal(store, spec("m00003", "rawB", "BBB original"));
  store = storeOriginal(store, spec("m00004", "rawD", "DDD original"));

  // Post-restamp map: rawA lands on seq+1 = m00003, rawB on m00005; rawD unmapped.
  // Note rawA's NEW ref collides with rawB's store-time alias.
  const byRaw: Record<string, string> = { rawA: "m00003", rawB: "m00005" };

  const next = restampContentStore(store, byRaw);

  // Live mappings claim their keys: m00003 → rawA's original (NOT rawB's).
  const a = retrieveByRef(next, "m00003");
  assert.ok(a.ok && a.entry.rawId === "rawA" && a.text === "AAA original", "new ref resolves to its own raw id's original");
  const b = retrieveByRef(next, "m00005");
  assert.ok(b.ok && b.entry.rawId === "rawB" && b.text === "BBB original", "rawB re-keyed to its new ref");
  // Dead rawD keeps its frozen alias m00004…
  const d = retrieveByRef(next, "m00004");
  assert.ok(d.ok && d.entry.rawId === "rawD", "dead id keeps its frozen alias");
  // …but its alias was m00004 — no collision here; assert the collision case below.
  assert.equal(next.byRef["m00002"], undefined, "rawA's old key vacated");
});

test("restampContentStore: a dead id's frozen alias never shadows a live mapping", () => {
  let store: MessageContentStore = createContentStore();
  store = storeOriginal(store, spec("m00004", "rawD", "DDD original")); // rawD dies
  store = storeOriginal(store, spec("m00009", "rawA", "AAA original")); // rawA lands on m00004 after restamp
  const byRaw: Record<string, string> = { rawA: "m00004" };
  const next = restampContentStore(store, byRaw);
  const r = retrieveByRef(next, "m00004");
  assert.ok(r.ok && r.entry.rawId === "rawA" && r.text === "AAA original", "live mapping wins the contested number");
});

test("restampContentStore: aligned store is returned unchanged (identity, no copy)", () => {
  let store: MessageContentStore = createContentStore();
  store = storeOriginal(store, spec("m00002", "rawA", "AAA original"));
  const byRaw: Record<string, string> = { rawA: "m00002" };
  assert.equal(restampContentStore(store, byRaw), store, "no-op when already aligned");
});
