import { defaultConfig, DEFAULT_CCR_CONFIG, type Config, type Prompts } from "acp-kernel";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { configFile } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { validateHttpProxy, type ProxyFallbackOptions } from "./upstream-proxy.js";
import { maskUrlForLog } from "./log-mask.js";
import { resolveOutputHeadroomCap, type WireProtocol } from "./util.js";
import { DEFAULT_MITM_DOMAINS, matchesAnyMitmDomain } from "./mitm-domains.js";

import { parseCompatRoles } from "./compat-roles.js";
import { parseCompatDropFields } from "./compat-drop.js";
import type { ImageBillingMode } from "./image-tokens.js";
import type { ReasoningGuardConfig } from "./reasoning-guard.js";
import type { OutputSteeringConfig } from "./output-steering.js";
import { parseExternalSummaryChain, type ExternalSummaryChain, validSummaryCredentialName } from "./external-summary-settings.js";

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
    /** #1909: declared wire protocol for this key's requests — forces the
     *  pipeline to treat matching POSTs as this protocol regardless of the
     *  built-in path-suffix table (relays that hang model endpoints off
     *  custom paths; MITM'd clients that cannot carry a /bili/ explicit
     *  marker). Resolved independently of every other field: ALL matching
     *  keys are scanned longest-prefix-first and the deepest key that
     *  EXPLICITLY declares `protocol` wins, so a host-level declaration keeps
     *  applying under a silent path-scoped key without duplication. The OTHER
     *  fields keep findRoute's single-entry longest-key semantics — a
     *  protocol-only path key still becomes the winning entry under its
     *  subtree for them. The /bili/<protocol>/ URL marker still outranks it; the
     *  body must still parse as the declared protocol or it relays verbatim
     *  (#1284). Invalid values reject the config load loudly. */
    protocol?: WireProtocol;
    /** Per-provider compression overrides (level 2 of 3). See CompressSettings. */
    compress?: CompressSettings;
    /** Per-provider wire-compat overrides. `roles` maps message roles to the
     *  role name this upstream accepts (e.g. `"developer": "system"`) —
     *  applied at the forward boundary to the FINAL wire body, covering
     *  client-sent roles and bili's own injected prompt alike (#552). Wins
     *  per key over the global `compat` block. `dropFields` (#1757) is an
     *  ADDITIVE union with the global list (a provider entry adds paths but
     *  cannot retract global ones): dot-separated plain-object key paths of
     *  client-sent fields this upstream's strict schema rejects. */
    compat?: { roles?: Record<string, string>; dropFields?: string[] };
    /** Route-scoped passthrough (#661): same semantics as the global
     *  `passthrough` flag, but only for requests whose upstream URL matches
     *  this route — request body forwarded byte-for-byte (no kernel
     *  round-trip, no render tags, no re-serialization), response piped
     *  verbatim, no session state. For upstreams whose anti-cheat fingerprints
     *  the request body (e.g. ZCode 405/3012). */
    passthrough?: boolean;
    /** Client-side routing exemption (#1622): this upstream never gets pointed
     *  through bili at all. Store-rewriting native lanes (zcode today) skip
     *  matching entries instead of wrapping them, so traffic flows
     *  client→upstream untouched — unlike `passthrough`, which still
     *  terminates at the proxy. Matched by the same longest-URL-prefix rule
     *  as every other provider field, so it is generic across lanes (an MITM
     *  lane could honor it by skipping interception for the domain). */
    direct?: boolean;
    /** Per-provider image billing mode (#767): "bytes" = ceil(base64/4), an
     *  EXPLICIT opt-in for byte-counting relays only; "pixels" = dimension-
     *  based tile estimate; "auto" (default) resolves to pixels for every host
     *  (#1843: base64/4 as an implicit default was a ±1500% estimate that
     *  poisoned every window gate). Wins over the global `imageBilling`; env
     *  BILI_IMAGE_BILLING wins over both. */
    imageBilling?: ImageBillingMode;
    /** #1843 L3: per-image token ceiling for this route — clamps each image's
     *  estimated cost (both billing modes). Wins over the global
     *  `imageTokenCap`; env BILI_IMAGE_TOKEN_CAP wins over both. Positive
     *  integer; undefined/unset = no cap. */
    imageTokenCap?: number;
    /** #1884 level-2 scheme-keyed re-sign overrides for this provider:
     *  key = lowercase signature scheme (e.g. "sdk-hmac-sha256"), per-field
     *  deepest wins over the global `resign` block (env still wins over
     *  both). The model-level knob lives one level deeper —
     *  `models.<name>.benefit` on this same provider key (#1884 level 3). */
    resign?: ResignSchemeMap;
    /** #2336 lane credential override (forward path): name of the environment
     *  variable holding the key bili sends upstream INSTEAD of the client's
     *  own credential for this lane. Exactly one of apiKeyEnv/credentialRef;
     *  replacement rules — `authorization` is replaced only when the client's
     *  value is a Bearer token (other schemes are signature-owned and kept),
     *  `x-api-key`/`x-goog-api-key` are replaced outright, and a request with
     *  none of the three gains `authorization: Bearer <key>`. Never applied
     *  when the #1884 re-sign arm owns the signature. Invalid values THROW
     *  (#1909 discipline). */
    apiKeyEnv?: string;
    /** #2336 lane credential override: NAME in the private summary-credential
     *  store (`billion-context.json.summary-credentials.json`) — same
     *  semantics as apiKeyEnv, for keys kept out of the environment. */
    credentialRef?: string;
    /** #3211: per-route estimator-calibration (k̂) policy. The learned k̂ is
     *  this route's billing reports ÷ local estimates — on a route that
     *  INFLATES its usage reports (relay markup, non-token accounting), the
     *  learned ratio is the inflation mark itself, and applying it to the
     *  decision meter pins usage into the pressure band (`nudge.maxContextLimitPct`)
     *  permanently, which bypasses growth-gate + cadence → high-frequency
     *  small-yield fold churn (#3211). Opt-in escape hatch applied at k̂
     *  PUBLICATION time — the learned ring stays raw and visible for audit:
     *  - `disabled: true` — never apply a learned factor on this route
     *    (decision meters run on the raw local estimate);
     *  - `max: <number>` — clamp the applied factor to ≤ max (e.g. `1` =
     *    allow deflation learning only, never inflation). Must be > 0 and ≤ 4
     *    (higher is inert anyway — the publication clamp already caps at 4).
     *  Invalid values reject the config load loudly (strict #1909 discipline). */
    calibration?: { disabled?: boolean; max?: number };
    /** #3376: idle prompt-cache keepalive overrides for this route (per-field
     *  deepest wins over the global `cacheKeepalive`; env still wins over
     *  both). See {@link CacheKeepaliveSettings}. */
    cacheKeepalive?: CacheKeepaliveSettings;
};
export type ProviderRoutes = Record<string, ProviderRoute>; // key = upstream URL prefix (the /bili/<this> string)

/** #3376: idle prompt-cache keepalive settings (Anthropic wire only, v1).
 *  While a session is idle, bili replays the EXACT last accepted upstream
 *  body (max_tokens=1, stream=false) at cadence ≈ TTL tier × ttlFactor so the
 *  upstream prefix cache survives user pauses. Verdict per ping:
 *  usage.cache_read_input_tokens > 0 → reschedule; 0 → stop (prefix dead);
 *  HTTP 429 → immediate stop; ≥3 consecutive other failures → stop.
 *  Configurable at two levels — global (config root `cacheKeepalive`) and
 *  per-provider (`providers[url].cacheKeepalive`) — merged per-field
 *  provider-wins by resolveCacheKeepalive (src/cache-keepalive.ts); env BILI_
 *  CACHE_KEEPALIVE* wins over both. All fields optional; unset = default. */
export interface CacheKeepaliveSettings {
    /** Master switch. Default false (opt-in feature). */
    enabled?: boolean;
    /** Cadence factor applied to the TTL tier (default 0.9 → 5m tier pings
     *  every ~4.5 min, 1h tier every ~54 min). Must be in (0, 1]. */
    ttlFactor?: number;
    /** Max wall-clock keepalive after the LAST REAL request, ms (default
     *  86400000 = 24h). Beyond it the session disarms even if still hitting. */
    maxDurationMs?: number;
    /** Max simultaneously armed sessions (default 4; oldest armed evicted on
     *  overflow). */
    maxConcurrentPings?: number;
    /** Skip body tier detection and assume this TTL tier regardless of what
     *  cache_control breakpoints the snapshot carries (CPA-style proxies may
     *  re-stamp breakpoints downstream of bili, or strip them entirely). */
    assumeTtl?: "5m" | "1h";
    /** Arm even when the snapshot carries NO cache_control breakpoints at all
     *  (pairs with assumeTtl; without it the tier falls back to 5m). */
    armWithoutBreakpoints?: boolean;
    /** Absolute cadence in ms — wins over tier × ttlFactor and implies
     *  armWithoutBreakpoints. For environments where the effective upstream
     *  TTL is neither Anthropic tier (custom CPA proxies). */
    intervalMs?: number;
}

/** Per-model declaration under a provider route. `context` / `output` are the
 *  legacy fields; `compress` is the level-3 override (deepest, highest priority). */
export type ModelEntry = {
    context?: number;
    output?: number;
    /** Per-model compression overrides (level 3 of 3, wins over provider
     *  and global). See CompressSettings. */
    compress?: CompressSettings;
    /** #1884 level-3: this model bills against the CodeArts free quota —
     *  re-signed requests for it carry the signed `maas_type: benefit`
     *  header. `true` / `false` are explicit (false opts a default-set model
     *  out); unset falls through to the built-in fallback set
     *  (CODEARTS_BENEFIT_FALLBACK mirror). Env BILI_RESIGN_BENEFIT wins over
     *  this like every other knob. */
    benefit?: boolean;
    /** #3376 per-model idle-cache-keepalive override — the deepest config
     *  tier (env > model > provider > global) for that model's snapshots. */
    cacheKeepalive?: CacheKeepaliveSettings;
};

/** User-facing compression tuning. Configurable at three levels — global
 *  (config root `compress`), per-provider (`providers[url].compress`), per-model
 *  (`providers[url].models[model].compress`) — merged deepest-field-wins by
 *  {@link mergeCompress} (child covers parent, per field, not whole-object). Every
 *  field is optional; unset fields fall through to the kernel default. */
export type CompressSettings = {
    /** External summary chain — three-level like every other compress field
     *  (whole-chain replace at provider/model level, no sub-merge). File shape:
     *  references into the named providers table ("glm/glm-4.9-flash"),
     *  expanded at request-config time (see NamedProviderRecipe). */
    externalSummary?: ExternalSummaryChain;
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
    /** #3211: minimum reclaimable tokens a pressure-band nudge must have to
     *  fire (usage already ≥ `maxContextLimit`). Default when unset at every
     *  level: `max(5000, context limit × 1%)`. On routes whose decision meter
     *  runs inflated (k̂ amplification, #3211), raising this (e.g. 50000) stops
     *  the "fold a little each time we hit the line" churn: sub-floor pending
     *  batches suppress the nudge (logged; truncate.threshold remains the
     *  safety valve) so growth accumulates until one batch big enough to push
     *  usage out of the band. An explicit 0 restores the legacy any-pending
     *  behavior. Maps to kernel `nudge.minPressureBenefitTokens`. Deepest
     *  level wins PER FIELD across global → provider → model, like every
     *  other compress field. */
    minPressureBenefitTokens?: number;
    /** Per-tier nudge growth thresholds in tokens (#2376): independent token
      *  trigger sizes for the T1/T2/T3 mass paths, e.g. keep T1 aggressive for
      *  long tasks while letting T2 distill earlier/later. Each UNSET tier
      *  falls back to the derived default (T1 = `nudgeGrowthTokens`, T2/T3 =
      *  `nudgeGrowthTokens` × the kernel's 1.5 multiplier), so an absent or
      *  empty object is fully backward compatible with the unified value.
      *  Maps to kernel `nudge.tierGrowthTokens` (acp-kernel >= 0.0.108).
      *  Deepest level wins PER FIELD across global → provider → model. */
    tierNudgeTokens?: { t1?: number; t2?: number; t3?: number };
    /** #2228: model-decided nudge timing. When true, an armed tier-1 (gentle)
     *  nudge first asks the model — over the session's already-cached prefix,
     *  in a short side call with no tools tail — whether compressing NOW is
     *  net-beneficial for the current task. A strict-JSON "yes" (optionally
     *  naming a span) injects an explicit directive with a program-finalized
     *  range; "no", a malformed answer, or a timeout injects nothing this
     *  round. After 3 consecutive hard failures the next arm falls back to
     *  the legacy advisory nudge once and resets (self-healing). Emergency /
     *  over-limit nudges and tier-2/3 distillation bypass the decision
     *  entirely. Host-only (not passed to the kernel); off unless explicitly
     *  enabled at some level. */
    nudgeModelDecided?: boolean;
    /** #2228: output budget (tokens) of the decision side call. Default 200
     *  (same ceiling class as SIDE_REQUEST_MAX_TOKENS). Must be > 0. */
    nudgeDecisionMaxTokens?: number;
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
    /** Hard character cap on ONE generated summary; longer replies are
     *  rejected whole by the kernel and the external-summary executor. Maps to
     *  kernel `compress.maxSummaryLength` (default 20000; 0 = unbounded).
     *  #3635: external summarizers are told this exact cap up front. */
    maxSummaryLength?: number;
    /** Character floor for generated summaries; shorter replies are rejected
     *  whole. Maps to kernel `compress.minSummaryLength` (default 50;
     *  0 = disabled). #3635. */
    minSummaryLength?: number;
    /** Enable multi-tier (T2/T3) distillation (kernel `tiers.enabled`). */
    tiers?: boolean;
    /** Tool-name patterns whose LATEST tool-call + paired result are never
     *  compressed (kernel `protectedLatestTools`, acp-kernel >= 0.0.80).
     *  Built for cumulative-snapshot tools (e.g. a client's todo/task list):
     *  every newer result supersedes the older ones, so only the newest
     *  instance is the source of truth — protecting ALL of them (via
     *  `protectedTools`) would make that tool's history grow unboundedly,
     *  while protecting the LATEST keeps the live snapshot in context and
     *  lets every superseded instance fold normally. Patterns match by exact
     *  tool name or `*` glob (e.g. `"todo_list"`, `"todo*"`); a pattern
     *  containing `/` matches the canonical skill path instead — skill loads
     *  project to `skill/<name>` on every client (#1947) — and protects the
     *  latest instance PER path (`"skill/*"` keeps the newest load of every
     *  skill, not just one). Protection is a HARD exclusion: neither
     *  suggested nor explicit compress ranges can cover the latest instance.
     *  Deepest level wins (global → provider → model), whole-array replace.
     *  Default: none — opt in per client/agent, since tool names are
     *  client-specific. */
    protectedLatestTools?: string[];
    /* (durable virtual paths) dsh lanes project their durable-state TEXT
     *  carriers to `durable/<name>` identities (#2446 family: skill catalog,
     *  mcp catalog, agents-md baseline, runtime-context snapshot), so the
     *  same pattern machinery governs them: `"durable/*"` keeps the LATEST
     *  instance of every carrier (all four are cumulative snapshots — the
     *  older catalogs/baselines fold away). Default when nothing is
     *  configured: `durable/*` latest-per-identity in
     *  `protectedLatestTools` (pi-reference single-live-copy semantics —
     *  skill/MCP visibility can never be lost, superseded snapshots
     *  fold). */
    /** Tool patterns whose tool-calls AND paired results are NEVER
     *  compressed — every instance, full history (kernel `protectedTools`,
     *  hard exclusion: matching refs render as `BLOCKED`, so neither suggested
     *  nor explicit compress ranges can cover them; applies identically in
     *  both compression modes and on every wire). Built for low-frequency,
     *  high-value tools whose instances are INDEPENDENT content rather than
     *  cumulative snapshots (e.g. opencode/pi `skill` loads, one-shot
     *  references): each load carries unique information that no later result
     *  supersedes, so folding older loads loses it permanently (#1109).
     *  ⚠ Trade-off (#639 rationale): protecting ALL instances of a chatty or
     *  cumulative-snapshot tool makes its history grow unboundedly — use
     *  `protectedLatestTools` for those instead. Patterns match by exact
     *  tool name or `*` glob (e.g. `"skill"`, `"skill_*"`); a pattern
     *  containing `/` selects skills by name on every client (#1947): skill
     *  loads project to `skill/<name>`, so `"skill/release-orchestrator"`
     *  protects each load of that one skill and `"skill/review-*"` glob-
     *  matches within the name segment (`*` never crosses `/`).
     *  Deepest level wins (global → provider → model), whole-array replace.
     *  Default: none — opt in per client/agent, since tool names are
     *  client-specific. */
    protectedTools?: string[];
    /* (durable virtual paths) any pattern whose first path segment is
     *  `durable` takes over the whole durable policy for that lane
     *  (whole-identity takeover): bili attaches only the identity
     *  classifier and injects NO default — e.g. `"durable/agents-md"`
     *  protects just the workspace baseline while skill/mcp catalogs fold
     *  normally. Unregistered lanes get no projection at all. */
    /** Tool-name patterns EXCLUDED from the soft-protected recent zone —
     *  matching tool results inside the recent zone become compressible
     *  immediately instead of aging out first (kernel
     *  `neverPreserveRecentTools`, acp-kernel >= 0.0.92). The kernel default
     *  is `["decompress", "search_context", "read", "bash"]`: read/bash are
     *  the largest reclaimable mass, so fresh results SHOULD re-enter the
     *  foldable pool right away. Removing a pattern (recommended: only
     *  `read`, → `["decompress", "search_context", "bash"]`) keeps freshly
     *  read files inside the recent zone so batch-read workflows stop hitting
     *  the fold→re-read death loop (#1198/#1277) — the results age out of the
     *  zone by position later instead of being pinned forever (unlike
     *  `protectedLatestTools`). Keep `decompress`/`search_context` excluded:
     *  re-including them pins just-restored blocks in the recent zone where
     *  they become unreclaimable — a different disease (#1277 owner note).
     *  ⚠ Empty array `[]` is VALID and excludes nothing (max-protection
     *  escape hatch); unlike `protectedTools`/`protectedLatestTools` an empty
     *  array is not rejected. Unset → kernel built-in default list. Patterns
     *  match like kernel tool patterns (exact name or `*` glob). Deepest
     *  level wins (global → provider → model), whole-array replace. */
    neverPreserveRecentTools?: string[];
    /** Tool-name patterns REMOVED from the effective recent-zone exclusion
     *  list — the positive-facing knob: "protect these tools in the recent
     *  zone" without restating the built-in list (kernel
     *  `preserveRecentTools`, acp-kernel >= 0.0.93). Effective exclusion =
     *  `(neverPreserveRecentTools ?? kernel built-in) minus
     *  preserveRecentTools`, so the #1198/#1277 batch-read fold→re-read
     *  remedy is a one-entry `[
     *  "read"]` that keeps following built-in list evolution — no hand-copied
     *  list to go stale. Composable with an explicit `neverPreserveRecentTools`
     *  (subtraction applies to it too). Unset/empty = no subtraction — NOT
     *  the protect-everything hatch (that is `neverPreserveRecentTools: []`).
     *  Patterns match like kernel tool patterns (exact name or `*` glob).
     *  Deepest level wins (global → provider → model), whole-array replace. */
    preserveRecentTools?: string[];
    /** Emit 📦/❌ ACP visibility markers after proxy tool executions
     *  (compress / decompress / search_context / acp_status) — both the marker
     *  line streamed to the client and the marker message re-injected into
     *  rebuilt history. `false` suppresses them entirely, for deployments where
     *  models imitate or narrate around the markers (#862). Default `true`. */
    visibilityMarkers?: boolean;
     /** Force preflight summarization calls to use streaming (SSE) instead of
      *  the default non-stream call (#2133). The error-driven self-learn flag
      *  (`session.metadata.preflightStreamSummary`) fires on any 400 from a
      *  NON-STREAMING summary attempt (#2494: the shape is the detector —
      *  originally only "stream … true" wording was recognized) and on a
      *  first-hit gateway timeout (Cloudflare's HTTP 524 / 504), so most
      *  stream-mandating upstreams now self-heal in one round-trip. Set this
      *  where a gateway cuts long non-streaming completions with a status the
      *  learn path cannot see, or simply to skip the one probe round-trip —
      *  every preflight summary call then streams from the first attempt.
      *  Deepest level wins (global → provider → model), so it can be
     *  scoped to just the affected route; unset = legacy behavior (non-stream
     *  first, learn on 400). No-op on the Google wire (its summary calls are
     *  always streamed via :streamGenerateContent). */
    streamSummary?: boolean;
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
        /** [#3402] When true (default), only image-bearing tool results are
         *  absorb candidates and they bypass minToolTokens; false restores the
         *  old behavior of marking any result ≥ minToolTokens. */
        mediaOnly?: boolean;
    };
    /** [#1097] Kernel CCR content store (kernel `Config.ccr`, acp-kernel
     *  0.0.84). When `enabled`, oversized tool results (>= minToolTokens) are
     *  ID-referenced at arrival by the kernel's ccr-store node (prune →
     *  ccr-store → absorb): the wire keeps a deterministic `[acp-stored` …
     *  placeholder and the original goes into the session's kernel
     *  `MessageContentStore`, retrievable via the injected retrieve tool.
     *  Lossless by default — a retrieve not made costs one cheap tool call,
     *  whereas a distilled-away detail is gone for good. ID-reference wins
     *  over absorb (kernel ordering). Off unless explicitly enabled at some
     *  level. Merged sub-field-wise across the three levels like `absorb`. */
    ccr?: {
        /** Enable CCR for this scope. Absent/false = off (kernel semantics). */
        enabled?: boolean;
        /** Tool results smaller than this many tokens stay verbatim
         *  (kernel default 4000). */
        minToolTokens?: number;
        /** Tool-name patterns (glob suffix allowed) never CCR-stored
         *  (kernel default: none). */
        excludeTools?: string[];
        /** Rename the retrieve tool (default "acp_retrieve"). Must stay unique
         *  against the client's own tool names. */
        toolName?: string;
        /** Max characters for the placeholder head/command preview (kernel
         *  default 96). */
        maxHeadChars?: number;
    };
    /** [#1336] Planning-aware retrieval: when `planAware` is true,
     *  search_context re-ranks its candidate blocks against the session's
     *  current todo/task state (the latest protectedLatestTools snapshot in
     *  context plus the most recent user turn) and appends a short steering
     *  section to the result. Pure host-side policy — the kernel's lexical
     *  candidate surface, the content store, folding and injection mechanics
     *  are all reused unchanged. Disabled or no plan state in context ⇒
     *  byte-identical output to the plain lexical ranking. Off by default;
     *  measure before enabling in shared configs. Merged sub-field-wise across
     *  the three levels like `absorb`/`ccr`. See src/decompress-shared.ts. */
    search?: {
        /** Enable plan-aware re-ranking + steering for search_context.
         *  Absent/false = off (byte-identical output). */
        planAware?: boolean;
    };
    /** Persistent rule reminders (kernel `Config.rules`, acp-kernel >= 0.0.70).
     *  When `enabled`, an `acp_rule` tool is injected (or advertised in the
     *  plugin manifest): passing a short `rule` records a principle-level
     *  reminder that is hard-protected from compression and stays in context
     *  for the life of the session; omitting the argument lists recorded
     *  rules for human review. `delete` removes one rule by id, `clear: true`
     *  removes all (#1399: the model has full rights over session rules and
     *  may call any of these unprompted). The feature deliberately adds NO
     *  system-prompt content (all guidance rides in the tool description).
     *  Maps to kernel `Config.rules = { enabled }`. Off unless explicitly
     *  enabled at some level. Deepest-wins like every other scalar field. */
    rules?: boolean;

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
    /** [#1093] Output-side compression levers — verbosity steering (a conciseness
     *  directive appended to the system-prompt tail) and effort routing (clamp an
     *  already-sent effort field down on mechanical continuation turns). Resolved
     *  through this same three-level cascade; sub-fields are validated by the
     *  kernel's resolveOutputSteeringConfig at resolution time (an out-of-range value
     *  falls back to its default with a warning rather than rejecting the whole block).
     *  Off unless enabled at some level. See src/output-steering.ts. */
    outputSteering?: Partial<OutputSteeringConfig>;
    /** [#1279] Price profile for the session cache-economics report
     *  (`acp_cache` / `/acp-cache` / `GET /__bili/cache-report`). Normalized
     *  multipliers over the input-token unit (p_in = 1): `w` = cacheWrite/input,
     *  `r` = cacheRead/input, `q` = output/input — e.g. Anthropic ≈ {w:1, r:0.1,
     *  q:4}, DeepSeek-V3 ≈ {w:1, r:0.1, q:1.5}. Drives ONLY the per-fold
     *  one-time-cost / breakeven-turns / paid-back verdicts in the report — it
     *  never affects compression triggers, cadence, or any wire behavior. Each
     *  unset field falls back to the kernel default (w=1, r=0.1, q=4); a fully
     *  unset profile yields byte-identical reports to pre-#1279 behavior. The
     *  last request's effective value is stamped onto the session and used by
     *  every report face. Merged sub-field-wise across the three levels like
     *  `absorb`. [#2478] Also accepts optional ABSOLUTE $/Mtok fields
     *  (`inputPerMtok` / `outputPerMtok` / `cacheReadPerMtok` /
     *  `cacheWritePerMtok`): when any is present the profile resolves as
     *  absolute prices instead of ratios, with the same kernel-convention
     *  fill-ins as models.dev rows (`w = cacheWrite ?? input`,
     *  `r = cacheRead ?? 0.1 × w`, `q = output ?? 4 × w`) — absolute mode wins
     *  over `w`/`r`/`q`, and requires a positive `inputPerMtok` (anything else
     *  falls back to ratio mode with a one-time warning). */
    priceProfile?: { w?: number; r?: number; q?: number; inputPerMtok?: number; outputPerMtok?: number; cacheReadPerMtok?: number; cacheWritePerMtok?: number };
    /** [#1921] Fold-state reconciliation — how the proxy reacts when the
     *  resent history no longer contains a folded message's content-hash id
     *  (client restart/resume re-serialized the history, formatting churn on
     *  tool results, duplicate-cluster shift after a deletion; see
     *  src/fold-reconcile.ts). `"repair"` (default) matches each missing
     *  covered id against an inbound candidate via its protocol-stable
     *  toolCallId or its normalized identity (NFC + whitespace-collapsed text
     *  equality at the same duplicate ordinal inside the aligned churn
     *  region) and rewrites the fold blocks' covered ids, so the fold
     *  survives byte churn. `"warn"` computes and logs the matches but never
     *  rewrites. `"off"` disables the layer entirely (pre-#1921 behavior).
     *  Env `BILI_FOLD_RECONCILE` (off|warn|repair) overrides every level.
     *  Real edits never match (normalized text differs) and honestly
     *  re-enter the wire unfolded, exactly as before. */
    reconcile?: "off" | "warn" | "repair";
};
type PromptCacheRouting = "auto" | "enabled" | "disabled";
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
    { match: /^gemini-3/i, limit: 1_048_576 },
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

