# Retirement register (deprecations)

> One table for every surface in billion-context that is retired or on a scheduled retirement — what replaced it, when, and the **exact condition** that gates the final step (flag removal / physical DROP). 中文: [deprecations.zh-CN.md](./deprecations.zh-CN.md). Related: [egress-plane.md](./egress-plane.md).

Discipline: a surface is listed here **before** it goes default-off, and stays here until the physical removal lands. "GA" in this repo means "bump the default to 100 and keep the entry as the rollback surface" (the #6785 watermark precedent); **removing** the entry / the table is a separate, later step with its own gate.

| Surface | Status | Replaced by | Final-removal gate | Source |
|---|---|---|---|---|
| Checkpoint / replica fork (`fork_base`, auto replica) **for egress-on sessions** | **Retired** (point-fork: 4-table copy at a flow watermark) | `egressPointFork` / `forkEgressSnapshot`; `POST /__bili/replicas` 201/503/400 contract | none left for egress-on; non-egress checkpoint path untouched | #7581 (discussion #7577) |
| kstate `tsStamps` / `tokenSnapshot` / `lastPassIds` **for egress-on sessions** | **Retired** (trimmed from `sessions.kstate_json` at save) | Derived from flow replay on load (`shadow.ts`) | none left for egress-on; legacy sessions byte-identical | #7581 |
| `compress-at-fold-point` kernel mode | **Retired** long ago | fold = D×n + I(summary) in the op log; the kernel never truncates in place | — (already removed) | #7439 series |
| **l1_world placeholder rows** (R3 latch carrier, identity cursor) | **Degraded**: egress-on sessions no longer use the carrier (`sessions.r3_latched_at` instead) and their stage-0 is stateless (no cursor) | `sessions.r3_latched_at` + op-log frontiers (`MAX(op_seq)` / `egressMessageHighWater`) | fleet at egressPlane GA + one stable release with no dual-carrier reads firing → physical DROP batch (column first, table last) | #7617 (discussion #7591) |
| **conversations** host-identity claim table | **Degraded** for egress-on (identity is stateless; no claim needed) | server-side identity from the flow | same batch as l1_world (one DDL migration) | #7617 |
| **refs** table — write path for egress-on sessions | **Write-retired** for egress-on (after the arm-time backfill, the op log covers the whole history; egress-on saves stop writing refs rows) | citation number = `log_seq` in the op log; refs derived from the flow view at load ([egress-plane.md](./egress-plane.md) §10) | read fallback for pre-backfill/legacy sessions until the physical DROP batch — final removal in that batch, gated like l1_world/conversations | renumber design, 2026-11-25 (#7691) |
| **session_ext** `inc:system` sticky copy (incremental-lane raw system) | **Retired** for egress-on (the client raw system `A` now lives in `egress_state` on the fixed `egress-system` msgid, number 0, U-updated on change) | the egress system row's input form ([egress-plane.md](./egress-plane.md) §10); the lane reads `A` from the egress state for egress-on sessions, legacy keeps the ext | legacy (plane-off) sessions keep using the ext; the column itself is part of the generic session_ext store — only the `inc:system` key's egress-on writes stop | renumber design, 2026-11-25 (#7691) |
| msgid trio: `pluginLaneServerHistory` / `pluginMsgIdIncremental` / `pluginFullResendWatermark` | **GA** (default 100); entries kept as opt-out | hardcoded-on behavior | egressPlane GA (the default-100 flip, pending owner decision) + ≥1 release with zero incident rollbacks via these three entries → remove the registry entries (hardcode on) | #7064 §8, #5469; default-100 flip pending owner decision |
| D-lane `snapshotRender` | **Not GA yet** (default 0). Serves *unarmed* plugin sessions; egress-on turns bypass it by construction (`snapshot-render.ts:529`) | the egress op log, once every plugin session arms | ALL of: egressPlane GA fleet-stable · every stamped host pinned by default · side-request carve-out closed → only then can D-lane become unreachable for plugin turns and be retired. **Not part of this PR.** | #3756 vs discussion #7439 |
| Rollout keys `egressOpLog` / `egressServeLog` | **Retired keys** (inert; setting them warns) | `egressPlane` | none (entries already gone; warning stays until the config files out in the wild are known clean) | #7439 series |

## Why "keep the entry" is the default GA shape

A registry entry is cheap and is the **only one-line rollback** for an incident in the wild. #6785's watermark GA flipped `percent: 100` and kept the entry for months while the fleet digested. Removal is planned per the gate column above — nobody removes a switch that is still the only rollback surface for a live surface.

## Not in this register (do not schedule)

- `storage.unified` — the substrate; never retiring while SQLite lane is the production store.
- `pluginIncrementalTurns` — a client opt-in wire protocol, not a rollout; clients enable it per agent.
- Non-egress legacy paths (checkpoint fork, l1 cursor resync, full-rederive render) — they stay the degrade target and the legacy store format; they retire only if the whole legacy format retires, which is out of scope.
