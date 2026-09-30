# 消息身份:内容哈希作为跨轮 join key

设计记录:billion-context 如何跨轮识别单条消息,以及为什么身份由消息**内容**派生、而不是在入口打一个由宿主持久化的 id。成文于 #1496 复核之后;与 `SESSION-IDENTITY.zh-CN.md`(会话粒度的同题文档)成对。实现锚点:`acp-kernel/src/wire/message-id.ts`(`deriveMessageId`)、`acp-kernel/src/refs.ts`(`assignRefs`)、`acp-kernel/src/prune.ts`(`isCovered`/`baseIdOf`)。

## 问题是 join key,不是 id

"在入口给每条消息打自增 id"并不是系统缺少的东西——内核已经在做:每条入站消息都会从会话内单调递增、永不复用的账本拿到 `mNNNNN` ref(repo AGENTS.md:*Kernel Contract — message ids are never reused*)。

真正的问题是第 N+1 轮:无状态宿主从**私有**存储重新序列化整个数组时,拿什么把账本重新钉回新数组?位置/顺序被生产证据证伪(见下);唯一在全部五个宿主 × 四条协议 lane 上都稳定的 key 是消息的**内容字节**:

```
wire 原始字节  --sha256-->  h_<sha16>  --byRaw join-->  mNNNNN(账本 ref)
```

`deriveMessageId` 对 `role | contentType | toolCallId | toolName | text` 做
sha256;`assignRefs` 再 first-wins 挂 ref(`if (map.byRaw[message.id]) continue`)。hash 不是**替代**自增 id,而是让 id 得以**复挂**的 join。

## 经手 ≠ 执笔 ≠ 存储

"每条消息都经手 → 能打 id → 100% 覆盖"这个推论混淆了三个概念。逐宿主验证:

