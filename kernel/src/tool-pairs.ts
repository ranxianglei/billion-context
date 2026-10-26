import type { CoreMessage } from "./types.js";

/**
 * Adjust compression range boundaries to include tool-call/result pairs.
 *
 * PREVENTIVE approach (adapted from opencode-acp PR #248): before compression
 * is applied, scan for tool-call or tool-result messages whose matching half
 * (the result for a call in range, or the call for a result in range) sits
 * outside the requested range. Pull the orphan half INTO the range so the
 * pair is compressed together — zero information loss.
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
  maxScan: number = 20,
): { startIndex: number; endIndex: number } {
  // Collect all toolCallIds in range (both tool-call and tool-result messages).
  // Skip compress tool — it's force-protected and always survives pruning.
  const callIdsInRange = new Set<string>();
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (!msg || !msg.toolCallId) continue;
    if (msg.toolName === "compress") continue;
    callIdsInRange.add(msg.toolCallId);
  }

  if (callIdsInRange.size === 0) {
    return { startIndex, endIndex };
  }

  // Extend FORWARD: tool-results typically follow their tool-call.
  // Stop at the first gap after finding at least one matching message.
  let newEndIndex = endIndex;
  for (
    let i = endIndex + 1;
    i < messages.length && i <= endIndex + maxScan;
    i++
  ) {
    const msg = messages[i];
    if (!msg) break;
    if (msg.toolCallId && callIdsInRange.has(msg.toolCallId)) {
      newEndIndex = i;
    } else if (newEndIndex > endIndex) {
      break;
    }
  }

  // Extend BACKWARD: tool-calls typically precede their tool-result.
  let newStartIndex = startIndex;
  for (let i = startIndex - 1; i >= 0 && i >= startIndex - maxScan; i--) {
    const msg = messages[i];
    if (!msg) break;
    if (msg.toolCallId && callIdsInRange.has(msg.toolCallId)) {
      newStartIndex = i;
    } else if (newStartIndex < startIndex) {
      break;
    }
  }

  return { startIndex: newStartIndex, endIndex: newEndIndex };
}
