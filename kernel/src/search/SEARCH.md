# Search

Block search finds compressed (invisible) content by keyword — the core value
of ACP as conversations grow. This module is a **pluggable algorithm registry**:
one stable interface, multiple strategies, zero runtime dependencies.

> **Legacy path warning:** `CompressionCore.search()` (`src/compress.ts`) is a
> separate substring-only implementation that does NOT go through this
> registry — it over-matches short terms ("the" ≈ "theater") and sees only
> active blocks. Production adapters use `searchBlocks`. The delegation plan
> (core.search → searchBlocks) is tracked in
> [issue #44](https://github.com/ranxianglei/acp-kernel/issues/44).

## Quick start

```ts
import { searchBlocks, blockDocs, messageDocs } from "acp-kernel";

// Search both blocks and historical messages
const docs = [
  ...blockDocs(state), // all blocks (active + inactive)
  ...messageDocs([...historyMsgs]), // original message text
];
const results = searchBlocks(docs, "auth token", { limit: 5 });
// → [{ kind: "message", ref: "m00350", blockId: "b3", score: 0.92,
//     title: "...", preview: "...match...", role: "user", tokens: 120 }]
```

`SearchResult` now carries `kind` ("block" | "message"), `ref`, `blockId`
(owning block for a message hit), `role`, and `tokens` (size). A message hit
links to the block that compressed it → `decompress({blockId})` recovers the
surrounding detail. This closes the **search → decompress** loop: cheaply
locate detail, then pay decompress cost only for what you need.

## Two data sources

| source       | text searched                     | ref      | when                                          |
| ------------ | --------------------------------- | -------- | --------------------------------------------- |
| **blocks**   | summary (+ topic)                 | `b3`     | active AND inactive blocks (inactive fix)     |
| **messages** | original content from session log | `m00350` | detail that compression folded into a summary |

Messages are host-supplied (pai-acp reads them from pi's append-only session
log via `getEntries()`). Each message maps to the block that compressed it
(via `effectiveMessageIds`), so a hit tells the model exactly which block to
decompress for surrounding context.

## Role weighting

Messages carry a role; per-role weights prioritize human intent over noise:

| role      | default weight | why                                              |
| --------- | -------------- | ------------------------------------------------ |
| user      | 1.5            | questions, decisions, requirements — high signal |
| assistant | 1.0            | reasoning and findings                           |
| tool      | 0.6            | logs, listings — large volume, lower density     |
| block     | 1.0            | model-authored summaries                         |

Override via `SearchOptions.roleWeights`.

## Why the default is "hybrid"

The default algorithm is `hybrid` (BM25+stem ⊕ fuzzy n-gram). On a 32-block
mixed EN/CJK benchmark with 48 queries, against the original substring counter:

| algorithm  | MRR       | R@1       | R@3       |
| ---------- | --------- | --------- | --------- |
| substring  | 0.797     | 0.792     | 0.792     |
| bm25       | 0.833     | 0.833     | 0.833     |
| fuzzy      | 0.795     | 0.708     | 0.875     |
| **hybrid** | **0.898** | **0.875** | **0.917** |

All rows measured on the rework benchmark (32 blocks / 48 queries) with the
final code (segmenter tokenizer + CJK fuzzy gate).

The wins come from three fixes to plain substring matching:

1. **CJK word segmentation** — Chinese/Japanese has no spaces, so `"登录"` is
   segmented via `Intl.Segmenter("zh", {granularity:"word"})` (CLDR
   dictionary): multi-char words stay atomic, and all-OOV runs fall back to
   overlapping bigrams + single chars — `"身份验证"` still matches
   `"身份验证流程"`, while `"试验证明"` no longer false-hits `"验证"`.
2. **English stemming** — `compressed`/`compression`/`compressing` collapse to a
   common root (lightweight Porter-inspired suffix stripper, no deps).
3. **Character n-gram fuzzy recall** — typo-tolerant (`tokan`≈`token`),
   script-agnostic; BM25 supplies precision, fuzzy supplies recall. The
   query-token gate is script-aware: Latin tokens need >= 4 chars (2-3 char
   stop-words are noise), but 2-char CJK words (`登录`/`缓存`) are admitted —
   most CJK words are exactly 2 characters, so a Latin-style threshold would
   starve the recall channel for a whole script.

Previews are **match-context snippets**, not arbitrary prefixes — the result
shows the sentence around the hit so the user sees _why_ a block matched.

## Options

```ts
interface SearchOptions {
  algorithm?: string; // "hybrid" (default) | "bm25" | "fuzzy" | "substring" | <custom>
  limit?: number; // default 10
  previewLength?: number; // default 200
  minScore?: number; // default 0.01
}
```

## Built-in algorithms

| name        | strengths                                 | when to use                 |
| ----------- | ----------------------------------------- | --------------------------- |
| `hybrid`    | best all-rounder (default)                | always                      |
| `bm25`      | IR-standard, IDF + length norm + stemming | precision on long corpora   |
| `fuzzy`     | typo-tolerant, cross-script               | recall on messy input       |
| `substring` | exact, deterministic, occurrence count    | backward compat / debugging |

## Adding a custom algorithm

Register any algorithm and select it by name:

```ts
import { registerSearchAlgorithm, searchBlocks } from "acp-kernel";

registerSearchAlgorithm({
  name: "prefix-only",
  description: "scores by whether summary starts with the query",
  score(docs, query) {
    const q = query.toLowerCase();
    return docs.map((d) => ({
      blockId: d.blockId,
      score: d.summary.toLowerCase().startsWith(q) ? 1 : 0,
    }));
  },
});

searchBlocks(state, "auth", { algorithm: "prefix-only" });
```

## Optional: semantic (embedding) search

Lexical algorithms can't bridge synonyms or cross-language pairs
(`login`↔`登录`, `cache`↔`缓存`, `credentials`→auth). For those, plug in an
embedding backend via the reference `semantic` algorithm. **acp-kernel stays
zero-deps** — you supply the `embed` function and pick the backend.

```ts
import { registerSearchAlgorithm, searchBlocksAsync } from "acp-kernel";
import { createSemanticAlgorithm } from "acp-kernel/search/algorithms/semantic";

const semantic = createSemanticAlgorithm({
  // any backend: @huggingface/transformers (local), OpenAI, Voyage, a local server…
  embed: async (texts) => myEmbeddingApi.embed(texts), // → number[][]
});
registerSearchAlgorithm(semantic);

// semantic score() is async → use searchBlocksAsync (searchBlocks throws a clear error)
const results = await searchBlocksAsync(state, "credentials", {
  algorithm: "semantic",
});
```

`embeddings` are memoized by content hash — docs only re-embed when their
summary changes; the query embeds fresh each call. Embedding docs + query in a
single batch keeps it to one round-trip per search.

## Module layout

```
src/search/
├── types.ts              SearchAlgorithm, AsyncSearchAlgorithm, SearchOptions, SearchResult
├── tokenizer.ts          Latin words + CJK word segmentation w/ bigram fallback
├── stemmer.ts            lightweight English stemmer
├── registry.ts           register / get / list algorithms
├── algorithms/
│   ├── substring.ts      baseline (exact occurrence count)
│   ├── bm25.ts           BM25 + stem + CJK tokenization
│   ├── fuzzy.ts          character n-gram Jaccard
│   ├── hybrid.ts         default: 0.7·BM25 + 0.3·fuzzy
│   └── semantic.ts       reference embedding algorithm (host supplies embed fn)
└── index.ts              searchBlocks (sync) + searchBlocksAsync
```
