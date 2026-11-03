# Ref-Keyed Surfaces Registry (#4797 phase C audit)

> **Purpose**: the ledger-alignment restamp (`restampRefsToLedger`, #4316 PR3/3) renumbers message refs. It is a MULTI-SURFACE migration: every state field / store / view keyed by ref number must move with it. Three leaks shipped before this registry existed (#4757 tokenSnapshot, #4733 CCR store, #4797 superseded/live collision). **Any new code that keys anything by an `mNNNNN` ref must register here and be added to the restamp pass (or proven ref-free).**

## The restamp pass — what migrates today

| Surface | Keyed by | Migrated where | Notes |
|---|---|---|---|
| `state.messageRefs` (`byRaw`/`byRef`) | ref ↔ rawId | `kernel/src/refs.ts restampRefsToLedger` | authoritative live space; sets `refLedgerAligned` |
| `state.tokenSnapshot` | ref | `src/persist.ts maybeRestampToLedger` (#4757, 4c6aefea) | two-pass move, no swap loss |
| CCR content store aliases | ref | `restampContentStore` (#4733), same pass | live claims first; dead keys frozen |
| `blocks[].startRef/endRef` | ref strings | `restampRefsToLedger` translateRef pre-pass map (#4807) | identity-preserving old-ref→same-message-new-ref; keeps recommend adjacency, hide-consumed dedup and nudge/decompress receipts (`resolveBlockSpan`) on live labels |
| `state.deadRefs` | ref numbers | `restampRefsToLedger` translateRef + live-drop (#4807) | tombstones follow the message's new number unless it lands live (re-granted ⇒ dropped — a live number is not a hole); ownerless dead keys stay verbatim; empty ⇒ undefined (#3302) |
| `session.restampSuperseded` | oldRef→rawId | produced by the pass | **process-lifetime only, never persisted, must be cleared on empty outcome** |

## Ref-keyed and NOT (yet) migrated — the collision band

| Surface | Keyed by | Status | Consequence if unmigrated |
|---|---|---|---|
| `state.hiddenOrphanRefs` | refs | stale | hidden orphan pairs resurrect mid-history (#3769 regression class) |
| `state.emergencyTruncateLatch[].ref`, `renderDeferredRefs`, `viewLatches`, `pendingOrphanSweepMinRef` | refs/number | stale | latch misses → replay divergence → prefix-cache churn (one-time rewrite) |
| `messages.ref_num` (unified store rows) | ref number | **index-time, never rewritten** | web leaf hydration + export JSONL query NEW numbers against OLD rows → silent misses for the renumbered band (#4738 family) |

## Flag propagation contract (kernel)

`state.refLedgerAligned` is the one-time gate. It is written ONLY by `restampRefsToLedger` (kernel/src/refs.ts) and MUST survive:
- `syncBlocks` state clone (kernel/src/sync.ts) — processTurn path
- `cloneState` (kernel/src/compress.ts, applyCompression path)

Losing it re-arms the restamp every turn; the re-stamp is a numbering no-op after convergence but keeps the superseded map alive forever (host only overwrites `session.restampSuperseded` when non-empty).

## The superseded/live collision (#4797 root)

`restampRefsToLedger` vacates an old number and records it in `superseded` — but the SAME pass hands vacated numbers to other messages as `seq+1` targets. Post-pass, a number can be **simultaneously live (byRaw/byRef) and a superseded key**. Any consumer that consults `superseded` before the live map misclassifies live refs.

**Contract (enforced by kernel post-pass prune + host guard priority):**
1. Kernel: after the pass, drop `superseded` entries whose key resolves in the final live map.
2. Host guard (`supersededRefRejection`, src/stream.ts): a ref that resolves LIVE is never superseded — liveness first; only genuinely-dead numbers consult the map; translation `oldRef→rawId→live ref` is identity-preserving and mandatory for model-cited pre-restamp refs (the model may cite any number it has ever seen — kernel contract).

## Inbound/outbound ref surfaces (verified all-live 2026-10-26, phase C audit)

Outbound emitters all derive from live `state.messageRefs` via the kernel render pipeline (render-refs.ts) or `byRaw` lookups — see audit tables in PR #4805. Inbound acceptors: compress (`supersededRefRejection`), decompress range/imageRef (fail-soft), CCR retrieve (store rekeyed). The one bypass: `loadStateForSearch` (src/persist.ts) reads the shadow view WITHOUT `afterLoad` — pre-restamp copy for foreign-session search_context.

## Restamp trigger surfaces

- Unified cold load: `loadUnified` hit / strictly-ahead envelope recovery / fresh import (src/persist.ts afterLoad).
- **LRU eviction mid-conversation**: `getSession` memory-miss → `loadSync` → afterLoad — the "restart boundary has no in-flight compress call" rationale does NOT hold here; pre-eviction outbound tags are still in the wild. The identity-preserving translation above is what makes this safe.

## 已落地（本 PR 2026-10-26_ref-chokepoint，决策记录）

- **host 守卫三级阶梯（src/stream.ts）**：端点粒度，活表优先 → 空置号保义翻译 → 翻译死路才拒绝。活键碰撞死循环由这一层根治（kernel 侧无论 superseded 表长什么样，活号永远胜出）。
- **kernel 克隆携带 `refLedgerAligned`**（kernel/src/sync.ts + kernel/src/compress.ts cloneState）：一次性对齐真正一次性——此前每轮克隆丢标志，重启后重排反复重跑。
- **persist 收敛清除**（src/persist.ts）：空 outcome 清 `session.restampSuperseded`。
- **registry 本文档**：所有 ref 键控面登记在案。

## 已评估、暂缓（需要 storage 影子层配合，单独立项）

- **kernel superseded 活键剪枝 + block startRef/endRef / deadRefs 迁移**：实现过并验证过单测，但 storage-engine 的重启不可见契约（wire-parity proofs + 影子摘要对比）依赖重排结果的确定性形状——迁移后影子层报 `DIGEST DRIFT [diverged: state]`，full 模式回退 legacy 信封，wire 漂移 4 项红。正确落地需要影子层把「对齐态」纳入摘要口径；在此之前 host 活表优先已消除其全部用户可见危害。剪枝与迁移的完整实现见 PR 历史（revert 前的 kernel/src/refs.ts）。
