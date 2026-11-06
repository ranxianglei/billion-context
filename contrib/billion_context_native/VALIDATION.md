# billion_context_native: scope and verification

This contribution contains Claude Code, OpenCode and DSH integrations, backed by the same append-only local archive and shared search/read core (MCP for Claude Code/OpenCode, native tools for DSH). It does not modify the host's primary model URL, OAuth, the billion-context proxy, or the compression kernel. The OpenCode adapter is explicitly opt-in and currently pins its supported interface to OpenCode V2.2.5.

## Update review (November 6, 2026)

The branch incorporates upstream master `c3dfbe6b21a1b2fc3642594043bc81fd2ae91247` by a history-preserving merge from PR head `8dade6995ba54edb45bd5a796642ba955b04fa15`. The contribution still changes only this directory relative to that master.

New rules use stable `rule<decimal UUID>` IDs. Replay preserves the ID in a successful, input-matching acknowledgment instead of allocating it again; application errors and duplicate evidence do not create mutations. Historical numeric/generic-result transcripts remain supported. Already-corrupt history in which different calls acknowledged the same ID reports a conflict rather than guessing which rule owns it. Parallel successful acknowledgments are retained even when their stale previews both passed duplicate/capacity checks; subsequent additions still enforce the existing limit.

All 14 Claude Code hook launchers quote the selected `RECALL_PYTHON` executable during both probing and execution. A shell regression uses an executable path containing spaces with no fallback interpreter available. This does not introduce a new interpreter-setting alias.

Local verification on Windows/Node 24/Python 3.10 passed all 198 Python tests, including 10 new rule-identity regressions and the hook launcher regression covering all 14 commands. Typecheck, build, the 8 OpenCode synthetic adapter checks, 11 core OpenCode incremental tests and 74 core DSH native tests passed. The core DSH tests used the complete CI preload chain. The contribution's minimal subprocess test environments now retain only required Windows system paths and explicitly select UTF-8 for direct Python children, without inheriting provider credentials. Full root-suite results remain the remote CI verdict on the pushed head.

These changes were checked with synthetic local data and no paid model requests. Earlier real-host compaction results below remain historical evidence; this update does not establish new real-model or full DSH JavaScript acceptance on Windows.

本次更新通过合并上述 master 保留原分支历史。新规则使用稳定的十进制 UUID 编号，回放保留成功响应确认的原 ID；错误结果和重复证据不会变成新的修改。旧编号保持兼容，已有重复 ID 的损坏历史会明确报错。并行调用基于滞后视图而同时成功时，回放保留两条确认记录；后续添加仍检查原有条数上限。全部 14 个 hook 启动命令已修复含空格解释器路径。本轮仅用合成数据，没有新增付费模型调用，也不把历史真实压缩测试算作当前版本验收。

Windows 本地验证通过 198 项 Python 测试、8 项 OpenCode 适配检查、11 项主仓库 OpenCode 测试和 74 项主仓库 DSH 测试，类型检查与构建也通过。测试夹具仅补入必要的 Windows 系统路径并显式使用 UTF-8，仍不继承服务商凭据。主仓库全套测试以推送后对应提交的远程 CI 为准。

## Rename verification boundary

The product, source directory, Claude Code plugin/marketplace and DSH package/runtime are now `billion_context_native`. Claude Code uses the internal MCP key `native` to keep generated tool names within 64 characters; MCP `serverInfo.name` retains the full product name. OpenCode uses the full MCP server key and qualified `billion_context_native_recall_search/get` names (expanded as `billion_context_native_recall_search` and `billion_context_native_recall_get`). Functional operation names and immutable archive identity are unchanged. See [MIGRATION.md](MIGRATION.md) for installation and data-preservation details.

**The results and source comparisons below describe pre-rename revisions. They are historical evidence, not acceptance of the renamed source. A new real DeepSeek run after the rename is pending and must be reported separately with its actual tested revision and outcome.** Historical reports retain their original scope and dates. The rename does not bump package versions, alter archive formats, or modify the repository's root `src/`/bili core.

## Local rename checks (November 5, 2026)

The renamed tree passed 187 Python tests, 14 DSH adapter tests, 8 OpenCode adapter checks, 12 validation guard checks, 5 synthetic validation checks and 10 structured-checker cases. Root typecheck and build passed; `tests/log-mask.test.ts` passed all 25 tests standalone. These are offline/synthetic checks, not the pending real-host DeepSeek acceptance or a claim that remote CI has finished. New `plugin/billion_context_native/config.py` centralizes the seven renamed settings and their legacy fallbacks; archive format and source identity algorithms are unchanged.

## Source lineage

- Original PR #1790 head: `4764afdefcf4355e3cdcbbbf7de468a4313b832b`.
- Archive reliability implementation: `63c2927bea2994f378e1a1b4d9b7f1b3f63c11c0` (local development history).
- OpenCode final implementation: `66a85d4bd2e610248e0390f99cf7bf3fe8c9e6d3` (local development history).
- Claude Code hardening: `428dd975b229da4c31aad2a65bdba833e41e2602` (local development history).
- Claude Code schema compatibility correction: v0.3.2, November 5, 2026.

