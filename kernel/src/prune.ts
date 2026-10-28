import { activeBlocks, coveredMessageIds } from "./state.js";
import type { CompressionState, CoreMessage } from "./types.js";

export const SUMMARY_HEADER = "[Compressed conversation section]";

// Reserved prefix for rendered-summary ids. Hosts own their message ids and
// must never assign one with this prefix; kernel-generated ids are mNNNNN
// refs and bN block ids.
const SUMMARY_ID_PREFIX = "acp_summary_";

/**
 * The transient visible id of an active block's rendered summary message.
 * This is a VIEW-ONLY representation: it must never be persisted into
 * `effectiveMessageIds`/`directMessageIds` (the durable coverage is the
 * block's raw message ids).
 */
export function summaryMessageId(blockId: string): string {
  return `${SUMMARY_ID_PREFIX}${blockId}`;
}

export function isSummaryMessageId(id: string): boolean {
  return id.startsWith(SUMMARY_ID_PREFIX);
}

/**
 * Base id of a message id: everything before the first `#`. Sub-id
 * projections (`base#callId`, `base#r0`, …) are alternate renderings of the
 * same original message, so coverage is decided per original message — id
 * comparisons normalize to the base (issue #231).
 */
export function baseIdOf(id: string): string {
  const hash = id.indexOf("#");
  return hash > 0 ? id.substring(0, hash) : id;
}

/**
 * True when `id` falls under any covered original message, regardless of
 * which projection form the block recorded and which the current view emits.
 * `coveredBases` must be the set of `baseIdOf(c)` over the covered ids,
 * built once per pass (O(1) per message instead of a scan). The exact
 * membership test is subsumed: a covered id's own base is in the set.
 */
export function isCovered(id: string, coveredBases: Set<string>): boolean {
  return coveredBases.has(baseIdOf(id));
}

/**
 * #4316 layer 3: seq-interval coverage claims. A block that recorded an exact
 * ledger interval (startSeq/endSeq) covers ANY message carrying a ledgerSeq
 * stamp inside that interval — id churn (model switch / re-stamp / re-encode
 * re-mints every content-hash id) cannot invalidate the positional claim.
 * Blocks without bounds contribute nothing; messages without stamps are
 * decided by the id path alone. Both paths run in parallel (union): the id
 * path stays byte-identical for unstamped traffic.
 *
 * The -1/-1 "no claim" sentinel (PR #4725 N1: storage writes it when a
 * block's covered ids cannot be resolved to transcript rows, e.g. migrated
 * pre-unified-storage folds) contributes nothing — with the historical
 * endSeq >= startSeq guard alone it would pass as a REAL interval and, for
 * the [0,0] placeholder it replaces, suppress the seq-0 message as already
 * folded. [0,0] itself stays a legitimate claim: a block can genuinely
 * cover just seq 0.
 */
export function coveredSeqIntervals(
  state: CompressionState,
): Array<{ start: number; end: number }> {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const block of state.blocks) {
    if (!block.active) continue;
    if (
      typeof block.startSeq === "number" &&
      typeof block.endSeq === "number" &&
      block.startSeq >= 0 &&
      block.endSeq >= block.startSeq
    ) {
      intervals.push({ start: block.startSeq, end: block.endSeq });
    }
  }
  return intervals;
}

/** True when `seq` falls inside any active block's exact interval claim. */
export function isCoveredBySeq(
  seq: number | undefined,
  intervals: Array<{ start: number; end: number }>,
): boolean {
  if (typeof seq !== "number" || !Number.isInteger(seq)) return false;
  for (const interval of intervals) {
    if (seq >= interval.start && seq <= interval.end) return true;
  }
  return false;
}

/**
 * True when a message is a rendered block summary (the exact shape prune
 * emits). The id prefix alone is not sufficient — a host-authored message
 * that happens to carry a reserved id must not be treated as a rendered
 * summary (it would be silently dropped from ranges or deleted by rebuild).
 */
export function isRenderedSummaryMessage(
  message: Pick<CoreMessage, "id" | "role" | "contentType">,
): boolean {
  return (
    isSummaryMessageId(message.id) &&
    message.role === "system" &&
    message.contentType === "text"
  );
}

