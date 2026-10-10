import type {
  NudgeDecision,
  CompressibleRange,
  ProtectedRange,
  ContextBreakdown,
  CompressionBlock,
  BlockSpan,
} from "./types.js";
import { defaultPrompts } from "./prompts.js";
import type { Prompts } from "./prompts.js";
import { orderedRefPair } from "./refs.js";

export type NudgeVoice = "gentle" | "emergency";

export interface NudgePromptSections {
  efficiencyNote?: string | null;
  emergencyHeader?: string | null;
  t2Guidance?: string | null;
  t3Guidance?: string | null;
}

export interface RenderedNudge {
  voice: NudgeVoice;
  text: string;
}

function efficiencyNote(
  prompts: Prompts,
  sections: NudgePromptSections,
): string | null {
  if (sections.efficiencyNote !== undefined) return sections.efficiencyNote;
  return `This is an efficiency nudge to compress early and keep context lean — not an overflow warning. A separate, stronger alert will appear if the context is actually full.\n\n${prompts.compressPhilosophy}`;
}

function emergencyHeader(
  prompts: Prompts,
  sections: NudgePromptSections,
): string | null {
  if (sections.emergencyHeader !== undefined) return sections.emergencyHeader;
  return `⚠️ Context limit reached — compress now. Prioritize consumed tool outputs.\n\n${prompts.compressPhilosophy}`;
}

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

function formatBreakdown(bd?: ContextBreakdown): string {
  if (!bd) return "";
  const parts: string[] = [];
  if (bd.system > 0) parts.push(`${formatK(bd.system)} system`);
  if (bd.tool > 0) parts.push(`${formatK(bd.tool)} tool`);
  if (bd.summaries > 0) parts.push(`${formatK(bd.summaries)} summaries`);
  if (bd.code > 0) parts.push(`${formatK(bd.code)} code`);
  if (bd.text > 0) parts.push(`${formatK(bd.text)} text`);
  const growth =
    bd.growth > 0 ? `\n+${formatK(bd.growth)} since last nudge` : "";
  return `Context breakdown: ${parts.join(" | ")}${growth}`;
}

function formatTierTargetBlocks(blocks: CompressionBlock[]): string {
  if (blocks.length === 0) {
    return "Target blocks: (none — no tier blocks found)";
  }
  const lines = blocks.map((b) => {
    const summaryTokens = Math.ceil((b.summary ?? "").length / 4);
    const topic = b.topic ? `  "${b.topic}"` : "";
    return `  ${b.blockId}  ${b.effectiveMessageIds.length} msgs  ${formatK(b.compressedTokens)}→${formatK(summaryTokens)}${topic}`;
  });
  return `Target ${blocks[0]!.tier === 1 ? "tier-1" : "tier-2"} blocks to distill (${blocks.length}):\n${lines.join("\n")}`;
}

const BLOCK_MAP_MAX_SHOWN = 8;

function formatBlockMap(spans: BlockSpan[]): string {
  if (spans.length === 0) return "";
  const hidden = Math.max(0, spans.length - BLOCK_MAP_MAX_SHOWN);
  const shown = hidden > 0 ? spans.slice(-BLOCK_MAP_MAX_SHOWN) : spans;
  const items = shown.map(
    (s) =>
      `${s.blockId}=${s.startRef}–${s.endRef}${s.tier > 1 ? ` t${s.tier}` : ""}`,
  );
  const prefix = hidden > 0 ? `…+${hidden} older · ` : "";
  return `Active blocks (${spans.length}): ${prefix}${items.join(" · ")}`;
}

