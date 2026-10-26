import type { SearchAlgorithm, SearchDoc, ScoredBlock } from "../types.js";
import { docFeatures } from "../doc-cache.js";

/**
 * Substring counting — the original baseline algorithm.
 * Exact, lowercased substring occurrence counts. Predictable but blind to
 * morphology, typos, and CJK word boundaries. Kept for backward compat and
 * as a deterministic reference.
 */
export const substringAlgorithm: SearchAlgorithm = {
  name: "substring",
  description:
    "Exact substring counting (original baseline). Predictable, no normalization.",
  score(docs: SearchDoc[], query: string): ScoredBlock[] {
    const terms = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) return docs.map((d) => ({ ref: d.ref, score: 0 }));
    return docs.map((d) => {
      const haystack = docFeatures(d.text).lower; // memoized across calls
      let score = 0;
      for (const term of terms) score += countOccurrences(haystack, term);
      return { ref: d.ref, score };
    });
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}
