/**
 * Recommendation engine — compression protection + recommendation.
 *
 * Clean-room reimplementation of the recommendation algorithm (MIT, ours).
 * These pure functions answer two questions every turn:
 *
 *  1. **Protection** — which messages must NOT be compressed? (protected tools,
 *     recent messages, recent tokens)
 *  2. **Recommendation** — which remaining ranges are actually WORTH compressing?
 *     (growth-aware threshold; suppress nudges when ranges are too small)
 *
 * Called by the `recommend` pipeline node. No side effects, no state mutation.
 */

import type {
  CompressibleRange,
  Config,
  ContextRanges,
  CoreMessage,
  ProtectedRange,
} from "./types.js";
import type { CompressionState } from "./types.js";
import { isToolMessage } from "./message-kind.js";
import { coveredMessageIds, isLiveCheckpointCarrier } from "./state.js";
import { SUMMARY_HEADER } from "./prune.js";
import {
  collectFailedCompressCallIds,
  collectLatestProtected,
  collectProtectedToolCallIds,
  hasUnrecoverableMediaPayload,
  isMessageLatestProtected,
  isMessageProtectedWithPairing,
  isNeverPreserveRecent,
} from "./protected.js";
import { computeTurnRetention } from "./turn-retention.js";
import { countMessageTokens } from "./tokenize.js";
import { computeIntegrityWithdrawals } from "./turn-integrity.js";
import { evaluateRefold } from "./refold.js";
import { segmentGroups } from "./segment.js";
import { projectUnit, collectCoverage } from "./unit-projection.js";
import { BoundaryNotFoundError } from "./boundaries.js";
import type { UnitProjection } from "./unit-projection.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default token estimate (chars/4) used when the caller doesn't inject a
 *  countTokens — preserves the historical behavior for backwards compat. */