export function formatRanges(
  compressible: CompressibleRange[],
  protectedRanges: ProtectedRange[],
): string {
  if (compressible.length === 0 && protectedRanges.length === 0) {
    return "[No specific ranges detected — compress any consumed content.]";
  }

  // Merge compressible + protected into a single oldest-first list, mirroring
  // opencode-acp's formatCompressibleRanges. Splitting them into two sections
  // lost the time order and hid overlaps; a range can be partly compressible
  // and partly protected, which only the merged view shows correctly.
  interface Merged {
    startRef: string;
    endRef: string;
    startNum: number;
    endNum: number;
    startPos: number;
    endPos: number;
    count: number;
    tokens: number;
    userMsgs: number;
    compressibleTokens: number;
    compressibleCount: number;
    protectedTokens: number;
    protectedCount: number;
    protectedTools: string[];
    toolPct: number;
    textPct: number;
    dangerous: boolean;
  }
  const refNum = (ref: string): number => {
    const m = ref.match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  };
  const entries: Merged[] = [];
  for (const r of compressible) {
    entries.push({
      startRef: r.startRef,
      endRef: r.endRef,
      startNum: refNum(r.startRef),
      endNum: refNum(r.endRef),
      startPos: r.startIndex ?? refNum(r.startRef),
      endPos: r.endIndex ?? refNum(r.endRef),
      count: r.count,
      tokens: r.tokens,
      userMsgs: r.userMsgs ?? 0,
      toolPct: r.toolPct,
      textPct: r.textPct,
      compressibleTokens: r.tokens,
      compressibleCount: r.count,
      protectedTokens: 0,
      protectedCount: 0,
      protectedTools: [],
      dangerous: r.dangerous ?? false,
    });
  }
  for (const r of protectedRanges) {
    entries.push({
      startRef: r.startRef,
      endRef: r.endRef,
      startNum: refNum(r.startRef),
      endNum: refNum(r.endRef),
      startPos: r.startIndex ?? refNum(r.startRef),
      endPos: r.endIndex ?? refNum(r.endRef),
      count: r.count,
      tokens: r.tokens,
      userMsgs: 0,
      toolPct: 0,
      textPct: 0,
      compressibleTokens: 0,
      compressibleCount: 0,
      protectedTokens: r.tokens,
      protectedCount: r.count,
      protectedTools: [...r.tools],
      dangerous: false,
    });
  }
  // Order/merge by POSITION, never ref number: refs can be non-monotonic vs array
  // order (subagent interleaving / mid-array summary nodes), and ref-number merging
  // then yields endpoints resolveBoundaries collapses to a tiny slice (#887).
  entries.sort((a, b) => a.startPos - b.startPos || a.startNum - b.startNum);
  // Merge positionally adjacent/overlapping ranges (gap ≤ 1 slot).
  const merged: Merged[] = [];
  for (const e of entries) {
    const last = merged[merged.length - 1];
    if (last && e.startPos <= last.endPos + 1) {
      last.endRef = e.endRef;
      last.endNum = Math.max(last.endNum, e.endNum);
      last.endPos = Math.max(last.endPos, e.endPos);
      last.count += e.count;
      last.tokens += e.tokens;
      last.userMsgs += e.userMsgs;
      last.compressibleTokens += e.compressibleTokens;
      last.compressibleCount += e.compressibleCount;
      last.protectedTokens += e.protectedTokens;
      last.protectedCount += e.protectedCount;
      if (e.dangerous) last.dangerous = true;
      for (const t of e.protectedTools) {
        if (!last.protectedTools.includes(t)) last.protectedTools.push(t);
      }
    } else {
      merged.push({ ...e });
    }
  }
  const userNote = (n: number): string =>
    n > 0 ? ` · ${n} user msg${n > 1 ? "s" : ""}` : "";
  const lines = merged.map((e) => {
    // Direction is notational (resolveBoundaries swaps reversed pairs), so
    // print endpoint labels ascending: non-monotonic-ref spans must not read
    // as malformed ranges (#2168, #1001).
    const [lo, hi] = orderedRefPair(e.startRef, e.endRef);
    const suffix =
      e.dangerous && e.compressibleTokens > 0
        ? "  ⚠️ NOT recommended unless you are certain."
        : "";
    if (e.protectedTokens > 0 && e.compressibleTokens === 0) {
      return `  ${lo}–${hi}  ${e.count} msgs  ${formatK(e.tokens)} [PROTECTED: ${e.protectedTools.join(", ")} — not compressible]${suffix}`;
    }
    if (e.protectedTokens > 0 && e.compressibleTokens > 0) {
      return `  ${lo}–${hi}  ${e.count} msgs  ${formatK(e.tokens)} [${formatK(e.compressibleTokens)} compressible | ${formatK(e.protectedTokens)} protected: ${e.protectedTools.join(", ")}]${userNote(e.userMsgs)}${suffix}`;
    }
    return `  ${lo}–${hi}  ${e.count} msgs  ${formatK(e.tokens)} [tool ${e.toolPct}% | text ${e.textPct}%]${userNote(e.userMsgs)}${suffix}`;
  });
  return `Compressible ranges (${merged.length}, oldest first):\n${lines.join("\n")}`;
}

const DEFAULT_T2_GUIDANCE = `Your tier-1 compression summaries have accumulated. Distill them into a single denser tier-2 summary. Use block IDs as boundaries (startId and endId as bN). Any raw (uncompressed) messages sitting between the boundary blocks are absorbed into the tier-2 block as well — apply HOW TO COMPRESS to those raw messages and the TIER 2 distillation rules to the existing summaries, so the whole span is covered and nothing is lost.`;

const DEFAULT_T3_GUIDANCE = `Your tier-2 compression summaries have accumulated. Condense them further into a tier-3 ultra-condensed summary. Use block IDs as boundaries (startId and endId as bN). Any raw (uncompressed) messages sitting between the boundary blocks are absorbed into the tier-3 block as well — apply HOW TO COMPRESS to those raw messages and the TIER 3 condensation rules to the existing summaries, so the whole span is covered and nothing is lost.`;

