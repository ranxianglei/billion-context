/**
 * OPTIONAL semantic search algorithm (embedding-based).
 *
 * NOT registered by default — acp-kernel stays zero-runtime-deps. This is a
 * reference implementation showing how a host plugs in a heavyweight
 * semantic retriever. It catches the queries lexical algorithms cannot:
 * synonyms (login↔登录), cross-language (cache↔缓存), and paraphrase.
 *
 * score() returns a Promise, so use it via searchBlocksAsync():
 *
 *   import { registerSearchAlgorithm, searchBlocksAsync } from "acp-kernel";
 *   import { createSemanticAlgorithm } from "acp-kernel/search/algorithms/semantic";
 *
 *   registerSearchAlgorithm(createSemanticAlgorithm({
 *     embed: async (texts) => embeddingApi.embed(texts),  // → number[][]
 *   }));
 *
 *   const results = await searchBlocksAsync(state, "credentials", { algorithm: "semantic" });
 *
 * The `embed` function is host-supplied — pick any backend:
 *   - @huggingface/transformers (local, ~25MB model, offline, ~25ms/query)
 *   - OpenAI / Voyage / Cohere embeddings API (remote, needs key)
 *   - a local inference server
 *
 * Embeddings are memoized by content hash: docs only re-embed when their
 * summary changes. The query embeds fresh each call.
 */

import type { AsyncSearchAlgorithm, SearchDoc, ScoredBlock } from "../types.js";

export interface EmbedFn {
  (texts: string[]): Promise<number[][]>;
}

export interface SemanticOptions {
  embed: EmbedFn;
  name?: string;
}

interface CachedEmbedding {
  hash: string;
  vec: number[];
}

function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createSemanticAlgorithm(
  opts: SemanticOptions,
): AsyncSearchAlgorithm {
  const name = opts.name ?? "semantic";
  const cache = new Map<string, CachedEmbedding>();

  return {
    name,
    description:
      "Embedding cosine similarity (host-supplied embed fn). Catches synonyms/cross-lang lexical algorithms miss.",

    async score(docs: SearchDoc[], query: string): Promise<ScoredBlock[]> {
      if (docs.length === 0) return [];

      // 1. find docs needing (re)embedding
      const stale: Array<{ id: string; text: string; hash: string }> = [];
      for (const d of docs) {
        const text = d.text;
        const hash = hashText(text);
        const cached = cache.get(d.ref);
        if (!cached || cached.hash !== hash)
          stale.push({ id: d.ref, text, hash });
      }

      // 2. batch-embed stale docs + query in one round-trip
      const toEmbed = stale.map((s) => s.text);
      toEmbed.push(query);
      const vecs = await opts.embed(toEmbed);
      if (vecs.length !== toEmbed.length) {
        return docs.map((d) => ({ ref: d.ref, score: 0 }));
      }
      const qVec = vecs[vecs.length - 1]!;
      for (let j = 0; j < stale.length; j++) {
        cache.set(stale[j]!.id, { hash: stale[j]!.hash, vec: vecs[j]! });
      }

      // 3. cosine similarity
      return docs.map((d) => {
        const cached = cache.get(d.ref);
        return { ref: d.ref, score: cached ? cosine(qVec, cached.vec) : 0 };
      });
    },
  };
}
