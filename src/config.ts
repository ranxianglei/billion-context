import { defaultConfig, type Config, type Prompts } from "acp-kernel";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configFile } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { validateHttpProxy, type ProxyFallbackOptions } from "./upstream-proxy.js";
import { resolveOutputHeadroomCap } from "./util.js";

import { parseCompatRoles } from "./compat-roles.js";
import type { ImageBillingMode } from "./image-tokens.js";
import type { ReasoningGuardConfig } from "./reasoning-guard.js";

export function safeReadJson(path: string): unknown {
    try {
        // Strip a leading UTF-8 BOM: Windows Notepad saves UTF-8 "with BOM",
        // and JSON.parse("\uFEFF...") throws SyntaxError, silently dropping
        // the whole config file.
        const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
        return JSON.parse(raw);
    } catch (e) {
        // Surface config parse failures instead of silently swallowing them;
        // a malformed providers file would otherwise run the proxy with
        // defaults and the user would not know why routing is wrong.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            loggerLog("error", `[acp-config] failed to parse ${path}: ${String(e)}`);
        }
        return undefined;
    }
}

/** Each upstream URL may declare per-model context/output limits, mirroring the
 *  structure agents like opencode carry in their own model registry. This is
 *  the source of truth for the proxy: the LLM `/models` endpoint does NOT
 *  return context windows (verified across OpenAI/Anthropic/zhipu/comfly),
 *  so the proxy cannot discover them at runtime — the user must declare them.
 */
export type ProviderRoute = {
    models?: Record<string, ModelEntry>;
    /** Per-URL upstream HTTP proxy. Overrides the global `proxy`. Empty string
     *  means "explicitly direct" (override global with no proxy). Format:
     *  `http://host:port`. SOCKS5 is not supported yet. */
    proxy?: string;
    /** Per-URL Responses compress protocol. "marker" = text-trigger protocol
     *  (for upstreams that cannot coexist with a declared tools field).
     *  Default / "tools" = native function tools. */
    compressProtocol?: "tools" | "marker";
    /** Per-provider compression overrides (level 2 of 3). See CompressSettings. */
    compress?: CompressSettings;
    /** Per-provider wire-compat overrides. `roles` maps message roles to the
     *  role name this upstream accepts (e.g. `"developer": "system"`) —
     *  applied at the forward boundary to the FINAL wire body, covering
     *  client-sent roles and bili's own injected prompt alike (#552). Wins
     *  per key over the global `compat` block. */
    compat?: { roles?: Record<string, string> };
    /** Route-scoped passthrough (#661): same semantics as the global
     *  `passthrough` flag, but only for requests whose upstream URL matches
     *  this route — request body forwarded byte-for-byte (no kernel
     *  round-trip, no render tags, no re-serialization), response piped
     *  verbatim, no session state. For upstreams whose anti-cheat fingerprints
     *  the request body (e.g. ZCode 405/3012). */
    passthrough?: boolean;
    /** Per-provider image billing mode (#767): "bytes" = ceil(base64/4)
     *  (conservative, matches byte-counting relays); "pixels" = dimension-
     *  based tile estimate (matches first-party pixel-tile upstreams);
     *  "auto" (default) classifies known first-party pixel hosts. Wins over
     *  the global `imageBilling`; env BILI_IMAGE_BILLING wins over both. */
    imageBilling?: ImageBillingMode;
};
export type ProviderRoutes = Record<string, ProviderRoute>; // key = upstream URL prefix (the /bili/<this> string)

/** Per-model declaration under a provider route. `context` / `output` are the
 *  legacy fields; `compress` is the level-3 override (deepest, highest priority). */
export type ModelEntry = {
    context?: number;
    output?: number;
    /** Per-model compression overrides (level 3 of 3, wins over provider
     *  and global). See CompressSettings. */
    compress?: CompressSettings;
};

/** User-facing compression tuning. Configurable at three levels — global
 *  (config root `compress`), per-provider (`providers[url].compress`), per-model
 *  (`providers[url].models[model].compress`) — merged deepest-field-wins by
 *  {@link mergeCompress} (child covers parent, per field, not whole-object). Every
 *  field is optional; unset fields fall through to the kernel default. */
