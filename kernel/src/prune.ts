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
   * placement: an anchor whose ids are absent from the input parks at the
   * tail, and no summary may precede the first user message — the pin is the
   * provider prefix-cache head (#2733).
   */
  headSummaryAnchors?: boolean;
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
  const firstUserIndex = messages.findIndex(
    (message) => message.role === "user",
  );

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

  const anchors = inject
    ? collectSummaryAnchors(
        state,
        baseIndexById,
        summaryIndexById,
        options.headSummaryAnchors ? 0 : messages.length,
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
          firstUserIndex,
          anchors,
          knownSummaryIds,
          options.headSummaryAnchors === true,
        ),
      ),
    ),
  );
}

interface SummaryAnchor {
  blockId: string;
  summary: string;
  topic?: string;
  insertAt: number;
}

function collectSummaryAnchors(
  state: CompressionState,
  baseIndexById: Map<string, number>,
  summaryIndexById: Map<string, number>,
  fallbackIndex: number,
): SummaryAnchor[] {
  const anchors: SummaryAnchor[] = [];
  for (const block of activeBlocks(state)) {
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
      // Unresolved (no anchor id present in this input): park at the tail —
      // index 0 would splice the summary ahead of the session head and nuke
      // the provider's cached prefix for every subsequent turn (#2733).
      insertAt: earliest ?? fallbackIndex,
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

function rebuildMessages(
  messages: CoreMessage[],
  coveredBases: Set<string>,
  firstUserIndex: number,
  anchors: SummaryAnchor[],
  knownSummaryIds: Set<string>,
  headAnchors: boolean,
): CoreMessage[] {
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
      insertAt: headAnchors
        ? anchor.insertAt
        : Math.max(anchor.insertAt, firstUserIndex + 1),
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
    if (index === firstUserIndex && firstUserIndex >= 0) {
      result.push(messages[index]!);
      continue;
    }
    if (isCovered(messages[index]!.id, coveredBases)) continue;
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
 * Defense-in-depth for tool-result pairing. Pairing is by ORDER and
 * MULTIPLICITY, never by id-set membership: host-minted tool-call ids are not
 * guaranteed unique (a host that numbers calls `name:index` re-issues the same
 * id on later turns), and a set cannot tell one instance from another — a
 * result whose own call was folded into a summary then survives because a
 * DIFFERENT call with the same id is still visible, and the wire carries a
 * `tool` message before any assistant declares its `tool_call_id`. Strict
 * upstreams reject that whole request with HTTP 400.
 */
function stripOrphanedToolResults(messages: CoreMessage[]): CoreMessage[] {
  const openCalls = new Map<string, number>();
  const kept: CoreMessage[] = [];
  for (const m of messages) {
    if (m.contentType === "tool-call" && m.toolCallId) {
      openCalls.set(m.toolCallId, (openCalls.get(m.toolCallId) ?? 0) + 1);
    } else if (m.contentType === "tool-result" && m.toolCallId) {
      const open = openCalls.get(m.toolCallId) ?? 0;
      if (open <= 0) continue;
      openCalls.set(m.toolCallId, open - 1);
    }
    kept.push(m);
  }
  return kept;
}

/**
 * Mirror of {@link stripOrphanedToolResults} for the call side: drop tool-calls
 * that no visible tool-result answers. Scanned from the tail so a call only
 * claims a result that actually FOLLOWS it. `compress` calls carry their own
 * receipt and stay regardless.
 */
function stripOrphanedToolCalls(messages: CoreMessage[]): CoreMessage[] {
  const openResults = new Map<string, number>();
  const kept: CoreMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.contentType === "tool-result" && m.toolCallId) {
      openResults.set(m.toolCallId, (openResults.get(m.toolCallId) ?? 0) + 1);
    } else if (
      m.contentType === "tool-call" &&
      m.toolCallId &&
      m.toolName !== "compress"
    ) {
      const open = openResults.get(m.toolCallId) ?? 0;
      if (open <= 0) continue;
      openResults.set(m.toolCallId, open - 1);
    }
    kept.push(m);
  }
  return kept.reverse();
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
