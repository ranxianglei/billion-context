import { DEFAULT_ABSORB_CONFIG, DEFAULT_CCR_CONFIG, DEFAULT_IMAGE_COMPRESSION_CONFIG, defaultPrompts, resolvePrompts, createPackResolver, defaultPackSources, isValidPackName, type AbsorbConfig, type Config, type CcrConfig, type ImageCompressionConfig, type PackSurface, type Prompts } from "acp-kernel";
import * as path from "node:path";
import { findRoute, type CompressSettings, type ProviderRoutes } from "./config.js";
import { configDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";

/** Host-side policy default for `compress.stripImagesKeepRecent` (#617): how
 *  many of the most recent messages keep their image payloads when stripping
 *  is enabled. The strip mechanism itself lives in acp-kernel's wire layer
 *  (kernel #215) — only the opt-in policy stays host-side. */
export const DEFAULT_STRIP_IMAGES_KEEP_RECENT = 5;

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
    // `absorb` is a second nested-object field, merged sub-field-wise exactly
    // like `prompts`: a model-level minToolTokens must not discard a
    // provider-level excludeTools.
    const absorbLevels = [global?.absorb, provider?.absorb, model?.absorb].filter(Boolean) as NonNullable<CompressSettings["absorb"]>[];
    const ccrLevels = [global?.ccr, provider?.ccr, model?.ccr].filter(Boolean) as NonNullable<CompressSettings["ccr"]>[];
    const imageCompressionLevels = [global?.imageCompression, provider?.imageCompression, model?.imageCompression].filter(Boolean) as NonNullable<CompressSettings["imageCompression"]>[];
    const reasoningLevels = [global?.reasoning, provider?.reasoning, model?.reasoning].filter(Boolean) as NonNullable<CompressSettings["reasoning"]>[];
    const reasoningGuardLevels = [global?.reasoningGuard, provider?.reasoningGuard, model?.reasoningGuard].filter(Boolean) as NonNullable<CompressSettings["reasoningGuard"]>[];
    const outputSteeringLevels = [global?.outputSteering, provider?.outputSteering, model?.outputSteering].filter(Boolean) as NonNullable<CompressSettings["outputSteering"]>[];
    return {
        modelContextLimit: pick("modelContextLimit"),
        outputHeadroomMaxPct: pick("outputHeadroomMaxPct"),
        maxContextLimit: pick("maxContextLimit"),
        emergencyThresholdPercent: pick("emergencyThresholdPercent"),
        nudgeGrowthTokens: pick("nudgeGrowthTokens"),
        preserveRecentMessages: pick("preserveRecentMessages"),
        preserveRecentTokens: pick("preserveRecentTokens"),
        minCompressRangeChars: rangeOf(model) ?? rangeOf(provider) ?? rangeOf(global),
        tiers: pick("tiers"),
        protectedLatestTools: pick("protectedLatestTools"),
        protectedTools: pick("protectedTools"),
        neverPreserveRecentTools: pick("neverPreserveRecentTools"),
        preserveRecentTools: pick("preserveRecentTools"),
        prompts: promptLevels.length > 0 ? Object.assign({}, ...promptLevels) : undefined,
        acknowledgePromptsRisk: pick("acknowledgePromptsRisk"),
        absorb: absorbLevels.length > 0 ? Object.assign({}, ...absorbLevels) : undefined,
        ccr: ccrLevels.length > 0 ? Object.assign({}, ...ccrLevels) : undefined,
        imageCompression: imageCompressionLevels.length > 0 ? Object.assign({}, ...imageCompressionLevels) : undefined,
        rules: pick("rules"),

stripImages: pick("stripImages"),
        stripImagesKeepRecent: pick("stripImagesKeepRecent"),
        visibilityMarkers: pick("visibilityMarkers"),
        // `reasoning` is a third nested-object field merged sub-field-wise
        // exactly like `absorb`/`prompts`: a model-level `threshold` must not
        // discard a provider-level `drop: false`.
        reasoning: reasoningLevels.length > 0 ? Object.assign({}, ...reasoningLevels) : undefined,
        reasoningGuard: reasoningGuardLevels.length > 0 ? Object.assign({}, ...reasoningGuardLevels) : undefined,
        outputSteering: outputSteeringLevels.length > 0 ? Object.assign({}, ...outputSteeringLevels) : undefined,
        promptPack: pick("promptPack"),
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
 *  overrides only take effect when `acknowledgePromptsRisk` resolves to `true`
 *  in the merged settings — the flag merges independently (deepest defined
 *  level wins) and gates all prompt pieces regardless of their own level (the
 *  kernel rules are load-bearing; see Prompts docs). When
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

let warnedUnknownPack = new Set<string>();

export interface SurfaceResolution {
    surface: PackSurface;
    /** Effective pack name — "default" when unset/invalid/unresolvable
     *  (the surface that actually serves requests). Feeds status-report
     *  surface meta and the session audit stamp. */
    packName: string;
    /** Pack-declared version, when the resolved pack carries one. */
    packVersion?: string;
}

/** Resolve the pack surface for one request: `promptPack` names a pack in the
 *  kernel's resolver chain [project `./.billion-context/packs` > user
 *  `<configDir>/packs` > builtin registry]. Unknown names fall back to the
 *  identity surface ({} — kernel defaults everywhere) with a one-time-per-name
 *  warning, so a typo never degrades the compression prompts. Directory
 *  layout is host policy; resolution/sanitization is the kernel's. */
export function resolveCompressSurfaceDetailed(
    s: CompressSettings,
    dirs?: { projectDir?: string; userDirs?: readonly string[] },
): SurfaceResolution {
    const name = s.promptPack;
    if (typeof name !== "string" || name === "default" || !isValidPackName(name)) return { surface: {}, packName: "default" };
    const resolver = createPackResolver(
        defaultPackSources({
            projectDir: dirs?.projectDir ?? path.join(process.cwd(), ".billion-context", "packs"),
            userDirs: dirs?.userDirs ?? [path.join(configDir(), "packs")],
        }),
    );
    const pack = resolver.resolve(name);
    if (!pack) {
        if (!warnedUnknownPack.has(name)) {
            warnedUnknownPack.add(name);
            loggerLog("warn", `[compress] promptPack "${name}" not found (project/user/builtin); using default surface`);
        }
        return { surface: {}, packName: "default" };
    }
    return { surface: pack.surface, packName: name, packVersion: pack.version };
}

export function resolveCompressSurface(
    s: CompressSettings,
    dirs?: { projectDir?: string; userDirs?: readonly string[] },
): PackSurface {
    return resolveCompressSurfaceDetailed(s, dirs).surface;
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
  *  - `tiers` → `tiers.enabled`.
  *  - `protectedLatestTools` → top-level Config (kernel hard-excludes the
  *    latest instance + paired result of matching tools from every compress
  *    range). Whole-array replace, deepest level wins.
  *  - `protectedTools` → top-level Config (kernel hard-excludes EVERY instance
  *    + paired result of matching tools from every compress range — full-
  *    history protection; see the #639/#1109 trade-off in config.ts).
  *    Whole-array replace, deepest level wins.
  *  - `neverPreserveRecentTools` → top-level Config (kernel recent-zone
  *    exclusion list, acp-kernel >= 0.0.92). Whole-array replace, deepest
  *    level wins; UNSET passes `base.neverPreserveRecentTools` through so the
  *    kernel built-in default list (`decompress/search_context/read/bash`)
  *    keeps governing, while an explicit array (including `[]` = exclude
  *    nothing) replaces it verbatim (#1277: the #1198 read-loop escape
  *    hatch).
  *  - `preserveRecentTools` → top-level Config (kernel positive override,
  *    acp-kernel >= 0.0.93): patterns REMOVED from the effective exclusion
  *    list computed by the kernel — `[
  *    "read"]` is the one-entry #1198/#1277 remedy, no built-in list
  *    restating/freezing. Whole-array replace, deepest level wins; unset
  *    passes `base.preserveRecentTools` through.
  *  - `absorb` → `absorb` (kernel AbsorbConfig; unset fields inherit the
  *    kernel DEFAULT_ABSORB_CONFIG, so a partial user block still resolves
  *    fully). Absent `s.absorb` leaves `base.absorb` untouched — the feature
  *    stays off unless some level enables it.
  *  - `rules` → `rules = { enabled }` (kernel RuleFeatureConfig; limits stay
  *    at kernel defaults). Absent `s.rules` leaves `base.rules` untouched.
  *  - `ccr` → `ccr` (kernel CcrConfig, acp-kernel >= 0.0.84; the kernel runs
  *    the ccr-store node inside processTurn between prune and absorb).
  *    Unset fields inherit DEFAULT_CCR_CONFIG. CCR is opt-in on every lane
  *    (#1207 owner decision): absent `s.ccr` leaves `base.ccr` untouched —
  *    the feature stays off until some level sets `enabled: true` and it has
  *    been verified locally. Host arming (server.ts) further gates it behind
  *    the retrieve tool channel, so plugin mode / no-channel wires stay
  *    inert regardless.
   *  - `imageCompression` → `imageCompression` (kernel ImageCompressionConfig,
   *    acp-kernel >= 0.0.84; #1095 pre-compression of image blocks). Unset
   *    fields inherit DEFAULT_IMAGE_COMPRESSION_CONFIG. Absent
   *    `s.imageCompression` leaves `base.imageCompression` untouched — the
   *    feature stays off unless some level enables it. */
// Config as resolved for the kernel, plus preserveRecentTools — the knob
// lands in acp-kernel 0.0.93 (acp-kernel#428) but the resolved object is
// built and typed here regardless of the installed kernel's Config so both
// release windows compile identically. Older kernels ignore the extra key
// (validateConfig does not flag unknown keys).
export type ResolvedKernelConfig = Config & { preserveRecentTools?: string[] };

// Single source of truth for raw->resolved absorb: applyCompressSettings and the
// plugin-lane base stamp (#1359) both go through this or they drift apart.
export function resolveAbsorbSettings(s: CompressSettings["absorb"]): AbsorbConfig | undefined {
    if (s === undefined) return undefined;
    const d = DEFAULT_ABSORB_CONFIG;
    return {
        enabled: s.enabled === true,
        toolName: s.toolName ?? d.toolName,
        minToolTokens: s.minToolTokens ?? d.minToolTokens,
        contextThresholdPct: s.contextThresholdPct !== undefined ? parsePercent(s.contextThresholdPct) : d.contextThresholdPct,
        excludeTools: s.excludeTools ?? [...d.excludeTools],
    };
}

export function applyCompressSettings(base: Config, limit: number, s: CompressSettings): ResolvedKernelConfig {
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
    const absorb = resolveAbsorbSettings(s.absorb);
    // #1207 owner decision: CCR is opt-in on every lane — no default-on
    // else-branch; an unset `s.ccr` leaves `base.ccr` untouched (off).
    let ccr: CcrConfig | undefined;
    if (s.ccr !== undefined) {
        const d = DEFAULT_CCR_CONFIG;
        ccr = {
            enabled: s.ccr.enabled === true,
            toolName: s.ccr.toolName ?? d.toolName,
            minToolTokens: s.ccr.minToolTokens ?? d.minToolTokens,
            excludeTools: s.ccr.excludeTools ?? [...d.excludeTools],
            maxHeadChars: s.ccr.maxHeadChars ?? d.maxHeadChars,
        };
    }
    let imageCompression: ImageCompressionConfig | undefined;
    if (s.imageCompression !== undefined) {
        const d = DEFAULT_IMAGE_COMPRESSION_CONFIG;
        imageCompression = {
            enabled: s.imageCompression.enabled === true,
            minTokens: s.imageCompression.minTokens ?? d.minTokens,
            maxDimension: s.imageCompression.maxDimension ?? d.maxDimension,
            quality: s.imageCompression.quality ?? d.quality,
            format: s.imageCompression.format ?? d.format,
        };
    }
    const resolved: ResolvedKernelConfig = {
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
        protectedLatestTools: s.protectedLatestTools ?? base.protectedLatestTools,
        protectedTools: s.protectedTools ?? base.protectedTools,
        neverPreserveRecentTools: s.neverPreserveRecentTools ?? base.neverPreserveRecentTools,
        // base is Config (0.0.92 lacks the field) — the cast keeps both kernel windows compiling.
        preserveRecentTools: s.preserveRecentTools ?? (base as ResolvedKernelConfig).preserveRecentTools,
        ...(absorb !== undefined ? { absorb } : {}),
        ...(ccr !== undefined ? { ccr } : {}),
        ...(imageCompression !== undefined ? { imageCompression } : {}),
        ...(s.rules !== undefined ? { rules: { enabled: s.rules === true } } : {}),
    };
    return resolved;
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
 *  and the limit is unchanged — CCR is opt-in, so an unset `ccr` never forces
 *  a fresh config). This is the exact function the proxy calls for every
 *  request, extracted so the three-level cascade is testable end-to-end
 *  without spinning up the HTTP server. */
export function resolveRequestConfig(
    base: Config,
    routes: ProviderRoutes,
    embeddedUrl: string | undefined,
    model: string,
    native: number | undefined,
    globalCompress?: CompressSettings,
): ResolvedKernelConfig {
    const compress = resolveCompress(routes, embeddedUrl, model, globalCompress);
    const limit = resolveContextLimitValue(compress.modelContextLimit, native ?? base.modelContextLimit);
    if (!hasCompressSettings(compress) && limit === base.modelContextLimit) return base;
    return applyCompressSettings(base, limit, compress);
}
