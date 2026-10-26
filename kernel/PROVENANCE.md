# acp-kernel Provenance Audit

This document classifies **every** source file in `opencode-acp/lib/` (the donor) into one of three buckets, to determine what can be carried into the MIT `acp-kernel` and what must be reimplemented in fresh expression.

**Method**: exact path comparison of `opencode-acp` (the ACP fork, 82 `lib/*.ts` files) against the upstream DCP repository (66 `lib/*.ts` files). A file that has **no DCP equivalent** is original work (bucket A). A file with a **DCP equivalent at the same path** is a DCP derivative — its _expression_ is AGPL-bound regardless of how much it was later changed (derivation is judged by whether a file was created by transforming the original, not by % changed; per copyright law expression is protected, not ideas/methods/algorithms).

---

## Legend

| Bucket  | Meaning                                                                      | Action in acp-kernel                                                                                    |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A**   | No DCP equivalent → original work of ranxianglei                             | **Bring verbatim** (the author's own code, MIT-safe). License header rewritten to MIT.                  |
| **B**   | DCP-derived file (same path exists upstream) → derivative expression is AGPL | **Reimplement in fresh expression** using the author's algorithm; do NOT copy/refactor the file's code. |
| **N/A** | Adapter-only (framework-specific: opencode hooks, I/O, auth, commands, UI)   | **Excluded** from the pure core. Stays in host adapters. Origin irrelevant.                             |

---

## Bucket A — Original work (bring verbatim) — 30 files

Quality gate intentionally omitted from acp-kernel (may be added later if needed).

### `compress/`

| File                           | Notes                                        |
| ------------------------------ | -------------------------------------------- |
| `compress/decompress.ts`       | ACP-original (v1.11+); DCP has no decompress |
| `compress/decompress-logic.ts` | ACP-original                                 |
| `compress/hide-consumed.ts`    | ACP-original (v1.14+)                        |
| `compress/hide-failed.ts`      | ACP-original                                 |
| `compress/keep-markers.ts`     | ACP-original (v1.12+)                        |
| `compress/parts.ts`            | ACP-original                                 |
| `compress/recap.ts`            | ACP-original (v1.12.1)                       |
| `compress/status.ts`           | ACP-original (v1.11+)                        |

### other

| File                                 | Notes                                                           |
| ------------------------------------ | --------------------------------------------------------------- |
| `config-validation.ts`               | ACP-extracted for testability; no DCP equivalent                |
| `gc/merge.ts`                        | ACP-original (DCP has no `gc/` dir)                             |
| `messages/truncate-tools.ts`         | ACP-original (v1.14.5, replaced DCP's `gc/truncate.ts`)         |
| `messages/filter/*` (9 files)        | ACP-original filtering subsystem                                |
| `messages/inject/policy/*` (3 files) | ACP-original (v1.13.1) — inject **policy** logic, not rendering |
| `state/rebuild.ts`                   | ACP-original (v1.11+)                                           |

---

## Bucket B — DCP-derived (reimplement in fresh expression) — 40 files

Only the **algorithmic** subset is reimplemented into the pure core; the rest are adapter-only (persistence, config-merge, prompts-rendering) and excluded from the core. Listed by what they become.

### Reimplemented into acp-kernel (fresh expression, ~9 substantial files)

| DCP-derived file                                | Becomes                              | What to reimplement                                                              |
| ----------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `compress/range.ts`                             | `core/applyCompression` (range mode) | block allocation, nested-block handling, boundary resolution                     |
| `compress/search.ts`                            | `core/resolveBoundaries`             | ref→index mapping, reversed-boundary swap, protected-gap detection               |
| `compress/state.ts`                             | `core/state` (mutation)              | block id/run allocation, deactivation, byMessageId index                         |
| `compress/pipeline.ts`                          | `core/processTurn` prep/finalize     | permission (host-side), fetch (host-side), state wrap                            |
| `messages/prune.ts`                             | `core/prune`                         | replace compressed ranges with summary blocks                                    |
| `messages/sync.ts`                              | `core/sync`                          | deactivate orphaned blocks when messages deleted                                 |
| `message-ids.ts`                                | `core/refs`                          | raw↔mNNNNN bidirectional map                                                     |
| `messages/inject/inject.ts` + `inject/utils.ts` | `core/decideNudge`                   | **decision only** — shouldNudge, growth baseline, threshold, compressible ranges |
| `config.ts` (core subset)                       | `core/Config` defaults               | defaults + validation (use A-class `config-validation.ts`)                       |

### Supporting types/barrels (trivial, write fresh)

`compress/{index,types,timing,range-utils}.ts`, `messages/{index,priority,query,reasoning-strip,shape,utils}.ts`, `state/{index,types,utils}.ts`, `token-utils.ts` (wrap `cc-alg` tokenizer), `protected-patterns.ts`, `compress/protected-content.ts`.

### Excluded from core (adapter-only despite B lineage)

`state/persistence.ts` (filesystem I/O), `prompts/*` (text rendering → adapter), `compress-permission.ts` (permission = host concern).

---

## Bucket N/A — Adapter-only (excluded from core) — 12 files

All framework-specific; irrelevant to the pure core. Stay in the OpenCode adapter (and a future Pi adapter).

`auth.ts`, `hooks.ts`, `host-permissions.ts`, `logger.ts`, `update.ts`, `ui/notification.ts`, `ui/utils.ts`, `commands/{compression-targets,context,index,stats}.ts`, `compress-permission.ts`.

---

## Summary

| Bucket            | Files | Disposition                                                                                                |
| ----------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| **B** DCP-derived | 40    | ~9 substantial algorithms reimplemented fresh + ~12 types/barrels rewritten fresh; rest excluded (adapter) |
| **N/A** adapter   | 12    | excluded from core                                                                                         |

---

## Compliance note

This audit exists to ensure acp-kernel is **genuinely MIT**, not "MIT-labeled but AGPL-tainted." The rule applied throughout: an idea/algorithm is free regardless of source; a _file's code expression_ is bound to the license of the file it descends from. A-class files descend from no DCP file. B-class files' code is NOT carried — the algorithms are reimplemented in new expression. Should any contributor question a classification, the comparison data above (and the upstream DCP tree) allow independent verification.
