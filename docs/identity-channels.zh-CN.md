# 身份信道接线（#5825）

跨客户端"稳定会话+消息 ID"接线的单页说明：谁把身份带进 bili、在哪里消费、
新车道必须做什么。设计法则（owner 裁定 2026-11-07）：**每条客户端车道都接进
同一条统一消费缝——任何调用点绝不自己去读客户端存储。** AGENTS.md KDD #18
是规范条文，本页是地图。

## 1. 缝在哪里

每个请求在唯一一点（`src/server/handle.ts`，会话身份解析之后、resolve 之前）
对身份注册表取一次快照：

```
宿主盖章 id（body 字段 / 轮次信封 msgIds）  ──▶ 同一条消费路径 ◀── 采集器 id
                                                     （msgid-pin 校验 → #5719 归属档 →
                                                      anthropic wire 上再进 pin/行链路）
```

- **盖章车道**（dsh 等）：宿主铸 canonical id（`acp_summary_*`），写 body
  字段或 `/__bili/plugin/turn` 信封；出站前协议剥除。
- **采集车道**（本接线）：回环请求若来自"本地存储带稳定消息 id"的客户端，
  由自包含适配器匹配；任何一处不判定 → 该轮整体退化为接线前路径，绝不做
  部分映射、绝不静默改键。

采集门控（每请求全部满足才生效）：rollout `pluginLaneServerHistory` 开 ×
env `BILI_IDENTITY_HARVEST` 非空（`all` 或逗号来源列表；缺省 = 关，完全
惰性）× 请求来源仅回环 × 适配器 join key 匹配。

## 2. 车道状态表（来自 #5825 逐客户端调查）

| 客户端 | 会话键 | 消息 id | 适配器 | 状态 |
|---|---|---|---|---|
| claude-code | `x-claude-code-session-id`（+转录文件名） | 转录 JSONL 行 `uuid`；sidechain/summary 行排除 | `src/identity-claude.ts` | 已接（anthropic wire：全链路含行钉住） |
| codebuddy | `x-conversation-id`（==转录文件名，跨重启稳定，实测 2.181.0） | JSONL 行 `id`+`parentId`；system/草稿行排除 | `src/identity-codebuddy.ts` | 已接（openai wire：归属档）；识别并入 `conversationHeaderSource` 低信任层 |
| mcode / mavis | `x-mavis-session-id`（`mvs_…`，#1050 已识别） | runtime-state.sqlite `local_runtime_message_rows.msg_id` | `src/identity-mcode.ts` | 已接（SQLite 首例；每轮开库→查询→即关的只读探针） |
| opencode V1 | `x-opencode-session-id` | opencode-msgids 采集（既有） | 不变 | 在线 |
| opencode V2 | `x-opencode-session-id`（默认头） | context-hook 会话消息；变体 id 可选 → 保留整轮退化 | — | 后续 PR（需 transform-hook 深度工作 + 实测验证） |
| crush / qwen / gemini-cli / goose / hermes / antigravity / qoder / copilot | 各客户端键 | sqlite uuid PK / jsonl uuid（issue 评论中逐例证过稳定） | — | 后续适配器，同一注册表（布局已在 #5825 各线程确认；待核心在灰度观察下站稳后跟上） |
| zcode / iflow | zcode 归因头组 / 小写 `session-id`、`conversation-id`（已识别） | 尚无经证实的消息级线上传输 | — | 需一次登录态测量才能适配 |
| grok-shell / kiro | 已识别 | 模型线上无可用的消息级实体（源码证明） | 不适用 | 只有会话半程——按闭合备忘收尾 |
| aider / jcode / kimi | 无稳定会话键 | 无可用消息 id | 不适用 | 内容哈希回退即最优——按闭合备忘收尾 |
| codex | 会话已知 | item.id 属 provider 命名空间；自铸 id 两次生产否决（#242/#1474） | 不适用 | 暂缓，等 #5643 裁定 |
| trae / amp | — | — | — | 阻塞：外部拿不到构件 |

## 3. 信任边界

- 采集到的 id 一旦通过校验即与盖章 id **同信任级**（同一 canonical 校验、
  同一档语义）——因为它们来自发出该请求的**同一个客户端**在**本地**的
  文件/sqlite，且只允许回环来源；远端来源永远不采集。
- 每个适配器在自己的 snapshot 内自验布局假设；公共纪律在核心里：计数对
  `expectedLen` 精确对齐、至多 4 个边界位置的 role 抽查（仅当两侧都有
  role）、canonical msgid 校验、每来源 warn-once 退化。
- 消费者保持客户端无关：缝以下的任何代码都不出现客户端名。

## 4. 改动清单

新增采集车道：加 `src/identity-<client>.ts`（自包含，只用 node 内置模块）→
在 `src/identity-sources.ts` 登记一行 → `tests/identity-harvest.test.ts`
加夹具测试 → 本页 §2 加一行 + AGENTS.md 状态更新。**禁止**：注册表之外读
客户端存储、绕过门控、让任何车道带着无法判定的轮次做部分映射。
