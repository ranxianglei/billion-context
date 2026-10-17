# 消息身份:内容哈希作为跨轮 join key

设计记录:billion-context 如何跨轮识别单条消息,以及为什么身份由消息**内容**派生、而不是在入口打一个由宿主持久化的 id。成文于 #1496 复核之后;与 `SESSION-IDENTITY.zh-CN.md`(会话粒度的同题文档)成对。实现锚点:`acp-kernel/src/wire/message-id.ts`(`deriveMessageId`)、`acp-kernel/src/refs.ts`(`assignRefs`)、`acp-kernel/src/prune.ts`(`isCovered`/`baseIdOf`)。#2480 随后把问题一分为二:下文的**内核账本**仍是 content-hash;而**折叠覆盖重锚层**(`src/fold-reconcile.ts`)改为「位置 + 自存规范副本」——见下文「折叠覆盖层改为位置身份」一节;本文档的账本契约未变。

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
| dsh | 是 | **宿主模型 id 走旁路字段**——`MessageBase.id` 跨表示边界稳定;插件从出站 body 读 id,宿主序列化器带上它就盖 `_bili_message_ids`(#3464) |
| opencode | 是 | **宿主模型 id 走旁路字段**——`msg_…` id,同一机制(#3464) |

覆盖率必须在 **re-join 时点**衡量,而不是 ingress 时点。上表两条旁路 lane 即 R1 的采用:宿主自己存储里的 id 就是 join key,bili 永不铸造或改写它。

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

## 宿主必须在会话内保持工具调用 id 字节稳定

hash 以 `toolCallId` 为因子,fold-reconcile 层(`src/fold-reconcile.ts`,#1921)以它为主 claim key:`tool_use.id` / `tool_call_id` 是唯一既按会话协议唯一、又能在客户端重序列化中原样存活的字段。这个前提只有一个外部依赖——**宿主自身**不得在把同一会话投影到另一 provider 时改写这些 id。#2396 找到了真实违例:Prime(pi 系运行时)把同一会话从 Codex 切到自定义 Responses provider,其外部 provider 转换器对存储的复合 id 重新做了净化——`call_switch_seed|fc_0_0` 在 Codex lane 序列化为 `call_switch_seed`,在外部 lane 却发出 `call_switch_seed_fc_0_0`,且每一对的两侧都改。两条 claim pass 都以该 id 为键,于是所有已折叠的工具对全部失配:按 ~66,525 input token 计费的内容以 558,541/562,549 重新进入 500,000 token 窗口的 wire。

bili 的应对遵循上文的失败模式公理:**不猜** old→new 配对(猜了就是把"认不出"变成"认错"——decompress 在一个貌似合理的 id 替换后取回错误内容)。它只做形状检测:一个缺失 covered id,其**去掉 toolCallId** 的归一化身份与某个携带不同 toolCallId 的入站孪生消息相同,即计为一个 rewrite suspect 并在漂移日志中点名(#2396);原始内容则诚实地以未折叠状态重回 wire。义务在宿主一侧——见 PLUGIN.md("Obligations of a plugin"第 5 条):在 payload 到达代理之前于宿主边界规范化 id。#2396 中的 workaround(在处理前基于权威存储历史同步改写 `call_id` + `call_output.call_id`)就是这项义务的参考实现。

#2480 后来瓦解了这一类的「只检测」立场:缺的那块是**宿主对原始字节的记忆**,而折叠覆盖层现在恰好保有它——一份自存规范副本(见下节)。位置提供配对,存储的指纹验证配对,于是跨宿主改写 id 方案的 claim 不再是猜测。漂移日志与诚实重入兑底仍保留,用于副本覆盖不了的情形(结构性编辑、超出窗口的历史)。

## 折叠覆盖层改为位置身份(#2480)

内核账本与折叠覆盖重锚回答的是两个不同问题:

- **账本 join**(第 N+1 轮,把 `mNNNNN` 重新钉到重序列化的数组上):内容哈希,不变,遵循上文全部结论。
- **折叠覆盖重锚**(哪些入站消息是我压缩块已覆盖的那些?):`src/fold-reconcile.ts` 现在用**位置 + 自存规范副本**回答,排在它原有的 toolCallId pass 与归一化内容 pass 之前。

机制:每个 reconcile pass 滚动写入 `foldPositions`——按位置的 `sha256-16`,输入 `role | toolName | canonical text`(JSON 形文本键排序紧凑化;散文保留原始字节;`toolCallId` 与 `contentType` 字面量被排除,因为它们恰是跨 codec 重编码的 token;**reasoning 仅按 role 指纹**——responses adapter 把 provider item id 投影为 core text,若参与哈希,每次 churn 的第一条 reasoning 就会断掉全部配对)。Pass 0 随后在 churn 区间内先头扫、后尾扫,**仅在指纹于对齐位置相等时**才把旧 covered id 认领到新对应物;首个失配即停,所以中点插入/删除会诚实地拒绝桥接。没有副本的会话(升级时点的全部存量)零成本:第一个稳态 pass 建立副本,*下一次*漂移即被位置认领——迁移免费,因为"认不出"本身就是新序列。

这与下文否决「位置当 join key」并不矛盾:裸位置被否决,是因为在没有旧字节记忆的情况下,位置 claim 是**猜测**,以认错告终。副本把猜测变成对齐偏移处的**已验证等值**——同一公理上移一层:指纹失配 → 诚实的认不出(unmatched,走 #1001/#1195 lane),永不认错。验证矩阵在 `tests/identity-proof.test.ts`(机制级、judge 计费,仿 `tests/cache-proof.test.ts`):4 wire × 3 阶段(折叠稳定 → id 方案+序列化 churn 后覆盖保持 → 中点编辑诚实重入)、reconcile-off 对照(无该层时 churn 重新计费)、跨 wire 客户端互换(anthropic → chat)端到端保持覆盖,以及切模型阶段(#2636):chat lane 携带 reasoning 助手轮与图片用户轮,随后把历史重放到另一个形状的模型(reasoning 内联 pair→merged、图片换占位行)——覆盖必须扛住形状 churn 且已覆盖的 thinking 不得重入,以 churn 后**第一个** body 为准(新的服务端 compress 可能把失败重放重新折回去——治愈后的 round-2 不得冒充保持证明),另有自己的 reconcile-off 对照证明无该层时此 churn 类会重新计费。

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
| 位置/顺序当 join key | 六类事故证明前缀不稳定(#1148、#1102、#1307、#1247、宿主 `/compact`、自身 fold);失败模式是静默认错。对**账本 join** 仍然成立;#2480 后来仅对折叠覆盖层采纳了「位置 + 自存规范副本」,逐位验证消除了猜测——见上文。 |
| 内容近似匹配 | 字节精确性是承重墙(同 `SESSION-IDENTITY.md` 论证);模糊 join 在 decompress 时静默认错。 |
| 把 `msg-proxy-*` 升级为身份 | 单 lane、仅响应侧覆盖、通道易放大(标签回声证据)、上游命名空间约束。 |
| 标记当身份(标签由宿主持久化) | 标签回声事故证明该通道会污染所载内容;现行设计已在两端剥离。 |
| 隐式别名化宿主改写的工具调用 id | 把一个缺失 covered id 与"同内容、不同 toolCallId"的入站孪生配对需要宿主知识;没有它,claim 就是猜测,decompress 时认错(#2396:Prime 跨 provider 切换改写了复合 id)。只交付检测;修复属于宿主边界(PLUGIN.md 义务 5)。#2480 更新:Pass 0 现在提供了那份宿主知识(位置 + 存储的规范指纹),这一类从"只计数"变为"可认领";能在更早边界规范化的宿主,PLUGIN.md 义务 5 依然成立。 |

## 宿主稳定 id:R1 通道(#3464,取代旧的「未来方向」)

本文档旧立场——宿主稳定 id 至多算**附加 join hint**、永不替代 content-hash 基座——已被 #2938 的 owner 裁定(hash 降为二等公民;顺序为中心、绝不模糊)与 #3464(#2960 身份管线 R1)取代。宿主模型带稳定消息 id 的 lane(dsh `MessageBase.id`、opencode `msg_…`)现在通过**顶层 body 旁路字段**(`_bili_message_ids`,与 `messages` 下标对齐;wire 协议本身仍无 id 字段——上表普查结论不变)把 id 送进 bili。盖了章的 lane 上,身份从「猜内容像不像」变成精确集合代数:

- **存储**(`src/storage/schema.ts` v6):`messages.host_id`/`host_slot` + 部分唯一索引 `(session_id, host_id, host_slot)`。行的键是宿主 id,字节 hash 降为内容列。同一条宿主消息以漂移后的字节重发时,**原地刷新该行**(有记录的 append-only 例外,保证 DB 视图与内存尾部逐字节相等——#2960⑤ digest parity),而不是再落一行孪生行。seq 分配优先沿用宿主键连续性,字节漂移不再搅动水位。
- **对账**(`src/fold-reconcile.ts`):Pass -1,排在一切启发式 pass 之前——锚点带宿主 id 的 covered id 直接认领同宿主 id 的唯一入站 core(多 core 组内 k-th 配对,role 门)。启发式 pass(位置/toolCallId/孪生/simhash/顺序括号)保留给未盖章 lane 与盖章前留下的锚点。未盖章 lane 与此前逐位一致。
- **fork**(`src/plugin.ts` fork 快照):响应新增加性的 `hostIds` 数组(与 orderedMessages 下标对齐)——宿主 id → bili ref 映射,构造上不进任何 hash,新旧客户端的分支点比较都保持基于字节。

采用按 lane 渐进、自动降级:插件被动读取宿主序列化器实际写进出站 body 的 id(不改宿主 API),仅在 proxy 广播 `capabilities.hostMessageIds` 时盖章,字段缺失或畸形一律退回字节 id 路径。宿主模型没有消息级 id 的 lane(pi、omp——见普查)在其宿主补齐前保持字节身份。字节仍是通用兜底;宿主 id 在有处即为主键。

相关:#1496(本文档的起因)、`SESSION-IDENTITY.zh-CN.md`(会话粒度)、#1476 + kernel #459/#463(回声判别)、#242/#1475(Responses id 约束)、#206/#673(标签回声)、#1479/#1482(strict-echo 修复)、#1039(工具调用字节不变量)、#2396(跨 provider 切换时宿主改写的工具调用 id)、#2480(位置折叠覆盖;`tests/identity-proof.test.ts` 是其证明矩阵)、#2636(切模型形状 churn:assistant-turn key + 图片占位变体 pass)、#2938(宿主消息 id 旁路通道提案;owner 裁定:顺序为中心、hash 二等公民)、#3464(R1 宿主 id 通道实现)。
