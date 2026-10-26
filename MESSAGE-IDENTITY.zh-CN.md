# 消息身份:内容哈希作为跨轮 join key

设计记录:billion-context 如何跨轮识别单条消息,以及为什么身份由消息**内容**派生、而不是在入口打一个由宿主持久化的 id。成文于 #1496 复核之后;与 `SESSION-IDENTITY.zh-CN.md`(会话粒度的同题文档)成对。实现锚点:`acp-kernel/src/wire/message-id.ts`(`deriveMessageId`)、`acp-kernel/src/refs.ts`(`assignRefs`)、`acp-kernel/src/prune.ts`(`isCovered`/`baseIdOf`)。#2480 随后把问题一分为二:下文的**内核账本**仍是 content-hash;而**折叠覆盖重锚层**(`src/fold-reconcile.ts`)改为「位置 + 自存规范副本」——见下文「折叠覆盖层改为位置身份」一节;本文档的账本契约未变。#3641 随后在其上补了判决层——**没有**任何通道验证成功时怎么办——见下文「快照即会话教义」一节;账本契约依然不变。

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

## 快照即会话教义:身份之上的判决分类(#3641)

#2480 让折叠覆盖变成「位置+验证」;#3641 则定论:**没有**通道验证成功时怎么办。反转在于:**(会话 id + 折叠快照)才是会话本体**——wire 只是对它的对齐观察。id、hash、形状都是提示;「我的块覆盖哪些消息、按什么顺序」才是事实。三类生产事故倒逼出这一层:协议重序列化把全部 id 重铸但词还在(#3640)、图片 offload 把无文本族改写成占位串(#3588)、无状态客户端截断已覆盖段(#2695)——三者过去都会被诊断为 "substrate destroyed"。

机制(全部在 `src/fold-reconcile.ts` 加一条内核摆位规则;证明测试在 `tests/fold-anchor-doctrine.test.ts`):

