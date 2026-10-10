import { log as loggerLog } from "./logger.js";
import type { NamedProviderRecipe } from "./config.js";
import type { SummaryBudget } from "./external-summary.js";
import type { PreflightProtocol } from "./preflight.js";

interface ExternalSummaryTarget {
    name: string;
    protocol: PreflightProtocol;
    url: string;
    model: string;
    /** Reference form (env:VAR / secret:NAME) — exactly one of
     *  credentialRef/apiKey is set. apiKey is the #2336 agent-registry form:
     *  a key resolved in the agent's memory (never persisted to a file),
     *  accepted only on the request rail (parseExternalSummarySettings
     *  inlineKeys mode) — the file/legacy form rejects it. */
    credentialRef?: string;
    apiKey?: string;
    contextWindow: number;
    outputTokens: number;
    stream: boolean;
}

export interface ExternalSummarySettings {
    enabled: boolean;
    targets: ExternalSummaryTarget[];
    budget: SummaryBudget;
    /** [#2657] Shared summary-queue pool size while this chain's work is in
     *  flight: integer [SUMMARY_CONCURRENCY_MIN, SUMMARY_CONCURRENCY_MAX],
     *  default SUMMARY_CONCURRENCY_DEFAULT. Absent → the executor's base
     *  size; present → the pool grows to it for the batch lifetime (the
     *  largest request among in-flight batches wins; see the executor). */
    concurrency?: number;
    /** [#autoFold] Proxy-driven growth folding: when true, preflight folds
     *  the conversation down to `autoFoldTargetTokens` (default half the
     *  model window) BEFORE forwarding — the model never sees a nudge and
     *  never drafts compression plans. Requires the chain itself to stay
     *  enabled; an unresolvable target disables the chain and thus the
     *  auto-fold (nudges come back). */
    autoFold?: boolean;
    autoFoldTargetTokens?: number;
}

/** A chain as it sits in the config file: model references into the named
 *  providers table (`"glm/glm-4.9-flash"`), resolved against the recipes at
 *  request-config time. The rail carries only EXPANDED settings. */
export interface ExternalSummaryChain {
    enabled: boolean;
    targets: string[];
    budget?: SummaryBudget;
    concurrency?: number;
    autoFold?: boolean;
    autoFoldTargetTokens?: number;
}

const SUMMARY_DEFAULT_BUDGET: Readonly<SummaryBudget> = {
    totalTimeoutMs: 50_000, targetTimeoutMs: 25_000, maxSummaryBytes: 64 * 1024,
};

/** [#2657] Shared summary-queue pool size: one process-wide executor serves
 *  every session, so the knob sizes THAT pool (it cannot be per-session). */
const SUMMARY_CONCURRENCY_MIN = 1;
const SUMMARY_CONCURRENCY_MAX = 32;
export const SUMMARY_CONCURRENCY_DEFAULT = 4;

export function validSummaryCredentialName(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an external summary object");
    return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Unknown external summary setting; credentials must use credentialRef");
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
    const result = value === undefined ? fallback : value;
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid external summary budget");
    return result;
}

function text(value: unknown, limit: number): string {
    if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid external summary target");
    return value.trim();
}

export const AUTO_FOLD_TARGET_MIN = 8_192;
const AUTO_FOLD_TARGET_MAX = 10_000_000;

/** [#autoFold] Both parsers share the exact switch/target semantics: the
 *  target is only meaningful with the switch on; the switch defaults to
 *  half the model window at trigger time. */
function parseAutoFold(settings: Record<string, unknown>): { autoFold?: boolean; autoFoldTargetTokens?: number } {
    let autoFold: boolean | undefined;
    if (settings.autoFold !== undefined) {
        if (typeof settings.autoFold !== "boolean") throw new Error("External summary autoFold must be boolean");
        autoFold = settings.autoFold;
    }
    let autoFoldTargetTokens: number | undefined;
    if (settings.autoFoldTargetTokens !== undefined) {
        if (typeof settings.autoFoldTargetTokens !== "number" || !Number.isSafeInteger(settings.autoFoldTargetTokens)
            || settings.autoFoldTargetTokens < AUTO_FOLD_TARGET_MIN || settings.autoFoldTargetTokens > AUTO_FOLD_TARGET_MAX) {
            throw new Error(`External summary autoFoldTargetTokens must be an integer between ${AUTO_FOLD_TARGET_MIN} and ${AUTO_FOLD_TARGET_MAX}`);
        }
        autoFoldTargetTokens = settings.autoFoldTargetTokens;
    }
    // A target without the switch is inert config noise, not an error; the
    // switch without a target is the normal "half the window" default.
    if (autoFold !== true) return {};
    return { autoFold, ...(autoFoldTargetTokens !== undefined ? { autoFoldTargetTokens } : {}) };
}

