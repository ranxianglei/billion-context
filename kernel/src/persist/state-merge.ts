import type { CompressionState } from "../types.js";
import { createInitialState } from "../state.js";

/**
 * Forward-compat: merge a parsed state with a fresh one so fields added in
 * later kernel versions get sane defaults instead of `undefined`. Nested
 * groups (nudge, stats) are shallow-merged per field so older snapshots
 * keep their values while newer counters default in.
 *
 * Lifted verbatim in behavior from billion-context's proxy mergeState.
 */
export function mergeCompressionState(
  parsed: CompressionState,
): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
    tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
    absorbed: parsed.absorbed ?? fresh.absorbed,
    rules: parsed.rules ?? fresh.rules,
    nextRuleId: parsed.nextRuleId ?? fresh.nextRuleId,
    terminalStreak: parsed.terminalStreak,
    // #2388/#2370: bare passthrough like terminalStreak above — none of these
    // optional fields is seeded by createInitialState, and without a line here
    // a standalone acp-kernel consumer loses it on restart. The host's own
    // hydrator (billion-context src/state-hydration.ts) carries the same set;
    // the clone-fidelity guard (kernel/tests/state-clone-fidelity.test.ts)
    // fails if this list ever lags CompressionState again.
    hiddenOrphanRefs: parsed.hiddenOrphanRefs,
    deadRefs: parsed.deadRefs,
    lastPassIds: parsed.lastPassIds,
    sweptOrphanCallIds: parsed.sweptOrphanCallIds,
    pendingOrphanSweepMinRef: parsed.pendingOrphanSweepMinRef,
    emergencyTruncateLatch: parsed.emergencyTruncateLatch,
    renderDeferredRefs: parsed.renderDeferredRefs,
    refLedgerAligned: parsed.refLedgerAligned,
    viewLatches: parsed.viewLatches,
    viewLatchConfigDigest: parsed.viewLatchConfigDigest,
    tsStamps: parsed.tsStamps,
    // #5608-C: the visibility mark survives hydration only when the persisted
    // state actually carries it — legacy states stay key-free (an explicit
    // undefined would materialize a phantom key every state-key digest
    // compares). Same conditional-spread contract as the host's mergeState.
    ...(parsed.timestampsHighWaterRefSeq !== undefined
        ? { timestampsHighWaterRefSeq: parsed.timestampsHighWaterRefSeq }
        : {}),
    // suppressMintingOnce is deliberately NOT carried — hydration rebuilds
    // from disk, and re-arming honest-NULL after a restart would eat genuine
    // first-sight mints of truly new messages; dropping it (the safe default)
    // is what pre-arm states look like anyway. Same decision as the host's
    // mergeState (src/state-hydration.ts).
  };
}
