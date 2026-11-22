import { clampPrefix } from "./truncate.js";
import { isToolMessage } from "./message-kind.js";
import { BLOCKED_REF, orderedRefPair, refForRaw } from "./refs.js";
import { countMessageTokens } from "./tokenize.js";
import { segmentGroups } from "./segment.js";
import { isLiveCheckpointCarrier } from "./state.js";
import {
  isRenderedSummaryMessage,
  summaryBlockIdOf,
} from "./prune.js";
import { tierActionHint } from "./compress.js";
import {
  COMPRESS_EXCHANGE_KEEP_RECENT,
  collectAgedCompressCallIds,
  isCompressToolName,
} from "./protected.js";
import { computeProtectedRefs } from "./recommend.js";
import {
  buildProjectionShared,
  collectCoverage,
  projectUnit,
} from "./unit-projection.js";
import type { UnitProjection } from "./unit-projection.js";
import type {
  CompressionBlock,
  CompressionState,
  Config,
  CoreMessage,
} from "./types.js";

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

function pct(n: number, total: number): number {
  if (n <= 0 || total <= 0) return 0;
  return Math.round((n / total) * 100);
}

function numericPart(blockId: string): number {
  const match = /^b(\d+)$/.exec(blockId);
  return match && match[1] !== undefined ? Number(match[1]) : 0;
}

function summaryTokensOf(
  block: CompressionBlock,
  countTokens: (t: string) => number,
): number {
  return countTokens(block.summary);
}

function effectiveCompressedTokens(
  block: CompressionBlock,
  _state: CompressionState,
  _countTokens: (t: string) => number,
): number {
  // block.compressedTokens already records the full input token count of the
  // operation that created this block: for a tier-1 block that is the raw
  // messages; for a tier-2 block it is the tier-1 summaries + the new
  // messages it spans. Recursing into directBlockIds and summing children's
  // compressedTokens double-counts the consumed children, so we return the
  // block's own value directly. (The previous recursion inflated tier-2+
  // "original" figures and mis-ordered the status report.)
  return block.compressedTokens;
}

function tierLabel(block: CompressionBlock): string {
  return `T${block.tier}`;
}

function tierBreakdown(
  blocks: CompressionBlock[],
  countTokens: (t: string) => number,
): string | null {
  const tierTokens: Record<number, number> = {};
  const tierCounts: Record<number, number> = {};
  for (const block of blocks) {
    tierTokens[block.tier] =
      (tierTokens[block.tier] ?? 0) + summaryTokensOf(block, countTokens);
    tierCounts[block.tier] = (tierCounts[block.tier] ?? 0) + 1;
  }
  const tiers = Object.keys(tierTokens).map(Number);
  if (tiers.length <= 1) return null;
  // Counts, not just tokens: the tier-distillation nudge lists every active
  // lower-tier block uncapped while the block list below may be truncated —
  // the count is what lets the model reconcile the two views (#221).
  const parts: string[] = [];
  for (const tier of [1, 2, 3]) {
    if (tierTokens[tier])
      parts.push(
        `T${tier}: ${formatTokens(tierTokens[tier])} (${tierCounts[tier]} blocks)`,
      );
  }
  return parts.join(" | ");
}

interface VisibleMessageInfo {
  ref: string;
  tokens: number;
  tool: string;
  isTool: boolean;
  index: number;
  isUser: boolean;
  gapBefore: boolean;
  /** Present for tool halves; lets the drill-down label BLOCKED compress
   *  receipts aged vs newest without re-scanning the message array. */
  toolCallId?: string;
}

/** A rendered block-summary node still resident in the view (id
 *  acp_summary_bN). It is visible on-wire mass, but its mass is already
 *  accounted in the summaryTokens ledger and it is NOT foldable as a plain
 *  m-ref range — only tier distillation (block-ID boundaries) folds it. */
interface SummaryNodeRow {
  ref: string;
  blockId: string;
  tokens: number;
}

