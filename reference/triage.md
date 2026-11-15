# Triage 分类与标签规则（lazy-loaded companion to AGENTS.md §4）

> 权威规则在 [AGENTS.md](../AGENTS.md) §4；本文件是查表用的全量标签分类。

每个新 issue 在 triage 时打齐三组标签，并在评论或讨论里注明主题类别（A–N）。全量开放 issue 的分类总账与各条目对应的修复 PR、处理建议维护在讨论区置顶：https://github.com/ranxianglei/billion-context/discussions/3913 （更新总账时直接编辑该讨论，不开新帖）。

**1. 优先级（必选其一）**
- `p1`：崩溃、数据丢失、会话永久不可用、核心能力整体停摆（可用性缺陷，参照 §7.3「可用性大于性能」）；以及**缓存泄露类**（stale cache 渗漏、cache ref 错误改写、上下文/存储只增不减地失控增长）——owner 修订 2026-10-19：两类一律 p1，不许降 p2
- `p2`：功能性缺陷但有绕行，或影响局部；确定性的噪音/成本问题（缓存泄露类除外——那是 p1）
- `p3`：轻微缺陷、文档、测试补齐、UX 打磨、低频场景

**2. 宿主车道（涉及哪个客户端打哪个，跨车道不打）**
- `dsh` `pi` `codex` `claude` `opencode` `hermes` `kimi` `trae` `claude-code` `opencodev2` `zcode` 等

**3. 领域（scope/* 为主；旧中文标签「协议接线/内核/storage」尚未退役，沿用即可，不再新增）**
- `scope/kernel`：压缩引擎、折叠判定、摘要、ref/账本（`kernel/` 与 src 侧压缩决策面）
- `scope/wiring`：协议接线、请求管道、wire 改写、工具注入、nudge
- `scope/storage`：持久化、SQLite 统一存储、会话文件、GC
- `scope/ci`：CI、发版流水线、测试基建
- `scope/ui`：Web UI / CLI 展示面
- `scope/docs`：文档面（README、docs/configuration.md、docs/clients.md、AGENTS.md 等 .md）
- `scope/other`：其余

**4. 状态标签（可选）**：`hold` `review中` `review发现修复中` `review发现小问题` `等待反馈` `下次发版` `解冲突中` 等，只描述当前状态，不描述领域。

**5. 主题类别（A–N，写进讨论总账，不作为标签）**：A 前缀缓存接缝 / B 折叠预算与资格判定 / C 压缩引擎行为 / D 超时重试与降级 / E 存储层 / F dsh 车道 / G fork 与会话继承 / H pi 车道 / I 其他宿主车道 / J 配置面静默失效 / K 启动器·自更新·CI / L Web UI 与文档 / M 跨车道功能提案 / N 服务端杂项。判定口径以讨论帖各类别开头的一句话定义为准。