// Relay/vLLM deployments serve models under "prefix/name" ids that miss
// every ^-anchored pattern ("meta-llama/Llama-4" vs /^llama-/i, #736). The
// bare basename is the PRIMARY family signal: a family rule describes the
// MODEL, and testing the full id first lets the provider segment hijack the
// match ("Kimi/glm-5" → ^kimi 200K instead of ^glm-5 1M; "deepseek/
// deepseek-r1" skips the specific ^deepseek-(r1|v3|ocr) rule because of the
// "/" and falls to broad ^deepseek 1M — #2074). The full id remains the
// FALLBACK for tails carrying no family signal whose provider segment does
// ("qwen/qwq-32b").
function modelRoots(model: string): string[] {
    const slash = model.lastIndexOf("/");
    if (slash > 0 && slash < model.length - 1) return [model.slice(slash + 1), model];
    return [model];
}

export function lookupContextLimit(model: string | undefined): number | undefined {
    if (!model) return undefined;
    for (const root of modelRoots(model)) {
        for (const entry of CONTEXT_LIMIT_TABLE) {
            if (entry.match.test(root)) return entry.limit;
        }
    }
    return undefined;
}

// #1321: model families where ONE id serves multiple context tiers and the
// larger tier requires explicit per-request negotiation — Anthropic's
// context-Nm beta header or an [Nm]-suffixed model name. models.dev
// advertises the MAX tier, but a plain plan serves the standard window until
// that negotiation happens; budgeting against the advertised max pushes every
// percentage threshold beyond the client's own wall (#1310 item 2 → #1321).
// The proxy caps registry-derived windows at the built-in standard window for
// these families when no tier evidence is present. Every other family keeps
// fresher-source-wins (#344/#852): a stale-low table entry must never pin a
// grown registry window.
const TIER_GATED_FAMILIES: Array<{ match: RegExp }> = [
    { match: /^claude-/i },
];

