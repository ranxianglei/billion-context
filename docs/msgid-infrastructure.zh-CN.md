# 消息身份公用设施:sessionid+msgid 的生产与消费地图

> 状态:#5826 release review(2026-11-07)owner 裁定落地的缺口修复配套文档。
> 身份层级教义见根目录 MESSAGE-IDENTITY.md 与会话侧 SESSION-IDENTITY.md;本文只负责一件事——把 **sessionid+msgid 这套跨车道的公用设施**的生产端、传输形态、校验副本、持久化单一事实源、五个消费方、信任边界,一次说明白。改动任何一处之前先读这里。

## 1. 这是什么

四条插件车道(dsh / omp / opencode / pi)的宿主在每条消息上盖一个稳定 UUID(bili 称之为 **msgid**),随请求上行;bili 用它钉住消息身份(抗改写/重排/压缩)。服务端会话身份 **sessionid** = 宿主对话 id(插件车道经 persona 分裂规则后可能带 `|sub:<fp>` 后缀,KDD #9)。两者合起来是账本身份三元组 `(session_id, msg_id, content_hash)` 的前两维:msgid 定身份,content hash 兜底防错绑(KDD #11/#13 是层级与快照渲染的教义,本文不重复)。

## 2. 生产端(谁造出 id)

| 层 | 内容 | 位置 |
|---|---|---|
| 宿主铸造 | 宿主对会话内每条消息赋稳定 UUID(压缩后不复用);`acp_summary_*` 命名空间是 kernel 合成锚点专用,**宿主 id 不得占用** | dsh:`options.messages[].id`;pi/opencode/omp 同理各宿主自有字段 |
| dsh 薄采集器 | `hostMsgIdsOf`(全有全无)+ `pfSlotIdsOf`(逐槽变体,坏槽骑 `?`) | src/agent/dsh-native.ts(~:1186/:1202) |
| pi 解析器 | `laneMsgIdsForWire` / `laneMsgIdsForOpenAiWire`;**直接调用 canonical 校验器**(非镜像);config-assembled 前导 system 槽无 branch entry,用合成 `bili-ps-N` 位置令牌覆盖 | src/agent/pi.ts |
| opencode / omp | 复用同一份已验证列表(transform 钩子 / `ompTurnMsgIds` fetch 层对齐,仅 anthropic wire 回合) | src/agent/opencode-native.ts / omp 车道 |

纪律:采集器只做「拿到并初筛」,**不进入身份裁决**;裁决权归 §4 校验器与 §5 存储。

## 3. 传输形态(id 怎么上行)

四种载体,**全部在转发上游前剥除**——上游模型线至今没有消息级 id(#2821 教义):

1. **信封字段** `biliMsgIds`:全量重发模型线的 body 平行数组,与 messages 等长、同生命周期(入站即剥,src/server/prepare-anthropic.ts 等)。
2. **增量 turn payload** `msgIds`:`POST /__bili/plugin/turn` 信封(src/agent/incremental-client.ts);服务端重打 `biliMsgIds`(src/incremental-lane.ts)。
3. **水位头** `x-bili-pf-tail-ids`(v2-v4,#5403/#5418):仅窗口段 = 上一锚点元素 + K 之后新增元素的宿主 msgid,逐段百分号编码、逗号分隔(id 内逗号走 `%2C`,分离符保持字面);伴生 `x-bili-pf-count` 计数戳。pf-* 是**协议头不是 hop 头**:转发上游前经 `UPSTREAM_HOP_HEADERS` 剥掉。
4. **ledger seq 兄弟字段** `biliLedgerSeqs` / `ledgerSeq` 戳(#4316 层3 PR2/3):1-based 正整数平行数组,`validateMsgSeqs` 校验,同样严格+降级同生命周期。

## 4. 校验副本(为什么有六份、如何同步)

结构性约束:**注入宿主的 bundle 运行在外部 runtime,禁止 import server 模块**(约束原文注释见 src/agent/dsh-native.ts ~:1177、src/agent/incremental-client.ts ~:227)。所以镜像是结构必需,不是偷懒。六份副本及各自筛查面:

| 副本 | 位置 | 角色 | 严格性剖面 | 降级方向 |
|---|---|---|---|---|
| **canonical** `validateMsgIds` | src/msgid-pin.ts | 入站总闸(全量重发 + 增量 turn gate) | 严格全有全无 + 长度必须相等;拒绝类:非串/空/超长(>512)/保留前缀/\s/\p{C}/重复 | 丢字段→该回合退内容 hash/id |
| 宽松入站变体 `incomingMsgIdsOf` | src/msgid-pin.ts | #5719 最后一档救援输入 | 无长度契约、**无去重门**;控制类仅 `\s`+C0/Del(U+200B 通过) | undefined→走 pre-#5719 路径 |
| dsh 宿主镜像 | hostMsgIdsOf / pfSlotIdsOf(src/agent/dsh-native.ts) | 宿主侧采集 | 全有全无 / 逐槽 `?`;完整 \p{C} 类 | 回合退非增量 / 槽骑 ? |
| incremental-client 镜像 `screenMsgIds` | src/agent/incremental-client.ts | 候选上行前预筛 | 全有全无布尔 | 「无字段」降级(避免 400 杀死整包) |
| pf-channel 内联筛查 | src/agent/pf-channel.ts(capture ~:99) | 水位 id 采集状态机 | 逐槽 `?` + `MAX_IDS=2048` 上限 + 解析失败即清列表 | count-only 模式 |
| wire 解码 `parseTailIds` | src/server/fastpath.ts | 服务端解码 tail-ids 头 | 整表作废(all-segments);#5826 review 起执行**全套 canonical 拒绝类**(补齐保留前缀门) | 本轮 count-only,不计熔断 |
| 证据型宽松 `collectRequestIds` | src/request-membership.ts | #4805 结算 membership 探针输入 | **跳过坏条目**(非作废)、无控制字符筛查、可回落 toolCallId | 空证据→membership 该轮未决 |

**机械锁:`tests/msgid-rule-parity.test.ts`。** 每个拒绝类喂过每一份副本,当前判决逐一断言;**有意分歧按分歧钉死**(如 U+200B 对 `incomingMsgIdsOf`/`collectRequestIds` 放行——二者均为纯证据角色,与严格钉入库的存量 id 不可能重叠,故安全),任何副本改规则必须让该测试通过或在那里显式重新钉并写明理由。「keep in sync」注释自此由 CI 背书。

已知一次性收敛:#5826 review 发现 `parseTailIds` 独缺保留前缀门(wire 解码侧),已在本次补齐——所有生产发射方本就预筛,此为单点收口的纵深防御,判决方向更保守(整表作废降级),零行为回归面。

## 5. 持久化单一事实源

统一存储 `messages.msg_id` 列是唯一 id 事实源:ingest 时把校验过的 id 钉进行(T5 裁定:无双平行 ledger、skeleton 行不携 id)。账本主键 `(session_id, msg_id, content_hash)`;canonical 行按 **MSGID 而非内容 hash** 键控(#4491);fork 克隆保号(#4316 L3 PR3/3 `cloneSessionRows`)。

## 6. 消费方(五个,id 各自回答什么问题)

| 消费方 | 位置 | 回答的问题 | id 使用边界 |
|---|---|---|---|
| ① 存储列身份 | unified store `messages.msg_id` | settle/reconcile 一切 join 的主键 | 唯一身份空间入口,其余四方的 id 证据最终都折到这里 |
| ② session-resolve 最后一档 #5719 | tryMsgIdRescue(src/session-resolve.ts ~:324;fork-exit 调用点 ~:432/:481/:501) | 字节/标签证据被压缩或 system 重写摧毁后,这条请求还是不是既有会话? | 同一 raw key 下**任意 id 重叠 ⇒ 认定同会话**;注意它不做 lane 归属判定(§7 边界 B) |
| ③ 结算 membership 探针 #4805 | probeRequestMembership(src/request-membership.ts;调用点 src/server/prepare-openai.ts:597、prepare-anthropic.ts:640;消费 cache-ledger.ts:1866) | 这个 id 是否已被本会话账本准入?needle = 最近准入 id | **纯证据,永不进身份空间**、永不 re-key/fork;误伤仅致一轮结算未决,自癒 |
| ④ 增量车道 canonical 行 #4491/#4834 | src/incremental-lane.ts(validateMsgIds :623、认领复用 400 :628、cache-control rekey :631-635;dsh 侧 burned-claim 预筛 ~:2584) | 本轮增量追加了哪些正史行? | 认领语义:已认领 id 再上行=重试风暴信号,整回合 400 |
| ⑤ 水位尾连续性 v2-v4 #5403/#5418 | PF_TAIL_IDS_HEADER(src/server/fastpath.ts:48) | 客户端 delta 窗口的起点还和服务端 seed 对齐吗? | v4 宽度自洽(len=T−K+1,服务端重验)时计数回声降为纯诊断;id 只证**窗口来源**,永不证前缀完整性(owner 裁定 2026-11-02;§7.4 盲点照旧,§7 边界 A) |

## 7. 信任边界(声明为契约的一部分,不是 bug)

- **A. §7.4 水位盲点**:元素数不变的前缀字节改写不可检测。人工评审闸,不得自动合并;多模态尾部入缓存后该历史永久降级 legacy。
- **B. #5719 最后一档无 lane 归属**:「任意 id 重叠 ⇒ 同会话」不区分主/辅 lane。若宿主把重叠 id 盖到 persona/review 派生请求上(宿主 id 空间复用或评审嵌入父回合 id),会被错认为主会话续写、且 record() 以该 fork 自身的 tag/model 覆写骨架。仓库内无法证实宿主是否会这么铸 id——**条件性风险**,处置待 owner 拍板(trace log 一行观测方案见 #5826 评论)。朴素 tag-equality 前置条件行不通:dsh 每轮换 system prompt,同 lane 相邻回合指纹就不同,加了会杀死救援本身。
- **C. membership needle 可穿透**:辅助请求嵌入父回合 id 时可令探针针落到旧行 → 该轮 settlement 未决(自癒:下一轮主尺度重发恢复)。证据-only 角色下最坏损失一轮,已接受。
- **D. 宿主铸造前提**:id 在会话范围内稳定且唯一、压缩后不复用。容器隔离:错配最多污染其所属 raw key 下的记录,不出 key。

## 8. 改动规则(改任何一处之前对照)

1. 新增/修改/删除任何拒绝类 → **全部严格族副本**(`validateMsgIds`、`incomingMsgIdsOf`*、dsh 双镜像、`screenMsgIds`、pf-channel 内联、`parseTailIds`)+ `tests/msgid-rule-parity.test.ts` 矩阵行,一步到位;(*`incomingMsgIdsOf`/`collectRequestIds` 的宽松是有意的,改动需 owner 级别理由。)
2. 新消费方先在 §6 登记一行再写代码。
3. 宿主 bundle 不得 import server 模块(§4 结构约束);新增镜像必须在 parity 测试中立项。
4. id 永远不进上游可见 body/header(剥除纪律,§3);pf-* 头维持协议头性质。
5. 讨论「id 失配/destroyed 误诊/断缓存」类问题先查 MESSAGE-IDENTITY.md 层级与本文 §6,确认该会话走的哪条消费路径。