function collectVisible(
  messages: CoreMessage[],
  state: CompressionState,
  countTokens: (t: string) => number,
): {
  visible: VisibleMessageInfo[];
  summaryTokens: number;
  summaryNodes: SummaryNodeRow[];
} {
  const coveredIds = new Set<string>();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) coveredIds.add(id);
  }
  let summaryTokens = 0;
  for (const block of state.blocks) {
    // #5765: retired summaries are not resident in the view — counting them
    // here would report context mass that is no longer on the wire. Coverage
    // above intentionally still includes retired blocks (their messages stay
    // folded away until acp_restore or decompress).
    if (block.active && !block.retired) summaryTokens += summaryTokensOf(block, countTokens);
  }
  const visible: VisibleMessageInfo[] = [];
  const summaryNodes: SummaryNodeRow[] = [];
  // Tool RESULTS carry no toolName of their own — resolve them through
  // their call so the tool bucket attributes result payload (#386: with
  // `toolName ?? "text"` every tool-result landed in the text bucket and
  // the tool bucket showed ~0.6% of the real volume).
  const toolCallNames = new Map<string, string>();
  for (const message of messages) {
    if (
      message.contentType === "tool-call" &&
      message.toolCallId &&
      message.toolName
    ) {
      toolCallNames.set(message.toolCallId, message.toolName);
    }
  }
  // A numbered-ref message that is not shown (covered by a block) consumes a
  // slot and opens a gap — same array-adjacency rule buildCompressibleRanges
  // applies to its skipped entries. Unrefed / BLOCKED / zero-token entries
  // consume no slot.
  let pendingGap = false;
  messages.forEach((message, index) => {
    const ref = refForRaw(state.messageRefs, message.id);
    if (!ref) return;
    const tokens = countMessageTokens(message, countTokens);
    // Rendered block-summary nodes: their mass is already counted in
    // summaryTokens above, and the nudge surface (buildCompressibleRanges)
    // never offers them as plain compressible ranges — it skips them and
    // opens a gap. Listing them as ordinary uncompressed rows made
    // already-compressed blocks look like fresh fold targets; the ranges
    // view now shows them in a labeled section instead, and splits there,
    // exactly where the nudge table splits.
    if (isRenderedSummaryMessage(message)) {
      if (ref !== BLOCKED_REF && tokens > 0) {
        const blockId = summaryBlockIdOf(message.id);
        if (blockId !== null) {
          summaryNodes.push({ ref, blockId, tokens });
          pendingGap = true;
        }
      }
      return;
    }
    if (!coveredIds.has(message.id) && tokens > 0) {
      const isTool = isToolMessage(message);
      const tool = isTool
        ? (message.toolName ??
          (message.toolCallId
            ? toolCallNames.get(message.toolCallId)
            : undefined) ??
          "tool")
        : "text";
      visible.push({
        ref,
        tokens,
        tool,
        isTool,
        index,
        isUser: message.role === "user",
        gapBefore: pendingGap,
        toolCallId: message.toolCallId,
      });
      // #2663: a live checkpoint carrier stays listed (it IS visible mass) but
      // must not be bridged across by a range row — the apply side refuses to
      // fold it in a plain range, exactly like buildCompressibleRanges screens
      // it. Stale carriers keep the old (no-gap) behavior.
      pendingGap = isLiveCheckpointCarrier(message, state);
      return;
    }
    if (ref !== BLOCKED_REF && tokens > 0) pendingGap = true;
  });
  return { visible, summaryTokens, summaryNodes };
}

/** Host-declared surface facts for status reports. The kernel never resolves
 *  packs — which pack is active is host policy (billion-context #730); the
 *  kernel only renders what the host declares about the active surface. */
export interface StatusReportMeta {
  pack?: string;
  packVersion?: string;
  host?: string;
}

export interface StatusReportOptions {
  scope?: "compressed" | "uncompressed";
  view?: "ranges" | "messages";
  tool?: string;
  sort?: "size" | "time" | "tool" | "age";
  limit?: number;
  meta?: StatusReportMeta;
  /** #3236: when both this and `originalMessages` are given, the
   * uncompressed range rows are screened through the SAME projection
   * applySingleRange executes and doomed rows get a ⚠ flag (diagnostic view —
   * rows are flagged, never dropped). Omit both for legacy output. */
  config?: Config;
  /** #3236: the exact array class applyCompression runs on (see
   * ProcessTurnInput.applyView). Screening is skipped without it — projecting
   * on the render view would judge a different array class than execute. */
  originalMessages?: CoreMessage[];
}