function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Precompute the covered-id set once per call (#498): the old per-message
// `state.blocks.some(...)` scan made both recommend paths O(visible × blocks ×
// coverage). Exact-ID lookup is preserved — base-ID normalization is #234.
function isSyntheticOrPruned(
  message: CoreMessage,
  covered: Set<string>,
): boolean {
  if (message.text?.startsWith(SUMMARY_HEADER)) return true;
  return covered.has(message.id);
}

// ─── 1. Protected Refs (soft protection zone) ─────────────────────────────────

/**
 * Compute the set of protected message refs (mNNNNN) that form the
 * "soft-protected zone" at the tail of the conversation.
 *
 * Combines four rules:
 *   1. Last N messages (`config.preserveRecentMessages`)
 *   2. Last N tokens expanding backward (`config.preserveRecentTokens`)
 *   3. Last visible user message (couples to Rule 1)
 *   4. Per-turn retention (#4593): the last N user-initiated turns form a
 *      positional protected suffix (`config.preserveRecentTurns`; recomputed
 *      every turn — see turn-retention.ts). A submitted range overlapping it
 *      is carved there with an auditable receipt (like Rules 1-3); a range
 *      entirely inside it is rejected by projectUnit.
 *
 * Then closes the tool-pair gap (#2886): if either half of a (tool-call,
 * tool-result) pair is protected, both are. Without this, `neverPreserveRecentTools`
 * excludes list-matching results from `visible` while their paired call stays
 * protectable, so the zone can hold the call but not its result — the advisory
 * carve keeps the call visible and folds the result, stranding an orphan
 * function_call that strict Responses validators reject (HTTP 400).
 *
 * Only considers visible, non-synthetic, non-pruned messages that have refs.
 */
export function computeProtectedRefs(
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  countTokens: (text: string) => number = estimateTextTokens,
): Set<string> {
  const preserveN = config.preserveRecentMessages;
  const preserveTokens = config.preserveRecentTokens;
  const covered = coveredMessageIds(state);

  const result = new Set<string>();
  const visible: { ref: string; tokens: number }[] = [];

  for (const msg of messages) {
    if (isSyntheticOrPruned(msg, covered)) continue;
    // Exclude configured large-result tools from the recent-zone window.
    // These are big inline payloads (restorations, file bodies, command
    // output) that the model should be free to compress again immediately;
    // counting them toward the last-N window would make them un-compressible
    // and hide them from recommendations. The message stays fully visible —
    // this only affects protection scope.
    if (
      isNeverPreserveRecent(
        msg,
        config.neverPreserveRecentTools,
        config.preserveRecentTools,
      )
    )
      continue;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    visible.push({ ref, tokens: countMessageTokens(msg, countTokens) });
  }

  // Rule 1: last N messages
  if (preserveN > 0) {
    for (const m of visible.slice(-preserveN)) {
      result.add(m.ref);
    }
  }

  // Rule 2: last N tokens (expand backward from tail)
  if (preserveTokens > 0) {
    let tokenAccum = 0;
    for (
      let i = visible.length - 1;
      i >= 0 && tokenAccum < preserveTokens;
      i--
    ) {
      result.add(visible[i]!.ref);
      tokenAccum += visible[i]!.tokens;
    }
  }

  // Rule 3: last visible user message. Protected whenever recent-message
  // protection is on (preserveRecentMessages > 0) — this couples it to the
  // same switch as Rule 1, so setting preserveRecentMessages = 0 fully opts
  // out (needed by tests that compress the tail). Production defaultConfig
  // uses 5, so the last user message is always protected in practice.
  // Note: we scan the raw messages array (not `visible`) here so the last
  // user message is still found even when a decompress tool result was
  // skipped above — user intent is always protected regardless of recent
  // tool results.
  if (preserveN > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (msg.role !== "user" || isSyntheticOrPruned(msg, covered)) continue;
      const ref = state.messageRefs.byRaw[msg.id];
      if (ref && ref !== "BLOCKED") result.add(ref);
      break;
    }
  }

  // Rule 4 (#4593): per-turn retention — the last N user-initiated turns form
  // a positional protected suffix. Recomputed every turn (the window slides
  // with each new user message), which is why it lives here rather than in
  // the permanent BLOCKED-ref decision. Fewer than N+1 visible user messages
  // ⇒ the whole conversation is retained (boundaryIndex 0).
  {
    const retention = computeTurnRetention(messages, state, config);
    if (retention) {
      for (let i = retention.boundaryIndex; i < messages.length; i++) {
        const ref = state.messageRefs.byRaw[messages[i]!.id];
        if (ref && ref !== "BLOCKED") result.add(ref);
      }
    }
  }

  // #2886: close the tool-pair gap. neverPreserveRecentTools drops big-result
  // tools (read/bash/...) from `visible`, so a matching tool-result can never
  // enter the recent zone while its paired tool-call (unmatched name) can.
  // Rules 1/2 above may then protect the call but not the result; the advisory
  // carve keeps the call visible and folds the result, stranding an orphan
  // function_call that strict Responses validators reject (HTTP 400). Make the
  // zone symmetric per pair: if either half is protected, protect both. This is
  // monotonic (only adds refs), so it cannot shrink any previously-protected set.
  {
    const msgByRef = new Map<string, CoreMessage>();
    for (const m of messages) {
      const ref = m.id ? state.messageRefs.byRaw[m.id] : undefined;
      if (ref && ref !== "BLOCKED") msgByRef.set(ref, m);
    }
    const callRefByToolCallId = new Map<string, string>();
    const resultRefByToolCallId = new Map<string, string>();
    for (const m of messages) {
      if (!m.id || typeof m.toolCallId !== "string") continue;
      if (isSyntheticOrPruned(m, covered)) continue;
      const ref = state.messageRefs.byRaw[m.id];
      if (!ref || ref === "BLOCKED") continue;
      if (m.contentType === "tool-call") callRefByToolCallId.set(m.toolCallId, ref);
      else if (m.contentType === "tool-result") resultRefByToolCallId.set(m.toolCallId, ref);
    }
    for (const ref of [...result]) {
      const m = msgByRef.get(ref);
      if (!m || typeof m.toolCallId !== "string") continue;
      if (m.contentType === "tool-call") {
        const r = resultRefByToolCallId.get(m.toolCallId);
        if (r) result.add(r);
      } else if (m.contentType === "tool-result") {
        const c = callRefByToolCallId.get(m.toolCallId);
        if (c) result.add(c);
      }
    }
  }

  return result;
}

