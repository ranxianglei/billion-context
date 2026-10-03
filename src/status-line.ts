// #1920: per-client compression status dashboards. The proxy renders the
// canonical one-line stats here and ships them on /__bili/plugin/status as
// statusLine.{min,med}; client adapters (pi/omp footer via ctx.ui.setStatus,
// claude statusLine via `bili statusline`) only ever PRINT what this module
// rendered — one renderer, zero per-client formatting drift. Full detail
// stays in the /acp panel (buildStatusPanel); these lines pick the few
// numbers that fit a status bar, by surface size (min ≈ 60 chars).

import type { Session } from "./session.js";

export interface StatusLineStats {
    /** Context the next request will carry (stats.lastInputTokens). */
    contextTokens: number;
    /** Effective window limit; null when unresolved. */
    contextLimit: number | null;
    /** Rounded percent of the window used; null with no limit. */
    contextPct: number | null;
    /** Ledger net Σ((S−σ)×ra − T − σ) when any fold exists, else the local
     *  pre-ledger estimate (stats.tokensSaved). May be negative. */
    savedTokens: number;
    /** true = ledger net; false = local estimate (rendered with a ~ mark). */
    savedIsNet: boolean;
    blocksActive: number;
    blocksTotal: number;
    /** Dual-source MAX cached/input hit rate (read-only, same pattern as the
     *  web sessions table); null when no input yet. */
    cacheHitPct: number | null;
    /** Dual-source MAX request count. */
    requests: number;
    /** Growth tokens since the nudge reference; null when no nudge decision. */
    nudgeGrowth: number | null;
    /** Flat nudge step (kernel contract: growthFloor == growthCap == 50K). */
    nudgeStep: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const stripZeros = (s: string): string => s.replace(/\.?0+$/, "");

/** Canonical compact token rendering shared by every client surface:
 *  999 → "999", 96_000 → "96k", 869_000 → "869k", 1_700_000 → "1.7M". */
export function compactTokens(n: number): string {
    const v = Math.round(n);
    const sign = v < 0 ? "-" : "";
    const a = Math.abs(v);
    if (a < 1000) return `${sign}${a}`;
    if (a < 1_000_000) return `${sign}${stripZeros((a / 1000).toFixed(1))}k`;
    return `${sign}${stripZeros((a / 1_000_000).toFixed(2))}M`;
}

/** Structural slice of the kernel NudgeDecision the line needs — keeps this
 *  module free of an acp-kernel type import. */
type NudgeLike = { breakdown?: { growth?: unknown; nudgeGrowthTokens?: unknown } } | null | undefined;

/** Read-only stats for the status line. Mirrors the dual-source MAX pattern
 *  of src/web/sessions-data.ts summaryOf (stats vs metadata.cacheLedger.agg
 *  overlap, never sum) WITHOUT calling getCacheLedger — that bootstraps and
 *  mutates session.metadata, which a read path must not do. */
export function buildStatusLineStats(session: Session, nudge?: NudgeLike): StatusLineStats {
    const s = session.stats;
    const led = session.metadata?.["cacheLedger"] as {
        agg?: { requests?: unknown; input?: unknown; cached?: unknown };
        folds?: Array<{ S?: unknown; sigma?: unknown; T?: unknown; requestsAfter?: unknown }>;
    } | undefined;
    const agg = led?.agg;
    const requests = Math.max(num(s.requests) ?? 0, num(agg?.requests) ?? 0);
    const inputTokens = Math.max(num(s.inputTokens) ?? 0, num(agg?.input) ?? 0);
    const cachedTokens = Math.max(num(s.cachedTokens) ?? 0, num(agg?.cached) ?? 0);
    let savedIsNet = false;
    let netSaved = 0;
    for (const f of led?.folds ?? []) {
        savedIsNet = true;
        const S = num(f.S) ?? 0;
        const sigma = num(f.sigma) ?? 0;
        const repay = num(f.T) ?? 0;
        const ra = num(f.requestsAfter) ?? 0;
        netSaved += (S - sigma) * ra - repay - sigma;
    }
    const limit = num(session.metadata?.["effectiveContextLimit"]);
    const contextTokens = num(s.lastInputTokens) ?? 0;
    const blocks = session.state.blocks ?? [];
    return {
        contextTokens,
        contextLimit: limit !== null && limit > 0 ? limit : null,
        contextPct: limit !== null && limit > 0 && contextTokens > 0 ? Math.round((contextTokens / limit) * 100) : null,
        savedTokens: savedIsNet ? netSaved : (num(s.tokensSaved) ?? 0),
        savedIsNet,
        blocksActive: blocks.filter((b) => b.active === true).length,
        blocksTotal: blocks.length,
        cacheHitPct: inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 100) : null,
        requests,
        nudgeGrowth: num(nudge?.breakdown?.growth),
        nudgeStep: num(nudge?.breakdown?.nudgeGrowthTokens),
    };
}

/** Render the one-line dashboard. min fits a narrow bottom bar (≈60 chars);
 *  med adds request count, the active/total block split and nudge progress
 *  toward the next growth step. Segments drop out individually when their
 *  data does not exist yet — the line never renders placeholders. */
export function renderStatusLine(s: StatusLineStats, tier: "min" | "med"): string {
    // "bili" is the label, not a data segment — no separator after it.
    const parts: string[] = [];
    if (s.contextPct !== null && s.contextLimit !== null) {
        parts.push(`${s.contextPct}% ${compactTokens(s.contextTokens)}/${compactTokens(s.contextLimit)}`);
    } else if (s.contextTokens > 0) {
        parts.push(compactTokens(s.contextTokens));
    }
    if (s.savedIsNet || s.savedTokens > 0) {
        parts.push(`saved ${compactTokens(s.savedTokens)}${s.savedIsNet ? "" : "~"}`);
    }
    if (s.blocksTotal > 0) {
        parts.push(tier === "min" ? `${s.blocksActive}blk` : `${s.blocksActive}/${s.blocksTotal}blk`);
    }
    if (s.cacheHitPct !== null) parts.push(`cache ${s.cacheHitPct}%`);
    if (tier === "med") {
        if (s.requests > 0) parts.push(`${s.requests}req`);
        if (s.nudgeGrowth !== null && s.nudgeStep !== null) parts.push(`nudge ${compactTokens(s.nudgeGrowth)}/${compactTokens(s.nudgeStep)}`);
    }
    return parts.length > 0 ? `bili ${parts.join(" · ")}` : "bili";
}
