import { activeBlocks, blockById, isLiveCheckpointCarrier } from "./state.js";
import { resolveBoundaries, blockVisibleInRange } from "./boundaries.js";
import { isSummaryMessageId } from "./prune.js";
import {
  collectFailedCompressCallIds,
  collectLatestProtected,
  hasUnrecoverableMediaPayload,
  isMessageLatestProtected,
  isMessageProtected,
  collectAgedCompressCallIds,
} from "./protected.js";
import { computeIntegrityWithdrawals } from "./turn-integrity.js";
import { adjustBoundariesForReasoningPairs } from "./reasoning-pairs.js";
import { adjustBoundariesForToolPairs } from "./tool-pairs.js";
import type {
  CompressionState,
  CompressionTier,
  Config,
  CoreMessage,
} from "./types.js";

/**
 * #3236: the ONE definition of "can this range fold" — the exact sequence
 * applySingleRange runs before it creates a block: boundary resolution →
 * checkpoint-carrier exclusion (#335/#2663) → pair-boundary widening
 * (tool/reasoning pairs) → nested-block rescan → protected-tool/media/zone
 * carves → turn-integrity withdrawal (#684) → empty check.
 *
 * Before this module existed the recommendation side re-implemented parts of
 * that judgment with a DIFFERENT input scope: global integrity screening over
 * ALL compressible messages at once (so a turn whose partners sit in another
 * advertised unit passed screening), while apply judges each SUBMITTED range
 * alone and throws when its carves split a turn or empty the fold. Production
 * result: acp_status / nudge advertised ranges that every submission rejected
 * with "Range would split N turn(s)" — a permanent advertise/reject loop.
 *
 * Now both sides run this one function on the same array class (the exact
 * array applyCompression executes on — see ProcessTurnInput.applyView). Apply
 * consumes the full projection and throws the carried Error verbatim; the
 * recommendation side uses it as a screen and demotes doomed units to gaps;
 * the acp_status uncompressed view flags rows whose projection is fatal.
 * Swapping any single carve criterion (dead ref, live carrier, media,
 * protected tools, zone, turn integrity) therefore changes advertise and
 * execute together — the #2663 acceptance criterion.
 */
export interface UnitProjectionInput {
  /** The EXACT message array class applyCompression will run on for this
   * lane (the unpruned log when the render view differs from it). */
  messages: CoreMessage[];
  state: CompressionState;
  config: Config;
  startRef: string;
  endRef: string;
  /** Raw ids already covered by active blocks BEFORE this unit folds
   * (apply computes one such set per call; recommend passes the current one). */
  preExistingCoverage: Set<string>;
  /** REF ids (mNNNNN) of the soft-protection zone, computed on `messages` —
   * apply derives them from its own input array via computeProtectedRefs. */
  protectedMessageIds?: Set<string>;
  /** Warnings are pushed here in apply's original emission order so the
   * apply-side refactor stays byte-identical. Omit for read-only screens. */
  warnings?: string[];
}

export interface UnitProjectionFatal {
  kind: "zone" | "split";
  error: Error;
}

export interface UnitProjection {
  /** Non-null when applySingleRange would THROW for this unit (and which
   * error, fully constructed). Null = the unit folds, possibly with warnings. */
  fatal: UnitProjectionFatal | null;
  rangeMessageIds: string[];
  skippedCarrierIds: string[];
  nestedBlockIds: string[];
  consumedBlockIds: string[];
  effectiveMessageIds: Set<string>;
  directMessageIds: string[];
  filteredIds: string[];
  withdrawnIds: Set<string>;
  splitTurnCount: number;
  splitPairCount: number;
  targetTier: CompressionTier;
  outputTier: CompressionTier;
  isBlockBoundary: boolean;
}

/** Read-only projection of one candidate range through the full apply
 * sequence. Never mutates `state`; never creates blocks. Throws
 * BoundaryNotFoundError when an endpoint ref cannot be resolved. */
