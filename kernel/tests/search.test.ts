import test from "node:test";
import assert from "node:assert";
import {
  searchBlocks,
  searchBlocksAsync,
  blockDocs,
  messageDocs,
  clearDocFeatures,
} from "../src/search.js";
import {
  registerSearchAlgorithm,
  listSearchAlgorithms,
} from "../src/search.js";
import { createInitialState } from "../src/state.js";
import type { CompressionState, CompressionBlock } from "../src/types.js";
import type { SearchDoc } from "../src/search/types.js";

function makeBlock(overrides: Partial<CompressionBlock>): CompressionBlock {
  return {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    active: true,
    topic: "",
    summary: "",
    directMessageIds: [],
    effectiveMessageIds: [],
    survivedCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

function stateWithBlocks(...blocks: CompressionBlock[]): CompressionState {
  return { ...createInitialState(), blocks };
}

// ─────────────────────────────────────────────────────────────────────────
// Blocks: active + inactive now both searchable
// ─────────────────────────────────────────────────────────────────────────

test("blockDocs: includes BOTH active and inactive blocks", () => {
  const state = stateWithBlocks(
    makeBlock({
      blockId: "b1",
      active: true,
      topic: "active",
      summary: "live content",
    }),
    makeBlock({
      blockId: "b2",
      active: false,
      topic: "archived",
      summary: "old content",
    }),
  );
  const docs = blockDocs(state);
  assert.equal(docs.length, 2);
  assert.ok(docs.some((d) => d.ref === "b1"));
  assert.ok(docs.some((d) => d.ref === "b2"));
});

test("searchBlocks: finds match in active block", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({
        blockId: "b1",
        summary: "Auth token refresh",
        topic: "Auth",
      }),
      makeBlock({ blockId: "b2", summary: "database pool", topic: "DB" }),
    ),
  );
  const r = searchBlocks(docs, "auth");
  assert.equal(r.length, 1);
  assert.equal(r[0].ref, "b1");
  assert.equal(r[0].kind, "block");
  assert.ok(r[0].score > 0);
});

test("searchBlocks: finds match in INACTIVE block (the bug fix)", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", active: true, summary: "current work" }),
      makeBlock({
        blockId: "b2",
        active: false,
        summary: "old auth token logic",
      }),
    ),
  );
  const r = searchBlocks(docs, "auth");
  assert.equal(r.length, 1);
  assert.equal(r[0].ref, "b2");
});

// ─────────────────────────────────────────────────────────────────────────
// Messages: original text searchable, with role weighting
// ─────────────────────────────────────────────────────────────────────────

test("messageDocs: builds message docs from inputs", () => {
  const docs = messageDocs([
    { ref: "m00100", role: "user", text: "how does auth work", blockId: "b1" },
    {
      ref: "m00200",
      role: "tool",
      text: "auth.ts: 401 handler",
      blockId: "b1",
    },
  ]);
  assert.equal(docs.length, 2);
  assert.equal(docs[0].kind, "message");
  assert.equal(docs[0].role, "user");
  assert.equal(docs[0].blockId, "b1");
});

test("searchBlocks: searches messages by original text", () => {
  const docs = messageDocs([
    {
      ref: "m00100",
      role: "user",
      text: "implement jwt refresh endpoint",
      blockId: "b1",
    },
    {
      ref: "m00200",
      role: "tool",
      text: "postgres connection string",
      blockId: "b2",
    },
  ]);
  const r = searchBlocks(docs, "jwt");
  assert.equal(r.length, 1);
  assert.equal(r[0].ref, "m00100");
  assert.equal(r[0].kind, "message");
  assert.equal(
    r[0].blockId,
    "b1",
    "result carries owning block for decompress",
  );
});