export function tierGatedStandardWindow(model: string | undefined): number | undefined {
    if (!model) return undefined;
    for (const root of modelRoots(model)) {
        if (!TIER_GATED_FAMILIES.some((fam) => fam.match.test(root))) continue;
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

/** #2317: the matched providers key itself (longest-URL-prefix, same rule as
 *  findRoute) — or undefined when no key matches. Diagnostics need the KEY a
 *  request resolved against (or proof of a route-miss), which findRoute's
 *  route-object return cannot express. A key matches if upstreamUrl === key OR
 *  upstreamUrl starts with key + "/" (boundary-safe: "https://x.com" does not
 *  match "https://x.com.evil"); longest (most specific) key wins. */
export function findRouteKey(routes: ProviderRoutes, upstreamUrl: string | undefined): string | undefined {
    if (!upstreamUrl) return undefined;
    let bestKey = "";
    for (const key of Object.keys(routes)) {
        if (upstreamUrl === key || upstreamUrl.startsWith(key + "/")) {
            if (key.length > bestKey.length) bestKey = key;
        }
    }
    return bestKey || undefined;
}

/** Longest-URL-prefix match over the providers map. Returns the most specific
 *  ProviderRoute whose key is a prefix of `upstreamUrl`, or undefined. Shared by
 *  context-limit / compress-protocol / compress-settings resolution. */
export function findRoute(routes: ProviderRoutes, upstreamUrl: string | undefined): ProviderRoute | undefined {
    const key = findRouteKey(routes, upstreamUrl);
    return key ? routes[key] : undefined;
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

/** #1909: the user-declared wire protocol for this destination — scans ALL
 *  matching keys longest-prefix-first and returns the deepest key that
 *  explicitly declares `protocol`. Unlike findRoute (single longest entry,
 *  every field from it), this one field resolves through the prefix hierarchy:
 *  a host-level declaration inherits down onto path-scoped keys that stay
 *  silent, and a path-scoped declaration needs no duplication of the host
 *  entry to take effect. The other fields keep findRoute's single-entry
 *  semantics — a protocol-only path key still wins for them under its subtree.
 *  undefined = no
 *  declaration anywhere → callers fall back to the built-in path-suffix
 *  inference. The query string is ignored (same as the built-in table). */
export function resolveDeclaredProtocol(routes: ProviderRoutes, url: string | undefined): WireProtocol | undefined {
    if (!url) return undefined;
    const path = url.split("?", 2)[0];
    let best: WireProtocol | undefined;
    let bestLen = -1;
    for (const key of Object.keys(routes)) {
        if (routes[key].protocol === undefined) continue;
        if (path === key || path.startsWith(key + "/")) {
            if (key.length > bestLen) { bestLen = key.length; best = routes[key].protocol; }
        }
    }
    return best;
}

export type ProxyOptions = {
    port: number;
    host: string;
    upstream: string;
    /** #4571: set by the inline lane at boot (startInlineEngine) — true when
     *  these options belong to the in-process engine instead of a spawned
     *  proxy server. Display-only downstream (the status panel appends
     *  " · inline"), never read for control flow. */
    inlineLane?: boolean;
    routes: ProviderRoutes;
    /** Named dialing recipes from the providers table (pi/opencode idiom) —
     *  referenced by `compress.externalSummary.targets` ("glm/glm-4.9-flash").
     *  Populated by loadOptions; optional so inline test fixtures (which
     *  never reference chains) stay terse. Refreshed together with `routes`
     *  on web Apply. */
    namedProviders?: Record<string, NamedProviderRecipe>;
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
     *  byte-for-byte transparent. `dropFields` (#1757): dot-separated
     *  plain-object key paths of client-fixed fields to strip before forward
     *  for strict-schema gateways that 400 on unknown fields; per-provider
     *  lists union onto it additively. Empty = byte-for-byte transparent. */
    compat?: { roles: Record<string, string>; dropFields?: string[] };
    /** #1455: how upstream stream failures are presented to the client on the
     *  anthropic/openai wire — "protocol" (default) = protocol-native error
     *  frames; "completion" = legacy synthesized-completion shape for hosts
     *  whose SDK cannot surface in-band errors. Env BILI_STREAM_ERROR_SHAPE
     *  wins over the file's compat.streamErrorShape. */
    streamErrorShape?: "protocol" | "completion";
    /** Global-level image billing mode (#767); per-provider route entries
     *  override it, env BILI_IMAGE_BILLING overrides both. undefined = auto
     *  (= pixels for every host since #1843). */
    imageBilling?: ImageBillingMode;
    /** #1843 L3: global per-image token ceiling; per-provider route entries
     *  override it, env BILI_IMAGE_TOKEN_CAP overrides both. Positive integer;
     *  undefined/unset = no cap. */
    imageTokenCap?: number;
    sessionHeader: string;
    log: boolean;
    debug: boolean;
    dumpSse?: string;
    passthrough: boolean;
    /** Where `passthrough` came from: "env" (ACP_PASSTHROUGH or --passthrough
     *  flag), "file" (config `passthrough: true`), or null (default off).
     *  Drives the #405 boot warning and the web panel's source display. */
    passthroughSource?: "env" | "file" | null;
    autoUpdate: boolean;
    /** Opt-in self-restart when a newer version is already installed on disk
     *  (#811): re-exec at zero in-flight requests. Default OFF. */
    autoRestartOnUpdate?: boolean;
    /** Dist-tag channel the auto-updater follows (default "latest"). */
    updateTag?: string;
    /** Critical-defect advisory watcher (#1481): runs INDEPENDENTLY of
     *  autoUpdate and force-installs the owner-recommended version when the
     *  local version falls inside an affected range. Default ON. */
    advisoryCheck?: boolean;
    /** Tiered release-notes visibility (#1870): fetch + cache only — never
     *  installs, never restarts. Default ON. */
    releaseNotesCheck?: boolean;
    /** Override for the advisory document URL (env BILI_ADVISORY_URL wins). */
    advisoryUrl?: string;
    /** Override for the release-notes document URL (env
     *  BILI_RELEASE_NOTES_URL wins) (#1870). */
    releaseNotesUrl?: string;
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
    /** Opt-in fork block-adoption (#629, default off). ANONYMOUS clients
     *  (prefix-affinity) that fork their history inherit the parent's
     *  fully-present compression blocks instead of restarting at zero.
     *  Identified resume-forks are NOT governed by this switch — they adopt
     *  blocks with resumeInheritance (#1834, default on).
     *  Enable with `forkAdoption: true` or env BILI_FORK_ADOPTION=1. */
    forkAdoption?: boolean;
    /** Simhash chain-alignment adoption (#2265, default ON). A client-side
     *  pervasive decorative rewrite (Trae re-stamps model tags on every
     *  assistant message after a model switch) breaks the exact hash chain;
     *  without this rung every request mints a fresh pfa-* session and
     *  re-folds the full history from zero. Chain-level similarity
     *  re-attaches the existing session and its compression state; the next
     *  request resolves by the exact fast path again.
     *  Disable with `affinitySimhash: false` or env BILI_AFFINITY_SIMHASH=0. */
    affinitySimhash?: boolean;
    /** Resume-fork inheritance (#1486, default ON). Identified clients that
     *  resume a conversation under a NEW client-provided session id (Claude
     *  Code --resume forks a fresh UUID while replaying the full transcript)
     *  would otherwise start at zero compression state and renumber refs from
     *  m00001, so the model's stale citations mis-hit renumbered messages.
     *  The proxy detects the resume by byte-exact full-history match against
     *  tracked chains and inherits the parent's ref assignments, its
     *  fully-present compression blocks (#1834: adopted together with this
     *  inheritance — losing them on resume meant the folded originals came
     *  back on the wire), and the derivedFrom lineage. Disable with
     *  `resumeInheritance: false` or env BILI_RESUME_INHERITANCE=0. */
    resumeInheritance?: boolean;
    /** Body-content detection of the bili→bili chain awareness: when an inbound
     *  request carries ACP artifacts / a `<bili-chain …/>` checkpoint in the
     *  BODY but no x-bili-hop header, record an advisory observation and/or apply
     *  first-processor-wins passthrough (#1086/#1421). OFF by default (#1683
     *  follow-up): scanning the body can false-positive on CCR/file-introduced
     *  text and model-echoed tags, so by default ONLY the x-bili-hop header drives
     *  chain recognition. Re-enable via env BILI_CHAIN_CONTENT=1 or
     *  `chainContentDetection: true` in the config file (env wins). The
     *  x-bili-hop signal is unaffected by this switch. */
    chainContentDetection?: boolean;
    /** Egress emission of the model-visible `<bili-chain …/>` checkpoint
     *  carrier (#1683): when set, every request THIS instance processes leaves
     *  with a digest-bearing stamp so a downstream bili applies first-processor-
     *  wins even if x-bili-hop was stripped in transit (#1421). The carrier
     *  lands in a slot the terminal MODEL also reads (trailing user message on
     *  openai/responses; trailing text part on anthropic/google), so models
     *  treat it as phantom user input and burn tokens commenting on it — hence
     *  OFF by default. Enable it for the narrow multi-bili + hop-header-
     *  stripped-middlebox case via env BILI_CHAIN_STAMP=1 or
     *  `chainEgressStamp: true` in the config file (env wins). Independent of
     *  chainContentDetection (inbound body-detection is also default OFF); the
     *  x-bili-hop passthrough is unaffected either way. */
    chainEgressStamp?: boolean;
    /** #1085: freeze the client's head-system text into a per-session sticky
     *  anchor and append detected changes to the conversation as trailing
     *  notes, keeping the forwarded prefix byte-stable for the provider's
     *  prefix cache when instruction files (AGENTS.md & co.) change mid-
     *  session. Default OFF; enable with env BILI_STABLE_SYSTEM_ANCHOR=1 or
     *  `stableSystemAnchor: true` in the config file (env wins). */
     stableSystemAnchor?: boolean;
 };

/** #2028/#3651/#3723: dsh client-lane settings namespace. The former
 *  `allowDshCompaction` escape hatch was REMOVED (#3651) — dsh native
 *  compaction is now refused unconditionally by the #1729 wire guard on every
 *  lane, and a landed checkpoint durably shadows the raw history
 *  (irreversible), so no opt-in remains. The one live key is
 *  `authoredCompaction` (#3723/#3901). Leftover removed keys still sit in old
 *  files: the section stays RECOGNIZED so they don't trip the unknown-key
 *  warning, and each is ignored with a once-per-process deprecation note
 *  (warnRemovedDshAllowKey). */
interface DshFileSettings {
    /** #3723/#3901: bili-authored compaction answers (ON by default since
     *  the 0.1.203 dogfood window; `false` or env `BILI_DSH_AUTHORED_COMPACTION=0`
     *  restores the #1729 refusal path). */
    authoredCompaction?: boolean;
    /** #4237: register the per-session Context tab (conversation.view slot)
     *  in the official dsh client. ON by default (= today's behavior);
     *  `false` (or env `BILI_DSH_CONTEXT_TAB=0`) hides the tab. Hiding only
     *  removes the top-bar entry — compression is untouched, and the ledger
     *  stays reachable through the settings section, the plugin bundle config
     *  face, the Web UI and /acp. Resolved per page load by the host half and
     *  shipped to the browser half through the __BILI__ snapshot /
     *  /bili/origin route. */
    contextTab?: boolean;
    /** #4237: custom label for that tab (display preference, file-only per
     *  #2030 — no env tier). Trimmed non-empty string wins over the built-in
     *  localized "上下文"/"Context"; empty/absent/non-string keeps it. The
     *  rename exists for machines where another plugin occupies the same name
     *  (dsh-context ships its own "上下文"). */
    contextTabLabel?: string;
}

/** The routing fields a provider entry can carry — exactly what
 *  {@link parseRouteEntry} consumes per route. When they sit on a non-URL key
 *  WITHOUT `bind` they are inert (longest-prefix matching never hits a name),
 *  so loadRoutes warns loudly instead of letting them sit dead (#1469). */
const NAMED_PROVIDER_ROUTING_FIELDS = ["compress", "models", "proxy", "passthrough", "compressProtocol", "protocol", "compat", "imageBilling", "imageTokenCap"] as const;

// Once-per-signature dedup so hot-reload / repeated launcher loads don't spam
// the same named-provider warning (same pattern as the absorb warnings below).
const seenNamedProviderWarnings = new Set<string>();

function warnNamedProviderOnce(signature: string, message: string): void {
    if (seenNamedProviderWarnings.has(signature)) return;
    seenNamedProviderWarnings.add(signature);
    loggerLog("warn", `[acp-config] ${message}`);
}

function warnInertRoutingFields(key: string, obj: Record<string, unknown> | null): void {
    if (!obj) return;
    // A dialing recipe (baseUrl/api/...) re-scopes "models": on a recipe entry
    // it is the model REGISTRY the summary chain references, not routing — so
    // only warn for fields that are genuinely dead routing config there.
    const recipe = obj.baseUrl !== undefined || obj.api !== undefined;
    const inert = NAMED_PROVIDER_ROUTING_FIELDS.filter((f) => f in obj && obj[f] !== undefined && !(recipe && f === "models"));
    if (inert.length === 0) return;
    warnNamedProviderOnce(
        `inert:${key}:${inert.join(",")}`,
        `providers."${key}" carries routing fields without "bind" [${inert.join(", ")}] — they are inert (add "bind": "<upstream base URL>" to apply them, or move them under the URL entry)`,
    );
}

export function _resetNamedProviderWarningsForTest(): void {
    seenNamedProviderWarnings.clear();
}

/** #3632: does a resolved route carry any routing field the request path
 *  consumes? Bare marker entries (`{}` values) earn no inert-lane warnings —
 *  there is nothing for them to apply. */
function routeCarriesFields(route: ProviderRoute | undefined): boolean {
    if (!route) return false;
    return Object.values(route).some((v) => v !== undefined);
}

/** #3632: does an already-configured `mitm://` key cover the same traffic as
 *  the https:// URL `target`? A pathless mitm://<host> lane covers every path
 *  on that host; a path-scoped one covers only its own prefix — mirroring
 *  findRouteKey's exact-or-`startsWith(key + "/")` matching. */
function mitmTwinCovers(routes: ProviderRoutes, target: URL): boolean {
    for (const key of Object.keys(routes)) {
        if (!key.startsWith("mitm://")) continue;
        let twin: URL;
        try {
            twin = new URL(key);
        } catch {
            continue;
        }
        if (twin.host !== target.host) continue;
        const tp = twin.pathname;
        if (tp === "" || tp === "/") return true;
        const pp = target.pathname;
        if (pp === tp || pp.startsWith(tp + "/")) return true;
    }
    return false;
}

/** #3632: on the CONNECT/MITM lane every lookup runs against a rewritten
 *  `mitm://<host>` URL (src/server.ts resolveUpstream), so a plain `https://`
 *  providers key can NEVER match MITM-lane traffic to its host. The scheme
 *  split is intentional (CONFIGURATION.md: one host can serve a login client
 *  over CONNECT and an API-key client over /bili/ with different settings),
 *  but a lone https:// entry on a MITM-whitelisted host sat silently inert
 *  until a per-request [window] fallback line much later — a 1M window
 *  degrading to the 2e5 default, emergency folds, ECONNRESET. Warn once per
 *  key at config load, same family as warnInertRoutingFields.
 *
 *  Whitelist scope: DEFAULT_MITM_DOMAINS ∪ explicit mitm.domains /
 *  BILI_MITM_DOMAINS. Auto-discovered hosts (discoverMitmDomains) are
 *  deliberately NOT checked here — keeping config load free of client-config
 *  file IO — and stay covered by the runtime [route] miss warning (#2317),
 *  which carries the same scheme-mismatch hint. */
function warnInertMitmLaneKeys(routes: ProviderRoutes, env: NodeJS.ProcessEnv): void {
    const fileConfig = loadConfigFile();
    const mitmEnabled = (env.BILI_MITM ?? (fileConfig.mitm?.enabled === false ? "0" : "1")) !== "0";
    if (!mitmEnabled) return;
    const whitelist = [...DEFAULT_MITM_DOMAINS, ...resolveMitmDomains(env)];
    for (const key of Object.keys(routes)) {
        let u: URL;
        try {
            u = new URL(key);
        } catch {
            continue;
        }
        // http:// keys are never warned: MITM terminates TLS only, so a plain
        // HTTP upstream has no MITM-lane traffic at all.
        if (u.protocol !== "https:") continue;
        if (!matchesAnyMitmDomain(u.hostname, whitelist)) continue;
        if (!routeCarriesFields(routes[key])) continue;
        if (mitmTwinCovers(routes, u)) continue;
        const twin = "mitm://" + key.slice("https://".length);
        warnNamedProviderOnce(
            `mitm-inert:${key}`,
            `providers."${key}" is inert for MITM-lane traffic to ${u.host} — CONNECT traffic looks up "${twin}", which has no entry, so these settings never apply to proxy-routed clients. Add a "${twin}" entry to cover them (the https:// entry still serves /bili/-embedded requests).`,
        );
    }
}

/** #3675: compress-block keys written on the ROUTE ROOT (URL lane or named
 *  entry) are silently dropped by parseRouteEntry — the same silent-inert
 *  class as the #1469 routing fields, one level down. Recognition is
 *  COMPRESS_SETTING_FIELDS (defined below; kept in sync with
 *  parseCompressSettings): every member is inert at a route root, and none of
 *  them may be added to parseRouteEntry's whitelist while this warning exists.
 *  Dialing recipes are skipped — their own parser rejects unknown root fields
 *  loudly (parseNamedProviderRecipe throws → chain disabled with a warning),
 *  so a second signal here would only add noise. */
function warnCompressOnlyFieldsAtRouteRoot(key: string, obj: Record<string, unknown> | null): void {
    if (!obj) return;
    if (obj.baseUrl !== undefined || obj.api !== undefined) return;
    const misplaced = Object.keys(obj).filter((f) => obj[f] !== undefined && COMPRESS_SETTING_FIELDS.has(f));
    if (misplaced.length === 0) return;
    warnNamedProviderOnce(
        `route-root-compress:${key}:${misplaced.join(",")}`,
        `providers."${key}" carries compress-block keys [${misplaced.join(", ")}] at the route root — they are inert there (move them under providers."${key}".compress to apply)`,
    );
}

/** True when the providers-map key is itself a URL lane (http/https/mitm
 *  scheme — mitm:// is the README-documented lookup key for MITM traffic).
 *  Anything else is a NAMED key (provider id): routing-inert on its own,
 *  meaningful via `compactionOptIn` (#1392) and/or `bind` (#1469). */
function isUrlLikeKey(key: string): boolean {
    return /^(https?|mitm):\/\//i.test(key.trim());
}

/** Normalize a `bind` value to its route-table key. Only http(s) base URLs
 *  are valid targets — the bound lane must be reachable by the request path's
 *  URL-prefix matching. Returns undefined for anything else. */
function normalizeBindTarget(raw: string): string | undefined {
    try {
        const u = new URL(raw.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
        return normalizeUrlKey(u.href);
    } catch {
        return undefined;
    }
}

function cloneJsonValue(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(cloneJsonValue);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneJsonValue(v);
    return out;
}

/** Deep-merge two route shapes where `winner` beats `filler` field-by-field:
 *  when both sides hold a plain object under one key the merge recurses into
 *  it; every other case (scalar vs scalar, array vs anything, object vs
 *  scalar) takes the winner's value wholesale — arrays are never element-
 *  merged. The result is a fresh copy; inputs are never shared or mutated.
 *  Used by loadRoutes to fold a named provider's `bind` alias into its URL
 *  lane (#1469). */
function fillRouteGaps(winner: unknown, filler: unknown): unknown {
    const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    const fillerObj = isObj(filler) ? filler : null;
    if (!fillerObj) return cloneJsonValue(winner);
    const winnerObj = isObj(winner) ? winner : null;
    if (!winnerObj) return cloneJsonValue(filler);
    const out: Record<string, unknown> = {};
    for (const [k, fv] of Object.entries(fillerObj)) out[k] = cloneJsonValue(fv);
    for (const [k, wv] of Object.entries(winnerObj)) {
        const fv = k in out ? out[k] : undefined;
        out[k] = isObj(wv) && isObj(fv) ? fillRouteGaps(wv, fv) : cloneJsonValue(wv);
    }
    return out;
}

/** Re-read ONLY the routes from the current config sources, returning a fresh
 *  ProviderRoutes object. Used by the web UI's "Apply" (hot-reload) button so
 *  provider/route changes take effect without restarting bili. Only routes are
 *  re-read — port/host/upstream can't change on a running server (the listen
 *  socket is already bound), so those stay as they were at startup. Mirrors the
 *  exact precedence of loadOptions: external ACP_PROVIDERS path > inline
 *  providers in the config file.
 *
 *  Named provider entries (#1469): a non-URL key carrying `bind` is a pure
 *  ALIAS for the bound URL lane — resolved HERE at config-load time only, so
 *  the request path keeps its single URL-prefix routing and names never appear
 *  on the wire. Precedence per field: an explicit URL-key entry beats any
 *  alias field; between sources the external ACP_PROVIDERS file beats inline
 *  config at every level (aliases fold in source order, first-set wins). A
 *  name key WITHOUT `bind` stays routing-inert (agent-side identity such as
 *  `compactionOptIn` only); if it nevertheless carries routing fields, a
 *  startup warning names the key and the inert fields instead of failing
 *  silently. */
/** Per-model knobs a named recipe exposes to referencing chains. These are
 *  the same fields an inline external-summary target carried; defaults come
 *  from the chain expansion, not from here. */
interface NamedProviderModel {
    contextWindow?: number;
    outputTokens?: number;
    stream?: boolean;
}

/** Dialing recipe on a NAMED providers-table key (pi/opencode idiom): the
 *  name maps to {baseUrl, api, credential, models}. Routing-inert by itself
 *  — same as every named entry without `bind` — and referenced by
 *  `compress.externalSummary.targets` ("glm/glm-4.9-flash"). Credentials are
 *  references only (env var name or secret-store name); a plaintext key in
 *  the config file is rejected by the unknown-key check, keeping the file
 *  non-secret (web GET echoes it verbatim). */
export interface NamedProviderRecipe {
    baseUrl: string;
    api: "anthropic" | "openai" | "responses" | "google";
    apiKeyEnv?: string;
    credentialRef?: string;
    models: Record<string, NamedProviderModel>;
}

const NAMED_PROVIDER_RECIPE_FIELDS = ["baseUrl", "api", "apiKeyEnv", "credentialRef", "models"] as const;

/** Parse one named-entry recipe. THROWS on an invalid shape — the web save
 *  path surfaces it as a 400; loadNamedProviders catches and warns instead
 *  (a broken recipe disables its chain references loudly, never the proxy). */
export function parseNamedProviderRecipe(value: unknown): NamedProviderRecipe {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("a named provider recipe must be an object");
    const obj = value as Record<string, unknown>;
    const unknownKeys = Object.keys(obj).filter((key) => ![...NAMED_PROVIDER_RECIPE_FIELDS, "bind", "compactionOptIn"].includes(key));
    if (unknownKeys.length > 0) throw new Error(`unknown recipe fields on named provider entry [${unknownKeys.join(", ")}] — routing fields need "bind"; credentials must use apiKeyEnv/credentialRef`);
    if (typeof obj.baseUrl !== "string" || !obj.baseUrl.trim() || obj.baseUrl.length > 2048) throw new Error("recipe baseUrl must be a non-empty string");
    if (obj.api !== "anthropic" && obj.api !== "openai" && obj.api !== "responses" && obj.api !== "google") throw new Error(`recipe api must be one of: anthropic, openai, responses, google (got ${JSON.stringify(obj.api)})`);
    if (obj.apiKeyEnv !== undefined && (typeof obj.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(obj.apiKeyEnv))) throw new Error("recipe apiKeyEnv must be an environment variable name");
    if (obj.credentialRef !== undefined && (typeof obj.credentialRef !== "string" || !validSummaryCredentialName(obj.credentialRef))) throw new Error("recipe credentialRef must be a secret-store credential name");
    if (obj.apiKeyEnv !== undefined && obj.credentialRef !== undefined) throw new Error("recipe carries both apiKeyEnv and credentialRef — pick one");
    if (obj.apiKeyEnv === undefined && obj.credentialRef === undefined) throw new Error("recipe needs a credential reference (apiKeyEnv or credentialRef)");
    if (!obj.models || typeof obj.models !== "object" || Array.isArray(obj.models) || Object.keys(obj.models).length === 0) throw new Error("recipe models must be a non-empty object of model entries");
    const models: Record<string, NamedProviderModel> = {};
    for (const [id, raw] of Object.entries(obj.models)) {
        const knobs = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
        const unknown = Object.keys(knobs).filter((key) => !["contextWindow", "outputTokens", "stream"].includes(key));
        if (unknown.length > 0) throw new Error(`unknown fields on recipe model "${id}" [${unknown.join(", ")}]`);
        if (knobs.contextWindow !== undefined && (typeof knobs.contextWindow !== "number" || !Number.isSafeInteger(knobs.contextWindow) || knobs.contextWindow < 2048 || knobs.contextWindow > 10_000_000)) throw new Error(`recipe model "${id}" contextWindow must be an integer in [2048, 10000000]`);
        if (knobs.outputTokens !== undefined && (typeof knobs.outputTokens !== "number" || !Number.isSafeInteger(knobs.outputTokens) || knobs.outputTokens < 128)) throw new Error(`recipe model "${id}" outputTokens must be an integer >= 128`);
        if (knobs.stream !== undefined && typeof knobs.stream !== "boolean") throw new Error(`recipe model "${id}" stream must be a boolean`);
        models[id] = { ...(knobs.contextWindow !== undefined ? { contextWindow: knobs.contextWindow } : {}), ...(knobs.outputTokens !== undefined ? { outputTokens: knobs.outputTokens } : {}), ...(knobs.stream !== undefined ? { stream: knobs.stream } : {}) };
    }
    return { baseUrl: obj.baseUrl.trim().replace(/\/+$/, ""), api: obj.api, ...(obj.apiKeyEnv !== undefined ? { apiKeyEnv: obj.apiKeyEnv } : {}), ...(obj.credentialRef !== undefined ? { credentialRef: obj.credentialRef } : {}), models };
}

/** True when the entry carries recipe fields (used to re-scope the inert
 *  warning: on a recipe entry `models` is a registry, not routing). */
function isNamedProviderRecipeShape(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    return obj.baseUrl !== undefined || obj.api !== undefined;
}

export function collectNamedProviders(providers: Record<string, unknown>): Record<string, NamedProviderRecipe> {
    const out: Record<string, NamedProviderRecipe> = {};
    for (const [key, value] of Object.entries(providers)) {
        if (isUrlLikeKey(key) || value === null || typeof value !== "object" || Array.isArray(value)) continue;
        if (!isNamedProviderRecipeShape(value)) continue;
        if (!validSummaryCredentialName(key)) {
            warnNamedProviderOnce(`recipe-name:${key}`, `providers."${key}" is not a valid recipe name ([A-Za-z0-9][A-Za-z0-9_-]{0,63}) — the entry is ignored`);
            continue;
        }
        try {
            out[key] = parseNamedProviderRecipe(value);
        } catch (error) {
            warnNamedProviderOnce(`recipe:${key}`, `providers."${key}" has an invalid recipe (${error instanceof Error ? error.message : String(error)}) — chains referencing it are disabled`);
        }
    }
    return out;
}

/** Named dialing recipes from the same sources `loadRoutes` reads (external
 *  ACP_PROVIDERS file entries replace inline ones wholesale). Re-read per
 *  call like every other config-file consumer; the server snapshots it next
 *  to routes and refreshes both on web Apply. */
export function loadNamedProviders(env: NodeJS.ProcessEnv = process.env): Record<string, NamedProviderRecipe> {
    const fileConfig = loadConfigFile();
    const out: Record<string, NamedProviderRecipe> = {};
    const routesPath = env.ACP_PROVIDERS ?? fileConfig.providersPath ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(out, collectNamedProviders(parsed as Record<string, unknown>));
    }
    if (fileConfig.providers) {
        const inline = collectNamedProviders(fileConfig.providers as unknown as Record<string, unknown>);
        for (const [name, recipe] of Object.entries(inline)) if (out[name] === undefined) out[name] = recipe;
    }
    return out;
}

export function loadRoutes(env: NodeJS.ProcessEnv = process.env): ProviderRoutes {
    const fileConfig = loadConfigFile();
    const routes: ProviderRoutes = {};
    const aliases: Array<{ target: string; route: ProviderRoute }> = [];
    // urlWins=true for the external ACP_PROVIDERS source (its entries replace
    // inline ones wholesale, as before); false for inline fileConfig.providers
    // (fills gaps only). Named entries with a valid `bind` never register under
    // their own key — they are collected and folded onto their target lane
    // AFTER both sources' URL keys are in place, so an explicit URL key always
    // outranks alias fields regardless of which file either came from.
    const ingest = (key: string, value: unknown, urlWins: boolean): void => {
        rejectLegacyRoute(key, value);
        const route = parseRouteEntry(value);
        if (!route) return;
        const obj = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
        const urlLike = isUrlLikeKey(key);
        // Before the bind branch on purpose: these keys are inert even on a
        // validly bound alias — parseRouteEntry never parses them, so the
        // fold onto the target lane cannot carry them.
        warnCompressOnlyFieldsAtRouteRoot(key, obj);
        if (obj && "bind" in obj) {
            const bind = obj.bind;
            if (typeof bind !== "string") {
                warnNamedProviderOnce(`bad-bind:${key}`, `providers."${key}".bind must be a string http(s) base URL — the entry stays routing-inert`);
            } else if (urlLike) {
                warnNamedProviderOnce(`bind-on-url:${key}`, `providers."${key}" has "bind" — ignored: URL keys are already lanes (remove "bind", or rename the key to make it a named entry)`);
            } else if (bind.trim().length > 0) {
                const target = normalizeBindTarget(bind);
                if (target) { aliases.push({ target, route }); return; }
                warnNamedProviderOnce(`bad-bind:${key}`, `providers."${key}".bind is not a valid http(s) base URL ("${bind}") — the entry stays routing-inert`);
            }
        }
        if (!urlLike) warnInertRoutingFields(key, obj);
        const normKey = normalizeUrlKey(key);
        if (urlWins || !routes[normKey]) routes[normKey] = route;
    };
    const routesPath = env.ACP_PROVIDERS ?? fileConfig.providersPath ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) ingest(k, v, true);
        }
    }
    if (fileConfig.providers) {
        for (const [k, v] of Object.entries(fileConfig.providers)) ingest(k, v, false);
    }
    for (const { target, route } of aliases) {
        routes[target] = fillRouteGaps(routes[target], route) as ProviderRoute;
    }
    warnInertMitmLaneKeys(routes, env);
    return routes;
}

/** Resolved passthrough state shared by loadOptions and the web config API
 *  (single source of truth — the GET handler must not re-derive it). */
export function passthroughState(env: NodeJS.ProcessEnv): { enabled: boolean; source: "env" | "file" | null } {
    const filePassthrough = loadConfigFile().passthrough === true;
    if (env.ACP_PASSTHROUGH !== undefined) return { enabled: env.ACP_PASSTHROUGH === "1", source: "env" };
    return { enabled: filePassthrough, source: filePassthrough ? "file" : null };
}

// #1359: provider/model absorb.* overrides apply only to the proxy lane (plugin
// lane follows the base block). Warn once per load so the divergence isn't silent.
const ABSORB_DIVERGENCE_FIELDS = ["enabled", "toolName", "minToolTokens", "contextThresholdPct", "excludeTools", "mediaOnly"] as const;
const seenAbsorbDivergenceWarnings = new Set<string>();

function normAbsorbValue(field: string, v: unknown): unknown {
    if (field === "contextThresholdPct" && typeof v === "string") {
        const m = v.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
        if (m) return Number(m[1]) / 100;
    }
    return v;
}

export function findAbsorbPluginDivergences(routes: ProviderRoutes, baseAbsorb?: CompressSettings["absorb"]): string[] {
    const out: string[] = [];
    const check = (scope: string, level?: CompressSettings["absorb"]) => {
        if (!level) return;
        for (const field of ABSORB_DIVERGENCE_FIELDS) {
            if (level[field] === undefined) continue;
            if (JSON.stringify(normAbsorbValue(field, level[field])) !== JSON.stringify(normAbsorbValue(field, baseAbsorb?.[field]))) {
                out.push(`${scope}.absorb.${field}=${JSON.stringify(level[field])} (base=${JSON.stringify(baseAbsorb?.[field])})`);
            }
        }
    };
    for (const [url, route] of Object.entries(routes)) {
        check(url, route.compress?.absorb);
        for (const [model, entry] of Object.entries(route.models ?? {})) check(`${url}/${model}`, entry.compress?.absorb);
    }
    return out;
}

function warnAbsorbPluginDivergences(routes: ProviderRoutes, baseAbsorb?: CompressSettings["absorb"]): void {
    const divs = findAbsorbPluginDivergences(routes, baseAbsorb);
    if (divs.length === 0) return;
    const sig = divs.join("\u0000");
    if (seenAbsorbDivergenceWarnings.has(sig)) return;
    seenAbsorbDivergenceWarnings.add(sig);
    loggerLog("warn", `[acp-config] provider/model absorb override diverges from base [${divs.join("; ")}] — plugin-mode sessions follow the base value, proxy-mode sessions honor the override (#1359)`);
}


/** [#1345] A provider/model-level `ccr` field that diverges from what plugin
 *  sessions actually execute. In plugin mode the static manifest is the ONLY
 *  declaration of the retrieve surface, so the whole ccr block follows the base
 *  config; such overrides only take effect on proxy-mode sessions. */
interface CcrOverrideDivergence {
    /** Where the override lives, e.g. "provider https://api.x.com" or "provider https://api.x.com model gpt-4". */
    level: string;
    field: "enabled" | "toolName" | "minToolTokens" | "excludeTools" | "maxHeadChars";
    value: unknown;
    effective: unknown;
}

const CCR_FIELDS = ["enabled", "toolName", "minToolTokens", "excludeTools", "maxHeadChars"] as const;

/** Pure: list every provider/model ccr field that would be ignored in plugin
 *  sessions (base config governs there). Empty when base ccr is not enabled —
 *  no plugin session can arm then, so nothing diverges (#1273 keeps
 *  route-scoped-only enablement proxy-mode-only by design). */
export function findCcrPluginDivergences(routes: ProviderRoutes, globalCompress?: CompressSettings): CcrOverrideDivergence[] {
    const base = globalCompress?.ccr;
    if (base?.enabled !== true) return [];
    const out: CcrOverrideDivergence[] = [];
    const report = (level: string, ccr?: CompressSettings["ccr"]): void => {
        if (!ccr) return;
        for (const f of CCR_FIELDS) {
            if (!(f in ccr)) continue;
            const value = ccr[f];
            const effective = base[f] ?? DEFAULT_CCR_CONFIG[f];
            const differs = Array.isArray(value) && Array.isArray(effective)
                ? JSON.stringify(value) !== JSON.stringify(effective)
                : value !== effective;
            if (differs) out.push({ level, field: f, value, effective });
        }
    };
    for (const [url, route] of Object.entries(routes)) {
        report(`provider ${url}`, route.compress?.ccr);
        for (const [model, entry] of Object.entries(route.models ?? {})) {
            report(`provider ${url} model ${model}`, entry.compress?.ccr);
        }
    }
    return out;
}

function formatCcrValue(v: unknown): string {
    return typeof v === "string" ? `"${v}"` : JSON.stringify(v);
}

/** Log every #1345 divergence once per config load (called from loadOptions;
 *  hot-reload funnels through it too — see handleConfigReload). */
function warnCcrPluginDivergences(routes: ProviderRoutes, globalCompress?: CompressSettings): void {
    for (const dv of findCcrPluginDivergences(routes, globalCompress)) {
        loggerLog("warn", `[acp-config] ccr override ignored in plugin sessions: ${dv.level} ccr.${dv.field}=${formatCcrValue(dv.value)} — plugin sessions use ${formatCcrValue(dv.effective)} (base config governs the plugin manifest surface, #1345); proxy-mode sessions honor the override`);
    }

}

// #2578: MCP-lane hosts (Kimi Code, Claude Code, zcode) expose bili tools
// under mcp__bili__<name> — "bili" is the fixed shim server name (mcp.ts).
// The kernel's hard protection matches bare names only (ALWAYS_PROTECTED_TOOLS
// in kernel/src/protected.ts), so MCP-prefixed compress/acp_rule calls were
// foldable by T1/T2/T3 compression while their bare-name twins were not.
// Route the MCP forms through the kernel's host-side isToolProtected hook;
// identity is the strict mcp__bili__ prefix (same convention as
// session-self-heal's isBiliToolName), never a suffix match on arbitrary
// server names.
const MCP_BILI_TOOL_PREFIX = "mcp__bili__";
// Mirrors the kernel's ALWAYS_PROTECTED_TOOLS (compress, acp_rule) — the
// constant is not part of the kernel public API. Keep in lockstep with
// kernel/src/protected.ts.
const MCP_HARD_PROTECTED_BARE_NAMES = ["compress", "acp_rule"];

export function isMcpBiliHardProtected(toolName: string): boolean {
    return toolName.startsWith(MCP_BILI_TOOL_PREFIX) &&
        MCP_HARD_PROTECTED_BARE_NAMES.includes(toolName.slice(MCP_BILI_TOOL_PREFIX.length));
}

// Consumed-call lifecycle recognition for the kernel's hideConsumedCompressCalls
// (#2970): the canonical bare form plus the MCP dialect form only. Unlike
// isMcpBiliHardProtected this must NOT match acp_rule — it decides which tool
// calls count as `compress` for inactive cleanup + live-range arg reduction.
export function isMcpBiliCompress(toolName: string): boolean {
    return toolName === "compress" ||
        (toolName.startsWith(MCP_BILI_TOOL_PREFIX) &&
            toolName.slice(MCP_BILI_TOOL_PREFIX.length) === "compress");
}

export function loadOptions(env: NodeJS.ProcessEnv = process.env): ProxyOptions {
    // --- Source 1: JSON config file (~/.config/billion-context/billion-context.json) ---
    // The canonical, user-editable config. Loaded first so env vars below can
    // override it (env wins for environment-specific overrides).
    const fileConfig = loadConfigFile();

    // #3651: BILI_ALLOW_DSH_COMPACTION no longer exists — surface a stale value
    // once instead of silently ignoring it (§7.3 honest output).
    if (env.BILI_ALLOW_DSH_COMPACTION !== undefined && !removedDshEnvWarned) {
        removedDshEnvWarned = true;
        loggerLog("warn", "[acp-config] env BILI_ALLOW_DSH_COMPACTION was removed (#3651, superseding #2028) — ignored; dsh native compaction is now refused unconditionally by the wire guard");
    }

    // --- Source 2: env vars (highest priority) ---
    const port = parseInt(env.ACP_PORT ?? env.PORT ?? `${fileConfig.port ?? 8787}`, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid port ${Number.isNaN(port) ? "(not a number)" : port}; must be 1-65535`);
    }
    const rawHost = env.ACP_HOST ?? fileConfig.host ?? "127.0.0.1";
    const host = rawHost === "localhost" ? "127.0.0.1" : rawHost;
    const upstream = (env.ACP_UPSTREAM ?? fileConfig.upstream ?? "https://api.anthropic.com").replace(/\/$/, "");
    const routes = loadRoutes(env);
    const namedProviders = loadNamedProviders(env);
    warnAbsorbPluginDivergences(routes, fileConfig.compress?.absorb);
    warnCcrPluginDivergences(routes, fileConfig.compress);
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
    // #2809: unset mode resolves to direct too, but means "no preference" —
    // this flag (unlike explicitDirect) never gates egress; it only lets
    // failure diagnostics name the proxy the auto chain would have picked.
    const defaultDirect = rawProxyMode === undefined && !biliProxy;
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
        defaultDirect,
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
        // defaultDirect inherits via the spread above: whenever it is true,
        // this explicitDirect is false, so the model-path short-circuit (and
        // the #2809 diagnostic peek inside it) can never fire for aux.
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
        namedProviders,
        proxy,
        proxyMode,
        proxySource,
        proxyFallback,
        modelContextLimit,
        // #2578: host-side extension of the kernel's bare-name hard protection
        // to the MCP-prefixed forms of bili's own tools.
        kernelConfig: { ...defaultConfig(modelContextLimit), isToolProtected: isMcpBiliHardProtected, isCompressTool: isMcpBiliCompress },
        compress: {
            ...(fileConfig.compress ?? {}),
            injectTool: (env.ACP_COMPRESS_TOOL ?? (fileConfig.compress?.injectTool === false ? "0" : "1")) !== "0",
            injectNudge: (env.ACP_COMPRESS_NUDGE ?? (fileConfig.compress?.injectNudge === false ? "0" : "1")) !== "0",
        },
        promptCache: {
            routing: parsePromptCacheRouting(env.ACP_PROMPT_CACHE_ROUTING ?? fileConfig.promptCache?.routing),
        },
        compat: { roles: parseCompatRoles(fileConfig.compat?.roles) ?? {}, dropFields: parseCompatDropFields(fileConfig.compat?.dropFields) ?? [] },
        streamErrorShape: parseStreamErrorShape(env.BILI_STREAM_ERROR_SHAPE ?? fileConfig.compat?.streamErrorShape),
        imageBilling: parseImageBilling(fileConfig.imageBilling),
        imageTokenCap: parseImageTokenCap(fileConfig.imageTokenCap),
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
        // Default ON: unlike autoRestartOnUpdate, this never touches process
        // liveness — it only installs files and warns (#1481).
        advisoryCheck: (env.BILI_ADVISORY_CHECK ?? (fileConfig.advisoryCheck === false ? "0" : "1")) !== "0",
        // Default ON: same reasoning as advisoryCheck — pure visibility (fetch
        // + cache; never installs, never restarts) (#1870).
        releaseNotesCheck: (env.BILI_RELEASE_NOTES_CHECK ?? (fileConfig.releaseNotesCheck === false ? "0" : "1")) !== "0",
        advisoryUrl: env.BILI_ADVISORY_URL || fileConfig.advisoryUrl || undefined,
        releaseNotesUrl: env.BILI_RELEASE_NOTES_URL || fileConfig.releaseNotesUrl || undefined,
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
        forkAdoption: (env.BILI_FORK_ADOPTION ?? (fileConfig.forkAdoption === true ? "1" : "0")) !== "0",
        affinitySimhash: (env.BILI_AFFINITY_SIMHASH ?? (fileConfig.affinitySimhash === false ? "0" : "1")) !== "0",
        resumeInheritance: (env.BILI_RESUME_INHERITANCE ?? (fileConfig.resumeInheritance === false ? "0" : "1")) !== "0",
        chainContentDetection: (env.BILI_CHAIN_CONTENT ?? (fileConfig.chainContentDetection === true ? "1" : "0")) !== "0",
        chainEgressStamp: (env.BILI_CHAIN_STAMP ?? (fileConfig.chainEgressStamp === true ? "1" : "0")) !== "0",
        stableSystemAnchor: (env.BILI_STABLE_SYSTEM_ANCHOR ?? (fileConfig.stableSystemAnchor === true ? "1" : "0")) !== "0",
    };
}

/** The resolved mitm.domains tier exactly as loadOptions computes it (config
 *  file ∪ BILI_MITM_DOMAINS, deduped). Exported so launchers can mirror the
 *  precise whitelist their proxy child will use when deciding MITM vs blind
 *  tunnel (#1403) — pass the env the CHILD will see, not process.env. */
export function resolveMitmDomains(env: NodeJS.ProcessEnv): string[] {
    return dedupeDomains([
        ...(loadConfigFile().mitm?.domains ?? []),
        ...splitCsv(env.BILI_MITM_DOMAINS),
    ]);
}

/** The mitm tier exactly as a spawned proxy child RECORDS it in its instance
 *  file (server.ts writes [] when mitm is disabled, even with domains
 *  configured): loadOptions' BILI_MITM / file mitm.enabled gate applied on top
 *  of its file-first/env-second union, evaluated against the env the child will
 *  actually see. `passed` is the explicit list a launcher injects into the
 *  child's BILI_MITM_DOMAINS at spawn time (CLI lanes); undefined/empty means
 *  the child inherits the ambient value (native lanes). Attachers must want
 *  THIS value — neither the raw caller list nor the raw union converges:
 *  domainless native bootstraps never matched a configured owner's tier, CLI
 *  lists miss the config-file layer, and a disabled-mitm child records []
 *  (#3436/#3540/#3551). */
export function resolveRecordedMitmDomains(passed: readonly string[] | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
    const fileConfig = loadConfigFile();
    const enabled = (env.BILI_MITM ?? (fileConfig.mitm?.enabled === false ? "0" : "1")) !== "0";
    if (!enabled) return [];
    const effective = passed && passed.length > 0 ? passed.join(",") : env.BILI_MITM_DOMAINS;
    return dedupeDomains([
        ...(fileConfig.mitm?.domains ?? []),
        ...splitCsv(effective),
    ]);
}

/** #4850: passthrough-axis twin of resolveRecordedMitmDomains (#3436
 *  discipline) — an instance record carries the CONFIG-MERGED mode
 *  (`passthrough: true` in the config file flips a spawned child even when
 *  the launcher passed no --passthrough flag; an inherited ACP_PASSTHROUGH
 *  reaches the child the same way), while launcher callers pass a raw boolean
 *  flag (native lanes hardcode false). Attach-side shape checks must compare
 *  against what a spawned child would RECORD, not the raw caller input. */
export function resolveRecordedPassthrough(flag: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
    return flag || passthroughState(env).enabled;
}

/** #1392: opted-in non-http(s) baseUrl providers — providers-table entries
 *  (key = provider id) with `compactionOptIn: true` ∪
 *  BILI_NON_HTTP_PROVIDERS, deduped. Exported so launchers can mirror the list
 *  to the client env (BILI_NON_HTTP_PROVIDERS) exactly like resolveMitmDomains. */
export function resolveNonHttpProviders(env: NodeJS.ProcessEnv = process.env): string[] {
    const out = new Set<string>();
    // #1392: the opt-in lives in the existing providers table — the KEY is the
    // provider id (a non-URL key is inert for routing: longest-prefix matching
    // never hits it), and the entry's compactionOptIn===true opts it in. Only
    // meaningful for providers whose baseUrl is not http(s); widening the
    // candidate set is all it does — carriage evidence still decides.
    const providers = loadConfigFile().providers;
    if (providers && typeof providers === "object") {
        for (const [id, v] of Object.entries(providers)) {
            if (!v || typeof v !== "object" || Array.isArray(v)) continue;
            const key = id.trim();
            if (key.length > 0 && (v as Record<string, unknown>).compactionOptIn === true) out.add(key);
        }
    }
    for (const id of splitCsv(env.BILI_NON_HTTP_PROVIDERS)) {
        out.add(id);
    }
    return [...out];
}

/** `pi.subagents` section of the config file (#2230 config-home): the home
 *  for the built-in pi-lane acp_delegate surface. Fields map 1:1 onto the
 *  standalone package's DelegateConfig (billion-context-pi-subagents); the
 *  two renames vs the deprecated acp.json keys: `prompt` replaces
 *  `delegatePrompt`, and `debug` is scoped to the sub-agent subsystem (the
 *  top-level `debug` key stays the proxy's own). See CONFIGURATION.md. */
export interface PiSubagentsFileConfig {
    /** Master switch, default true. `false` (or the boolean shorthand
     *  `"pi": {"subagents": false}`) removes the three tools, the
     *  system-prompt section and the fleet shortcut (new session required). */
    enabled?: boolean;
    /** Keep acp_delegate active even when a project-scope pi-subagents
     *  install is detected (#415 stand-down). Default false. Env
     *  PI_ACP_DELEGATE_FORCE_ENABLE=true/false wins over the file. */
    forceEnable?: boolean;
    /** "separate" (default) — delegate tokens tracked in their own
     *  accumulator; "merged" — folded into the main session totals. */
    displayUsage?: "merged" | "separate";
    /** Max nesting depth (default 2: main → child → grandchild). Propagated
     *  to children via PI_ACP_DELEGATE_MAX_DEPTH; env wins over the file. */
    maxDepth?: number;
    /** Hard timeout for synchronous delegates, minutes (default 5);
     *  0/null disables. Env PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES wins. */
    syncTimeoutMinutes?: number | null;
    /** Idle watchdog for async delegates, minutes (default 5); 0/null
     *  disables (warns). Env PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES wins. */
    idleTimeoutMinutes?: number | null;
    /** Hard time limit for async delegates, minutes (default 30); 0/null
     *  disables. Env PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES wins. */
    asyncTimeoutMinutes?: number | null;
    /** Cap on concurrent background delegates (default unlimited); extras
     *  queue. Env PI_ACP_DELEGATE_MAX_CONCURRENT wins. */
    maxConcurrent?: number;
    /** Global default thinking level (off|minimal|low|medium|high|xhigh|max). */
    thinkingLevel?: string;
    /** Per-role defaults keyed by role (reviewer/researcher/worker/planner/
     *  oracle or custom): { model: "provider/id", thinkingLevel: "…" }. */
    agents?: Record<string, { model?: string; thinkingLevel?: string }>;
    /** "skip" (default) — suppress the completion notification when the
     *  model already read the result file; "always" — always inject. */
    notifyIfRead?: "skip" | "always";
    /** TUI shortcut for the fleet inspector (default "ctrl+alt+d"); ""
     *  disables keyboard registration (/acp-fleet still works). */
    fleetShortcut?: string;
    /** Replace (string) or remove (null) the ACP_DELEGATE NOTIFICATIONS
     *  system-prompt appendix. acp.json name: `delegatePrompt`. */
    prompt?: string | null;
    /** Debug-level events in the shared ACP log (~/.pi/acp.log), scoped to
     *  the sub-agent subsystem. */
    debug?: boolean;
}

/** File shape of one feature's `rollout.features.<name>` override (#3062).
 *  All fields optional; each overrides the corresponding field of the
 *  version's baked-in plan — `enabled` (boolean) overrides ANY percentage,
 *  `percent` (0–100) re-scales the cohort, `salt` re-randomizes it, `base`
 *  re-scopes the nesting. */
export interface RolloutFeatureOverride {
    enabled?: boolean;
    percent?: number;
    salt?: string;
    base?: string;
}

/** `rollout` config block (#3062): machine-wide rollout identity + per-feature
 *  overrides. See src/rollout.ts for the resolution contract. */
export interface RolloutFileConfig {
    /** Pins the bucketing identity (support/testing) instead of the persisted
     *  state-dir UUID. */
    installId?: string;
    /** Per-feature overrides; shorthand forms are accepted and equivalent:
     *  `"x": true/false` = {enabled: true/false} (force, beats any percent),
     *  `"x": 20` = {percent: 20}. Wrong-typed fields ("enabled": "true") are
     *  ignored (never widen a cohort) and named by the startup warning. */
    features?: Record<string, RolloutFeatureOverride | boolean | number>;
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
    /** Set `false` to disable the critical-defect advisory watcher (#1481);
     *  env BILI_ADVISORY_CHECK wins when set. */
    advisoryCheck?: boolean;
    /** Set `false` to disable the tiered release-notes visibility watcher
     *  (#1870); env BILI_RELEASE_NOTES_CHECK wins when set. */
    releaseNotesCheck?: boolean;
    /** Override for the advisory document URL (env BILI_ADVISORY_URL wins). */
    advisoryUrl?: string;
    /** Override for the release-notes document URL (env
     *  BILI_RELEASE_NOTES_URL wins) (#1870). */
    releaseNotesUrl?: string;
    upstreamProxy?: string;
    upstreamProxyMode?: string;
    logFile?: string;
    /** Global compression block (level 1 of 3). Holds the injection toggles
     *  (`injectTool` / `injectNudge`, honored globally) plus the tuning fields
     *  (see CompressSettings), overridden per-field by provider- and model-level
     *  `compress`. */
    compress?: CompressSettings & { injectTool?: boolean; injectNudge?: boolean };
    promptCache?: { routing?: string };
    /** #3376: global idle prompt-cache keepalive block (level 1 of 2);
     *  per-provider overrides live at `providers[url].cacheKeepalive`.
     *  Resolved by src/cache-keepalive.ts; env BILI_CACHE_KEEPALIVE* wins. */
    cacheKeepalive?: CacheKeepaliveSettings;
    /** MITM block (#2030: + handshakeTimeoutMs, was env BILI_MITM_HANDSHAKE_TIMEOUT_MS only). */
    mitm?: { enabled?: boolean; domains?: string[]; handshakeTimeoutMs?: number };
    /** Snapshot-render observability block. `shadow` (boolean, default true)
     *  computes the snapshot view on armed turns without using it — counters
     *  surface in the web panel; env BILI_SNAPSHOT_SHADOW wins (#3756). */
    snapshot?: { shadow?: boolean };
    /** Re-sign block (#1884), scheme-keyed: the key is the lowercase
     *  Authorization scheme (built-in: "sdk-hmac-sha256" — CodeArts APIG).
     *  `enabled: false` unloads the arm for that scheme (pre-resign rewrite
     *  behavior; env BILI_RESIGN=0 wins). `passthrough: true` opts into
     *  verbatim forwarding for requests signed with THAT scheme that cannot
     *  be re-signed (no credential) instead of the default local 403
     *  refusal (env BILI_RESIGN_PASSTHROUGH=1 wins) — scoping passthrough
     *  by scheme pins exactly which signature may tunnel. The model-level
     *  free-quota knob is NOT here — it lives at level 3:
     *  `providers.<url>.models.<name>.benefit: true|false` (env
     *  BILI_RESIGN_BENEFIT wins over the whole tree).
     *  `credentialRef` pins the dsh credentials-service ref used for
     *  re-signing instead of account-pool discovery (env BILI_CODEARTS_REF
     *  wins). */
    resign?: ResignSchemeMap;
    /** Set `false` to log real (non-public) target hosts instead of the
     *  `<private-host>` placeholder (#897; env BILI_LOG_MASK_HOSTS=0 wins). */
    maskHosts?: boolean;
    /** Set `false` to keep Claude Code subagents on the main session (#970;
     *  env BILI_SUBAGENT_SPLIT=0 wins). */
    subagentSplit?: boolean;
    /** Opt-in fork block-adoption (#629): when an anonymous (prefix-affinity)
     *  client forks its history mid-conversation (edit / regenerate), the new
     *  session inherits the parent's compression blocks whose source content
     *  is fully present in the forked request, instead of restarting with
     *  zero compression state. Default false; env BILI_FORK_ADOPTION=1/0
     *  wins over the file. */
    forkAdoption?: boolean;
    /** Set `false` to disable simhash chain-alignment adoption (#2265,
     *  default ON; env BILI_AFFINITY_SIMHASH=0 wins over the file). */
    affinitySimhash?: boolean;
    /** Set `false` to disable resume-fork inheritance (#1486, default ON;
     *  env BILI_RESUME_INHERITANCE=0 wins over the file). */
    resumeInheritance?: boolean;
    /** Set `true` to enable body-content detection of the bili→bili chain
     *  awareness (#1086/#1421); OFF by default — by default only x-bili-hop drives
     *  chain recognition, since body scanning can false-positive on CCR/file-
     *  introduced text and model-echoed tags (#1683). Env BILI_CHAIN_CONTENT=1
     *  wins over the file. */
    chainContentDetection?: boolean;
    /** Set `true` to enable egress emission of the model-visible
     *  `<bili-chain …/>` checkpoint carrier (#1683, default OFF; env
     *  BILI_CHAIN_STAMP=1 wins over the file). Independent of
     *  chainContentDetection. */
    chainEgressStamp?: boolean;
    /** Set `true` to enable the sticky head-system anchor (#1085, default
     *  OFF; env BILI_STABLE_SYSTEM_ANCHOR wins). */
    stableSystemAnchor?: boolean;
    /** dsh client-lane settings — see {@link DshFileSettings}. The former
     *  `allowDshCompaction` escape hatch was removed (#3651); the one live key
     *  is `authoredCompaction` (#3723/#3901). Leftover removed keys stay
     *  recognized (no unknown-key warning) and are ignored with a deprecation
     *  note (warnRemovedDshAllowKey). */
    dsh?: DshFileSettings;
    /** Global wire-compat block. `roles` maps message roles to the role name
     *  upstreams accept (e.g. `{"developer":"system"}`) — applied to the
     *  final forwarded body for openai/responses requests (#552).
     *  `dropFields` (#1757): dot-separated plain-object key paths of
     *  client-fixed fields stripped from every forwarded body (strict-schema
     *  gateways that 400 on unknown fields); per-provider lists union onto it.
     *  `streamErrorShape` (#1455): "protocol" (default) presents upstream
     *  stream failures as protocol-native error frames; "completion" restores
     *  the legacy shape that delivered the failure text inside a synthesized
     *  successful completion. Env BILI_STREAM_ERROR_SHAPE wins over the file.
     *  `noCacheControl` (#2030): set `true` to stop stamping Anthropic
     *  cache_control marks entirely (env BILI_NO_CACHE_CONTROL wins).
     *  `keepResponseId` (#2030): set `true` to preserve previous_response_id
     *  on rebuilt Responses requests (env ACP_KEEP_RESPONSE_ID=1 wins). */
    compat?: { roles?: Record<string, string>; streamErrorShape?: string; dropFields?: string[]; noCacheControl?: boolean; keepResponseId?: boolean };
    /** Global image billing mode (#767): "auto" | "pixels" | "bytes".
     *  Per-provider `imageBilling` overrides it; env BILI_IMAGE_BILLING wins
     *  over both. See ProviderRoute.imageBilling. */
    imageBilling?: string;
    /** #1843 L3: global per-image token ceiling (positive integer); per-route
     *  `imageTokenCap` overrides it, env BILI_IMAGE_TOKEN_CAP wins over both. */
    imageTokenCap?: number;
    /** Claude-native port override (#964/#1660): an explicit port for the
     *  claude lane — strict-port semantics (EADDRINUSE fails loud). Undefined
     *  (the default) means the lane's sticky zone port (ZONE_PORT_BASE base).
     *  Env BILI_CLAUDE_NATIVE_PORT wins over the file. */
    claude?: { nativePort?: number };
    /** Built-in pi-lane sub-agents (#2230 config-home): the `pi.subagents`
     *  section owns the acp_delegate surface for the pi lane (embedded wiring
     *  src/agent/pi-subagents.ts; the standalone package
     *  billion-context-pi-subagents reads the same section through its own
     *  loader — the file format is the contract, not shared code). Fields map
     *  1:1 onto the package's DelegateConfig; `prompt` replaces acp.json's
     *  `delegatePrompt` and `debug` is scoped to the sub-agent subsystem (no
     *  collision with the top-level proxy `debug`). Boolean shorthand:
     *  `"pi": {"subagents": false}` disables the whole surface. The four
     *  acp.json keys (delegate/delegatePrompt/displayUsage/debug) are a
     *  deprecated fallback, read only while this section is absent.
     *  `inline` (#3278, OPT-IN — default stays the spawned proxy, #4687
     *  reverts the #4571 default flip): run the pi lane's compression
     *  IN-PROCESS — no proxy server spawned. Enable with `true` (or
     *  BILI_PI_INLINE=1/on/yes/TRUE). Resolved env > file; an explicit
     *  inline choice beats an announced attach target (launcher-set
     *  BILLION_CONTEXT_PROXY/ATTACH); when unset the lane behaves exactly
     *  as before (attach/spawn). */
     pi?: { subagents?: PiSubagentsFileConfig | boolean; inline?: boolean };
    /** Built-in opencode-lane inline switch (#3278 port, OPT-IN — default
     *  stays the spawned proxy, per owner decision on #4687): run the
     *  opencode lane's compression IN-PROCESS — no proxy server spawned.
     *  Enable with `true` (or BILI_OPENCODE_INLINE=1/on/yes/TRUE). Resolved
     *  env > file; an explicit inline choice beats an announced attach
     *  target (launcher-set BILLION_CONTEXT_PROXY/ATTACH); when unset the
     *  lane behaves exactly as before (attach/spawn). */
    opencode?: { inline?: boolean };
    /** Feature rollout (canary) block (#3062, resolved by src/rollout.ts):
     *  per-feature overrides of the version's baked-in rollout plan
     *  (ROLLOUT_FEATURES). `installId` pins the bucketing identity instead of
     *  the auto-generated state-dir UUID (support/testing). Env
     *  BILI_ROLLOUT_<FEATURE>=0/1 (UPPER_SNAKE name) wins over everything,
     *  including `enabled`. */
    rollout?: RolloutFileConfig;
    /** Security posture block (#3373) — knobs that WIDEN a trust boundary
     *  live here so the exposure surface is auditable in one place.
     *  `adminRelay` (default false, fail-closed): allow an embedding host
     *  (dsh web today) to relay the ENTIRE /__bili/ admin surface — including
     *  config editing and credential writes, not just the read-only panel —
     *  through its own entry origin: the host registers a /__bili prefix
     *  route forwarding to the loopback proxy, so a browser on another
     *  machine opens the panel through the same origin it already reached
     *  the host by. The admin gate itself is unchanged: the relayed hop is a
     *  local non-browser client (loopback source + loopback Host + no
     *  Origin header), so #1538 DNS-rebinding protection holds verbatim.
     *  Enabling it means whoever can reach the host web entry can reach the
     *  admin surface — protect the entry (auth/reverse proxy) accordingly.
     *  File-only, no env var (#2030). */
    security?: {
        adminRelay?: boolean;
    };
     /** Native-hook attach behavior.
      *  `attachExternal` (#1335): set `true` to let native hooks attach to
      *  lifecycle-less listeners (a manually started `bili start` daemon — no
      *  session-lifecycle watchdog, outlives every session, often an older code
      *  version); default false → hooks self-manage and spawn their own armed
      *  session proxy instead (#1322). Env BILI_NATIVE_ATTACH_EXTERNAL=1/0 wins
      *  over the file.
      *  `attachLanePriority` (#2905): an ordered list of lane names whose live
      *  instances a hook may ride when NO instance of its own lane exists — each
      *  name becomes an attachable tier in list order, after the hook's own lane
      *  (always first) and before the user zone (manual `bili start`, the 8787
      *  global daemon), which is ALWAYS last among attachable candidates.
      *  Unlisted lanes stay non-attachable (#1225/#1232 isolation). Default [] =
      *  own lane → user zone → spawn; cross-lane attach stays opt-in because a
      *  foreign lane's MITM whitelist may not cover your providers (blind tunnel
      *  + tool 404s — the accident #2905 reports). File-only, no env var (#2030).
      *  `attachPolicy` (#2877): how a LANEd hook discovers an existing daemon
      *  when none of its own lane is running. "own-lane" (default) rides ONLY a
      *  same-lane daemon and otherwise spawns its own — it never falls back to a
      *  lane-less / user-zone / other-lane daemon (the manual `bili start` global
      *  that used to get ridden by every lane, #2877). "global-fallback" restores
      *  the pre-#2877 behavior (own lane first, then any compatible user-zone
      *  daemon). Env BILI_NATIVE_ATTACH_POLICY wins over the file.
      *  `attachUrl` (#2877): an explicit target origin (any URL, local or remote)
      *  to attach to instead of discovering; when set it overrides attachPolicy
      *  (the hook attaches only to that origin, else spawns). Env BILI_MCP_PROXY
      *  (also set by --origin) wins over this file value. */
     native?: {
         attachExternal?: boolean;
         attachLanePriority?: string[];
         attachPolicy?: "own-lane" | "global-fallback";
         attachUrl?: string;
     };
    /** Unified SQLite storage sidecar (#2671). `storage.unified` selects the
     *  whole-lane mode ("legacy" | "shadow" | "full"); env
     *  BILI_STORAGE_UNIFIED wins over this file value, absent/invalid falls
     *  back to "legacy". Resolved at store construction (lane boot) — hot
     *  edits apply on the next restart, not mid-session. */
    storage?: {
        unified?: string;
        /** SQLite engine self-download (#2833): when unified storage is
         *  requested but neither builtin node:sqlite nor a host-installed
         *  better-sqlite3 exists, bili downloads a pinned N-API prebuilt at
         *  startup instead of degrading to legacy-only. Default true; env
         *  BILI_SQLITE_AUTO_DOWNLOAD wins. A cached copy is still used when
         *  this is false — the switch gates the network fetch only. */
        sqliteAutoDownload?: boolean;
        /** Storage backend selection (#3931, step 1 of the #3388 pluggable
         *  plan): "sqlite" (default, only real implementation today) or
         *  "mysql" (registered stub — step 2). env BILI_STORAGE_BACKEND
         *  wins; a non-sqlite selection logs one notice and stays on
         *  sqlite until the backend ships. */
        backend?: string;
        /** MySQL DSN for storage.backend="mysql" (#3388 step 2, #3931):
         *  mysql://user:pass@host:3306/db — consumed by the StorageBackend
         *  contract paths (export/replica/checkpoint). env BILI_MYSQL_DSN
         *  wins. The proxy hot path stays on sqlite until the step-3 async
         *  swap; the boot notice names that boundary. */
        mysql?: { dsn?: string };
        /** Phase 3 (#2960): "off" stops writing the legacy JSON envelope while
         *  storage.unified is "full" — the SQLite index becomes the only
         *  persistent copy (reads were already unified-first; boot enumerates
         *  the index union). Ignored with a one-time warning under
         *  shadow/legacy, where the JSON file remains the sole source of
         *  truth. Env BILI_STORAGE_JSON_WRITER wins; default "on". Rollback =
         *  unset (JSON writing resumes; index-only sessions keep loading via
         *  the boot union, and replicas/restore re-materialize envelopes). */
        jsonWriter?: string;
        /** WAL reclamation cap for index.db-wal (#3250), in bytes: every
         *  completed checkpoint truncates the WAL file back to this size.
         *  NOT a per-session data quota — data lands in index.db as it is
         *  written and the WAL only stages frames between checkpoints, so
         *  session count/size does not scale this. Higher = rarer truncate
         *  IO but more steady disk use and a longer crash-replay tail.
         *  Env BILI_STORAGE_WAL_JOURNAL_SIZE_LIMIT_BYTES wins; default
         *  8388608 (8 MiB); a non-positive/non-integer value falls back to
         *  the file/default tier. Applied when the store opens (lane boot) —
         *  hot edits apply on the next restart. */
        walJournalSizeLimitBytes?: number;
        /** #3901/#3463: session retention window in days for the GC age
         *  sweep (archive + tombstone + CAS release). 0 disables; env
         *  BILI_STORAGE_ARCHIVE_AFTER_DAYS wins. Default 365. */
        archiveAfterDays?: number;
    };
    /** Network & timing knobs (#2030) — every field was an env-only variable
     *  before (BILI_*_MS / BILI_REPLAY_* family); env still wins when set.
     *  Resolved by src/knobs.ts. */
    network?: {
        /** Upstream fetch timeout (was BILI_UPSTREAM_TIMEOUT_MS; default 720000). */
        upstreamTimeoutMs?: number;
        /** Request watchdog budget (was BILI_REQUEST_WATCHDOG_MS; default 2× upstream timeout). */
        requestWatchdogMs?: number;
        /** Server keep-alive timeout (was BILI_KEEP_ALIVE_TIMEOUT_MS; default 5000). */
        keepAliveTimeoutMs?: number;
        /** Client-error backstop (was BILI_CLIENT_ERROR_BACKSTOP_MS; default 30000). */
        clientErrorBackstopMs?: number;
        /** Exposure log interval, 0 disables (was BILI_EXPOSURE_LOG_INTERVAL_MS; default 3600000). */
        exposureLogIntervalMs?: number;
        /** Preflight stream keep-alive hold, 0 disables (was BILI_STREAM_KEEPALIVE_MS; default 15000). */
        streamKeepAliveMs?: number;
        /** Preflight hold grace (was BILI_PREFLIGHT_HOLD_MS; default 30000). */
        preflightHoldMs?: number;
        /** Max replay attempts on transient upstream errors (was BILI_REPLAY_RETRY_MAX; default 3). */
        replayRetryMax?: number;
        /** Replay backoff base delay (was BILI_REPLAY_RETRY_BASE_MS; default 1500). */
        replayRetryBaseMs?: number;
        /** Egress-side 429 throttle governor master switch (#4204; was env-only BILI_THROTTLE_429; default true).
         *  After consecutive upstream 429s, further sends to that origin+credential are answered locally
         *  (429 + Retry-After, then a terminal 424) instead of being forwarded, so host-driven retry loops
         *  cannot pin a concurrency-style provider limit. false restores the legacy always-forward behavior. */
        throttle429Enabled?: boolean;
        /** Consecutive upstream 429s before the hold turns terminal — local 424 answers outside every known
         *  client-SDK retry set, so hosts stop re-driving (#4204; was env-only BILI_THROTTLE_429_MAX_CONSECUTIVE; default 5). */
        throttle429MaxConsecutive?: number;
        /** 429-hold backoff base delay in ms — exponential ×2 per consecutive 429, jittered, capped by
         *  throttle429MaxDelayMs (#4204; was env-only BILI_THROTTLE_429_BASE_DELAY_MS; default 2000). */
        throttle429BaseDelayMs?: number;
        /** 429-hold backoff ceiling in ms; also the probe cadence once the hold is terminal (#4204;
         *  was env-only BILI_THROTTLE_429_MAX_DELAY_MS; default 30000). */
        throttle429MaxDelayMs?: number;
        /** Per-compress shrink steering factor in (0,1] (was BILI_MAX_SHRINK_PER_COMPRESS; default unset). */
        maxShrinkPerCompress?: number;
        /** Outbound proxy keep-alive ceiling, 0 for one-shot (was BILI_PROXY_KEEPALIVE_MAX_MS; default 55000). */
        proxyKeepAliveMaxMs?: number;
        /** Post-response close linger budget (#1982; was env-only BILI_POST_RESPONSE_LINGER_MS; default 5000). */
        postResponseLingerMs?: number;
        /** Opt-in plain-HTTP trust for private networks (#2984): when true, private hosts
         *  (RFC1918, 127/8, link-local, ULA, *.local/.lan/.internal) may be admitted over
         *  plaintext by the #2585 gates — agent-registry intake and the summary-endpoint
         *  guards. Default false: plaintext stays loopback-only. Public IPs/domains and
         *  CGNAT (100.64/10) remain refused regardless. Env BILI_ALLOW_PRIVATE_HTTP_PROVIDERS wins. */
        allowPrivateHttpProviders?: boolean;
        /** Per-request inbound wire byte budget (#3128; was hardcoded 100 MiB, now default 5 GiB).
         *  Env BILI_RECEIVE_BODY_BYTES wins. Also the threshold above which a decoded request
         *  consumes one of two shared large-decode admission slots. WebSocket lanes keep 100 MiB. */
        receiveBodyBytes?: number;
        /** Per-request DECODED byte budget after content-encoding expansion (#3128; default 10 GiB = 2x receive). Env BILI_DECODED_BODY_BYTES wins. */
        decodedBodyBytes?: number;
        /** Per-request rebuilt-outbound byte budget forwarded upstream (#3128; default 5 GiB). Env BILI_OUTBOUND_BODY_BYTES wins. */
        outboundBodyBytes?: number;
        /** Soft egress byte budget for the WebSocket lane (#3701; default 10 MiB, 0 disables). Above it, older non-protected images are shed from the outbound copy before sending. Env BILI_WS_OUTBOUND_BYTES wins. */
        wsOutboundBytes?: number;
        /** Soft egress byte budget for the plain/proxy/pi-native HTTP relay lane (#3909; default 10 MiB, 0 disables). Above it, older non-protected images are shed from the outbound copy before sending, because an image-dense session can carry tens of MiB of base64 that upstreams reject on raw bytes / pixel-decode CPU (Cloudflare Worker 503) while token-space folding stays below its trigger. Applies only when no managed transport is installed (the spawned relay); the WS lane uses wsOutboundBytes and managed HTTP transports (inline-engine / dsh-inline) are never shed here (#3701 Finding 1). Env BILI_HTTP_OUTBOUND_BYTES wins. */
        httpOutboundBytes?: number;
        /** Extra root-CA PEM bundle trusted by bili's OWN outbound upstream fetch (#3776): for security
         *  software doing HTTPS/encrypted-connection scanning (Kaspersky, enterprise DLP) or a corporate
         *  MITM proxy whose re-signed upstream cert Node's default trust rejects with
         *  SELF_SIGNED_CERT_IN_CHAIN. MERGED with Node's built-in roots, never replacing them.
         *  Env BILI_CA_FILE wins. */
        caFile?: string;
    };
    /** Session persistence knobs (#2030) — was BILI_PERSIST_* env-only. */
    persist?: {
        enabled?: boolean;
        zstd?: boolean;
        debounceMs?: number;
        tailTokens?: number;
        epermAlertThreshold?: number;
        epermAlertRepeatMs?: number;
    };
    /** Session pool & GC knobs (#2030) — was BILI_MAX_SESSIONS / BILI_SESSION_GC*.
     *  #2803 adds the bounded-startup warm-set and resident-cache budgets:
     *  `warmMax` caps how many most-recently-saved sessions boot hydrates
     *  before listening, `warmMaxBytes` its decoded-byte budget (a single file
     *  over the budget is never warmed), `residentMaxBytes` the soft target for
     *  estimated resident session bytes (active/in-flight state stays pinned). */
    sessions?: {
        max?: number;
        warmMax?: number;
        warmMaxBytes?: number;
        residentMaxBytes?: number;
        gc?: { enabled?: boolean; maxAgeDays?: number; maxTokens?: number; intervalMs?: number };
    };
    /** Plugin-surface knobs (#2017). `snapshotCapBytes` caps the raw
     *  wire-history snapshot retained per plugin session for the public
     *  fork API — beyond the cap the session stops being forkable (409)
     *  instead of retaining an unbounded raw copy. Default 100 MiB; `0`
     *  disables retention entirely; env BILI_PUBLIC_SNAPSHOT_CAP_BYTES wins. */
    plugin?: { snapshotCapBytes?: number };
    /** Updater knobs (#2030) — was BILI_UPDATE_REGISTRY / BILI_UPDATE_CHECK_INTERVAL_MS.
     *  `staggerMinDelayMs`/`staggerMaxDelayMs` override the LOCAL base window of
     *  the #3619 staggered rollout (remote policy `default`/overrides still stack
     *  on top); both accept raw ms numbers OR human-readable duration strings
     *  ("15m", "2d", "1d12h" — #3619) in this file; `policyUrl` overrides the
     *  remote policy file URL (test seam — production stays pinned to the
     *  official repo). */
    update?: { registry?: string; checkIntervalMs?: number; staggerMinDelayMs?: number | string; staggerMaxDelayMs?: number | string; policyUrl?: string };
    /** Diagnostics & debug surface (#2030) — was ACP_DUMP_BODY / ACP_DUMP_REQ /
     *  ACP_RAW_DUMP_DIR / BILI_DUMP_4XX* / ACP_RENDER_NONE / ACP_NO_INJECT_TOOL /
     *  ACP_NO_COMPRESS_PROMPT / ACP_COUNT_TOKENS_PASSTHROUGH / ACP_COMPRESS_PROTOCOL. */
    diagnostics?: {
        dumpBody?: boolean;
        dumpReq?: boolean;
        rawDumpDir?: string;
        dump4xx?: boolean;
        dump4xxMaxBytes?: number;
        renderNone?: boolean;
        /** #3938 decision ②: arm the I1/I2 outbound-invariant judge as an L1
         *  advisory (warn-log violations, never blocks). Default true;
         *  BILI_INVARIANT_JUDGE=0/false disarms. */
        invariantJudge?: boolean;
        noInjectTool?: boolean;
        noCompressPrompt?: boolean;
        countTokensPassthrough?: boolean;
        compressProtocol?: string;
        /** #2412: retention bounds for debug dump dirs (dumps/, raw/, SSE dump dir) —
         *  oldest-first deletion when exceeded. Unset/0 = off (default). */
        maxTotalBytes?: number;
        maxAgeDays?: number;
    };
    /** Fake-completion fallback tuning (#2030) — was BILI_FAKE_COMPLETION_RETRIES / BILI_FAKE_BUF_CAP. */
    fakeCompletion?: { retries?: number; bufCapBytes?: number };
    /** Codex compaction kill-switch (#2030) — was BILI_CODEX_COMPACT ("intercept" | "pass"). */
    codexCompact?: string;
    /** Auto-mode classifier local-forge switch (#2740) — env BILI_AUTO_MODE_FORGE. */
    autoModeForge?: { enabled?: boolean };
    /** pi/omp plugin tool-output guardrails (#3066) plus the proxy-side
     *  text-run stream guard (#3406 item 1). `bashTimeout` injects N
     *  seconds as the bash `timeout` when the model omits it — default 60
     *  (#3066 owner intent, re-affirmed #3366: unsupervised bash could hang a
     *  pi session for a whole day); 0 disables injection (pi-native).
     *  `maxOutputBytes` caps combined text tool output (default 50000, 0 = no
     *  cap). `repetition: false` disables the identical-call loop-breaker.
     *  `textRunThreshold` is the single-codepoint repetition breaker over
     *  decoded model text (default 200, 0 = off). Env
     *  BILI_GUARDRAIL_BASH_TIMEOUT / BILI_GUARDRAIL_MAX_OUTPUT_BYTES /
     *  BILI_GUARDRAIL_REPETITION / BILI_GUARDRAIL_TEXT_RUN_THRESHOLD win over
     *  all. */
    guardrails?: {
        bashTimeout?: number;
        maxOutputBytes?: number;
        repetition?: boolean;
        textRunThreshold?: number;
    };
    /** CCR retrieval TTL in ms (#2030) — was BILI_CCR_RETRIEVAL_TTL_MS (default 600000). */
    ccrRetrievalTtlMs?: number;
    /** Large-decompress temp-file cap (#2030) — was BILI_DECOMPRESS_TMP_CAP (default 50). */
    decompressTmpCap?: number;
    /** Image rescale egress pass on/off (#3400) — env BILI_IMAGE_RESCALE (default: on). */
    imageRescale?: boolean;
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

// #1815: a top-level key the loader does not consume must not vanish without
// feedback — a misplaced key (e.g. "promptPack" at root instead of under
// "compress") was dropped silently, violating the never-silently-drop-user-
// config rule (§7.3). KNOWN_TOP_LEVEL_KEYS is the runtime mirror of FileConfig
// above; keep it in sync when adding fields there.
const KNOWN_TOP_LEVEL_KEYS = new Set([
    "port", "host", "upstream", "providersPath", "providers", "proxy",
    "modelContextLimit", "sessionHeader", "log", "debug", "dumpSse",
    "passthrough", "autoUpdate", "autoRestartOnUpdate", "updateTag",
    "advisoryCheck", "advisoryUrl", "releaseNotesCheck", "releaseNotesUrl",
    "upstreamProxy", "upstreamProxyMode",
    "logFile", "compress", "promptCache", "mitm", "maskHosts",
    "subagentSplit", "forkAdoption", "affinitySimhash", "resumeInheritance",
    "chainContentDetection", "chainEgressStamp", "stableSystemAnchor",
    "rollout",
    "dsh",
    "compat", "imageBilling", "imageTokenCap", "claude", "native", "resign",
    "pi", "storage", "security",
    // #2030 subsystem blocks:
    "network", "persist", "sessions", "plugin", "update", "diagnostics",
    "fakeCompletion", "codexCompact", "ccrRetrievalTtlMs", "decompressTmpCap",
    "autoModeForge", "imageRescale", "guardrails",
    // #3376:
    "cacheKeepalive",
]);

// Every field parseCompressSettings accepts — hint source for misplaced keys:
// an unknown top-level key that appears here almost certainly belongs one
// level down under "compress". Keep in sync with parseCompressSettings.
const COMPRESS_SETTING_FIELDS = new Set([
    "modelContextLimit", "maxContextLimit", "emergencyThresholdPercent",
    "nudgeGrowthTokens", "minPressureBenefitTokens", "tierNudgeTokens", "nudgeModelDecided", "nudgeDecisionMaxTokens",
    "preserveRecentMessages", "preserveRecentTokens",
    "minCompressRange", "minCompressRangeChars",
    "outputHeadroomMaxPct", "tiers", "protectedLatestTools", "protectedTools",
    "neverPreserveRecentTools", "preserveRecentTools",
    "visibilityMarkers", "rules", "injectTool", "injectNudge",
    "acknowledgePromptsRisk", "absorb", "ccr", "search",
    "prompts", "promptPack", "reasoningGuard", "outputSteering", "priceProfile",
    "reconcile", "streamSummary", "externalSummary",
    // #3635: summary-length caps — previously accepted nowhere, silently dropped.
    "maxSummaryLength", "minSummaryLength",
]);

// Deduped per unique key set per process (same pattern as
// seenAbsorbDivergenceWarnings): loadConfigFile() runs on every config read,
// so without this one startup would log the same warning several times.
const seenUnknownTopLevelKeySignatures = new Set<string>();

export function warnUnknownTopLevelKeys(obj: Record<string, unknown>): void {
    // #3651: the removed top-level allowDshCompaction key gets its own deprecation
    // note (warnRemovedDshAllowKey) — exclude it here so it isn't named twice.
    const unknown = Object.keys(obj).filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key) && key !== "allowDshCompaction");
    if (unknown.length === 0) return;
    const signature = [...unknown].sort().join("\u0000");
    if (seenUnknownTopLevelKeySignatures.has(signature)) return;
    seenUnknownTopLevelKeySignatures.add(signature);
    const misplaced = unknown.filter((key) => COMPRESS_SETTING_FIELDS.has(key));
    const hint = misplaced.length > 0
        ? ` — ${misplaced.map((k) => `"${k}" belongs under "compress" (did you mean "compress.${k}"?)`).join("; ")}`
        : "";
    loggerLog("warn", `[acp-config] ignoring unknown top-level config key(s): ${unknown.join(", ")}${hint}`);
}

// #2078: parse-once cache for loadConfigFile(). Every knob resolves its file
// tier through this reader per call (~5-10 calls per request once #2030
// landed), and each call used to do a full readFileSync + JSON.parse. The raw
// file TEXT is the invalidation key, deliberately NOT (mtime, size): back-to-
// back rewrites can land on the same sub-ms mtime on common filesystems
// (measured), so a stat-keyed cache serves stale values right after a web-UI
// Apply or a test-seam write. Re-reading the text per call is a page-cache hit
// (~µs); JSON.parse is the expensive half and now runs only when content
// actually changed. Hot-reload stays exact: any external rewrite is visible on
// the next call; a missing file is never cached (reappearing files show up
// immediately). Callers treat the returned object as READ-ONLY (shared across
// calls until the content changes) — audited: all current consumers only read
// fields.
let configFileCache: { raw: string; value: FileConfig } | null = null;

// #3572: bili's own config file is documented as JSONC — CONFIGURATION*.md show
// ```jsonc blocks whose first line is a // comment — but this reader used bare
// JSON.parse, so a file copied straight from the docs failed on the first // and
// EVERY key was silently dropped (one error line, no other signal; e.g. an
// update.registry mirror override never applied). Parse strict JSON first so a
// valid file takes the exact same path as before (zero behavior change), then
// fall back to jsonc-parser (comments + trailing commas) — the same way the repo
// already reads opencode's own JSONC configs (parseConfigText, src/client-config.ts).
// A genuinely malformed file still fails LOUDLY: jsonc-parser reports the first
// error and we rethrow it as a SyntaxError, so the caller's catch logs + caches {}
// exactly as it did for JSON.parse failures.
export function parseBiliConfig(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        const errors: ParseError[] = [];
        const value = parseJsonc(raw, errors, { allowTrailingComma: true });
        if (errors.length === 0) return value;
        const first = errors[0];
        throw new SyntaxError(`invalid JSON/JSONC at ${lineColumnOf(raw, first.offset)}: ${printParseErrorCode(first.error)}`);
    }
}

function lineColumnOf(text: string, offset: number): string {
    let line = 1;
    let column = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charAt(i) === "\n") { line++; column = 1; } else column++;
    }
    return `line ${line} column ${column}`;
}

