import type { SearchAlgorithm, SearchDoc, ScoredBlock } from "../types.js";
import { tokenize } from "../tokenizer.js";
import { docFeatures } from "../doc-cache.js";

/**
 * BM25 with stemming + CJK bigram tokenization.
 *
 * k1=1.2, b=0.75 (standard IR). IDF down-weights terms common across the
 * corpus; length normalization prevents long summaries from dominating by
 * raw term count. Stemming collapses English morphology
 * (compress/compressed/compression → ~compress).
 *
 * On the 32-block mixed EN/CJK benchmark: MRR 0.833 / R@1 0.833 / R@3 0.833
 * vs 0.797 / 0.792 / 0.792 for substring — better in isolation on every
 * metric, and the precision component of the hybrid default (see hybrid.ts).
 */
export const bm25Algorithm: SearchAlgorithm = {
  name: "bm25",
  description:
    "BM25 with stemming + CJK bigram tokenization. IR-standard relevance ranking.",
  score(docs: SearchDoc[], query: string): ScoredBlock[] {
    const N = docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const parsed = docs.map((d) => {
      const f = docFeatures(d.text); // memoized: tf + length, cached across calls
      return { id: d.ref, tf: f.tf, len: f.len };
    });
    const avgdl = parsed.reduce((s, d) => s + d.len, 0) / (N || 1);

    const qTerms = tokenize(query, { stem: true });
    if (qTerms.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));

    const idf = new Map<string, number>();
    for (const t of new Set(qTerms)) {
      let df = 0;
      for (const d of parsed) if (d.tf.has(t)) df++;
      idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
    }

    return parsed.map((d) => {
      let score = 0;
      for (const t of qTerms) {
        const f = d.tf.get(t) ?? 0;
        if (f === 0) continue;
        const idfT = idf.get(t) ?? 0;
        score +=
          (idfT * (f * (k1 + 1))) /
          (f + k1 * (1 - b + (b * d.len) / (avgdl || 1)));
      }
      return { ref: d.id, score };
    });
  },
};
