# The egress plane (egressPlane) — dedicated doc

> The #7439 series end-state: the outbound conversation **op log is the single authority** for egress-on sessions. This page is the one-stop reference — what it does, which switches gate it and how they depend on each other, the tables, the operator runbook, and the PR/proposal timeline. 中文: [egress-plane.zh-CN.md](./egress-plane.zh-CN.md). Retiring surfaces live in [deprecations.md](./deprecations.md); the storage module page: [architecture/storage.md](./architecture/storage.md).

## What it is

For **egress-on** sessions, bili records every turn's outbound conversation view as a sparse op log (I/D/U rows with the message bytes riding the row — self-contained, no content CAS, ruling 7439-1) and serves the outbound core-message portion back **from the log**, byte-identical by construction. Pinned plugin lanes additionally take **server authority**: the kernel input is replayed from the flow (rulings 7439-3/5). The legacy re-derive-from-client-bytes chain is kept as the degrade target, not the source of truth.

Consequences that define the architecture (KDD #23):

- **`egress_flow` I rows are the canonical message authority** (msgid + never-reissued `log_seq`); the `messages` table is a **lazy projection** rebuilt one-time on rollback / web read / restore.
- The session JSON envelope **freezes at bootstrap** (index-only saves); `kstate` is trimmed to the residual field list (derivable fields drop out).
- `tsStamps`/token stats are **derived from flow replay on load** instead of persisted.
- Identity (stage-0) is **stateless** for egress-on sessions — computed from the op log frontiers, no `l1_world` cursor needed (#7617).

## The switch family and how they depend on each other

| Flag | Default | Role in the egress family |
|---|---|---|
| `rollout.features.egressPlane` | **100 (on, GA 2026-11-24)** | THE switch. Arms the plane for eligible sessions. Opt-out: `false`/percent / `BILI_ROLLOUT_EGRESS_PLANE=0`. |
| `storage.unified` (full/shadow) | — | **Prerequisite.** SQLite lane only; the op log lives in the unified store (`store.egressOpLogStore()`). No unified store ⇒ the plane has nowhere to write and stays inert. |
| `pluginLaneServerHistory` | 100 (GA) | The **pin**: server history + msgid identity. Without a pin, `egressAuthority` never arms — the plane silently idles. |
| `pluginMsgIdIncremental` | 100 (GA) | Steady-state tail form of the pin channel (requires `pluginLaneServerHistory`). |
| `pluginFullResendWatermark` | 100 (GA) | Fastpath optimization of the same family (skip re-parsing the verified identical prefix). |
| `snapshotRender` (D-lane) | 0 | **NOT egress.** Server-render for *unarmed* plugin sessions. egress-on turns bypass it by construction (`src/server/snapshot-render.ts:529`: `if (deps.pluginMode) return clientMsgs`) — armed plugin sessions are served from the op log. |
| `pluginIncrementalTurns` | 0 | Not egress at all — a client opt-in wire protocol (#3248). |

**Arm rule** (`src/server/egress-lane-io.ts`, `egressAuthorityArmed`): `featureEnabled("egressPlane") && pluginMode && pinned && !sideRequest` — one rule for all four wire lanes; side requests (title-gen, compaction, tiny budgets) never touch the log.

**Silent half-states are documented, not hidden**: with `egressPlane` on but `pluginLaneServerHistory` off, no session arms and nothing happens (no rows, no logs) — the plane idles. All four msgid-family flags above default to 100, so this can only happen via an explicit operator opt-out. Flag-removal (hardcode-on) is on the retirement register, gated on GA stability ([deprecations.md](./deprecations.md)).

## Tables (SQLite, `src/storage/schema.ts`)

| Table | Role | Key points |
|---|---|---|
| `egress_flow` | Append-only message op log (I/D/U/B rows) | PK `(session_id, op_seq)`, **dense within the table** (the #7574 invariant; recovery = walk back to the newest healthy base, `recoverEgressBase`). I rows carry `log_seq` — the canonical, never-reissued message number. |
| `egress_state` | Read replica of the live view | `(session_id, log_seq)`; bounded by compaction (B bases). |
| `egress_block_flow` | Append-only **block** history (I/U/B rows) — #7581 | **Own number pool** (dual clocks, owner ruling 2026-11-24); each row carries `flow_op_seq` = the flow's `MAX(op_seq)` at write time (a pointer, non-decreasing ⇒ `flow_op_seq <= X` is a prefix). |
| `egress_block_state` | Latest snapshot per block | `(session_id, block_id)`; same pointer. |
| `sessions.r3_latched_at` | R3 identity-fault latch carrier (#7617) | NULL/0 = not latched. Dual-carrier read (`??` legacy `l1_world` column) and clear (both carriers) so a session latched under either binary works; the physical DROP of the legacy carriers is on the retirement register. |
| `conversations` | Host-identity claim table | egress-on sessions no longer need it (identity is stateless); physical DROP on the retirement register. |

Full DDL + row/payload shapes: [egress-block-flow.md](./egress-block-flow.md) (blocks) and the #6785 doc §6 (flow/state).

## Operator runbook

- **Where on/off is read (resolution order):** env `BILI_ROLLOUT_EGRESS_PLANE` (`"0"`/`"false"` = off, anything else = on) → config file `$XDG_CONFIG_HOME/billion-context/billion-context.json` (default `~/.config/billion-context/billion-context.json`), key `rollout.features.egressPlane` (`true`/`false`, or `{ "percent": n }` for a gradual rollout) → code default (`src/rollout.ts`): 0 = off until the GA flip lands, then 100 = on. Turning it on needs nothing else — the prerequisite is `storage.unified`, which the standard install already sets.
- **Opt out (whole plane):** `BILI_ROLLOUT_EGRESS_PLANE=0` (env wins over config) or `"rollout": {"features": {"egressPlane": false}}`. Effect: new turns go back to the legacy chain; existing egress rows stay (lazy projection rebuild still reads them).
- **Degrade behavior (no action needed):** any unrebuildable row, corrupt log point, or probe failure degrades **that turn** to the legacy chain — never a partial swap, never client-as-authority. A log with **no** healthy point at all hard-fails loudly (ruling 7439-5).
- **Point fork:** `POST /__bili/replicas` (201 = point-fork created / 503 = non-resident / 400 = point below the newest base — below-base points are refused until the point-reconstruction materializer follow-up lands). Fork-to-now copies all four tables verbatim; a true point fork filters block rows by `flow_op_seq <= wm`.
- **R3 latch stuck:** check `SELECT r3_latched_at FROM sessions WHERE session_id = ?` (fall back to `l1_world.r3_latched_at` on old binaries); clearing goes through the store's clear path which resets **both** carriers.
- **GC / archive:** egress-on sessions are **excluded from age-based GC entirely** and **refused** on manual archive (`bili sessions archive`) — the archive format does not carry the op log yet (follow-up; until it does, archiving an egress-on session would strand its content).
- **Diagnosis:** `/__bili/status` shows storage state; recovery events (truncated bases, degraded turns) are loud in the proxy log.

## PR / proposal timeline

| When | What |
|---|---|
| Discussion [#7439](https://github.com/ranxianglei/billion-context/discussions/7439) | Series origin; the five owner rulings (self-contained rows; blocks table read/write side; server authority + flow replay; blocks-table alignment; no-healthy-point hard fail). |
| KDD #23 (#7474/#7475, 2026-11-22) | op log = sole authority, `messages` lazy projection, re-anchor delta. |
| #7574 | op-log integrity: in-transaction seq reads, `recoverEgressBase` walk-back, concurrent-writer refusal. |
| [Discussion #7577](https://github.com/ranxianglei/billion-context/discussions/7577) / #7581 (merged) | `egress_block_flow`/`egress_block_state` (dual clocks), checkpoint retirement → point fork, kstate trim. |
| [Discussion #7591](https://github.com/ranxianglei/billion-context/discussions/7591) / #7617 (merged) | Identity consolidation: stateless stage-0, R3 latch → `sessions`, conversations retirement for egress-on, GC/manual-archive guards. |
| **This PR (GA, 2026-11-24)** | `egressPlane` default 0 → 100. Every CI run now exercises the plane fleet-wide; the opt-out above is the rollback surface. |

**Open follow-ups** (tracked, not blocking GA): the point-reconstruction materializer (fork points below the newest base); the archive format gaining the op log (until then egress-on archive refusal); `egressBlockCompact`/`Replay` have no production caller yet (block log compaction); the physical DROP batch for the retired identity carriers.