/** [#2657] Pool sizing rides the same enabled-gate as autoFold: parsed only
 *  on an enabled chain, absent → undefined → the executor's base size. */
function parseConcurrency(settings: Record<string, unknown>): { concurrency?: number } {
    if (settings.concurrency === undefined) return {};
    const value = settings.concurrency;
    if (typeof value !== "number" || !Number.isSafeInteger(value)
        || value < SUMMARY_CONCURRENCY_MIN || value > SUMMARY_CONCURRENCY_MAX) {
        throw new Error(`External summary concurrency must be an integer between ${SUMMARY_CONCURRENCY_MIN} and ${SUMMARY_CONCURRENCY_MAX}`);
    }
    return { concurrency: value };
}

function parseBudget(raw: unknown): SummaryBudget {
    const rawBudget = raw === undefined ? {} : object(raw);
    knownKeys(rawBudget, ["totalTimeoutMs", "targetTimeoutMs", "maxSummaryBytes"]);
    // totalTimeoutMs bounds the WHOLE batch (one shared deadline across every
    // chunk); a big-session fold runs a dozen or more chunks, so the cap needs
    // real headroom. Long waits are safe — preflight holds the client with SSE
    // keep-alives past its undici body timeout (#2484/#1647).
    const totalTimeoutMs = integer(rawBudget.totalTimeoutMs, SUMMARY_DEFAULT_BUDGET.totalTimeoutMs, 100, 600_000);
    const targetTimeoutMs = integer(rawBudget.targetTimeoutMs, Math.min(SUMMARY_DEFAULT_BUDGET.targetTimeoutMs, totalTimeoutMs), 100, totalTimeoutMs);
    const maxSummaryBytes = integer(rawBudget.maxSummaryBytes, SUMMARY_DEFAULT_BUDGET.maxSummaryBytes, 128, 1024 * 1024);
    return { totalTimeoutMs, targetTimeoutMs, maxSummaryBytes };
}

const seenAutoFoldInertWarnings = new Set<string>();

/** [#autoFold] Surface the silent no-op: `autoFold`/`autoFoldTargetTokens` are
 *  read only once the chain is enabled (parseAutoFold runs after the enabled
 *  gate), so setting them on a disabled — or omitted-`enabled` — chain does
 *  nothing. Warn once per distinct knob-set instead of failing silently; purely
 *  diagnostic, changes no behavior. */
function noteAutoFoldIgnored(settings: Record<string, unknown>): void {
    const wantsAutoFold = settings.autoFold === true;
    const hasTarget = settings.autoFoldTargetTokens !== undefined;
    if (!wantsAutoFold && !hasTarget) return;
    const sig = `${wantsAutoFold ? "f" : "-"}:${hasTarget ? "t" : "-"}`;
    if (seenAutoFoldInertWarnings.has(sig)) return;
    seenAutoFoldInertWarnings.add(sig);
    const knobs = `${wantsAutoFold ? "autoFold" : ""}${wantsAutoFold && hasTarget ? " + " : ""}${hasTarget ? "autoFoldTargetTokens" : ""}`;
    loggerLog("warn", `[external-summary] ${knobs} set but "enabled" is not true — the chain is off, so it has no effect. Set "enabled": true to activate auto-fold.`);
}

/** External summary chain, three-level like every other `compress` field:
 *  a deeper level (provider or model) replaces the whole chain — no per-target
 *  or per-budget sub-merge. Syntax level only: references are validated
 *  against the providers table at expansion time (expandExternalSummaryChain). */
export function parseExternalSummaryChain(value: unknown): ExternalSummaryChain {
    const settings = object(value);
    knownKeys(settings, ["enabled", "targets", "budget", "concurrency", "autoFold", "autoFoldTargetTokens"]);
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error("External summary enabled must be boolean");
    const enabled = settings.enabled === true;
    if (!enabled) {
        noteAutoFoldIgnored(settings);
        // A disabled chain never reads targets or budget — rejecting the
        // whole compress block over a stale typo here would disable
        // compression itself. Strict validation re-engages the moment the
        // (possibly deeper-level) chain is enabled.
        return { enabled: false, targets: [], budget: SUMMARY_DEFAULT_BUDGET };
    }
    if (settings.targets !== undefined && !Array.isArray(settings.targets)) throw new Error("External summary targets must be an array of \"provider/model\" references");
    const refs = (settings.targets ?? []) as unknown[];
    if (refs.length > 16 || refs.length === 0) throw new Error("External summary requires 1 to 16 targets when enabled");
    const targets = refs.map((ref) => {
        const target = text(ref, 256);
        const slash = target.indexOf("/");
        if (slash <= 0 || slash === target.length - 1) throw new Error(`External summary target "${target}" must reference a provider and model as "provider/model"`);
        return target;
    });
    return { enabled, targets, budget: parseBudget(settings.budget), ...parseConcurrency(settings), ...parseAutoFold(settings) };
}