export interface PruneOptions {
  injectSummaries?: boolean;
  /**
   * Chronological head anchoring for views with NO provider prefix cache at
   * stake (session handoff/restore docs). Default (false) is the pin-safe
   * placement: an anchor whose ids are absent from the input parks before
   * the newest user message (never at the tail, #3640), and no summary may
   * precede the first user message — the pin is the provider prefix-cache
   * head (#2733).
   */
  headSummaryAnchors?: boolean;
  /**
   * Names that count as a `compress` call for the pending-call exemption in
   * orphan stripping (same predicate family as Config.isCompressTool). Unset =
   * bare-name only, byte-identical to before; without it an MCP-form compress
   * call still awaiting its result is deleted while its bare-name twin survives.
   */
  isCompressTool?: (toolName: string) => boolean;
}

export function prune(
  messages: CoreMessage[],
  state: CompressionState,
  options: PruneOptions = {},
): CoreMessage[] {
  const covered = coveredMessageIds(state);
  if (covered.size === 0) return [...messages];
  const coveredBases = new Set<string>();
  for (const id of covered) coveredBases.add(baseIdOf(id));

  const inject = options.injectSummaries ?? true;
  const isCompressTool =
    options.isCompressTool ?? ((name: string) => name === "compress");
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user",
  );
  // #3640: an unresolved anchor (no covered id present in this input) parks
  // immediately BEFORE the newest user message, never at the list tail.
  // Tail-parking put days-old summaries after the user's current question,
  // and the model answered the stale recap instead of the question for every
  // subsequent turn. Parking before the newest user turn also keeps the
  // provider prefix cache intact: the insertion point sits inside the
  // turn-over region that the next request rewrites anyway (#2733 trade-off
  // reassessed). No user message at all: keep the legacy tail.
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUserIndex = i;
      break;
    }
  }

  const baseIndexById = new Map<string, number>();
  const summaryIndexById = new Map<string, number>();
  messages.forEach((message, index) => {
    const base = baseIdOf(message.id);
    const existing = baseIndexById.get(base);
    if (existing === undefined || index < existing)
      baseIndexById.set(base, index);
    if (isRenderedSummaryMessage(message))
      summaryIndexById.set(message.id, index);
  });

  // #4311: a wire-visible compress call already carries the full summary
  // draft in its arguments, and the call+receipt pair stays protected —
  // re-rendering the block summary duplicates that text on the wire. Skip
  // the anchor for blocks whose ORIGINATING call is visible in THIS view
  // (the exchange itself is the model-visible recap); blocks whose call is
  // gone (folded away, gateway-dropped) or that never had one (system folds,
  // codex/dsh forged-summary lanes) keep their render. The skip must key on
  // the exact compressCallId — never on range overlap — so a RE-FOLD that
  // covers similar ground still renders its own summary.
  const visibleCompressCallIds = new Set<string>();
  if (inject) {
    for (const message of messages) {
      if (
        message.contentType === "tool-call" &&
        message.toolCallId &&
        typeof message.toolName === "string" &&
        isCompressTool(message.toolName)
      ) {
        visibleCompressCallIds.add(message.toolCallId);
      }
    }
  }
  const anchors = inject
    ? collectSummaryAnchors(
        state,
        baseIndexById,
        summaryIndexById,
        options.headSummaryAnchors
          ? 0
          : lastUserIndex >= 0
            ? lastUserIndex
            : messages.length,
        visibleCompressCallIds,
      )
    : [];
  // Summary ids of every block this session has ever created — active or
  // consumed. Rendered copies of ACTIVE blocks are replaced by the fresh
  // render at their anchor; copies of CONSUMED blocks (superseded by a chain
  // re-fold) must be dropped too, or the loop path keeps rendering them
  // next to the successor summary forever (#2733). Only when summaries are
  // actually injected: with injectSummaries off there is no fresh render to
  // substitute, so dropping here would silently delete already-rendered
  // summaries from the view instead of keeping them.
  const knownSummaryIds = new Set(
    inject ? state.blocks.map((block) => summaryMessageId(block.blockId)) : [],
  );

  return stripOrphanedReasoning(
    stripOrphanedToolResults(
      stripOrphanedToolCalls(
        rebuildMessages(
          messages,
          coveredBases,
          // #4316 layer 3: positional claims, built once per prune pass.
          coveredSeqIntervals(state),
          firstUserIndex,
          anchors,
          knownSummaryIds,
          options.headSummaryAnchors === true,
        ),
        isCompressTool,
      ),
    ),
  );
}