// ─── 2. Build Compressible + Protected Ranges ────────────────────────────────

/** Numeric part of a message ref ("m00005" → 5); null for non-m refs. */
function refNumber(ref: string): number | null {
  const m = /^m(\d+)$/i.exec(ref);
  return m ? Number(m[1]) : null;
}

/** True when a recorded-dead ref sits STRICTLY between two live ref numbers —
 *  the endpoints themselves are live (a dead endpoint can't be a compressible
 *  message), so only interior holes matter (#3192/#3205). */
function hasDeadRefBetween(
  deadRefNums: ReadonlySet<number>,
  lo: number,
  hi: number,
): boolean {
  for (const n of deadRefNums) if (n > lo && n < hi) return true;
  return false;
}

interface NoMergeTarget {
  startRef: string;
  endRef: string;
  startIndex?: number;
  endIndex?: number;
  noMergeBefore?: boolean;
}

/** #3192/#3205: tag every range that opens right after a dead-ref hole so the
 *  position-based mergers (mergeRangesToThreshold, formatRanges) cannot bridge
 *  across it — a dropped message leaves no array slot, so the hole has no index
 *  gap and position adjacency alone would re-emit one doomed span bracketing the
 *  dead ref. Runs over compressible + protected together so cross-type
 *  boundaries are covered too. */
function markNoMergeAcrossDeadHoles(
  ranges: NoMergeTarget[],
  deadRefNums: ReadonlySet<number>,
): void {
  if (deadRefNums.size === 0 || ranges.length < 2) return;
  const startPos = (r: NoMergeTarget): number =>
    r.startIndex ?? refNumber(r.startRef) ?? 0;
  const order = [...ranges].sort((a, b) => startPos(a) - startPos(b));
  for (let i = 1; i < order.length; i++) {
    const prevEnd = refNumber(order[i - 1]!.endRef);
    const curStart = refNumber(order[i]!.startRef);
    if (prevEnd === null || curStart === null) continue;
    const lo = Math.min(prevEnd, curStart);
    const hi = Math.max(prevEnd, curStart);
    if (hi - lo > 1 && hasDeadRefBetween(deadRefNums, lo, hi)) {
      order[i]!.noMergeBefore = true;
    }
  }
}

/**
 * Build compressible and protected range groups from the message list.
 *
 * Messages are classified into:
 *   - **compressible**: normal messages outside the protected zone
 *   - **protected**: messages from protected tools (e.g., skill, task)
 *   - **skipped**: covered by blocks, synthetic, or in the protected zone
 *
 * Compressible messages are grouped into contiguous ranges. The protected
 * zone (from `computeProtectedRefs`) splits groups — the unprotected head
 * survives as its own range.
 */
