import { clampPrefix } from "./truncate.js";
import { isToolMessage } from "./message-kind.js";
import { BLOCKED_REF, orderedRefPair, refForRaw } from "./refs.js";
import { countMessageTokens } from "./tokenize.js";
import { segmentGroups } from "./segment.js";
import { isLiveCheckpointCarrier } from "./state.js";
import type {
  CompressionBlock,
  CompressionState,
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
}

function collectVisible(
  messages: CoreMessage[],
  state: CompressionState,
  countTokens: (t: string) => number,
): { visible: VisibleMessageInfo[]; summaryTokens: number } {
  const coveredIds = new Set<string>();
  for (const block of state.blocks) {
    if (!block.active) continue;
    for (const id of block.effectiveMessageIds) coveredIds.add(id);
  }
  let summaryTokens = 0;
  for (const block of state.blocks) {
    if (block.active) summaryTokens += summaryTokensOf(block, countTokens);
  }
  const visible: VisibleMessageInfo[] = [];
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
  return { visible, summaryTokens };
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

  const { visible, summaryTokens } = collectVisible(
    messages,
    state,
    countTokens,
  );

  if (scope === "uncompressed") {
    if (view === "messages") {
      return renderMessageDrilldown(visible, toolFilter, sort, limit);
    }
    return renderUncompressedRanges(visible, sort, limit);
  }

  return renderOverview(
    visible,
    summaryTokens,
    activeBlocks,
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
  const topTool = [...toolTypeMap.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0]?.[0];

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

  lines.push("");
  lines.push(
    `Tip: buildStatusReport({scope:"uncompressed", view:"messages", tool:"${topTool ?? "bash"}"}) for per-message listing`,
  );
  return lines.join("\n");
}

function renderUncompressedRanges(
  visible: VisibleMessageInfo[],
  sort: string,
  limit: number,
): string {
  const lines: string[] = [];
  const totalTokens = visible.reduce((s, m) => s + m.tokens, 0);
  lines.push(
    `UNCOMPRESSED — ${formatTokens(totalTokens)} | ${visible.length} visible messages`,
  );
  lines.push("");
  if (visible.length === 0) {
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
  for (const group of segmentGroups(visible)) {
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
  lines.push(`Sorted by ${sort === "time" ? "time" : "size"}`);
  lines.push("");
  for (const r of merged.slice(0, limit)) {
    // Ascending endpoint labels: non-monotonic refs (#1001) can make a
    // positional span's labels numerically descending (#2168).
    const range =
      r.count === 1
        ? r.startRef
        : orderedRefPair(r.startRef, r.endRef).join("–");
    lines.push(
      `  ${range}  (${r.count} msgs, ${formatTokens(r.tokens)}${r.count > 1 ? ` (${Math.round(r.tokens / r.count)}/msg)` : ""}) ${dominantTool(r.toolTokens)}`,
    );
  }
  if (merged.length > limit) {
    lines.push(`  ... and ${merged.length - limit} more ranges`);
  }
  return lines.join("\n");
}

function renderMessageDrilldown(
  visible: VisibleMessageInfo[],
  toolFilter: string | undefined,
  sort: string,
  limit: number,
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
    lines.push(
      `  ${message.ref} (${formatTokens(message.tokens)}) ${message.tool}`,
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
    lines.push(
      `  ${block.blockId} (${tierLabel(block)})  ${formatTokens(eff)}→${formatTokens(summaryTokensOf(block, countTokens))}  ${block.effectiveMessageIds.length} msgs  age=${block.survivedCount} ${block.generation}${nested}`,
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