test("searchBlocks: user role outranks tool role at equal text match (role weighting)", () => {
  const docs = messageDocs([
    { ref: "m-tool", role: "tool", text: "match match here", blockId: "b1" },
    { ref: "m-user", role: "user", text: "match match here", blockId: "b1" },
  ]);
  const r = searchBlocks(docs, "match");
  assert.equal(
    r[0].ref,
    "m-user",
    "user (1.5x) beats tool (0.6x) on same content",
  );
  assert.ok(r[0].score > r[1].score);
});

test("searchBlocks: roleWeights option overrides defaults", () => {
  const docs = messageDocs([
    { ref: "m-tool", role: "tool", text: "match match here", blockId: "b1" },
    { ref: "m-user", role: "user", text: "match match here", blockId: "b1" },
  ]);
  // equalize weights → scores tie, order falls back to original
  const r = searchBlocks(docs, "match", {
    roleWeights: { user: 1, tool: 1, assistant: 1, block: 1 },
  });
  assert.ok(Math.abs(r[0].score - r[1].score) < 1e-9);
});

test("searchBlocks: mixed blocks + messages ranked together", () => {
  const docs = [
    ...blockDocs(
      stateWithBlocks(
        makeBlock({
          blockId: "b1",
          summary: "auth token refresh",
          topic: "auth",
        }),
      ),
    ),
    ...messageDocs([
      {
        ref: "m00500",
        role: "assistant",
        text: "auth token refresh detail",
        blockId: "b1",
      },
    ]),
  ];
  const r = searchBlocks(docs, "auth");
  assert.equal(r.length, 2);
  // both should appear; refs preserved
  const refs = r.map((x) => x.ref);
  assert.ok(refs.includes("b1"));
  assert.ok(refs.includes("m00500"));
});

// ─────────────────────────────────────────────────────────────────────────
// Result shape: ref, tokens, preview, decompress hint
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: message result includes tokens + blockId (for decompress hint)", () => {
  const docs = messageDocs([
    {
      ref: "m00420",
      role: "user",
      text: "login flow design".padEnd(500, "."),
      blockId: "b7",
      tokens: 150,
    },
  ]);
  const r = searchBlocks(docs, "login");
  assert.equal(r[0].ref, "m00420");
  assert.equal(r[0].blockId, "b7");
  assert.equal(r[0].tokens, 150);
  assert.match(r[0].preview, /login/);
});

test("searchBlocks: preview centers on the matched term", () => {
  const docs = messageDocs([
    {
      ref: "m1",
      role: "assistant",
      text: "padding ".repeat(20) + " NEEDLE found here " + "more ".repeat(20),
      blockId: "b1",
    },
  ]);
  const r = searchBlocks(docs, "NEEDLE", { previewLength: 40 });
  assert.match(r[0].preview, /NEEDLE/);
  assert.ok(!r[0].preview.startsWith("padding padding"));
});

// ─────────────────────────────────────────────────────────────────────────
// Generic behavior + algorithm selection
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: empty query returns nothing", () => {
  const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "content" })));
  assert.equal(searchBlocks(docs, "").length, 0);
  assert.equal(searchBlocks(docs, "   ").length, 0);
});

test("searchBlocks: respects limit", () => {
  const docs = blockDocs(
    stateWithBlocks(
      ...Array.from({ length: 20 }, (_, i) =>
        makeBlock({ blockId: `b${i}`, summary: "match match match" }),
      ),
    ),
  );
  assert.equal(searchBlocks(docs, "match", { limit: 5 }).length, 5);
});

test("searchBlocks: sorts by score descending", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", summary: "one match" }),
      makeBlock({ blockId: "b2", summary: "match match match match" }),
      makeBlock({ blockId: "b3", summary: "match match" }),
    ),
  );
  const r = searchBlocks(docs, "match");
  assert.equal(r[0].ref, "b2");
  assert.ok(r[0].score >= r[1].score);
});

test("searchBlocks: case insensitive", () => {
  const docs = blockDocs(
    stateWithBlocks(makeBlock({ summary: "Auth Token Refresh" })),
  );
  assert.equal(searchBlocks(docs, "AUTH token").length, 1);
});