interface SummaryAnchor {
  blockId: string;
  summary: string;
  topic?: string;
  insertAt: number;
  /** True when no anchor id was present in the input (the substrate is off
   *  the wire). Unresolved anchors park before the newest user message and
   *  are exempt from the first-user-pin lower bound of firstUserIndex + 1:
   *  riding AFTER the user's current question is the functional bug #3640
   *  (the model answered the stale recap instead of the question for five
   *  consecutive turns), and the rendered summary is role "system", so
   *  leading the view is provider-safe. */
  unresolved?: boolean;
}

function collectSummaryAnchors(
  state: CompressionState,
  baseIndexById: Map<string, number>,
  summaryIndexById: Map<string, number>,
  fallbackIndex: number,
  // #4311: call ids of compress exchanges visible in the current view;
  // blocks created by one of these skip their anchor render (see the
  // collection site above for the rationale and the safety conditions).
  visibleCompressCallIds: Set<string>,
): SummaryAnchor[] {
  const anchors: SummaryAnchor[] = [];
  for (const block of activeBlocks(state)) {
    // #4311: the originating call is on the wire — its arguments carry the
    // summary text, so injecting the block render would duplicate it. The
    // stale render (if a previously-pruned view carried one) is dropped by
    // rebuildMessages via knownSummaryIds and NOT re-injected here.
    if (block.compressCallId && visibleCompressCallIds.has(block.compressCallId))
      continue;
    // Prefer the position of an already-rendered summary (hosts may pass a
    // previously-pruned view): keeps the summary stable in place instead of
    // jumping to index 0 when the raw ids are no longer in the input.
    const existingIndex = summaryIndexById.get(summaryMessageId(block.blockId));
    if (existingIndex !== undefined) {
      anchors.push({
        blockId: block.blockId,
        summary: block.summary,
        topic: block.topic,
        insertAt: existingIndex,
      });
      continue;
    }
    // #2733: anchor on the block's DIRECT range — the ids this fold itself
    // covered — not the merged effective set. Consumption folds the consumed
    // block's effectiveMessageIds into the new block, so the merged set reaches
    // back to the earliest id any ancestor ever covered; anchoring on it
    // re-anchors the new summary at that far-earlier position, rewriting bytes
    // the provider already cached there (observed in production as the
    // post-fold prefix match collapsing to the ~11K immutable head on every
    // re-fold). Anchoring on the direct ids confines the churn to the region
    // the fold actually rewrote. Legacy persisted blocks predate the field —
    // fall back to the effective set for them.
    const anchorIds =
      block.directMessageIds && block.directMessageIds.length > 0
        ? block.directMessageIds
        : block.effectiveMessageIds;
    let earliest: number | null = null;
    for (const id of anchorIds) {
      const index = baseIndexById.get(baseIdOf(id));
      if (index !== undefined && (earliest === null || index < earliest)) {
        earliest = index;
      }
    }
    anchors.push({
      blockId: block.blockId,
      summary: block.summary,
      topic: block.topic,
      // Unresolved (no anchor id present in this input): park before the
      // newest user message — see prune() for the #3640/#2733 reasoning.
      // Tail-parking (the pre-#3640 behavior) let stale summaries land after
      // the user's current question, which the model then answered instead.
      insertAt: earliest ?? fallbackIndex,
      unresolved: earliest === null,
    });
  }
  anchors.sort((left, right) => left.insertAt - right.insertAt);
  return anchors;
}

/**
 * A rendered summary replaces the messages its block covers, so it takes the
 * position of the earliest covered message. That position can fall inside a
 * unit the provider validates as a whole, and a summary may never be placed
 * inside such a unit:
 *
 * - A parallel tool burst: a range that covers one call and its result leaves
 *   the burst's other calls visible, and the summary then lands between an
 *   assistant `tool_calls` message and the tool results answering it. Strict
 *   upstreams reject the whole request in that shape ("an assistant message
 *   with 'tool_calls' must be followed by tool messages responding to each
 *   'tool_call_id'"), so an anchor that would separate a call from its result
 *   is moved past that result.
 * - A single assistant message: consecutive assistant cores (a reasoning run,
 *   its text and its tool calls) merge into one wire message. An anchor landing
 *   between them splits the message, and its tool calls then reach the provider
 *   without the reasoning run they were produced with — DeepSeek thinking mode
 *   rejects that ("The `reasoning_content` in the thinking mode must be passed
 *   back to the API"), so an anchor inside an assistant run is moved back to the
 *   run's start.
 */