function tierGuidance(
  tier: 2 | 3,
  sections: NudgePromptSections,
): string | null {
  const value = tier === 2 ? sections.t2Guidance : sections.t3Guidance;
  if (value !== undefined) return value;
  return tier === 2 ? DEFAULT_T2_GUIDANCE : DEFAULT_T3_GUIDANCE;
}

function compact(parts: string[]): string[] {
  while (parts.length > 0 && parts[0] === "") parts.shift();
  return parts;
}

/** #2302 root-cause fix, distilled to a STATIC reminder. The nudge used to
 *  hand the model a LIST of recommended ranges plus a batching hint — and the
 *  model digests the list in groups, one compress call per group. Each separate
 *  call resets the provider prefix cache from its fold point and re-bills the
 *  whole remaining history; one call carrying every range pays once (live
 *  incident: five single-range calls over 44s on a 555K-token session
 *  re-billed 1.38M tokens; one 9-range call on the same log paid once).
 *  Instructions about batching do not survive contact with the model — but
 *  the expanded ready-to-fill skeleton had its own failure mode (#2377
 *  review): it grows linearly with the range count, reads like a mandatory
 *  to-do list (eroding the model's own judgment on WHAT to fold), and leaked
 *  onto query-only surfaces (acp_status). So the reminder is now ONE static
 *  line — never expanded, never range-aware, identical for every nudge. */
export const ONE_CALL_HINT =
  "ONE call — fold every range you keep into a single compress call: content = [{startId, endId, summary, topic?}, …] entries (strict JSON: every string quoted, internal double quotes written \\\", newlines written \\n), or one quoted string holding one block per range ('m00150–m00220 topic' header line, then the summary — all inside the quotes). Ranges you still need can wait — they reappear in later nudges; never split the batch across separate calls.";

export function renderNudgeText(
  decision: NudgeDecision,
  prompts: Prompts = defaultPrompts,
  sections: NudgePromptSections = {},
): RenderedNudge {
  const breakdownStr = formatBreakdown(decision.contextBreakdown);
  const rangesStr = formatRanges(
    decision.compressibleRanges,
    decision.protectedRanges ?? [],
  );
  const blockMapStr = formatBlockMap(decision.activeBlockSpans ?? []);
  const isEmergency =
    !!decision.breakdown?.emergencyOverride || !!decision.breakdown?.overLimit;

  if (decision.tier !== null && decision.tier >= 2) {
    const isT2 = decision.tier === 2;
    const targets = decision.tierTargetBlocks ?? [];
    const blockList = formatTierTargetBlocks(targets);
    const startId = targets[0]?.blockId ?? "b1";
    const endId = targets[targets.length - 1]?.blockId ?? "b5";
    const voice: NudgeVoice = isEmergency ? "emergency" : "gentle";
    const triggerLine = isEmergency
      ? `[EMERGENCY — TIER ${decision.tier} ${isT2 ? "DISTILLATION" : "CONDENSATION"}] Context limit reached — distill NOW into a denser summary to reclaim tokens.`
      : `[TIER ${decision.tier} ${isT2 ? "DISTILLATION" : "CONDENSATION"} TRIGGER]`;
    const guidance = tierGuidance(isT2 ? 2 : 3, sections);
    const head = efficiencyNote(prompts, sections);
    return {
      voice,
      text: compact([
        ...(head === null ? [] : [head]),
        "",
        breakdownStr,
        "",
        triggerLine,
        ...(guidance === null ? [] : [guidance]),
        blockList,
        `Example: compress({ content: [{ startId: "${startId}", endId: "${endId}", summary: "..." }] })`,
        "",
        prompts.howToCompressRules,
        "",
        isT2 ? prompts.tier2DistillRules : prompts.tier3CondenseRules,
      ]).join("\n"),
    };
  }

  if (isEmergency) {
    const head = emergencyHeader(prompts, sections);
    return {
      voice: "emergency",
      text: compact([
        ...(head === null ? [] : [head]),
        "",
        breakdownStr,
        "",
        prompts.howToCompressRules,
        "",
        "Only use IDs from visible messages above. Compress older work first.",
        "",
        rangesStr,
        ...(blockMapStr ? ["", blockMapStr] : []),
        "",
        ONE_CALL_HINT,
      ]).join("\n"),
    };
  }

  const gentleHead = efficiencyNote(prompts, sections);
  return {
    voice: "gentle",
    text: compact([
      ...(gentleHead === null ? [] : [gentleHead]),
      "",
      breakdownStr,
      "",
      prompts.howToCompressRules,
      "",
      rangesStr,
      ...(blockMapStr ? ["", blockMapStr] : []),
      "",
      `💡 If you compress, fold the ranges you keep in ONE call — content entries (\`content: [{...}, {...}]\`, strict JSON: every string quoted, internal double quotes written \\\", newlines written \\n) or ONE quoted string holding every range, each block starting with its 'mNNNNN–mNNNNN topic' header line inside the quotes. Ranges the task still needs can wait — they reappear in later nudges.`,
    ]).join("\n"),
  };
}
