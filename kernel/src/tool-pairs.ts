import type { CoreMessage } from "./types.js";

/**
 * Adjust compression range boundaries to include tool-call/result pairs.
 *
 * PREVENTIVE approach (adapted from opencode-acp PR #248): before compression
 * is applied, find tool-call or tool-result messages whose matching half (the
 * result for a call in range, or the call for a result in range) sits outside
 * the requested range. Pull the orphan half INTO the range so the pair is
 * compressed together — zero information loss.
 *
 * Pairing is id-exact, never distance-scanned (#5751): each toolCallId's
 * lowest/highest position is indexed over the WHOLE array once, because a
 * legal history can interleave arbitrarily many messages between a call and
 * its result (parallel tool bursts, host-injected system/attachment
 * messages). The previous capped scan (maxScan=20, stop-on-gap, break-on-
 * empty) left such pairs straddling the fold — the turn-integrity gate then
 * withdrew the pair from every candidate range, so in tool-dense regions no
 * legal range remained ("folding stuck", #5746), or the split reached the
 * wire as a persistent upstream 400.
 *
 * Only MESSAGE-boundary ranges are adjusted. Block-boundary ranges (bN) are
 * left untouched to preserve tier-detection correctness.
 *
 * @returns Adjusted { startIndex, endIndex } — may be wider than input.
 */
export function adjustBoundariesForToolPairs(
  startIndex: number,
  endIndex: number,
  messages: CoreMessage[],
): { startIndex: number; endIndex: number } {
  // Skip compress as a SEED — it's force-protected and always survives
  // pruning (#4348: aged compress results do seed, they carry no toolName).
  // Positions are still indexed for EVERY message carrying the id: the
  // compress half of an aged pair must widen INTO the range (#4348 lace).
  // A callId duplicated across messages (host re-echoes a result on retry)
  // widens to its extremes so every message claiming the id folds on the
  // same side of the boundary.
  const loById = new Map<string, number>();
  const hiById = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !msg.toolCallId) continue;
    const lo = loById.get(msg.toolCallId);
    const hi = hiById.get(msg.toolCallId);
    if (lo === undefined || hi === undefined) {
      loById.set(msg.toolCallId, i);
      hiById.set(msg.toolCallId, i);
    } else {
      if (i < lo) loById.set(msg.toolCallId, i);
      if (i > hi) hiById.set(msg.toolCallId, i);
    }
  }

  // Widen to a fixed point: pulling a mate in can expose callIds whose own
  // mates sit further out (chains of interleaved pairs). Iterations are
  // bounded by distinct callIds — every iteration must process a new id to
  // change anything, else the loop ends.
  let newStartIndex = startIndex;
  let newEndIndex = endIndex;
  const settled = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = newStartIndex; i <= newEndIndex && i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || !msg.toolCallId) continue;
      if (settled.has(msg.toolCallId)) continue;
      if (msg.toolName === "compress") continue;
      settled.add(msg.toolCallId);
      const lo = loById.get(msg.toolCallId)!;
      const hi = hiById.get(msg.toolCallId)!;
      if (lo < newStartIndex) {
        newStartIndex = lo;
        changed = true;
      }
      if (hi > newEndIndex) {
        newEndIndex = hi;
        changed = true;
      }
    }
  }

  return { startIndex: newStartIndex, endIndex: newEndIndex };
}
