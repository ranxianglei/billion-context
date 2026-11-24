# egress 平面(egressPlane)—— 专项文档

> #7439 系列的终态:egress-on 会话的出站对话 **op log 是唯一权威**。本页是单一入口——它干什么、由哪些开关控制、开关之间怎么依赖、表结构、操作手册、PR/提案时间线。英文: [egress-plane.md](./egress-plane.md)。退役面清单见 [deprecations.md](./deprecations.md);存储模块页: [architecture/storage.md](./architecture/storage.md)。

## 它是什么

对 **egress-on** 会话,bili 把每一轮的出站对话视图记成稀疏 op log(I/D/U 行,消息字节随行走行、自包含、无内容 CAS,裁定 7439-1),出站核心消息部分**直接从日志回供**,按构造字节一致。带 pin 的插件车道进一步取**服务端权威**:kernel 输入从 flow 回放(裁定 7439-3/5)。旧的"从客户端字节重新推导"链路保留为降级目标,不再是事实源。

由此定义架构的推论(KDD #23):

- **`egress_flow` 的 I 行是消息唯一正史**(msgid + 永不重发的 `log_seq`);`messages` 表降级为**惰性投影**,回滚/web 读/恢复时一次性重建。
- 会话 JSON 信封**在 bootstrap 时冻结**(index-only 落盘);`kstate` 裁到残差字段清单(可派生字段全部剔除)。
- `tsStamps`/token 统计改为**加载时从 flow 回放派生**,不再持久化。
- 身份(stage-0)对 egress-on 会话是**无状态**的——从 op log 前沿现算,不需要 `l1_world` 游标(#7617)。

## 开关家族与依赖关系

| 开关 | 缺省 | 在 egress 家族里的角色 |
|---|---|---|
| `rollout.features.egressPlane` | **100(开,GA 2026-11-24)** | **总开关**。对符合条件的会话 arm 平面。退出:`false`/百分比 / `BILI_ROLLOUT_EGRESS_PLANE=0`。 |
| `storage.unified`(full/shadow) | — | **前置。** 仅 SQLite 车道;op log 在 unified store 里(`store.egressOpLogStore()`)。没有 unified store ⇒ 平面无处可写,保持空转。 |
| `pluginLaneServerHistory` | 100(GA) | **pin**:服务端历史 + msgid 身份。没有 pin,`egressAuthority` 永不 arm——平面静默空转。 |
| `pluginMsgIdIncremental` | 100(GA) | pin 通道的稳态尾部形态(依赖 `pluginLaneServerHistory`)。 |
| `pluginFullResendWatermark` | 100(GA) | 同族快路径优化(跳过重新解析已校验一致的前缀)。 |
| `snapshotRender`(D-lane) | 0 | **不是 egress**。服务*未 arm* 的插件会话。egress-on 轮次按构造绕过它(`src/server/snapshot-render.ts:529`: `if (deps.pluginMode) return clientMsgs`)——已 arm 的插件会话从 op log 回供。 |
| `pluginIncrementalTurns` | 0 | 完全不是 egress——客户端自选的线路协议(#3248)。 |

**arm 规则**(`src/server/egress-lane-io.ts`,`egressAuthorityArmed`):`featureEnabled("egressPlane") && pluginMode && pinned && !sideRequest` —— 四条线路车道一个规则;side 请求(标题生成、压缩、小预算)永不触碰日志。

**静默半态是写进文档的,不是藏着掖着**:`egressPlane` 开但 `pluginLaneServerHistory` 关时,没有会话 arm,什么都不发生(无行、无日志)——平面空转。上表四个 msgid 族开关缺省都是 100,所以这种半态只能由运维显式退出造成。开关删除(硬编码开)在退役登记里,以 GA 稳定为前提([deprecations.md](./deprecations.md))。

## 表(SQLite,`src/storage/schema.ts`)

| 表 | 角色 | 要点 |
|---|---|---|
| `egress_flow` | 只追加消息 op log(I/D/U/B 行) | PK `(session_id, op_seq)`,**表内连续**(#7574 不变量;恢复 = 回退到最新健康基,`recoverEgressBase`)。I 行携带 `log_seq`——规范、永不重发的消息编号。 |
| `egress_state` | 活视图的读副本 | `(session_id, log_seq)`;由压缩(B 基)限界。 |
| `egress_block_flow` | 只追加**块**历史(I/U/B 行)—— #7581 | **自己的编号池**(双时钟,owner 裁定 2026-11-24);每行携带 `flow_op_seq` = 写入时刻 flow 的 `MAX(op_seq)`(指针,单调不减 ⇒ `flow_op_seq <= X` 是前缀)。 |
| `egress_block_state` | 每块最新快照 | `(session_id, block_id)`;同一指针。 |
| `sessions.r3_latched_at` | R3 身份故障 latch 载体(#7617) | NULL/0 = 未 latch。双载体读(`??` 回退旧 `l1_world` 列)、双载体清(两者都清),哪个二进制 latch 的都能用;旧载体的物理 DROP 在退役登记里。 |
| `conversations` | 宿主身份认领表 | egress-on 会话不再需要它(身份无状态化);物理 DROP 在退役登记里。 |

完整 DDL + 行/载荷形态:[egress-block-flow.md](./egress-block-flow.md)(块表)与 [#6785 文档 §6](../pr-6785-unified-storage-and-flows.md#6-round-2)(flow/state)。

## 操作手册

- **开关在哪读(解析优先级):** 环境变量 `BILI_ROLLOUT_EGRESS_PLANE`(`"0"`/`"false"` = 关,其他值 = 开)→ 配置文件 `$XDG_CONFIG_HOME/billion-context/billion-context.json`(默认 `~/.config/billion-context/billion-context.json`),键 `rollout.features.egressPlane`(`true`/`false`,或 `{ "percent": n }` 灰度)→ 代码缺省(`src/rollout.ts`):GA 翻转落地前 0 = 关,落地后 100 = 开。要开只需这一处——前置是 `storage.unified`,标准安装已经设好。
- **整平面退出:** `BILI_ROLLOUT_EGRESS_PLANE=0`(env 优先于 config)或 `"rollout": {"features": {"egressPlane": false}}`。效果:新轮次回到 legacy 链路;已有 egress 行保留(惰性投影重建仍读它们)。
- **降级行为(无需干预):** 任何不可重建行、损坏日志点、探针失败,只让**该轮**降级到 legacy 链路——绝不部分替换、绝不客户端当权威。**任何健康点都没有**时该轮大声硬失败(裁定 7439-5)。
- **点式 fork:** `POST /__bili/replicas`(201 = 点式 fork 已建 / 503 = 不在驻留集 / 400 = 点在最新基之下——基下点被拒,直到点重建物化器跟进落地)。fork-to-now 逐字复制四张表;真正的点式 fork 按 `flow_op_seq <= wm` 过滤块行。
- **R3 latch 卡住:** 查 `SELECT r3_latched_at FROM sessions WHERE session_id = ?`(旧二进制回退查 `l1_world.r3_latched_at`);清除走 store 的 clear 路径,**两个载体都清**。
- **GC / 归档:** egress-on 会话**整体排除**在按龄 GC 之外,手动归档(`bili sessions archive`)被**拒绝**——归档格式还装不下 op log(跟进项;在此之前归档 egress-on 会话会把它的内容困死)。
- **诊断:** `/__bili/status` 显示存储状态;恢复事件(截断基、降级轮)在代理日志里是响的。

## PR / 提案时间线

| 时间 | 内容 |
|---|---|
| 讨论 [#7439](https://github.com/ranxianglei/billion-context/discussions/7439) | 系列起源;五条 owner 裁定(自包含行;块表读写侧;服务端权威 + flow 回放;块表对齐;无健康点硬失败)。 |
| KDD #23(#7474/#7475,2026-11-22) | op log = 唯一正史,`messages` 惰性投影,re-anchor delta。 |
| #7574 | op log 完整性:事务内序号读取、`recoverEgressBase` 回退、并发写者拒绝。 |
| 讨论 [#7577](https://github.com/ranxianglei/billion-context/discussions/7577) / #7581(已合) | `egress_block_flow`/`egress_block_state`(双时钟)、checkpoint 退役 → 点式 fork、kstate 裁剪。 |
| 讨论 [#7591](https://github.com/ranxianglei/billion-context/discussions/7591) / #7617(已合) | 身份收拢:无状态 stage-0、R3 latch → `sessions`、conversations 对 egress-on 退役、GC/手动归档护栏。 |
| **本 PR(GA,2026-11-24)** | `egressPlane` 缺省 0 → 100。每次 CI 都在全量跑平面;上面的退出项就是回滚面。 |

**开放跟进项**(有跟踪,不阻塞 GA):点重建物化器(最新基之下的 fork 点);归档格式获得 op log(在此之前 egress-on 归档被拒);`egressBlockCompact`/`Replay` 还没有生产调用方(块日志压缩);退役身份载体的物理 DROP 批次。
