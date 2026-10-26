import type { NamedProviderRecipe } from "./config.js";
import { validSummaryCredentialName } from "./external-summary-settings.js";
import { plainHttpTrusted } from "./private-host.js";
import { allowPrivateHttpProviders } from "./knobs.js";

/**
 * #2336 agent-registry fallback: a plugin host (pi today) reports its own
 * provider dialing recipes — baseUrl + api + the RESOLVED api key, in memory
 * only — so bili's named-providers table gains an agent-side fallback layer.
 * The owner's blueprint: bili's file recipes always WIN over the agent's
 * (merge order `{...agentProviderRecipes(), ...opts.namedProviders}`), and an
 * agent recipe never carries a credential REFERENCE — the key bytes are
 * resolved in the agent's process and live only inside bili's memory, never
 * in a config file, never in a log line, never in a GET response.
 *
 * Intake is the /__bili/agent-providers admin endpoint (loopback +
 * trusted-origin gated like every /__bili/* route): the payload is validated
 * structurally before it can influence an outbound summary request.
 */

type AgentProviderRecipe = NamedProviderRecipe & { apiKey: string };

const byAgent = new Map<string, Record<string, AgentProviderRecipe>>();

export function recordAgentProviders(agent: string, recipes: Record<string, AgentProviderRecipe>): void {
    // An empty re-report clears that agent's layer entirely (equals absent).
    if (Object.keys(recipes).length === 0) byAgent.delete(agent);
    else byAgent.set(agent, recipes);
}

/** Merged view across every registered agent (later agents overwrite earlier
 *  ones per provider name — one agent per process in practice). */
export function agentProviderRecipes(): Record<string, AgentProviderRecipe> {
    const out: Record<string, AgentProviderRecipe> = {};
    for (const recipes of byAgent.values()) Object.assign(out, recipes);
    return out;
}

/** For the web config GET: agent + provider NAMES only (with model ids so
 *  the summary panel can offer them as dropdown options) — no keys, no
 *  baseUrl. */
export function agentRegistryStatus(): Array<{ agent: string; providers: Array<{ name: string; models: string[] }> }> {
    return [...byAgent.entries()].map(([agent, recipes]) => ({
        agent,
        providers: Object.entries(recipes)
            .map(([name, recipe]) => ({ name, models: Object.keys(recipe.models).sort() }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

const APIS = new Set(["anthropic", "openai", "responses", "google"]);

// #2585: entry names and refusal reasons cross a log line AND the POST
// response — keep them single-line and bounded. Validation errors reference
// only names, urls and knob values, never key bytes.
export function sanitizeAgentProviderField(value: string, max: number): string {
    return value.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, max);
}

/** Structural validation of ONE provider entry. Throws with a reason that
 *  names the entry; never inspects or echoes the key beyond shape
 *  (non-empty printable, sane length). */
function parseAgentProviderEntry(name: string, value: unknown): AgentProviderRecipe {
    if (!validSummaryCredentialName(name)) throw new Error(`Invalid provider name "${name}"`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Provider "${name}" must be an object`);
    const recipe = value as { baseUrl?: unknown; api?: unknown; apiKey?: unknown; models?: unknown };
    if (typeof recipe.baseUrl !== "string" || recipe.baseUrl.length === 0 || recipe.baseUrl.length > 2048) throw new Error(`Provider "${name}" needs a baseUrl`);
    if (typeof recipe.api !== "string" || !APIS.has(recipe.api)) throw new Error(`Provider "${name}" api must be one of: anthropic, openai, responses, google`);
    if (typeof recipe.apiKey !== "string" || recipe.apiKey.length === 0 || recipe.apiKey.length > 8192 || /[\x00-\x20\x7f]/.test(recipe.apiKey)) throw new Error(`Provider "${name}" needs an apiKey`);
    let url: URL;
    try { url = new URL(recipe.baseUrl); } catch { throw new Error(`Provider "${name}" baseUrl is not a valid URL`); }
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && plainHttpTrusted(url, allowPrivateHttpProviders()))) || url.username || url.password || url.hash
        || url.pathname.includes("/bili/") || url.pathname.startsWith("/__bili/")) throw new Error(`Provider "${name}" baseUrl must be HTTPS (or loopback HTTP) without credentials or proxy recursion`);
    if (!recipe.models || typeof recipe.models !== "object" || Array.isArray(recipe.models)) throw new Error(`Provider "${name}" needs a models object`);
    const models = recipe.models as Record<string, { contextWindow?: unknown; outputTokens?: unknown; stream?: unknown }>;
    const modelEntries = Object.entries(models);
    if (modelEntries.length === 0 || modelEntries.length > 64) throw new Error(`Provider "${name}" needs 1 to 64 models`);
    const outModels: NamedProviderRecipe["models"] = {};
    for (const [model, knobs] of modelEntries) {
        if (model.length === 0 || model.length > 200) throw new Error(`Provider "${name}" has an invalid model name`);
        const parsed: { contextWindow?: number; outputTokens?: number; stream?: boolean } = {};
        if (knobs.contextWindow !== undefined) {
            if (typeof knobs.contextWindow !== "number" || !Number.isSafeInteger(knobs.contextWindow) || knobs.contextWindow < 2048 || knobs.contextWindow > 10_000_000) throw new Error(`Provider "${name}" model "${model}" has an invalid contextWindow`);
            parsed.contextWindow = knobs.contextWindow;
        }
        if (knobs.outputTokens !== undefined) {
            if (typeof knobs.outputTokens !== "number" || !Number.isSafeInteger(knobs.outputTokens) || knobs.outputTokens < 128) throw new Error(`Provider "${name}" model "${model}" has an invalid outputTokens`);
            parsed.outputTokens = knobs.outputTokens;
        }
        if (knobs.stream !== undefined) {
            if (typeof knobs.stream !== "boolean") throw new Error(`Provider "${name}" model "${model}" has an invalid stream flag`);
            parsed.stream = knobs.stream;
        }
        outModels[model] = parsed;
    }
    return { baseUrl: recipe.baseUrl.replace(/\/+$/, ""), api: recipe.api as NamedProviderRecipe["api"], apiKey: recipe.apiKey, models: outModels };
}

/** Structural intake validation for a registry POST body: `{ agent, providers }`.
 *  Top-level violations (no usable agent/providers envelope) still throw —
 *  nothing could be attributed without them. Entry-level violations are
 *  collected instead (#2585): one refused entry costs only itself, so the
 *  route answers 200 with `registered` + `skipped:[{name, reason}]` and the
 *  client can say which provider stays unresolved. */
export function parseAgentProviderReport(payload: unknown): { agent: string; registered: Record<string, AgentProviderRecipe>; skipped: Array<{ name: string; reason: string }> } {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected a JSON object");
    const report = payload as { agent?: unknown; providers?: unknown };
    if (typeof report.agent !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(report.agent)) throw new Error("Invalid agent name");
    if (!report.providers || typeof report.providers !== "object" || Array.isArray(report.providers)) throw new Error("Expected a providers object");
    const entries = Object.entries(report.providers as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 64) throw new Error("Expected 1 to 64 providers");
    const registered: Record<string, AgentProviderRecipe> = {};
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const [name, value] of entries) {
        try {
            registered[name] = parseAgentProviderEntry(name, value);
        } catch (err) {
            skipped.push({ name: sanitizeAgentProviderField(name, 64) || "<unnamed>", reason: sanitizeAgentProviderField(err instanceof Error ? err.message : String(err), 200) });
        }
    }
    return { agent: report.agent, registered, skipped };
}
