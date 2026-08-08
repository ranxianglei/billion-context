import { defaultConfig, type Config } from "acp-kernel";
import { readFileSync } from "node:fs";
import { configFile } from "./paths.js";
import { log as loggerLog } from "./logger.js";

function safeReadJson(path: string): unknown {
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

/** Provider route: a short name (e.g. "glm") mapped to an upstream URL.
 *  Agents point their base URL at the proxy using the name as a path segment:
 *    http://localhost:8788/v1/glm          → routes.glm
 *    http://localhost:8788/anthropic        → routes.anthropic
 *  The API key is NOT stored here — the proxy passes the agent's key through
 *  untouched, so secrets only live in the agent's config.
 *
 *  Each route may declare per-model context/output limits, mirroring the
 *  structure agents like opencode carry in their own model registry. This is
 *  the source of truth for the proxy: the LLM `/models` endpoint does NOT
 *  return context windows (verified across OpenAI/Anthropic/zhipu/comfly),
 *  so the proxy cannot discover them at runtime — the user must declare them.
 *
 *  Backward compatible: a bare string is accepted and treated as { url }. */
export type ProviderRoute = {
    url: string;
    models?: Record<string, { context?: number; output?: number }>;
};
export type ProviderRoutes = Record<string, ProviderRoute>;

/** Built-in context window for common model families, keyed by a lowercase
 *  prefix. This is a FALLBACK used when the per-route model declaration in
 *  providers.json does not cover a model. The per-route declaration (which
 *  the user controls) always wins, because the same model name can have
 *  different windows behind different relays. */
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
    { match: /^glm-/i, limit: 128_000 },
    { match: /^deepseek/i, limit: 64_000 },
    { match: /^qwen/i, limit: 128_000 },
    { match: /^kimi/i, limit: 128_000 },
    { match: /^llama-/i, limit: 128_000 },
];

export function lookupContextLimit(model: string | undefined): number | undefined {
    if (!model) return undefined;
    for (const entry of CONTEXT_LIMIT_TABLE) {
        if (entry.match.test(model)) return entry.limit;
    }
    return undefined;
}

/** Resolve the context-window limit for a request. Priority:
 *  1. Per-route per-model declaration in providers.json (user-controlled, most accurate)
 *  2. Built-in CONTEXT_LIMIT_TABLE (by model name prefix)
 *  Returns undefined if neither matches — caller falls back to the env default. */
export function resolveContextLimit(
    routes: ProviderRoutes,
    provider: string | undefined,
    model: string | undefined,
): number | undefined {
    if (!model) return undefined;
    if (provider) {
        const route = routes[provider];
        if (route?.models) {
            const m = route.models[model];
            if (m?.context && m.context > 0) return m.context;
        }
    }
    return lookupContextLimit(model);
}

export type ProxyOptions = {
    port: number;
    host: string;
    upstream: string;
    routes: ProviderRoutes;
    modelContextLimit: number;
    kernelConfig: Config;
    compress: {
        injectTool: boolean;
        injectNudge: boolean;
    };
    sessionHeader: string;
    log: boolean;
    debug: boolean;
    dumpSse?: string;
    passthrough: boolean;
    autoUpdate: boolean;
    logFile?: string;
};

export function loadOptions(env: NodeJS.ProcessEnv = process.env): ProxyOptions {
    // --- Source 1: JSON config file (~/.config/billion-context/billion-context.json) ---
    // The canonical, user-editable config. Loaded first so env vars below can
    // override it (env wins for environment-specific overrides).
    const fileConfig = loadConfigFile();

    // --- Source 2: env vars (highest priority) ---
    const port = parseInt(env.ACP_PORT ?? env.PORT ?? `${fileConfig.port ?? 8787}`, 10);
    const host = env.ACP_HOST ?? fileConfig.host ?? "127.0.0.1";
    const upstream = (env.ACP_UPSTREAM ?? fileConfig.upstream ?? "https://api.anthropic.com").replace(/\/$/, "");
    let routes: ProviderRoutes = {};
    // Routes: explicit env path > config file providers > none.
    const routesPath = env.ACP_PROVIDERS ?? fileConfig.providersPath ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                const route = parseRouteEntry(v);
                if (route) routes[k] = route;
            }
        }
    }
    // Also accept providers inline in the config file.
    if (fileConfig.providers) {
        for (const [k, v] of Object.entries(fileConfig.providers)) {
            const route = parseRouteEntry(v);
            if (route && !routes[k]) routes[k] = route;
        }
    }
    const modelContextLimit = parseInt(env.ACP_MODEL_CONTEXT_LIMIT ?? `${fileConfig.modelContextLimit ?? 200000}`, 10);
    return {
        port: Number.isFinite(port) ? port : 8787,
        host,
        upstream,
        routes,
        modelContextLimit,
        kernelConfig: defaultConfig(modelContextLimit),
        compress: {
            injectTool: (env.ACP_COMPRESS_TOOL ?? (fileConfig.compress?.injectTool === false ? "0" : "1")) !== "0",
            injectNudge: (env.ACP_COMPRESS_NUDGE ?? (fileConfig.compress?.injectNudge === false ? "0" : "1")) !== "0",
        },
        sessionHeader: env.ACP_SESSION_HEADER ?? fileConfig.sessionHeader ?? "x-acp-session",
        log: env.ACP_LOG !== "0" && fileConfig.log !== false,
        debug: (env.ACP_DEBUG ?? (fileConfig.debug ? "1" : "0")) === "1",
        dumpSse: env.ACP_DUMP_SSE || fileConfig.dumpSse || undefined,
        passthrough: (env.ACP_PASSTHROUGH ?? (fileConfig.passthrough ? "1" : "0")) === "1",
        autoUpdate: (env.ACP_AUTO_UPDATE ?? (fileConfig.autoUpdate === false ? "0" : "1")) !== "0",
        logFile: env.ACP_LOG_FILE !== undefined ? (env.ACP_LOG_FILE || undefined) : fileConfig.logFile,
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
    modelContextLimit?: number;
    sessionHeader?: string;
    log?: boolean;
    debug?: boolean;
    dumpSse?: string;
    passthrough?: boolean;
    autoUpdate?: boolean;
    logFile?: string;
    compress?: { injectTool?: boolean; injectNudge?: boolean };
};

function loadConfigFile(): FileConfig {
    const parsed = safeReadJson(configFile());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as FileConfig;
    }
    return {};
}

function parseRouteEntry(v: unknown): ProviderRoute | undefined {
    if (typeof v === "string" && v.length > 0) {
        return { url: v.replace(/\/$/, "") };
    }
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as { url?: unknown }).url === "string" && (v as { url: string }).url.length > 0) {
        const obj = v as { url: string; models?: Record<string, { context?: number; output?: number }> };
        return { url: obj.url.replace(/\/$/, ""), models: obj.models };
    }
    return undefined;
}