test("searchBlocks: algorithm option selects algorithm", () => {
  const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "auth token" })));
  const hybrid = searchBlocks(docs, "auth", { algorithm: "hybrid" });
  const substr = searchBlocks(docs, "auth", { algorithm: "substring" });
  assert.ok(hybrid.length > 0 && substr.length > 0);
  assert.ok(substr[0].score >= 1, "substring score is occurrence count");
  assert.ok(hybrid[0].score <= 1.0001, "hybrid score is normalized");
});

test("searchBlocks: unknown algorithm returns empty", () => {
  const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "match" })));
  assert.equal(searchBlocks(docs, "match", { algorithm: "nope" }).length, 0);
});

test("listSearchAlgorithms: includes all builtins", () => {
  const names = listSearchAlgorithms().map((a) => a.name);
  for (const n of ["hybrid", "bm25", "fuzzy", "substring"])
    assert.ok(names.includes(n));
});

test("registerSearchAlgorithm: custom algorithm usable by name", () => {
  registerSearchAlgorithm({
    name: "test-prefix",
    description: "prefix-only scorer",
    score(docs, query) {
      const q = query.toLowerCase();
      return docs.map((d) => ({
        ref: d.ref,
        score: d.text.toLowerCase().startsWith(q) ? 1 : 0,
      }));
    },
  });
  const docs = messageDocs([
    { ref: "m1", role: "user", text: "prefix match", blockId: "b1" },
    { ref: "m2", role: "user", text: "no prefix here", blockId: "b2" },
  ]);
  const r = searchBlocks(docs, "prefix", { algorithm: "test-prefix" });
  assert.equal(r.length, 1);
  assert.equal(r[0].ref, "m1");
});

// ─────────────────────────────────────────────────────────────────────────
// Hybrid quality properties
// ─────────────────────────────────────────────────────────────────────────

test("hybrid: CJK query matches CJK content", () => {
  const docs = [
    ...blockDocs(
      stateWithBlocks(
        makeBlock({
          blockId: "b1",
          topic: "用户认证",
          summary: "实现了用户登录认证流程",
        }),
      ),
    ),
    ...messageDocs([
      {
        ref: "m1",
        role: "assistant",
        text: "database postgres pool",
        blockId: "b2",
      },
    ]),
  ];
  const r = searchBlocks(docs, "登录");
  assert.equal(r[0].ref, "b1");
});

test("hybrid: typo tolerance via fuzzy", () => {
  const docs = messageDocs([
    {
      ref: "m1",
      role: "assistant",
      text: "authentication token refresh",
      blockId: "b1",
    },
  ]);
  const r = searchBlocks(docs, "tokan");
  assert.equal(r[0].ref, "m1");
});

test("hybrid: stemming matches morphological variants", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({
        blockId: "b1",
        topic: "compress",
        summary: "the compress utility",
      }),
      makeBlock({
        blockId: "b2",
        topic: "other",
        summary: "completely different caching topic",
      }),
    ),
  );
  const r = searchBlocks(docs, "compressed");
  assert.equal(r[0].ref, "b1");
});

test("tokenize: CJK runs become dictionary words, no single-char noise", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  assert.deepEqual(tokenize("身份验证流程"), ["身份", "验证", "流程"]);
  assert.equal(tokenize("身份验证流程").includes("份"), false);
  assert.equal(tokenize("身份验证流程").includes("证流"), false);
});

test("tokenize: all-OOV run falls back to bigrams (recall preserved)", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  const toks = tokenize("可视化");
  assert.ok(
    toks.includes("可视") || toks.includes("视化"),
    `got ${JSON.stringify(toks)}`,
  );
});

test("tokenize: Japanese katakana becomes dictionary words, not char-run fragments", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  const toks = tokenize("テスト用の文章です");
  assert.ok(toks.includes("テスト"), `got ${JSON.stringify(toks)}`);
  assert.ok(toks.includes("文章"), `got ${JSON.stringify(toks)}`);
  assert.equal(
    toks.includes("テス"),
    false,
    "katakana must not be split into char runs",
  );
  assert.equal(
    toks.includes("スト"),
    false,
    "katakana must not be split into char runs",
  );
});

