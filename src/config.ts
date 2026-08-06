import { defaultConfig, type Config } from "acp-kernel";
import { readFileSync } from "node:fs";

function safeReadJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

export type ProviderRoute = { name?: string; baseURL: string; apiKey?: string };

export type ProxyOptions = {
    port: number;
    host: string;
    upstream: string;
    routes: ProviderRoute[];
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
    let routes: ProviderRoute[] = [];
    const routesPath = env.ACP_PROVIDERS ?? "";
    if (routesPath) {
        const parsed = safeReadJson(routesPath);
        if (Array.isArray(parsed)) routes = parsed.filter((r) => r && typeof r.baseURL === "string");
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
