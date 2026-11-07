# 身份信道接线（#5825）

跨客户端"稳定会话+消息 ID"接线的单页说明：谁把身份带进 bili、在哪里消费、
新车道必须做什么。设计法则（owner 裁定 2026-11-07）：**每条客户端车道都接进
同一条统一消费缝——任何调用点绝不自己去读客户端存储。** AGENTS.md KDD #18
是规范条文，本页是地图。
姊妹页（**判定侧**——ID 到达之后 bili 如何裁决归属）：`docs/session-identity-resolution.zh-CN.md`。

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
- **盖戳头车道**（opencode V2）：扩展在自己的 http-request hook 里读**当轮
  自己的**结构化消息，设 `x-bili-msg-ids` 请求头（同一事件取值零竞态；任一
  变体缺 id → 整份戳作废）。服务端按「body 字段 > 该头 > 采集」优先级消费，
  两条 wire 的 prepare 均无条件剥除内部字段。
- **采集车道**（本接线）：回环请求若来自"本地存储带稳定消息 id"的客户端，
  由自包含适配器匹配；任何一处不判定 → 该轮整体退化为接线前路径，绝不做
  部分映射、绝不静默改键。

采集门控（每请求全部满足才生效）：**env `BILI_IDENTITY_HARVEST` 非空（`all`
或逗号来源列表）或灰度键 `rollout.features.identityChannelHarvest` 开——二者
任其一即可使能、均默认关（刻意与无关的 `pluginLaneServerHistory` 解耦）**
× 请求来源仅回环 × 适配器 join key 匹配。已接纳 id 的**行钉住**仍在两条 wire
上由 `pluginLaneServerHistory` 把关（命中水位快路径的轮次因窗口变短按构造不
参与）；归属档证据不需要它。

## 2. 车道状态表（来自 #5825 逐客户端调查）

| 客户端 | 会话键 | 消息 id | 适配器 | 状态 |
|---|---|---|---|---|
| claude-code | `x-claude-code-session-id`（+转录文件名） | 转录 JSONL 行 `uuid`；sidechain/summary 行排除 | `src/identity-claude.ts` | 已接（anthropic wire：全链路含行钉住） |
| codebuddy | `x-conversation-id`（==转录文件名，跨重启稳定，实测 2.181.0） | JSONL 行 `id`+`parentId`；system/草稿行排除 | `src/identity-codebuddy.ts` | 已接（openai wire：归属档）；识别并入 `conversationHeaderSource` 低信任层 |
| mcode / mavis | `x-mavis-session-id`（`mvs_…`，#1050 已识别） | runtime-state.sqlite `local_runtime_message_rows.msg_id` | `src/identity-mcode.ts` | 已接（SQLite 首例；每轮开库→查询→即关的只读探针） |
| goose | `agent-session-id`（==sessions.id，跨重启稳定；BYOK 路径同样带；用户改过头名则仅本车道退化） | sessions.db `messages.message_id`（`msg_<uuidv4>` 不复用）按 created_timestamp,id 排序；压缩改父子关系 → 压缩后当轮整轮退化、下轮自愈 | `src/identity-goose.ts` | 已接（`agent-session-id` 已入会话识别低信任层） |
| qwen-code | 用户 customHeaders `${session_id}`，官方 BYOK 文档示例名即 `x-opencode-session`（bili 已识别）；自选其它名则安全退化 | `<QWEN_HOME>\|~/.qwen/projects/<cwd>/chats/<sid>.jsonl` git-log 行 `uuid`；sidechain 文件/压缩 checkpoint/rewind 记录均整轮安全退化 | `src/identity-qwen.ts` | 已接（join 是**用户侧选择项**——见状态注） |
| opencode V1 | `x-opencode-session-id` | opencode-msgids 采集（既有） | 不变 | 在线 |
| opencode V2 | 扩展自己盖 `x-bili-msg-ids`（当轮自身结构化消息，同事件零竞态） | 变体 id 可选 → 任一处缺失即整份作废 | `src/agent/opencode-v2-msgids.ts`（+ handle 消费、双线剥除钉住） | 已接（盖戳头车道） |
| crush | join 键为会话 UUID 的 XXH3 hex 摘要，且库在工程目录内（代理无法枚举客户端 cwd） | sqlite uuid PK 已证稳定 | — | 闭合备忘：需客户端给出 xxh3 join 值或约定数据目录后再适配 |
| gemini-cli | 最接近的身份是装机级（`installationId`，机器维度而非会话维度，且随遥测开关） | 转录有 uuid 但无稳定会话级线上键 | — | 闭合备忘：待出现会话级线上键 |
| hermes-agent | 线上零身份信号（只有品牌头），尽管 sqlite schema 很强 | id AUTOINCREMENT + active/compacted 列 | — | 闭合备忘：没有可 join 的东西，除非客户端改动 |
| iflow | 曾有可接的会话头 + claude 式 JSONL | 双 id 空间歧义（线上 getSessionId vs `session-<hash>` 文件名） | — | 闭合备忘：产品已下线（README 停服公告；npm 最终版）——不值得加面 |
| antigravity / qoder / copilot / zcode | 各客户端键（antigravity 线上无任何身份头） | 转录布局部分已证（#5825 各线程） | — | 需一次登录态测量才能适配 |
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