test("tokenize: Japanese kanji compounds are kept whole, no cross-word fragments", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  const toks = tokenize("日本語の検索テスト");
  assert.ok(toks.includes("日本語"), `got ${JSON.stringify(toks)}`);
  assert.equal(toks.includes("索テ"), false, "no cross-word '索テ' fragment");
});

test("tokenize: Korean hangul becomes dictionary words, no cross-word fragments", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  const toks = tokenize("테스트 문장입니다");
  assert.ok(toks.includes("테스트"), `got ${JSON.stringify(toks)}`);
  assert.equal(toks.includes("니다"), false, "no cross-word '니다' fragment");
});

test("tokenize: single-char query survives via fallback", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  assert.deepEqual(tokenize("验"), ["验"]);
});

test("hybrid: CJK query no longer matches across word boundaries (试验证明 vs 验证)", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", topic: "auth", summary: "用户身份验证通过" }),
      makeBlock({
        blockId: "b2",
        topic: "experiment",
        summary: "试验数据采集已完成",
      }),
    ),
  );
  const r = searchBlocks(docs, "试验证明");
  assert.equal(
    r[0].ref,
    "b2",
    "word-segmented docs must not rank 验证 above 试验",
  );
});

test("hybrid: dictionary word query hits the doc containing the whole word", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({
        blockId: "b1",
        topic: "i18n",
        summary: "i18n 国际化 setup with locales",
      }),
      makeBlock({
        blockId: "b2",
        topic: "logs",
        summary: "ELK 日志栈 采集 过滤 存储。结构化日志 JSON。",
      }),
    ),
  );
  const r = searchBlocks(docs, "国际化");
  assert.equal(r[0].ref, "b1");
});

test("hybrid: OOV doc still recallable via bigram fallback", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", topic: "dash", summary: "可视化" }),
      makeBlock({
        blockId: "b2",
        topic: "cache",
        summary: "缓存策略 redis 层",
      }),
    ),
  );
  const r = searchBlocks(docs, "可视化");
  assert.equal(r[0].ref, "b1");
});

