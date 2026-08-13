import type { Config } from "acp-kernel";
import { findRoute, type CompressSettings, type ProviderRoutes } from "./config.js";

/** Resolve a raw `contextLimit` value to an absolute token count.
 *  - `number` → used as-is (absolute window).
 *  - `string` ending in `%` (e.g. `"70%"`) → that fraction of `nativeLimit`.
 *  - any other `string` → parsed as a number (absolute window).
 *  - `undefined` → `nativeLimit` (the model's full window).
 *
 *  `contextLimit` is the **window size** the kernel uses as the denominator for
 *  its usage ratio (`usage = tokens / contextLimit`) — it is NOT a truncation
 *  cap. All ratio-based thresholds (`emergencyThreshold`, truncate) scale off
 *  it, so shrinking it pulls every threshold down proportionally. To leave
 *  headroom, raise/lower `emergencyThreshold` instead. Always returns int ≥ 1. */
export function resolveContextLimitValue(raw: number | string | undefined, nativeLimit: number): number {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.max(1, Math.floor(raw));
    if (typeof raw === "string") {
        const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(raw.trim());
        if (pct) return Math.max(1, Math.floor((nativeLimit * Number(pct[1])) / 100));
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return Math.max(1, Math.floor(nativeLimit));
}

/** Per-field deepest-wins merge of the three compression config levels. An
 *  `undefined` field at a deeper level does NOT clear a value set at a shallower
 *  level — only a defined value overrides. This is what "child covers parent"
 *  means: the merge is per-field, never a whole-object replace. */
export function mergeCompress(
    global?: CompressSettings,
    provider?: CompressSettings,
    model?: CompressSettings,
): CompressSettings {
    const pick = <K extends keyof CompressSettings>(k: K): CompressSettings[K] =>
        model?.[k] ?? provider?.[k] ?? global?.[k];
    return {
        modelContextLimit: pick("modelContextLimit"),
        maxContextLimit: pick("maxContextLimit"),
        emergencyThresholdPercent: pick("emergencyThresholdPercent"),
        nudgeGrowthTokens: pick("nudgeGrowthTokens"),
        preserveRecentMessages: pick("preserveRecentMessages"),
        preserveRecentTokens: pick("preserveRecentTokens"),
        minCompressRange: pick("minCompressRange"),
        tiers: pick("tiers"),
    };
}

/** Resolve the merged compression settings for one request: global → provider
 *  (matched by longest-URL-prefix, identical to the context-limit lookup) →
 *  model. Returns a CompressSettings where every field is `undefined` when
 *  nothing is configured at any of the three levels. */
export function resolveCompress(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
    global?: CompressSettings,
): CompressSettings {
    const route = findRoute(routes, upstreamUrl);
    return mergeCompress(global, route?.compress, model ? route?.models?.[model]?.compress : undefined);
}

/** True when a CompressSettings carries at least one configured field (i.e. it
 *  actually overrides something at some level). */
export function hasCompressSettings(s: CompressSettings): boolean {
    return Object.values(s).some((v) => v !== undefined);
}

/** Apply merged compression settings onto a base kernel Config, returning a NEW
 *  Config (the input is not mutated). `limit` is always written to
 *  `modelContextLimit` (the caller resolves the final limit, including the
 *  compress.modelContextLimit override). Unset fields inherit the base value
 *  untouched. Field mapping:
 *  - `maxContextLimit` → `nudge.maxContextLimitPct` (force-nudge trigger).
 *  - `emergencyThresholdPercent` → `nudge.emergencyThresholdPct` +
 *    `truncate.threshold` (emergency + hard-truncate).
 *  - `nudgeGrowthTokens` → flattens the adaptive band to a fixed step
 *    (sets both `nudge.growthFloor` and `nudge.growthCap`).
 *  - `preserveRecentMessages` / `preserveRecentTokens` → top-level Config.
 *  - `minCompressRange` → `compress.minCompressRange`.
 *  - `tiers` → `tiers.enabled`. */
export function applyCompressSettings(base: Config, limit: number, s: CompressSettings): Config {
    const nudge = { ...base.nudge };
    const truncate = { ...base.truncate };
    if (s.maxContextLimit !== undefined) nudge.maxContextLimitPct = parsePercent(s.maxContextLimit);
    if (s.emergencyThresholdPercent !== undefined) {
        const pct = parsePercent(s.emergencyThresholdPercent);
        nudge.emergencyThresholdPct = pct;
        truncate.threshold = pct;
    }
    if (s.nudgeGrowthTokens !== undefined && s.nudgeGrowthTokens > 0) {
        nudge.growthFloor = s.nudgeGrowthTokens;
        nudge.growthCap = s.nudgeGrowthTokens;
    }
    const tiers = { ...base.tiers };
    if (s.tiers !== undefined) tiers.enabled = s.tiers;
    return {
        ...base,
        modelContextLimit: limit,
        nudge,
        truncate,
        tiers,
        preserveRecentMessages: s.preserveRecentMessages ?? base.preserveRecentMessages,
        preserveRecentTokens: s.preserveRecentTokens ?? base.preserveRecentTokens,
        compress: {
            ...base.compress,
            minCompressRange: s.minCompressRange ?? base.compress.minCompressRange,
        },
    };
}

function parsePercent(v: number | string): number {
    if (typeof v === "number") return v;
    const s = v.trim();
    if (s.endsWith("%")) return Number(s.slice(0, -1)) / 100;
    return Number(s);
}