export function buildCompressibleRanges(
  messages: CoreMessage[],
  state: CompressionState,
  config: Config,
  protectedZoneRefs?: Set<string>,
  countTokens: (text: string) => number = estimateTextTokens,
  /** #2663: the array class the fold gate judges at apply time (the full
   *  resent log — compress.ts passes input.messages). Turn grouping and
   *  call/result pairing are array-dependent, so integrity withdrawal must be
   *  computed on it; screening on a pruned view withdraws different messages
   *  than apply does. Defaults to `messages` for direct callers. */
  integritySource?: CoreMessage[],
): ContextRanges {
  let compressibleMsgs: {
    id: string;
    ref: string;
    gapBefore: boolean;
    tokens: number;
    chars: number;
    isTool: boolean;
    isUser: boolean;
    index: number;
  }[] = [];
  const protectedMsgs: {
    ref: string;
    gapBefore: boolean;
    tokens: number;
    tools: string[];
    index: number;
  }[] = [];

  const covered = coveredMessageIds(state);

  // Pairing: a tool-result may carry only toolCallId (no toolName). Collect the
  // callIds of protected tool-calls first, then protect matching results too.
  const protectedCallIds = collectProtectedToolCallIds(messages, config);
  // #4289: failed compress exchanges (zero ranges applied) must be advertised
  // as compressible like ordinary messages — without this set their call half
  // stays "protected" here while assignRefs already gave it a foldable ref.
  const failedCompressCallIds = collectFailedCompressCallIds(messages, config);
  // Latest-only protected calls: their results are covered by the pairing
  // union; the calls themselves need the explicit check below (pairing only
  // matches tool-results).
  const latest = collectLatestProtected(messages, config);
  for (const id of latest.callIds) protectedCallIds.add(id);

  // Segmentation is array adjacency, never ref arithmetic: surface-replacing
  // hosts leave holes in the ref map (compressed messages leave the array, refs
  // stay assigned) and insert mid-array summary nodes with fresh HIGH refs —
  // ref arithmetic fragments every range there and emits startRef > endRef
  // pairs. Only a numbered-ref message physically skipped between two entries
  // interrupts; unrefed/BLOCKED consume no slot. On dense append-only hosts the
  // two rules coincide, so ranges are byte-identical to the old behavior.
  let skipSinceCompressible = false;
  let skipSinceProtected = false;
  let msgIndex = -1;
  // #3192/#3205: numeric set of recorded-dead refs. A dropped message leaves a
  // hole in the ref map that array-adjacency segmentation bridges, so we break
  // groups at those holes (checked right before each compressible push below).
  const deadRefNums = new Set<number>(
    (state.deadRefs ?? [])
      .map((ref) => refNumber(ref))
      .filter((n): n is number => n !== null),
  );
  let lastCompressibleRefNum: number | null = null;

  for (const msg of messages) {
    msgIndex++;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    if (isSyntheticOrPruned(msg, covered)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    // Live checkpoint carriers (#335/#2663): a message rendering the summary
    // of a still-active block sits outside that block's coverage on purpose
    // (it stays visible), so pruning keeps it and the apply side refuses to
    // fold it in a plain message-ref range (compress.ts live-carrier carve).
    // A span bridging over it drags the covering block in as consumed
    // coverage while every direct message gets carved out — zero foldable
    // messages, livelock guard throws every turn (#2638). Screen with the
    // SAME predicate the apply side uses, and treat it as a gap so no group
    // bridges across it. Stale carriers fold normally.
    if (isLiveCheckpointCarrier(msg, state)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    // Unrecoverable media (no stored bytes — remote URL / file refs) is
    // destroyed by folding with no restore behind it (#1188/#2609): never
    // advertised as compressible, and a gap so no range spans it. Archivable
    // inline images are compressible like text (#2607).
    if (hasUnrecoverableMediaPayload(msg)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    if (
      isMessageProtectedWithPairing(
        msg,
        config,
        protectedCallIds,
        failedCompressCallIds,
      ) ||
      isMessageLatestProtected(msg, latest)
    ) {
      protectedMsgs.push({
        ref,
        gapBefore: skipSinceProtected,
        tokens: countMessageTokens(msg, countTokens),
        tools: msg.toolName ? [msg.toolName] : [],
        index: msgIndex,
      });
      skipSinceProtected = false;
      skipSinceCompressible = true;
      continue;
    }

    if (protectedZoneRefs?.has(ref)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    // #3192/#3205: break the group at a dead-ref hole between this message and
    // the previous compressible one (a dropped message leaves no array slot, so
    // no earlier gap flag fires). Same level as covered/pruned/carrier gaps.
    const curRefNum = refNumber(ref);
    if (
      deadRefNums.size > 0 &&
      curRefNum !== null &&
      lastCompressibleRefNum !== null
    ) {
      const lo = Math.min(curRefNum, lastCompressibleRefNum);
      const hi = Math.max(curRefNum, lastCompressibleRefNum);
      if (hi - lo > 1 && hasDeadRefBetween(deadRefNums, lo, hi)) {
        skipSinceCompressible = true;
      }
    }
    compressibleMsgs.push({
      id: msg.id,
      ref,
      gapBefore: skipSinceCompressible,
      tokens: countMessageTokens(msg, countTokens),
      chars: (msg.text ?? "").length,
      isTool: isToolMessage(msg),
      isUser: msg.role === "user",
      index: msgIndex,
    });
    if (curRefNum !== null) lastCompressibleRefNum = curRefNum;
    skipSinceCompressible = false;
    skipSinceProtected = true;
  }

  // Foldability: the fold gate (src/compress.ts) withdraws every message whose
  // turn would lose its reasoning run or whose call/result pair it would split,
  // because the protected-zone carve removes individual messages after the
  // range is built. A residual range that brushes the zone can therefore hold
  // nothing the fold may take: it was advertised as compressible, and folding
  // it then failed with "Range would split N tool call/result pair(s)". Screen
  // the same messages out here so every advertised range is foldable, and treat
  // each removed message as a gap so no range spans it.
  // #2663: judge foldability on the same array class apply does (see the
  // `integritySource` parameter) — grouping/pairing are array-dependent.
  const unfoldedIds = computeIntegrityWithdrawals(
    integritySource ?? messages,
    new Set(compressibleMsgs.map((info) => info.id)),
  ).withdrawn;
  if (unfoldedIds.size > 0) {
    let gapPending = false;
    const kept: typeof compressibleMsgs = [];
    for (const info of compressibleMsgs) {
      if (unfoldedIds.has(info.id)) {
        gapPending = true;
        continue;
      }
      kept.push(gapPending ? { ...info, gapBefore: true } : info);
      gapPending = false;
    }
    compressibleMsgs = kept;
  }

  // Build compressible groups via the shared segmentation primitive (segment.ts):
  // split at real array gaps and at user messages once a group has >= 3 messages.
  // Splitting at user boundaries keeps each range aligned to roughly one turn.
  const compressible: CompressibleRange[] = [];
  for (const group of segmentGroups(compressibleMsgs)) {
    const first = group[0]!;
    const range: CompressibleRange = {
      startRef: first.ref,
      endRef: first.ref,
      startIndex: first.index,
      endIndex: first.index,
      count: 1,
      tokens: first.tokens,
      chars: first.chars,
      toolPct: first.isTool ? 100 : 0,
      textPct: first.isTool ? 0 : 100,
      userMsgs: first.isUser ? 1 : 0,
    };
    for (let i = 1; i < group.length; i++) {
      const info = group[i]!;
      range.endRef = info.ref;
      range.endIndex = info.index;
      range.count++;
      range.tokens += info.tokens;
      range.chars = (range.chars ?? 0) + info.chars;
      if (info.isUser) range.userMsgs = (range.userMsgs ?? 0) + 1;
      if (info.isTool) {
        range.toolPct = Math.round(
          (range.toolPct * (range.count - 1) + 100) / range.count,
        );
      } else {
        range.toolPct = Math.round(
          (range.toolPct * (range.count - 1)) / range.count,
        );
      }
      range.textPct = 100 - range.toolPct;
    }
    compressible.push(range);
  }

  // Build protected groups (contiguous)
  const protectedRanges: ProtectedRange[] = [];
  let pcur: ProtectedRange | null = null;

  for (const info of protectedMsgs) {
    if (pcur && info.gapBefore) {
      protectedRanges.push(pcur);
      pcur = null;
    }
    if (!pcur) {
      pcur = {
        startRef: info.ref,
        endRef: info.ref,
        count: 1,
        tokens: info.tokens,
        tools: [...info.tools],
        startIndex: info.index,
        endIndex: info.index,
      };
    } else {
      pcur.endRef = info.ref;
      pcur.endIndex = info.index;
      pcur.count++;
      pcur.tokens += info.tokens;
      for (const t of info.tools) {
        if (!pcur!.tools.includes(t)) pcur!.tools.push(t);
      }
    }
  }
  if (pcur) protectedRanges.push(pcur);

  markNoMergeAcrossDeadHoles([...compressible, ...protectedRanges], deadRefNums);

  return {
    compressible: compressible.filter((g) => g.tokens > 0),
    protected: protectedRanges,
  };
}

function mergeBatch(batch: CompressibleRange[]): CompressibleRange {
  const first = batch[0]!;
  const last = batch[batch.length - 1]!;
  const count = batch.reduce((s, r) => s + r.count, 0);
  const tokens = batch.reduce((s, r) => s + r.tokens, 0);
  const chars = batch.reduce((s, r) => s + rangeChars(r), 0);
  const toolPct = Math.round(
    batch.reduce((s, r) => s + r.toolPct * r.count, 0) / count,
  );
  const merged: CompressibleRange = {
    startRef: first.startRef,
    endRef: last.endRef,
    count,
    tokens,
    chars,
    toolPct,
    textPct: 100 - toolPct,
    userMsgs: batch.reduce((s, r) => s + (r.userMsgs ?? 0), 0),
  };
  if (first.startIndex !== undefined && last.endIndex !== undefined) {
    merged.startIndex = Math.min(...batch.map((r) => r.startIndex ?? Infinity));
    merged.endIndex = Math.max(...batch.map((r) => r.endIndex ?? -Infinity));
  }
  if (batch.some((r) => r.dangerous === true)) {
    merged.dangerous = true;
  }
  // #3192/#3205: carry the leading dead-hole boundary forward so downstream
  // position-based merging (formatRanges) still sees it after this batch is
  // re-emitted as a single range.
  if (first.noMergeBefore === true) merged.noMergeBefore = true;
  return merged;
}

/** Effective size of a range in characters — the unit the apply-side
 *  minCompressRange gate uses. Falls back to the historical tokens*4
 *  estimate only for hand-built ranges that predate the `chars` field. */
function rangeChars(r: CompressibleRange): number {
  return r.chars ?? r.tokens * 4;
}

/** Merge adjacent ranges into batches that clear `minChars` of REAL text —
 *  the same accounting `applyCompression` uses — so a recommended range is
 *  never below the threshold the kernel would atomically reject. Batching by
 *  token estimates (tokens*4) instead broke whenever the host injected a
 *  tokenizer where tokens != chars/4 (CJK-aware estimators are ~1:1, so
 *  tokens*4 overestimated size ~4x and nudge recommended ranges the apply
 *  side then refused). Invariant: EVERY returned batch alone clears
 *  `minChars`. A sub-threshold tail is folded into the preceding batch
 *  (overshoot allowed); if no batch precedes it, nothing is emitted — the
 *  whole remainder is below the gate, so no selection of it can pass and
 *  offering it only yields guaranteed-rejected calls (billion-context #847). */
export function mergeRangesToThreshold(
  ranges: CompressibleRange[],
  minChars: number,
): CompressibleRange[] {
  if (minChars <= 0 || ranges.length === 0) return ranges;
  const result: CompressibleRange[] = [];
  let batch: CompressibleRange[] = [];
  let batchChars = 0;
  // Close the running batch at a boundary: emit it only when it alone clears
  // the gate. A sub-threshold segment bounded by a gap cannot be offered (it
  // fails the apply-side #847 gate) and must not be stretched across the gap
  // to reach the threshold, or the emitted span covers non-compressible
  // content (#498).
  const closeBatch = () => {
    if (batch.length > 0) {
      if (batchChars >= minChars) result.push(mergeBatch(batch));
      batch = [];
      batchChars = 0;
    }
  };
  for (const r of ranges) {
    // #3192/#3205: hard boundary at a dead-ref hole — never bridge across it,
    // even though the hole carries no array-index gap (see noMergeBefore).
    if (r.noMergeBefore) closeBatch();
    const prev = batch[batch.length - 1];
    // A physical array-index gap between the previous range and this one marks
    // a block / protected / pruned boundary (buildCompressibleRanges leaves a
    // slot hole there; user-turn splits stay contiguous). Without index data we
    // keep the legacy accumulate-across-everything behavior.
    if (
      prev &&
      prev.endIndex !== undefined &&
      r.startIndex !== undefined &&
      r.startIndex > prev.endIndex + 1
    ) {
      closeBatch();
    }
    batch.push(r);
    batchChars += rangeChars(r);
    if (batchChars >= minChars) closeBatch();
  }
  if (batch.length > 0 && result.length > 0) {
    const prev = result[result.length - 1]!;
    const contiguous =
      !batch[0]!.noMergeBefore &&
      (prev.endIndex === undefined ||
        batch[0]!.startIndex === undefined ||
        batch[0]!.startIndex <= prev.endIndex + 1);
    if (contiguous) {
      result[result.length - 1] = mergeBatch([prev, ...batch]);
    } else if (batchChars >= minChars) {
      result.push(mergeBatch(batch));
    }
  }
  return result;
}

/**
 * #3236: re-screen each merged recommended unit through the SAME judgment
 * applySingleRange executes (projectUnit, unit-projection.ts). A unit that
 * would be rejected wholesale — protected-zone-only span, turn/pair split, or
 * nothing new to fold — is demoted to a gap instead of advertised. Without
 * this, global integrity screening passes turns whose partners sit in ANOTHER
 * advertised unit, and every submission of such a range throws "Range would
 * split N turn(s)" — a permanent advertise/reject loop observed in production
 * (billion-context#3236). No re-merge after filtering: re-merging could
 * resurrect a doomed unit under different groupings and oscillate; a dropped
 * unit simply stops being offered until the geometry changes.
 */
export function screenRecommendedUnits(
  units: CompressibleRange[],
  source: CoreMessage[],
  state: CompressionState,
  config: Config,
  protectedRefs: Set<string>,
): CompressibleRange[] {
  if (units.length === 0) return units;
  const coverage = collectCoverage(state);
  return units.filter((unit) => {
    let projection: UnitProjection | undefined;
    try {
      projection = projectUnit({
        messages: source,
        state,
        config,
        startRef: unit.startRef,
        endRef: unit.endRef,
        preExistingCoverage: coverage,
        protectedMessageIds: protectedRefs,
      });
    } catch (err) {
      // Endpoints that cannot resolve on this array class (dead/consumed)
      // must never be advertised. BoundaryNotFoundError is that expected
      // case (#3371 screens consumed units through here routinely) and stays
      // silent; any OTHER exception is a programming error being swallowed
      // into a silent demotion — the unit vanished with no trace at all
      // (#3406 item 9). Surface it as a diagnostic (same channel as the
      // config-validation warn in processTurn); behavior is unchanged —
      // still return false, the unit is never advertised.
      if (!(err instanceof BoundaryNotFoundError)) {
        console.warn(
          `[acp-kernel] screenRecommendedUnits dropped unit ${unit.startRef}..${unit.endRef} after projection error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return false;
    }
    if (!projection || projection.fatal !== null) return false;
    if (
      projection.filteredIds.length === 0 &&
      projection.consumedBlockIds.length === 0
    ) {
      return false;
    }
    // #3371: the apply lane's livelock guard (compress.ts, pi#199) throws on
    // a message-ref range that owns nothing new and only consumes active
    // block(s) — UNLESS the shared refold verdict (evaluateRefold) classifies
    // it a genuine in-place refold (#398: every in-span block restored-inline
    // with a fully restored ancestor chain). Screen that exact shape through
    // the SAME evaluateRefold (refold.ts — extracted from compress.ts for
    // this) so an advertised unit can never be a guaranteed apply-time
    // throw; real refolds stay advertised. Block-boundary units (bN..bM,
    // promote/merge) take apply's explicit block route and are exempt, same
    // as the apply-side guard.
    if (
      projection.filteredIds.length === 0 &&
      projection.consumedBlockIds.length > 0 &&
      !projection.isBlockBoundary &&
      evaluateRefold(state, unit).kind !== "refold"
    ) {
      return false;
    }
    return true;
  });
}