test("hybrid: no RangeError at large doc counts (argument-spread → reduce, #227)", () => {
  // The old `Math.max(...scores)` spread threw RangeError past V8's argument
  // limit (~65K–125K docs). 160K is the scale that crashed on Node 22.
  clearDocFeatures();
  try {
    const n = 160_000;
    const docs: SearchDoc[] = new Array(n);
    for (let i = 0; i < n; i++) {
      docs[i] = {
        kind: "block",
        ref: `b${i}`,
        text: `doc ${i} alpha beta`,
        title: `b${i}`,
        blockId: `b${i}`,
        tier: 1,
        tokens: 10,
      };
    }
    const r = searchBlocks(docs, "alpha", { algorithm: "hybrid", limit: 10 });
    assert.equal(r.length, 10);
    assert.ok(r[0].score > 0);
  } finally {
    clearDocFeatures();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Async / semantic
// ─────────────────────────────────────────────────────────────────────────

test("searchBlocks: throws for async algorithm when sync entry used", async () => {
  const { createSemanticAlgorithm } =
    await import("../src/search/algorithms/semantic.js");
  registerSearchAlgorithm(
    createSemanticAlgorithm({ embed: async (t) => t.map(() => [1, 0]) }),
  );
  const docs = blockDocs(stateWithBlocks(makeBlock({ summary: "auth login" })));
  assert.throws(
    () => searchBlocks(docs, "login", { algorithm: "semantic" }),
    /searchBlocksAsync/,
  );
});

test("searchBlocksAsync: semantic ranks synonyms by cosine similarity", async () => {
  const { createSemanticAlgorithm } =
    await import("../src/search/algorithms/semantic.js");
  const vocab: Record<string, number[]> = {
    auth: [1, 0],
    login: [0.95, 0.05],
    signin: [0.9, 0.1],
    database: [0, 1],
  };
  const semantic = createSemanticAlgorithm({
    embed: async (texts: string[]) =>
      texts.map((t) => {
        const hit = Object.keys(vocab).find((k) => t.toLowerCase().includes(k));
        return hit ? vocab[hit]! : [0, 0, 1];
      }),
    name: "semantic-syn",
  });
  registerSearchAlgorithm(semantic);
  const docs = messageDocs([
    { ref: "m1", role: "user", text: "login authentication", blockId: "b1" },
    { ref: "m2", role: "user", text: "database postgres", blockId: "b2" },
  ]);
  const r = await searchBlocksAsync(docs, "signin", {
    algorithm: "semantic-syn",
  });
  assert.equal(r[0].ref, "m1", "semantic catches synonym signin≈login");
});

// ─────────────────────────────────────────────────────────────────────────
// Pinned status-quo guards — record CURRENT behavior and fail loudly on
// drift. A green test means "unchanged from the rework baseline", NOT
// "behavior is correct": several of these pin known defects until a fix
// decision is made. Query-side users are LLMs (no typos, retry-capable),
// so typo/camelCase/single-char gaps are low-value defects, not blockers.
// NOTE: "defect #1" (2-char CJK queries never reached the fuzzy scorer) was
// FIXED by the CJK-only gate below — its tests now pin the new behavior.
// ─────────────────────────────────────────────────────────────────────────

test("stem: authenticate family does not converge (pinned, defect #2)", async () => {
  const { stem } = await import("../src/search/stemmer.js");
  assert.equal(stem("authenticate"), "authenticate");
  assert.equal(stem("authenticated"), "authenticat");
  assert.equal(stem("authentication"), "authenticat");
});

test("searchBlocks: morphology family only rescued by fuzzy cap (pinned)", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", summary: "authenticate the user account" }),
    ),
  );
  const r = searchBlocks(docs, "authentication");
  assert.equal(r[0].ref, "b1", "fuzzy bigram overlap still rescues the hit");
  assert.ok(
    r[0].score < 0.7,
    `fuzzy-only rescue must stay under BM25 cap, got ${r[0].score}`,
  );
});

test("fuzzy: 2-char CJK query reaches the scorer, full bigram overlap scores 1 (defect #1 fixed)", () => {
  // 缓存 has no dictionary word in the CLDR zh segmenter — the query would
  // have been dropped by the old >= 4 gate. The CJK-only gate admits it.
  const docs = blockDocs(
    stateWithBlocks(makeBlock({ blockId: "b1", summary: "缓存策略 redis 层" })),
  );
  const r = searchBlocks(docs, "缓存", { algorithm: "fuzzy" });
  assert.equal(r.length, 1, "2-char CJK query must reach the fuzzy scorer");
  assert.equal(r[0].ref, "b1");
  assert.equal(r[0].score, 1, "full bigram overlap scores 1.0");
});

test("fuzzy: 1-char CJK and 2-char Latin queries still filtered (gate is CJK-only)", () => {
  const docs = blockDocs(
    stateWithBlocks(makeBlock({ blockId: "b1", summary: "缓存策略 redis 层" })),
  );
  assert.equal(
    searchBlocks(docs, "验", { algorithm: "fuzzy" }).length,
    0,
    "single char cannot form a bigram",
  );
  assert.equal(
    searchBlocks(docs, "ok", { algorithm: "fuzzy" }).length,
    0,
    "2-char Latin stays filtered (noise)",
  );
  assert.equal(
    searchBlocks(docs, "to", { algorithm: "fuzzy" }).length,
    0,
    "2-char Latin stays filtered (noise)",
  );
});

test("searchBlocks: 2-char CJK typo (登入 vs 登录) still returns nothing — gram mismatch, not gate", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({
        blockId: "b1",
        topic: "用户认证",
        summary: "实现了用户登录认证流程",
      }),
    ),
  );
  const r = searchBlocks(docs, "登入");
  assert.equal(
    r.length,
    0,
    "BM25 sees no shared token; 登入 is now admitted to fuzzy but shares no bigram with 登录",
  );
});

