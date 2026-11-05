# Native Recall: scope and verification

This contribution contains both Claude Code and OpenCode integrations, backed by the same append-only local archive and MCP search/read layer. It does not modify the host's primary model URL, OAuth, the billion-context proxy, or the compression kernel. The OpenCode adapter is explicitly opt-in and currently pins its supported interface to OpenCode V2.2.5.

## Source lineage

- Original PR #1790 head: `4764afdefcf4355e3cdcbbbf7de468a4313b832b`.
- Archive reliability implementation: `63c2927bea2994f378e1a1b4d9b7f1b3f63c11c0` (local development history).
- OpenCode final implementation: `66a85d4bd2e610248e0390f99cf7bf3fe8c9e6d3` (local development history).
- Claude Code hardening: `428dd975b229da4c31aad2a65bdba833e41e2602` (local development history).
- Claude Code schema compatibility correction: v0.3.2, November 5, 2026.

The final v0.3.2 source includes all 48 files in the OpenCode delivery. Of these, 36 are byte-identical and 12 have subsequent Claude Code/shared-core hardening; five Claude Code test modules were added. The entire OpenCode adapter directory, bridge and OpenCode test modules are unchanged. These local commit IDs describe provenance, not remote branches or publicly retrievable commits.

## Verification commands

From this contribution's directory, using Python 3 and Node.js:

```sh
python3 -X utf8 -m unittest discover -s tests -v
node opencode/test-local.mjs
node tools/opencode-native-validation/test-plugin/test-local.mjs
python3 tools/opencode-native-validation/test-plugin/test-structured-checker.py
node tools/opencode-native-validation/guard-plugin/test-local.mjs
```

These checks use synthetic data and do not make paid model requests. They are scoped contribution tests, not billion-context's full repository CI. GitHub Actions on the current PR head remains the authority for whole-repository checks.

Publication recheck on November 5, 2026: Python 3.12.14 and Node v24.22.1, with a temporary HOME and a clean environment. Results were 162 Python tests (OK), 7 OpenCode adapter checks, 5 test-plugin checks, 10 structured-checker checks and 12 guard checks, all passing. The recheck did not rerun native hosts or make model requests. No full repository typecheck/build was run in this source-only staging workspace; whole-repository CI must be assessed separately on the pushed head.

## Claude Code evidence and limits

An unmodified official Claude Code 2.1.318 CLI with the official DeepSeek Flash API performed real manual `/compact`, `SessionStart(source=compact)` and a new-process `SessionStart(source=resume)`. Actual model-driven `recall_search` and paginated `recall_get` returned the same 45,812-byte archived turn in both phases, byte for byte. Its SHA256 was `088574728acf87dbb5211069908000bcaef780d4282c414a4c856bec4cb766a4`. The underlying synthetic Read result contained 22,020 UTF-8 bytes and was also checked against the original fixture.

The v0.3.2 correction removes a root-level `anyOf` from the `recall_get` tool schema so official CLI configurations without schema-union rewriting still expose the tool. Selector constraints remain checked by the server. The final corrected package passed all 162 Python tests. An earlier package briefly retained an obsolete v0.3.1 version assertion; that test was corrected and the entire suite rerun before this source was selected.

The recorded main requests included `output_config.effort=low`. The compaction request's low setting was checked offline with the same CLI/configuration, not captured from that real network request. This proves working retrieval after native compaction and process restart, not complete forgetting: the host may retain recent content and its append-only transcript preserves older records. Real automatic-compaction thresholds/veto, failure-tool flows, Windows/macOS and long-term concurrent workloads remain unverified.

## OpenCode evidence and limits

The November 1 tests exercised real OpenCode V2.2.5 archive hooks, native compaction and post-compaction recall. Subsequent locator and byte-pagination changes were then validated with a new process and index rebuild: two tool-response pages reassembled 40,250 bytes exactly. The original 115-test suite is included in the later shared regression suite.

**The complete native-compaction sequence was not rerun after the last locator/pagination changes.** Historical native-compaction evidence and final-source restart/index-rebuild evidence are different checks; neither is presented as a final-source full-chain acceptance. OpenCode does not gain a compaction veto through this adapter. Data truncated before the host exposes it, unobserved events while the adapter is disabled, cross-platform execution and long-term reliability are not guaranteed.

## 中文摘要

两版在同一源码树交付：CC hooks、OpenCode 原生适配器共用追加式事实归档、稳定定位和 MCP 搜索/分页读取。旧 OC 包的全部文件均包含在当前源码中，不能把旧包再覆盖回共享核心，否则会撤销后续 CC 修补。

CC 已实际完成手动原生压缩、compact/resume hooks、压缩后及新进程搜索/完整取回 45,812 字节；最终修订版 162 项 Python 回归通过。未证明宿主已完全遗忘旧内容，自动压缩 veto 和 Windows 等仍未实测。

OC 已有真实原生压缩证据，最终定位/分页代码另通过新进程召回 40,250 字节与索引重建；最后修改后没有重新跑完整原生压缩链。各阶段历史报告保留原日期与当时状态，以本说明区分当前验证边界。

本更新只提交源代码、测试和文档，不代表合并、发版或在用户电脑完成安装。主请求路由、OAuth、bili 配置和 kernel 均未改动。
