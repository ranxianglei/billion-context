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
import { coveredMessageIds } from "./state.js";
import { SUMMARY_HEADER } from "./prune.js";
import {
  collectLatestProtected,
  collectProtectedToolCallIds,
  hasMediaPayload,
  isMessageLatestProtected,
  isMessageProtectedWithPairing,
  isNeverPreserveRecent,
} from "./protected.js";
import { countMessageTokens } from "./tokenize.js";
import { computeIntegrityWithdrawals } from "./turn-integrity.js";
import { segmentGroups } from "./segment.js";

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
 * Combines two rules:
 *   1. Last N messages (`config.preserveRecentMessages`)
 *   2. Last N tokens expanding backward (`config.preserveRecentTokens`)
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

  return result;
}

// ─── 2. Build Compressible + Protected Ranges ────────────────────────────────

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

  for (const msg of messages) {
    msgIndex++;
    const ref = state.messageRefs.byRaw[msg.id];
    if (!ref || ref === "BLOCKED") continue;
    if (isSyntheticOrPruned(msg, covered)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    // Media payloads are unrecoverable once folded (#1188): never advertised
    // as compressible, and treated as a gap so no range spans them.
    if (hasMediaPayload(msg)) {
      skipSinceCompressible = true;
      skipSinceProtected = true;
      continue;
    }

    if (
      isMessageProtectedWithPairing(msg, config, protectedCallIds) ||
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
  const unfoldedIds = computeIntegrityWithdrawals(
    messages,
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
  return merged;
}

/** Character size of a range, used only to populate the informational
 *  `chars` field on merged ranges. The minCompressRange gate itself reads
 *  `tokens` (#511). Falls back to the historical tokens*4 estimate only for
 *  hand-built ranges that predate the `chars` field. */
function rangeChars(r: CompressibleRange): number {
  return r.chars ?? r.tokens * 4;
}

/** Merge adjacent ranges into batches that clear `minTokens` of real content
 *  — the same token accounting `applyCompression` uses — so a recommended
 *  range is never below the threshold the kernel would atomically reject.
 *  Counting tokens (not chars) keeps the gate language-neutral: a CJK-aware
 *  estimator yields ~1 token/char while Latin is ~4 chars/token, so a char
 *  threshold applied ~4 different effective floors per language (#511).
 *  Invariant: EVERY returned batch alone clears `minTokens`. A sub-threshold
 *  tail is folded into the preceding batch (overshoot allowed); if no batch
 *  precedes it, nothing is emitted — the whole remainder is below the gate,
 *  so no selection of it can pass and offering it only yields
 *  guaranteed-rejected calls (billion-context #847). */
export function mergeRangesToThreshold(
  ranges: CompressibleRange[],
  minTokens: number,
): CompressibleRange[] {
  if (minTokens <= 0 || ranges.length === 0) return ranges;
  const result: CompressibleRange[] = [];
  let batch: CompressibleRange[] = [];
  let batchTokens = 0;
  // Close the running batch at a boundary: emit it only when it alone clears
  // the gate. A sub-threshold segment bounded by a gap cannot be offered (it
  // fails the apply-side #847 gate) and must not be stretched across the gap
  // to reach the threshold, or the emitted span covers non-compressible
  // content (#498).
  const closeBatch = () => {
    if (batch.length > 0) {
      if (batchTokens >= minTokens) result.push(mergeBatch(batch));
      batch = [];
      batchTokens = 0;
    }
  };
  for (const r of ranges) {
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
    batchTokens += r.tokens;
    if (batchTokens >= minTokens) closeBatch();
  }
  if (batch.length > 0 && result.length > 0) {
    const prev = result[result.length - 1]!;
    const contiguous =
      prev.endIndex === undefined ||
      batch[0]!.startIndex === undefined ||
      batch[0]!.startIndex <= prev.endIndex + 1;
    if (contiguous) {
      result[result.length - 1] = mergeBatch([prev, ...batch]);
    } else if (batchTokens >= minTokens) {
      result.push(mergeBatch(batch));
    }
  }
  return result;
}