test("searchBlocks: 2-char CJK query rescued end-to-end by fuzzy (缓存 → 缓存策略 doc)", () => {
  // BM25 misses on purpose: 缓存 is not a dictionary word, and the doc's own
  // tokens are its other dictionary words (策略/redis/层). Only the fuzzy
  // channel sees the raw-text bigram 缓存 — which is exactly the recall gap
  // the CJK gate repairs.
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", topic: "viz", summary: "可视化 dashboards" }),
      makeBlock({
        blockId: "b2",
        topic: "cache",
        summary: "缓存策略 redis 层",
      }),
    ),
  );
  const r = searchBlocks(docs, "缓存");
  assert.equal(r.length, 1);
  assert.equal(
    r[0].ref,
    "b2",
    "fuzzy bigram overlap must rescue the cache block",
  );
  assert.ok(r[0].score > 0, "rescued result must not be filtered");
  // Fuzzy-only rescue scores exactly W_FUZZY (0.3) — but ONLY while the ICU
  // dictionary keeps 缓存 a non-word and BM25 misses. That is deliberate:
  // if a Node/ICU bump starts segmenting 缓存 as a dictionary word, BM25
  // takes over and this assertion turns red. The red IS the signal that the
  // dictionary changed — don't paper over it; decide then (e.g. swap the
  // fixture to a word the dictionary still doesn't know).
  assert.ok(
    r[0].score <= 0.31,
    `fuzzy-only rescue caps at W_FUZZY, got ${r[0].score}`,
  );
});

test("hybrid: CJK phrase still ranks whole-word doc above char-run doc (图表可视化, no leftover noise)", () => {
  // Regression guard: the pr-rework guarantee must survive the fuzzy gate —
  // a phrase must rank the fully-matching doc first and must not let the
  // OOV-run doc's bigram leftovers (可视/视化) outrank it via fuzzy.
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", topic: "dash", summary: "可视化" }),
      makeBlock({ blockId: "b2", topic: "charts", summary: "图表可视化" }),
    ),
  );
  const r = searchBlocks(docs, "图表可视化");
  assert.equal(r[0].ref, "b2", "whole-word doc must win");
  assert.ok(r[0].score > 0.5, `BM25 carries the full match, got ${r[0].score}`);
  assert.ok(
    r.every((x) => x.ref !== "b1") || (r[0].ref === "b2" && r[1]?.ref !== "b2"),
    "OOV leftovers must not rank first",
  );
});

test("searchBlocks: single-char query misses dict-word docs, hits OOV docs (pinned, defect #3)", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", topic: "auth", summary: "身份验证流程" }),
      makeBlock({ blockId: "b2", topic: "viz", summary: "可视化" }),
    ),
  );
  const r = searchBlocks(docs, "验");
  assert.ok(
    r.every((x) => x.ref !== "b1"),
    `dict-word doc has no single-char token, got ${JSON.stringify(r)}`,
  );
  const oov = blockDocs(
    stateWithBlocks(makeBlock({ blockId: "b3", summary: "验" })),
  );
  const r2 = searchBlocks(oov, "验");
  assert.equal(
    r2[0].ref,
    "b3",
    "OOV fallback docs keep single chars, still recallable",
  );
});

test("tokenize: camelCase is not split (pinned, defect #3)", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  assert.deepEqual(tokenize("syncBlocks"), ["syncblocks"]);
});

test("searchBlocks: space-separated camelCase query rescued by fuzzy cap (pinned)", () => {
  const docs = blockDocs(
    stateWithBlocks(
      makeBlock({ blockId: "b1", summary: "syncBlocks registry walk" }),
    ),
  );
  const r = searchBlocks(docs, "sync blocks");
  assert.equal(r[0].ref, "b1");
  assert.ok(
    r[0].score < 0.7,
    `single camelCase token can't be BM25-hit via 'sync', got ${r[0].score}`,
  );
});