| 宿主 | 每轮从私有存储重序列化 | 我们打的 id 能往返? |
|---|---|---|
| codex(Responses) | 是(rollout 文件;environment_context 逐轮更新) | **部分**——仅响应侧 item(#242) |
| claude-code(anthropic chat) | 是(session JSONL) | 无通道 |
| pi(chat,MITM/plugin) | 是(`convertToLlm()` 每次重建数组;消息模型无 id 字段) | 无通道 |
| omp | 是(pi 系插件) | 无通道 |
| hermes 插件 | 是(自有存储 + `pre_api_request` 钩子) | 无通道 |

覆盖率必须在 **re-join 时点**衡量,而不是 ingress 时点。

## Lane 普查:id 能放在哪?

| Lane | 消息级 id 字段 | 判定 |
|---|---|---|
| anthropic chat | 无(仅 `tool_use.id`/`tool_use_id` 配对键) | 无候选 |
| openai chat | 无(仅 `tool_calls[].id`) | 无候选 |
| google | 无(仅 `functionCall`/`functionResponse` 配对 id) | 无候选 |
| responses | 有 `input[].id` | **服务商命名空间**:#242——66 字符超 64 上限,每轮 400;#1474/#1475——Copilot 要求 `rs` 前缀形状;healing 已收窄到自家 `msg-proxy-*` 命名空间 |

四条 lane 三条无字段;唯一有字段的 Responses 在生产中两次拒绝本地铸造的 id。ingress 删除回放的 `msg-proxy-*`(`src/loop/adapter-responses.ts:62-68`)正因为它们是逐轮合成物,不是身份。

## "原始字节永不变"到底指什么

方向正确,但必须修正为:**用户/助手执笔的字节稳定;环境执笔的槽位原地轮换。** codex `environment_context` 每轮重写;匿名 OpenAI harness 每轮轮换内联 system `messages[0]`(#1148);nudge 文本逐轮注入(#728)。这正是 `SESSION-IDENTITY.md` 把 environment 排除出身份、#1148 修复把头部 system run 剥出 affinity 哈希的原因。

前缀比单条更不稳定:滚动窗口截断(dsh 类客户端 20–30 项)、fork/回退重放(#1148、#1102)、单条侧请求(#1307:`ctx==1` → 163/163 压缩全败,`ctx>1` → 62/62 全成)、同位置改写(#1247)、宿主自压缩(codex `/compact`、claude-code `/compact`)。

## 失败模式不对称:认错 vs 认不出

- **位置/顺序 join 失效 = 认错。** ref/压缩块挂到错误消息;decompress 取回错误内容;不可自愈的静默损坏。#1307 原始的 ≤2 计数守卫正是这类顺序启发式的失败实例。
- **内容哈希 join 失效 = 认不出。** 会话 fork 成新会话、重建冷缓存;可自愈的性能损失(#286 fork 语义)。

公理应按失败模式更轻者选择。

## hash 公理的已知代价——以及修复方向

同字节 ⇒ 同身份有代价面:#1476——用户原样重发与已折叠内容相同的短文本;裸 `h_` id 重新派生;`isCovered()` 吞掉新消息。注意**修复方向**:kernel #459 加实例重编号(`_1/_2…`),#463 加 `lastPassIds` 快照区分折叠后**回声**(id ∈ covered ∧ ∈ 上一轮 → 保持 id,prune 吞掉)与真**新实例**(id ∈ covered ∧ ∉ 上一轮 → 重编号到空闲 `_k`)。content hash 始终是基座,只在其上叠加实例判别——连 hash 公理自己的 bug 都靠**保留 hash** 修,而不是退回位置 id。

## 存在的部分往返通道——以及为何不用作身份

#242 是双刃证据。它证明真实存在存回/回放通道(codex 把响应侧 `msg-proxy-*` id 存进 rollout 并回放);也证明该通道不能当身份:覆盖率仅响应侧 item(用户侧 item 无 id 字段)、上游约束命名空间(64 字符上限、`rs` 前缀)、四条 lane 仅此一条。它的现行用途(round-2 生命周期一致性 + ingress 剥离)就是局部最优。

## 标签是派生视图,不是存储的身份

`<acp:mNNNNN…>` 标签在**出站**(朝模型)从 ref map 打印、在**入站**从宿主重发字节剥离;`renderMessage()` 渲染前先剥消息自己的旧标签(幂等),外来标签当内容保留。身份从不依赖往返:同字节 → 同 hash → 同 ref → 同标签,每一轮。

标签回声事故(#206/#295、#14、#673)是"必须如此"的经验证明:模型有时在可见 prose 里模仿渲染标记;宿主原样存下回放;模仿被放大(一条消息累积 77 个回声标签 + ~3300 空行——#14;打错的名字 `acip` 成了一轮的全部可见文本——#673)。"标记进入宿主存储"的通道真实存在但**脏**:会打错、会放大、命名空间不可控。任何"标记当身份"的方案都等于把身份押在这条脏通道上。现行设计把泄漏的标记当可剥离噪声(`src/loop/tag-echo-filter.ts`,仅 prose——工具调用参数绝不剥,#1039),身份从字节重新派生。

## 上游唯一强制往返的地方:strict-echo reasoning

DeepSeek 类网关要求客户端传回网关自己发出的 reasoning("the reasoning content from the previous turn must be passed back in thinking mode")。这是全舰队唯一被强制的内容往返,而 bili 的处理方式展示了模式:当**可修复的形状约束**处理,不进身份——#762 在 chat wire 注入空 `reasoning_content`,#1479/#1482 把修复扩展到 Responses wire 和循环重试路径,全部门控在 `isStrictReasoningEcho`(学到的 400 标记或 deepseek 系),非思考会话字节恒等。身份账本从不参与。

## 被否决的备选

| 方向 | 否决理由 |
|---|---|
| 入口打 id、靠宿主存储携带 | 3/4 lane 无承载字段;第 4 条被服务商命名空间拒绝(#242、#1475);覆盖率在 re-join 时点衡量(见上表)。 |
| 位置/顺序当 join key | 六类事故证明前缀不稳定(#1148、#1102、#1307、#1247、宿主 `/compact`、自身 fold);失败模式是静默认错。 |
| 内容近似匹配 | 字节精确性是承重墙(同 `SESSION-IDENTITY.md` 论证);模糊 join 在 decompress 时静默认错。 |
| 把 `msg-proxy-*` 升级为身份 | 单 lane、仅响应侧覆盖、通道易放大(标签回声证据)、上游命名空间约束。 |
| 标记当身份(标签由宿主持久化) | 标签回声事故证明该通道会污染所载内容;现行设计已在两端剥离。 |

## 未来方向

若未来宿主或 lane 提供真正稳定的客户端消息 id,只允许作为**附加 join hint** 采纳——永不替代 content-hash 基座。在那之前:字节是锚,hash 是 join,mNNNNN 是账本,标签是视图。

相关:#1496(本文档的起因)、`SESSION-IDENTITY.zh-CN.md`(会话粒度)、#1476 + kernel #459/#463(回声判别)、#242/#1475(Responses id 约束)、#206/#673(标签回声)、#1479/#1482(strict-echo 修复)、#1039(工具调用字节不变量)。
