/**
 * Doc-features cache — memoization of per-doc derived data across search
 * calls (src/search/doc-cache.ts).
 *
 * The corpus of a long session (compressed block summaries + folded message
 * text) is immutable, so a search_context call must not re-tokenize /
 * re-lowercase / rebuild bigram sets for the whole corpus on every query.
 * These tests pin the cache semantics and the eviction cap.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  docFeatures,
  clearDocFeatures,
  docCacheInfo,
  setDocCacheCap,
  searchBlocks,
  type SearchDoc,
} from "../src/index.js";
import { tokenize } from "../src/search/tokenizer.js";

const DEFAULT_CAP = 8 * 1024 * 1024;

test("docFeatures: same text → same cached object", () => {
  clearDocFeatures();
  const a = docFeatures("缓存命中 cache hit 身份验证");
  const b = docFeatures("缓存命中 cache hit 身份验证");
  assert.equal(a, b, "second call must return the cached instance");
  assert.ok(docCacheInfo().entries >= 1);
});

test("docFeatures: different text → different objects, independent data", () => {
  clearDocFeatures();
  const a = docFeatures("身份验证失败"); // → 身份,验证,失败 (CLDR dictionary words)
  const b = docFeatures("请求超时处理"); // → 请求,超,时,处理
  assert.notEqual(a, b);
  assert.ok(a.tf.has("身份") && !a.tf.has("请求"));
  assert.ok(b.tf.has("请求") && !b.tf.has("身份"));
});

test("docFeatures: derived fields are correct", () => {
  clearDocFeatures();
  const f = docFeatures("The quick Cache cache CACHE, 缓存 缓存 hit");
  assert.ok(f.lower.startsWith("the quick cache"), "lower must be lowercased");
  assert.equal(
    f.tf.get("cache"),
    3,
    "stemmed tf counts case-insensitive repeats",
  );
  assert.equal(f.tf.get("缓存"), 2, "CJK word tokens counted per occurrence");
  assert.ok(f.len >= f.tf.size, "len = sum of tf values");
  assert.ok(f.grams.has("qu"), "bigrams of the lower-cased text");
  assert.ok(f.grams.has("缓存"), "CJK word bigrams present");
});

test("clearDocFeatures: forces a rebuild", () => {
  clearDocFeatures();
  const a = docFeatures("缓存命中 test-clear");
  clearDocFeatures();
  const b = docFeatures("缓存命中 test-clear");
  assert.notEqual(a, b, "after clear the features must be rebuilt");
  assert.equal(docCacheInfo().entries, 1);
});

test("setDocCacheCap: small cap evicts least-recently-used, info tracks occupancy", () => {
  clearDocFeatures();
  setDocCacheCap(20);
  try {
    docFeatures("a".repeat(10)); // 10 chars
    docFeatures("b".repeat(10)); // 10+10 <= 20 → both fit, no eviction
    assert.equal(docCacheInfo().entries, 2);
    assert.equal(docCacheInfo().chars, 20);
    docFeatures("c".repeat(15)); // 20+15 > 20 → evict LRU head (a), then (b)
    assert.equal(docCacheInfo().entries, 1);
    assert.equal(docCacheInfo().chars, 15);
  } finally {
    setDocCacheCap(DEFAULT_CAP);
    clearDocFeatures();
  }
});

test("LRU: re-accessing a doc keeps it alive (FIFO would evict it)", () => {
  clearDocFeatures();
  setDocCacheCap(25);
  try {
    const a = docFeatures("a".repeat(10)); // cache [a]
    docFeatures("b".repeat(10)); // cache [a, b]
    docFeatures("a".repeat(10)); // re-access a → LRU order [b, a]
    docFeatures("c".repeat(15)); // 20+15>25 → evict LRU head (b); a survives
    const a2 = docFeatures("a".repeat(10));
    assert.equal(
      a2,
      a,
      "LRU must keep the re-accessed doc; FIFO would have evicted it",
    );
  } finally {
    setDocCacheCap(DEFAULT_CAP);
    clearDocFeatures();
  }
});

test("setDocCacheCap(Infinity): whole corpus cached, no eviction", () => {
  clearDocFeatures();
  setDocCacheCap(Infinity);
  try {
    docFeatures("a".repeat(100));
    docFeatures("b".repeat(100));
    docFeatures("c".repeat(100));
    assert.equal(
      docCacheInfo().entries,
      3,
      "no eviction under an Infinity cap",
    );
    assert.equal(docCacheInfo().chars, 300);
  } finally {
    setDocCacheCap(DEFAULT_CAP);
    clearDocFeatures();
  }
});

test("setDocCacheCap: lowering the cap evicts immediately", () => {
  clearDocFeatures();
  try {
    setDocCacheCap(DEFAULT_CAP);
    docFeatures("x".repeat(100));
    assert.equal(docCacheInfo().entries, 1);
    setDocCacheCap(50);
    assert.equal(
      docCacheInfo().entries,
      0,
      "oversized-after-lowering doc must be evicted",
    );
    assert.equal(docCacheInfo().chars, 0);
  } finally {
    setDocCacheCap(DEFAULT_CAP);
    clearDocFeatures();
  }
});

test("docs larger than the cap are never cached", () => {
  clearDocFeatures();
  try {
    setDocCacheCap(100);
    const f = docFeatures("alpha ".repeat(100)); // 600 chars > 100 cap
    assert.ok(f.tf.has("alpha"), "features are still returned");
    assert.equal(
      docCacheInfo().entries,
      0,
      "oversized doc must not enter the cache",
    );
  } finally {
    setDocCacheCap(DEFAULT_CAP);
    clearDocFeatures();
  }
});

test("searchBlocks: results identical on warm cache (no score drift)", () => {
  clearDocFeatures();
  const docs: SearchDoc[] = [
    {
      kind: "block",
      ref: "b1",
      text: "缓存服务 命中率 0.87 身份验证失败 请求超时",
      title: "b1",
      blockId: "b1",
      tier: 1,
      tokens: 100,
    },
    {
      kind: "message",
      ref: "m1",
      text: "the auth flow failed twice, then the cache warm-up finished",
      title: "m1",
      role: "tool",
      blockId: "b2",
      tier: 1,
      tokens: 50,
    },
    {
      kind: "block",
      ref: "b2",
      text: "auth failure 身份验证 cache warmup 缓存预热",
      title: "b2",
      blockId: "b2",
      tier: 1,
      tokens: 80,
    },
  ];
  const cold = searchBlocks(docs, "缓存 身份验证");
  const warm = searchBlocks(docs, "缓存 身份验证");
  assert.deepEqual(
    warm.map((r) => [r.ref, r.score]),
    cold.map((r) => [r.ref, r.score]),
    "cached features must not change scores",
  );
  assert.ok(cold.length >= 1);
  clearDocFeatures();
});

test("single-pass CJK segmentation: run grouping edge cases", () => {
  // Pins the tokenizer rewrite (one segmenter pass over the whole text,
  // runs re-derived) against the per-run implementation's token contract.
  // Expected token sets are the ACTUAL CLDR dictionary outputs (verified on
  // Node 25 ICU) — do not "fix" them to nicer segmentations.
  // all-OOV run → bigrams + singles (fallback preserved across the rewrite)
  const oov = tokenize("㐀㐁㐂", {});
  assert.deepEqual(oov, ["㐀㐁", "㐁㐂", "㐀", "㐁", "㐂"]);
  // dictionary run keeps whole words; single chars inside a word-found run are dropped
  assert.deepEqual(tokenize("身份验证流程", {}), ["身份", "验证", "流程"]);
  // single CJK char stays a token
  assert.deepEqual(tokenize("缓", {}), ["缓"]);
  // mixed: latin + several CJK runs, latin first, runs in text order
  const mixed = tokenize("cache 缓存 pool 连接池", {});
  assert.ok(mixed.includes("cache") && mixed.includes("pool"));
  assert.ok(
    mixed.indexOf("缓存") !== -1,
    `缓存 (OOV bigram) missing in ${JSON.stringify(mixed)}`,
  );
  assert.ok(
    mixed.indexOf("缓存") < mixed.indexOf("连接"),
    "run order must follow text order",
  );
});
