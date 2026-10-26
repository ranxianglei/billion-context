/**
 * searchBlocks — public search entry point.
 *
 * Scores a unified document set (block summaries + historical messages)
 * and returns ranked results. The model uses search to cheaply locate
 * detail that compression folded into summaries, then decompresses the
 * owning block for the full content.
 *
 * Two entry points:
 *  - searchBlocks()      — sync. Works for all lexical algorithms.
 *  - searchBlocksAsync() — async. Also supports embedding-based semantic
 *                          algorithms whose score() returns a Promise.
 */

import type { CompressionState, CompressionBlock } from "../types.js";
import { getSearchAlgorithm } from "./registry.js";
import type { SearchDoc, ScoredBlock, MessageInput } from "./types.js";
import type { SearchResult, SearchOptions, RoleWeights } from "./types.js";
import { clampPrefix, clampWindow } from "../truncate.js";
import { DEFAULT_ALGORITHM, DEFAULT_ROLE_WEIGHTS } from "./types.js";

/** Build SearchDoc[] from all blocks (active AND inactive) of the state. */
export function blockDocs(state: CompressionState): SearchDoc[] {
  return state.blocks.map((b: CompressionBlock): SearchDoc => ({
    kind: "block",
    ref: b.blockId,
    text: `${b.topic ?? ""} ${b.summary ?? ""}`,
    title: b.topic ?? b.blockId,
    blockId: b.blockId,
    tier: b.tier ?? 1,
    tokens: b.compressedTokens,
  }));
}

/**
 * Build SearchDoc[] from historical messages supplied by the host. The host
 * (pai-acp) reads these from the append-only session log — they include the
 * original text of messages that compression later folded into block summaries.
 *
 * `ownerOf(ref)` maps a message ref to the block id that compressed it, so a
 * message hit tells the model exactly which block to decompress for detail.
 */
export function messageDocs(msgs: MessageInput[]): SearchDoc[] {
  return msgs.map((m): SearchDoc => ({
    kind: "message",
    ref: m.ref,
    text: m.text,
    title: `${m.role}: ${clampPrefix(m.text, 60)}`,
    role: m.role,
    blockId: m.blockId,
    tier: m.tier,
    tokens: m.tokens,
  }));
}

function applyRoleWeight(
  scored: ScoredBlock[],
  docs: SearchDoc[],
  rw: Required<RoleWeights>,
): ScoredBlock[] {
  if (docs.length === 0) return scored;
  const docByRef = new Map(docs.map((d) => [d.ref, d]));
  return scored.map((s) => {
    const doc = docByRef.get(s.ref);
    if (!doc) return s;
    const w =
      doc.kind === "message"
        ? doc.role === "user"
          ? rw.user
          : doc.role === "assistant"
            ? rw.assistant
            : rw.tool
        : rw.block;
    return { ref: s.ref, score: s.score * w };
  });
}

function runSearch(
  docs: SearchDoc[],
  query: string,
  options: SearchOptions,
): SearchResult[] | Promise<SearchResult[]> {
  const limit = options.limit ?? 10;
  const previewLength = options.previewLength ?? 200;
  const minScore = options.minScore ?? 0.01;
  const algoName = options.algorithm ?? DEFAULT_ALGORITHM;
  const rw = { ...DEFAULT_ROLE_WEIGHTS, ...options.roleWeights };

  const algo = getSearchAlgorithm(algoName);
  if (!algo) return [];
  if (docs.length === 0) return [];

  const scoredOrPromise = algo.score(docs, query);

  const buildResults = (weighted: ScoredBlock[]): SearchResult[] => {
    const byRef = new Map(docs.map((d) => [d.ref, d]));
    return weighted
      .map((s): SearchResult | null => {
        const doc = byRef.get(s.ref);
        if (!doc) return null;
        return {
          kind: doc.kind,
          ref: doc.ref,
          blockId: doc.blockId,
          tier: doc.tier ?? 1,
          score: s.score,
          title: doc.title,
          preview: makePreview(doc.text, query, previewLength),
          role: doc.role,
          tokens: doc.tokens,
        };
      })
      .filter((r): r is SearchResult => r !== null && r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  };

  if (scoredOrPromise instanceof Promise) {
    return scoredOrPromise.then((raw) =>
      buildResults(applyRoleWeight(raw, docs, rw)),
    );
  }
  return buildResults(applyRoleWeight(scoredOrPromise, docs, rw));
}

/** Sync entry — throws for async algorithms. Pass docs from blockDocs() + messageDocs(). */
export function searchBlocks(
  docs: SearchDoc[],
  query: string,
  options: SearchOptions = {},
): SearchResult[] {
  const result = runSearch(docs, query, options);
  if (result instanceof Promise) {
    throw new Error(
      `searchBlocks: algorithm "${options.algorithm ?? DEFAULT_ALGORITHM}" is async (e.g. semantic). Use searchBlocksAsync() instead.`,
    );
  }
  return result;
}

export {
  clearDocFeatures,
  docCacheInfo,
  docFeatures,
  setDocCacheCap,
} from "./doc-cache.js";
export type { DocFeatures } from "./doc-cache.js";

export async function searchBlocksAsync(
  docs: SearchDoc[],
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  return await runSearch(docs, query, options);
}

/**
 * Preview centered on the first query-term hit (case-insensitive).
 * Falls back to the head when no term hits.
 */
function makePreview(text: string, query: string, len: number): string {
  if (!text) return "";
  const terms = query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return clampPrefix(text, len);

  const lower = text.toLowerCase();
  let hitIdx = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0) {
      hitIdx = idx;
      break;
    }
  }

  if (hitIdx < 0) return clampPrefix(text, len);

  const half = Math.max(0, Math.floor(len / 2) - 10);
  const start = Math.max(0, hitIdx - half);
  const end = Math.min(text.length, start + len);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + clampWindow(text, start, end).trim() + suffix;
}
