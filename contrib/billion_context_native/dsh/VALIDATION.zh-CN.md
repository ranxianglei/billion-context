# DSH 原生 Recall 验证记录

日期：2026-11-05。这是独立的 Recall 原生适配器，不是 billion-context 的代理插件，也不替换宿主压缩机制。实现、安装方法和配置见 [README](README.zh-CN.md)。

## 固定基线

- 参考 billion-context 正式版 `v0.1.212`（`daa082ead8a8ead60311e29ad4627bff0f569fc1`），该版本内 kernel 为 `0.0.178`。
- 对齐该版本测试使用的官方 `@deepseek-ai/dsh@0.2.0-rc.2`，tag `dsh-v0.2.0-rc.2`（`639ed015397290b3745d163aafe02ffee4aa3f84`）。DSH 是 developer preview，此 RC 不是正式稳定版。
- 运行时 peer dependencies：`@deepseek-ai/cordis@4.0.5`、`@deepseek-ai/schemastery@3.18.5`、`@deepseek-ai/dsh-llm@0.2.0-rc.2`。

## 可重复的本地回归

在 `contrib/billion_context_native/` 下运行：

```sh
python3 -m unittest discover -s tests -q
node --test dsh/adapter.test.mjs
```

第二项需要从 `dsh/index.mjs` 能解析上述固定版本的 peer dependencies。测试只使用临时目录和合成事件，不需要模型密钥。

整合进 PR 时重新运行：176 项 Python 测试（原 162 项加 14 项 DSH 测试）通过，14 项 DSH adapter 测试通过。adapter 测试使用真实版本的 peer packages、模拟的宿主 context，不等同于运行完整 DSH 宿主。原 OpenCode adapter、guard、test-plugin 的 24 项 Node 测试及 10 项结构检查器测试也通过。

回归覆盖关闭无副作用、会话/项目/host 隔离、原生事件保留、长工具输入、UTF-8 分页、64 KiB 响应上限、冲突 seq 拒绝、旧 locator 稳定、索引重建、归档故障降级、快照分批、prepared lease 拒绝、延迟观察与子进程退出竞态、waterfall 委托以及全局 fetch 身份不变。

## 宿主与真实模型证据的范围

开发阶段使用官方 DSH 0.2.0-rc.2 的 profile/patch/Loader 入口，测试内容均为合成 fixture，没有读取真实用户历史。以下两类证据分开记录，不把脚本模型当作官方模型。

1. **无密钥脚本模型 + 真实 DSH**：验证原生 `/compact`、压缩后检索和新进程 resume 后检索。最终修正源码重跑了无密钥真实 DSH 恢复及全部回归。两阶段各两页重组为 14073 UTF-8 bytes，SHA256 为 `f93dd4e9395aa78b1b1a91f5ca45ec9de6df9539f221ec8440c72a23cd3ae35c`，逐字节相同。
2. **官方 DeepSeek 模型初阶段**：修正前原型完成真实 `/compact`，随后实际调用 `recall_search` 和两次 `recall_get`。重组 turn 为 16313 bytes，SHA256 为 `fe2acae74e608ebb2af89553802f4c4cdea42e97904dcb77a2d28bd122a9d481`；其中 6182-byte 合成工具输出与 fixture 逐字节一致。此阶段有 8 条模型 usage 记录。它是原型证据，不冒称最终源码的完整 `/compact` 重测。
3. **官方模型新进程恢复，最终修正源码**：2026-11-05 10:15:54–10:16:06 UTC，执行 4 次真实模型调用，退出码 0、未超时。新进程实际调用 `recall_search`、`recall_get`、`recall_get`，页范围 `[0,12000)`、`[12000,16313)`，最后 `next_cursor=null`。重组的 16313 bytes 与初阶段逐字节一致，SHA256 同上，合成 fixture 仍为 6182 bytes。107 条原生 session 事件逐对象存在于事实档案。最终源码没有另行重跑官方模型的完整 `/compact` 链路。

官方模型测试使用 DSH 自带 `deepseek-official` provider、DeepSeek Flash 和原生认证入口。测试脚手架设 `reasoningEffort=low`、`maxTokens=2048`，关闭模型 adapter 重试。恢复阶段原生请求字段明确记录 4 次 low。初阶段压缩调用未在公共参数面显式提供 effort，沿用 provider 配置的 low 默认值；没有服务端内部 effort 回显或 HTTP 尝试次数的独立证据。

初阶段 26973 tokens、恢复阶段 50173 tokens，共 77146 tokens。按当时官方峰/闲时价格估算约人民币 0.0432 元，不是账户实扣证明。本次 PR 整合只重跑无密钥回归，不新增计费模型请求。

## 边界与公开内容

- 归档为本地明文；历史返回标记为 `untrusted_historical_data`，该标记不是提示注入防护保证。
- JSON 对象及字符串可精确保留；序列化会规范化键顺序和空白，不承诺原始物理 JSONL 的词法字节。
- 仅显式选定的 session 和项目启用；不扫描历史目录，不归档子 agent 或 fork seed。
- `session/event` 是 fire-and-forget，`session/flush` 不提供压缩 veto；失败降级但不阻断宿主。完整 snapshot durable ACK 后才能恢复成功索引注入。
- 未验证 Windows/macOS、其他 DSH RC、自动压缩触发/veto、长期大规模压力、掉电和全部宿主修复路径。
- PR 提交实现、文档和合成测试；不提交密钥、认证配置、原始 session dumps、模型请求/响应日志或个人工作目录。开发验收原始材料不作为运行时依赖。

## English summary

This optional native Recall adapter targets the DSH version used by billion-context v0.1.212: DSH 0.2.0-rc.2, a developer-preview RC. It preserves native session events in the existing local archive and exposes scoped native retrieval tools. It does not redirect model URLs, replace authentication, change global fetch, or install the proxy compaction gate.

Integration checks passed: 176 Python tests, 14 DSH adapter tests using the pinned peer packages with a mocked host context, 24 existing OpenCode Node tests, and 10 structured-checker tests. These are distinct from full-host and paid-model tests. The original paid-model compact/retrieve run used the earlier prototype. The final corrected implementation was exercised by keyless real-host recovery and a four-call official-model fresh-process resume. A full official-model compact/retrieve/resume chain was not rerun on the final corrected source. Platform, RC-version, automatic-compaction and long-running stress coverage remain limited as described above.