export function loadConfigFile(): FileConfig {
    const path = configFile();
    let raw: string | undefined;
    let value: FileConfig | undefined;
    try {
        raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
        const cached = configFileCache;
        if (cached && cached.raw === raw) return cached.value;
        const parsed: unknown = parseBiliConfig(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            warnRemovedDshAllowKey(obj);
            warnUnknownTopLevelKeys(obj);
            warnInertResignPassthrough(obj);
            warnInertStripImages(obj);
            warnInertRemovedCompressKeys(obj);
            value = obj as FileConfig;
        } else {
            value = {};
        }
    } catch (e) {
        // Same surface as safeReadJson: silent on ENOENT, loud otherwise.
        // Corrupt-but-present content IS cached (as {}) so one bad save does
        // not re-log and re-fail-parse on every knob call until it is fixed.
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
            loggerLog("error", `[acp-config] failed to parse ${path}: ${String(e)}`);
        }
        if (raw !== undefined) value = {};
    }
    if (raw === undefined || value === undefined) return {};
    configFileCache = { raw, value };
    return value;
}

/** #2960⑥ (config epoch): stable identity of the config FILE SOURCE right now —
 *  sha256(raw text). Sessions stamp this next to their effectiveConfig snapshot
 *  so readers can detect that the snapshot was resolved from a source that no
 *  longer exists (file edited since the last wire request) and re-resolve from
 *  the live file instead of serving the stale cascade. Content-only hash:
 *  identical bytes at different BILI_CONFIG_FILE paths are the same settings
 *  (so cross-instance stamps validate — and that is correct, the resolved
 *  file tier is identical), while any edit diverges the hash. Deliberately
 *  NOT path-keyed: golden drives run in mkdtemp dirs and a path component
 *  would make every run's metadata digest unique. Cost mirrors
 *  loadConfigFile()'s own per-call read (page-cache hit, ~µs). */
