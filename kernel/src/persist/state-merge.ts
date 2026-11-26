import type { CompressionState } from "../types.js";
import { createInitialState } from "../state.js";

/**
 * Forward-compat: merge a parsed state with a fresh one so fields added in
 * later kernel versions get sane defaults instead of `undefined`.
 *
 * This is a SPREAD merge on purpose. The previous implementation enumerated
 * a field list; every optional field added in a later release was silently
 * dropped on hydration (tsStamps / viewLatches / sweptOrphanCallIds / deadRefs
 * / …), which changed rendered bytes mid-history and resurrected already
 * swept compress orphans after a restart. A spread carries every present
 * field without a second list to maintain, and future fields ride along
 * automatically. Nested groups (nudge, stats) are shallow-merged per field so
 * older snapshots keep their values while newer counters default in.
 */
export function mergeCompressionState(
  parsed: CompressionState,
): CompressionState {
  const fresh = createInitialState();
  return {
    ...fresh,
    ...parsed,
    // Required fields must never become `undefined` just because a hand-built
    // or partially-written record carried the key with no value.
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    tokenSnapshot: parsed.tokenSnapshot ?? fresh.tokenSnapshot,
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
  };
}