export type CompressSettings = {
    /** Effective context window used by the compression engine — this is the
     *  model's context size. It is the **denominator** the kernel uses for its
     *  usage ratio (`usage = tokens / modelContextLimit`); it is NOT a
     *  truncation cap. Accepts two forms:
     *  - **absolute** (`number`): exact token budget, e.g. `200000`.
     *  - **percentage** (`string` like `"70%"`): a fraction of the model's
     *    native window (from the built-in table / models.dev registry).
     *  When unset at every level, the default is the model's **native window**.
     *  Highest-priority source for the model limit; overrides the built-in
     *  table / registry and the legacy `modelContextLimit` / per-model
     *  `context`. See {@link resolveContextLimitValue}. */
    modelContextLimit?: number | string;
    /** Cap on the output-headroom reservation as a fraction of the context
     *  window: reserved = min(max_tokens, pct × window), so the kernel's
     *  nudge/truncate bands sit below (window − reserved). Accepts a ratio
     *  (0.25) or percent string ("25%"). Default: 0.25 (aligned with
     *  billion-context-pi #207). Set 0 to disable the reservation entirely;
     *  >= 1 restores the legacy full-capability reservation (input + a response
     *  using its ENTIRE output budget always fits — what strict backends like
     *  SGLang/vLLM enforce). A reply longer than the reservation overflows
     *  once; the overflow self-heal recovers it next turn (#896). Negative or
     *  unparseable values reject the whole compress block. Anthropic wire is
     *  exempt (its input limit is enforced independently of max_tokens). */
    outputHeadroomMaxPct?: number | string;
    /** Context usage percentage that triggers forced compression nudges
     *  (bypasses growth-gate + cadence). Accepts a ratio (0.75) or percent
     *  string ("75%"). Maps to kernel `nudge.maxContextLimitPct`. */
    maxContextLimit?: number | string;
    /** Context usage percentage that triggers emergency truncation of large
     *  tool outputs. Accepts a ratio (0.95) or percent string ("95%"). Must
     *  be >= maxContextLimit. Maps to kernel `nudge.emergencyThresholdPct` +
     *  `truncate.threshold`. */
    emergencyThresholdPercent?: number | string;
    /** Nudge growth magnitude in tokens — a compression nudge fires roughly
     *  every time this many tokens become compressible. Flattens the kernel's
     *  adaptive band to a fixed step (sets both `nudge.growthFloor` and
     *  `nudge.growthCap`). */
    nudgeGrowthTokens?: number;
    /** Trailing messages never offered for compression
     *  (kernel `preserveRecentMessages`). */
    preserveRecentMessages?: number;
    /** Token budget reserved for recent messages (kernel `preserveRecentTokens`). */
    preserveRecentTokens?: number;
    /** Minimum compressible range size, in CHARACTERS (not tokens); smaller
     *  ranges are skipped. English/code averages ~4 chars per token, CJK
     *  ~1-2 chars per token, so the same number is ~4× more permissive for
     *  English text than a token-based reading. Maps to kernel
     *  `compress.minCompressRange` (default 5000 chars). */
    minCompressRangeChars?: number;
    /** Deprecated alias of {@link minCompressRangeChars} kept for backward
     *  compatibility. When both keys are set at the same level the new name
     *  wins; across levels the deeper level wins regardless of which name it
     *  uses. */
    minCompressRange?: number;
    /** Enable multi-tier (T2/T3) distillation (kernel `tiers.enabled`). */
    tiers?: boolean;
    /** Emit 📦/❌ ACP visibility markers after proxy tool executions
     *  (compress / decompress / search_context / acp_status) — both the marker
     *  line streamed to the client and the marker message re-injected into
     *  rebuilt history. `false` suppresses them entirely, for deployments where
     *  models imitate or narrate around the markers (#862). Default `true`. */
    visibilityMarkers?: boolean;
    /** Override the kernel's compression prompt text (compressPhilosophy /
     *  howToCompressRules / tier2DistillRules / tier3CondenseRules). All four
     *  fields are LOAD-BEARING: the kernel rules were tuned in production and
     *  overriding them can degrade summary quality (lost paths / signatures /
     *  decisions → broken retrieval). Ignored unless `acknowledgePromptsRisk`
     *  resolves to `true` after the merge (the flag merges independently,
     *  deepest defined level wins — no co-location with this block required).
     *  Same three-level merge as the other
     *  fields, but the object is merged via kernel `resolvePrompts` (non-string
     *  fields silently dropped), not a raw pass-through. */
    prompts?: Partial<Prompts>;
    /** Must be true for `prompts` overrides to take effect. Acknowledges the
     *  summary-quality risk documented on `prompts`. */
    acknowledgePromptsRisk?: boolean;
    /** Named prompt pack (kernel pack registry): a curated surface preset —
     *  tool descriptions, system-prompt sections, nudge sections — resolved
     *  from [project `./.billion-context/packs` > user `<configDir>/packs` >
     *  builtin (`default`, `lean`)]. Deepest-wins like every other field;
     *  unknown names fall back to the identity surface. Kernel >= 0.0.66. */
    promptPack?: string;
    /** Instant tool-result absorption (kernel absorb API, acp-kernel >= 0.0.54).
     *  When `enabled`, eligible large tool results carry a forced [ACP absorb]
     *  instruction and the model distills them via the injected `absorb` tool;
     *  the original output is then hidden from every wire view until the next
     *  fold round (and its token cost is netted out of usage credits, like
     *  compress). Maps to kernel `Config.absorb`. Off unless explicitly
     *  enabled at some level. NOT supported on Responses marker/text-protocol
     *  routes (no native tool surface there). */
    absorb?: {
        /** Enable absorb for this scope. Absent/false = off (kernel semantics). */
        enabled?: boolean;
        /** Tool results smaller than this many tokens never get the absorb
         *  instruction (kernel default 1000). */
        minToolTokens?: number;
        /** Only emit instructions once context usage reaches this fraction of
         *  the model window (kernel `contextThresholdPct`). Accepts a ratio
         *  (0.5) or percent string ("50%"); 0 = size gate alone (kernel
         *  default). */
        contextThresholdPct?: number | string;
        /** Tool names whose results are never absorbable (glob-suffix
         *  patterns, e.g. "read"). Kernel default: none. */
        excludeTools?: string[];
        /** Rename the wire tool (default "absorb"). Must stay unique against
         *  the client's own tool names or the agent will call its own tool. */
        toolName?: string;
    };

/** Opt-in removal of historical image payloads (src/strip-images.ts). When
     *  true, every message except the most recent {@link stripImagesKeepRecent}
     *  has its image parts dropped before the wire rebuild (image-only content
     *  collapses to an "[image]" placeholder). Off by default — the #488 image
     *  floor / overflow 502 stays the opt-in signal until this is enabled. */
    stripImages?: boolean;
    /** With {@link stripImages}, how many trailing messages keep their images
     *  verbatim (default 5). Ignored unless stripImages is true. */
    stripImagesKeepRecent?: number;
    /** [#651] Drop oversized reasoning (thinking) from closed-turn `compress`
     *  tool calls at request time (src/reasoning-drop.ts, aligned with
     *  billion-context-pi #336/#339 and opencode-acp #377). Compress turns
     *  are hard-exempt from compression, so their reasoning is otherwise an
     *  unreclaimable context floor. Merged sub-field-wise across the three
     *  config levels like `absorb`. */
    reasoning?: {
        /** Master switch (default true). Set `drop: false` per-provider for
         *  models whose reasoning must round-trip unmodified. */
        drop?: boolean;
        /** A closed turn's reasoning run must exceed this many chars to be
         *  dropped (default 2048). */
        threshold?: number;
    };
    /** [#739] Opt-in guard against gpt-5.x/gpt-6.x "lattice" reasoning truncation
     *  (reasoning stops at exactly base*n+offset tokens, default 518n-2 -> 516,
     *  1034, ..., mid-thought). When engaged on a matched-model terminal round that
     *  hits the lattice AND carries an encrypted_content blob, bili buffers the
     *  response, replays its own reasoning plus a continue nudge (up to maxContinue
     *  rounds), and folds to ONE response with true summed usage. Merged sub-field-wise
     *  across the three levels like `absorb`/`reasoning`; off unless enabled at some
     *  level. See src/reasoning-guard.ts. */
    reasoningGuard?: ReasoningGuardConfig;
};
export type PromptCacheRouting = "auto" | "enabled" | "disabled";
export type UpstreamProxyMode = "auto" | "manual" | "direct";