export function configFileEpoch(): string {
    let raw: string;
    try {
        raw = readFileSync(configFile(), "utf8").replace(/^\uFEFF/, "");
    } catch {
        raw = "";
    }
    return createHash("sha256").update(raw).digest("hex");
}


// #3651: the allowDshCompaction escape hatch (#2028) is GONE — dsh native
// compaction is refused unconditionally on every lane by the #1729 wire guard.
// Old values may still sit in config files (top-level legacy position or
// dsh.*); they are IGNORED — never relocated or rewritten (§7.3) — and named
// once per distinct shape so the user knows why they do nothing. Deduped per
// key set like warnUnknownTopLevelKeys: loadConfigFile() runs on every read.
let removedDshAllowKeySignature = "";
let removedDshEnvWarned = false;
function warnRemovedDshAllowKey(obj: Record<string, unknown>): void {
    const hits: string[] = [];
    if (Object.prototype.hasOwnProperty.call(obj, "allowDshCompaction") && obj.allowDshCompaction !== null && obj.allowDshCompaction !== undefined) {
        hits.push('top-level "allowDshCompaction"');
    }
    const d = obj.dsh;
    if (d !== null && typeof d === "object" && !Array.isArray(d)) {
        // authoredCompaction (#3723/#3901), contextTab + contextTabLabel
        // (#4237) are the LIVE keys in the section — everything else found
        // here is removed/unknown and gets named.
        const live = new Set(["authoredCompaction", "contextTab", "contextTabLabel"]);
        for (const key of Object.keys(d as Record<string, unknown>)) if (!live.has(key)) hits.push(`dsh.${key}`);
    }
    hits.sort();
    const sig = hits.join(",");
    if (sig === "" || sig === removedDshAllowKeySignature) return;
    removedDshAllowKeySignature = sig;
    loggerLog("warn", `[acp-config] ${hits.join(", ")} was removed (#3651, superseding #2028) — value(s) ignored: dsh native compaction is now refused unconditionally by the wire guard on every lane. Delete it from your config to silence this.`);
}
/** File shape of ONE scheme's `resign` block (see FileConfig.resign). */
interface ResignFileSettings {
    enabled?: boolean;
    passthrough?: boolean;
    credentialRef?: string;
}

