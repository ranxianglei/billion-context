# Egress block flow/state: block canonical history + checkpoint retirement

> #7577 (follow-up to #7439 / #6785). Adds two new tables (`egress_block_flow`, `egress_block_state`) that make the block set a first-class op-log citizen alongside the message view (`egress_flow`/`egress_state`). Retires checkpoints (fork_base/replica/auto) for egress-on sessions in favor of point-fork (4-table copy). Trims the kstate column for egress-on sessions (tsStamps/tokenSnapshot/lastPassIds derivable from flow replay).

## Tables

| Table | Role | PK |
|---|---|---|
| `egress_block_flow` | Append-only block canonical history (I/U/B rows) | `(session_id, op_seq)` |
| `egress_block_state` | Read replica: latest snapshot per block | `(session_id, block_id)` |

**Dual clocks** (owner ruling 2026-11-24 — the original shared-clock design was
rejected because it broke `egress_flow`'s density invariant: a fold's block rows
land at SAVE time, after the same turn's message rows, so the next message append
would start two op_seqs past the last flow row and every egress read's
`op_seq === prevSeq + 1` check would throw):

- The block tables number **themselves**: `egress_block_flow.op_seq` is dense
  within its own table, issued from `MAX(egress_block_flow) + 1`. What the
  block table does internally (compress, transform, renumber) is
  self-contained; it never touches the flow number pool.
- `egress_flow` keeps its **exclusive** number pool and its density invariant,
  untouched.
- Every block row carries **`flow_op_seq`** — a pointer to the flow clock:
  `egress_flow`'s `MAX(op_seq)` at the moment the row was written (it never
  decreases, so the rows with `flow_op_seq <= X` form a prefix). A point fork
  at flow watermark `X` copies flow rows with `op_seq <= X` and block rows
  with `flow_op_seq <= X`, aligning the message view with the block set at
  that moment.

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
- Admin `POST /__bili/replicas` takes the point-fork path for an egress-on parent: `201 {ok, pointFork, sessionId, opSeq, restoredFrom}` — a fresh, independent child session (the parent is never mutated, and the child is a snapshot, not a live alias). Egress-off parents keep the checkpoint behavior; a below-high-water `opSeq` is rejected (400) because it needs the point-reconstruction materializer (follow-up).
- `persistForkSession` / `cloneSessionRows` use `egressPointFork` (the four tables `egress_state`, `egress_flow`, `egress_block_state`, `egress_block_flow`). The watermark is the **flow clock** (`egressStateMaxSeq` — the reference clock under dual clocks). Fork-to-now (`wm` >= flow high water) copies all four directly (SQL `INSERT…SELECT`); a true point fork (`wm` < flow high water) copies flow rows filtered by `op_seq <= wm` and block rows filtered by `flow_op_seq <= wm`, then rebuilds the state replicas by replaying those rows (a direct copy filtered by the block clock would align two unrelated clocks).

## kstate trim (D4)

For egress-on sessions, `tsStamps`, `tokenSnapshot`, and `lastPassIds` are excluded from the `sessions.kstate_json` column (derivable from the egress log). The legacy path is byte-identical.

On load, the store re-derives `tsStamps` for an egress-on session whose column has no value: each I row's `msgid` is the kernel raw id (the `tsStamps` key) and its `ts` is the first-seen wall clock. A persisted value always wins — the derive only fills the gap the trim left.

## Gating

Everything is under the `egressPlane` master switch. Zero new config items. The egress dual tables were never shipped (dev-DB DROP-recreate precedent); the block tables follow the same pattern. The shipped tables (`blocks`, `orphan_blocks`, `checkpoints`) get write-stop + read-path switch only (no DROP; physical DROP is a follow-up with version bump + 100% rollout).