/** Built-in context window for common model families, keyed by a lowercase
 *  prefix. This is a FALLBACK used when the per-route model declaration in
 *  providers.json does not cover a model. The per-route declaration (which
 *  the user controls) always wins, because the same model name can have
 *  different windows behind different relays. Generic family guesses (no
 *  specific known window) default to 200k, not 128k — a too-small guess
 *  strands the session in the preflight fail-fast loop while a too-large
 *  one self-heals on the first upstream overflow (#852). */
const CONTEXT_LIMIT_TABLE: Array<{ match: RegExp; limit: number }> = [
    { match: /^claude-/i, limit: 200_000 },
    { match: /^gpt-5/i, limit: 400_000 },
    { match: /^gpt-4\.1/i, limit: 1_000_000 },
    { match: /^gpt-4o/i, limit: 128_000 },
    { match: /^gpt-4-turbo/i, limit: 128_000 },
    { match: /^o[13]-/i, limit: 200_000 },
    { match: /^gemini-2\.5/i, limit: 1_000_000 },
    { match: /^gemini-1\.5/i, limit: 1_000_000 },
    { match: /^glm-4\.6/i, limit: 128_000 },
    { match: /^glm-5/i, limit: 1_000_000 },
    { match: /^glm-/i, limit: 200_000 },
    // DeepSeek: flagship line (chat/reasoner/v4*/flash) is 1M on models.dev; only legacy r1/v3/ocr stay ~128k (#852).
    { match: /^deepseek-(r1|v3|ocr)/i, limit: 128_000 },
    { match: /^deepseek/i, limit: 1_000_000 },
    { match: /^minimax/i, limit: 204_800 },
    { match: /^qwen/i, limit: 200_000 },
    { match: /^kimi/i, limit: 200_000 },
    { match: /^llama-/i, limit: 200_000 },
];

export function lookupContextLimit(model: string | undefined): number | undefined {
    if (!model) return undefined;
    // Relay/vLLM deployments serve models under "prefix/name" ids that miss
    // every ^-anchored pattern ("meta-llama/Llama-4" vs /^llama-/i). Try the
    // bare basename too; the full name keeps precedence (#736).
    const roots = [model];
    const slash = model.lastIndexOf("/");
    if (slash > 0 && slash < model.length - 1) roots.push(model.slice(slash + 1));
    for (const root of roots) {
        for (const entry of CONTEXT_LIMIT_TABLE) {
            if (entry.match.test(root)) return entry.limit;
        }
    }
    return undefined;
}

/** Floor for the EFFECTIVE context window (after output-headroom reservation)
 *  when the window came from a low-confidence fallback — the built-in table
 *  above or the env default — rather than an authoritative source (plugin
 *  report, launcher declaration, models.dev registry, per-route config). Fallback values are guesses, and the two error
 *  directions are asymmetric: a too-small guess strands the session on a
 *  permanent compression treadmill (issue #282: 128k table value − 64k
 *  max_tokens → 64k effective for a 1M-window model), while a too-large guess
 *  self-heals on the first upstream overflow. */
export const FALLBACK_EFFECTIVE_WINDOW_FLOOR = 100_000;

/** Resolve the context-window limit for a request. Priority:
 *  1. Per-URL per-model declaration in config (user-controlled, most accurate).
 *     The upstreamUrl is matched against config keys by **longest-prefix wins**
 *     (the key is a string the user wrote, identical to what follows /bili/ in
 *     the zero-config baseURL). A shallow key like "https://open.bigmodel.cn"
 *     matches all paths on that host; a deep key like
 *     "https://open.bigmodel.cn/api/anthropic" matches only that endpoint.
 *  2. Built-in CONTEXT_LIMIT_TABLE (by model name prefix)
 *  Returns undefined if neither matches — caller falls back to the env default. */
export function resolveContextLimit(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
): number | undefined {
    return resolveConfiguredContextLimit(routes, upstreamUrl, model) ?? lookupContextLimit(model);
}

/** Longest-URL-prefix match over the providers map. Returns the most specific
 *  ProviderRoute whose key is a prefix of `upstreamUrl`, or undefined. Shared
 *  by context-limit / compress-protocol / compress-settings resolution. */
export function findRoute(routes: ProviderRoutes, upstreamUrl: string | undefined): ProviderRoute | undefined {
    if (!upstreamUrl) return undefined;
    // A key matches if upstreamUrl === key OR upstreamUrl starts with key + "/".
    // The boundary check ("/" or end-of-string) avoids "https://x.com" matching
    // "https://x.com.evil". Longest (most specific) key wins.
    let bestKey = "";
    for (const key of Object.keys(routes)) {
        if (upstreamUrl === key || upstreamUrl.startsWith(key + "/")) {
            if (key.length > bestKey.length) bestKey = key;
        }
    }
    return bestKey ? routes[bestKey] : undefined;
}

export function resolveConfiguredContextLimit(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
): number | undefined {
    if (!model || !upstreamUrl) return undefined;
    const m = findRoute(routes, upstreamUrl)?.models?.[model];
    if (m?.context && m.context > 0) return m.context;
    return undefined;
}

/** #924: the operator-declared max OUTPUT of a model (ModelEntry.output,
 *  documented as the model's max output size) — the mirror of
 *  resolveConfiguredContextLimit for the output-headroom fallback chain. When
 *  the request carries no output budget at all (Codex native Responses sends
 *  no max_output_tokens), this outranks the auto-fetched models.dev ceiling —
 *  same order as the window resolution (#344). */