/** Expand chain references against the named providers table. THROWS on an
 *  unresolvable reference — callers decide the failure policy (web save:
 *  400; request path: warn + treat the chain as disabled, never brick the
 *  request over a config typo). Recipes may carry an in-memory `apiKey`
 *  (#2336 agent-registry form) — it expands to an inline-key target instead
 *  of a credential reference. */
export function expandExternalSummaryChain(chain: ExternalSummaryChain, recipes: Record<string, NamedProviderRecipe & { apiKey?: string }>): ExternalSummarySettings {
    if (!chain.enabled) return { enabled: false, targets: [], budget: chain.budget ?? SUMMARY_DEFAULT_BUDGET };
    const names = new Set<string>();
    const targets = chain.targets.map((ref): ExternalSummaryTarget => {
        const slash = ref.indexOf("/");
        const providerName = ref.slice(0, slash);
        const model = ref.slice(slash + 1);
        const recipe = recipes[providerName];
        if (!recipe) throw new Error(`External summary target "${ref}" references unknown provider "${providerName}" (known: ${Object.keys(recipes).sort().join(", ") || "none"})`);
        const knobs = recipe.models[model];
        if (!knobs) throw new Error(`External summary target "${ref}" references unknown model "${model}" on provider "${providerName}" (known: ${Object.keys(recipe.models).sort().join(", ")})`);
        let name = `${providerName}--${model}`.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
        if (!validSummaryCredentialName(name) || names.has(name)) name = `${providerName}-${names.size}`;
        names.add(name);
        const contextWindow = integer(knobs.contextWindow, 128_000, 2048, 10_000_000);
        const outputTokens = integer(knobs.outputTokens, Math.min(8192, Math.floor(contextWindow / 4)), 128, contextWindow - 1);
        if (knobs.stream !== undefined && typeof knobs.stream !== "boolean") throw new Error("External summary stream must be boolean");
        const stream = knobs.stream === true;
        const inlineKey = recipe.apiKey;
        const credentialRef = recipe.apiKeyEnv ? `env:${recipe.apiKeyEnv}` : `secret:${recipe.credentialRef}`;
        return { name, protocol: recipe.api, url: derivedSummaryEndpoint(recipe, model, stream), model, ...(inlineKey !== undefined ? { apiKey: inlineKey } : { credentialRef }), contextWindow, outputTokens, stream };
    });
    return { enabled: true, targets, budget: chain.budget ?? SUMMARY_DEFAULT_BUDGET
        , ...(chain.concurrency !== undefined ? { concurrency: chain.concurrency } : {}), ...parseAutoFold(chain as unknown as Record<string, unknown>) };
}

/** Derive the full request endpoint from a recipe's baseUrl + api type —
 *  the pi/opencode idiom: users give a base, the protocol's path is ours.
 *  The derived URL passes the same endpoint guard as an explicit one. */
function derivedSummaryEndpoint(recipe: NamedProviderRecipe, model: string, stream: boolean): string {
    const base = recipe.baseUrl.replace(/\/+$/, "");
    let path: string;
    if (recipe.api === "google") {
        path = `/models/${encodeURIComponent(model.replace(/^models\//, ""))}:${stream ? "streamGenerateContent" : "generateContent"}`;
    } else {
        const suffix = recipe.api === "anthropic" ? "/messages" : recipe.api === "openai" ? "/chat/completions" : "/responses";
        // Providers version their API root differently (/v1 openai+anthropic,
        // /v4 bigmodel, /api/paas …): a base that already ends in a version
        // segment gets only the method path appended.
        path = /\/+v\d+[a-z]*$/.test(base) ? suffix : `/v1${suffix}`;
    }
    const url = new URL(`${base}${path}`);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash
        || [...url.searchParams.keys()].some((key) => key !== "alt")
        || url.pathname.includes("/bili/") || url.pathname.startsWith("/__bili/")) throw new Error(`External summary endpoint derived from "${recipe.baseUrl}" is not usable; use HTTPS and no embedded credentials or proxy recursion`);
    return url.href;
}

/** EXPANDED-shape parser — the settings object as it rides the request
 *  Config rail after expandExternalSummaryChain. Re-parsed by
 *  ConfiguredSummaryPlan at execution time so a hand-built rail value gets
 *  the same validation as a file-driven one. `inlineKeys` (#2336) admits
 *  literal `apiKey` values on targets — the agent-registry recipes resolve
 *  their key in memory and hand bili the bytes; the FILE form keeps
 *  rejecting them (a plaintext key must never enter a config file). */