The pre-rename v0.3.2 source included all 48 files in the OpenCode delivery. Of these, 36 are byte-identical and 12 have subsequent Claude Code/shared-core hardening; five Claude Code test modules were added. At that pre-rename comparison, the entire OpenCode adapter directory, bridge and OpenCode test modules were unchanged. These local commit IDs describe provenance, not remote branches or publicly retrievable commits.

## Verification commands

From this contribution's directory, using Python 3 and Node.js:

```sh
python3 -X utf8 -m unittest discover -s tests -v
node --test dsh/adapter.test.mjs
node opencode/test-local.mjs
node tools/opencode-native-validation/test-plugin/test-local.mjs
python3 tools/opencode-native-validation/test-plugin/test-structured-checker.py
node tools/opencode-native-validation/guard-plugin/test-local.mjs
```

These checks use synthetic data and do not make paid model requests. They are scoped contribution tests, not billion-context's full repository CI. GitHub Actions on the current PR head remains the authority for whole-repository checks.

Pre-rename publication recheck on November 5, 2026: Python 3.12.14 and Node v24.22.1, with a temporary HOME and a clean environment. Results were 162 Python tests (OK), 7 OpenCode adapter checks, 5 test-plugin checks, 10 structured-checker checks and 12 guard checks, all passing. The recheck did not rerun native hosts or make model requests. No full repository typecheck/build was run in this source-only staging workspace; whole-repository CI must be assessed separately on the pushed head.

## Claude Code evidence and limits

An unmodified official Claude Code 2.1.318 CLI with the official DeepSeek Flash API performed real manual `/compact`, `SessionStart(source=compact)` and a new-process `SessionStart(source=resume)`. Actual model-driven `recall_search` and paginated `recall_get` returned the same 45,812-byte archived turn in both phases, byte for byte. Its SHA256 was `088574728acf87dbb5211069908000bcaef780d4282c414a4c856bec4cb766a4`. The underlying synthetic Read result contained 22,020 UTF-8 bytes and was also checked against the original fixture.

The v0.3.2 correction removes a root-level `anyOf` from the `recall_get` tool schema so official CLI configurations without schema-union rewriting still expose the tool. Selector constraints remain checked by the server. The final corrected package passed all 162 Python tests. An earlier package briefly retained an obsolete v0.3.1 version assertion; that test was corrected and the entire suite rerun before this source was selected.

The recorded main requests included `output_config.effort=low`. The compaction request's low setting was checked offline with the same CLI/configuration, not captured from that real network request. This proves working retrieval after native compaction and process restart, not complete forgetting: the host may retain recent content and its append-only transcript preserves older records. Real automatic-compaction thresholds/veto, failure-tool flows, Windows/macOS and long-term concurrent workloads remain unverified.

## OpenCode evidence and limits

The November 1 tests exercised real OpenCode V2.2.5 archive hooks, native compaction and post-compaction recall. Subsequent locator and byte-pagination changes were then validated with a new process and index rebuild: two tool-response pages reassembled 40,250 bytes exactly. The original 115-test suite is included in the later shared regression suite.

**The complete native-compaction sequence was not rerun after the last locator/pagination changes.** Historical native-compaction evidence and final-source restart/index-rebuild evidence are different checks; neither is presented as a final-source full-chain acceptance. OpenCode does not gain a compaction veto through this adapter. Data truncated before the host exposes it, unobserved events while the adapter is disabled, cross-platform execution and long-term reliability are not guaranteed.

## 中文摘要

三种宿主在同一源码树交付：CC hooks、OpenCode 与 DSH 原生适配器共用追加式事实归档、稳定定位和搜索/分页读取核心（CC/OC 通过 MCP，DSH 通过原生工具）。旧 OC 包的全部文件均包含在当前源码中，不能把旧包再覆盖回共享核心，否则会撤销后续 CC 修补。

以下数值与真实模型结果属于改名前历史版本，不是 `billion_context_native` 改名后的验收；改名后的真实 DeepSeek 测试待完成。DSH 历史验证另见 [DSH 验证记录](dsh/VALIDATION.zh-CN.md)。

CC 历史版本已实际完成手动原生压缩、compact/resume hooks、压缩后及新进程搜索/完整取回 45,812 字节；最终修订版 162 项 Python 回归通过。未证明宿主已完全遗忘旧内容，自动压缩 veto 和 Windows 等仍未实测。

OC 已有真实原生压缩证据，最终定位/分页代码另通过新进程召回 40,250 字节与索引重建；最后修改后没有重新跑完整原生压缩链。各阶段历史报告保留原日期与当时状态，以本说明区分当前验证边界。

本更新只提交源代码、测试和文档，不代表合并、发版或在用户电脑完成安装。主请求路由、OAuth、bili 配置和 kernel 均未改动。
