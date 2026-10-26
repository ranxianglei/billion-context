import { baseIdOf, summaryMessageId } from "./prune.js";
import type { CompressionState, CoreMessage } from "./types.js";

/** #4316 layer 3: true when any visible message's ledgerSeq stamp falls
 * inside the block's exact interval claim. Unbounded blocks and unstamped
 * views answer false — the id path decides those. The -1/-1 "no claim"
 * sentinel (PR #4725 N1) also answers false: it is absence of evidence, not
 * a positional claim (a [0,0] row IS a real claim over seq 0). */
function blockSeqPresent(
  block: { startSeq?: number; endSeq?: number },
  messages: CoreMessage[],
): boolean {
  if (
    typeof block.startSeq !== "number" ||
    typeof block.endSeq !== "number" ||
    block.startSeq < 0 ||
    block.endSeq < block.startSeq
  ) {
    return false;
  }
  for (const message of messages) {
    const seq = message.ledgerSeq;
    if (
      typeof seq === "number" &&
      Number.isInteger(seq) &&
      seq >= block.startSeq &&
      seq <= block.endSeq
    ) {
      return true;
    }
  }
  return false;
}

export interface SyncResult {
  state: CompressionState;
  deactivated: string[];
}

export function syncBlocks(
  messages: CoreMessage[],
  state: CompressionState,
): SyncResult {
  const presentIds = new Set(messages.map((message) => message.id));
  const presentBases = new Set<string>();
  // Subid coverage only applies to messages that actually carry a string id.
  // Id-less host-shaped entries were silently digested by every release
  // before 0.0.90 (presentIds merely held undefined and no has() ever
  // matched); baseIdOf would throw on them and hard-crash processTurn (#421).
  for (const message of messages) {
    if (typeof message.id === "string") presentBases.add(baseIdOf(message.id));
  }
  const deactivated: string[] = [];
  // Deep-clone (not just `{...state}`) so the caller's input state is never
  // mutated: processTurn stamps `state.nudge.*` and reassigns `messageRefs`,
  // and block sub-arrays must not alias the input. Previously nudge/stats/
  // messageRefs were shared references → input-state mutation leak.
  const result: CompressionState = {
    blocks: state.blocks.map((block) => ({
      ...block,
      directMessageIds: [...block.directMessageIds],
      effectiveMessageIds: [...block.effectiveMessageIds],
      directBlockIds: [...block.directBlockIds],
    })),
    messageRefs: {
      byRaw: { ...state.messageRefs.byRaw },
      byRef: { ...state.messageRefs.byRef },
    },
    // Snapshot is keyed by ref with primitive values — shallow copy suffices.
    tokenSnapshot: { ...(state.tokenSnapshot ?? {}) },
    nudge: { ...state.nudge, anchors: { ...state.nudge.anchors } },
    stats: { ...state.stats },
    absorbed: (state.absorbed ?? []).map((record) => ({ ...record })),
    rules: (state.rules ?? []).map((rule) => ({ ...rule })),
    nextRuleId: state.nextRuleId,
    terminalStreak: state.terminalStreak,
    nextBlockId: state.nextBlockId,
    nextRunId: state.nextRunId,
    deadRefs: state.deadRefs ? [...state.deadRefs] : undefined,
    // #3769 orphan-cleanup ledgers — same carry set as cloneState: dropping any
    // of these here would wipe them before the hide-compress-calls node reads
    // them (this node runs first), silently disabling both the fold-gated sweep
    // and the legacy hiddenOrphanRefs upgrade-compat clause every turn.
    hiddenOrphanRefs: state.hiddenOrphanRefs ? [...state.hiddenOrphanRefs] : undefined,
    sweptOrphanCallIds: state.sweptOrphanCallIds ? [...state.sweptOrphanCallIds] : undefined,
    pendingOrphanSweepMinRef: state.pendingOrphanSweepMinRef,
    // #3939 ③: the truncation latch must survive the sync node — dropping it
    // here would re-expose clipped bytes mid-history after a sync carried the
    // rest of the state (#3691 oscillation via the sync path).
    emergencyTruncateLatch: state.emergencyTruncateLatch
      ? state.emergencyTruncateLatch.map((e) => ({ ref: e.ref, text: e.text }))
      : undefined,
    // #3939 ②: the render deferral must survive sync — losing it would stamp
    // migration tags mid-history after a sync carried the ref map (#3805).
    renderDeferredRefs: state.renderDeferredRefs
      ? [...state.renderDeferredRefs]
      : undefined,
    // #3939 ⑤: the view latch must survive sync — losing it re-derives
    // transform output mid-history after a sync carried the state (#3805).
    viewLatches: state.viewLatches
      ? Object.fromEntries(
          Object.entries(state.viewLatches).map(([k, v]) => [k, { ...v }]),
        )
      : undefined,
    viewLatchConfigDigest: state.viewLatchConfigDigest,
  };

  // Refs are additive (assignRefs never removes them from messageRefs), so
  // prune the snapshot by currently-present message refs — otherwise it grows
  // unboundedly as messages are compressed/deleted across a long session.
  const liveRefs = new Set(
    messages
      .map((m) => result.messageRefs.byRaw[m.id])
      .filter((r): r is string => typeof r === "string"),
  );
  if (Object.keys(result.tokenSnapshot).length !== liveRefs.size) {
    const pruned: Record<string, number> = {};
    for (const [ref, n] of Object.entries(result.tokenSnapshot)) {
      if (liveRefs.has(ref)) pruned[ref] = n;
    }
    result.tokenSnapshot = pruned;
  }

  const consumedBlockIds = new Set<string>();
  for (const block of result.blocks) {
    for (const consumedId of block.directBlockIds) {
      consumedBlockIds.add(consumedId);
    }
  }

  for (const block of result.blocks) {
    if (consumedBlockIds.has(block.blockId)) {
      block.active = false;
      continue;
    }
    // Host-set `expanded` = the user explicitly decompressed this block, so its
    // deactivated state is intentional. Re-activating it here would re-fold the
    // already-restored messages next turn (double cost + lost originals). Keep
    // it inactive; a fresh compress of the same range creates a NEW block.
    if (block.expanded) {
      block.active = false;
      continue;
    }
    block.active = true;
    // A block whose raw messages were replaced by its rendered summary
    // (pruned view) is still present — the summary IS the block's visible
    // representation. Without this, hosts passing pruned views would lose
    // block activity every turn.
    // #4316 layer 3: a block with an exact ledger interval is also still
    // present when ANY visible message carries a ledgerSeq stamp inside the
    // interval — the host restored/re-stamped the originals (fresh ids, same
    // positions), and the positional claim survives the id churn that the
    // id-membership check above just missed.
    const stillPresent =
      block.effectiveMessageIds.some((id) => presentBases.has(baseIdOf(id))) ||
      presentIds.has(summaryMessageId(block.blockId)) ||
      blockSeqPresent(block, messages);
    if (!stillPresent) {
      block.active = false;
      deactivated.push(block.blockId);
    }
  }

  return { state: result, deactivated };
}
