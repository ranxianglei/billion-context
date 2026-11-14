# Query-word review follow-up / 查询虚词修复评测

## Contract and alternatives

The review of PR #5048 identified grammatical query words inflating literal coverage. The fix compares non-grammar coverage, raw coverage, plan score, then original order. Raw evidence is retained: deleting `is` or `a` outright loses SQL/operator/identifier distinctions. Reusing `planTokenize` also splits identifiers and CJK phrases and drops meaningful short words. Neither alternative is used.

The grammar vocabulary has 17 English words (documented in CONFIGURATION en/zh); sentence punctuation affects classification only. Candidate generation, substring matching, snippets, protocol payloads and defaults are unchanged. Status-aware narrowing tips use non-grammar terms when available, retaining the original minimum query length. This intentionally removes tips recommending `what` alone. It does not introduce a query parser.

## Protocol

- Baseline: published PR commit `434daf1e958f1d1db6e832f4c8fa841bdeaffce9`. The upstream synchronization before this follow-up changes README files only.
- `tests/fixtures/plan-query-word-baseline.json` freezes 174 actual tool calls (87 examples at limits 1 and 3), their returned order, candidate count, complete-output SHA256 and canonical input SHA256. The file records the pre-fix source hash. It was captured before changing production ranking; it is not regenerated from the fix.
- The 35 new examples were labelled independently before execution. Input hashes include relevance labels and rationale; tests reject silent relabelling. No case was removed after seeing results.
- All calls use the real `core.search` and `executeSearchContext`. P@1 uses limit 1; MRR@3 uses a separate limit-3 call. Every accepted relevant block has equal credit.
- Groups remain separate: the original 28 examples, four prior review regressions, 20 prior challenges, and 35 query-word diagnostics. Their populations differ; do not pool them into a production accuracy claim.

## Results

| Corpus | P@1 before → after | MRR@3 before → after | P@1/MRR regressions | Identical full outputs |
|---|---|---|---|---|
| Original 28 | 27/28 → 27/28 | 0.9821 → 0.9821 | 0 / 0 | 56/56 |
| Prior query regressions 4 | 4/4 → 4/4 | 1 → 1 | 0 / 0 | 8/8 |
| Prior diverse challenges 20 | 20/20 → 20/20 | 1 → 1 | 0 / 0 | 40/40 |
| New query-word diagnostics 35 | 18/35 → 32/35 | 0.7143 → 0.9429 | 0 / 0 | 38/70 |

For the new diagnostics, 14 first-place answers improve and 21 tie; all 18 previously correct first-place answers remain correct. Candidate counts are unchanged in every call. The remaining failures stay in the denominator. The earlier unknown-status failure remains in the original corpus.

Examples span auth, payments, RAG, Agent checkpoints/budgets, deployment and databases. The 35 labels include nine natural questions, ten initially-intended preservation examples, 12 literal-query examples and four multilingual examples. Category names describe design intent; measured correctness is computed from the recorded baseline, not assumed from a category name.

- `where is the refund ledger`: substantive historical ledger evidence outranks grammatical overlap in an active webhook task.
- `what is the embedding dimension`: dimension evidence outranks ingestion scheduling text.
- `what is the user_id 字段`: identifiers and contiguous Chinese terms retain literal significance.
- `IS NULL`, quoted/backticked literals, `id`, `user_id`, `v2.3`: no tokenizer substitution or minimum-length filter is introduced.

## Regression and integration checks

- 70/70 tests pass across `plan-query-words`, `plan-state-retrieval`, `plan-state-retrieval-eval`, and `search-plan-aware`.
- 51/51 neighboring tests pass across `search-context`, `search-context-2751`, and `output-steering`.
- The query-word test file includes 108 deterministic perturbation checks: six domain term pairs × nine grammatical framings × two candidate orders. These are property checks, not 108 independent relevance samples.
- Guard checks cover disabled/foreign/no-plan/invalid-snapshot/small-pool behavior; state/messages/metadata remain read-only. Literal tie-breaks, all-grammar behavior, diagnostics and useful narrowing tips are also asserted.
- A real local HTTP A/B runs TodoWrite → compress → search with a mock upstream. Enabled ranking restores JWT issuer evidence over grammar-heavy active-task text; default-off behavior remains lexical. All forwarded TodoWrite arguments and cache anchors are checked unchanged. This is HTTP integration evidence, not a live LLM experiment.
- Typecheck, build, unused-export and test-import-graph gates pass. Full-suite authority remains remote CI on the submitted head; earlier-head CI is not claimed as validation of this follow-up.

## Limits and retained failures

`variable-a`, `plain-stopword-query`, and `all-function-word-literals` remain wrong under their frozen semantic labels. Substring matching makes `a` match within other words and `is` match within prose; tied evidence can still favor the active plan. Their before/after ordering is explicitly checked unchanged. Deleting all grammatical evidence would not solve this safely. The separate `not`/`note` example illustrates the same boundary; it is a documented diagnostic, not an additional executed quality sample.

The vocabulary is bounded English heuristics; code and natural language can share words. More substantive coverage is not a universal relevance oracle. No finite test set guarantees zero production regressions. The 104 old output comparisons primarily protect keyword-query compatibility (the old corpus contains no complete grammar words from this set); the new natural questions and metamorphic checks address that blind spot. No new paid model calls were made and no Agent task-success or token-saving claim follows from these results.

## Reproduce

```sh
node --import tsx scripts/eval-plan-query-words.ts --json query-word-results.json
node --import tsx --test tests/plan-query-words.test.ts tests/plan-state-retrieval.test.ts tests/plan-state-retrieval-eval.test.ts tests/search-plan-aware.test.ts
node --import tsx --test tests/search-context-2751.test.ts tests/search-context.test.ts tests/output-steering.test.ts
```

The JSON report includes every query, rationale, accepted labels, old/new Top-1/Top-3 and paired metrics. Frozen-output provenance can be independently checked by running those fixtures through `executePlanRetrievalSearch` at the baseline commit; only the new fixture data need be supplied to that checkout. Source/fixture hashes make changes detectable.

## 中文结论

本次采用“非虚词覆盖 → 全部原词覆盖 → 计划分 → 原顺序”，没有简单删除虚词。定向合成语料从 **18/35 提升到 32/35**，已有正确案例没有观察到 P@1 或 MRR@3 退步；旧语料 **104 次完整输出一致**。三个既有失败继续保留在分母，未通过改标签抬高结果。另有 108 次扰动检查、121 项本地测试及真实 HTTP 往返验证。这些数字不能写成线上准确率或真实 Agent 任务成功率；全量回归以本次提交的远端 CI 为准。