/** The scheme bili can re-sign out of the box: Huawei CodeArts APIG's
 *  SDK-HMAC-SHA256. The `resign` block is keyed by signature scheme name
 *  (lowercase, as it appears on the wire's Authorization header) so the
 *  field stays generic — adding a second re-signable scheme later adds a
 *  key, not a redesign (#1884). */
export const RESIGN_BUILTIN_SCHEME = "sdk-hmac-sha256";

/** Scheme-keyed re-sign policy: key = lowercase Authorization scheme
 *  (e.g. "sdk-hmac-sha256"). The built-in key resolves out of the box
 *  (defaults below); other body-covering schemes can be scoped their own
 *  `passthrough` opt-in without opening the built-in one. */
type ResignSchemeMap = Record<string, ResignFileSettings>;

/** Resolved #1884 re-sign settings: env vars win over the config file, the
 *  file wins over the defaults (same precedence family as
 *  resolveClaudeNativePort / chainContentDetection). `credentialRef` stays
 *  undefined when neither env nor file sets it — the signer then falls back
 *  to account-pool discovery. The free-quota model knob is resolved
 *  separately at level 3 (ModelEntry.benefit). */
export interface ResignSettings {
    enabled: boolean;
    passthrough: boolean;
    credentialRef?: string;
}

