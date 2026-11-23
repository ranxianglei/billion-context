# Egress block flow/state: block canonical history + checkpoint retirement

> #7579 (follow-up to #7439 / #6785). Adds two new tables (`egress_block_flow`, `egress_block_state`) that make the block set a first-class op-log citizen alongside the message view (`egress_flow`/`egress_state`). Retires checkpoints (fork_base/replica/auto) for egress-on sessions in favor of point-fork (4-table copy). Trims the kstate column for egress-on sessions (tsStamps/tokenSnapshot/lastPassIds derivable from flow replay).

## Tables

| Table | Role | PK |
|---|---|---|
| `egress_block_flow` | Append-only block canonical history (I/U/B rows) | `(session_id, op_seq)` |
| `egress_block_state` | Read replica: latest snapshot per block | `(session_id, block_id)` |

Both tables share the **same op_seq clock** as `egress_flow` (one turn writes both logs; `blockNextSeq` = MAX over `egress_flow` + `egress_block_flow`).

### Row types

| row_type | Meaning |
|---|---|
| `I` | Block born (one fold). Payload = full snapshot. |
| `U` | State change (superseded / reaped / content revision). Payload = full snapshot (no diff). |
| `B` | Compaction base. Payload = `{entries: [{blockId, snapshot}], watermark}`. |

### Snapshot shape

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

Self-contained bytes (D2): zero content-CAS refs in both tables.

## kstate sidecar

Every I/U/B row carries a `kstate_json` column: the bounded residual snapshot at write time (<2KB). The 13 residual fields: `viewLatches`, `emergencyTruncateLatch`, `absorbed`, `rules`, `nudge`, `stats`, `terminalStreak`, `nextRuleId`, `deadRefs`, `sweptOrphanCallIds`, `renderDeferredRefs`, `refLedgerAligned`, `timestampsHighWaterRefSeq`. `lastPassIds` is excluded (self-heal field).

Replay takes the last sidecar at or before the watermark (else fresh default).

## Checkpoint retirement (D5)

For egress-on sessions:
- `maybeCutForkBaseAsync` / `createReplica` skip (no fork_base/replica/auto rows).
- Admin `/__bili/replicas` returns 400.
- `persistForkSession` / `cloneSessionRows` use `egressPointFork` (4-table copy: `egress_state`, `egress_flow`, `egress_block_state`, `egress_block_flow` WHERE `op_seq <= wm`).
- The state replicas are rebuilt by replaying the flow tables (a direct copy filtered by op_seq would miss blocks whose latest row is past wm).

## kstate trim (D4)

For egress-on sessions, `tsStamps`, `tokenSnapshot`, and `lastPassIds` are excluded from the `sessions.kstate_json` column (derivable from flow replay). The legacy path is byte-identical.

## Gating

Everything is under the `egressPlane` master switch. Zero new config items. The egress dual tables were never shipped (dev-DB DROP-recreate precedent); the block tables follow the same pattern. The shipped tables (`blocks`, `orphan_blocks`, `checkpoints`) get write-stop + read-path switch only (no DROP; physical DROP is a follow-up with version bump + 100% rollout).