export function parseExternalSummarySettings(value: unknown, options: { inlineKeys?: boolean } = {}): ExternalSummarySettings {
    const inlineKeys = options.inlineKeys === true;
    const settings = object(value);
    knownKeys(settings, ["enabled", "targets", "budget", "concurrency", "autoFold", "autoFoldTargetTokens"]);
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") throw new Error("External summary enabled must be boolean");
    const enabled = settings.enabled === true;
    if (!enabled) {
        noteAutoFoldIgnored(settings);
        return { enabled: false, targets: [], budget: SUMMARY_DEFAULT_BUDGET };
    }
    if (settings.targets !== undefined && !Array.isArray(settings.targets)) throw new Error("External summary targets must be an array");
    const values = (settings.targets ?? []) as unknown[];
    if (values.length > 16 || values.length === 0) throw new Error("External summary requires 1 to 16 targets when enabled");
    const names = new Set<string>();
    const targets = values.map((value): ExternalSummaryTarget => {
        const target = object(value);
        knownKeys(target, inlineKeys ? ["name", "protocol", "url", "model", "credentialRef", "apiKey", "contextWindow", "outputTokens", "stream"] : ["name", "protocol", "url", "model", "credentialRef", "contextWindow", "outputTokens", "stream"]);
        const name = text(target.name, 64);
        if (!validSummaryCredentialName(name) || names.has(name)) throw new Error("External summary target names must be unique identifiers");
        names.add(name);
        const protocol = target.protocol;
        if (protocol !== "anthropic" && protocol !== "openai" && protocol !== "responses" && protocol !== "google") throw new Error("Invalid external summary protocol");
        const endpoint = text(target.url, 2048);
        let url: URL;
        try { url = new URL(endpoint); } catch { throw new Error("Invalid external summary endpoint"); }
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash
            || [...url.searchParams.keys()].some((key) => key !== "alt")
            || url.pathname.includes("/bili/") || url.pathname.startsWith("/__bili/")) throw new Error("Invalid external summary endpoint; use HTTPS and no embedded credentials or proxy recursion");
        const inlineKey = inlineKeys ? target.apiKey : undefined;
        if (inlineKey !== undefined && (typeof inlineKey !== "string" || inlineKey.length === 0 || inlineKey.length > 8192 || /[\x00-\x20\x7f]/.test(inlineKey))) throw new Error("Invalid external summary api key");
        if (inlineKey !== undefined && target.credentialRef !== undefined) throw new Error("External summary target carries both apiKey and credentialRef — exactly one credential is allowed");
        let credentialRef: string | undefined;
        if (inlineKey === undefined) {
            credentialRef = text(target.credentialRef, 128);
            if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRef)
                && !(credentialRef.startsWith("secret:") && validSummaryCredentialName(credentialRef.slice(7)))) throw new Error("Invalid external summary credential reference");
        }
        const contextWindow = integer(target.contextWindow, 128_000, 2048, 10_000_000);
        const outputTokens = integer(target.outputTokens, Math.min(8192, Math.floor(contextWindow / 4)), 128, contextWindow - 1);
        if (target.stream !== undefined && typeof target.stream !== "boolean") throw new Error("External summary stream must be boolean");
        const model = text(target.model, 200);
        if (protocol === "google") {
            const suffix = target.stream === true ? "streamGenerateContent" : "generateContent";
            if (!url.pathname.endsWith(`/models/${encodeURIComponent(model.replace(/^models\//, ""))}:${suffix}`)) throw new Error("Google summary endpoint must match the model and stream mode");
        }
        return { name, protocol, url: url.href, model, ...(inlineKey !== undefined ? { apiKey: inlineKey } : { credentialRef }), contextWindow, outputTokens, stream: target.stream === true };
    });
    return { enabled: true, targets, budget: parseBudget(settings.budget), ...parseConcurrency(settings), ...parseAutoFold(settings) };
}

const seenExpansionWarnings = new Set<string>();

/** Request-path expansion with the runtime failure policy: an unresolvable
 *  reference disables the chain for that request (warn once per signature) —
 *  a config typo must never 500 the proxy lane. The web save path uses the
 *  throwing expandExternalSummaryChain directly (400). */
export function expandExternalSummaryChainTolerant(chain: ExternalSummaryChain, recipes: Record<string, NamedProviderRecipe>): ExternalSummarySettings {
    try {
        return expandExternalSummaryChain(chain, recipes);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!seenExpansionWarnings.has(message)) {
            seenExpansionWarnings.add(message);
            loggerLog("warn", `[external-summary] ${message} — the chain is disabled until the reference is fixed`);
        }
        return { enabled: false, targets: [], budget: SUMMARY_DEFAULT_BUDGET };
    }
}
