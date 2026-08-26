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

export interface OpencodeProvider {
    baseURL?: string;
}

export interface OpencodeConfig {
    providers: Record<string, OpencodeProvider>;
}

export interface HermesProvider {
    api?: string;
}

export interface HermesConfig {
    providers: Record<string, HermesProvider>;
}

export interface DshConfig {
    baseUrls: string[];
}

export interface ClientConfig {
    claude?: ClaudeSettings;
    codex?: CodexConfig;
    pi?: PiConfig;
    zcode?: ZcodeConfig;
    omp?: OmpConfig;
    opencode?: OpencodeConfig;
    hermes?: HermesConfig;
    dsh?: DshConfig;
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

/** hermes-agent (Nous Research) keeps everything under HERMES_HOME
 *  (default ~/.hermes): config.yaml, .env, skills, memories, sessions. */
export function resolveHermesHome(env: NodeJS.ProcessEnv): string {
    const h = os.homedir();
    return nonEmpty(env.HERMES_HOME) ? env.HERMES_HOME!
        : path.join(h, ".hermes");
}

/** deepseek-harness (dsh) keeps settings under DSH_HOME (default ~/.dsh). */
export function resolveDshHome(env: NodeJS.ProcessEnv): string {
    const h = os.homedir();
    return nonEmpty(env.DSH_HOME) ? env.DSH_HOME!
        : path.join(h, ".dsh");
}

/** Line-based scanner for dsh settings.yaml: collects every http(s) URL that
 *  appears as a baseURL/baseUrl/base_url value (llm-pi-ai provider profiles,
 *  llm-deepseek baseURL, model-level overrides). Route discovery only needs
 *  the endpoint set — the launcher rewrites the same lines in an overlay. */
export function parseDshSettingsYaml(text: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const rawLine of text.split(/\r?\n/)) {
        const m = /^\s*(?:baseURL|baseUrl|base_url):\s*(\S+)(?:\s+#.*)?$/.exec(rawLine);
        if (!m) continue;
        const url = m[1].replace(/^["']|["']$/g, "");
        if (!/^https?:\/\//i.test(url)) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
    }
    return out;
}

export function readDshConfig(dshHome: string): DshConfig {
    let text: string;
    try {
        text = fs.readFileSync(path.join(dshHome, "settings.yaml"), "utf8");
    } catch {
        return { baseUrls: [] };
    }
    return { baseUrls: parseDshSettingsYaml(text) };
}

export function readClaudeSettings(homeDir: string, cwd: string, env: NodeJS.ProcessEnv = process.env): ClaudeSettings {
    const files = [
        path.join(homeDir, ".claude", "settings.json"),
        path.join(cwd, ".claude", "settings.json"),
    ];
    let anthropicBaseUrl: string | undefined;
    for (const f of files) {
        const obj = readJsonObject(f);
        const settingsEnv = obj?.env;
        if (settingsEnv && typeof settingsEnv === "object" && !Array.isArray(settingsEnv)) {
            const v = (settingsEnv as Record<string, unknown>).ANTHROPIC_BASE_URL;
            if (nonEmpty(v)) anthropicBaseUrl = v;
        }
    }
    // Honor a shell-exported ANTHROPIC_BASE_URL (claude's native override) so
    // the launcher wraps the relay the user actually uses, not the default.
    if (!anthropicBaseUrl && nonEmpty(env.ANTHROPIC_BASE_URL)) anthropicBaseUrl = env.ANTHROPIC_BASE_URL;
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

/** Minimal line-based YAML reader for hermes config.yaml: collects provider
 *  entries from the v12 `providers:` dict (provider key -> `api:` url) and the
 *  legacy `custom_providers:` list (- name: ... / base_url: ...). Anything
 *  else in the file is ignored — only name -> endpoint URL pairs matter for
 *  launcher route discovery. */
export function parseHermesYaml(text: string): HermesConfig {
    const result: HermesConfig = { providers: {} };
    type Mode = "none" | "dict" | "list";
    let mode: Mode = "none";
    let sectionIndent = -1;
    let entryIndent = -1;
    let current: string | null = null;
    let anonCount = 0;
    for (const rawLine of text.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const indent = rawLine.length - rawLine.trimStart().length;
        if (mode === "none") {
            if (/^providers:\s*(#.*)?$/.test(trimmed)) {
                mode = "dict";
                sectionIndent = indent;
                entryIndent = -1;
                current = null;
            } else if (/^custom_providers:\s*(#.*)?$/.test(trimmed)) {
                mode = "list";
                sectionIndent = indent;
                entryIndent = -1;
                current = null;
            }
            continue;
        }
        if (indent <= sectionIndent) {
            // Left the section — re-evaluate this line for a new section start.
            mode = "none";
            sectionIndent = -1;
            entryIndent = -1;
            current = null;
            if (/^providers:\s*(#.*)?$/.test(trimmed)) {
                mode = "dict";
                sectionIndent = indent;
            } else if (/^custom_providers:\s*(#.*)?$/.test(trimmed)) {
                mode = "list";
                sectionIndent = indent;
            }
            continue;
        }
        if (mode === "dict") {
            if (entryIndent === -1) entryIndent = indent;
            if (indent === entryIndent) {
                const m = /^([A-Za-z0-9_.-]+):/.exec(trimmed);
                current = m ? m[1] : null;
                if (current && !result.providers[current]) result.providers[current] = {};
            } else if (indent > entryIndent && current) {
                const apiMatch = /^api:\s*(\S+)/.exec(trimmed);
                if (apiMatch) result.providers[current].api = apiMatch[1];
            }
        } else {
            // Legacy list: "- name: x" opens an entry; nested base_url/api/url lines.
            const dashMatch = /^-\s+(.*)$/.exec(trimmed);
            if (dashMatch) {
                entryIndent = indent;
                const nameMatch = /name:\s*([A-Za-z0-9_.-]+)/.exec(dashMatch[1]);
                current = nameMatch ? nameMatch[1] : `custom-${++anonCount}`;
                if (!result.providers[current]) result.providers[current] = {};
                const inlineUrl = /^(?:base_url|api|url):\s*(\S+)/.exec(dashMatch[1]);
                if (inlineUrl) result.providers[current].api = inlineUrl[1];
            } else if (current) {
                const urlMatch = /^(?:base_url|api|url):\s*(\S+)/.exec(trimmed);
                if (urlMatch) result.providers[current].api = urlMatch[1];
            }
        }
    }
    return result;
}

export function readHermesConfig(hermesHome: string): HermesConfig {
    const cfgPath = path.join(hermesHome, "config.yaml");
    let text: string;
    try {
        text = fs.readFileSync(cfgPath, "utf8");
    } catch {
        return { providers: {} };
    }
    return parseHermesYaml(text);
}

export function resolveOpencodeConfigFile(env: NodeJS.ProcessEnv): string {
    if (nonEmpty(env.OPENCODE_CONFIG)) return env.OPENCODE_CONFIG;
    const xdg = nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
    return path.join(xdg, "opencode", "opencode.json");
}

export function readOpencodeConfig(file: string): OpencodeConfig {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf8");
    } catch {
        return { providers: {} };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { providers: {} };
    }
    const providers: Record<string, OpencodeProvider> = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const root = parsed as Record<string, unknown>;
        const provRoot = root.provider;
        if (provRoot && typeof provRoot === "object" && !Array.isArray(provRoot)) {
            for (const [name, value] of Object.entries(provRoot)) {
                if (!value || typeof value !== "object" || Array.isArray(value)) continue;
                const opts = (value as Record<string, unknown>).options;
                if (opts && typeof opts === "object" && !Array.isArray(opts)) {
                    const baseURL = (opts as Record<string, unknown>).baseURL;
                    if (typeof baseURL === "string") providers[name] = { baseURL };
                }
            }
        }
    }
    return { providers };
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
    config.claude = readClaudeSettings(home, cwd, env);
    const codexHome = nonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex");
    config.codex = readCodexConfig(codexHome);
    config.pi = readPiConfig(resolvePiHome(env));
    const zcodeHome = nonEmpty(env.ZCODE_DATA_BASE_DIR) ? env.ZCODE_DATA_BASE_DIR : path.join(home, ".zcode");
    config.zcode = readZcodeConfig(zcodeHome);
    config.omp = readOmpConfig(resolveOmpHome(env));
    config.opencode = readOpencodeConfig(resolveOpencodeConfigFile(env));
    config.hermes = readHermesConfig(resolveHermesHome(env));
    config.dsh = readDshConfig(resolveDshHome(env));
    return config;
}
