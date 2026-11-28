# Retrieval evaluation

## Reproduce

After installing dependencies and building the kernel prerequisites:

```sh
node --import tsx scripts/eval-plan-state-retrieval.ts --json plan-retrieval-results.json
node --import tsx --test tests/plan-state-retrieval.test.ts tests/plan-state-retrieval-eval.test.ts tests/search-plan-aware.test.ts
```

All four arms use real `core.search` candidate generation. Lexical, old plan-aware, and complete status-aware use `executeSearchContext` rendering. The lexical arm disables plan ranking. The old arm freezes extraction/ranking semantics from `b0b0e66ff085b08e8e26c02f1f79ad2a8849a496`; its rendered output uses a punctuation suffix to trigger the runtime's compatibility path, with exact token-weight and ordering assertions against the frozen reference on every call. Baseline parity was checked on the unmodified source before the fix.

The status-only ablation supplies production `extractPlanState` terms to the same frozen overlap sorter, disabling query coverage while retaining its candidate-count gate and stable tie order. It returns ranks only (`text: null`), not fabricated tool output. This diagnostic is not a production configuration or a fourth live-model arm.

The 28-case fixture was authored separately before inspecting improved rankings. Four strict pairs change only task statuses. Case content SHA-256: `ed972c878998149968153a3bef790f8ab19518853f12c9d48d2bb89b3c99e7a8`. Removing three unused type exports later changed the file hash, not case content, labels or order. Current file SHA-256: `e232f1037542d3c5bca6196b84542537be38478df65daadb67a3aa1fcf9b3bc7`.

## Results

P@1 is measured at limit=1. MRR@3 is measured separately at limit=3; it is the reciprocal rank of the first accepted relevant block, or zero if absent. These use actual tool calls except the rank-only ablation. Every case has more than three lexical candidates, so both limits exercise the re-ranking gate.

| Arm | P@1 | MRR@3 |
|---|---:|---:|
| Lexical | 17/28 (60.71%) | 0.6726 |
| Old plan-aware | 19/28 (67.86%) | 0.8393 |
| Status-only ablation | 22/28 (78.57%) | 0.8690 |
| Status-aware | 27/28 (96.43%) | 0.9821 |

Against old plan-aware: 8 first-place improvements, 20 ties, 0 regressions. Against lexical, one unknown-status case remains worse because compatibility deliberately preserves the old plan override. All eight declared legacy-order controls pass.

| Targeted category | Old P@1 | Status-only P@1 | Complete P@1 |
|---|---:|---:|---:|
| Status switch | 4/8 | 8/8 | 8/8 |
| Pending without active task | 1/2 | 2/2 | 2/2 |
| Completed-task noise | 1/3 | 3/3 | 3/3 |
| Explicit historical query | 2/3 | 0/3 | 3/3 |
| Completed dependency | 2/2 | 0/2 | 2/2 |

The ablation isolates the tradeoff: extracting current tasks improves ambiguous-query cases, but removing completed descriptions alone loses five historical/dependency targets. Coverage restores all five, with 23 ties and no rank-metric regressions against status-only. For example, `token JWT signing key` must retrieve the completed authentication block while rate limiting is in progress. Status-only instead selects the current limiter. The earlier four query regressions likewise score 0/4 with status-only and 4/4 with coverage.

The JSON report contains every query, plan payload, candidate, accepted label, rationale, top-1/top-3 result and available rendered tool output, plus all category metrics and paired ablation differences. The intentionally failing unknown-status case remains in the denominator.

## Additional diversity challenges

Twenty diagnostic cases were added after implementation across payments, RAG, Agent orchestration, and deployments. Labels were declared before the first run and were not changed afterward. This set includes compatibility-contract expectations, so its score is a test-pass measure, not a held-out relevance estimate. It is reported separately as `challengeSupplement` rather than added to the original 28 cases.

| Behavior category | Cases | Old P@1 | Status-only P@1 | Complete P@1 |
|---|---:|---:|---:|---:|
| Multiple active/pending tasks and independent tools | 3 | 1/3 | 3/3 | 3/3 |
| Latest, cleared, terminal, and user-only state | 4 | 3/4 | 4/4 | 4/4 |
| Mixed language, identifiers, whitespace, repeated/unmatched terms | 5 | 0/5 | 0/5 | 5/5 |
| Malformed JSON, invalid entry, tool-specific status, namespaced tool | 4 | 4/4 | 4/4 | 4/4 |
| 4000 versus 4001 characters | 2 | 1/2 | 2/2 | 2/2 |
| 40 versus 41 messages | 2 | 2/2 | 2/2 | 2/2 |

Overall: lexical 12/20 (MRR@3 0.7750), old 11/20 (0.7667), status-only 15/20 (0.8667), complete 20/20 (1.0000). All six explicit legacy-order controls pass at both limits. Source-file SHA-256 recorded before execution: `d693c622eae07ae68b0b932946102b467622dba6bcddb7737daec1063db40d6a`; case-content SHA-256: `4508d3e497978c2f79aac7e5879097033200adb9397cdfe313dd9dc6bda481b1`.

The follow-up changes production diagnostics only. Comparing all three original rendered arms at both limits on the 28 fixed cases and four query regressions found 192 unchanged tool outputs, candidate counts, and rankings. The earlier 144-episode DeepSeek experiment remains evidence for its recorded source version, not a new experiment on this follow-up; no additional paid calls were made.

## Review-driven improvement

An initial boolean guard preferred candidates containing every query term. Independent review found that `token JWT issuer?`, `token JWT issuer behavior`, `cache CDN purge details`, and `网关 超时 截止时间？` could disable that guard and incorrectly promote the active task. These four examples are recorded in a separate supplement, not added to the original denominator or described as a held-out sample. The initial guard failed all four; distinct-term coverage passes all four. A separate test prevents repeated query words from overpowering more distinct query evidence.

## Interpretation and boundaries

This deliberately targeted synthetic corpus demonstrates the mechanism and guards against regressions; it does not estimate production query quality. It does not measure automatic tool adoption, total task completion, token savings, or arbitrary-length plans. Terminal documents remain searchable. Unknown schemas, incremental task events, oversized snapshots, unsuccessful tool executions and fuzzy/CJK query rewriting remain outside this change. Defaults, foreign-session search, small candidate pools, original tool payloads and cache breakpoints retain their prior contracts.
