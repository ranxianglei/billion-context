# Task-state-aware plan retrieval

## Problem

The opt-in `compress.search.planAware` feature currently tokenizes entire planning tool inputs. A completed task contributes the same weight as an in-progress task. Swapping only the statuses of two TodoWrite entries therefore cannot change retrieval, even when a short query is ambiguous between the tasks. Repeated completed descriptions can dominate the current task.

This is a bounded improvement to the feature shipped in #1419 / #1336, not a new retrieval subsystem. Tracked in #5047. Base: `b0b0e66ff085b08e8e26c02f1f79ad2a8849a496`.

## Acceptance criteria

- Recognize complete TodoWrite / todowrite snapshots and prefer in-progress descriptions, or pending descriptions if none are in progress.
- Do not use terminal-task descriptions as plan signals. Keep their historical blocks searchable, especially for explicit queries and dependencies.
- Preserve the existing flag, default, 40-message lookback, latest-per-pattern selection, weights, and 4,000-character source bound.
- Invalid, unknown, incremental, custom, and oversized tool inputs retain the legacy behavior. A valid empty or all-terminal snapshot suppresses older state.
- Under recognized snapshots, the number of distinct whitespace-separated query terms present takes priority over plan score. Preserve original core order for ties.
- Do not mutate history, provider tool arguments, session state, or cross-session ranking. No kernel or configuration schema changes.
- Prove the status-swap failure before the fix, cover compatibility and wire paths, and compare lexical / frozen legacy / improved retrieval on a predeclared corpus.
- Evaluate real model continuation separately from retrieval ranking, with explicit synthetic-task limitations and metered costs. Do not equate rank improvement with general Agent success.

## Out of scope

Incremental TaskCreate/TaskUpdate reconstruction, embedding/LLM ranking, automatic retrieval, new memory stores, new tuning knobs, default-on rollout, release or merge.

## Review follow-up acceptance criteria

- Add a status-only ablation using the production extractor, real candidate pool, and frozen overlap ranker without query coverage. Mark it as rank-only evidence, with no fabricated tool output or model-continuation claims.
- Keep all 28 original cases and four separate review regressions unchanged; report per-case, category, and paired ablation results, including failures.
- Log query coverage, plan score, and original rank for recognized snapshots. Preserve legacy log formatting and all model-visible search output.
- Reuse the frozen score/order implementation for the ablation; retain independent legacy extraction and compatibility assertions.
- Validate against current upstream, update the existing PR with additive commits, and report CI separately from local checks. Preserve the provenance of the earlier paid-model experiment.
- Add a separate review-time challenge set across payments, RAG, Agent orchestration, and deployments. Declare labels before running it, cover both structured and fallback paths, and keep its metrics separate from the original corpus and live-model experiment.
