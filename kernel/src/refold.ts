// #3371: the refold-in-place verdict, extracted verbatim from compress.ts so
// the recommend lane can consult the SAME definition the apply lane throws
// by — the projectUnit discipline (#3236): one shape, one judgment, two
// consumers. compress.ts kept this private, so screenRecommendedUnits
// advertised consumed-but-not-restored spans (filteredIds === 0 &&
// consumedBlockIds > 0) that applyCompression is GUARANTEED to reject
// ("contains no new compressible messages") — an advertise→reject loop, the
// #3236 failure family reached through its last shape.

import { parseBoundary } from "./boundaries.js";
import { resolveBlockSpan } from "./block-map.js";
import { blockById } from "./state.js";
import { activeAncestorIds } from "./decompress.js";
import type { CompressionBlock, CompressionState } from "./types.js";

export type RefoldDecision =
  | { kind: "refold"; blocks: CompressionBlock[] }
  | { kind: "blocked"; reasons: string[] };

/** Ref-number span [lo, hi] of a spec boundary: m-refs contribute their
 * number, block refs expand through resolveBlockSpan. */
export function requestedRefoldSpan(
  state: CompressionState,
  spec: { startRef: string; endRef: string },
): { lo: number; hi: number } | null {
  const nums: number[] = [];
  for (const ref of [spec.startRef, spec.endRef]) {
    const parsed = parseBoundary(ref);
    if (!parsed) return null;
    if (parsed.kind === "message") {
      nums.push(parsed.numericId);
      continue;
    }
    const block = blockById(state, `b${parsed.numericId}`);
    if (!block) return null;
    const span = resolveBlockSpan(block, state.messageRefs.byRaw);
    if (!span) return null;
    const lo = parseBoundary(span.startRef);
    const hi = parseBoundary(span.endRef);
    if (!lo || !hi) return null;
    nums.push(lo.numericId, hi.numericId);
  }
  return { lo: Math.min(...nums), hi: Math.max(...nums) };
}

/** #398 refold-in-place gate for a consumed range: every active block inside
 * the requested span must be restored-inline (with a fully restored ancestor
 * chain) and at least one must be — then it updates those in place instead of
 * rejecting as "already compressed". Otherwise the blocking blocks are listed
 * by id ("blocked by bN (not restored)" / "partially covered bN"). */
export function evaluateRefold(
  state: CompressionState,
  spec: { startRef: string; endRef: string },
): RefoldDecision {
  const span = requestedRefoldSpan(state, spec);
  if (!span) return { kind: "blocked", reasons: [] };
  const reasons: string[] = [];
  const blocks: CompressionBlock[] = [];
  for (const block of state.blocks) {
    if (!block.active) continue;
    const resolved = resolveBlockSpan(block, state.messageRefs.byRaw);
    if (!resolved) {
      reasons.push(`partially covered ${block.blockId}`);
      continue;
    }
    const ownLo = parseBoundary(resolved.startRef)?.numericId;
    const ownHi = parseBoundary(resolved.endRef)?.numericId;
    if (ownLo === undefined || ownHi === undefined) continue;
    if (ownHi < span.lo || ownLo > span.hi) continue;
    if (!block.restoredInline) {
      reasons.push(`blocked by ${block.blockId} (not restored)`);
      continue;
    }
    // Overlapping but not fully contained in the request: part of the block
    // would keep the stale summary while the range gets a new one.
    if (ownLo < span.lo || ownHi > span.hi) {
      reasons.push(`partially covered ${block.blockId}`);
      continue;
    }
    const blockers = activeAncestorIds(state, block.blockId).filter(
      (ancestorId) => !blockById(state, ancestorId)?.restoredInline,
    );
    if (blockers.length > 0) {
      for (const id of blockers)
        reasons.push(`blocked by ${id} (not restored)`);
      continue;
    }
    blocks.push(block);
  }
  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length > 0)
    return { kind: "blocked", reasons: uniqueReasons };
  if (blocks.length > 0) return { kind: "refold", blocks };
  return { kind: "blocked", reasons: [] };
}