export function projectUnit(input: UnitProjectionInput): UnitProjection {
  const warnings = input.warnings ?? [];
  // Declared up front: every exit path (including the zone fatal below)
  // assembles the result through finish(), which reads these bindings.
  let withdrawnIds = new Set<string>();
  let splitTurnCount = 0;
  let splitPairCount = 0;

  const resolved = resolveBoundaries({
    startRef: input.startRef,
    endRef: input.endRef,
    messages: input.messages,
    state: input.state,
  });

  // Host checkpoint carriers (#335): a host that renders its own compression
  // summaries marks each carrier with `summaryOfBlockId`. A plain message-ref
  // range does not go through the block-distillation path, so folding a live
  // carrier would silently drop the previous distillation from the visible
  // context while the result reports nothing superseded. Keep carriers of
  // still-active blocks visible; stale carriers (block already consumed, or
  // unknown id) fold like ordinary messages. Block-ref boundaries deliberately
  // distill across checkpoints and keep folding carriers.
  const plainRange = resolved.boundaryKind !== "block";
  const liveCarrierIds = new Set<string>();
  if (plainRange) {
    // #2663: the selector screens with this same predicate — one definition,
    // two call sites, so advertise/validate cannot drift apart again.
    for (const message of input.messages) {
      if (isLiveCheckpointCarrier(message, input.state)) {
        liveCarrierIds.add(message.id);
      }
    }
  }
  const adjustedIds = applyPairBoundaryAdjustments(resolved, input.messages);
  const skippedCarrierIds = adjustedIds.filter((id) => liveCarrierIds.has(id));
  if (skippedCarrierIds.length > 0) {
    warnings.push(
      `Excluded ${skippedCarrierIds.length} checkpoint message(s) ${skippedCarrierIds.join(
        ", ",
      )} from the compression range — they carry the visible summary of still-active block(s), which a plain message-ref range does not supersede. The checkpoints stay visible; to fold them, reference the block ids (bN..bM) instead.`,
    );
  }
  const rangeMessageIds = adjustedIds.filter(
    (id) => !isSummaryMessageId(id) && !liveCarrierIds.has(id),
  );

  // Re-scan for nested blocks in the ADJUSTED range (tool-pair extension may
  // have pulled in messages that are anchors of existing blocks).
  if (rangeMessageIds.length > resolved.messageIds.length) {
    const indexByMessageId = new Map<string, number>();
    input.messages.forEach((m, i) => indexByMessageId.set(m.id, i));
    const adjustedStart =
      rangeMessageIds.length > 0
        ? (indexByMessageId.get(rangeMessageIds[0]!) ?? resolved.startIndex)
        : resolved.startIndex;
    const adjustedEnd =
      rangeMessageIds.length > 0
        ? (indexByMessageId.get(rangeMessageIds[rangeMessageIds.length - 1]!) ??
          resolved.endIndex)
        : resolved.endIndex;
    const nestedSeen = new Set(resolved.nestedBlockIds);
    for (const block of activeBlocks(input.state)) {
      if (nestedSeen.has(block.blockId)) continue;
      if (
        blockVisibleInRange(block, indexByMessageId, adjustedStart, adjustedEnd)
      ) {
        nestedSeen.add(block.blockId);
        resolved.nestedBlockIds.push(block.blockId);
      }
    }
  }

  const isBlockBoundary = resolved.boundaryKind === "block";
  const targetTier = resolveTargetTier(
    input.state,
    resolved.nestedBlockIds,
    isBlockBoundary,
  );
  const outputTier = isBlockBoundary
    ? (Math.min(3, targetTier + 1) as CompressionTier)
    : 1;

  const consumedBlockIds = resolved.nestedBlockIds.filter((id) => {
    const block = blockById(input.state, id);
    return block?.active && block.tier === targetTier;
  });

  const effectiveMessageIds = new Set<string>(rangeMessageIds);
  for (const consumedId of consumedBlockIds) {
    const consumed = blockById(input.state, consumedId);
    if (consumed) {
      for (const id of consumed.effectiveMessageIds)
        effectiveMessageIds.add(id);
    }
  }

  const directMessageIds = [...effectiveMessageIds].filter(
    (id) => !input.preExistingCoverage.has(id),
  );

  let filteredIds = filterProtectedToolMessages(
    directMessageIds,
    input.messages,
    input.config,
  );

  // filterProtectedToolMessages drops protected tool calls (and their paired
  // results) from the compressible set. They must also leave effectiveMessageIds,
  // otherwise the block would record them as covered and hide them from view.
  // (Bug 39: protected tool messages folded into a block.)
  if (filteredIds.length < directMessageIds.length) {
    const kept = new Set(filteredIds);
    for (const id of directMessageIds) {
      if (!kept.has(id)) effectiveMessageIds.delete(id);
    }
  }

  const mediaExcluded = directMessageIds.filter((id) => {
    const msg = input.messages.find((m) => m.id === id);
    return !!msg && hasUnrecoverableMediaPayload(msg);
  });
  if (mediaExcluded.length > 0) {
    warnings.push(
      `Excluded ${mediaExcluded.length} message(s) carrying unrecoverable media (remote URL / file references with no stored bytes) from compression range — folding would destroy them permanently (billion-context#1188/#2609). Inline images fold normally and stay restorable via decompress({ imageRef }).`,
    );
  }

  // SOFT PROTECTION: the recent-N / last-user-message zone is advisory-only at
  // compress time. Instead of failing the whole range when it brushes protected
  // messages, exclude those messages and proceed with the rest (so the model
  // isn't blocked when it picks a range that slightly overlaps the recent
  // window). If excluding them empties the range entirely AND there are no
  // consumed blocks to merge, we still fail — there is genuinely nothing to
  // compress. `protectedMessageIds` holds REF ids (mNNNNN) from
  // computeProtectedRefs; filteredIds holds RAW message ids, so convert via
  // state.messageRefs.byRaw before testing membership.
  const protectedRefs = input.protectedMessageIds;
  const hitProtectedRaw = protectedRefs
    ? filteredIds.filter((id) => {
        const ref = input.state.messageRefs.byRaw[id];
        return ref !== undefined && protectedRefs.has(ref);
      })
    : [];
  if (hitProtectedRaw.length > 0) {
    const protectedSet = new Set(hitProtectedRaw);
    // #3953: a protected message INTERIOR to the range means the fold would
    // also cover messages that come AFTER it — typically the assistant
    // replies to the protected user message — while the summary anchor lands
    // at the earliest covered position, i.e. BEFORE the question it answers.
    // Truncate the fold at the first protected message instead of carving a
    // hole: everything from that position on (protected and post-protected
    // alike) stays visible and causality holds. A protected message at the
    // range TAIL (the advisory recent-zone brush this carve was built for)
    // has nothing after it inside the range — truncation is a no-op there.
    const firstProtectedIdx = filteredIds.findIndex((id) => protectedSet.has(id));
    let truncatedAfter = 0;
    if (firstProtectedIdx >= 0) {
      const truncatable = filteredIds.length - firstProtectedIdx - hitProtectedRaw.length;
      // Truncate only when the truncated prefix still has work to do AND the
      // cut does not strand a tool call/result pair across it (kept call,
      // dropped result or vice versa — the #684 gate would either fatal at
      // the protected-zone boundary or force a withdrawal the advisory carve
      // was never designed for). When truncation would empty the range or
      // split a pair (protected ids at the HEAD — e.g. absorb-context
      // protection around an absorbed pair), keep the advisory carve
      // semantics: fold what remains, exactly as before (#3953 changes
      // nothing there; the zone fatal below still fires only when even the
      // carve empties the range).
      const pairByCallId = new Map<string, [string, string]>();
      for (const m of input.messages) {
        if (m.contentType === "tool-call" || m.contentType === "tool-result") {
          const key = m.toolCallId ?? m.id;
          const pair = pairByCallId.get(key) ?? ["", ""];
          if (m.contentType === "tool-call") pair[0] = m.id; else pair[1] = m.id;
          pairByCallId.set(key, pair);
        }
      }
      const keptIds = filteredIds.slice(0, firstProtectedIdx);
      const droppedIds = filteredIds.slice(firstProtectedIdx);
      const strandsPair = keptIds.some((id) => {
        const m = input.messages.find((x) => x.id === id);
        if (!m || (m.contentType !== "tool-call" && m.contentType !== "tool-result")) return false;
        const pair = pairByCallId.get(m.toolCallId ?? m.id);
        return !!pair && pair.some((half) => half !== "" && half !== id && droppedIds.includes(half));
      });
      if (truncatable > 0 && firstProtectedIdx > 0 && !strandsPair) {
        truncatedAfter = truncatable;
        filteredIds = keptIds;
        for (const id of droppedIds) effectiveMessageIds.delete(id);
      }
    }
    filteredIds = filteredIds.filter((id) => !protectedSet.has(id));
    // Remove protected messages from effective coverage too, so they are NOT
    // hidden by the new block (they must stay fully visible).
    for (const id of hitProtectedRaw) effectiveMessageIds.delete(id);

    const hitRefs = hitProtectedRaw
      .map((id) => input.state.messageRefs.byRaw[id])
      .filter((v): v is string => typeof v === "string");

    if (filteredIds.length === 0 && consumedBlockIds.length === 0) {
      const recentN = input.config.preserveRecentMessages;
      return finish({
        fatal: {
          kind: "zone",
          error: new Error(
            `Range is entirely within the protected zone (the last ${recentN} messages and/or the most recent user message): ${hitRefs.join(
              ", ",
            )}. Adjust startId/endId to older messages.`,
          ),
        },
      });
    }
    warnings.push(
      `Excluded ${hitProtectedRaw.length} protected message(s) ${hitRefs.join(
        ", ",
      )} from compression range (recent/last-user zone) — they stay visible outside the new block; do not target them in another compress call.` +
        (truncatedAfter > 0
          ? ` Range truncated at that boundary — ${truncatedAfter} later message(s) (including replies to the protected message) stay visible too, so no summary can land above the question it answers (#3953).`
          : ""),
    );
  }

  // TURN-INTEGRITY GATE (#684): the protected carve above (and the protected
  // tool filter before it) remove individual messages AFTER
  // applyPairBoundaryAdjustments completed the range, which can split a turn.
  // The DIRECTIONAL invariant that strict-echo providers enforce: an assistant
  // tool-call message that survives the fold must keep its reasoning run
  // (DeepSeek thinking mode: "reasoning_content ... must be passed back").
  // The reverse split — reasoning + text kept while the call and result fold —
  // leaves a valid message stream and stays allowed (#564 depends on it), so
  // only turns whose KEPT side carries a tool-call while the FOLDED side
  // carries the reasoning are withdrawn, entirely (all members stay visible).
  // The same carve can also strip a call and its result onto opposite sides of
  // the fold. Either half alone is invalid — a visible call whose result folded
  // is an unanswered tool_call_id, a visible result whose call folded answers
  // nothing — so those pairs are withdrawn together, both halves staying
  // visible. Whole pairs may still fold while the turn's reasoning and text
  // stay visible (#564).
  //
  // Both invariants are re-checked to a fixed point inside
  // computeIntegrityWithdrawals: withdrawing a pair for the result half can
  // strand a turn whose reasoning still folds and whose call now stays visible.
  {
    // #4484/#3322: on a MERGE (this unit consumes existing blocks) the integrity
    // gate needs two things a fresh fold does not. (a) Judge POST-FOLD coverage —
    // this unit's ids PLUS every still-active sibling block's coverage — so a tool
    // half already covered by an unconsumed sibling reads as folded, not a spurious
    // "visible" half (#3322 withdrew inherited coverage for exactly this reason).
    // (b) Never drop an id whose ONLY covering block is consumed here: those blocks
    // deactivate below, so removing their id strands it uncovered — the regression
    // the host pre-commit guard then refuses (#4484). We therefore unfold only ids
    // whose coverage does not depend on a consumed block, re-checking to a fixed
    // point; if consistency would force unfolding such an id we fail honestly rather
    // than emit a doomed regressive candidate. Fresh folds keep the legacy behavior.
    const isMerge = consumedBlockIds.length > 0;
    let consumedCoverage = new Set<string>();
    let survivingCoverage = new Set<string>();
    if (isMerge) {
      const consumedSet = new Set(consumedBlockIds);
      for (const block of activeBlocks(input.state)) {
        const target = consumedSet.has(block.blockId)
          ? consumedCoverage
          : survivingCoverage;
        for (const id of block.effectiveMessageIds) target.add(id);
      }
    }
    let foldedRef = effectiveMessageIds;
    if (isMerge) {
      foldedRef = new Set(effectiveMessageIds);
      for (const id of survivingCoverage) foldedRef.add(id);
    }
    const initial = computeIntegrityWithdrawals(input.messages, foldedRef);
    splitTurnCount = initial.splitTurnCount;
    splitPairCount = initial.splitPairCount;
    if (initial.withdrawn.size > 0) {
      const splitDesc = [
        splitTurnCount > 0 ? `${splitTurnCount} turn(s)` : null,
        splitPairCount > 0 ? `${splitPairCount} tool call/result pair(s)` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" and ");
      if (!isMerge) {
        withdrawnIds = initial.withdrawn;
        for (const id of initial.withdrawn) effectiveMessageIds.delete(id);
        const beforeWithdraw = filteredIds.length;
        filteredIds = filteredIds.filter((id) => !initial.withdrawn.has(id));
        if (filteredIds.length === 0 && consumedBlockIds.length === 0) {
          return finish({
            fatal: {
              kind: "split",
              error: new Error(
                `Range would split ${splitDesc} at the protected-zone boundary: a visible tool-call must keep its reasoning run and its results (strict providers reject a rebuilt request that lost either). Shrink the range to end before the turn starts, or wait until the whole turn ages out of the protected zone.`,
              ),
            },
          });
        }
        warnings.push(
          `Withdrawn ${beforeWithdraw - filteredIds.length} message(s) from compression range to keep ${splitDesc} intact (visible tool-call would lose its reasoning run or its results).`,
        );
      } else {
        const unfoldable = new Set<string>(
          [...effectiveMessageIds].filter((id) => !consumedCoverage.has(id)),
        );
        const unfolded = new Set<string>();
        let current = initial.withdrawn;
        let guard = unfoldable.size + 2;
        let stuck = false;
        while (current.size > 0 && guard-- > 0) {
          let progress = false;
          for (const id of current) {
            if (unfoldable.has(id) && !unfolded.has(id)) {
              unfolded.add(id);
              progress = true;
            }
          }
          if (!progress) {
            stuck = true;
            break;
          }
          const recheck = new Set(effectiveMessageIds);
          for (const id of unfolded) recheck.delete(id);
          for (const id of survivingCoverage) recheck.add(id);
          current = computeIntegrityWithdrawals(input.messages, recheck).withdrawn;
        }
        if (stuck || current.size > 0) {
          const sample = [...consumedCoverage].slice(0, 5).join(", ");
          return finish({
            fatal: {
              kind: "split",
              error: new Error(
                `Merging ${consumedBlockIds.join(", ")} cannot satisfy turn integrity without unfolding already-folded message(s) owned by those blocks (${sample}) — doing so would drop their existing coverage. Align the range to whole turns (do not cut through a reasoning/tool-call/result group) or merge fewer blocks.`,
              ),
            },
          });
        }
        withdrawnIds = unfolded;
        for (const id of unfolded) effectiveMessageIds.delete(id);
        const beforeWithdraw = filteredIds.length;
        filteredIds = filteredIds.filter((id) => !unfolded.has(id));
        warnings.push(
          `Withdrew ${beforeWithdraw - filteredIds.length} newly-folded message(s) from the merge to keep ${splitDesc} intact while preserving the existing coverage of ${consumedBlockIds.join(", ")}.`,
        );
      }
    }
  }

  return finish({ fatal: null });

  function finish(
    partial: Pick<UnitProjection, "fatal">,
  ): UnitProjection {
    return {
      ...partial,
      rangeMessageIds,
      skippedCarrierIds,
      nestedBlockIds: [...resolved.nestedBlockIds],
      consumedBlockIds,
      effectiveMessageIds,
      directMessageIds,
      filteredIds,
      withdrawnIds,
      splitTurnCount,
      splitPairCount,
      targetTier,
      outputTier,
      isBlockBoundary,
    };
  }
}