/** Per-field precedence: env var > provider-level block (`providers.<url>.resign`,
 *  level 2) > global file block > default. Provider resolution happens AFTER
 *  routing — the provider and its model filter are known before the re-sign
 *  action runs (the repo's route-first ordering; #1884). Host-side callers
 *  (native intercept, dsh lane) pass no provider — they run before any route
 *  exists and take the root cascade. `scheme` scopes the lookup to one
 *  signature: the built-in key resolves with defaults when the file says
 *  nothing about it (out-of-box), and a scheme the file only mentions under
 *  a different key never leaks into another key's policy. */
export function resolveResignSettings(env: NodeJS.ProcessEnv = process.env, provider: ResignSchemeMap = {}, scheme: string = RESIGN_BUILTIN_SCHEME): ResignSettings {
    const key = scheme.trim().toLowerCase();
    const file = loadConfigFile().resign?.[key] ?? {};
    const providerBlock = provider?.[key] ?? {};
    const enabled = env.BILI_RESIGN !== undefined ? env.BILI_RESIGN !== "0" : providerBlock.enabled !== undefined ? providerBlock.enabled : file.enabled !== false;
    const passthrough = env.BILI_RESIGN_PASSTHROUGH !== undefined
        ? env.BILI_RESIGN_PASSTHROUGH === "1" || env.BILI_RESIGN_PASSTHROUGH === "true"
        : providerBlock.passthrough !== undefined
            ? providerBlock.passthrough
            : file.passthrough === true;
    const credentialRef = env.BILI_CODEARTS_REF?.trim() || providerBlock.credentialRef || file.credentialRef || undefined;
    return { enabled, passthrough, credentialRef };
}

// #2260(B)/#2090: pre-v0.1.186 configs may carry `passthrough: true` under a
// NON-built-in scheme key. Since the compress-or-refuse contract the unsigned
// pass-through exists ONLY for sdk-hmac-sha256 (both guard sites gate on it),
// so such a key is inert while its requests stay refused — "my opt-in does
// nothing". Name the dead key(s) at config load instead of letting the 403
// body be the only signal. Dedup by dead-key signature (#1815 style): re-warn
// when the set changes, stay quiet while it stays fixed or empty.
let inertResignPassthroughSignature: string | null = null;
/** #2607 follow-up: `compress.stripImages` was REMOVED — default media folding
 *  (#2640) replaced it, and the strip itself was a turn-over-turn prompt-cache
 *  breaker on three of four wires (sliding cutoff). Old configs that still set
 *  the keys get this one-time inert notice instead of silent no-op (the parse
 *  whitelist simply no longer carries the fields). */
function warnInertStripImages(obj: Record<string, unknown>): void {
    const compress = obj.compress;
    if (!compress || typeof compress !== "object" || Array.isArray(compress)) return;
    const hit = ["stripImages", "stripImagesKeepRecent"].filter((k) => (compress as Record<string, unknown>)[k] !== undefined);
    const sig = hit.join(",");
    if (sig === "" || sig === seenInertStripImagesSignature) return;
    seenInertStripImagesSignature = sig;
    loggerLog("warn", `[acp-config] compress.${hit.join("/compress.")} is INERT — compress.stripImages was removed: media now folds by default (#2640) and decompress({ imageRef }) recovers folded pixels; nothing is stripped from the wire anymore. Remove the key(s) from the config.`);
}
let seenInertStripImagesSignature = "";

// #3344: compress.imageCompression was REMOVED wholesale (#3266, image
// pre-compression + the image_full restore channel). Old configs that still set
// it get a one-time inert notice instead of a silent no-op: the parse whitelist
// (COMPRESS_SETTING_FIELDS) no longer carries the field, so it is dropped at
// EVERY compress level it can appear (global / provider / model). (`absorb` was
// removed by #3293 but REVIVED by #3402/#3422 — it parses again and is NOT inert.)
// Dedup by dead-key path signature (#1815 style): re-warn when the set changes.
const INERT_REMOVED_COMPRESS_KEYS = ["imageCompression"] as const;
let seenInertRemovedCompressKeysSignature = "";
function warnInertRemovedCompressKeys(obj: Record<string, unknown>): void {
    const hits: string[] = [];
    const scanBlock = (block: unknown, pathPrefix: string): void => {
        if (!block || typeof block !== "object" || Array.isArray(block)) return;
        for (const key of INERT_REMOVED_COMPRESS_KEYS) {
            if ((block as Record<string, unknown>)[key] !== undefined) hits.push(`${pathPrefix}.${key}`);
        }
    };
    scanBlock(obj.compress, "compress");
    const providers = obj.providers;
    if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        for (const [url, entry] of Object.entries(providers as Record<string, unknown>)) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            const p = entry as Record<string, unknown>;
            scanBlock(p.compress, `providers["${url}"].compress`);
            const models = p.models;
            if (models && typeof models === "object" && !Array.isArray(models)) {
                for (const [model, mEntry] of Object.entries(models as Record<string, unknown>)) {
                    if (!mEntry || typeof mEntry !== "object" || Array.isArray(mEntry)) continue;
                    scanBlock((mEntry as Record<string, unknown>).compress, `providers["${url}"].models["${model}"].compress`);
                }
            }
        }
    }
    hits.sort();
    const sig = hits.join(",");
    if (sig === "" || sig === seenInertRemovedCompressKeysSignature) return;
    seenInertRemovedCompressKeysSignature = sig;
    loggerLog("warn", `[acp-config] ${hits.join(", ")} is INERT — compress.imageCompression was removed and no longer does anything at any level (image pre-compression + image_full restore channel, #3266). Remove it from the config; images pass through byte-identical.`);
}

function warnInertResignPassthrough(obj: Record<string, unknown>): void {
    const inert: string[] = [];
    const consider = (map: unknown, providerBlockFor: (key: string) => ResignFileSettings | undefined): void => {
        if (!map || typeof map !== "object" || Array.isArray(map)) return;
        for (const [key, val] of Object.entries(map as Record<string, unknown>)) {
            if (key === RESIGN_BUILTIN_SCHEME) continue;
            const block = val !== null && typeof val === "object" && !Array.isArray(val) ? (val as Record<string, unknown>) : {};
            if (block["passthrough"] !== true) continue;
            // Same enabled cascade as resolveResignSettings (env > provider >
            // file > default-true), read straight off the parsed object so the
            // hook never re-enters loadConfigFile (it runs mid-parse).
            const fileBlock = ((obj.resign as Record<string, ResignFileSettings> | undefined) ?? {})[key];
            const providerBlock = providerBlockFor(key);
            const enabled = process.env.BILI_RESIGN !== undefined
                ? process.env.BILI_RESIGN !== "0"
                : providerBlock?.enabled !== undefined
                    ? providerBlock.enabled
                    : fileBlock?.enabled !== false;
            if (enabled) inert.push(key);
        }
    };
    consider(obj.resign, () => undefined);
    const providers = obj.providers;
    if (providers && typeof providers === "object" && !Array.isArray(providers)) {
        for (const entry of Object.values(providers as Record<string, unknown>)) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
            const pmap = (entry as Record<string, unknown>).resign;
            if (pmap === undefined) continue;
            consider(pmap, (key) => ((pmap as Record<string, ResignFileSettings> | undefined) ?? {})[key]);
        }
    }
    inert.sort();
    const sig = inert.join(",");
    if (sig === "" || sig === inertResignPassthroughSignature) return;
    inertResignPassthroughSignature = sig;
    const list = inert.map((k) => `resign["${k}"].passthrough`).join(", ");
    loggerLog("warn", `[acp-config] ${list}=true is INERT — since the #2090 compress-or-refuse contract, unsigned pass-through exists ONLY for the built-in scheme "${RESIGN_BUILTIN_SCHEME}"; those signed requests stay REFUSED until bili ships a re-signer for them. Restore pre-resign handling with resign["<scheme>"].enabled=false or BILI_RESIGN=0 (the upstream will then reject the rewritten bodies).`);
}

/** #1660: the self-managed zone port base. Every launcher-spawned lane
 *  binds here by default instead of an OS-assigned ephemeral port: a stable
 *  origin survives instance death, and the proxy child's EADDRINUSE ladder
 *  (+1 per attempt) resolves collisions deterministically with a sticky
 *  record (instance.ts port-zone.json). 18787 sits below the Linux ephemeral
 *  range (32768–60999) so the ladder never lands on OS-assigned ports; 8787
 *  stays reserved as the USER zone (manual `bili start`). Env BILI_ZONE_PORT
 *  overrides the base for the whole zone. */
export const ZONE_PORT_BASE = 18787;

export function resolveZonePortBase(env: NodeJS.ProcessEnv = process.env): number {
    const fromEnv = Number.parseInt(env.BILI_ZONE_PORT ?? "", 10);
    if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
    return ZONE_PORT_BASE;
}

/** #1660: an explicit user override of the claude lane's port: env
 *  BILI_CLAUDE_NATIVE_PORT > config `claude.nativePort` > undefined. A
 *  DEFINED value means a strict-port launch (an EADDRINUSE at bind fails
 *  loud, #964); undefined means the lane's sticky zone port
 *  (instance.ts lanePreferredPort) with the +1 ladder absorbing collisions.
 *  The installer no longer persists this — zone drift is repaired by the
 *  SessionStart hook rewriting the managed block to the live origin every
 *  session. */
export function resolveClaudeNativePort(env: NodeJS.ProcessEnv = process.env): number | undefined {
    const fromEnv = Number.parseInt(env.BILI_CLAUDE_NATIVE_PORT ?? "", 10);
    if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
    const fromFile = loadConfigFile().claude?.nativePort;
    if (typeof fromFile === "number" && Number.isInteger(fromFile) && fromFile > 0 && fromFile < 65536) return fromFile;
    return undefined;
}

/** #1660: explicit override of the zcode lane's port (env only — the store
 *  is re-derived at every bootstrap, nothing is baked at install time).
 *  Defined means a strict-port launch; undefined means the lane's sticky
 *  zone port. Legacy wrappers pinned to the old 48789 default are migrated
 *  by the bootstrap's origin-drift repair (routeZcodeConfig rewrites the
 *  store to the live origin). */
export function resolveZcodeNativePort(env: NodeJS.ProcessEnv = process.env): number | undefined {
    const fromEnv = Number.parseInt(env.BILI_ZCODE_PORT ?? "", 10);
    if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
    return undefined;
}

/** Client-side routing exemptions (#1622): providers whose route declares
 *  `direct: true` are never pointed through bili by store-rewriting native
 *  lanes. Returns the normalized URL keys (the same key space findRoute
 *  matches against). */
export function zcodeDirectPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
    const routes = loadRoutes(env);
    return Object.entries(routes).filter(([, r]) => r.direct === true).map(([k]) => k);
}

/** #1335: the native-hook attach-gate escape hatch. True when the user
 *  deliberately runs lifecycle-less resident daemons for native hooks to ride:
 *  env BILI_NATIVE_ATTACH_EXTERNAL (1/true vs 0/false) wins over the file's
 *  `native.attachExternal`, which must be exactly `true` (any other value —
 *  including garbage — leaves the gate closed). Default false. */
export function resolveNativeAttachExternal(env: NodeJS.ProcessEnv = process.env): boolean {
    const fromEnv = (env.BILI_NATIVE_ATTACH_EXTERNAL ?? "").trim().toLowerCase();
    if (fromEnv === "1" || fromEnv === "true") return true;
    if (fromEnv === "0" || fromEnv === "false") return false;
    return loadConfigFile().native?.attachExternal === true;
}

/** #2905: ordered cross-lane attach fallbacks for native hooks (see the
 *  `native.attachLanePriority` field docs). Normalized: non-array/garbage →
 *  [], string elements trimmed + deduped, empty entries dropped. */
export function resolveNativeAttachLanePriority(): string[] {
    const raw = loadConfigFile().native?.attachLanePriority;
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== "string") continue;
        const t = item.trim();
        if (t.length > 0 && !out.includes(t)) out.push(t);
    }
    return out;
}

/** #3373: the /__bili/ admin relay gate (fail-closed). Read per use — the
 *  config file cache makes this cheap and hot edits apply without a host
 *  restart. */
export function adminRelayEnabled(): boolean {
    return loadConfigFile().security?.adminRelay === true;
}

