import type { SearchAlgorithm, SearchDoc, ScoredBlock } from "../types.js";
import { charBigrams, CJK } from "../tokenizer.js";
import { docFeatures } from "../doc-cache.js";

/**
 * Fuzzy character-bigram matching (Jaccard-style).
 *
 * Decomposes the query into character bigrams and measures overlap with
 * each doc. Robust to typos (tokan≈token), partial words, and works
 * uniformly across all scripts (CJK benefits most).
 *
 * Query-token gate — CJK gets its own length rule; Latin is frozen:
 *   length >= 4 (any script)   typo-tolerant bigram rescue needs a couple of
 *       chars before it means anything; 2-3-char Latin tokens ("to", "of",
 *       "us") are stop-word noise whose bigrams overlap nearly every doc.
 *   length >= 2 && CJK         Chinese/Japanese/Korean words are mostly
 *       2-character atomic units (登录/缓存/図表), so the Latin-style >= 4 rule
 *       would lock the whole CJK query space out of this recall channel
 *       (that gap is what bench "缓存 → nothing" exposed). Single CJK chars
 *       stay excluded — one char cannot form a bigram, nothing to compare.
 *
 * On benchmark: lowest MRR of any single algorithm (0.795 — a hair under
 * substring's 0.797) — precision is weak, but it is the recall boost in the
 * hybrid default.
 */
export const fuzzyAlgorithm: SearchAlgorithm = {
  name: "fuzzy",
  description:
    "Character bigram overlap. Typo-tolerant, script-agnostic, high recall.",
  score(docs: SearchDoc[], query: string): ScoredBlock[] {
    // Gate (see header): Latin short tokens are noise, 2-char CJK words
    // are real terms — admit the latter so 缓存/登录 reach the scorer.
    const qTokens = query
      .toLowerCase()
      .split(/[\s,]+/)
      .filter((t) => t.length >= 4 || (t.length >= 2 && CJK.test(t)));
    if (qTokens.length === 0)
      return docs.map((d) => ({ ref: d.ref, score: 0 }));

    const qGrams = new Set<string>();
    for (const t of qTokens) for (const g of charBigrams(t)) qGrams.add(g);
    if (qGrams.size === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));

    return docs.map((d) => {
      const docGrams = docFeatures(d.text).grams; // memoized bigram set
      let hits = 0;
      for (const g of qGrams) if (docGrams.has(g)) hits++;
      return { ref: d.ref, score: hits / qGrams.size };
    });
  },
};
