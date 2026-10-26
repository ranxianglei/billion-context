/**
 * Search quality benchmark — runs the REAL searchBlocks API (public export)
 * against the corpus, for every built-in algorithm, and reports
 * MRR / Recall@1 / Recall@3 + per-query failures.
 *
 * This measures the shipped code, not a prototype. Re-run after any algorithm
 * change to catch regressions:
 *
 *   node --import tsx bench/search/bench.ts
 */

import { searchBlocks, blockDocs } from "../../src/search.js";
import { createInitialState } from "../../src/state.js";
import type { CompressionState, CompressionBlock } from "../../src/types.js";
import { CORPUS, QUERIES } from "./corpus.js";

function toState(): CompressionState {
  const blocks: CompressionBlock[] = CORPUS.map((b) => ({
    blockId: b.blockId,
    runId: "r",
    tier: 1,
    active: true,
    topic: b.topic,
    summary: b.summary,
    directMessageIds: [],
    effectiveMessageIds: [],
    survivedCount: 0,
    createdAt: Date.now(),
  }));
  return { ...createInitialState(), blocks };
}

function evaluate(algorithm: string | undefined) {
  const state = toState();
  let rr = 0,
    c1 = 0,
    it3 = 0;
  const fails: string[] = [];
  for (const q of QUERIES) {
    const r = searchBlocks(blockDocs(state), q.query, { algorithm });
    const got = r[0]?.blockId ?? null;
    const top3 = r.slice(0, 3).map((x) => x.blockId);
    const idx = r.findIndex((x) => x.blockId === q.expectFirst);
    rr += idx >= 0 ? 1 / (idx + 1) : 0;
    if (got === q.expectFirst) c1++;
    if (top3.includes(q.expectFirst)) it3++;
    if (got !== q.expectFirst)
      fails.push(
        `  ✗ [${q.note}] "${q.query}" want ${q.expectFirst} got ${got} ${idx >= 0 ? "#" + (idx + 1) : "ABSENT"}`,
      );
  }
  const n = QUERIES.length;
  return {
    label: algorithm ?? "hybrid (default)",
    mrr: rr / n,
    r1: c1 / n,
    r3: it3 / n,
    fails,
  };
}

console.log(
  `\n=== Search benchmark: ${CORPUS.length} blocks, ${QUERIES.length} queries ===\n`,
);
const algos = ["hybrid", "bm25", "fuzzy", "substring"];
const results = algos.map(evaluate);
for (const r of results) {
  console.log(
    `  ${r.label.padEnd(16)} MRR=${r.mrr.toFixed(3)}  R@1=${r.r1.toFixed(3)}  R@3=${r.r3.toFixed(3)}`,
  );
}
console.log("\n--- default (hybrid) failures ---");
for (const f of results[0].fails) console.log(f);
console.log(
  `\n  (${results[0].fails.length}/${QUERIES.length} not #1 — remaining failures are pure-semantic:\n   synonyms / cross-language, solvable only with embeddings via the optional 'semantic' algorithm)`,
);
