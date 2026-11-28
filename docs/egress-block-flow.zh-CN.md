# Egress 块流/状态：块正史 + checkpoint 退役

> #7577（#7439 / #6785 后续）。新增两张表（`egress_block_flow`、`egress_block_state`），使块集合成为与消息视图（`egress_flow`/`egress_state`）平级的一等 op-log 公民。对 egress-on 会话退役 checkpoint（fork_base/replica/auto），改用点位 fork（4 表拷贝）。对 egress-on 会话裁剪 kstate 列（tsStamps/tokenSnapshot/lastPassIds 可从 flow 回放推导）。

## 表

| 表 | 角色 | 主键 |
|---|---|---|
| `egress_block_flow` | 追加式块正史（I/U/D 行） | `(session_id, op_seq)` |
| `egress_block_state` | 读副本：每块最新快照 | `(session_id, block_id)` |

**双时钟**（owner 裁定 2026-11-24——原“共享时钟”设计被否：折叠轮的块行在 SAVE 时落盘，晚于同轮的消息行，下一条消息会从“最后一条 flow 行 +2”处开始，导致每次 egress 读的 `op_seq === prevSeq + 1` 稠密校验全部报错）：

- 块表**自己发号**：`egress_block_flow.op_seq` 在表内稠密，从 `MAX(egress_block_flow) + 1` 发出。块表内部怎么压缩、变换、重编号都是自成体系，不碰 flow 的号池。
- `egress_flow` 保留**独占**号池与稠密不变量，零改动。
- 每条块行携带 **`flow_op_seq`**——指向 flow 时钟的指针：写入时刻 `egress_flow` 的 `MAX(op_seq)`（只增不减，故 `flow_op_seq <= X` 的行构成前缀）。点位 fork 在 flow 水位 `X` 处：拷贝 `op_seq <= X` 的 flow 行 + `flow_op_seq <= X` 的块行，消息视图与块集合在该时刻对齐。

### 行类型

| row_type | 含义 |
|---|---|
| `I` | 块诞生（一次折叠）。payload = 完整快照。 |
| `U` | 状态变更（被取代 / 内容修订）。payload = 完整快照（无 diff）。 |
| `D` | 块被收割——该行携带块的**终态全量快照**（`reaped: true`），同一事务内物理删除 `egress_block_state` 行（#7773）。退役的 `B` 压实基线行不再存在。 |

### 快照形状

```json
{
  "tier": 1,
  "startMsgid": "m00001",
  "startSeq": 1,
  "endMsgid": "m00005",
  "endSeq": 5,
  "supersedesBlockId": null,
  "active": true,
  "reaped": false,
  "one": "{\"text\":\"...\",\"count\":3}",
  "full": "{\"text\":\"...\",\"count\":5}"
}
```

自包含字节（D2）：两表中零 content-CAS 引用。

## kstate 边车

每个 I/U/D 行携带 `kstate_json` 列：写入时刻的有界残差快照（<2KB）。13 个残差字段：`viewLatches`、`emergencyTruncateLatch`、`absorbed`、`rules`、`nudge`、`stats`、`terminalStreak`、`nextRuleId`、`deadRefs`、`sweptOrphanCallIds`、`renderDeferredRefs`、`refLedgerAligned`、`timestampsHighWaterRefSeq`。`lastPassIds` 被排除（自愈字段）。

回放取水线之前（含）最后一个边车（否则用全新默认值）。

## Checkpoint 退役（D5）

对 egress-on 会话：
- `maybeCutForkBaseAsync` / `createReplica` 跳过（不建 fork_base/replica/auto 行）。
- Admin `POST /__bili/replicas` 对 egress-on 父会话走点 fork：`201 {ok, pointFork, sessionId, opSeq, restoredFrom}` —— 生成一个全新的独立子会话（父会话永不被改，子会话是快照而非活别名）。egress-off 父保留 checkpoint 行为；低于高水位的 `opSeq` 被拒绝（400），因为它需要点位重构物化器（后续项）。
- `persistForkSession` / `cloneSessionRows` 使用 `egressPointFork`（四张表 `egress_state`、`egress_flow`、`egress_block_state`、`egress_block_flow`）。水位是 **flow 时钟**（`egressStateMaxSeq`——双时钟下的参考时钟）。fork-to-now（`wm` >= flow 高水位）直接拷贝全部四表（SQL `INSERT…SELECT`）；真点位 fork（`wm` < flow 高水位）按 `op_seq <= wm` 拷 flow 行、按 `flow_op_seq <= wm` 拷块行，再回放重建状态副本（直接按块表自己的 op_seq 过滤会把两个无关时钟对齐）。

## kstate 裁剪（D4）

对 egress-on 会话，`tsStamps`、`tokenSnapshot`、`lastPassIds` 从 `sessions.kstate_json` 列中排除（可从 egress 日志推导）。legacy 路径字节级不变。

加载时，store 为「列里无值」的 egress-on 会话重新推导 `tsStamps`：每个 I 行的 `msgid` 就是内核 raw id（`tsStamps` 的键），其 `ts` 是首见墙钟。已持久化的值永远优先 —— 推导只补裁剪留下的缺口。

## 门控

全部在 `egressPlane` 主开关下。零新增配置项。egress 双表从未发布（dev-DB DROP-recreate 先例）；块表遵循同一模式。已发布的表（`blocks`、`orphan_blocks`、`checkpoints`）只做停写 + 读路径切换（不 DROP；物理 DROP 是后续工作，需版本 bump + 100% 灰度）。