export function resolveConfiguredOutputLimit(
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
    model: string | undefined,
): number | undefined {
    if (!model || !upstreamUrl) return undefined;
    const m = findRoute(routes, upstreamUrl)?.models?.[model];
    if (m?.output && m.output > 0) return m.output;
    return undefined;
}

export function resolveCompressProtocol(routes: ProviderRoutes, upstreamUrl: string | undefined): "tools" | "marker" | undefined {
    return findRoute(routes, upstreamUrl)?.compressProtocol;
}

export type ProxyOptions = {
    port: number;
    host: string;
    upstream: string;
    routes: ProviderRoutes;
    /** Global default upstream HTTP proxy. Per-URL `proxy` overrides this.
     *  Empty string explicitly disables environment/system proxy fallback. */
    proxy?: string;
    proxyMode?: UpstreamProxyMode;
    proxySource?: "bili-env" | "web-manual" | "config" | "auto" | "direct";
    proxyFallback?: ProxyFallbackOptions;
    /** Auxiliary-egress fallback (#1012): same shape as proxyFallback but its
     *  env tier is filled from the launcher-forwarded BILI_INHERITED_* vars.
     *  Consumed ONLY by the MITM blind-tunnel resolver — client-side aux
     *  traffic (MCP/web) regains the user's shell proxy, while model egress
     *  keeps the clean-env direct semantics (e1c6c92). */
    auxProxyFallback?: ProxyFallbackOptions;
    modelContextLimit: number;
    kernelConfig: Config;
    /** Global-level compression settings (level 1) — the tuning fields from the
     *  user-facing `compress` block, passed through for per-request resolution
     *  (provider = level 2, model = level 3). `injectTool` / `injectNudge` are
     *  the env-resolved booleans (honored globally only). */
    compress: CompressSettings & {
        injectTool: boolean;
        injectNudge: boolean;
    };
    promptCache: { routing: PromptCacheRouting };
    /** Wire-compat role map (global level; per-provider `compat.roles` overlays
     *  it per key). `{"developer":"system"}` rewrites developer→system on the
     *  forwarded body for upstreams without the developer role (#552). Empty =
     *  byte-for-byte transparent. */
    compat: { roles: Record<string, string> };
    /** Global-level image billing mode (#767); per-provider route entries
     *  override it, env BILI_IMAGE_BILLING overrides both. undefined = auto. */
    imageBilling?: ImageBillingMode;
    sessionHeader: string;
    log: boolean;
    debug: boolean;
    dumpSse?: string;
    passthrough: boolean;
    /** Where `passthrough` came from: "env" (ACP_PASSTHROUGH or --passthrough
     *  flag), "file" (config `passthrough: true`), or null (default off).
     *  Drives the #405 boot warning and the web panel's source display. */
    passthroughSource: "env" | "file" | null;
    autoUpdate: boolean;
    /** Opt-in self-restart when a newer version is already installed on disk
     *  (#811): re-exec at zero in-flight requests. Default OFF. */
    autoRestartOnUpdate: boolean;
    /** Dist-tag channel the auto-updater follows (default "latest"). */
    updateTag: string;
    logFile?: string;
    /** MITM transparent-proxy mode. When enabled, an HTTP CONNECT handler is
     *  attached so clients that only know how to set HTTP_PROXY (ZCode with a
     *  locked-in endpoint) can route through the proxy. Whitelisted model
     *  hosts are TLS-terminated locally and fed back into the same request
     *  pipeline; all other hosts are blind-tunnelled. */
    mitm: { enabled: boolean; domains: string[] };
    /** Mask non-public target hosts in proxy logs (#255, default on when
     *  omitted). Opt out for local debugging with env BILI_LOG_MASK_HOSTS=0
     *  or `maskHosts: false` (#897); credential masking stays on either way. */
    maskHosts?: boolean;
    /** Split Claude Code subagent requests (parent+agent header pair) into
     *  their own session id so they don't queue on the main session's lock
     *  (#970, default on). Opt out with env BILI_SUBAGENT_SPLIT=0 or
     *  `subagentSplit: false` in the config file (env wins). */
    subagentSplit?: boolean;
};

/** Re-read ONLY the routes from the current config sources, returning a fresh
 *  ProviderRoutes object. Used by the web UI's "Apply" (hot-reload) button so
 *  provider/route changes take effect without restarting bili. Only routes are
 *  re-read — port/host/upstream can't change on a running server (the listen
 *  socket is already bound), so those stay as they were at startup. Mirrors the
 *  exact precedence of loadOptions: external ACP_PROVIDERS path > inline
 *  providers in the config file. */
export function loadRoutes(env: NodeJS.ProcessEnv = process.env): ProviderRoutes {
    const fileConfig = loadConfigFile();
    const routes: ProviderRoutes = {};
    const routesPath = env.ACP_PROVIDERS ?? fileConfig.providersPath ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                rejectLegacyRoute(k, v);
                const route = parseRouteEntry(v);
                if (route) routes[normalizeUrlKey(k)] = route;
            }
        }
    }
    if (fileConfig.providers) {
        for (const [k, v] of Object.entries(fileConfig.providers)) {
            rejectLegacyRoute(k, v);
            const route = parseRouteEntry(v);
            if (route && !routes[normalizeUrlKey(k)]) routes[normalizeUrlKey(k)] = route;
        }
    }
    return routes;
}

/** Resolved passthrough state shared by loadOptions and the web config API
 *  (single source of truth — the GET handler must not re-derive it). */
export function passthroughState(env: NodeJS.ProcessEnv): { enabled: boolean; source: "env" | "file" | null } {
    const filePassthrough = loadConfigFile().passthrough === true;
    if (env.ACP_PASSTHROUGH !== undefined) return { enabled: env.ACP_PASSTHROUGH === "1", source: "env" };
    return { enabled: filePassthrough, source: filePassthrough ? "file" : null };
}

