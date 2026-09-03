import { defaultPrompts, resolvePrompts, type Config, type Prompts } from "acp-kernel";
import { findRoute, type CompressSettings, type ProviderRoutes } from "./config.js";
import { log as loggerLog } from "./logger.js";

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
    // `prompts` is the one nested-object field: merge SUB-field-wise across
    // levels (global → provider → model) instead of whole-object replace, so a
    // model-level override of howToCompressRules does not discard a
    // provider-level compressPhilosophy. The kernel's resolvePrompts then
    // fills any still-missing sub-fields from defaultPrompts.
    const promptLevels = [global?.prompts, provider?.prompts, model?.prompts].filter(Boolean) as Partial<Prompts>[];
    // minCompressRangeChars is the canonical name; minCompressRange is a
    // deprecated alias. Resolve the alias per LEVEL first (same level: new
    // name wins), then deepest defined level wins — so a model-level old-name
    // value still beats a global-level new-name value. The merged output
    // always carries the canonical name only.
    const rangeOf = (s?: CompressSettings): number | undefined => s?.minCompressRangeChars ?? s?.minCompressRange;
    return {
        modelContextLimit: pick("modelContextLimit"),
        maxContextLimit: pick("maxContextLimit"),
        emergencyThresholdPercent: pick("emergencyThresholdPercent"),
        nudgeGrowthTokens: pick("nudgeGrowthTokens"),
        preserveRecentMessages: pick("preserveRecentMessages"),
        preserveRecentTokens: pick("preserveRecentTokens"),
        minCompressRangeChars: rangeOf(model) ?? rangeOf(provider) ?? rangeOf(global),
        tiers: pick("tiers"),
        prompts: promptLevels.length > 0 ? Object.assign({}, ...promptLevels) : undefined,
        acknowledgePromptsRisk: pick("acknowledgePromptsRisk"),
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

let warnedPromptsRisk = false;

/** Resolve the effective compression prompts from merged settings. `prompts`
 *  overrides only take effect with `acknowledgePromptsRisk: true` at the
 *  winning level (the kernel rules are load-bearing; see Prompts docs). When
 *  ignored, a one-time warning is logged so the misconfiguration is visible.
 *  Non-string fields inside `prompts` are silently dropped by the kernel's
 *  resolvePrompts (a malformed partial never clobbers a good default). */
export function resolveCompressPrompts(s: CompressSettings): Prompts {
    if (!s.prompts) return defaultPrompts;
    if (s.acknowledgePromptsRisk !== true) {
        if (!warnedPromptsRisk) {
            warnedPromptsRisk = true;
            loggerLog("warn", "[compress] prompts override IGNORED: acknowledgePromptsRisk !== true. Set it to true to acknowledge the summary-quality risk.");
        }
        return defaultPrompts;
    }
    try {
        return resolvePrompts(s.prompts, { acknowledgeRisk: true });
    } catch {
        return defaultPrompts;
    }
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
 *  - `minCompressRangeChars` (deprecated alias: `minCompressRange`) →
 *    `compress.minCompressRange`. The unit is characters.
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
            minCompressRange: s.minCompressRangeChars ?? s.minCompressRange ?? base.compress.minCompressRange,
        },
    };
}

function parsePercent(v: number | string): number {
    if (typeof v === "number") return v;
    const s = v.trim();
    if (s.endsWith("%")) return Number(s.slice(0, -1)) / 100;
    return Number(s);
}

/** Resolve the per-request kernel Config for one proxied request: the pure
 *  (non-async) half of the server.ts:485-502 pipeline. Given the route graph,
 *  the matched upstream URL, the request model, and the already-resolved native
 *  context window (the caller handles the async registry lookup), this merges
 *  global → provider → model compress settings and applies them onto `base`,
 *  returning the tuned Config (or `base` unchanged when nothing is configured
 *  and the limit is unchanged). This is the exact function the proxy calls for
 *  every request, extracted so the three-level cascade is testable end-to-end
 *  without spinning up the HTTP server. */
export function resolveRequestConfig(
    base: Config,
    routes: ProviderRoutes,
    embeddedUrl: string | undefined,
    model: string,
    native: number | undefined,
    globalCompress?: CompressSettings,
): Config {
    const compress = resolveCompress(routes, embeddedUrl, model, globalCompress);
    const limit = resolveContextLimitValue(compress.modelContextLimit, native ?? base.modelContextLimit);
    if (!hasCompressSettings(compress) && limit === base.modelContextLimit) return base;
    return applyCompressSettings(base, limit, compress);
}
