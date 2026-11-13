# #5874 2×2 — 2×2 snapshot egress modes (M1–M4): stage-0 world match, kernel-input assembly, delta outbound

References **#6181** (rebase → msgid+snapshot, Proposal 6).

## Stacking structure

**This PR is stacked on #5901** (base branch `2026-11-07_snapshot-table-foundation`, head `f0001977a`). The diff is exactly the 2×2 work — nothing from the foundation is duplicated here:

| commit | content |
|---|---|
| `8f4c89cda` | feat: 2×2 modes — stage-0 world match (M1), kernel-input assembly (M2), delta outbound (M3/M4) |
| `be8990d61` | fix: `ACP_KEEP_RESPONSE_ID` semantics on delta rounds (#1954 pin: id kept on delta rounds, stripped only on full re-seeds) |
| `b9b3f0e9e` | fix: review round 1 — B0 plane-protection bypass, B1 400 fault exit, B3 pure-continuation routing, B4 frontier commit at accept, M1 rollout tie, M2 R3 arbiter, M3 latch persistence |
| `2fc593afd` | fix: review round 2 — Residual 1a no-op classification, Residual 1b replay guard, Residual 2 first-chained-round frontier seed |
| `256b27b48` | fix: Residual 2 hardening — seed only for an id THIS proxy minted, persisted-frontier id mismatch forces a plain re-seed, B3 latent `resetAfterSuccess` fix |
| `5b6ac48b3` | rebase hygiene: drop the duplicate `getStore` import (already on the #5901 base) |
| `e3409963b` | fix: guard untagged saves against a live tagged plane (see below) |

Proposal 6 = foundation (#5901) + these 2×2 modes; merging this PR into #5901 delivers the complete proposal. Rebasing #5901 onto master remains the owner's call (#5901 is currently CONFLICTING on 3 doc files; the code auto-merges).

## e3409963b — the durability-persist vs tagged-plane interaction (needs owner awareness)

Re-testing on the current #5901 head (which now includes #6326 "durability-before-render") exposed a real interaction: #6326 persists the session **before** the model call so a crash can't lose the turn. That pre-render save carries no tagged plane view (the transcript at that moment is the pre-turn world). Against a session whose snapshot plane already holds the pinned-id rows (2×2 cohort traffic), that save ran the legacy final-state diff, which could not address the pinned ids and **deleted the plane rows** — the next round then had no history to serve (context loss).

The fix (`e3409963b`, 6 lines in `UnifiedStore.snapShadowSync`): an untagged save against a sid that already has active plane rows is a no-op for the plane (the disk record still lands, so #6326's crash-durability win is untouched) — the plane is only ever updated by tagged saves, which is the existing addressing doctrine (R2). Repro + pin: the p3 B4 e2e test (fails without the guard on this base, passes with it).

## What the 2×2 modes are

Four combinations of **inbound mode** (how the client sends history) and **outbound mode** (what the proxy forwards to the provider), all served from one source of truth — the snapshot table (the l1 world + the plane rows):

| | snapshot out (M1 / M2) | delta out (M3 / M4) |
|---|---|---|
| **full in** | **M1** — today's behavior: kernel re-renders the full world every round, the plane is re-served whole | **M4** — full world in, but the provider only receives the new spans (chain intact) |
| **incremental in** (msgid + seqs declared) | **M2** — the kernel input is ASSEMBLED from the plane (old rows) + new spans; byte-identical to M1's input | **M3** — both sides incremental |

The kernel is untouched (a CI guard asserts it). Inbound mode is chosen per request at stage 0 (world match: `issue` / `probe` / `echo` / `scatter` / `diverge` / `resync` / `replay`); outbound mode is chosen at the protocol rewrite for the responses lane (the only lane with provider-side retention), gated on the existing `ACP_KEEP_RESPONSE_ID`.

## Review history

### Round 1 (five Blockers + six Majors) — all fixed in `b9b3f0e9e`

- **B0** chained-turn plane collapse — a non-cohort chained turn's kernel view is a delta, not the world; flushing it destroyed plane history. Fix: `skipPlaneFlush` (one-shot, one write seam) + egress `bypass` → the plane is neither written nor served for those turns; next full turn re-syncs (one-round convergence).
- **B1** R3 identity fault must be a 400 — the lane swallow catches now rethrow `FoundationRejectError`; the server funnel maps it to `400` + `x-bili-snapshot: identity` before the generic 503 path. E2E-pinned (real 400 over HTTP, zero side effects).
- **B3** no-op chained round produced a BLIND provider response (empty input + dev message + stripped id). Fix: (a) pure-continuation rounds (chained, empty input) route to the raw-body passthrough — bytes unchanged, no kernel, no dev, no plane touch; (b) delta no-op rounds keep the id and skip the dev message (`noopServed`). Both e2e-pinned.
- **B4** the delta frontier was advanced at egress-build time with no rollback. Fix: `pendingResponsesDelta` on the prepared request; committed to the session only after the upstream accepts (status < 400), dropped on failure.
- **M1** R3 arming now rides the same rollout as the pin (`pluginLaneServerHistory`), so R3 is reachable whenever the cohort is. **M2** `checkR3Identity` is the single R3 arbiter (was dead code). **M3** the R3 latch persists (`l1_world.r3_latched_at`, upsert so it survives before the l1 row exists). **M4** the M1-vs-M2 byte pin now runs both legs through the real `openaiToCore` codec (wireIndex stripped — legitimately position-dependent). **M6** every `snapStage0Reset` also clears the delta frontier.

### Round 2 (three residuals) — fixed in `2fc593afd` + hardened in `256b27b48`

- **Residual 1a** same-body retry of an M1 round → no-op (id kept, empty input, no dev) — e2e-pinned.
- **Residual 1b** same-body retry of an M2 round would have hit `diverge` and **wiped the plane** (the retry's seqs are ≤ frontier but its id is known → headMoved). Fix: stage-0 **replay guard** — all-unknown-free incoming with all seqs at/behind the frontier is classified `echo` with `replay: true`, zero writes.
- **Residual 2** the first CHAINED round of a keepResponseId chain re-seeded the full view although the provider chain already held it (2× tokens, one-time). Fix: seed the delta frontier at the stored world when stage-0 proves a strict extension AND the chain id is **one this proxy minted** (recorded in the relay from the bytes actually forwarded — `response.created`/`response.completed` scan for streaming, `json.id` otherwise, status < 400 only). If a persisted frontier's recorded id doesn't match the incoming `previous_response_id` (fork/rewind on a stale id), the frontier is voided and the round takes the plain re-seed (id kept, full view, dev) — the status quo, which never loses. E2E-pinned including a fork round that asserts the full re-seed.

Round 2 also surfaced and fixed a latent bug the review didn't name: the pure-continuation (B3) route used the compact base which hard-codes `resetAfterSuccess: true` → the relay would mark a native compaction boundary on every B3 round and reset the session's compression state with no compaction ever happening. `pureChainContinuation` now sets `resetAfterSuccess: false`.

### Residual 3 (body note, no code)

The openai lane deliberately has **no** `skipPlaneFlush`/bypass: chat-completions providers keep no server-side history, so there is no collapse to protect against — an untagged non-cohort openai turn's kernel view IS the full client array.

## Config surface

**No new config keys.** Reused: `ACP_KEEP_RESPONSE_ID` (outbound mode for the responses lane), the existing `pluginLaneServerHistory` rollout (gates R3 arming + pin validation), the plane/e2e rollout already on the #5901 base. Two owner rulings remain (flagged since round 1): (a) whether the keepResponseId-upgrade policy (chained cohort rounds are delta by default) should be a separate key; (b) the D-lane (snapshot-render) yield policy for cohort turns.

## Acceptance evidence

Local (stack head `e3409963b`):

- `tests/issue5874-2x2-p3.test.ts` — **42/42** (verdict pairs ±6, assembly incl. M1-vs-M2 codec-level byte pin, delta seed/delta/noop/full-resend, R3 gates + latch persistence, store round trip, #1954 native, B0 flush-skip + egress bypass, B1 400 over real HTTP, B3 pure-continuation over real HTTP, B4 frontier commit incl. the 400-drop, Residual 1a/1b/2 unit + e2e incl. fork)
- regression battery: snapbase p0 10/10, snaplane p1 4/4 + p2 17/17 + fastpath 2/2, snapshot-render 13/13 + shadow-chain 6/6, storage-engine-proofs 12/12, opencode-rolling-cache-marks 10/10, responses-previous-response-id 7/7
- `tsc --noEmit` clean; unused-exports gate clean; architecture-docs guard green (`src/snapshot/stage0.ts` mapped)

CI: full run on `e3409963b` — https://github.com/ranxianglei/billion-context/actions/runs/43126815381 (dispatched; result pending). Prior full runs on the master-based equivalent: 48 success / 0 failed (43108701003).

Not done: acceptance item 10's real-client leg (a real codex CLI end-to-end) — marked out of scope for this PR, e2e coverage stands in via the fake-upstream harness.
