import type { CoreMessage } from "./types.js";

/** Per-toolCallId [lowest, highest] position over the WHOLE array (#5751).
 *  One O(n) pass: a legal history can interleave arbitrarily many messages
 *  between a call and its result (parallel tool bursts, host-injected
 *  system/attachment messages), so pairing is id-exact, never
 *  distance-scanned. Positions are indexed for EVERY message carrying the id
 *  — including compress halves (#4348: aged compress results do seed, they
 *  carry no toolName; the compress half of an aged pair must widen INTO the
 *  range) — and a callId duplicated across messages (host re-echoes a result
 *  on retry) widens to its extremes so every message claiming the id folds on
 *  the same side of the boundary.
 *
 *  Cost contract: callers screening many units against one immutable array
 *  must build ONCE per pass and share via
 *  ProjectionShared.toolPairExtremes — rebuilding per unit is the #5337
 *  quadratic class (U units x O(n)). */
export function buildToolPairExtremes(
  messages: CoreMessage[],
): Map<string, [number, number]> {
  const extremes = new Map<string, [number, number]>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !msg.toolCallId) continue;
    const cur = extremes.get(msg.toolCallId);
    if (cur === undefined) {
      extremes.set(msg.toolCallId, [i, i]);
    } else {
      if (i < cur[0]) cur[0] = i;
      if (i > cur[1]) cur[1] = i;
    }
  }
  return extremes;
}

/**
 * Adjust compression range boundaries to include tool-call/result pairs.
 *
 * PREVENTIVE approach (adapted from opencode-acp PR #248): before compression
 * is applied, find tool-call or tool-result messages whose matching half (the
 * result for a call in range, or the call for a result in range) sits outside
 * the requested range. Pull the orphan half INTO the range so the pair is
 * compressed together — zero information loss.
 *
 * Pairing resolves through {@link buildToolPairExtremes}; when screening many
 * units against one immutable array, pass the pre-built map (per-unit rebuild
 * would pay O(n) each — the #5337 quadratic class).
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
  extremes?: Map<string, [number, number]>,
): { startIndex: number; endIndex: number } {
  const pairExtremes = extremes ?? buildToolPairExtremes(messages);

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
      const ext = pairExtremes.get(msg.toolCallId)!;
      if (ext[0] < newStartIndex) {
        newStartIndex = ext[0];
        changed = true;
      }
      if (ext[1] > newEndIndex) {
        newEndIndex = ext[1];
        changed = true;
      }
    }
  }

  return { startIndex: newStartIndex, endIndex: newEndIndex };
}