/** Union of the raw ids covered by all active blocks — the set apply treats
 * as "already folded" before a new spec runs (one per applyCompression call). */
export function collectCoverage(state: CompressionState): Set<string> {
  const coverage = new Set<string>();
  for (const block of activeBlocks(state)) {
    for (const id of block.effectiveMessageIds) coverage.add(id);
  }
  return coverage;
}

function applyPairBoundaryAdjustments(
  resolved: {
    startIndex: number;
    endIndex: number;
    messageIds: string[];
    boundaryKind: string;
  },
  messages: CoreMessage[],
): string[] {
  if (resolved.boundaryKind === "block") {
    return resolved.messageIds;
  }
  // Compose tool-pair and reasoning-pair boundary adjustments to a fixpoint
  // (≤2 passes). Reasoning may pull in a tool-call whose result tool-pairs
  // then extends for; tool-pairs may pull in a tool-call whose preceding
  // reasoning is then drawn in. Both only ever WIDEN the range.
  let startIndex = resolved.startIndex;
  let endIndex = resolved.endIndex;
  for (let pass = 0; pass < 2; pass++) {
    const reasoningAdjusted = adjustBoundariesForReasoningPairs(
      startIndex,
      endIndex,
      messages,
    );
    const toolAdjusted = adjustBoundariesForToolPairs(
      reasoningAdjusted.startIndex,
      reasoningAdjusted.endIndex,
      messages,
    );
    const changed =
      toolAdjusted.startIndex !== startIndex ||
      toolAdjusted.endIndex !== endIndex;
    startIndex = toolAdjusted.startIndex;
    endIndex = toolAdjusted.endIndex;
    if (!changed) break;
  }
  if (startIndex === resolved.startIndex && endIndex === resolved.endIndex) {
    return resolved.messageIds;
  }
  const ids: string[] = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const msg = messages[i];
    if (msg) ids.push(msg.id);
  }
  return ids;
}

