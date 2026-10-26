import { defaultCountTokens } from "../tokenize.js";
import { formatRanges } from "../nudge-text.js";
import type { CompressionState, NudgeDecision } from "../types.js";
import { formatCompactTokens } from "./format.js";
import { topicFallback } from "./topic.js";
import { viableRanges } from "../viable.js";
import {
  cacheHitStats,
  formatHitRate,
  type CacheUsageSample,
} from "./cache.js";

export interface StatusPanelInput {
  /** Adapter identifier for the header, e.g. "billion-context-omp@0.1.6".
   *  Omit to hide the version line. */
  version?: string;
  /** Host session accounting — the SAME number the host footer displays.
   *  It includes compressed originals (summaries stay in the window), so it
   *  shrinks slower than the sent view when compression prunes the
   *  per-request projection. */
  tokenCount: number;
  /** Measured token count of the host system prompt (host-specific to
   *  obtain; the kernel breakdown does not see it). */
  systemPromptTokens: number;
  /** Kernel state (blocks drive the Blocks section). */
  state: CompressionState;
  /** The nudge decision from core.processTurn for this turn, if any. The
   *  panel applies the viability filter to compressibleRanges itself. */
  nudge: NudgeDecision | undefined;
  /** Configured model context window, in tokens. */
  modelContextLimit: number;
  /** Estimate of the FULL (unpruned) core-message projection, computed
   *  with the SAME countTokens the core uses (kernel default = CJK-aware
   *  defaultCountTokens) — the same estimation scale as the kernel
   *  breakdown. When provided, the panel derives `Session-only` on that
   *  scale (unpruned − sent). Without it the line is omitted: subtracting
   *  the host's provider-scale number from an estimate-scale number
   *  invents a third, meaningless scale (issue #18 "看板统计的和拆分的有差异"). */
  unprunedTokens?: number;
  /** One-line human-readable storage-mode label (e.g. "storage: full
   *  (unified-first reads, dual-write)"). Pre-rendered by the host from the
   *  effective mode — the kernel never guesses. Omit to hide the line. */
  storage?: string;
  /** Per-request prompt-cache usage (from assistant messages' provider-
   *  reported `usage`). Requests without cache reporting are excluded by
   *  cacheHitStats; when no counted request remains, the section is
   *  omitted entirely. Omit the field to hide the section. */
  cacheUsages?: ReadonlyArray<CacheUsageSample>;
  /** Token formatter override (defaults to formatCompactTokens). */
  fmtTokens?: (n: number) => string;
  /** Block ids whose summaries were written by an out-of-band executor
   *  (e.g. the host's external summary service) rather than the model
   *  itself. Purely cosmetic: the panel marks these lines with "⚡ext".
   *  Omit to render without markers. */
  externalBlockIds?: ReadonlySet<string>;
}

