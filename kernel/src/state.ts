import type {
  CompressionBlock,
  CompressionState,
  CoreMessage,
} from "./types.js";

export function createInitialState(): CompressionState {
  return {
    blocks: [],
    messageRefs: { byRaw: {}, byRef: {} },
    tokenSnapshot: {},
    nudge: {
      lastPerMessageNudgeTokens: 0,
      lastNudgeShownTokens: 0,
      baselineTokens: 0,
      anchors: {},
      lastShownByTier: {},
    },
    stats: {
      tokensCompressed: 0,
      compressionCount: 0,
      absorbedTokens: 0,
      imagesShrunk: 0,
      imageBytesSaved: 0,
      imageTokensSaved: 0,
      storedCount: 0,
      retrievalCount: 0,
    },
    absorbed: [],
    rules: [],
    nextRuleId: 1,
    imageFullRestored: [],
    imageShrinks: [],
    nextBlockId: 1,
    nextRunId: 1,
  };
}

export function allocateBlockId(state: CompressionState): string {
  const id = state.nextBlockId;
  state.nextBlockId = Math.max(1, id) + 1;
  return `b${id}`;
}

export function allocateRunId(state: CompressionState): string {
  const id = state.nextRunId;
  state.nextRunId = Math.max(1, id) + 1;
  return `r${id}`;
}

export function blockById(
  state: CompressionState,
  blockId: string,
): CompressionBlock | undefined {
  return state.blocks.find((block) => block.blockId === blockId);
}

export function activeBlocks(state: CompressionState): CompressionBlock[] {
  return state.blocks.filter((block) => block.active);
}

export function coveredMessageIds(state: CompressionState): Set<string> {
  const covered = new Set<string>();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) covered.add(id);
  }
  return covered;
}

/** #2663: single source of truth for "live host checkpoint carrier" (#335) —
 *  a message that renders the visible summary of a still-active block. The
 *  selector (recommend.ts) and the applier (compress.ts) must judge this with
 *  the SAME predicate or they advertise spans the apply side structurally
 *  rejects (a plain range bridging a live carrier resolves to zero foldable
 *  messages once the covering block is consumed). Stale carriers — block
 *  inactive or id unknown — are NOT live and fold like ordinary messages. */
export function isLiveCheckpointCarrier(
  message: Pick<CoreMessage, "summaryOfBlockId">,
  state: CompressionState,
): boolean {
  const carrierOf = message.summaryOfBlockId;
  return carrierOf !== undefined && blockById(state, carrierOf)?.active === true;
}

export function highestActiveTier(state: CompressionState): 0 | 1 | 2 | 3 {
  let highest: 0 | 1 | 2 | 3 = 0;
  for (const block of state.blocks) {
    if (block.active && block.tier > highest) highest = block.tier;
  }
  return highest;
}

export function advanceSurvival(
  state: CompressionState,
  promotionThreshold: number,
): void {
  for (const block of state.blocks) {
    if (!block.active) continue;
    block.survivedCount += 1;
    if (block.survivedCount >= promotionThreshold) {
      block.generation = "old";
    }
  }
}
