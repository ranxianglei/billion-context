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
    imageFullRestored: parsed.imageFullRestored ?? fresh.imageFullRestored,
    imageShrinks: parsed.imageShrinks ?? fresh.imageShrinks,
    // #2388: this explicit list was missing these two optional fields, so a
    // standalone acp-kernel consumer lost them on restart. Bare passthrough
    // like terminalStreak above — neither is seeded by createInitialState.
    hiddenOrphanRefs: parsed.hiddenOrphanRefs,
    lastPassIds: parsed.lastPassIds,
  };
}