export function loadOptions(env: NodeJS.ProcessEnv = process.env): ProxyOptions {
    // --- Source 1: JSON config file (~/.config/billion-context/billion-context.json) ---
    // The canonical, user-editable config. Loaded first so env vars below can
    // override it (env wins for environment-specific overrides).
    const fileConfig = loadConfigFile();

    // --- Source 2: env vars (highest priority) ---
    const port = parseInt(env.ACP_PORT ?? env.PORT ?? `${fileConfig.port ?? 8787}`, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port ${Number.isNaN(port) ? "(not a number)" : port}; must be 1-65535`);
    }
    const rawHost = env.ACP_HOST ?? fileConfig.host ?? "127.0.0.1";
    const host = rawHost === "localhost" ? "127.0.0.1" : rawHost;
    const upstream = (env.ACP_UPSTREAM ?? fileConfig.upstream ?? "https://api.anthropic.com").replace(/\/$/, "");
    const routes = loadRoutes(env);
    const passthrough = passthroughState(env);
    const modelContextLimit = parseInt(env.ACP_MODEL_CONTEXT_LIMIT ?? `${fileConfig.modelContextLimit ?? 200000}`, 10);
    const biliProxy = nonEmpty(env.BILI_UPSTREAM_PROXY);
    const webProxy = nonEmpty(fileConfig.upstreamProxy);
    const configProxy = nonEmpty(fileConfig.proxy);
    const rawProxyMode = env.BILI_UPSTREAM_PROXY_MODE ?? fileConfig.upstreamProxyMode ?? (webProxy ? "manual" : undefined);
    // Unset mode means "direct" (matches the web UI's 直连（默认） and ZCode's
    // default), NOT auto-detect. To follow the system/env proxy, set mode "auto".
    const effectiveMode = rawProxyMode ?? "direct";
    const proxyMode = parseUpstreamProxyMode(effectiveMode);
    // explicitDirect short-circuits an EMPTY global proxy to "direct" (instead of
    // env/system auto-detect). It is true for the unset-defaults-to-direct case and
    // explicit "direct" mode, but false when an explicit proxy (BILI_UPSTREAM_PROXY)
    // is set so that proxy still wins (globalProxy is non-empty, so the short-circuit
    // is skipped regardless).
    const explicitDirect = proxyMode === "direct" && !biliProxy;
    const proxy = biliProxy ?? (proxyMode === "direct" ? "" : proxyMode === "manual" ? webProxy ?? configProxy : configProxy);
    const proxySource: ProxyOptions["proxySource"] = biliProxy
        ? "bili-env"
        : proxyMode === "direct"
          ? "direct"
          : proxyMode === "manual" && webProxy
            ? "web-manual"
            : configProxy
              ? "config"
              : "auto";
    const httpProxy = nonEmpty(env.HTTP_PROXY ?? env.http_proxy);
    const httpsProxy = nonEmpty(env.HTTPS_PROXY ?? env.https_proxy);
    const allProxy = nonEmpty(env.ALL_PROXY ?? env.all_proxy);
    const noProxy = nonEmpty(env.NO_PROXY ?? env.no_proxy);
    const proxyFallback: ProxyFallbackOptions = {
        ...(httpProxy ? { httpProxy } : {}),
        ...(httpsProxy ? { httpsProxy } : {}),
        ...(allProxy ? { allProxy } : {}),
        ...(noProxy ? { noProxy } : {}),
        biliPort: port,
        globalSource: proxySource,
        explicitDirect,
    };
    // #1012: the launcher forwards the user's pre-strip proxy vars under
    // BILI_INHERITED_* (the child's own env tier is intentionally empty —
    // e1c6c92). They feed ONLY the aux (blind-tunnel) fallback; explicit
    // routes / global config / explicitDirect keep outranking them, and the
    // biliPort loop guard inside parseFallbackProxy still drops self-loops.
    const inheritedHttpProxy = nonEmpty(env.BILI_INHERITED_HTTP_PROXY);
    const inheritedHttpsProxy = nonEmpty(env.BILI_INHERITED_HTTPS_PROXY);
    const inheritedAllProxy = nonEmpty(env.BILI_INHERITED_ALL_PROXY);
    const inheritedNoProxy = nonEmpty(env.BILI_INHERITED_NO_PROXY);
    const auxProxyFallback: ProxyFallbackOptions = {
        ...proxyFallback,
        // #1012 review catch: the DEFAULT (unset) mode resolves to "direct"
        // too (explicitDirect=true + empty global) which short-circuits
        // resolveProxyDecision BEFORE the env tier — killing the inherited
        // aux tier for every default-config user. Only an EXPLICIT "direct"
        // mode (upstreamProxyMode / BILI_UPSTREAM_PROXY_MODE) opts aux egress
        // out of the inherited tier; unset means "no preference".
        explicitDirect: rawProxyMode === "direct" && !biliProxy,
        ...(httpProxy ? {} : inheritedHttpProxy ? { httpProxy: inheritedHttpProxy } : {}),
        ...(httpsProxy ? {} : inheritedHttpsProxy ? { httpsProxy: inheritedHttpsProxy } : {}),
        ...(allProxy ? {} : inheritedAllProxy ? { allProxy: inheritedAllProxy } : {}),
        ...(noProxy ? {} : inheritedNoProxy ? { noProxy: inheritedNoProxy } : {}),
    };
    validateHttpProxy(proxy, proxyFallback.biliPort);
    for (const [url, route] of Object.entries(routes)) {
        try {
            validateHttpProxy(route.proxy, proxyFallback.biliPort);
        } catch (error) {
            throw new Error(`[acp-config] invalid upstream proxy for ${url}: ${String(error)}`);
        }
    }
    return {
        port,
        host,
        upstream,
        auxProxyFallback,
        routes,
        proxy,
        proxyMode,
        proxySource,
        proxyFallback,
        modelContextLimit,
        kernelConfig: defaultConfig(modelContextLimit),
        compress: {
            ...(fileConfig.compress ?? {}),
            injectTool: (env.ACP_COMPRESS_TOOL ?? (fileConfig.compress?.injectTool === false ? "0" : "1")) !== "0",
            injectNudge: (env.ACP_COMPRESS_NUDGE ?? (fileConfig.compress?.injectNudge === false ? "0" : "1")) !== "0",
        },
        promptCache: {
            routing: parsePromptCacheRouting(env.ACP_PROMPT_CACHE_ROUTING ?? fileConfig.promptCache?.routing),
        },
        compat: { roles: parseCompatRoles(fileConfig.compat?.roles) ?? {} },
        imageBilling: parseImageBilling(fileConfig.imageBilling),
        sessionHeader: env.ACP_SESSION_HEADER ?? fileConfig.sessionHeader ?? "x-acp-session",
        log: env.ACP_LOG !== "0" && fileConfig.log !== false,
        debug: (env.ACP_DEBUG ?? (fileConfig.debug ? "1" : "0")) === "1",
        dumpSse: env.ACP_DUMP_SSE || fileConfig.dumpSse || undefined,
        passthrough: passthrough.enabled,
        passthroughSource: passthrough.source,
        autoUpdate: (env.ACP_AUTO_UPDATE ?? (fileConfig.autoUpdate === false ? "0" : "1")) !== "0",
        // Default OFF: unlike autoUpdate, self-restart touches process
        // liveness, so it requires an explicit opt-in (#811).
        autoRestartOnUpdate: (env.ACP_AUTO_RESTART_ON_UPDATE ?? (fileConfig.autoRestartOnUpdate === true ? "1" : "0")) !== "0",
        updateTag: (env.ACP_UPDATE_TAG ?? fileConfig.updateTag ?? "latest").trim() || "latest",
        logFile: env.ACP_LOG_FILE !== undefined ? (env.ACP_LOG_FILE || undefined) : fileConfig.logFile,
        mitm: {
            enabled: (env.BILI_MITM ?? (fileConfig.mitm?.enabled === false ? "0" : "1")) !== "0",
            domains: dedupeDomains([
                ...(fileConfig.mitm?.domains ?? []),
                ...splitCsv(env.BILI_MITM_DOMAINS),
            ]),
        },
        maskHosts: (env.BILI_LOG_MASK_HOSTS ?? (fileConfig.maskHosts === false ? "0" : "1")) !== "0",
        subagentSplit: (env.BILI_SUBAGENT_SPLIT ?? (fileConfig.subagentSplit === false ? "0" : "1")) !== "0",
    };
}

/** Shape of the optional JSON config file. All fields optional — the file is a
 *  pure override layer; anything unset falls through to defaults. */
type FileConfig = {
    port?: number;
    host?: string;
    upstream?: string;
    /** Path to a legacy providers.json (backward compat). */
    providersPath?: string;
    /** Inline providers, same shape as providers.json. */
    providers?: Record<string, unknown>;
    /** Global default upstream HTTP proxy (applied to all providers unless a
     *  per-URL `proxy` overrides it). `http://host:port`. */
    proxy?: string;
    modelContextLimit?: number;
    sessionHeader?: string;
    log?: boolean;
    debug?: boolean;
    dumpSse?: string;
    passthrough?: boolean;
    autoUpdate?: boolean;
    /** Opt-in self-restart when a newer version is installed on disk (#811). */
    autoRestartOnUpdate?: boolean;
    /** Dist-tag channel the auto-updater follows (default "latest"). */
    updateTag?: string;
    upstreamProxy?: string;
    upstreamProxyMode?: string;
    logFile?: string;
    /** Global compression block (level 1 of 3). Holds the injection toggles
     *  (`injectTool` / `injectNudge`, honored globally) plus the tuning fields
     *  (see CompressSettings), overridden per-field by provider- and model-level
     *  `compress`. */
    compress?: CompressSettings & { injectTool?: boolean; injectNudge?: boolean };
    promptCache?: { routing?: string };
    mitm?: { enabled?: boolean; domains?: string[] };
    /** Set `false` to log real (non-public) target hosts instead of the
     *  `<private-host>` placeholder (#897; env BILI_LOG_MASK_HOSTS=0 wins). */
    maskHosts?: boolean;
    /** Set `false` to keep Claude Code subagents on the main session (#970;
     *  env BILI_SUBAGENT_SPLIT=0 wins). */
    subagentSplit?: boolean;
    /** Global wire-compat block. `roles` maps message roles to the role name
     *  upstreams accept (e.g. `{"developer":"system"}`) — applied to the
     *  final forwarded body for openai/responses requests (#552). */
    compat?: { roles?: Record<string, string> };
    /** Global image billing mode (#767): "auto" | "pixels" | "bytes".
     *  Per-provider `imageBilling` overrides it; env BILI_IMAGE_BILLING wins
     *  over both. See ProviderRoute.imageBilling. */
    imageBilling?: string;
    /** Claude-native install tuning (#964): the loopback port the managed
     *  settings block pins ANTHROPIC_BASE_URL at and the SessionStart hook
     *  brings a proxy up on. Default CLAUDE_NATIVE_DEFAULT_PORT; env
     *  BILI_CLAUDE_NATIVE_PORT wins over both. */
    claude?: { nativePort?: number };
};

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

function splitCsv(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function dedupeDomains(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of list) {
        if (!seen.has(d)) {
            seen.add(d);
            out.push(d);
        }
    }
    return out;
}

function loadConfigFile(): FileConfig {
    const parsed = safeReadJson(configFile());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as FileConfig;
    }
    return {};
}

