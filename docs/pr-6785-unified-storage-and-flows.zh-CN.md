# PR #6785 详尽梳理:统一存储的表结构 / 实现逻辑 / 数据流转 / 开关

> 范围:`2026-11-15_msgid-snapshot-unified` @ `39941c816`(base `origin/master` `b10c1a0d4`)。
> 134 文件 +13740/−367。本文是本 PR 的**审查级**完整梳理:四部分(表结构 / 实现逻辑 / 数据流转 / 开关)+ 实测验证 + 本轮发现与修复。行号均指 head 处源码。
> **第 2 轮(owner 裁定 7439-2,KDD #23,2026-11-22)已落在同一分支、晚于本快照**——op log 正史编号、窗口 re-anchor delta、messages 惰性投影与常驻性能门。见 **§6**(与本文件 §1.2 egress DDL 草图、§5.4 遗留项冲突处以 §6 为准)。


---

## 0. 这个 PR 到底是什么(一句话 + 五块)

把"出站视图每轮全量重算、入站每轮全量重去重"的两条 O(全量) 路径,改造成**以 msgid 为锚的稀疏增量结构**:出站建 op-log 物化表(7398 提案)、入站走水位 delta ingest(#3133 既有,本 PR 补 parse 层)、身份走增量 pin 通道(#7064 §8)、快路径走全量重发水位 + delta 尾切片(#5403/#5418 + 本 PR)。五块:

| 块 | 提案/来源 | 开关(默认) |
|---|---|---|
| ~~① 快照底座 v2~~(fold 日志 + egress_snapshot + scope-rev) | #5874 v2 / #7064 瘦身 | **本 PR 已退役**(bc51c9445,7439 裁定):平面从未上线——被 round-2 op log(`egress_state`/`egress_flow`,KDD #23)整体取代;stage-0 身份账本(L1 world / pf pin)保留,但 `storage.snapBase.*` 已从配置面**移除**——你配置里残留的 `snapBase` 键是死键(被忽略) |
| ② 出站 op-log(egress_state/egress_flow + 重建 serve + 服务端权威) | 讨论区 7398/7439 | `egressPlane`(0)——整条新链路的**唯一开关** |
| ③ 全量重发水位 + delta 尾切片 | #5403/#5418 + 本 PR | `pluginFullResendWatermark`(5)/ `pluginDeltaResend`(0) |
| ④ 增量 msgid pin(tail-ids 尾形态) | #7064 §8 | `pluginMsgIdIncremental`(**100**,本 PR 起默认开) |
| ⑤ 服务端正史 GA | #4491 | `pluginLaneServerHistory`(**100**,本 PR 从 0 翻到 100) |

---

## 1. 表结构(统一存储 SQLite,schema v12)

### 1.1 迁移机制(schema.ts)

- `STORAGE_SCHEMA_VERSION = 12`(schema.ts:105,本 PR 从 11 提到 12)。
- v12 **probe-first**(查表存在与否,不靠版本号门):因为兄弟分支 #5855 已把 pf 平面表当 "v12/v13" 落进过共享库(2026-11-08 现场:user_version 13 + 有 pf 表无 l1_world),版本门会让那些库跳过。
- 所有新表都是**追加式**:新构建打开旧文件 probe 后补齐;旧构建打开新文件忽略多余表。表还在,但会话那一行回不来原样——旧构建打开过的会话会变成什么样,见 §7.1。
- 每库打开时 pragma(auto_vacuum=INCREMENTAL 必须第一个):`journal_mode=WAL, synchronous=NORMAL, busy_timeout=5000, foreign_keys=ON, journal_size_limit=8MiB`。

### 1.2 本 PR 新增的 8 张表(DDL 均在 schema.ts)

**l1_world**(schema.ts:377-391,`SNAPBASE_DDL_V12`)—— stage-0 身份账本:宿主原始 session id → 代理账本身份 + 一轮武装 + 元素级世界游标 + R3 断路器。

```
sess_raw TEXT PRIMARY KEY,        -- 宿主写入的原始会话 id
ledger_id TEXT NOT NULL,          -- 解析出的账本 session_id
witness_probe TEXT NOT NULL,      -- 首见时的见证探针(身份证据)
issued_at INTEGER NOT NULL, armed_at INTEGER,
tail_json TEXT,   -- 上一轮宿主 id 数组的**尾 512**(JSON string[])
head_json TEXT,   -- 头 32
count INTEGER,    -- 数组全长
max_pos INTEGER,  -- append-only 位置前沿
r3_latched_at INTEGER  -- #6181 M3 持久 R3 断路器闩(NULL=未闩)
+ idx_l1_ledger ON l1_world(ledger_id)   -- 服务 deleteSession 按 ledger_id 删
```

(#7064 瘦身后的形态:原 `envelope_json` 整包已 DROP,降级为"尾 512/头 32 窗 + count + max_pos"——身份闸门→记账游标,中段不可见。)

**fold_journal**(schema.ts:413-427)—— append-only 折叠决策日志:

```
session_id TEXT NOT NULL, jseq INTEGER NOT NULL,
kind TEXT NOT NULL DEFAULT 'fold' CHECK (kind IN ('fold')),
block_id TEXT NOT NULL, start_seq INTEGER NOT NULL, end_seq INTEGER NOT NULL,
input_hash TEXT NOT NULL,   -- sha256 over messages[ start_seq..end_seq ](全代际,含 retired)
created_at INTEGER NOT NULL,
PRIMARY KEY (session_id, jseq),
UNIQUE (session_id, block_id)  -- 幂等重摄入;被替换的块保留第一条 fold 行
```

UNPIN **不存储**,读取时按三条件推导(块已非 active / 区间内有 live 行 / 区间内某 id 在 end_seq 之后重新 live)。`covered_ids` 列在 dev 期存在过,#7064 瘦身时由迁移 DROP(schema.ts:573-576)。

**egress_snapshot**(schema.ts:441-453)—— 切点物化的出站前缀**缓存**(最新行生效,旧行同事务裁剪):

```
session_id TEXT NOT NULL, snap_seq INTEGER NOT NULL,
watermark INTEGER NOT NULL,    -- 切割时 pin 集合的最大 live seq = hash 作用域
input_hash TEXT NOT NULL,      -- sha256 over LIVE 行 seq<=watermark
prefix_ref TEXT,               -- 派生前缀 JSON 的 CAS ref(NULL=仅 hash pin)
last_stable_id TEXT NOT NULL,  -- 缝合点尾部 msgid
created_at INTEGER NOT NULL,
scope_rev INTEGER,             -- 切割时 egress_scope_rev 的值(NULL=升级前行)
PRIMARY KEY (session_id, snap_seq)
```

(`ids_json` 已由迁移 DROP;`scope_rev` 为升级时 ADD。)

**egress_scope_rev**(schema.ts:459-464)—— 每会话消息变更修订号,O(1) 读端信任:

```
session_id TEXT PRIMARY KEY, rev INTEGER NOT NULL
```

凡能改 input_hash 的写(retire/unretire、content_hash 编辑、硬删、归档恢复、旧 seq 填洞)旁路 bump;纯尾部追加不 bump(seq 单调 ⇒ 在所有 watermark 之外)。

**orphan_blocks**(schema.ts:475-483,#6785 step 7)—— 收割块内容落表(原 `sessions.orphans_json` blob 拆出):

```
session_id TEXT NOT NULL, block_id TEXT NOT NULL,
one_json TEXT, full_json TEXT NOT NULL,
PRIMARY KEY (session_id, block_id)
```

**state_fields**(schema.ts:491-498,#6785 step 8)—— kstate 无限增长字段拆行:

```
session_id TEXT NOT NULL, field TEXT NOT NULL, value_json TEXT NOT NULL,
PRIMARY KEY (session_id, field)
```

字段集**冻结**在 slim.ts `ROW_BACKED_KSTATE_FIELDS`(9 个:tokenSnapshot, tsStamps, lastPassIds, hiddenOrphanRefs, sweptOrphanCallIds, renderDeferredRefs, viewLatches, absorbed, rules),`tests/issue5874-state-fields` 钉死。

**egress_state / egress_flow**(schema.ts:508-530,7398 提案)—— 出站会话 op-log,双表同构:

```
session_id TEXT NOT NULL, log_seq INTEGER NOT NULL,
row_type TEXT NOT NULL CHECK (row_type IN ('B','I','D','U')),
msgid TEXT,          -- B/D 为 NULL;I/U 必填
payload TEXT NOT NULL,
created_at INTEGER NOT NULL,
PRIMARY KEY (session_id, log_seq)
+ idx_egress_state_msgid(session_id, msgid)
+ idx_egress_flow_msgid (session_id, msgid)
```

- `egress_state` = serve 读 + 压实物理裁剪(水位以下删);
- `egress_flow` = append-only **永不删**(任意 log_seq 可重建,回滚以此表为据,不靠客户端重发)。#7574 起有变化(§7.3):压缩时这张表也一起裁——只留最新一条基线行及其之后的行。

行 payload 契约(egress-state.ts):
- `I`: `{"after": msgid|null, "ref", "tokens", "type", "content_hash", "role"?, "cas_ref"?}`
- `D`: `{"start": msgid, "end": msgid}`(闭区间,锚定 msgid 不是位置——"位置随其他 op 漂移,msgid 不会",KDD#11)
- `U`: `{"content_hash", "role"?, "cas_ref"?}`(msgid 列即目标)
- `B`: `{"entries": EgressViewRow[], "watermark": seq}`(条目 CAMEL 键 `contentHash/casRef`,与 I/U 的 snake 键不同)

`EgressViewRow` = `{msgid, ref, tokens, type, contentHash, role?, casRef?}`;`casRef` = 该消息**最终 core JSON**(reasoning 剥离/图片缩放后、出站转换前)在统一内容 CAS 的键。

### 1.3 既有表的关键列(与本报相关的)

- `messages` (schema.ts:181-195):PK (session_id, seq),UNIQUE (session_id, msg_id, content_hash),v8 加 `identity`(跨 save join 键)+ `retired_at`(墓碑,稳态不硬删),v10 加 `ts`。
- `content` CAS (schema.ts:173-179):`hash PK, byte_len, refcount, algo='sha256', bytes BLOB`——所有字节(消息、块摘要、媒体、CCR、egress 前缀、egress core JSON)共一个库,引用计数。
- `ccr_entries` (schema.ts:254-264):**本 PR 加 `orig_hash`**(+ 索引)—— byHash 半进 CAS。
- `conversations` (schema.ts:273-281):**本 PR 加 `idx_conversations_session(session_id)`**——stage-0 每轮按 session_id 反查绑定,PK 服务不了。
- `blocks`(197-214)、`dead_refs`(216-223)、`refs`(229-237)、`checkpoints`(239-252)、`session_ext`(291-298)、`kv_store`(303-310)、`message_media`(315-320)、`sessions`(148-171,`kstate_json/ccr_json` 语义被 slim 改变,DDL 未动)。

### 1.4 MySQL 对等(mysql.ts +274)

移植了:`orphan_blocks`、`state_fields`、`ccr_entries.orig_hash`(+ 索引、probe 迁移、归档/恢复/级联)。
**未移植**:`l1_world / fold_journal / egress_snapshot / egress_scope_rev / egress_state / egress_flow`——快照/egress 平面是 **SQLite 车道专属**(shadow.ts `egressOpLogSync()` 网络后端返回 null,录制器整轮跳过)。

---

## 2. 实现逻辑(按模块)

### 2.1 slim.ts(新,185 行)—— CCR 瘦身 + kstate 拆行

- `sessions.ccr_json` 只存瘦信封 `{version:1, ccrSlim:1, byRef:{key:{hash}}, orphanByHash?}`(slim.ts:20-48);`ccr_entries` 行存两半 CAS:`content_hash`=条目 JSON,`orig_hash`=条目背后原文。
- **null-orig 契约**:某行 `orig_hash=NULL` ⇒ 整个 store 回退文件车道(hydrate 返回 null,永不半份 byHash);`""`(空串 hash)=合法空原文(fork 回执 stub);byHash 缺条目必须落 null 不能落 `""`。
- kstate:`splitKstate` 把 9 个冻结字段从 `kstate_json` 拆到 `state_fields`(slim.ts:155-185);读端行覆盖列,写端变更 upsert、变 undefined 删行。
- 稳态 ingest 跳过判断升级为 `ord && content_hash && orig_hash` 三者全等。

### 2.2 snap.ts(新,493 行)—— stage-0 身份账本(只判身份,不压缩不供字节)

- `snapL1Record` → `hit|echo|arm|wait|issue|red`(snap.ts:80-114):新行 issue;`ledger_id` 不同 = **red 硬冲突,什么都不写**(R3 域,调用方留 legacy);armed+探针匹配 echo;armed+不匹配 hit;未 armed 匹配 → arm(一轮武装);其余 wait。
- 世界游标:`snapL1WindowRead/Upert`(snap.ts:138-165)读写 l1_world 的 tail/head/count/max_pos(窗宽 `WORLD_TAIL_K=512` / `WORLD_HEAD_K=32`,identity.ts:29/32)。
- R3 闩:`snapR3LatchWrite`(snap.ts:179-191)UPSERT 占位行(首次故障可先于任何 snapL1Record);闩住的会话永不重新武装。
- `foldInputHash`(snap.ts:252-268):对 `[start_seq,end_seq]` **全代际**(无 retired 过滤——折叠自己的 ingest 同事务 retire 覆盖行,live-only 聚合在折叠时刻是空的)逐行 `${seq}\u0000${msg_id}\u0000${content_hash}\n` sha256。
- `foldUnpins`(snap.ts:326-370):唯一的 UNPIN 谓词(三条件,见 §1.2)。
- egress 切读:`egressInputHash`(407-424,live-only,作用域=watermark)、`egressScopeRev`/`bumpEgressScopeRev`(430-450)、`egressLatestRow`(477-486)。

### 2.3 egress-state.ts(新,365 行)—— op-log 引擎(纯函数,可测)

- `diffEgressView`(153-204):骨架 = `next` 中 msgid 在 `prev` 里**升序出现**的最长子序列(双指针扫描);骨架行 contentHash 变 ⇒ `U`;prev 非骨架 ⇒ 按 prev 顺序发最大连续 `D` 段;next 非骨架 ⇒ 按 next 顺序发 `I`(锚 = 前行);**移动 = D+I,无 M op**;op 顺序 D→U→I;不变式 `replay(prev, diff(prev,next)) === next`。
- `nextLogSeq` 从 **flow** 取 MAX(state 被压实裁剪过,flow 是超集)。
- `egressStateAt(db, sid, x)`(264-274):flow 重放到 `log_seq <= x` = 任意历史点重建(回滚)。#7574 起(§7.3):只能重建最新基线行之后的点。
- `egressStateCompact`(278-292):重放结果写成一条 `B` 行(两表)+ 物理删 state 水位以下(flow 不动)。
- 任何锚点/端点/重复/畸形违例 ⇒ 抛 `EgressStateCorruptError`(36-42)⇒ 调用方**整会话降级 legacy**,永不模糊兜底。

### 2.4 egress-record.ts(新,102 行)—— 每轮录制(seg 3)

- `buildEgressViewRows`:首行 system(`msgid="system:"+hash32`,`casRef=CAS(系统文本)`,**字节稳定就是缓存锚点**);每消息一行,`contentHash=rowHash([id,role,contentType,text])`,`casRef=CAS(最终 core JSON)`(head commit `39941c816` 起工具行 sidecar(toolCallId/toolName)随 body 进 CAS,serve 不再排除工具行)。临时行(nudge、sysNotes)按设计排除(KDD#7)。
- `recordEgressTurn`:prev = 会话缓存或一次 hydrate;diff;有 op 才 append;**批内含 D(折叠形状)才压实**。
- 本轮修复:unchanged 行**复用** prev 的 `casRef` 不再重复 putContent(原来每轮每行 refcount +1,只增不减;唯一释放点在会话清扫——见 §5)。

### 2.5 egress-serve.ts(新,65 行)—— 从日志重建 + 真 swap(seg 4b)

`rebuildOutboundFromLog(view, store)`:跳过 system 行(系统块恒 live 构建,前缀缓存锚点纪律);缺 `casRef`(seg4 前行)或 CAS body 缺失 ⇒ 返回 null(**整轮**留 legacy);body 必须解析为含 id/role 的对象且 role 合法;然后走与 legacy **完全相同的**链 `hardenOpenaiAssistantContent(coreToOpenai(systemToUser(msgs)))` ⇒ 按构造字节一致。

### 2.6 入站:水位 delta ingest(#3133 既有,本 PR 未改内核)

- 决策点 `shadow.ts:679-703`(`ingestDelta`):`ingestWatermark`(sessions.last_ingested_seq + 持久 tailSeqs,store.ts:2329)→ 边界探针(:2403)→ #3919 头部 id 探针(:2418)→ `planIngestDelta` → `ingestSession(delta)`;任何一环 null/false ⇒ 精确全量路径。
- `planIngestDelta`(ingest.ts:311-405)返回 null 的形状:pluginSnapshot 非空 / decompositionLog(#3301 导入) / 无水位 / `tail.length===trustedLen && !hasRawTail`(等长尾只在 raw 谱系是合法空 delta,#2960 ⑤ 折叠重渲染可能乱序)/ **`tail.length < trustedLen`(线变短 = 折叠发生 ⇒ 全量)** / 尾部或头部探针不符。
- 新消息循环只序列化+hash **新**的(`O(N)`),占位 seq `watermark+1+i`。
- 店端守卫 `store.ts:1229-1281`(BEGIN IMMEDIATE 内):边界**事务内复验**(1231-1232);每条新消息按 `(session_id,msg_id,identity)` 探针,任一已有行 ⇒ 全量(1239-1247,#4390 identity 位置无关,retired 也算存在);重编号 `probe.maxSeq+1+i`(1253);tailSeqs 前缀一致性(1256-1268)。**陈旧/外部水位最多浪费一次冗余全量写,永不写错行。**

### 2.7 parse 层 parse-defer(本 PR 新增)

- `fastpath-scan.ts`:`scanMessagesSpans` 扫原始 body 提取 messages 元素 span(不 parse);`synthesizeTopLevel` 重建顶层对象,`messages: null` 作"延迟"标记(用 null 不是 `[]`——`Array.isArray([])=true` 会破 MISS 重 parse 路径,且 relay 守卫对 null 放行)。
- `handle.ts` 门:openai 形 + pf 协议戳 + body ≥ 1MiB ⇒ 走延迟;HIT 轮省掉整包 parse;MISS 才在 prepare-openai 一次性从文本重 parse。

### 2.8 快路径:水位 + delta 臂(fastpath.ts / handle.ts)

- **全量重发水位**(#5418,rollout 5%):响应盖 `x-bili-pf-seq`(messages 元素数,零分配结构扫描测出);客户端回带 `x-bili-pf-count` + `x-bili-pf-tail-ids`(宽度 `T − stampT + 1`,首格锚点,`?` 占位);命中 = 上一轮 canonical cores + 仅尾窗新解析(跳整包 parse/转换/钉存——#5403 OOM 生产者)。
- **delta 臂**(本 PR,`pluginDeltaResend` 0):客户端 body.messages **只发**新元素 L 个;服务端用钉存前缀核 + 小切片重建视图。任何不成立声明(count/body/尾宽不符、已知清单后锚链断、灰度关)⇒ 400 `pf_delta_reanchor` + `x-bili-msgid-mode: full`,客户端当轮改发全量形态——**一轮收敛,永不静默错解**;delta miss 绝不 fall through 到 legacy parse(把尾当全史 = 毁会话)。
- 失配语义(fastpath.ts:296-304):`stamp > T` = "ahead"(线缩了=发生过压缩)⇒ 清 mode 下轮全量重锚;`stamp === T` = "no-progress"。
- **bug A 修复**(b4bbaaef):HIT 头检查排除 id 字段——pin 之后账本行 msg_id 是宿主 UUID,而 fresh 侧是内容 hash id,逐格比对必假阴性。
- **bug B 修复**(2c3bdd10):HIT 轮快照渲染只出 ~2 行 ⇒ rawTail 短 ⇒ completeLog ⇒ sweep retire 全部前缀行 ⇒ 账本排空 ⇒ 每轮 pin 降级。修:命中即置 `session.lastMessagesFolded=true`。
- **bug C 修复**(9efbf8b7):HIT 轮账本新行带 h_ id 不带宿主 UUID(pin 行只覆盖窗口内)⇒ 尾宽永远差 1 ⇒ full/incremental 永久交替。修:命中轮用 `s0.pinned` 尾窗重盖 ledgerWindow 再 snapshotMessages。

### 2.9 增量 msgid pin(#7064 §8,默认 100)

稳态轮用有界 `x-bili-pf-tail-ids`(锚点+新增,≤2048 个,`?` 占位)或短 body id 数组申报;服务端**从账本 live 行重盖前缀**(ingest INSERT OR IGNORE on (session_id,seq)——位置上的 msg_id 只写一次)。接受规则(2026-11-19 定型):声明尾段 [T-L,T-1] 与账本重叠段**逐行相等**,任一行漂移 ⇒ 降级 full,永不 400;超长会话(>2048)截断尾清单同样可 pin(重叠段更长=证明更强)。快照轮(账本空/折叠后重锚)发全量;全量优先。响应盖 `x-bili-msgid-mode: incremental|full`(4xx 即清,与 pf-seq 同一学习点 pfLearnStamp)。失配一轮自愈。条目正常的短数组打在**空**账本上——增量客户端在服务端丢了账本之后(数据库恢复/重建、会话被删)的第一轮——照常处理(不 pin)并回 `full`,下一轮全量重建账本;只有条目本身坏掉的数组(空串/超长/保留前缀/空白控制字符/重复)仍然 400(#7574,owner 2026-11-23 改判;此前空账本上的任何短数组都 400)。

### 2.10 admin 面

新增回环路由 `GET /__bili/snapshot/r3-latches` / `POST /__bili/snapshot/r3-unlatch`(admin.ts +56)。

---

## 3. 数据流转逻辑(一轮请求的完整路径)

### 3.1 稳态轮(+N 条新消息,pf 命中)——两条增量都生效

```
客户端 POST /bili/http://<upstream>/chat/completions
  body: 全量 messages(水位全量臂)或 仅尾 L 条(delta 臂)
  + biliMsgIds(全量形态)或 x-bili-pf-tail-ids 尾形态
  + x-bili-pf-count / x-bili-pf-seq(若已学)
  → [handle] readBody(155MB 级)→ pf 协议扫描(fastpath-scan,零 parse)
  → [fastpath] HIT(戳前进+锚链对):跳整包 parse/转换/钉存
  → [prepare-openai] 重建视图 = 钉存前缀核 + 尾窗解析(delta 臂)
     ├─ egressPlane 开:recordEgressTurn(稀疏 I op,几 KB)
     │   → rebuildOutboundFromLog(op log + CAS)→ swap 进出站字节
     └─ 关:legacy 内核视图 → coreToOpenai 链
  → [ingest] shadow.ingestDelta:watermark+边界+头探针 → planIngestDelta
     只序列化/哈希新 N 条 → 行 append 到 watermark+1..(同事务写 watermark)
  → 出站:render-refs 标签 + nudge(每轮临时,不入表)→ 上游
  → 响应:x-bili-pf-seq(新 T)+ x-bili-msgid-mode: incremental
```

**每轮新增存储 = 新消息 CAS 字节 + 一条 I op(几 KB)。** 出站重建稳态 O(尾部)。

### 3.2 折叠轮(客户端线变短 / 服务端 fold 落账)

```
fold tx:blocks 插/更 + 覆盖行 retire(同事务)+ fold_journal 一行
  (input_hash=区间全代际聚合;egress_scope_rev 因 retire 而 bump)
→ 下一轮入站:wire 变短 ⇒ planIngestDelta null ⇒ 精确全量路径
  (解析全量 + INSERT OR IGNORE 去重 + retire 落账 + watermark 重设)
→ 出站:egress 视图出现 -D(区间)+ +I(摘要行)⇒ 批内含 D ⇒ 压实 B 行
  (B = 全量视图行列表,设计自认 ≈8MB @10w 行;CAS 字节不复制,只指针)
→ pf 协议:stamp>T "ahead" ⇒ 清 mode ⇒ 该轮发全量形态重锚 ⇒ 次轮回增量
```

**代价集中在折叠那一轮**(实测 ~0.5–0.8s),稳态轮回到 O(尾部)。这是设计内的节奏(折叠=重锚轮),不是 gap。

### 3.3 异常/降级路径(全部"整轮 legacy,不猜")

| 触发 | 动作 |
|---|---|
| pf 戳缺失/回退/锚链断 | 整轮全量解析+全量路径,重新盖戳 |
| delta 声明不成立 | 400 pf_delta_reanchor + msgid-mode: full(一轮收敛) |
| 尾形态 id 与账本重叠段任一行漂移 | 降级 full 信号,下轮重锚(D1 家族,永不 reject) |
| l1 red(ledger_id 冲突) | 不写任何东西,留 legacy,R3 域处置 |
| EgressStateCorruptError(15 类违例) | 该会话停止录制/serve,整轮 legacy |
| serve 重建缺 casRef/CAS body/未知 role | 整轮 legacy(4a 影子对拍继续度量) |
| 水位陈旧/外部写 | 事务内探针失败 ⇒ 精确全量路径,一次冗余写 |

### 3.4 生命周期(删除/归档级联)

`deleteSession`(store.ts:~2586):messages/media/blocks/**fold_journal/egress_snapshot/egress_scope_rev/orphan_blocks/state_fields** + dead_refs/refs/ccr_entries/conversations/session_ext/sessions + l1_world(按 ledger_id)+ CAS 释放与 scoped collect。
`archiveSession`:同上(除 l1_world),JSONL 导出**先于** COMMIT 追加,状态翻 archived。
**本轮修复**:两处都补了 `egress_state/egress_flow` 清扫(原漏删 ⇒ op-log 行永久孤儿,属"存储只增不减"p1 类;CAS 引用的 egress 半也一并释放,消息字节仍由 messages 行持有)。

---

## 4. 开关总账

### 4.1 rollout.features(src/rollout.ts;env `BILI_ROLLOUT_<KEY 大写下划线>`)

| 键 | 默认 | 本 PR 变化 | 作用 | 回滚 |
|---|---|---|---|---|
| `pluginLaneServerHistory` | **100** | 0→100(GA,owner 裁定 2026-11-13) | ⑤ 服务端正史:biliMsgIds pin 行身份 + /__bili/plugin/render + 增量车道通告 serverHistory | env=0 |
| `pluginMsgIdIncremental` | **100** | 新增即开 | ④ 尾形态 id 申报,账本重盖前缀 | env=0 |
| `pluginFullResendWatermark` | **100** | 5→100(GA,owner 裁定 2026-11-22) | ③ 水位快路径 | env=0 |
| `pluginDeltaResend` | 0 | 新增,关 | ③ delta 尾切片臂;0 = 对 delta 请求 400,客户端一轮收敛回全量 | 天生回滚态 |
| `egressPlane` | 0 | 新增,关 | ② 整条新链路一个开关:稀疏 op 记账(四车道)+ 日志回放 serve(字节一致 swap)+ pinned 插件车道服务端权威(裁定 7439-3/5);关 = legacy 链路零行、与特性前字节一致。取代已退役的 `egressOpLog`/`egressServeLog` 双键 | 天生回滚态 |

**无新增静态 env 变量、无新增 CLI flag**(rollout env 由键名动态派生,docs-coverage CI 对动态名双向豁免——这也是 `pluginMsgIdIncremental` 此前漏文档的根因,本轮已补 yaml 条目)。

### 4.2 配置对象

| 键 | 默认 | 作用 |
|---|---|---|
| ~~`storage.snapBase.*`~~ | — | **本 PR 已退役**(bc51c9445)——config.ts/knobs.ts 已移除;残留键被忽略 | `network.ingestBodyBytes` | 32MiB | 入站 body 上限(实测 155MB 场景需调 1GiB;env `BILI_INGEST_BODY_BYTES` 优先) |

### 4.3 响应头(协议面)

`x-bili-pf-seq`(bili→客户端,元素数戳)、`x-bili-msgid-mode: incremental|full`(4xx 即清)、`x-bili-pf-delta: 1`(客户端→bili,hop 头,转发上游前剥,headers.ts:40)、`x-bili-pf-tail-ids`(客户端→bili,≤8KB 预算,超预算省略头不抑制 body 全量形态)。

---

## 5. 实测验证(理想模型增量压测)与本轮修复

### 5.1 压测方法(perf/,2026-11-21)

构造 = 用户场景的 plugin 形态:客户端历史从 1 条增长(纯 append-only),fake 理想模型每 ~300 refs(≈5w token 增长)注入一次 compress 工具调用(折最旧段、保 1800 refs≈30w token 存活尾)——**客户端在宿主侧应用折叠**(plugin 语义:模型发起、客户端执行),因此线上 wire 恒定 = 存活视图(1800–2100 条,0.7–0.8MB 请求体,出站 200–253k token),`cum` 计累计产生量(到 10w)。臂:master(`b10c1a0d4`,无 pf)/ PR 全量臂 / PR delta 臂。三臂同 fake 校准、同 driver(node:http `connection: close`——bili 按 #1982 设计每轮后关连)。**注意:本批所有跑都是 egress 平面关闭态**(7398 臂未测,见 §5.4);155MB 原始 wire 形态(宿主不折叠的客户端)不在本批覆盖内。

### 5.2 实测(RUN1 batch=500 三臂跑满 210 轮;RUN2 batch=100 仅 PR 全量臂跑到 g943≈9.4w,master 臂因代理误杀中止,delta 臂未启动)

**RUN2,PR 全量臂,按累计规模**(wire 恒 ~720–840KB,出站 200–253k token,折叠每 ~3 轮):

| 累计产生 | 1w | 3w | 5w | 7w | 9w | 9.4w(非折叠轮) |
|---|---|---|---|---|---|---|
| PR 全量 | 526ms | 501ms | 1170ms | 1346ms | 1650–1737ms | 1821ms |

**RUN1 @ 10w 累计稳态段 10 轮**(wire 720KB,视图 1801 条,折叠已停):

| 臂 | 稳态范围 | 备注 |
|---|---|---|
| master 全量 | 1312–1624ms(p50 ~1338) | pf=null(无水位) |
| PR 全量 | 1613–2322ms(末轮 1613) | pf=1804,mode=incremental |
| PR delta(无效臂) | 1891–2849ms | 配置缺 `pluginDeltaResend` ⇒ x-bili-pf-delta 被忽略 = 全量+死头 |

**诚实结论**:
1. 视图形态 wire(~750KB)下,单轮耗时随**累计账本规模**线性上升(1w→0.5s,9.4w→1.8s),与 wire 大小无关——成本在 9.4w 条 messages 行 + 309 条 fold_journal 的入站 ingest/扫描域(slow-ingest 日志点名 #5744,WAL 33MB/次),不是本 PR 结构。
2. "整轮 <1s" 在 ≤3w 规模达成(501ms),5w 起越过(1170ms)。
3. 静态重放(comp1200k:781 条/1.2MB 视图,无账本累积)测得 delta 臂 32–62ms、全量 ~91ms——结构天花板(纯 wire 受限)远低于增长跑,差值 = 账本累积成本,是下一步 profiling 对象(见 §5.4)。
4. delta 臂在增长场景无有效数据(需带 `pluginDeltaResend:true` 的代理重跑)。

### 5.3 本轮发现与修复(小问题直接修,已随本报告提交)

1. **[p1 存储只增不减] deleteSession/archiveSession 漏删 egress_state/egress_flow** ⇒ op-log 行 + 其 CAS 引用永久孤儿。修:store.ts `deleteEgressOps` + 两处级联。
2. **[p1 存储只增不减] buildEgressViewRows 每轮对每条未变行重复 putContent**(CAS refcount 每轮每行 +1,无对应释放)⇒ 开了 egress 键的会话内容库无限膨胀。修:未变行复用 prev casRef(缺的补上,变的重新 put)。
3. **[文档] `docs/proposals/snapshot-compression-foundation/`** 描述已退役的 v1 四表平面(snap_rows/snap_log/snap_ckpt 合入前删除;标题还说 "DDL landed in #5901"),与现 v12 形态矛盾 ⇒ **整目录移除**。
4. **[文档] `docs/storage-relations.{en,zh}.svg`** 缺 5 张新表、fold_journal 卡片还写已删的 covered_ids、egress_snapshot 卡片还写 ids_json、⑦级联卡片不准确 ⇒ **移除**,由本报告接替。
5. **[文档] rollout.yaml 三处过时**:pluginLaneServerHistory 默认值 "0 (off)"(代码 100)、egressServeLog 描述 "seg 4a LOG ONLY never swaps"(4b 已真 swap)、缺 pluginMsgIdIncremental 条目 ⇒ 全部更正/补齐,重新生成 docs。
6. **[注释] rollout.ts egressServeLog 注释** "(AND egressOpLog is on)"+"tool rows in v1" 两处过时 ⇒ 更正。
7. **[开关] egress 双键合并为一个**(owner 裁定 2026-11-21):`egressOpLog` + `egressServeLog` 退役,由单一 `egressPlane` 灰度键取代——开 = 完整新链路(记账 + serve + 服务端权威,四车道),关 = legacy 链路与特性前字节一致。两个旧键从未发布(默认 0、天生回滚态),无需迁移。

### 5.4 留给后续(不在本 PR 范围)

- **egress 键开启态的最小验证**(待定):155MB 原始 wire(宿主不折叠)+ egressServeLog 真 serve ⇒ 出站 30w token 的完整场景,逐轮对"每轮新增存储几 K"红线(WAL diff)——这是 7398 验收线,本批未覆盖。
- 累计 5w+ 规模单轮 1.1–1.8s 的账本累积成本 profiling(slow-ingest #5744 域;含折叠轮 retire+重锚、fold_journal 309 行的折叠交叉门、kernel 扫描)。
- delta 臂在增长场景的有效重跑(带 `pluginDeltaResend:true`)。
- 压实 B 行 ≈8MB @10w 行 vs "每轮新增存储几 K" 红线:设计自认的例外(7398 §5);若要彻底守住红线,可把 B 行改成"区间引用+防伪指纹"(#7064 对 l1_world 的降级思路),代价是失去"状态表独立可重放"的封闭性——需 owner 裁定。
- 归档恢复后 egress op-log 从空重启(下一轮全量 +I 重建,正确但有一次全批)。

## 6. 第 2 轮——裁定 7439-2(KDD #23):op log 唯一正史、惰性投影、窗口 re-anchor(2026-11-22)

> 第 2 轮工作落在同一分支、晚于 §1–§5 快照。本节与前面章节冲突时,以本节为准。

### 6.1 R-A:正史消息编号(op_seq / log_seq)

- 两张 egress 表各带两个键:`op_seq`(PK,每表 append-only 行游标——恢复/截断键)与 `log_seq`(正史消息编号,**仅 I 行**;D/U/B 行为 NULL)。`log_seq` 会话内作用域、**永不重发**(kernel id 契约);每条 I 行的 `log_seq` = 该轮新增行在存活视图里的正史下标,记账时戳定——编号不再依赖位置、也不再依赖 messages 表。
- `recoverEgressBase` 有界(state 表被 compaction 物理裁剪);无行会话经新 B op 引导;有行但**无健康点**的 pinned 会话整轮**硬失败**(裁定 7439-5:500 + `x-bili-egress: unreadable` + `{type:'egress_flow_unreadable'}`,经 `EgressAuthorityRejectError`——车道 catch 不再吞掉;会话永不截断自己的坏行、永不从客户端字节重引导)。
- R-B:fork = `egressFork` 整表 op log 拷贝(self-fork 抛错;空父 no-op)。

### 6.2 B:事务内窗口 re-anchor delta(#7474——2s 地板的根因)

修复前增长会话延迟(10w 时 ON 臂 ep3 5697ms/轮)的根因:pf 水位车道每个 HIT 轮只持久化 ~56 元素尾窗(`lastMessagesFolded`),而 `planIngestDelta` 为严格追加轮设计——其等长/缩短/边界 id 门结构性拒绝滑动窗口 ⇒ 几乎**每轮**落入全量路径:`remapPlanToAbsolute` = SELECT **全部** ~10w 会话行 + identity→seq 映射重建 + 逐行字节修复。写从来不是成本;读是 O(总账本)。

修复:`planIngestReanchor` + `ingestSession` re-anchor 事务分支。每窗口行一次索引点查 `(session_id, msg_id, identity)`:已存在行**保持原 seq**(身份稳定性不变量;字节 hash + retired_at 校验),新行落在 `MAX(seq)+1`,#6947 ref 回填;`anchored === 0` 或存储 `tail_json` 不符 ⇒ 分支让位,全量路径原样执行。O(窗口) 点查 ≈ 毫秒;全量路径仍是通用兜底。

### 6.3 P2b/P2b-ext:egress-on 会话的 messages 投影惰性化(KDD #23)

对 `metadata.egressAuthority === true`(且 `egressPlane` 开)的会话:

- **不再逐轮统一 ingest**:`ingestRowsNow` 与防抖统一腿早退——这些会话的 `messages` 表降级为**惰性投影**(平面回滚 / web 读 / 副本恢复时一次性 O(n) 重建)。重启后的引导仍走 op log(`recoverEgressBase`),不走投影。
- **pin 通道读 op log**:KDD #21/#22 pin 账本(尾重叠 / 活 id 重盖)在 egress-on 会话上改从 `egress_flow` I 行(msgid + log_seq)解析,不经 messages 账本(`snapPinLiveIds` shim)。wire 不变。
- **信封在 bootstrap 冻结**(`d28d9ff3a`):不再逐轮读+写 15.5MB 的会话 JSON(kernel refs 永不裁剪——10w 时 messageRefs 10MB + tsStamps 5.5MB);冻结路由必须保持常驻字段不被裁剪(`9183ea817`,#4788 D2),否则 pinned 轮 502。
- **校验**:egress 探针(flow vs 客户端抽样)是 egress-on 会话唯一的漂移校验器——`BatchedViewVerification` 对它们关闭(`13b9baae2`):客户端 vs 正史那条腿只会量到已知的服务端赢分歧(裁定 7439-5),并把 drift 永远锁死。
- flow 损坏语义:硬失败,出站无投影兜底——flow 与 messages 同生共死(flow 独立性,裁定 7439-2 §2)。

### 6.4 修复后实测(10w 累计,折叠形态视图 ~1800–2100,稳态 8 轮,同机同 dist 成对)

| 跑 | 臂 | build | 稳态 p50 / max | 总时长 |
|---|---|---|---|---|
| ep3 | ON 修复前 | a33d02184 | 5697 / 6298 ms | 3273 s |
| ep5f | OFF 修复前 | a33d02184 | 2301 / 2946 ms | 1124 s |
| ep8d | OFF 修复后(B) | fb88bc2af | 1954 / 2735 ms | 1067 s |
| ep10 | ON 修复后 | fb88bc2af | 1327 / 1374 ms | 676 s |
| ep18 / ep20 | ON 合并后 | dbf4b140b | 730 / 761 · **638 / 655 ms** | 462 / 456 s |
| ep22 | OFF 合并后 | dbf4b140b | 2016 / 2957 ms | 1070 s |

**验收线「10w 累计 <1s」由 ON 臂达成(638ms p50,比修复前快 9×);ON 臂现在比同 build 的 OFF 臂更快。** ep20 DB:无 JSON 信封,egress-on 会话 messages 表 0 行,egress_flow 每轮 1 行,state 25 行有界,WAL 上限 8MiB(journal_size_limit)。OFF 臂地板(~2s)属修复前 #5744 家族(逐轮全量读+写膨胀的 JSON 信封 + 244MB DB fsync)——按单开关裁定不在本 PR 范围。ep14c 时代 2.2GB WAL 异常是 WAL 上限前的 build;上限后的 build 稳在 8MiB。

### 6.5 常驻性能门(裁定:e2e bench ×3,不超基线 +20%)

`tests/egress-bench.test.ts`(gate `ACP_TEST_EG_BENCH=1`;专属 CI 车道 `.github/workflows/ci-e2e-egbench.yml`,master 触发):hermetic 进程内代理(port 0、临时 XDG),3w 行增长的 pinned 会话(宿主侧折叠 + pf 水位通道),3 次中位稳态 p50/max 不超 `tests/e2e/bench/egress-bench.baseline.json`(校准值 201/300 ms;基线缺失时打印 CALIBRATION 并放行)。把单轮成本钉在 O(存活窗口):任何退回全表路径的回归会红。上面的 10w 增长矩阵留作深查参照;bench 是常驻守卫。

## 7. 评审之后的跟进(#7574)

本 PR 的评审(issue #7574)发现了落地内容里的几处缺口。之后改了什么,统一记在这里。上文引用的行号都指本 PR 落地时的代码。

### 7.1 回退到旧构建

「所有新表都是追加式」对表成立,对会话不成立。旧构建(本 PR 之前的任何版本)只认识 `sessions` 这一行——不认识 `ccr_entries`、`state_fields`、`orphan_blocks`。它运行期间:

- 工具输出、文件读取显示成 `{ hash }` 占位(`ccr_json` 列现在只存哈希,原文在 `ccr_entries` 后面);
- 已回收的块看不到(内容在 `orphan_blocks`);
- 搬到 `state_fields` 的 9 个状态字段缺失。

留下什么后果,取决于旧构建有没有**保存过**这个会话:

- **只读没存**(没在上面跑过一轮):磁盘上什么都没变——重新升级后会话是完整的。
- **至少保存过一次**(拿真实的上一个构建验证过):
  - 9 个状态字段从各自的行回来,已回收的块从它的表回来。旧构建自己写过非空值的那个字段以它的值为准(它加的规则还在;它删的规则还是删了);
  - 这个会话的工具输出、文件读取原文**永久丢失**。旧构建把只存哈希的列当成自己的内容库来读,保存时就把 `ccr_entries` 的行改写成它看到的 `{ hash }` 占位,并释放了原来的条目行——此后对话里的占位符到原文之间,任何地方都不再有链接(原文那些行本身还在内容表里,只是没人引用)。重新升级后,这个会话**不带内容库**加载。以前这是悄悄发生的;现在每次加载记一条 `warn`,写明原因。

留给 owner 决定(这里没有改):接受这个现状;或者让新构建把那份链接在旧构建不会改写的地方留一份副本(一张副表,每个条目存条目内容和原文哈希,约 150 字节);或者之后几个版本继续保留旧的整体 `ccr_json` 列。

### 7.2 带水位握手头的大请求

1 MiB 以上且带 `x-bili-pf-*` 头的请求,JSON 是延迟解码的(`messages` 先留占位)。以前只有插件通道和水位开关同时打开才会把占位补回真实内容;否则请求直接 `502 wireMessages is not iterable`,而且命中水位快速路径时,handle.ts 已经剥掉的顶层字段(`dsh_*` 等)会重新被转发给上游。现在请求体总会在转发前解码回来,转发的顶层字段和不走延迟解码的路径完全一致,键顺序也一致。

### 7.3 出站操作日志(egress)

- **谁以服务端日志为准——四条线一条规则。** 只有「插件通道 + msgid 钉住成功 + 不是旁路请求 + 开关打开」的轮次,会话才可以被服务端日志替换。其余轮次照常记录,但按原样下发。(之前:三条后置内核的线还会把未钉住的插件轮次、普通代理会话也当成以服务端为准;anthropic 线连标题请求也算。)
- **日志坏了。** 只有上面那些「以服务端为准」的会话才失败一轮(和以前一样是 500)。只做镜像的会话照常应答,每轮记一条日志。`GET /__bili/egress/latches` 列出失败的会话;`POST /__bili/egress/reset { sessionId }` 丢掉坏掉的日志,下一轮从客户端的对话重建。已经标记的会话不再每个请求都重扫一遍日志。
- **回退到最后一个健康点**(并删掉之后的行)只在日志确实无法重放时发生,而且只针对「以服务端为准」的会话。数据库忙/锁住/IO 错误原样抛出,不删任何东西。
- **同一会话两个请求。** 开始时基于旧日志的那个写入会被拒绝(`EgressConcurrentWriteError`),它的轮次照常下发、只是不记录。会把日志写坏的批次在写入之前就被拒绝。
- **压缩。** 带删除的轮次在同一次写入里完成压缩,而且两张表**一起**裁。`egress_flow` 不再是「只追加、永不删」:它保留最新一条基线行及其之后的行,`egressStateAt` 能重建最新基线之后的任意点。(之前:flow 保留所有行,每次折叠多存一份完整快照。)
- **服务副本**(`egress_state`)每次读取都和日志比对;副本坏了就从日志重新拷贝,日志有洞会被报出来。
- **非空视图上的 `after: null` 表示「新的第一行」**,两个重放一致。(之前:校验放第一、存储放最后,下一轮要付出一次删除+插入的重写。)
- **开关关闭** = 什么都不读操作日志,哪怕会话已经有日志:钉住的 id 从 `messages` 读,漂移检查关闭。

### 7.4 msgid

- msgid 校验失败的 400 也带 `x-bili-msgid-mode: full`,和增量重锚一致,客户端知道下一轮要发全量。
- **空**账本上收到格式正常的短 id 数组(客户端的数据库被恢复或重建过),不再让这一轮失败:照常处理、不钉住,响应要求下一轮发全量。只有条目本身坏掉的尾段才算身份故障。这推翻了 2026-11-18 的空账本例外(AGENTS.md 的 KDD #22)。
- pi 只在 OpenAI 这一种线上省略全量 `biliMsgIds`(只有这条线的服务端会读 `x-bili-pf-tail-ids` 头)。`/model` 切到 anthropic / responses 线的模型后,全量 id 列表重新随请求发出;以前这类请求完全没有 id,直到尾段超过字节上限。

### 7.5 迁移

迁移在两张 egress 表之间被打断的,下次启动会补完;从更早版本升级上来的库会补上 `conversations(session_id)` 索引(以前只有新版本新建的库才有)。