export function buildStatusReport(
  state: CompressionState,
  messages: CoreMessage[],
  countTokens: (t: string) => number,
  options: StatusReportOptions = {},
): string {
  const scope = options.scope;
  const view = options.view ?? "ranges";
  const toolFilter = options.tool;
  const sort = options.sort ?? "size";
  const limit = options.limit ?? 30;

  const activeBlocks = state.blocks
    .filter((b) => b.active)
    .sort((a, b) => numericPart(a.blockId) - numericPart(b.blockId));
  // #5765: retire splits the active set — retired blocks keep their coverage
  // and decompress entry but leave the resident view, so the overview shows
  // them in their own section instead of the COMPRESSED BLOCKS list. The
  // compressed drilldown still lists them (marked) so a specific block can be
  // inspected either way.
  const residentBlocks = activeBlocks.filter((b) => !b.retired);
  const retiredBlocks = activeBlocks.filter((b) => b.retired);

  if (scope === "compressed") {
    return renderCompressedDrilldown(
      activeBlocks,
      state,
      sort,
      limit,
      countTokens,
      options.meta,
    );
  }

  const { visible, summaryTokens, summaryNodes } = collectVisible(
    messages,
    state,
    countTokens,
  );

  if (scope === "uncompressed") {
    if (view === "messages") {
      // #7536: BLOCKED compress rows in the drill-down must read the same
      // way the fold gate judges them — aged receipts fold when a range
      // spans them, the newest few are working memory (kernel #4348).
      const cfg = options.config;
      const orig = options.originalMessages;
      const blockedInfo =
        cfg && orig
          ? {
              agedIds: collectAgedCompressCallIds(orig, cfg),
              isCompress: (t: string) => isCompressToolName(t, cfg),
            }
          : undefined;
      return renderMessageDrilldown(
        visible,
        toolFilter,
        sort,
        limit,
        blockedInfo,
      );
    }
    return renderUncompressedRanges(
      visible,
      summaryNodes,
      sort,
      limit,
      state,
      countTokens,
      options.config,
      options.originalMessages,
    );
  }

  return renderOverview(
    visible,
    summaryTokens,
    residentBlocks,
    retiredBlocks,
    state,
    countTokens,
    limit,
    options.meta,
  );
}

function surfaceLine(meta: StatusReportMeta | undefined): string | null {
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.pack)
    parts.push(
      `pack=${meta.pack}${meta.packVersion ? ` v${meta.packVersion}` : ""}`,
    );
  if (meta.host) parts.push(`host=${meta.host}`);
  if (parts.length === 0) return null;
  return `ACTIVE SURFACE: ${parts.join(" | ")}`;
}

