/**
 * Shared conversation segmentation — the single primitive both range views
 * build on. `buildCompressibleRanges` (recommend.ts) and the uncompressed
 * status view (report.ts) must segment identically or the same session renders
 * two disagreeing pictures of where its turns are; the split rule therefore
 * lives here, once. Each view supplies per-item `gapBefore` / `isUser` from its
 * own base set and aggregates its own output fields per group.
 */

export interface SegmentItem {
  /** Display ref (mNNNNN); used verbatim as a group boundary, never parsed. */
  ref: string;
  /** A numbered-ref message was physically skipped between this item and the
   *  previous one in the source array. Callers compute it from ARRAY positions
   *  — never from ref arithmetic. */
  gapBefore: boolean;
  /** True when this item is a user-role message (turn boundary candidate). */
  isUser: boolean;
}

/**
 * Group items into contiguous segments. Split rules (identical to
 * opencode-acp's buildCompressibleRanges condition):
 *   - a real array gap (`item.gapBefore`) always starts a new segment, AND
 *   - a user message starts a new segment once the current one holds >= 3 items.
 *
 * Segmentation is ARRAY ADJACENCY, never ref arithmetic. Surface-replacing
 * hosts leave holes in the ref map (compressed messages left the array but keep
 * their refs) and insert mid-array summary nodes with fresh HIGH refs; ref
 * contiguity fragments every range there and emits startRef > endRef pairs.
 * Unrefed / BLOCKED entries consume no slot. Dense append-only hosts: both
 * rules coincide, so behavior is byte-identical to the old merge.
 */
export function segmentGroups<T extends SegmentItem>(
  items: readonly T[],
): T[][] {
  const groups: T[][] = [];
  let cur: T[] | null = null;
  for (const item of items) {
    if (cur !== null && ((item.isUser && cur.length >= 3) || item.gapBefore)) {
      groups.push(cur);
      cur = null;
    }
    if (cur === null) cur = [item];
    else cur.push(item);
  }
  if (cur !== null) groups.push(cur);
  return groups;
}