/** Default loopback port for the claude native install (#964): the value the
 *  installer bakes into ~/.claude/settings.json's env.ANTHROPIC_BASE_URL and
 *  the SessionStart hook brings a proxy up on. Documented as reserved. */
export const CLAUDE_NATIVE_DEFAULT_PORT = 48787;

/** The claude-native loopback port, one resolution for installer, hook, and
 *  launcher: env BILI_CLAUDE_NATIVE_PORT > config `claude.nativePort` >
 *  CLAUDE_NATIVE_DEFAULT_PORT. */
export function resolveClaudeNativePort(env: NodeJS.ProcessEnv = process.env): number {
    const fromEnv = Number.parseInt(env.BILI_CLAUDE_NATIVE_PORT ?? "", 10);
    if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
    const fromFile = loadConfigFile().claude?.nativePort;
    if (typeof fromFile === "number" && Number.isInteger(fromFile) && fromFile > 0 && fromFile < 65536) return fromFile;
    return CLAUDE_NATIVE_DEFAULT_PORT;
}

/** Persist the claude-native port the installer baked into settings.json
 *  (#964). Without this, an install driven by BILI_CLAUDE_NATIVE_PORT writes
 *  that port into ~/.claude/settings.json but the SessionStart hook (which
 *  does NOT inherit claude's settings.env) later resolves the default —
 *  hooking the wrong port while claude dials the baked one. `claude plugin
 *  install` calls this; `claude plugin remove` calls clearClaudeNativePort. */
