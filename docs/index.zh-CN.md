# 文档总目录

> 全部系统文档集中在 `docs/`。仓库根目录只保留四个入口文件：`README.md`、`README.zh-CN.md`、`AGENTS.md`、`CHANGELOG.md`。原根路径保留单行重定向占位（计划 1–2 个版本后删除，记账见 [lifecycle §5](lifecycle.md#5-卫生记录)）。
> 惰性加载的施工参考（架构 / 环境变量 / 测试 / 发版 / git-pr）：[reference/](../reference/README.md)。

## 从这里开始

| 文档 | 说明 |
|---|---|
| [README](../README.md) / [English](../README.zh-CN.md) | 项目入口：是什么、快速上手、架构总览 |
| [architecture](architecture.zh-CN.md) / [English](architecture.md) | **系统架构总览**（实时维护，owner 裁定 2026-11-08）：整体架构图 + 每模块一页（各配图），见 `docs/architecture/` |
| [configuration](configuration.zh-CN.md) / [English](configuration.md) | 全量配置参考（由 `website/config-reference/*.yaml` 经 `tools/gen-config-docs.mjs` 生成；手写部分有漂移守卫） |
| [clients](clients.zh-CN.md) / [English](clients.md) | 各客户端接入深潜：launcher / `/bili/` / 原生插件三种模式如何接线 |
| [how-it-works](how-it-works.zh-CN.svg) / [English](how-it-works.en.svg) | 一张图：请求流转 + 注入的上下文工具 |
| [README](README.zh-CN.md) / [English](README.md) | 目录落地页：分区地图 + 保持本目录不再变乱的规则 |

## 身份与协议

| 文档 | 说明 |
|---|---|
| [message-identity](message-identity.zh-CN.md) / [English](message-identity.md) | 消息身份教义：内容哈希作跨轮 join 键、顺序 > hash、msgid 层、快照渲染 |
| [session-identity](session-identity.zh-CN.md) / [English](session-identity.md) | 匿名请求归属哪个会话 |
| [session-identity-resolution](session-identity-resolution.zh-CN.md) / [English](session-identity-resolution.md) | 已知客户端 session id 归属哪个会话（同 id 不同会话的裁决） |
| [identity-channels](identity-channels.zh-CN.md) / [English](identity-channels.md) | 跨客户端稳定会话/消息 id 接线（#5825）：谁带身份进来、在哪里消费 |
| [msgid-infrastructure](msgid-infrastructure.zh-CN.md) / [English](msgid-infrastructure.md) | sessionid+msgid 的生产、校验（六份副本）、钉住与消费 |
| [opencode-responses-websocket](opencode-responses-websocket.zh-CN.md) / [English](opencode-responses-websocket.md) | OpenCode V2 Responses-over-WebSocket 集成（#1844） |
| [plugin-protocol](plugin-protocol.md) | 协作插件协议 v2（实验性，无中文版） |

## 工程与运维

| 文档 | 说明 |
|---|---|
| [technical-notes](technical-notes.zh-CN.md) / [English](technical-notes.md) | 机制深潜大杂烩（wire 行为、双压缩模式、快路径） |
| [lifecycle](lifecycle.md) | 过渡开关台账 / 退役模块盘点 / 卫生记录（CI 强制 `BILI_*` 覆盖） |
| [auto-merge-guardrails](auto-merge-guardrails.md) | `AGENTS.md` §7 背后的证据附录（AI 自动开发评审史） |
| [unified-loop-spec](unified-loop-spec.md) | 历史设计：统一压缩循环规格（已落地，以代码为准） |