/** #2877: the native-hook discovery policy. "own-lane" (default) rides only a
 *  same-lane daemon and never falls back to a lane-less / user-zone one;
 *  "global-fallback" restores the pre-#2877 fallback. Env
 *  BILI_NATIVE_ATTACH_POLICY wins over the file's native.attachPolicy; any
 *  unrecognized value leaves the default "own-lane". */
export function resolveNativeAttachPolicy(env: NodeJS.ProcessEnv = process.env): "own-lane" | "global-fallback" {
    const norm = (v: string | undefined) => (v ?? "").trim().toLowerCase();
    const fromEnv = norm(env.BILI_NATIVE_ATTACH_POLICY);
    if (fromEnv === "global-fallback" || fromEnv === "global") return "global-fallback";
    if (fromEnv === "own-lane" || fromEnv === "ownlane" || fromEnv === "strict") return "own-lane";
    const file = norm(loadConfigFile().native?.attachPolicy);
    if (file === "global-fallback" || file === "global") return "global-fallback";
    return "own-lane";
}

/** #2877: an explicit attach target origin (any URL, local or remote). When
 *  present a hook attaches only to that origin instead of discovering. Env
 *  BILI_MCP_PROXY (also set by --origin) wins over the file's native.attachUrl;
 *  empty/whitespace values are treated as unset. */
export function resolveNativeAttachUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const fromEnv = (env.BILI_MCP_PROXY ?? "").trim();
    if (fromEnv.length > 0) return fromEnv;
    const file = (loadConfigFile().native?.attachUrl ?? "").trim();
    return file.length > 0 ? file : undefined;
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
        const obj = v as { models?: Record<string, ModelEntry>; proxy?: string; compressProtocol?: string; protocol?: unknown; compress?: CompressSettings; cacheKeepalive?: unknown; compat?: { roles?: unknown; dropFields?: unknown }; passthrough?: boolean; direct?: boolean; imageBilling?: unknown; imageTokenCap?: unknown; calibration?: unknown; baseUrl?: unknown; api?: unknown; apiKeyEnv?: unknown; credentialRef?: unknown };
        const route: ProviderRoute = { models: obj.models };
        if (typeof obj.proxy === "string") route.proxy = obj.proxy;
        if (obj.compressProtocol === "marker" || obj.compressProtocol === "tools") route.compressProtocol = obj.compressProtocol;
        const declaredProtocol = parseDeclaredWireProtocol(obj.protocol);
        if (declaredProtocol !== undefined) route.protocol = declaredProtocol;
        if (obj.compress) route.compress = obj.compress;
        const cacheKeepalive = parseCacheKeepaliveSettings(obj.cacheKeepalive);
        if (cacheKeepalive) route.cacheKeepalive = cacheKeepalive;
        // Per-model keepalive blocks share the same strict parser (#1909
        // stance) — validation only; well-formed entries pass through as-is.
        for (const raw of Object.values(obj.models ?? {})) {
            if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "cacheKeepalive")) {
                parseCacheKeepaliveSettings(raw.cacheKeepalive);
            }
        }
        const compat: ProviderRoute["compat"] = {};
        const compatRoles = parseCompatRoles(obj.compat?.roles);
        if (compatRoles) compat.roles = compatRoles;
        const compatDrops = parseCompatDropFields(obj.compat?.dropFields);
        if (compatDrops) compat.dropFields = compatDrops;
        if (Object.keys(compat).length > 0) route.compat = compat;
        if (typeof obj.passthrough === "boolean") route.passthrough = obj.passthrough;
        if (typeof obj.direct === "boolean") route.direct = obj.direct;
        const imageBilling = parseImageBilling(obj.imageBilling);
        if (imageBilling) route.imageBilling = imageBilling;
        const imageTokenCap = parseImageTokenCap(obj.imageTokenCap);
        if (imageTokenCap !== undefined) route.imageTokenCap = imageTokenCap;
        const calibration = parseCalibrationPolicy(obj.calibration);
        if (calibration) route.calibration = calibration;
        // #2336 lane credential override. Only parsed for NON-recipe-shaped
        // entries: a dialing recipe (baseUrl/api present) validates its own
        // credential fields in parseNamedProviderRecipe, and letting this
        // parser run first would surface recipe errors with route-flavored
        // wording. A named non-recipe entry carrying `bind` folds these onto
        // the bound lane via fillRouteGaps (generic field copy) — free.
        if (obj.baseUrl === undefined && obj.api === undefined) {
            if (obj.apiKeyEnv !== undefined || obj.credentialRef !== undefined) {
                if (obj.apiKeyEnv !== undefined && obj.credentialRef !== undefined)
                    throw new Error("[acp-config] providers entry carries both apiKeyEnv and credentialRef — exactly one lane credential is allowed");
                if (obj.apiKeyEnv !== undefined) {
                    if (typeof obj.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(obj.apiKeyEnv))
                        throw new Error(`[acp-config] providers entry apiKeyEnv must be an environment variable name (got ${JSON.stringify(obj.apiKeyEnv)})`);
                    route.apiKeyEnv = obj.apiKeyEnv;
                } else {
                    if (typeof obj.credentialRef !== "string" || !validSummaryCredentialName(obj.credentialRef))
                        throw new Error(`[acp-config] providers entry credentialRef must be a name in the summary-credential store (got ${JSON.stringify(obj.credentialRef)})`);
                    route.credentialRef = obj.credentialRef;
                }
            }
        }
        return route;
    }
    // A bare value (e.g. null) means "this upstream exists, no overrides".
    if (v === null) return {};
    return undefined;
}

function parseImageBilling(value: unknown): ImageBillingMode | undefined {
    return value === "auto" || value === "pixels" || value === "bytes" ? value : undefined;
}

/** Strict #1909 validation: an invalid providers.protocol value THROWS
 *  (config-load failure / web 400) instead of being silently dropped — a
 *  dropped declaration would leave the user staring at "unrecognized path"
 *  passthrough logs with no signal about why their config had no effect. */
function parseDeclaredWireProtocol(v: unknown): WireProtocol | undefined {
    if (v === undefined) return undefined;
    if (v === "anthropic" || v === "openai" || v === "responses" || v === "google") return v;
    throw new Error(`[acp-config] providers.protocol must be one of: anthropic, openai, responses, google (got ${JSON.stringify(v)})`);
}

/** #1843 L3: per-image token ceiling — positive integer only (lenient like
 *  parseImageBilling: anything else is dropped, never a throw). */
export function parseImageTokenCap(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// #3211: same strict-#1909 stance as parseDeclaredWireProtocol — an invalid
// calibration policy THROWS instead of being silently dropped, because a
// dropped escape hatch leaves the user staring at pressure-band churn with no
// signal that their config had no effect. `max` above the publication clamp
// (4) is rejected as provably inert rather than accepted dead weight.
export function parseCalibrationPolicy(value: unknown): { disabled?: boolean; max?: number } | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`[acp-config] providers entry calibration must be an object with "disabled" and/or "max" (got ${JSON.stringify(value)})`);
    const vo = value as Record<string, unknown>;
    for (const key of Object.keys(vo)) {
        if (key !== "disabled" && key !== "max")
            throw new Error(`[acp-config] providers entry calibration has unknown key "${key}" (allowed: disabled, max)`);
    }
    const out: { disabled?: boolean; max?: number } = {};
    if ("disabled" in vo) {
        if (typeof vo.disabled !== "boolean")
            throw new Error(`[acp-config] providers entry calibration.disabled must be a boolean (got ${JSON.stringify(vo.disabled)})`);
        out.disabled = vo.disabled;
    }
    if ("max" in vo) {
        const m = vo.max;
        if (typeof m !== "number" || !Number.isFinite(m) || m <= 0 || m > 4)
            throw new Error(`[acp-config] providers entry calibration.max must be a number > 0 and <= 4 (got ${JSON.stringify(m)})`);
        out.max = m;
    }
    if (out.disabled === undefined && out.max === undefined)
        throw new Error('[acp-config] providers entry calibration requires at least one of "disabled" or "max"');
    return out;
}

// #3376: strict #1909-stance validation — an invalid cacheKeepalive value
// THROWS (config-load failure) instead of being silently dropped, so a
// typo'd keepalive config can't leave the user wondering why idle sessions
// cold-rebuild every time.
const CACHE_KEEPALIVE_FIELDS = ["enabled", "ttlFactor", "maxDurationMs", "maxConcurrentPings", "assumeTtl", "armWithoutBreakpoints", "intervalMs"] as const;

export function parseCacheKeepaliveSettings(v: unknown): CacheKeepaliveSettings | undefined {
    if (v === undefined) return undefined;
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw new Error(`[acp-config] cacheKeepalive must be an object of optional fields (got ${JSON.stringify(v)})`);
    const obj = v as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
        if (!(CACHE_KEEPALIVE_FIELDS as readonly string[]).includes(key))
            throw new Error(`[acp-config] cacheKeepalive has unknown key "${key}" (allowed: ${CACHE_KEEPALIVE_FIELDS.join(", ")})`);
    }
    const out: CacheKeepaliveSettings = {};
    if ("enabled" in obj) {
        if (typeof obj.enabled !== "boolean")
            throw new Error(`[acp-config] cacheKeepalive.enabled must be a boolean (got ${JSON.stringify(obj.enabled)})`);
        out.enabled = obj.enabled;
    }
    if ("ttlFactor" in obj) {
        const n = obj.ttlFactor;
        if (typeof n !== "number" || !Number.isFinite(n) || !(n > 0 && n <= 1))
            throw new Error(`[acp-config] cacheKeepalive.ttlFactor must be a number in (0, 1] (got ${JSON.stringify(n)})`);
        out.ttlFactor = n;
    }
    for (const key of ["maxDurationMs", "maxConcurrentPings", "intervalMs"] as const) {
        if (key in obj) {
            const n = obj[key];
            if (typeof n !== "number" || !Number.isInteger(n) || n <= 0)
                throw new Error(`[acp-config] cacheKeepalive.${key} must be a positive integer ms/count (got ${JSON.stringify(n)})`);
            out[key] = n;
        }
    }
    if ("assumeTtl" in obj) {
        if (obj.assumeTtl !== "5m" && obj.assumeTtl !== "1h")
            throw new Error(`[acp-config] cacheKeepalive.assumeTtl must be "5m" or "1h" (got ${JSON.stringify(obj.assumeTtl)})`);
        out.assumeTtl = obj.assumeTtl;
    }
    if ("armWithoutBreakpoints" in obj) {
        if (typeof obj.armWithoutBreakpoints !== "boolean")
            throw new Error(`[acp-config] cacheKeepalive.armWithoutBreakpoints must be a boolean (got ${JSON.stringify(obj.armWithoutBreakpoints)})`);
        out.armWithoutBreakpoints = obj.armWithoutBreakpoints;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function parseStreamErrorShape(value: unknown): "protocol" | "completion" {
    return value === "completion" ? "completion" : "protocol";
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
    if (obj.externalSummary !== undefined) {
        try { out.externalSummary = parseExternalSummaryChain(obj.externalSummary); }
        catch (error) {
            // Keep the "unparseable values reject the whole compress block"
            // contract, but make the rejection VISIBLE with the specific
            // reason — silently dropping the block also reverts custom
            // prompts/knobs to defaults, which must never pass unnoticed.
            loggerLog("warn", `[config] compress.externalSummary is invalid (${error instanceof Error ? error.message : String(error)}); ignoring the whole compress section`);
            return undefined;
        }
    }
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
    for (const key of ["nudgeGrowthTokens", "preserveRecentMessages", "preserveRecentTokens", "minCompressRange", "minCompressRangeChars"] as const) {
        takeNumber(key);
    }
    // #3635: summary-length caps map onto kernel compress.{max,min}SummaryLength.
    // 0 is meaningful (unbounded cap / disabled floor), negative is not — so
    // validate stricter than takeNumber instead of reusing it.
    for (const key of ["maxSummaryLength", "minSummaryLength"] as const) {
        if (!(key in obj)) continue;
        const v = obj[key];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) ok = false;
        else (out as Record<string, unknown>)[key] = v;
    }
    // #2228: the decision side-call budget must be positive — 0/negative would
    // starve the call, so validate stricter than takeNumber.
    if ("nudgeDecisionMaxTokens" in obj) {
        const v = obj.nudgeDecisionMaxTokens;
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
            ok = false;
        } else {
            out.nudgeDecisionMaxTokens = Math.floor(v);
        }
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
    if ("tierNudgeTokens" in obj && obj.tierNudgeTokens !== undefined) {
        const v = obj.tierNudgeTokens;
        if (!v || typeof v !== "object" || Array.isArray(v)) {
            ok = false;
        } else {
            const vo = v as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["tierNudgeTokens"]> = {};
            for (const key of ["t1", "t2", "t3"] as const) {
                if (!(key in vo)) continue;
                const x = vo[key];
                if (typeof x !== "number" || !Number.isFinite(x) || x < 1) { ok = false; continue; }
                cleaned[key] = x;
            }
            if (ok && Object.keys(cleaned).length > 0) out.tierNudgeTokens = cleaned;
        }
    }
    if ("nudgeModelDecided" in obj) {
        if (typeof obj.nudgeModelDecided !== "boolean") ok = false;
        else out.nudgeModelDecided = obj.nudgeModelDecided;
    }
    // #3211: an explicit 0 is meaningful (legacy any-pending), so validate
    // >= 0 instead of takeNumber's plain finite check.
    if ("minPressureBenefitTokens" in obj) {
        const v = obj.minPressureBenefitTokens;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) ok = false;
        else out.minPressureBenefitTokens = Math.floor(v);
    }
    for (const key of ["protectedLatestTools", "protectedTools"] as const) {
        if (!(key in obj) || obj[key] === undefined) continue;
        const v = obj[key];
        if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || x.trim().length === 0)) ok = false;
        else (out as Record<string, unknown>)[key] = (v as string[]).map((x) => x.trim());
    }
    // neverPreserveRecentTools keeps the kernel semantics that an explicit
    // empty array is meaningful (excludes nothing — the #1198/#1277 escape
    // hatch), so unlike the two protectedTools knobs an empty array passes.
    if ("neverPreserveRecentTools" in obj && obj.neverPreserveRecentTools !== undefined) {
        const v = obj.neverPreserveRecentTools;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim().length === 0)) ok = false;
        else out.neverPreserveRecentTools = (v as string[]).map((x) => x.trim());
    }
    // preserveRecentTools is a pure no-op when empty, so — like the
    // protectedTools knobs — an empty array is rejected (a bare [] here is
    // almost certainly a typo for neverPreserveRecentTools: []).
    if ("preserveRecentTools" in obj && obj.preserveRecentTools !== undefined) {
        const v = obj.preserveRecentTools;
        if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== "string" || x.trim().length === 0)) ok = false;
        else out.preserveRecentTools = (v as string[]).map((x) => x.trim());
    }
    if ("visibilityMarkers" in obj) {
        if (typeof obj.visibilityMarkers !== "boolean") ok = false;
        else out.visibilityMarkers = obj.visibilityMarkers;
    }
    if ("streamSummary" in obj) {
        if (typeof obj.streamSummary !== "boolean") ok = false;
        else out.streamSummary = obj.streamSummary;
    }
    if ("rules" in obj) {
        if (typeof obj.rules !== "boolean") ok = false;
        else out.rules = obj.rules;
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
            for (const key of ["enabled", "minToolTokens", "contextThresholdPct", "excludeTools", "toolName", "mediaOnly"] as const) {
                if (!(key in ao)) continue;
                const v = ao[key];
                if (key === "enabled" || key === "mediaOnly") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    if (key === "enabled") cleaned.enabled = v;
                    else cleaned.mediaOnly = v;
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
    if ("ccr" in obj && obj.ccr !== undefined) {
        const c = obj.ccr;
        if (!c || typeof c !== "object" || Array.isArray(c)) {
            ok = false;
        } else {
            const co = c as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["ccr"]> = {};
            for (const key of ["enabled", "minToolTokens", "excludeTools", "toolName", "maxHeadChars"] as const) {
                if (!(key in co)) continue;
                const v = co[key];
                if (key === "enabled") {
                    if (typeof v !== "boolean") { ok = false; continue; }
                    cleaned.enabled = v;
                } else if (key === "minToolTokens" || key === "maxHeadChars") {
                    if (typeof v !== "number" || !Number.isFinite(v)) { ok = false; continue; }
                    cleaned[key] = v;
                } else if (key === "excludeTools") {
                    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) { ok = false; continue; }
                    cleaned.excludeTools = [...v] as string[];
                } else {
                    if (typeof v !== "string" || v.trim().length === 0) { ok = false; continue; }
                    cleaned.toolName = v.trim();
                }
            }
            if (ok) out.ccr = cleaned;
        }
    }
    if ("search" in obj && obj.search !== undefined) {
        const c = obj.search;
        if (!c || typeof c !== "object" || Array.isArray(c)) {
            ok = false;
        } else {
            const co = c as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["search"]> = {};
            for (const key of ["planAware"] as const) {
                if (!(key in co)) continue;
                const v = co[key];
                if (typeof v !== "boolean") { ok = false; continue; }
                cleaned.planAware = v;
            }
            if (ok) out.search = cleaned;
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
    if ("outputSteering" in obj && obj.outputSteering !== undefined) {
        const os = obj.outputSteering;
        if (!os || typeof os !== "object" || Array.isArray(os)) {
            ok = false;
        } else {
            // Shape-guard only: sub-field validation is the kernel resolver's job at
            // resolution time, so one out-of-range value can't nuke the whole block.
            out.outputSteering = os as Partial<OutputSteeringConfig>;
        }
    }
    if ("priceProfile" in obj && obj.priceProfile !== undefined) {
        const pp = obj.priceProfile;
        if (!pp || typeof pp !== "object" || Array.isArray(pp)) {
            ok = false;
        } else {
            const ppo = pp as Record<string, unknown>;
            const cleaned: NonNullable<CompressSettings["priceProfile"]> = {};
            for (const key of ["w", "r", "q", "inputPerMtok", "outputPerMtok", "cacheReadPerMtok", "cacheWritePerMtok"] as const) {
                if (!(key in ppo)) continue;
                const v = ppo[key];
                if (typeof v !== "number" || !Number.isFinite(v) || v < 0) { ok = false; continue; }
                cleaned[key] = v;
            }
            if (ok) out.priceProfile = cleaned;
        }
    }
    if (!ok) return undefined;
    return out;
}

export function rejectLegacyRoute(key: string, value: unknown): void {
    if (typeof value !== "string") return;
    const masked = maskUrlForLog(value);
    throw new Error(
        `[acp-config] legacy provider route \"${key}\": \"${masked}\" is no longer valid; ` +
        `use the upstream URL as the key, for example { \"${masked.replace(/\/+$/, "")}\": {} }`,
    );
}