test("hybrid: fuzzy-only full overlap caps at 0.3 (pinned weight split)", () => {
  const docs = messageDocs([
    { ref: "m1", role: "assistant", text: "auth token refresh", blockId: "b1" },
    { ref: "m2", role: "assistant", text: "tokanxyz", blockId: "b2" },
  ]);
  const r = searchBlocks(docs, "tokan");
  assert.equal(r[0].ref, "m2", "fuzzy full overlap wins");
  assert.ok(
    r[0].score <= 0.31,
    `fuzzy-only score stuck at W_FUZZY cap, got ${r[0].score}`,
  );
});

test("searchBlocks: exact BM25 term hit dominates fuzzy-only overlap (weights pinned)", () => {
  const docs = messageDocs([
    { ref: "m1", role: "assistant", text: "tokenized", blockId: "b1" },
    { ref: "m2", role: "assistant", text: "token", blockId: "b2" },
  ]);
  const r = searchBlocks(docs, "token");
  assert.equal(
    r[0].ref,
    "m2",
    "exact 'token' beats 'tokenized' (stem splits -ized, pinned)",
  );
  assert.ok(
    r[0].score >= 0.7,
    `BM25 channel carries exact hit, got ${r[0].score}`,
  );
});

test("preview: anchored on FIRST hit term only, later terms ignored (pinned, defect #6)", () => {
  const text =
    "a".repeat(20) + " cache strategy " + "b".repeat(40) + " redis config";
  const r = searchBlocks(
    messageDocs([{ ref: "m1", role: "assistant", text, blockId: "b1" }]),
    "cache redis",
    { previewLength: 40 },
  );
  const preview = r[0].preview;
  assert.ok(preview.includes("cache"), `preview centers first hit: ${preview}`);
  assert.ok(
    !preview.includes("redis"),
    `second hit term left out of window: ${preview}`,
  );
});

test("tokenize: empty / punctuation / pure digits (edge)", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("!! ... "), []);
  assert.deepEqual(
    tokenize("4096"),
    [],
    "leading-digit run fails LATIN_WORD first alt, single digits filtered",
  );
  assert.deepEqual(tokenize("value=4096"), ["value"]);
});

test("tokenize: digits inside CJK run dropped (edge)", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  const toks = tokenize("检测到3个异常");
  assert.ok(
    toks.includes("检测") || toks.includes("检测到"),
    `got ${JSON.stringify(toks)}`,
  );
  assert.ok(toks.includes("异常"), `got ${JSON.stringify(toks)}`);
  assert.equal(toks.includes("3"), false, "digit is not CJK, never tokenized");
});

test("tokenize: lone single char survives, in-word single chars drop (asymmetry pinned)", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  assert.deepEqual(tokenize("验"), ["验"], "fallback keeps single-char query");
  assert.equal(
    tokenize("身份验证流程").includes("份"),
    false,
    "segmented words drop interior chars",
  );
});

test("tokenize: stem flag leaves CJK untouched (invariance)", async () => {
  const { tokenize } = await import("../src/search/tokenizer.js");
  assert.deepEqual(
    tokenize("身份验证", { stem: true }),
    tokenize("身份验证", { stem: false }),
  );
});

test("charBigrams: pairs, whitespace filtered, short input empty", async () => {
  const { charBigrams } = await import("../src/search/tokenizer.js");
  assert.deepEqual(charBigrams("登录"), ["登录"]);
  assert.deepEqual(charBigrams("可视 化"), ["可视"]);
  assert.deepEqual(charBigrams("a"), []);
});

test("tfMap: counts per token, stems by flag", async () => {
  const { tfMap } = await import("../src/search/tokenizer.js");
  const m = tfMap("token token 身份", true);
  assert.equal(m.get("token"), 2);
  assert.equal(m.get("身份"), 1);
});
