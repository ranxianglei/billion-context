# 退役登记(deprecations)

> billion-context 里所有**已退役或按表退役**的面的单一清单:被什么替代、何时、最后一步(删开关 / 物理 DROP)的**确切门槛条件**。英文: [deprecations.md](./deprecations.md)。相关: [egress-plane.md](./egress-plane.zh-CN.md)。

纪律:一个面在**改成默认关之前**就进这张表,并一直留到物理移除落地。本仓库里"GA"= "缺省提到 100、条目保留作回滚面"(#6785 watermark 先例);**删条目 / 删表**是单独的后续步骤,有自己的门槛。

| 面 | 状态 | 被什么替代 | 最后移除的门槛 | 出处 |
|---|---|---|---|---|
| egress-on 会话的 checkpoint / replica fork(`fork_base`、自动 replica) | **已退役**(点式 fork:flow 水位处 4 表复制) | `egressPointFork` / `forkEgressSnapshot`;`POST /__bili/replicas` 201/503/400 契约 | egress-on 侧无遗留;非 egress 的 checkpoint 路径不动 | #7581(讨论 #7577) |
| egress-on 会话 kstate 里的 `tsStamps` / `tokenSnapshot` / `lastPassIds` | **已退役**(落盘时从 `sessions.kstate_json` 裁掉) | 加载时从 flow 回放派生(`shadow.ts`) | egress-on 侧无遗留;legacy 会话字节不变 | #7581 |
| `compress-at-fold-point` kernel 模式 | **早已退役** | fold = op log 里 D×n + I(摘要);kernel 不再原地截断 | —(已移除) | #7439 系列 |
| **l1_world 占位行**(R3 latch 载体、身份游标) | **已降级**:egress-on 会话不再用载体(改用 `sessions.r3_latched_at`),stage-0 无状态(无游标) | `sessions.r3_latched_at` + op log 前沿(`MAX(op_seq)` / `egressMessageHighWater`) | 全量到 egressPlane GA + 一个稳定版本期间双载体回读零触发 → 物理 DROP 批次(先列后表) | #7617(讨论 #7591) |
| **conversations** 宿主身份认领表 | 对 egress-on **已降级**(身份无状态化,无需认领) | flow 的服务端身份 | 与 l1_world 同批(一次 DDL 迁移) | #7617 |
| **refs** 表——egress-on 会话的**写路径** | 对 egress-on **停写**(arm 时一次性回填后,op log 覆盖全部历史,egress-on 落盘不再写 refs 行) | 引用号 = op log 的 `log_seq`;加载时从 flow 视图推导 refs([egress-plane.zh-CN.md](./egress-plane.zh-CN.md) §10) | 读方对回填前/legacy 会话的回退保留到物理 DROP 批次——最终移除在该批次内,门槛同 l1_world/conversations | 重编号设计,2026-11-25(#7691) |
| **session_ext** `inc:system` 粘性副本(增量车道的原始系统提示词) | 对 egress-on **退役**(客户端原文 `A` 改存 `egress_state` 固定 `egress-system` msgid、编号 0 的一行,变化发 U 更新) | egress system 行的输入形态([egress-plane.zh-CN.md](./egress-plane.zh-CN.md) §10);车道对 egress-on 会话从 egress state 读 `A`,legacy 继续用 ext | legacy(关平面)会话继续用 ext;列本身属于通用 session_ext 存储——只有 `inc:system` 键的 egress-on 写入停止 | 重编号设计,2026-11-25(#7691) |
| msgid 三件套:`pluginLaneServerHistory` / `pluginMsgIdIncremental` / `pluginFullResendWatermark` | **GA**(缺省 100);条目保留作退出 | 硬编码开的行为 | egressPlane GA（默认翻 100，待 owner 决定）+ 至少一个版本期间这三个条目零事故回滚 → 删注册表条目(硬编码开) | #7064 §8、#5469;默认翻 100 待 owner 决定 |
| D-lane `snapshotRender` | **尚未 GA**(缺省 0)。服务*未 arm* 的插件会话;egress-on 轮次按构造绕过它(`snapshot-render.ts:529`) | egress op log(等每个插件会话都能 arm) | 全部满足才算:D-lane 才会对插件轮次不可达、才可退役——egressPlane 全量稳定 · 所有盖章宿主默认 pin · side 请求例外关闭。**不属于本 PR。** | #3756 vs 讨论 #7439 |
| 注册表键 `egressOpLog` / `egressServeLog` | **已退役键**(设了只告警) | `egressPlane` | 无(条目已删;告警留到市面配置文件确认干净) | #7439 系列 |
| **session-order\|v1** kv 行(会话排序台账) | **写方已退役**——写方(`src/order-persist.ts`)已从 master 消失;市面那 640 KB 孤儿 blob 再也不会被改写,且 eg 模式全新库不会创建它(R2 表门) | 无(写方已消失;该行是惰性孤儿) | 无——该行惰性;不排物理移除(eg 模式全新库干脆不物化它) | #7735 R6(讨论 #7735) |
| **plugin-conversations** 持久化(kv + legacy 文件)**对 eg 模式实例** | **eg 模式退役**——内存表(K4)在进程生命周期内仍是权威;身份行(R1)+ egress op log 是持久记录 | `sessions` 身份行(R1)+ egress op log | eg 模式实例侧无遗留;非 eg 实例照旧持久化 | #7735 R4 |
| **prefix-affinity** 显式客户端链(`prefix-affinity\|v1`)**对 eg 模式实例** | **eg 模式退役**——匿名分支(K3)继续写;那 1.88 MB blob 是市面最大的活跃 kv 行 | egress op log 是已识别客户端的持久记录 | eg 模式实例侧无遗留;非 eg 实例照旧写入 | #7735 R5 |
| **kv_store 大值策略**(256 字符上限,R7) | **新写门**——序列化 kv 值超 256 字符即抛错(不截断),除非在白名单(`prefix-affinity\|v1`、`plugin-conversations\|table`) | 大 payload 走 content CAS / egress op log | 无——上限是写门,不是退役;两个白名单条目随 R4/R5 退役 | #7735 R7 |
| **l1_world arm 轮死行**(egress-on 会话的 stage-0 身份台账行) | **自动清理**(R3)——身份行缝(R1)在同一事务、同一轮 DELETE 掉死行 | `sessions` 身份行(R1) | 无——清理是逐轮 DDL,不是移除;l1_world 表本身对非 eg 会话保留 | #7735 R3 |

## 为什么"保留条目"是 GA 的默认形态

注册表条目很便宜,而且是线上事故时**唯一的一行回滚**。#6785 的 watermark GA 把 `percent` 提到 100 后,条目留了好几个月等全量消化。删除按上表门槛列规划——没有人会删掉一个仍是活面唯一回滚面的开关。

## 不进这张表的(别排期)

- `storage.unified`——基座;SQLite 车道是生产存储期间永不退役。
- `pluginIncrementalTurns`——客户端自选线路协议,不是 rollout;按 agent 逐个开。
- 非 egress 的 legacy 路径(checkpoint fork、l1 游标重同步、全量重推导渲染)——它们是降级目标和 legacy 存储格式;只有整个 legacy 格式退役它们才退役,超出当前范围。
