# 文档导航

**billion-context** 的全部系统文档都集中在这个目录。仓库根目录只保留四个入口文件：`README.md`、`README.zh-CN.md`、`AGENTS.md`、`CHANGELOG.md`（原根路径保留单行重定向占位，记账见 [lifecycle §5](lifecycle.md#5-卫生记录)）。

> **全量目录：** [index.zh-CN.md](index.zh-CN.md) / [index.md](index.md) —— 每篇文档一行说明。本页是目录落地页：东西在哪、什么规则让它们保持新鲜。

## 分区

| 分区 | 文档 | 里面有什么 |
|---|---|---|
| **从这里开始** | [configuration](configuration.zh-CN.md) · [clients](clients.zh-CN.md) · [how-it-works](how-it-works.zh-CN.svg) | 全量配置参考（生成式，有漂移守卫）· 各客户端接入深潜 · 一张全流程图 |
| **系统架构** | [architecture](architecture.zh-CN.md) / [English](architecture.md) | **实时枢纽**：整体图 + 每模块一页（pipeline / lanes / kernel / identity / fastpaths / storage / webui / update），每页配自己的图 —— 新鲜度由 CI 车道 `architecture-docs` 强制 |
| **身份与协议** | [message-identity](message-identity.zh-CN.md) · [session-identity](session-identity.zh-CN.md) · [session-identity-resolution](session-identity-resolution.zh-CN.md) · [identity-channels](identity-channels.zh-CN.md) · [msgid-infrastructure](msgid-infrastructure.zh-CN.md) · [opencode-responses-websocket](opencode-responses-websocket.zh-CN.md) · [plugin-protocol](plugin-protocol.md) | 身份教义（消息 id、会话 id、persona 分叉、#5825 信道接线）与各客户端协议说明 |
| **工程与运维** | [technical-notes](technical-notes.zh-CN.md) · [lifecycle](lifecycle.md) · [auto-merge-guardrails](auto-merge-guardrails.md) · [unified-loop-spec](unified-loop-spec.md) | 机制深潜 · 过渡/退役台账（CI 强制）· `AGENTS.md` §7 的证据附录 · 历史设计（以代码为准） |

## 目录规约（这个目录为什么不会再次变乱）

1. **默认双语** —— 英文基名 + `*.zh-CN.md` 镜像；单语言文档必须在 [index](index.zh-CN.md) 条目里写明原因。
2. **每篇新增/搬动的文档都必须在同一 PR 里进 [index.zh-CN.md](index.zh-CN.md) + [index.md](index.md)** —— 没进目录的文档等于不存在。
3. **架构文档是实时的** —— 结构变化在同一 PR 里更新对应页 + 图 + 枢纽总表行；CI 车道 `architecture-docs` 卡机械部分。
4. **施工流程在 [`../reference/`](../reference/README.md)，不在这里** —— `docs/` 放给决策者/评审者看的参考；`reference/` 放惰性加载的施工材料（测试 / 发版 / git-pr / 环境变量 / KDD 全文台账）。
5. **搬家留桩** —— 旧路径留单行重定向 + 在 [lifecycle.md](lifecycle.md) §5 卫生账记一笔，带明确解除条件。

这些规则的权威表述：[`AGENTS.md` §3「Documentation Layout」](../AGENTS.md)。