function renderOverview(
  visible: VisibleMessageInfo[],
  summaryTokens: number,
  blocks: CompressionBlock[],
  retiredBlocks: CompressionBlock[],
  state: CompressionState,
  countTokens: (t: string) => number,
  limit: number,
  meta: StatusReportMeta | undefined,
): string {
  const lines: string[] = [];
  const surface = surfaceLine(meta);
  if (surface) {
    lines.push(surface);
    lines.push("");
  }
  const toolTypeMap = new Map<string, number>();
  for (const message of visible) {
    toolTypeMap.set(
      message.tool,
      (toolTypeMap.get(message.tool) ?? 0) + message.tokens,
    );
  }

  const totalTool = visible
    .filter((m) => m.isTool)
    .reduce((sum, m) => sum + m.tokens, 0);
  const totalText = visible
    .filter((m) => !m.isTool)
    .reduce((sum, m) => sum + m.tokens, 0);
  const total = summaryTokens + totalTool + totalText;

  lines.push("CONTEXT BREAKDOWN");
  lines.push(
    `  ${formatTokens(totalTool)} tool (${pct(totalTool, total)}%) | ${formatTokens(totalText)} text (${pct(totalText, total)}%) | ${formatTokens(summaryTokens)} summaries (${pct(summaryTokens, total)}%)`,
  );
  const topTypes = [...toolTypeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (topTypes.length > 0) {
    lines.push(
      `  Top tools: ${topTypes.map(([t, n]) => `${t} (${pct(n, total)}%)`).join(", ")}`,
    );
  }

  lines.push("");
  if (blocks.length === 0) {
    lines.push("COMPRESSED BLOCKS");
    lines.push("  No compressed blocks.");
  } else {
    const totalSummary = blocks.reduce(
      (s, b) => s + summaryTokensOf(b, countTokens),
      0,
    );
    const totalEffective = blocks.reduce(
      (s, b) => s + effectiveCompressedTokens(b, state, countTokens),
      0,
    );
    lines.push(
      `COMPRESSED BLOCKS — ${blocks.length} active (${formatTokens(totalSummary)} summary, ${formatTokens(totalEffective)} original)`,
    );
    const breakdown = tierBreakdown(blocks, countTokens);
    if (breakdown) lines.push(`  Tier usage: ${breakdown}`);
    lines.push("");
    const sorted = [...blocks].sort(
      (a, b) =>
        effectiveCompressedTokens(b, state, countTokens) -
          effectiveCompressedTokens(a, state, countTokens) ||
        b.createdAt - a.createdAt,
    );
    for (const block of sorted.slice(0, limit)) {
      const topic = block.topic ?? "(no topic)";
      const eff = effectiveCompressedTokens(block, state, countTokens);
      lines.push(
        `  ${block.blockId} (${tierLabel(block)})  ${formatTokens(eff)}→${formatTokens(summaryTokensOf(block, countTokens))}  ${block.effectiveMessageIds.length} msgs  "${topic}"`,
      );
    }
    if (blocks.length > limit) {
      lines.push(
        `  ... and ${blocks.length - limit} more blocks not shown (scope:"compressed", limit:${blocks.length} for full list)`,
      );
    }
  }

  // #5765 retire: retired blocks live in their own section — out of the
  // resident view but still restorable and decompressible.
  if (retiredBlocks.length > 0) {
    const freed = retiredBlocks.reduce(
      (s, b) => s + summaryTokensOf(b, countTokens),
      0,
    );
    lines.push("");
    lines.push(
      `RETIRED BLOCKS — ${retiredBlocks.length} out of the resident view (${formatTokens(freed)} summary kept off the wire)`,
    );
    const sorted = [...retiredBlocks].sort(
      (a, b) => numericPart(a.blockId) - numericPart(b.blockId),
    );
    for (const block of sorted.slice(0, limit)) {
      const topic = block.topic ?? "(no topic)";
      lines.push(
        `  ${block.blockId} (${tierLabel(block)})  ${formatTokens(summaryTokensOf(block, countTokens))} summary  ${block.effectiveMessageIds.length} msgs  "${topic}"`,
      );
    }
    if (retiredBlocks.length > limit) {
      lines.push(`  ... and ${retiredBlocks.length - limit} more retired blocks not shown`);
    }
    lines.push(
      `  acp_restore({ blockId }) puts a block back into the view; decompress/search_context work on retired blocks as usual.`,
    );
  }

  lines.push("");
  // #5555 audit: was leaking an internal function name + option keys;
  // scope/view/tool are declared params on every wire now, so this hint is
  // honest advice in the public contract. The default uncompressed output IS
  // the compressible-ranges listing (aligned with the injected nudge table)
  // — steer models there, not into the per-message detail view.
  lines.push(
    `Tip: call again with scope:"uncompressed" for the compressible-ranges listing (view:"messages" drills into individual refs)`,
  );
  return lines.join("\n");
}

function renderUncompressedRanges(
  visible: VisibleMessageInfo[],
  summaryNodes: SummaryNodeRow[],
  sort: string,
  limit: number,
  state: CompressionState,
  countTokens: (t: string) => number,
  config?: Config,
  original?: CoreMessage[],
): string {
  const lines: string[] = [];
  const totalTokens = visible.reduce((s, m) => s + m.tokens, 0);
  // Unrefed rows (protection-pinned, sentinel ref instead of a number) cannot
  // end or cite a range — buildCompressibleRanges (the nudge table) skips them
  // WITHOUT opening a gap, so range rows are built from the resolvable entries
  // only and the pinned mass gets its own labeled section below. Same splits,
  // same mass, no phantom "mX–BLOCKED ⚠ not foldable" rows (#6936: the
  // internal sentinel must never reach a model-facing label).
  const blockedRows = visible.filter((m) => m.ref === BLOCKED_REF);
  const rangeable = visible.filter((m) => m.ref !== BLOCKED_REF);
  // Clean sessions keep the historical header byte-for-byte; pinned rows are
  // appended as `+ N unrefed` only when present.
  lines.push(
    `UNCOMPRESSED — ${formatTokens(totalTokens)} | ${rangeable.length} visible messages${blockedRows.length > 0 ? ` + ${blockedRows.length} unrefed` : ""}`,
  );
  lines.push("");
  if (visible.length === 0 && summaryNodes.length === 0) {
    lines.push("  (no uncompressed messages)");
    return lines.join("\n");
  }
  // Segment via the shared primitive (segment.ts) — identical split rules to
  // buildCompressibleRanges — then aggregate token counts and dominant tool
  // so the view reads as blocks, not a per-message firehose.
  interface Merged {
    startRef: string;
    endRef: string;
    startIndex: number;
    count: number;
    tokens: number;
    toolTokens: Map<string, number>;
  }
  const dominantTool = (toolTokens: Map<string, number>): string => {
    let best = "text";
    let bestN = -1;
    for (const [tool, n] of toolTokens) {
      if (n > bestN) {
        best = tool;
        bestN = n;
      }
    }
    return best;
  };
  const merged: Merged[] = [];
  for (const group of segmentGroups(rangeable)) {
    const first = group[0]!;
    const r: Merged = {
      startRef: first.ref,
      endRef: first.ref,
      startIndex: first.index,
      count: 1,
      tokens: first.tokens,
      toolTokens: new Map<string, number>([[first.tool, first.tokens]]),
    };
    for (let i = 1; i < group.length; i++) {
      const m = group[i]!;
      r.endRef = m.ref;
      r.count += 1;
      r.tokens += m.tokens;
      r.toolTokens.set(m.tool, (r.toolTokens.get(m.tool) ?? 0) + m.tokens);
    }
    merged.push(r);
  }
  // Array index is the correct time proxy even on surface-replace hosts,
  // where mid-array summary nodes carry fresh HIGH refs and numeric-ref
  // ordering would mis-sort equal-size ranges.
  if (sort !== "time")
    merged.sort((a, b) => b.tokens - a.tokens || a.startIndex - b.startIndex);
  // #3236: screen displayed rows through the SAME projection applySingleRange
  // executes so a row that would be rejected wholesale carries a ⚠ flag. The
  // diagnostic view flags rather than drops — it must keep showing what is
  // visible even when it is not foldable as-is. Requires the exact array class
  // apply runs on (`original`); without it projection would judge a different
  // array class than execute, which is the #3236 bug itself.
  let flagFor: ((r: Merged) => string | null) | null = null;
  if (config && original) {
    const coverage = collectCoverage(state);
    const protectedRefs = computeProtectedRefs(
      original,
      state,
      config,
      countTokens,
    );
    // #5337 option A: every displayed row runs projectUnit against this same
    // (original, state, config) triple — share the per-pass O(n) derivations
    // instead of re-scanning the whole history per row (status refresh on a
    // long session).
    const shared = buildProjectionShared(original, state, config);
    const splitDescOf = (p: UnitProjection): string => {
      const parts: string[] = [];
      if (p.splitTurnCount > 0) parts.push(`${p.splitTurnCount} turn(s)`);
      if (p.splitPairCount > 0)
        parts.push(`${p.splitPairCount} tool call/result pair(s)`);
      return parts.join(" and ") || "turn structure";
    };
    flagFor = (r): string | null => {
      let proj: UnitProjection;
      try {
        proj = projectUnit({
          messages: original!,
          state,
          config,
          startRef: r.startRef,
          endRef: r.endRef,
          preExistingCoverage: coverage,
          protectedMessageIds: protectedRefs,
          shared,
        });
      } catch {
        return "\u26a0 not foldable: refs unresolvable";
      }
      if (proj.fatal?.kind === "zone")
        return "\u26a0 not foldable: protected zone only";
      if (proj.fatal?.kind === "split")
        return `\u26a0 not foldable: would split ${splitDescOf(proj)}`;
      if (proj.filteredIds.length === 0 && proj.consumedBlockIds.length === 0)
        return "\u26a0 not foldable: nothing new to fold";
      return null;
    };
  }
  lines.push(`Sorted by ${sort === "time" ? "time" : "size"}`);
  lines.push("");
  if (rangeable.length === 0) {
    lines.push("  (no raw uncompressed messages)");
  } else {
    for (const r of merged.slice(0, limit)) {
      // Ascending endpoint labels: non-monotonic refs (#1001) can make a
      // positional span's labels numerically descending (#2168).
      const range =
        r.count === 1
          ? r.startRef
          : orderedRefPair(r.startRef, r.endRef).join("–");
      const flag = flagFor ? flagFor(r) : null;
      lines.push(
        `  ${range}  (${r.count} msgs, ${formatTokens(r.tokens)}${r.count > 1 ? ` (${Math.round(r.tokens / r.count)}/msg)` : ""}) ${dominantTool(r.toolTokens)}${flag ? `  ${flag}` : ""}`,
      );
    }
    if (merged.length > limit) {
      lines.push(`  ... and ${merged.length - limit} more ranges`);
    }
    // Static skeleton (never range-aware — expanded skeletons grow with the
    // listing and leak onto query-only surfaces, #2302): the exact call shape
    // the ranges above are meant to be folded with.
    lines.push("");
    lines.push(
      `  To fold one of the ranges above: compress({ content: "m00150\u2013m00220 optional topic\\n<summary markdown>" })`,
    );
  }
  // Rendered block-summary nodes: already-compressed mass that plain m-ref
  // ranges do not fold. Shown separately (and split, as the nudge table does)
  // instead of masquerading as fresh fold targets.
  if (summaryNodes.length > 0) {
    const sumTokens = summaryNodes.reduce((s, n) => s + n.tokens, 0);
    lines.push("");
    lines.push(
      `ALREADY-COMPRESSED SUMMARY NODES — ${summaryNodes.length} node(s), ${formatTokens(sumTokens)}`,
    );
    const shown = summaryNodes.slice(0, limit);
    lines.push(
      `  ${shown
        .map((n) => {
          const block = state.blocks.find(
            (b) => b.blockId === n.blockId && b.active,
          );
          return block
            ? `${n.blockId} (T${block.tier}) ${formatTokens(n.tokens)}`
            : `${n.blockId} ${formatTokens(n.tokens)}`;
        })
        .join(" \u00b7 ")}`,
    );
    if (summaryNodes.length > limit) {
      lines.push(
        `  ... and ${summaryNodes.length - limit} more nodes (scope:"compressed" lists every block)`,
      );
    }
    lines.push(
      `  These are block summaries already in the view — plain m-ref ranges do not fold them; only tier distillation (block-ID boundaries) does.`,
    );
    const hint = config ? tierActionHint(config, state).trim() : "";
    if (hint) {
      lines.push(`  ${hint}`);
    } else if (config) {
      lines.push(
        `  Tier distillation is not armed yet — the nudge announces when block-ID distillation is actionable.`,
      );
    } else {
      lines.push(
        `  Fold them via tier distillation: compress({ content: "b1\u2013bN optional topic\\nsummary markdown..." })`,
      );
    }
  }
  // Protection-pinned mass: no numeric ref, so no range can cite or fold it
  // directly — the nudge table skips it silently; this section is where the
  // meter-vs-offer gap is named on this surface (the host-side attribution
  // line is PROTECTED MASS, #7463). Compress receipts carry the #4348 truth:
  // aged ones ARE consumed by any fold that spans their position, the newest
  // few are working memory.
  if (blockedRows.length > 0) {
    const blockedTokens = blockedRows.reduce((s, m) => s + m.tokens, 0);
    lines.push("");
    lines.push(
      `UNREFED MESSAGES — ${blockedRows.length} msg(s), ${formatTokens(blockedTokens)} (protected rows — no m-ref to cite; cannot be folded by name)`,
    );
    const isCompressRow = (m: VisibleMessageInfo) =>
      config ? isCompressToolName(m.tool, config) : m.tool === "compress";
    const compressRows = blockedRows.filter(isCompressRow);
    const otherRows = blockedRows.filter((m) => !isCompressRow(m));
    if (compressRows.length > 0) {
      const cTokens = compressRows.reduce((s, m) => s + m.tokens, 0);
      const callIds = new Set<string>();
      for (const m of compressRows) if (m.toolCallId) callIds.add(m.toolCallId);
      const exchangeCount =
        callIds.size > 0 ? callIds.size : compressRows.length;
      let detail = " — pinned compress receipts";
      if (config && original) {
        const agedAll = collectAgedCompressCallIds(original, config);
        const aged = [...callIds].filter((id) => agedAll.has(id)).length;
        const newest = exchangeCount - aged;
        detail =
          " — pinned compress receipts: " +
          (newest > 0 ? `${newest} newest = working memory; ` : "") +
          (aged > 0
            ? `the ${aged} older exchange(s) are consumed by any fold that spans their position (cite the refs on either side)`
            : `all ${exchangeCount} are protected working memory (newest ${COMPRESS_EXCHANGE_KEEP_RECENT} stay pinned)`);
      }
      lines.push(
        `  compress: ${exchangeCount} exchange(s), ${formatTokens(cTokens)}${detail}`,
      );
    }
    if (otherRows.length > 0) {
      const oTokens = otherRows.reduce((s, m) => s + m.tokens, 0);
      lines.push(
        `  other: ${otherRows.length} msg(s), ${formatTokens(oTokens)} — hard protection (unrecoverable media / protectedTools)`,
      );
    }
  }
  return lines.join("\n");
}

function renderMessageDrilldown(
  visible: VisibleMessageInfo[],
  toolFilter: string | undefined,
  sort: string,
  limit: number,
  blockedInfo?: {
    agedIds: Set<string>;
    isCompress: (tool: string) => boolean;
  },
): string {
  let filtered = visible;
  if (toolFilter) filtered = filtered.filter((m) => m.tool === toolFilter);

  if (sort === "time") filtered.sort((a, b) => a.index - b.index);
  else if (sort === "tool")
    filtered.sort(
      (a, b) => a.tool.localeCompare(b.tool) || b.tokens - a.tokens,
    );
  else filtered.sort((a, b) => b.tokens - a.tokens);

  const totalTokens = filtered.reduce((s, m) => s + m.tokens, 0);
  const allTokens = visible.reduce((s, m) => s + m.tokens, 0);
  const header = toolFilter
    ? `UNCOMPRESSED — ${toolFilter}: ${formatTokens(totalTokens)} | ${filtered.length} msgs | ${pct(totalTokens, allTokens)}% of visible`
    : `UNCOMPRESSED — ${formatTokens(totalTokens)} | ${filtered.length} msgs`;
  const lines = [header, `Sorted by ${sort}`, ""];
  const shown = filtered.slice(0, limit);
  for (const message of shown) {
    // #7536: a bare "BLOCKED (x) compress" row read as uncompressible junk;
    // the fold gate (kernel #4348) says otherwise for the aged ones. Label
    // with the same split the gate uses.
    let suffix = "";
    if (message.ref === BLOCKED_REF) {
      if (blockedInfo?.isCompress(message.tool)) {
        suffix =
          message.toolCallId && blockedInfo.agedIds.has(message.toolCallId)
            ? " \u00b7 aged \u2014 folds when a range spans it"
            : " \u00b7 newest \u2014 working memory";
      } else if (message.tool !== "text") {
        suffix = " \u00b7 protected";
      }
    }
    lines.push(
      `  ${message.ref === BLOCKED_REF ? "(unrefed)" : message.ref} (${formatTokens(message.tokens)}) ${message.tool}${suffix}`,
    );
  }
  if (filtered.length > shown.length) {
    lines.push("");
    lines.push(`${shown.length} of ${filtered.length} shown.`);
  }
  return lines.join("\n");
}

function renderCompressedDrilldown(
  blocks: CompressionBlock[],
  state: CompressionState,
  sort: string,
  limit: number,
  countTokens: (t: string) => number,
  meta: StatusReportMeta | undefined,
): string {
  let sorted = [...blocks];
  if (sort === "time") sorted.sort((a, b) => a.createdAt - b.createdAt);
  else if (sort === "age")
    sorted.sort((a, b) => b.survivedCount - a.survivedCount);
  else
    sorted.sort(
      (a, b) =>
        effectiveCompressedTokens(b, state, countTokens) -
          effectiveCompressedTokens(a, state, countTokens) ||
        b.createdAt - a.createdAt,
    );

  const totalSummary = sorted.reduce(
    (s, b) => s + summaryTokensOf(b, countTokens),
    0,
  );
  const totalEffective = sorted.reduce(
    (s, b) => s + effectiveCompressedTokens(b, state, countTokens),
    0,
  );
  const lines: string[] = [];
  const surface = surfaceLine(meta);
  if (surface) {
    lines.push(surface);
    lines.push("");
  }
  lines.push(
    `COMPRESSED — ${sorted.length} blocks | ${formatTokens(totalEffective)} original → ${formatTokens(totalSummary)} summary`,
  );
  const breakdown = tierBreakdown(sorted, countTokens);
  if (breakdown) lines.push(`Tier usage: ${breakdown}`);
  lines.push("");
  const shown = sorted.slice(0, limit);
  for (const block of shown) {
    const nested =
      block.directBlockIds.length > 0
        ? ` nested=[${block.directBlockIds.join(",")}]`
        : "";
    const topic = block.topic ?? "(no topic)";
    const eff = effectiveCompressedTokens(block, state, countTokens);
    // #5765: retired blocks stay listed (inspectable) but marked — their
    // summary is out of the resident view until acp_restore.
    const retiredMark = block.retired ? ", retired" : "";
    lines.push(
      `  ${block.blockId} (${tierLabel(block)}${retiredMark})  ${formatTokens(eff)}→${formatTokens(summaryTokensOf(block, countTokens))}  ${block.effectiveMessageIds.length} msgs  age=${block.survivedCount} ${block.generation}${nested}`,
    );
    lines.push(`    "${topic}"`);
  }
  if (sorted.length > shown.length) {
    lines.push("");
    lines.push(`${shown.length} of ${sorted.length} shown.`);
  }
  return lines.join("\n");
}

export function buildRecap(state: CompressionState, blockId?: string): string {
  const activeBlocks = state.blocks
    .filter((b) => b.active)
    .sort((a, b) => numericPart(a.blockId) - numericPart(b.blockId));

  if (blockId !== undefined) {
    const block = state.blocks.find((b) => b.blockId === blockId);
    if (!block) {
      const activeList = activeBlocks.map((b) => b.blockId).join(", ");
      return `Block ${blockId} not found. Active blocks: ${activeList}`;
    }
    if (!block.active) {
      return `Block ${blockId} is inactive (deactivated by nested compression).`;
    }
    const range = `${block.effectiveMessageIds.length} messages`;
    return `[Compressed conversation section]\n${block.summary}\n\n[${blockId} | ${range} | topic: "${block.topic ?? "(none)"}"]`;
  }

  if (activeBlocks.length === 0) return "No active compression blocks.";

  const lines = [`Active compression blocks (${activeBlocks.length}):`];
  for (const block of activeBlocks) {
    const range = `${block.effectiveMessageIds.length} messages`;
    const preview = clampPrefix(block.summary, 200);
    lines.push(`\n${block.blockId} | ${range} | "${block.topic ?? "(none)"}"`);
    lines.push(`  ${preview}${block.summary.length > 200 ? "..." : ""}`);
  }
  lines.push(`\nCall with blockId to get the full summary.`);
  return lines.join("\n");
}