// Per-rebuild indexes for anchor pairing (#498). Building these once per
// rebuild costs O(N); rebuilding them per anchor made prune O(anchors × N).
interface AnchorPairingIndex {
  /** Start of the maximal consecutive assistant-role run containing i; -1 when `messages[i]` is not assistant. */
  runStart: Int32Array;
  /** Farthest `firstResultIndex(callId) + 1` across assistant tool-call messages at positions `< i`; 0 when none. Length N+1. */
  prefixEnd: Int32Array;
}

function buildAnchorPairingIndex(messages: CoreMessage[]): AnchorPairingIndex {
  const n = messages.length;

  // A duplicate call id can appear on multiple results; the earliest position
  // is the pairing boundary.
  const resultIndexByCallId = new Map<string, number>();
  messages.forEach((message, at) => {
    if (message.contentType !== "tool-result") return;
    if (typeof message.toolCallId !== "string") return;
    if (!resultIndexByCallId.has(message.toolCallId)) {
      resultIndexByCallId.set(message.toolCallId, at);
    }
  });

  const runStart = new Int32Array(n).fill(-1);
  for (let i = 0; i < n;) {
    if (messages[i]!.role !== "assistant") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && messages[j + 1]!.role === "assistant") j++;
    for (let k = i; k <= j; k++) runStart[k] = i;
    i = j + 1;
  }

  const prefixEnd = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const message = messages[i]!;
    let end = 0;
    if (
      message.role === "assistant" &&
      message.contentType === "tool-call" &&
      typeof message.toolCallId === "string"
    ) {
      const resultIndex = resultIndexByCallId.get(message.toolCallId);
      if (resultIndex !== undefined) end = resultIndex + 1;
    }
    prefixEnd[i + 1] = Math.max(prefixEnd[i]!, end);
  }

  return { runStart, prefixEnd };
}

function pairSafeAnchorIndex(
  messages: CoreMessage[],
  index: number,
  ix: AnchorPairingIndex,
): number {
  const n = messages.length;
  let safe = index;
  // Only assistant cores that reach the wire matter; a covered core between
  // them is dropped, and the runs then merge in the rendered view. Both steps
  // below therefore walk the input, where the covered ids are still present.
  if (safe > 0 && safe < n) {
    const start = ix.runStart[safe]!;
    if (start >= 0 && messages[safe - 1]!.role === "assistant") {
      safe = start;
    }
  }

  // Degenerate inputs outside [0, n] have no prefix to scan; the original
  // full-scan behavior returned them unchanged.
  if (safe < 0 || safe > n) return safe;

  // Each move lands just past a result, so the loop reaches a fixed point; the
  // bound only guards against a malformed message list. Entries whose result
  // ends at or before `safe` contribute ≤ safe and are absorbed by
  // max(safe, ·), so the unfiltered prefix max agrees with the filtered scan.
  for (let guard = 0; guard < n; guard++) {
    const next = Math.max(safe, ix.prefixEnd[safe]!);
    if (next === safe) break;
    safe = next;
  }
  return safe;
}

/** #3642: the wire message index a core was flattened from (set by every
 *  codec; kernel-rendered cores carry none). Declared locally so prune stays
 *  free of wire-module imports. */
type WireIndexedCore = { wireIndex?: number };
const wireIndexOf = (m: CoreMessage): number | undefined =>
  (m as WireIndexedCore).wireIndex;

