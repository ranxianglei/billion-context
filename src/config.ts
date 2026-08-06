import { defaultConfig, type Config } from "acp-kernel";
import { readFileSync } from "node:fs";

function safeReadJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

/** Provider route: a short name (e.g. "glm") mapped to an upstream URL.
 *  Agents point their base URL at the proxy using the name as a path segment:
 *    http://localhost:8788/v1/glm          → routes.glm
 *    http://localhost:8788/anthropic        → routes.anthropic
 *  The API key is NOT stored here — the proxy passes the agent's key through
 *  untouched, so secrets only live in the agent's config. */
export type ProviderRoutes = Record<string, string>;

/** Built-in context window for common model families, keyed by a lowercase
 *  prefix. Used so the proxy doesn't need to ask the user for a context limit —
 *  it reads body.model and looks it up here. Falls back to a query to the
 *  upstream /models endpoint, then to MODEL_CONTEXT_LIMIT. */
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

export type ProxyOptions = {
    port: number;
    host: string;
    upstream: string;
    routes: ProviderRoutes;
    modelContextLimit: number;
    kernelConfig: Config;
    condense: {
        keepRecentToolResults: number;
        minCharsToCondense: number;
        maxKeptChars: number;
        enabled: boolean;
    };
    compress: {
        injectTool: boolean;
        injectNudge: boolean;
    };
    sessionHeader: string;
    log: boolean;
    debug: boolean;
    dumpSse?: string;
    passthrough: boolean;
};

export function loadOptions(env: NodeJS.ProcessEnv = process.env): ProxyOptions {
    const port = parseInt(env.ACP_PORT ?? env.PORT ?? "8787", 10);
    const host = env.ACP_HOST ?? "127.0.0.1";
    const upstream = (env.ACP_UPSTREAM ?? "https://api.anthropic.com").replace(/\/$/, "");
    let routes: ProviderRoutes = {};
    const routesPath = env.ACP_PROVIDERS ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            // { "glm": "https://...", "anthropic": "https://..." }
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof v === "string" && v.length > 0) routes[k] = v.replace(/\/$/, "");
            }
        }
    }
    const modelContextLimit = parseInt(env.ACP_MODEL_CONTEXT_LIMIT ?? "200000", 10);
    const enabled = (env.ACP_CONDENSE_ENABLED ?? "1") !== "0";
    const keepRecentToolResults = parseInt(env.ACP_KEEP_RECENT_TOOL_RESULTS ?? "6", 10);
    const minCharsToCondense = parseInt(env.ACP_MIN_CHARS_TO_CONDENSE ?? "1500", 10);
    const maxKeptChars = parseInt(env.ACP_MAX_KEPT_CHARS ?? "400", 10);
    return {
        port: Number.isFinite(port) ? port : 8787,
        host,
        upstream,
        routes,
        modelContextLimit,
        kernelConfig: defaultConfig(modelContextLimit),
        condense: { enabled, keepRecentToolResults, minCharsToCondense, maxKeptChars },
        compress: {
            injectTool: (env.ACP_COMPRESS_TOOL ?? "1") !== "0",
            injectNudge: (env.ACP_COMPRESS_NUDGE ?? "1") !== "0",
        },
        sessionHeader: env.ACP_SESSION_HEADER ?? "x-acp-session",
        log: env.ACP_LOG !== "0",
        debug: (env.ACP_DEBUG ?? "0") === "1",
        dumpSse: env.ACP_DUMP_SSE || undefined,
        passthrough: (env.ACP_PASSTHROUGH ?? "0") === "1",
    };
}
