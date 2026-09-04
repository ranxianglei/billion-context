// Line-based reader for dsh's settings.yaml (#521): resolves the active LLM
// route's upstream origin so the fetch interceptor knows which traffic to
// rewrite. Deliberately line-based (same discipline as the launcher's
// prepareDshHome scanner) instead of a YAML dependency: dsh's shipped profiles
// use 2-space indentation throughout, and we need exactly two facts — the
// default provider/model and each provider's baseURL/api.
//
// Origin resolution order (per #521): settings baseURL ?? $DEEPSEEK_BASE_URL
// ?? the official deepseek route's built-in default. A typo'd custom provider
// resolves to nothing — rewriting traffic toward an unknown origin would be
// worse than not intercepting at all.

export interface DshRoute {
    provider: string;
    model: string;
    api?: string;
    baseUrl?: string;
}

const BASE_URL_KEY = /^(baseURL|baseUrl|base_url)$/;
export const OFFICIAL_DEEPSEEK_ORIGIN = "https://api.deepseek.com";
const DEFAULT_OFFICIAL_PROVIDER = "deepseek-official";

function scalar(raw: string): string {
    return raw.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "").trim();
}

function indentOf(line: string): number {
    return /^\s*/.exec(line)![0].length;
}

export function parseDshSettings(text: string): DshRoute {
    const lines = text.split("\n");
    let section = "";
    let inProviders = false;
    let providerName = "";
    const providers: Record<string, { api?: string; baseUrl?: string }> = {};
    let deepseekBaseUrl: string | undefined;
    const route: DshRoute = { provider: DEFAULT_OFFICIAL_PROVIDER, model: "deepseek-chat" };

    for (const line of lines) {
        const t = line.trim();
        if (t === "" || t.startsWith("#")) continue;
        const indent = indentOf(line);
        if (indent === 0) {
            section = t.replace(/:\s*(#.*)?$/, "");
            inProviders = false;
            providerName = "";
            continue;
        }
        if (section === "agent-default-model" && indent === 2) {
            const key = t.split(":")[0]!.trim();
            const val = scalar(t.slice(t.indexOf(":") + 1));
            if (key === "provider" && val.length > 0) route.provider = val;
            else if (key === "model" && val.length > 0) route.model = val;
        } else if (section === "llm-deepseek" && indent === 2) {
            const key = t.split(":")[0]!.trim();
            if (BASE_URL_KEY.test(key)) deepseekBaseUrl = scalar(t.slice(t.indexOf(":") + 1));
        } else if (section === "llm-pi-ai") {
            if (indent === 2 && /^providers:\s*(#.*)?$/.test(t)) {
                inProviders = true;
                providerName = "";
            } else if (inProviders && indent === 4 && !t.startsWith("- ")) {
                providerName = t.replace(/:\s*(#.*)?$/, "").split(":")[0]!.trim();
                providers[providerName] = {};
            } else if (inProviders && providerName !== "" && indent >= 6 && !t.startsWith("- ")) {
                const key = t.split(":")[0]!.trim();
                const val = scalar(t.slice(t.indexOf(":") + 1));
                if (key === "api" && val.length > 0) providers[providerName].api = val;
                else if (BASE_URL_KEY.test(key) && val.length > 0) providers[providerName].baseUrl = val;
            }
        }
    }

    const prov = providers[route.provider];
    if (prov) {
        route.api = prov.api;
        route.baseUrl = prov.baseUrl;
    } else if (deepseekBaseUrl !== undefined) {
        route.baseUrl = deepseekBaseUrl;
    }
    return route;
}

export function resolveDshUpstreamOrigin(route: DshRoute, env: NodeJS.ProcessEnv): string | undefined {
    const candidates = [route.baseUrl, env.DEEPSEEK_BASE_URL];
    for (const raw of candidates) {
        const trimmed = raw?.trim();
        if (!trimmed) continue;
        try {
            return new URL(trimmed).origin;
        } catch {
            continue;
        }
    }
    if (route.provider === DEFAULT_OFFICIAL_PROVIDER) return OFFICIAL_DEEPSEEK_ORIGIN;
    return undefined;
}