function bar(value: number, total: number, width: number = 20): string {
  if (total === 0) return "";
  const filled = Math.max(
    0,
    Math.min(width, Math.round((value / total) * width)),
  );
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Render the /acp status panel. Three token numbers, each labeled with
 *  its own scale, never mixed in arithmetic:
 *  - Session accounting (host footer scale): the host's reported context
 *    size INCLUDING compressed originals (summaries stay in the window), so
 *    it shrinks slower than the sent view when compression prunes the
 *    per-request projection.
 *  - Sent view (estimated, kernel countTokens scale): what actually
 *    reaches the LLM after compression (kernel's classification over the
 *    pruned projection + measured system prompt). This is the number
 *    compression controls.
 *  - Session-only (estimated, kernel countTokens scale): unpruned
 *    projection − sent view; the compressed originals pruned from every
 *    request.
 *  Subtracting the host number from an estimate produced numbers that
 *  reconciled with neither scale ("Framework 390K", "session-only 29k vs
 *  112k compressed") — that is what issue #18 reported. */
export function buildStatusPanel(input: StatusPanelInput): string {
  const { tokenCount, state, nudge, modelContextLimit } = input;
  const fmt = input.fmtTokens ?? formatCompactTokens;
  const externalBlockIds = input.externalBlockIds;
  const bd = nudge?.contextBreakdown;
  const limit = modelContextLimit;
  const classified = bd
    ? bd.system + bd.tool + bd.summaries + bd.code + bd.text
    : 0;
  const systemPromptTokens = input.systemPromptTokens;
  const sentTotal = classified + systemPromptTokens;
  // Same-scale derivation only: both sides use the core's countTokens
  // estimate (kernel default = CJK-aware defaultCountTokens). The host
  // footer's tokenCount (provider-anchored, session-tree) is displayed as
  // its own line and never fed into an arithmetic difference with these.
  const sessionOnly =
    input.unprunedTokens !== undefined
      ? Math.max(0, input.unprunedTokens - sentTotal)
      : 0;
  const displayTotal = tokenCount;
  const displayPct = limit > 0 ? Math.round((displayTotal / limit) * 100) : 0;
  const sentPct = limit > 0 ? Math.round((sentTotal / limit) * 100) : 0;
  const activeBlocksList = state.blocks.filter((b) => b.active);
  const totalBlocksList = state.blocks;

  const lines: string[] = [];

  lines.push("╭─────────────────────────────────────────────╮");
  lines.push("│           ACP Context Analysis              │");
  lines.push("╰─────────────────────────────────────────────╯");
  if (input.version) lines.push(input.version);
  if (input.storage) lines.push(input.storage);
  lines.push("");
  lines.push(
    `Context (session accounting, host footer scale): ${displayPct}% (${fmt(displayTotal)} / ${fmt(limit)}) — includes compressed originals; shrinks slower than the sent view`,
  );

  if (nudge && bd) {
    const growth = bd.growth;
    if (growth > 0 && displayTotal > 0) {
      lines.push(`Growth: +${fmt(growth)} since last nudge`);
    }
    lines.push("");
    lines.push(
      `Sent to LLM (after compression, est.): ${fmt(sentTotal)}${limit > 0 ? ` (${sentPct}% of limit)` : ""}`,
    );
    if (input.unprunedTokens !== undefined && sessionOnly > 0) {
      lines.push(
        `Session-only (compressed originals, est.): ${fmt(sessionOnly)} — pruned from every request; the footer/nudge still count them`,
      );
    }
    lines.push("");
    lines.push("Token Breakdown (sent view):");

    const categories: Array<{ label: string; value: number }> = [
      { label: "Tool", value: bd.tool },
      { label: "SysPrompt", value: systemPromptTokens },
      { label: "Text", value: bd.text },
      { label: "Code", value: bd.code },
      { label: "Summaries", value: bd.summaries },
    ];

    for (const cat of categories) {
      if (cat.value <= 0) continue;
      const pct = sentTotal > 0 ? Math.round((cat.value / sentTotal) * 100) : 0;
      const b = bar(cat.value, sentTotal);
      lines.push(
        `  ${cat.label.padEnd(10)} ${b} ${String(pct).padStart(3)}%  ${fmt(cat.value)}`,
      );
    }
  }

  if (input.cacheUsages) {
    const cache = cacheHitStats(input.cacheUsages);
    if (
      cache.requests > 0 &&
      cache.session !== undefined &&
      cache.last !== undefined
    ) {
      lines.push("");
      lines.push(
        `Prompt cache (provider-reported): ${formatHitRate(cache.last)} last · ${formatHitRate(cache.session)} session avg — ${fmt(cache.cacheRead)} of ${fmt(cache.billedPrompt)} billed prompt tokens served from cache (${cache.requests} req)`,
      );
    }
  }

  lines.push("");

  if (nudge) {
    if (nudge.shouldInject) {
      const tierInfo = nudge.tier ? ` [T${nudge.tier} distillation]` : "";
      lines.push(`Nudge: ACTIVE${tierInfo} — ${nudge.reason}`);
    } else {
      lines.push(`Nudge: idle — ${nudge.reason}`);
    }
  }

  const ranges = viableRanges(nudge?.compressibleRanges ?? []);
  const protectedRanges = nudge?.protectedRanges ?? [];
  if (ranges.length > 0 || protectedRanges.length > 0) {
    lines.push("");
    lines.push(formatRanges(ranges, protectedRanges));
  }

  if (activeBlocksList.length > 0) {
    lines.push("");
    lines.push(
      `Blocks: ${activeBlocksList.length} active / ${totalBlocksList.length} total (${fmt(state.stats.tokensCompressed)} tokens compressed, cumulative)`,
    );
    for (const b of activeBlocksList) {
      const topic = b.topic
        ? `: ${b.topic}`
        : `: ${topicFallback(b.summary || "")}`;
      const summaryTok = defaultCountTokens(b.summary || "");
      const origTok = b.compressedTokens > 0 ? b.compressedTokens : summaryTok;
      const ext = externalBlockIds?.has(b.blockId) ? " ⚡ext" : "";
      lines.push(
        `  [${b.blockId}] T${b.tier} ${fmt(origTok)}→${fmt(summaryTok)}${ext}${topic}`,
      );
    }
  } else if (totalBlocksList.length > 0) {
    lines.push("");
    lines.push(
      `Blocks: 0 active / ${totalBlocksList.length} total (${fmt(state.stats.tokensCompressed)} tokens compressed, cumulative)`,
    );
  } else {
    lines.push("");
    lines.push("Blocks: none (nothing compressed yet)");
  }

  lines.push("");
  lines.push(
    "Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.",
  );

  return lines.join("\n");
}
