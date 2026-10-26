import { orderedRefPair } from "./refs.js";
import type {
  BlockSpan,
  CompressionBlock,
  CompressionState,
  MessageRefMap,
} from "./types.js";

function refNum(ref: string): number {
  const m = ref.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

const M_REF = /^m\d+$/;

/** Resolve a block's current ref span. Prefers the stored startRef/endRef
 *  (assigned at creation from the requested range); falls back to the
 *  min/max of effectiveMessageIds' refs for blocks persisted before those
 *  fields existed. Stored refs are only trusted when both are message refs —
 *  block-boundary specs (startId "bN") are stored verbatim on tier-distilled
 *  blocks and must not render as spans. Returns null when nothing resolves. */
export function resolveBlockSpan(
  block: CompressionBlock,
  byRaw: MessageRefMap["byRaw"],
): { startRef: string; endRef: string } | null {
  if (
    block.startRef &&
    block.endRef &&
    M_REF.test(block.startRef) &&
    M_REF.test(block.endRef)
  ) {
    // Stored specs keep the caller's direction; spans are display data, so
    // canonicalize to ascending labels (#2168).
    const [startRef, endRef] = orderedRefPair(block.startRef, block.endRef);
    return { startRef, endRef };
  }
  const refs = block.effectiveMessageIds
    .map((id) => byRaw[id])
    .filter((r): r is string => typeof r === "string" && r !== "BLOCKED");
  if (refs.length === 0) return null;
  const sorted = [...refs].sort((a, b) => refNum(a) - refNum(b));
  return { startRef: sorted[0]!, endRef: sorted[sorted.length - 1]! };
}

export function activeBlockSpans(state: CompressionState): BlockSpan[] {
  const spans: BlockSpan[] = [];
  for (const block of state.blocks) {
    if (!block.active) continue;
    const span = resolveBlockSpan(block, state.messageRefs.byRaw);
    if (!span) continue;
    spans.push({ blockId: block.blockId, tier: block.tier, ...span });
  }
  return spans;
}

/** Format newly created blocks for tool-result display, e.g.
 *  `blocks: b3=m00044–m00097, b4=m00103–m00123`. Adapters append this to their
 *  compress result line so the model's block ledger comes from the kernel
 *  instead of being inferred from its own arguments (#376). Empty string when
 *  no blocks were created. */
export function formatCreatedBlocks(
  state: CompressionState,
  newBlocks: CompressionBlock[],
): string {
  const parts: string[] = [];
  for (const block of newBlocks) {
    const span = resolveBlockSpan(block, state.messageRefs.byRaw);
    parts.push(
      span ? `${block.blockId}=${span.startRef}–${span.endRef}` : block.blockId,
    );
  }
  return parts.length > 0 ? `blocks: ${parts.join(", ")}` : "";
}