function rebuildMessages(
  messages: CoreMessage[],
  coveredBases: Set<string>,
  // #4316 layer 3: exact ledger-interval claims of active blocks (positional
  // coverage, immune to id churn), threaded from prune().
  seqIntervals: Array<{ start: number; end: number }>,
  firstUserIndex: number,
  anchors: SummaryAnchor[],
  knownSummaryIds: Set<string>,
  headAnchors: boolean,
): CoreMessage[] {
  // #3642: canonical granularity splits one wire message into one core per
  // content part, so the opening user message can be a RUN of user cores
  // (text + image + …) sharing one wireIndex. The first-user pin protects
  // the OPENING WIRE MESSAGE, not merely its first core: a multimodal
  // opening keeps its image bytes through folds (pre-split the merged core
  // carried them in its sidecar and the single-core pin preserved both).
  // Kernel-rendered cores (no wireIndex) never extend the run, and neither
  // does an adjacent but different wire message. Run length 1 keeps the
  // legacy shape byte-for-byte.
  let firstUserPinEnd = firstUserIndex + 1;
  if (firstUserIndex >= 0) {
    const firstWire = wireIndexOf(messages[firstUserIndex]!);
    if (firstWire !== undefined) {
      while (
        firstUserPinEnd < messages.length &&
        messages[firstUserPinEnd]!.role === "user" &&
        wireIndexOf(messages[firstUserPinEnd]!) === firstWire
      ) {
        firstUserPinEnd++;
      }
    }
  }
  const ix = anchors.length > 0 ? buildAnchorPairingIndex(messages) : null;
  const safeAnchors = anchors
    .map((anchor) => ({
      ...anchor,
      insertAt: ix
        ? pairSafeAnchorIndex(messages, anchor.insertAt, ix)
        : anchor.insertAt,
    }))
    // #2733: a summary may NEVER precede the session's first user message.
    // The pin is the provider prefix-cache head; a block whose range roots
    // at (or before) the pinned message would otherwise flush its summary
    // ahead of the pin — the first history item changes and the cached
    // prefix collapses for every subsequent request. Anchors resolve against
    // baseIndexById BEFORE the pin logic runs here, so this clamp is the
    // single choke point that guarantees pin-first ordering. Handoff views
    // (headAnchors) have no prefix cache at stake and keep chronological
    // head placement for summaries of older, absent material.
    .map((anchor) => ({
      ...anchor,
      // #2733/#3642: a summary may NEVER precede the pinned opening wire
      // message — now measured to the END of the opening core run
      // (firstUserPinEnd), so an anchor can never land between the opening
      // message's split parts either.
      insertAt: headAnchors
        ? anchor.insertAt
        : Math.max(
            anchor.insertAt,
            anchor.unresolved === true ? firstUserIndex : firstUserPinEnd,
          ),
    }))
    .sort((left, right) => left.insertAt - right.insertAt);
  const result: CoreMessage[] = [];
  const pending = [...safeAnchors];

  for (let index = 0; index < messages.length; index++) {
    while (pending.length > 0 && pending[0]!.insertAt === index) {
      result.push(renderSummary(pending.shift()!));
    }
    // First-user-message pin: the session's opening user message survives
    // prune even when covered by an active block. This check deliberately
    // PRECEDES the covered check below — swapping them would let a compress
    // range strip the last guaranteed user message off the wire. Strict
    // providers reject conversations with no user message. See DESIGN.md §8.1.
    // #3642: the pin spans the opening wire message's whole core run.
    if (index === firstUserIndex && firstUserIndex >= 0) {
      for (let k = index; k < firstUserPinEnd; k++) {
        result.push(messages[k]!);
      }
      index = firstUserPinEnd - 1;
      continue;
    }
    if (isCovered(messages[index]!.id, coveredBases)) continue;
    // #4316 layer 3: positional coverage — a stamped message inside any
    // active block's exact ledger interval is covered even when its id was
    // re-minted (the id check above just missed it by construction). Runs
    // after the pin and the id path so unstamped behavior is untouched.
    if (isCoveredBySeq(messages[index]!.ledgerSeq, seqIntervals)) continue;
    // A stale copy of a block's summary from a previously-pruned view:
    // the freshly rendered one above replaces it. Active blocks re-render
    // at their anchor; consumed blocks (chain re-fold) are covered by their
    // successor's summary — either way the old copy must not survive.
    // Only rendered-summary shaped messages whose id maps to a block we
    // created qualify — a host message that merely reuses the reserved
    // prefix is content, not a stale copy.
    if (
      isRenderedSummaryMessage(messages[index]!) &&
      knownSummaryIds.has(messages[index]!.id)
    )
      continue;
    result.push(messages[index]!);
  }

  while (pending.length > 0) {
    result.push(renderSummary(pending.shift()!));
  }

  return result;
}

function renderSummary(anchor: SummaryAnchor): CoreMessage {
  const body = anchor.summary.trim();
  const topicLine = anchor.topic
    ? `${SUMMARY_HEADER} — ${anchor.topic}`
    : SUMMARY_HEADER;
  const text = body.length === 0 ? topicLine : `${topicLine}\n${body}`;
  return {
    id: summaryMessageId(anchor.blockId),
    role: "system",
    contentType: "text",
    text,
  };
}