/** #964: read-modify-write safety for user config files — refuse to write
 *  over a file that exists but is NOT valid JSON: loadConfigFile() degrades
 *  malformed input to {}, so an unguarded RMW would replace the user's
 *  corrupt-but-repairable config with a minimal one (silent clobber).
 *  Absent / empty / valid files are all safe to write. */
function configFileRmwSafe(): boolean {
    const p = configFile();
    let raw: string;
    try {
        raw = readFileSync(p, "utf8");
    } catch {
        return true;
    }
    if (!raw.trim()) return true;
    try {
        JSON.parse(raw.replace(/^\uFEFF/, ""));
        return true;
    } catch {
        return false;
    }
}

export function saveClaudeNativePort(port: number): void {
    const p = configFile();
    if (!configFileRmwSafe()) {
        loggerLog("warn", `[acp-config] refusing to persist claude.nativePort=${port} — ${p} is not valid JSON; repair it first`);
        return;
    }
    const cur = loadConfigFile() as { claude?: { nativePort?: number } } & Record<string, unknown>;
    const next: { claude?: { nativePort?: number } } & Record<string, unknown> = { ...cur };
    next.claude = { ...(cur.claude ?? {}), nativePort: port };
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
    } catch (err) {
        loggerLog("warn", `[acp-config] could not persist claude.nativePort=${port} at ${p} — ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Drop the persisted claude-native port (plugin remove) so a fresh default
 *  install resolves the default port again. Never throws. */
export function clearClaudeNativePort(): void {
    const p = configFile();
    if (!configFileRmwSafe()) {
        loggerLog("warn", `[acp-config] refusing to clear claude.nativePort — ${p} is not valid JSON; repair it first`);
        return;
    }
    const cur = loadConfigFile() as { claude?: { nativePort?: number } } & Record<string, unknown>;
    if (cur.claude?.nativePort === undefined) return;
    const next: Record<string, unknown> = { ...cur };
    if (Object.keys(cur.claude).length > 1) {
        const claude = { ...cur.claude } as Record<string, unknown>;
        delete claude.nativePort;
        next.claude = claude;
    } else {
        delete next.claude;
    }
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
    } catch (err) {
        loggerLog("warn", `[acp-config] could not clear claude.nativePort at ${p} — ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** Template written on first run so the user has a file to edit instead
 *  of having to invent the path/schema. Left empty on purpose: the proxy
 *  can't guess your provider, so we don't put a fake one. Fill it in per
 *  the README Quickstart, then restart `bili`. */
const TEMPLATE_CONFIG = `{
  "providers": {
  }
}`;

/** On first run, seed a template config file next to where loadOptions reads.
 *  Idempotent: never overwrites an existing file. Returns true if it created
 *  one. Non-fatal: if the dir isn't writable, we fall through to defaults and
 *  the proxy still runs. */
export function ensureConfigTemplate(): boolean {
    const p = configFile();
    if (existsSync(p)) return false;
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, TEMPLATE_CONFIG + "\n", "utf8");
        loggerLog("info", `[acp-config] created empty config at ${p} — add your providers (see README Quickstart), then restart`);
        return true;
    } catch {
        return false;
    }
}

export function normalizeUrlKey(key: string): string {
    // Keys are upstream URLs matched by longest-prefix against the request's
    // embedded URL. A trailing slash breaks that match (the embedded URL never
    // has one), so strip trailing slashes. Manual edits and web-UI saves both
    // flow through here so the behavior is consistent.
    return key.replace(/\/+$/, "");
}

export function parseRouteEntry(v: unknown): ProviderRoute | undefined {
    // The value describes per-model context overrides. The upstream URL itself
    // is the KEY in the providers map (identical to the /bili/<url> string),
    // so it is NOT repeated inside the value.
    if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as { models?: Record<string, ModelEntry>; proxy?: string; compressProtocol?: string; compress?: CompressSettings; compat?: { roles?: unknown }; passthrough?: boolean; imageBilling?: unknown };
        const route: ProviderRoute = { models: obj.models };
        if (typeof obj.proxy === "string") route.proxy = obj.proxy;
        if (obj.compressProtocol === "marker" || obj.compressProtocol === "tools") route.compressProtocol = obj.compressProtocol;
        if (obj.compress) route.compress = obj.compress;
        const compatRoles = parseCompatRoles(obj.compat?.roles);
        if (compatRoles) route.compat = { roles: compatRoles };
        if (typeof obj.passthrough === "boolean") route.passthrough = obj.passthrough;
        const imageBilling = parseImageBilling(obj.imageBilling);
        if (imageBilling) route.imageBilling = imageBilling;
        return route;
    }
    // A bare value (e.g. null) means "this upstream exists, no overrides".
    if (v === null) return {};
    return undefined;
}

export function parseImageBilling(value: unknown): ImageBillingMode | undefined {
    return value === "auto" || value === "pixels" || value === "bytes" ? value : undefined;
}

export function parsePromptCacheRouting(value: string | undefined): PromptCacheRouting {
    return value === "enabled" || value === "disabled" ? value : "auto";
}

export function parseUpstreamProxyMode(value: string | undefined): UpstreamProxyMode {
    return value === "manual" || value === "auto" ? value : "direct";
}

