// Shared client-config readers extracted here (not in launcher.ts) so the MITM
// discovery module can import them without forming a cycle
// (discover → client-config is fine; discover → launcher → mitm → discover is not).
// This module MUST NOT import from mitm.ts or launcher.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeSettings {
    anthropicBaseUrl?: string;
}

export interface CodexProvider {
    baseUrl?: string;
}

export interface CodexConfig {
    modelProvider?: string;
    openaiBaseUrl?: string;
    providers: Record<string, CodexProvider>;
}

export interface PiProvider {
    baseUrl?: string;
}

export interface PiConfig {
    providers: Record<string, PiProvider>;
}

export interface ZcodeProvider {
    baseURL?: string;
}

export interface ZcodeConfig {
    providers: Record<string, ZcodeProvider>;
}

export interface OmpProvider {
    baseUrl?: string;
}

export interface OmpConfig {
    providers: Record<string, OmpProvider>;
}

export interface ClientConfig {
    claude?: ClaudeSettings;
    codex?: CodexConfig;
    pi?: PiConfig;
    zcode?: ZcodeConfig;
    omp?: OmpConfig;
}

export function nonEmpty(s: unknown): s is string {
    return typeof s === "string" && s.trim().length > 0;
}

export function readJsonObject(filePath: string): Record<string, unknown> | null {
    try {
        const txt = fs.readFileSync(filePath, "utf8");
        const parsed: unknown = JSON.parse(txt);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

export function resolvePiHome(env: NodeJS.ProcessEnv): string {
    const h = os.homedir();
    return nonEmpty(env.PI_CODING_AGENT_DIR) ? env.PI_CODING_AGENT_DIR!
        : nonEmpty(env.PI_HOME) ? env.PI_HOME!
        : path.join(h, ".pi", "agent");
}

/** omp (oh-my-pi) is pi-based: it honors PI_CODING_AGENT_DIR and defaults to
 *  ~/.omp/agent. */
export function resolveOmpHome(env: NodeJS.ProcessEnv): string {
    const h = os.homedir();
    return nonEmpty(env.PI_CODING_AGENT_DIR) ? env.PI_CODING_AGENT_DIR!
        : path.join(h, ".omp", "agent");
}

export function readClaudeSettings(homeDir: string, cwd: string): ClaudeSettings {
    const files = [
        path.join(homeDir, ".claude", "settings.json"),
        path.join(cwd, ".claude", "settings.json"),
    ];
    let anthropicBaseUrl: string | undefined;
    for (const f of files) {
        const obj = readJsonObject(f);
        const env = obj?.env;
        if (env && typeof env === "object" && !Array.isArray(env)) {
            const v = (env as Record<string, unknown>).ANTHROPIC_BASE_URL;
            if (nonEmpty(v)) anthropicBaseUrl = v;
        }
    }
    return anthropicBaseUrl ? { anthropicBaseUrl } : {};
}

/**
 * Targeted TOML reader for ~/.codex/config.toml: top-level `model_provider` /
 * `openai_base_url` and each `[model_providers.<name>]` `base_url`. String
 * values only; NOT a general TOML parser — intentionally dependency-free.
 */
export function parseCodexToml(text: string): CodexConfig {
    const result: CodexConfig = { providers: {} };
    let table = "";
    let curProvider: string | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const tableMatch = /^\[([^\]]+)\]$/.exec(line);
        if (tableMatch) {
            table = tableMatch[1].trim();
            curProvider = table.startsWith("model_providers.")
                ? table.slice("model_providers.".length).trim()
                : null;
            if (curProvider && !result.providers[curProvider]) {
                result.providers[curProvider] = {};
            }
            continue;
        }
        const m = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
        if (!m) continue;
        const key = m[1];
        const val = m[2] !== undefined ? m[2] : m[3];
        if (table === "") {
            if (key === "model_provider") result.modelProvider = val;
            else if (key === "openai_base_url") result.openaiBaseUrl = val;
        } else if (curProvider && key === "base_url") {
            result.providers[curProvider].baseUrl = val;
        }
    }
    return result;
}

export function readCodexConfig(codexHome: string): CodexConfig {
    const cfgPath = path.join(codexHome, "config.toml");
    let text: string;
    try {
        text = fs.readFileSync(cfgPath, "utf8");
    } catch {
        return { providers: {} };
    }
    return parseCodexToml(text);
}