/**
 * Drop tool-results whose declaring tool-call is not visible *before* them.
 *
 * Pairing is by order, not by id-set membership (#3046): a bare set cannot tell
 * two instances apart when a host re-issues the same tool-call id for different
 * calls (Agent Teams `name:index` ids). The upstream contract is directional —
 * a `role: "tool"` message must follow the assistant that declared its
 * `tool_call_id` — so a result is valid iff some call carrying the same id sits
 * EARLIER in the view. A result whose own call was folded away used to survive
 * because a different same-id call was still visible (possibly later); that
 * shipped an unpaired half and bricked the session with a 400. Walking forward
 * and remembering which ids a call has opened drops exactly that orphan and
 * nothing else: unique-id sessions behave identically to the old set lookup,
 * and one call still answers any number of same-id results (precedence is
 * checked, not multiplicity).
 */
function stripOrphanedToolResults(messages: CoreMessage[]): CoreMessage[] {
  const openCallIds = new Set<string>();
  const drop = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.contentType === "tool-call") {
      if (m.toolCallId) openCallIds.add(m.toolCallId);
    } else if (m.contentType === "tool-result" && m.toolCallId) {
      if (!openCallIds.has(m.toolCallId)) drop.add(i);
    }
  }
  return drop.size === 0 ? messages : messages.filter((_, i) => !drop.has(i));
}

/**
 * Drop tool-calls that no visible tool-result answers *after* them.
 *
 * Mirror of {@link stripOrphanedToolResults} (#3046): the upstream requires an
 * assistant `tool_calls` entry to be followed by a response for each id, so a
 * call is valid iff some result carrying the same id sits LATER in the view. A
 * call whose answering result was folded away used to survive because a
 * different same-id result was still visible (possibly earlier); that shipped
 * an unanswered tool_call and bricked the session. Walking backward and
 * remembering which ids a result has answered keeps precedence-only semantics;
 * compress calls stay exempt (their result is managed by
 * hideConsumedCompressCalls, not this guard) — matched through the host's
 * isCompressTool predicate so MCP-form compress calls are treated like their
 * bare-name twins (#3222).
 */
function stripOrphanedToolCalls(
  messages: CoreMessage[],
  isCompressTool: (toolName: string) => boolean,
): CoreMessage[] {
  const answeredCallIds = new Set<string>();
  const drop = new Set<number>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.contentType === "tool-result") {
      if (m.toolCallId) answeredCallIds.add(m.toolCallId);
    } else if (m.contentType === "tool-call" && m.toolCallId) {
      if (typeof m.toolName === "string" && isCompressTool(m.toolName)) continue;
      if (!answeredCallIds.has(m.toolCallId)) drop.add(i);
    }
  }
  return drop.size === 0 ? messages : messages.filter((_, i) => !drop.has(i));
}

/**
 * Defense-in-depth for reasoning/text pairing (analogue of
 * {@link stripOrphanedToolCalls}). A `reasoning` message is only meaningful
 * when immediately followed — after any same-run reasoning — by its companion
 * assistant text/tool-call; strict thinking models (DeepSeek et al.) reject
 * reasoning_content that has lost its response with HTTP 400. Compress-time
 * boundary expansion normally keeps the pair in one block, so this only fires
 * for degenerate straddles (block-boundary ranges, malformed input, or a
 * reasoning that never had a companion): drop the dangling run rather than
 * ship a 400-triggering half-pair. Runs AFTER tool stripping, since removing
 * an orphaned tool-call can leave its preceding reasoning dangling too.
 */
function stripOrphanedReasoning(messages: CoreMessage[]): CoreMessage[] {
  const drop = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    if (drop.has(i)) continue;
    if (messages[i]!.contentType !== "reasoning") continue;
    let j = i;
    while (
      j + 1 < messages.length &&
      messages[j + 1]!.contentType === "reasoning"
    ) {
      j++;
    }
    const companion = messages[j + 1];
    const hasCompanion =
      companion !== undefined &&
      companion.role === "assistant" &&
      (companion.contentType === "text" ||
        companion.contentType === "tool-call");
    if (!hasCompanion) {
      for (let k = i; k <= j; k++) drop.add(k);
    }
  }
  if (drop.size === 0) return messages;
  return messages.filter((_, i) => !drop.has(i));
}