- **形状层**(保序):当一次性缺失**成片** covered id(≥ `SHAPE_MASS_MIN`)时,残留散文锚按会话顺序与入站候选配对,受编辑诚实门约束——词袋相等 + simhash ≤ 8 + role + 长度卫兵(sim 层用于 gap 的同一道门,用在 claim 上)。无文本锚(图片族:构造上无 sh/wh)在两侧被已验证的侧翼包夹、且逐桶计数恰相等时按第 k 对第 k 配对——byImage 纪律推广到 bili 自家占位变体之外。
- **残差普查与判决分类**:阶梯认不下的部分被*分类*,而非假定已毁。`shapeExplained`(变换:claim 或近重证据承担了主体)——一次性 info latch,清零 streak。`truncationExplained`(良性删除:残差全部到处缺席、零近重、且**wire 连续性见证**——冻结的旧序尾部仍居于入站头部)——块休眠而非 reap(#2695)。其余照旧是 drift,照旧升级。
- **episode 见证人**:首个 drift pass 冻结旧序尾部(`foldEpisodeOrder`);同会话 id 下的外来会话与它无连续性,整体替换无法冒充截断。
- **epoch 确认门**:全塌 latch `foldEpochConfirmPending`,发一条 error,preflight 原样透传——折叠*暂停*;不删任何东西,不静默重置。对齐恢复(宿主重发真实历史)自动清 latch。
- **未解析锚摆位**(内核 `prune.ts`):锚全部解析失败的块,插入点从尾部改为最后一个 user 消息——摘要块再也不会骑在用户最新提问*之后*(#3640 的六个骑尾块)。

诚实边界是有意的:形状层要求**严格**词袋相等,所以系统性内容突变——比如宿主给历史批量加/删尾部 `<system-reminder>` 后缀——**不会**被认成同一条消息(模糊内容 join 在 decompress 时认错;见下文被否决备选)。这类事件被分类为截断或全塌,落在休眠/暂停路径上——永不静默重键。批量同后缀重戳(N 对保序对共享完全相同的 delta)是否值得单独立一个*可验证*类,是待生产日志定界的开放跟进项(#3640/#3588)。

兼容性:教义是匹配/判决层变更——零迁移,新老会话一体适用,与存储无关(legacy JSON、shadow、full 三模式行为完全一致;记账走 session metadata)。内核账本的 content-hash 契约分毫米未动。

## 快照渲染引擎:出站身份移到服务端(#3756)

#3641 定论了「没有通道验证成功时怎么判」;#3756 则把依赖本身从出站路径上拆掉:灰度开关 `snapshotRender`(默认 0%,`BILI_ROLLOUT_SNAPSHOT_RENDER`)开启时,prepare 层不再**从客户端重发的字节**重建历史,而是**从服务端统一存储正史**渲染出站前缀(`src/server/snapshot-render.ts`):

- **身份阶梯最终形态**:会话身份 = 会话绑定(宿主原生 session id 优先,凡有即用);会话内消息身份 = 服务端快照行(`seq`),永不重铸;内容 hash/签名降级为**仅作链回溯兜底证据**——定位「客户端逐字尾巴让位给服务端前缀」的分歧点(id 快路径 + `role|contentType|toolName|text`/图片长度签名兜底,即 #3642 的 canonical 形态——id 全部重铸仍可链接)。
- **覆盖由引擎自拥**:被覆盖行按块的 seq/签名覆盖集抑制;`acp_summary_*` 锚从块状态原位重渲。引擎**不信任** reconcile 阶梯 re-key 后的块 id——reconcile 合法地把块 re-key 到客户端新铸 id(恰是 #3752 在 16384 锚封顶下把它们丢掉的失败形状)。
- **尾巴保持客户端逐字**:分歧点之上按客户端原字节转发——未折叠工作区仍是客户端自己的话,轮轮前缀缓存稳定。rewind 掉的行位于 join 之下,永不渲染。
- **降级,不猜**:开关关/无活跃块/存储不可读/链接不上——整轮回退 legacy 路径,零变化。客户端头部 checkpoint 有一轮采用滞后(视图=上一轮的观察),且永不复活已覆盖行。
- 结构性消灭:#3752 的锚封顶悬崖(MAX_ANCHORS × id 重铸 × 无状态重发)与 #3751 的图片 `_N` 族位移 churn——渲染前缀跟随块 seq 与内容签名,不再跟随客户端字节,这两类都再也无法丢/重折叠历史。

#3641 的 reconcile/判决层全部保留:它们仍是 D 关闭/不可用/降级时的安全网;观测通道(`reconcileFoldCoverage`)继续观察**客户端**视图(渲染与观测刻意分离)。

## 图片按载荷寻址,不再按家族编号(#3751)

上面的 `_N` 实例纪律有一个前提:base id 本身已经区分了「这是哪份内容」。
图片在 #3751 之前打破了这个前提——每条图片 core 的规范文本都是同一个
`[image]` 标记,一个会话里所有图片哈希出**同一个共享 base**,全靠 `_N`
序号做区分——而序号是**位置敏感**的。一张图变化(offload 占位、重编码、
删除)会把全族序号整体位移,每轮把整个家族的 id 重铸一遍(正是 #3748
写放大事故的喂数机)。

修法保持教义、补上缺口:规范种子增加第六个槽位,但**只有媒体 core 才有**
——数据图取 `hash(imageBase64)`(字节在 codec 与内容 CAS 两边都已经有),
URL 图取 URL 字符串(wire 上没有字节,URL 是唯一可用的身份),罕见的
legacy 复数 sidecar core 取各部件指纹的有序串。字节相同的图片共享 base
id 是有意的:`_N` 保留给**真正的重复图**(回到 #459/#463 实例纪律的本职)。
一张图变化现在只重铸它自己那条 core。文本 core 永不加该槽位,非图片 id
跨本次升级逐字节不变。

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

## 未来方向

若未来宿主或 lane 提供真正稳定的客户端消息 id,只允许作为**附加 join hint** 采纳——永不替代 content-hash 基座。在那之前:字节是锚,hash 是 join,mNNNNN 是账本,标签是视图。

相关:#1496(本文档的起因)、`SESSION-IDENTITY.zh-CN.md`(会话粒度)、#1476 + kernel #459/#463(回声判别)、#242/#1475(Responses id 约束)、#206/#673(标签回声)、#1479/#1482(strict-echo 修复)、#1039(工具调用字节不变量)、#2396(跨 provider 切换时宿主改写的工具调用 id)、#2480(位置折叠覆盖;`tests/identity-proof.test.ts` 是其证明矩阵)、#2636(切模型形状 churn:assistant-turn key + 图片占位变体 pass)、#2695/#3588/#3640/#3641(快照即会话教义;`tests/fold-anchor-doctrine.test.ts`)。