export function parseCompressSettings(v: unknown): (CompressSettings & { injectTool?: boolean; injectNudge?: boolean }) | undefined {
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    const obj = v as Record<string, unknown>;
    const out: CompressSettings = {};
    const numberOrPercent = (value: unknown): value is number | string =>
        typeof value === "number" && Number.isFinite(value)
        || (typeof value === "string" && /^\d+(\.\d+)?%$/.test(value.trim()));
    let ok = true;
    const takeNumber = (key: keyof CompressSettings): void => {
        if (!(key in obj)) return;
        if (typeof obj[key] !== "number" || !Number.isFinite(obj[key] as number)) ok = false;
        else (out as Record<string, unknown>)[key] = obj[key];
    };
    for (const key of ["modelContextLimit", "maxContextLimit", "emergencyThresholdPercent"] as const) {
        if (!(key in obj)) continue;
        if (!numberOrPercent(obj[key])) { ok = false; continue; }
        (out as Record<string, unknown>)[key] = typeof obj[key] === "string" ? (obj[key] as string).trim() : obj[key];
    }
    for (const key of ["nudgeGrowthTokens", "preserveRecentMessages", "preserveRecentTokens", "minCompressRange", "minCompressRangeChars", "stripImagesKeepRecent"] as const) {
        takeNumber(key);
    }
    if ("outputHeadroomMaxPct" in obj) {
        const v = obj.outputHeadroomMaxPct;
        if (typeof v !== "number" && typeof v !== "string") ok = false;
        else {
            const pct = resolveOutputHeadroomCap(v);
            if (!Number.isFinite(pct) || pct < 0) ok = false;
            else out.outputHeadroomMaxPct = v;
        }
    }
    if ("tiers" in obj) {
        if (typeof obj.tiers !== "boolean") ok = false;
        else out.tiers = obj.tiers;
    }
    if ("stripImages" in obj) {
        if (typeof obj.stripImages !== "boolean") ok = false;
        else out.stripImages = obj.stripImages;
    }
    if ("visibilityMarkers" in obj) {
        if (typeof obj.visibilityMarkers !== "boolean") ok = false;
        else out.visibilityMarkers = obj.visibilityMarkers;
    }
    // Injection toggles are file-level fields (FileConfig.compress) honored by
    // loadOptions via `=== false`; the web UI shows them from the raw file
    // block, so they must round-trip here. Dropping them would silently
    // re-enable injectTool/injectNudge on an unchanged save.
    for (const key of ["injectTool", "injectNudge"] as const) {
        if (key in obj) {
            if (typeof obj[key] !== "boolean") ok = false;
            else (out as Record<string, unknown>)[key] = obj[key];
        }
    }
    if ("acknowledgePromptsRisk" in obj) {
        if (typeof obj.acknowledgePromptsRisk !== "boolean") ok = false;
        else out.acknowledgePromptsRisk = obj.acknowledgePromptsRisk;
    }
    if ("absorb" in obj && obj.absorb !== undefined) {
        const a = obj.absorb;
        if (!a || typeof a !== "object" || Array.isArray(a)) {
            ok = false;
        } else {
            const ao = a as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["absorb"]> = {};
            for (const key of ["enabled", "minToolTokens", "contextThresholdPct", "excludeTools", "toolName"] as const) {
                if (!(key in ao)) continue;
                const v = ao[key];
                if (key === "enabled") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.enabled = v;
                } else if (key === "minToolTokens") {
                    if (typeof v !== "number" || !Number.isFinite(v)) { ok = false; continue; }
                    cleaned.minToolTokens = v;
                } else if (key === "contextThresholdPct") {
                    if (!numberOrPercent(v)) { ok = false; continue; }
                    cleaned.contextThresholdPct = typeof v === "string" ? v.trim() : v;
                } else if (key === "excludeTools") {
                    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) { ok = false; continue; }
                    cleaned.excludeTools = [...v] as string[];
                } else {
                    if (typeof v !== "string" || v.trim().length === 0) { ok = false; continue; }
                    cleaned.toolName = v.trim();
                }
            }
            if (ok) out.absorb = cleaned;
        }
    }
    if ("prompts" in obj && obj.prompts !== undefined) {
        const prompts = obj.prompts;
        if (!prompts || typeof prompts !== "object" || Array.isArray(prompts)) {
            ok = false;
        } else {
            const cleaned: Partial<Prompts> = {};
            for (const [key, value] of Object.entries(prompts as Record<string, unknown>)) {
                if (typeof value !== "string" || value.trim().length === 0) { ok = false; continue; }
                if (key !== "compressPhilosophy" && key !== "howToCompressRules"
                    && key !== "tier2DistillRules" && key !== "tier3CondenseRules") {
                    ok = false;
                    continue;
                }
                (cleaned as Record<string, string>)[key] = value;
            }
            if (ok) out.prompts = cleaned;
        }
    }
    if ("promptPack" in obj && obj.promptPack !== undefined) {
        if (typeof obj.promptPack !== "string" || obj.promptPack.trim().length === 0) ok = false;
        else out.promptPack = obj.promptPack.trim();
    }
    if ("reasoningGuard" in obj && obj.reasoningGuard !== undefined) {
        const rg = obj.reasoningGuard;
        if (!rg || typeof rg !== "object" || Array.isArray(rg)) {
            ok = false;
        } else {
            const rgo = rg as Record<string, unknown>;
            const cleaned: ReasoningGuardConfig = {};
            for (const key of ["enabled", "maxContinue", "maxTierN", "markerText", "base", "offset", "debugLog"] as const) {
                if (!(key in rgo)) continue;
                const v = rgo[key];
                if (key === "enabled") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.enabled = v;
                } else if (key === "debugLog") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.debugLog = v;
                } else if (key === "markerText") {
                    if (typeof v !== "string" || v.trim().length === 0) { ok = false; continue; }
                    cleaned.markerText = v.trim();
                } else {
                    if (typeof v !== "number" || !Number.isFinite(v)) { ok = false; continue; }
                    (cleaned as Record<string, unknown>)[key] = v;
                }
            }
            if (ok) out.reasoningGuard = cleaned;
        }
    }
    if (!ok) return undefined;
    return out;
}

function rejectLegacyRoute(key: string, value: unknown): void {
    if (typeof value !== "string") return;
    throw new Error(
        `[acp-config] legacy provider route \"${key}\": \"${value}\" is no longer valid; ` +
        `use the upstream URL as the key, for example { \"${value.replace(/\/+$/, "")}\": {} }`,
    );
}
