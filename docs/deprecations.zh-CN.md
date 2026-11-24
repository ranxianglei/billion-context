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
| msgid 三件套:`pluginLaneServerHistory` / `pluginMsgIdIncremental` / `pluginFullResendWatermark` | **GA**(缺省 100);条目保留作退出 | 硬编码开的行为 | 本 PR 的 egressPlane GA + 至少一个版本期间这三个条目零事故回滚 → 删注册表条目(硬编码开) | #7064 §8、#5469;GA 翻转在本 PR |
| D-lane `snapshotRender` | **尚未 GA**(缺省 0)。服务*未 arm* 的插件会话;egress-on 轮次按构造绕过它(`snapshot-render.ts:529`) | egress op log(等每个插件会话都能 arm) | 全部满足才算:D-lane 才会对插件轮次不可达、才可退役——egressPlane 全量稳定 · 所有盖章宿主默认 pin · side 请求例外关闭。**不属于本次 GA。** | #3756 vs 讨论 #7439 |
| 注册表键 `egressOpLog` / `egressServeLog` | **已退役键**(设了只告警) | `egressPlane` | 无(条目已删;告警留到市面配置文件确认干净) | #7439 系列 |

## 为什么"保留条目"是 GA 的默认形态

注册表条目很便宜,而且是线上事故时**唯一的一行回滚**。#6785 的 watermark GA 把 `percent` 提到 100 后,条目留了好几个月等全量消化。删除按上表门槛列规划——没有人会删掉一个仍是活面唯一回滚面的开关。

## 不进这张表的(别排期)

- `storage.unified`——基座;SQLite 车道是生产存储期间永不退役。
- `pluginIncrementalTurns`——客户端自选线路协议,不是 rollout;按 agent 逐个开。
- 非 egress 的 legacy 路径(checkpoint fork、l1 游标重同步、全量重推导渲染)——它们是降级目标和 legacy 存储格式;只有整个 legacy 格式退役它们才退役,超出当前范围。