function filterProtectedToolMessages(
  directMessageIds: string[],
  messages: CoreMessage[],
  config: Config,
): string[] {
  // Protected tool calls (and their results, paired by toolCallId) stay in
  // visible context and are simply dropped from the compressible set. They are
  // NOT folded into the summary — the summary reflects what the author wrote,
  // nothing auto-appended.
  // #4289: failed compress exchanges (result = "[Compression FAILED…", zero
  // ranges applied) are NOT protected — they are dead drafts that must stay
  // foldable so a failing compress loop cannot permanently bloat context.
  const failedCompressCallIds = collectFailedCompressCallIds(messages, config);
  const protectedCallIds = new Set<string>();
  const removedIds = new Set<string>();
  const latest = collectLatestProtected(messages, config);
  // #4348: compress exchanges older than the newest few lose the hard-coded
  // ALWAYS_PROTECTED_TOOLS exemption inside the FOLD path — their receipts
  // are exhaust and the summaries live on in block anchors. Newest exchanges
  // keep it (working memory). The lift overrides host protection patterns for
  // recognized compress dialects too — required, since the MCP lane's
  // hard-protection hook would otherwise pin mcp__bili__compress forever;
  // host patterns for all other tools are unaffected.
  const agedCompressCallIds = collectAgedCompressCallIds(messages, config);
  const isExemptFold = (msg: CoreMessage): boolean =>
    !!msg.toolCallId && agedCompressCallIds.has(msg.toolCallId);
  for (const id of latest.callIds) protectedCallIds.add(id);
  for (const msg of messages) {
    if (
      isMessageProtected(msg, config, failedCompressCallIds) &&
      msg.toolCallId &&
      !isExemptFold(msg)
    ) {
      protectedCallIds.add(msg.toolCallId);
    }
  }

  for (const id of directMessageIds) {
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (
      hasUnrecoverableMediaPayload(msg) ||
      (isMessageProtected(msg, config, failedCompressCallIds) &&
        !isExemptFold(msg)) ||
      isMessageLatestProtected(msg, latest)
    ) {
      removedIds.add(id);
      if (msg.toolCallId) protectedCallIds.add(msg.toolCallId);
    }
  }

  for (const id of directMessageIds) {
    if (removedIds.has(id)) continue;
    const msg = messages.find((m) => m.id === id);
    if (!msg) continue;
    if (
      msg.contentType === "tool-result" &&
      msg.toolCallId &&
      protectedCallIds.has(msg.toolCallId)
    ) {
      removedIds.add(id);
    }
  }

  return directMessageIds.filter((id) => !removedIds.has(id));
}

function resolveTargetTier(
  state: CompressionState,
  nestedBlockIds: string[],
  isBlockBoundary: boolean,
): CompressionTier {
  if (!isBlockBoundary) return 1;
  if (nestedBlockIds.length === 0) return 1;
  let minTier: CompressionTier = 3;
  for (const id of nestedBlockIds) {
    const block = blockById(state, id);
    if (block && block.tier < minTier) minTier = block.tier;
  }
  return minTier;
}