export function readPiConfig(piHome: string): PiConfig {
    const cfgPath = path.join(piHome, "models.json");
    const obj = readJsonObject(cfgPath);
    const providers: Record<string, PiProvider> = {};
    const rawProviders = obj?.providers;
    if (rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)) {
        for (const [name, val] of Object.entries(rawProviders as Record<string, unknown>)) {
            if (val && typeof val === "object" && !Array.isArray(val)) {
                const baseUrl = (val as { baseUrl?: unknown }).baseUrl;
                providers[name] = typeof baseUrl === "string" ? { baseUrl } : {};
            }
        }
    }
    return { providers };
}

/**
 * Targeted YAML reader for omp's ~/.omp/agent/models.yml: each
 * `providers.<name>.baseUrl`. String values only; NOT a general YAML parser —
 * intentionally dependency-free (mirrors parseCodexToml). Indentation-relative
 * so it tolerates the file's base indent.
 */
export function parseOmpYaml(text: string): OmpConfig {
    const result: OmpConfig = { providers: {} };
    let providersIndent = -1;
    let providerIndent = -1;
    let currentProvider: string | null = null;
    for (const rawLine of text.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const indent = rawLine.length - rawLine.trimStart().length;
        if (providersIndent === -1) {
            if (/^providers:\s*(#.*)?$/.test(trimmed)) providersIndent = indent;
            continue;
        }
        if (indent <= providersIndent) break;
        if (providerIndent === -1) providerIndent = indent;
        if (indent === providerIndent) {
            const m = /^([A-Za-z0-9_.-]+):/.exec(trimmed);
            if (m) {
                currentProvider = m[1];
                if (!result.providers[currentProvider]) result.providers[currentProvider] = {};
            } else {
                currentProvider = null;
            }
        } else if (indent > providerIndent && currentProvider) {
            const m = /^baseUrl:\s*(\S+)/.exec(trimmed);
            if (m) result.providers[currentProvider].baseUrl = m[1];
        }
    }
    return result;
}

export function readOmpConfig(ompHome: string): OmpConfig {
    const cfgPath = path.join(ompHome, "models.yml");
    let text: string;
    try {
        text = fs.readFileSync(cfgPath, "utf8");
    } catch {
        return { providers: {} };
    }
    return parseOmpYaml(text);
}

export function parseZcodeConfig(obj: unknown): ZcodeConfig {
    const result: ZcodeConfig = { providers: {} };
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return result;
    const root = obj as Record<string, unknown>;
    const providerField = root.provider;
    if (!providerField || typeof providerField !== "object" || Array.isArray(providerField)) return result;
    const providerMap = providerField as Record<string, unknown>;
    for (const [name, val] of Object.entries(providerMap)) {
        if (!val || typeof val !== "object" || Array.isArray(val)) continue;
        const options = (val as { options?: unknown }).options;
        if (!options || typeof options !== "object" || Array.isArray(options)) continue;
        const baseURL = (options as { baseURL?: unknown }).baseURL;
        if (typeof baseURL === "string") result.providers[name] = { baseURL };
    }
    return result;
}

export function readZcodeConfig(zcodeHome: string): ZcodeConfig {
    const cfgPath = path.join(zcodeHome, "v2", "config.json");
    let txt: string;
    try {
        txt = fs.readFileSync(cfgPath, "utf8");
    } catch {
        return { providers: {} };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(txt);
    } catch {
        return { providers: {} };
    }
    return parseZcodeConfig(parsed);
}

export function loadClientConfig(env: NodeJS.ProcessEnv, cwd: string): ClientConfig {
    const home = os.homedir();
    const config: ClientConfig = {};
    config.claude = readClaudeSettings(home, cwd);
    const codexHome = nonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex");
    config.codex = readCodexConfig(codexHome);
    config.pi = readPiConfig(resolvePiHome(env));
    const zcodeHome = nonEmpty(env.ZCODE_DATA_BASE_DIR) ? env.ZCODE_DATA_BASE_DIR : path.join(home, ".zcode");
    config.zcode = readZcodeConfig(zcodeHome);
    config.omp = readOmpConfig(resolveOmpHome(env));
    return config;
}
