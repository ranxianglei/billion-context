// Shared client-config readers extracted here (not in launcher.ts) so the MITM
// discovery module can import them without forming a cycle
// (discover → client-config is fine; discover → launcher → mitm → discover is not).
// This module MUST NOT import from mitm.ts or launcher.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

export interface ClaudeSettings {
    anthropicBaseUrl?: string;
    /** Model claude runs: settings `env.ANTHROPIC_MODEL` ?? top-level `model`. */
    model?: string;
    /** The user's explicit auto-compact window (settings `autoCompactWindow`
     *  or `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`) — when set, the launcher
     *  must NOT override it with its own budget injection (#321). */
    autoCompactWindow?: number;
}

export interface ModelWindow {
    id: string;
    contextWindow: number;
    /** Configured max output for the model (#971), when the client's own
 *  config declares it (codex model_max_output_tokens, pi/omp maxTokens,
 *  opencode limit.output, codebuddy maxOutputTokens). */
    maxOutput?: number;
}

function toModelWindow(id: unknown, contextWindow: unknown, maxOutput?: unknown): ModelWindow | null {
    if (typeof id !== "string" || id.length === 0 || typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return null;
    const win: ModelWindow = { id, contextWindow: Math.floor(contextWindow) };
    if (typeof maxOutput === "number" && Number.isFinite(maxOutput) && maxOutput > 0) win.maxOutput = Math.floor(maxOutput);
    return win;
}

export interface CodexProvider {
    baseUrl?: string;
}

export interface CodexConfig {
    modelProvider?: string;
    openaiBaseUrl?: string;
    /** Top-level `model` — the model codex runs (budget alignment, #321). */
    model?: string;
    /** Top-level `model_context_window` override (if set). */
    contextWindow?: number;
    /** Top-level `model_auto_compact_token_limit` override (if set). */
    autoCompactLimit?: number;
    /** Top-level `model_max_output_tokens` override (if set) (#971). */
    maxOutput?: number;
    /** Top-level `model` + `model_context_window` override pair (if set). */
    modelWindows?: ModelWindow[];
    providers: Record<string, CodexProvider>;
}

export interface PiProvider {
    baseUrl?: string;
    models?: ModelWindow[];
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
    models?: ModelWindow[];
}

export interface OmpConfig {
    providers: Record<string, OmpProvider>;
}

export interface OpencodeProvider {
    baseURL?: string;
    /** opencode's per-model context limit (`models.<id>.limit`). */
    models?: ModelWindow[];
}

export interface OpencodeConfig {
    providers: Record<string, OpencodeProvider>;
}

/** opencode's built-in "zen" gateway (`opencode auth login`): the baseURL
 *  (`https://opencode.ai/zen/v1/messages`) comes from the models.dev catalog,
 *  not from any local config file, so discovery cannot see it — seed it like
 *  the other stock model gateways so `bili omp` / `bili opencode` cert-MITM
 *  zen traffic instead of blind-tunneling it (#1405). */
export const OPENCODE_DEFAULT_MODEL_HOSTS = ["opencode.ai"];

export interface HermesProvider {
    api?: string;
}

export interface HermesConfig {
    providers: Record<string, HermesProvider>;
}

export interface DshConfig {
    baseUrls: string[];
}

export interface CodebuddyConfig {
    /** Model endpoint (OpenAI chat completions wire): settings
     *  `env.CODEBUDDY_BASE_URL` ?? shell `CODEBUDDY_BASE_URL`. */
    codebuddyBaseUrl?: string;
    /** The model codebuddy runs: settings top-level `model`. */
    model?: string;
    /** The user's explicit auto-compact window (settings `autoCompactWindow`)
     *  — when set, the launcher must NOT override it with its own budget
     *  injection (#321 pattern). */
    autoCompactWindow?: number;
    /** Per-model context windows from the two-tier models.json
     *  (`maxInputTokens`), project-level winning per model id. */
    models?: ModelWindow[];
    /** Per-model `url` values from the two-tier models.json (inventory; the
     *  launcher does NOT rewrite these in v1 — they bypass CODEBUDDY_BASE_URL). */
    modelUrls?: string[];
}

export interface QoderConfig {
    /** Model qoder runs: settings.json `model` (gemini-cli-style `model.name`
     *  or bare string) — budget alignment (#321 pattern, #653). */
    model?: string;
    /** `QODER_MODEL_SERVER_HOST` (undocumented env, scheme/trailing-slash
     *  stripped) — when set, qoder talks to this host INSTEAD of the
     *  binary's static default map, so it replaces the MITM whitelist. */
    modelServerHost?: string;
}

export interface TraeConfig {
    modelApiHost?: string;
}

export interface KimiProvider {
    baseUrl?: string;
}

export interface KimiConfig {
    /** Provider base URLs: the explicit `base_url` field, or — when absent —
     *  a `*_BASE_URL` key from the provider's `[providers.<name>.env]`
     *  sub-table (kimi's documented credential/base-URL fallback channel). */
    providers: Record<string, KimiProvider>;
    /** Per-model endpoint overrides (`[models.<alias>].base_url`) — take
     *  precedence over their provider's base_url. */
    modelUrls?: string[];
    /** Endpoints from env channels that redirect model traffic without
     *  touching config.toml (KIMI_MODEL_BASE_URL synthetic provider,
     *  KIMI_CODE_BASE_URL managed-provider override). */
    envUrls?: string[];
    /** Per-model context windows keyed by WIRE model id (`[models.<alias>]`
     *  `model`, falling back to the alias); `[models.<alias>.overrides]`
     *  max_context_size wins over the top-level value. */
    models?: ModelWindow[];
    /** Top-level `default_model` alias. */
    defaultModel?: string;
}

export interface GeminiConfig {
    /** The user's pre-existing `GOOGLE_GEMINI_BASE_URL` env — when set,
     *  gemini-cli already routes model traffic to this relay, so the launcher
     *  wraps IT via /bili/ instead of the stock Google endpoint. */
    baseUrl?: string;
}

export interface IflowConfig {
    /** The user's pre-existing iFlow base-URL env (`IFLOW_BASE_URL` /
     *  `IFLOW_baseUrl`) — relay-wrap semantics, same as GeminiConfig.baseUrl. */
    baseUrl?: string;
}

export interface McodeProvider {
    baseUrl?: string;
}

export interface McodeConfig {
    /** Provider base URLs keyed by provider key: top-level
     *  `minimax_api.baseURL`, or `custom_provider.<key>.options.baseURL`
     *  (BYOK, `mcode provider add`). The managed-login tree (`provider:`)
     *  carries no configurable URL — its hosts live in
     *  MCODE_DEFAULT_MODEL_HOSTS. */
    providers: Record<string, McodeProvider>;
    /** Per-model context windows from `custom_provider.<key>.models.<id>.limit`
     *  (budget alignment). */
    models?: ModelWindow[];
}

export interface AiderConfig {
    /** Model endpoint base URLs discovered from aider's runtime channels:
     *  inherited env (OPENAI_API_BASE etc.), `.aider.conf.yml` files, and the
     *  `--openai-api-base` / `--set-env` CLI args (merged by the launcher).
     *  Read-only discovery — aider has no persistent credential store of its
     *  own (#1048). */
    baseUrls?: string[];
}

/** goose (Block) model routing surface. Release builds wire reqwest with
 *  rustls (webpki roots), so bili's CA is untrusted and cert-MITM cannot reach
 *  the model legs — every leg must be redirected straight at the proxy as
 *  plain HTTP instead: built-in openai/anthropic via their `*_HOST` env
 *  overrides, custom declarative providers via a regenerated config overlay. */
export interface GooseConfig {
    /** `active_provider` from config.toml (legacy GOOSE_PROVIDER env wins). */
    activeProvider?: string;
    /** Custom declarative providers: file name (without .toml) → raw
     *  `base_url` from `<config_dir>/custom_providers/<name>.toml`. */
    customProviders: Record<string, string>;
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
    codebuddy?: CodebuddyConfig;
    qoder?: QoderConfig;
    trae?: TraeConfig;
    kimi?: KimiConfig;
    gemini?: GeminiConfig;
    iflow?: IflowConfig;
    mcode?: McodeConfig;
    aider?: AiderConfig;
    goose?: GooseConfig;
}

/** qoder's default model-inference hosts, hardcoded in the binary (no config
 *  file to discover from): prod + regional (US/SG/JP) + the CN gateway.
 *  daily/test variants are deliberately NOT included. */
export const QODER_DEFAULT_MODEL_HOSTS = [
    "api2-v2.qoder.sh",
    "api1.qoder.sh",
    "api2.qoder.sh",
    "api3.qoder.sh",
    "gateway.qoder.com.cn",
];

/** CN-site detection rule (#653 open question 4): the launcher picks the
 *  `QODER_` vs `QODERCN_` env prefix by, in order — (1) `QODERCLI_SITE=cn`,
 *  (2) a CN-prefixed config env being set (`QODERCN_CONFIG_DIR` /
 *  `QODERCN_CLI_HOME`), (3) only the CN config dir existing on disk (the CN
 *  package defaults to `~/.qoder-cn`, the intl one to `~/.qoder`), else intl.
 *  Known edge: with BOTH packages installed, a CN launch is detected as intl
 *  (degrades to no budget injection / wrong-prefix transport env — never
 *  breaks the launch). */
export function qoderIsCnSite(env: NodeJS.ProcessEnv = process.env): boolean {
    const site = env.QODERCLI_SITE?.trim().toLowerCase();
    if (site === "cn") return true;
    if (nonEmpty(env.QODERCN_CONFIG_DIR) || nonEmpty(env.QODERCN_CLI_HOME)) return true;
    const h = os.homedir();
    const cnDir = path.join(h, ".qoder-cn");
    const intlDir = path.join(h, ".qoder");
    try {
        if (fs.existsSync(cnDir) && !fs.existsSync(intlDir)) return true;
    } catch {}
    return false;
}

/** qoder's config root: `QODER_CONFIG_DIR`/`QODERCN_CONFIG_DIR` (full path)
 *  > `QODER_CLI_HOME`/`QODERCN_CLI_HOME` + dir name > `~/.qoder` (intl) /
 *  `~/.qoder-cn` (CN); `QODER_CONFIG_DIR_NAME`/`QODERCN_CONFIG_DIR_NAME`
 *  override the dir name. The site prefix family is chosen by qoderIsCnSite. */
export function resolveQoderHome(env: NodeJS.ProcessEnv = process.env): string {
    const h = os.homedir();
    const cn = qoderIsCnSite(env);
    const configDir = cn ? env.QODERCN_CONFIG_DIR : env.QODER_CONFIG_DIR;
    if (nonEmpty(configDir)) return configDir!;
    const cliHomeEnv = cn ? env.QODERCN_CLI_HOME : env.QODER_CLI_HOME;
    const cliHome = nonEmpty(cliHomeEnv) ? cliHomeEnv! : h;
    const dirNameEnv = cn ? env.QODERCN_CONFIG_DIR_NAME : env.QODER_CONFIG_DIR_NAME;
    const dirName = nonEmpty(dirNameEnv) ? dirNameEnv! : (cn ? ".qoder-cn" : ".qoder");
    return path.join(cliHome, dirName);
}

/** Read-only discovery of qoder's `<configDir>/settings.json` (gemini-cli
 *  style): the selected model for budget alignment. qoder has no local model
 *  catalog (server-driven), so no windows are collected here. The model host
 *  override env is read too — it decides which host the MITM whitelist must
 *  carry. */
export function readQoderConfig(qoderHome: string, env: NodeJS.ProcessEnv = process.env): QoderConfig {
    const result: QoderConfig = {};
    const obj = readJsonObject(path.join(qoderHome, "settings.json"));
    const model = obj?.model;
    if (typeof model === "string" && model.trim().length > 0) {
        result.model = model.trim();
    } else if (model && typeof model === "object" && !Array.isArray(model)) {
        const name = (model as Record<string, unknown>).name;
        if (nonEmpty(name)) result.model = name!.trim();
    }
    const cn = qoderIsCnSite(env);
    const host = nonEmpty(cn ? env.QODERCN_MODEL_SERVER_HOST : env.QODER_MODEL_SERVER_HOST)
        ? (cn ? env.QODERCN_MODEL_SERVER_HOST : env.QODER_MODEL_SERVER_HOST)!
        : undefined;
    if (host) {
        const bare = host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
        if (bare.length > 0) result.modelServerHost = bare;
    }
    return result;
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

/** codex keeps everything under CODEX_HOME (default ~/.codex): config.toml,
 *  auth.json, sessions. Same resolution the discovery + plugin-install paths
 *  already use (client-config.ts / plugin-install.ts `codexToml`). */
export function resolveCodexHome(env: NodeJS.ProcessEnv): string {
    const h = os.homedir();
    return nonEmpty(env.CODEX_HOME) ? env.CODEX_HOME!
        : path.join(h, ".codex");
}

/** codebuddy (Tencent CodeBuddy Code CLI) keeps its config under
 *  CODEBUDDY_CONFIG_DIR (default ~/.codebuddy). */
export function resolveCodebuddyHome(env: NodeJS.ProcessEnv): string {
    const h = os.homedir();
    return nonEmpty(env.CODEBUDDY_CONFIG_DIR) ? env.CODEBUDDY_CONFIG_DIR!
        : path.join(h, ".codebuddy");
}

/** codebuddy models.json: per-model `url` (OpenAI /chat/completions full
 *  path) + `maxInputTokens` (context window). The container shape is
 *  unverified in the wild, so this tolerates a top-level model map, a
 *  `models` map, or a `models`/top-level array of {id|name, url,
 *  maxInputTokens} entries. */
export function parseCodebuddyModelsJson(obj: unknown): { models: ModelWindow[]; urls: string[] } {
    const out: { models: ModelWindow[]; urls: string[] } = { models: [], urls: [] };
    const seenUrl = new Set<string>();
    const collect = (id: unknown, entry: unknown): void => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        const e = entry as Record<string, unknown>;
        const url = e.url;
        if (typeof url === "string" && url.length > 0 && !seenUrl.has(url)) {
            seenUrl.add(url);
            out.urls.push(url);
        }
        const win = toModelWindow(id, e.maxInputTokens, e.maxOutputTokens);
        if (win) out.models.push(win);
    };
    if (!obj) return out;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const it = item as Record<string, unknown>;
            collect(it.id ?? it.name, it);
        }
        return out;
    }
    if (typeof obj !== "object") return out;
    const root = obj as Record<string, unknown>;
    const modelsField = root.models;
    if (Array.isArray(modelsField)) {
        for (const item of modelsField) {
            if (!item || typeof item !== "object" || Array.isArray(item)) continue;
            const it = item as Record<string, unknown>;
            collect(it.id ?? it.name, it);
        }
        return out;
    }
    if (modelsField && typeof modelsField === "object") {
        for (const [id, val] of Object.entries(modelsField as Record<string, unknown>)) collect(id, val);
        return out;
    }
    for (const [id, val] of Object.entries(root)) collect(id, val);
    return out;
}

function readJsonFile(filePath: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return null;
    }
}

/** codebuddy config discovery (read-only):
 *  - <configDir>/settings.json: `env.CODEBUDDY_BASE_URL` (OpenAI chat
 *    completions endpoint), top-level `model`, top-level `autoCompactWindow`;
 *  - two-tier <configDir>/models.json + <cwd>/.codebuddy/models.json (project
 *    level wins per model id): per-model `url` + `maxInputTokens`.
 *  A shell-exported CODEBUDDY_BASE_URL (codebuddy's native override) is
 *  honored when no settings value exists. */
export function readCodebuddyConfig(codebuddyHome: string, cwd: string, env: NodeJS.ProcessEnv = process.env): CodebuddyConfig {
    let codebuddyBaseUrl: string | undefined;
    let model: string | undefined;
    let autoCompactWindow: number | undefined;
    const settings = readJsonObject(path.join(codebuddyHome, "settings.json"));
    const settingsEnv = settings?.env;
    if (settingsEnv && typeof settingsEnv === "object" && !Array.isArray(settingsEnv)) {
        const e = settingsEnv as Record<string, unknown>;
        const v = e.CODEBUDDY_BASE_URL;
        if (nonEmpty(v)) codebuddyBaseUrl = v;
    }
    const tm = settings?.model;
    if (nonEmpty(tm)) model = String(tm);
    const tacw = Number(settings?.autoCompactWindow);
    if (Number.isFinite(tacw) && tacw > 0) autoCompactWindow = tacw;
    if (!codebuddyBaseUrl && nonEmpty(env.CODEBUDDY_BASE_URL)) codebuddyBaseUrl = env.CODEBUDDY_BASE_URL;

    const windowByModel = new Map<string, number>();
    const urls: string[] = [];
    const seenUrl = new Set<string>();
    for (const f of [
        path.join(codebuddyHome, "models.json"),
        path.join(cwd, ".codebuddy", "models.json"),
    ]) {
        const parsed = parseCodebuddyModelsJson(readJsonFile(f));
        for (const w of parsed.models) windowByModel.set(w.id, w.contextWindow);
        for (const u of parsed.urls) {
            if (!seenUrl.has(u)) {
                seenUrl.add(u);
                urls.push(u);
            }
        }
    }
    return {
        ...(codebuddyBaseUrl ? { codebuddyBaseUrl } : {}),
        ...(model ? { model } : {}),
        ...(autoCompactWindow ? { autoCompactWindow } : {}),
        ...(windowByModel.size > 0 ? { models: [...windowByModel.entries()].map(([id, contextWindow]) => ({ id, contextWindow })) } : {}),
        ...(urls.length > 0 ? { modelUrls: urls } : {}),
    };
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

/** Default model API gateways for Trae CLI (ByteDance). The CLI is a Go
 *  binary that honors HTTPS_PROXY (Go net/http) and resolves its API host
 *  from TRAE_CLI_API_HOST (chatmodel.resolveBaseURL); without it the
 *  enterprise gateway is console.enterprise.trae.cn. These hosts are
 *  cert-MITM'd so `bili trae` can compress the model traffic. */
export const TRAE_DEFAULT_MODEL_HOSTS = [
    "console.enterprise.trae.cn",
    "www.trae.cn",
];

/** jcode (Rust harness) default model hosts, cert-MITM'd so `bili jcode`
 *  compresses the zai leg. Loopback providers stay direct via NO_PROXY. */
export const JCODE_DEFAULT_MODEL_HOSTS = [
    "api.z.ai",
];

/** Qwen Code's stock model gateways, cert-MITM'd so `bili qwen` compresses
 *  the model traffic: DashScope OpenAI-compatible endpoints (CN/intl/coding),
 *  the Qwen OAuth gateway, plus the third-party provider hosts qwen-code ships
 *  support for. Custom relays go through `--mitm-domain`. */
export const QWEN_DEFAULT_MODEL_HOSTS = [
    "dashscope.aliyuncs.com",
    "dashscope-intl.aliyuncs.com",
    "coding.dashscope.aliyuncs.com",
    "coding-intl.dashscope.aliyuncs.com",
    "chat.qwen.ai",
    "api.openai.com",
    "api.anthropic.com",
    "openrouter.ai",
    "api.deepseek.com",
];

/** Trae CLI keeps its config under TRAE_CONFIG_DIR (default ~/.trae):
 *  traecli.yaml, skills, session state. */
export function resolveTraeHome(env: NodeJS.ProcessEnv): string {
    const h = os.homedir();
    return nonEmpty(env.TRAE_CONFIG_DIR) ? env.TRAE_CONFIG_DIR!
        : path.join(h, ".trae");
}

export function readTraeConfig(env: NodeJS.ProcessEnv): TraeConfig {
    const result: TraeConfig = {};
    const host = nonEmpty(env.TRAE_CLI_API_HOST)
        ? env.TRAE_CLI_API_HOST!.replace(/^https?:\/\//i, "").replace(/\/+$/, "")
        : undefined;
    if (host) result.modelApiHost = host;
    return result;
}

export function readGeminiEnvConfig(env: NodeJS.ProcessEnv): GeminiConfig {
    return { baseUrl: nonEmpty(env.GOOGLE_GEMINI_BASE_URL) ? env.GOOGLE_GEMINI_BASE_URL : undefined };
}

export function readIflowEnvConfig(env: NodeJS.ProcessEnv): IflowConfig {
    // iFlow's docs list case variants of the base-URL env; the SCREAMING form
    // is the documented primary, the camel form is accepted too.
    const raw = nonEmpty(env.IFLOW_BASE_URL) ? env.IFLOW_BASE_URL : nonEmpty(env.IFLOW_baseUrl) ? env.IFLOW_baseUrl : undefined;
    return { baseUrl: raw };
}

export function readClaudeSettings(homeDir: string, cwd: string, env: NodeJS.ProcessEnv = process.env): ClaudeSettings {
    const files = [
        path.join(homeDir, ".claude", "settings.json"),
        path.join(cwd, ".claude", "settings.json"),
    ];
    let anthropicBaseUrl: string | undefined;
    let model: string | undefined;
    let autoCompactWindow: number | undefined;
    for (const f of files) {
        const obj = readJsonObject(f);
        const settingsEnv = obj?.env;
        if (settingsEnv && typeof settingsEnv === "object" && !Array.isArray(settingsEnv)) {
            const e = settingsEnv as Record<string, unknown>;
            const v = e.ANTHROPIC_BASE_URL;
            if (nonEmpty(v)) anthropicBaseUrl = v;
            // env-block values beat same-file top-level settings (claude applies
            // the env block as real environment, which outranks settings).
            const m = e.ANTHROPIC_MODEL;
            if (nonEmpty(m)) model = String(m);
            const acw = Number(e.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
            if (Number.isFinite(acw) && acw > 0) autoCompactWindow = acw;
        }
        const tm = obj?.model;
        if (nonEmpty(tm) && model === undefined) model = String(tm);
        const tacw = Number(obj?.autoCompactWindow);
        if (Number.isFinite(tacw) && tacw > 0 && autoCompactWindow === undefined) autoCompactWindow = tacw;
    }
    // Honor a shell-exported ANTHROPIC_BASE_URL (claude's native override) so
    // the launcher wraps the relay the user actually uses, not the default.
    if (!anthropicBaseUrl && nonEmpty(env.ANTHROPIC_BASE_URL)) anthropicBaseUrl = env.ANTHROPIC_BASE_URL;
    return {
        ...(anthropicBaseUrl ? { anthropicBaseUrl } : {}),
        ...(model ? { model } : {}),
        ...(autoCompactWindow ? { autoCompactWindow } : {}),
    };
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
    let codexModel: string | undefined;
    let codexContextWindow: number | undefined;
    let codexAutoCompactLimit: number | undefined;
    let codexMaxOutput: number | undefined;
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
        const strMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
        const numMatch = /^([A-Za-z0-9_.-]+)\s*=\s*([0-9]+)\b/.exec(line);
        if (strMatch) {
            const key = strMatch[1];
            const val = strMatch[2] !== undefined ? strMatch[2] : strMatch[3];
            if (table === "") {
                if (key === "model_provider") result.modelProvider = val;
                else if (key === "openai_base_url") result.openaiBaseUrl = val;
                else if (key === "model") codexModel = val;
            } else if (curProvider && key === "base_url") {
                result.providers[curProvider].baseUrl = val;
            }
        } else if (numMatch && table === "") {
            if (numMatch[1] === "model_context_window") codexContextWindow = Number(numMatch[2]);
            else if (numMatch[1] === "model_auto_compact_token_limit") codexAutoCompactLimit = Number(numMatch[2]);
            else if (numMatch[1] === "model_max_output_tokens") codexMaxOutput = Number(numMatch[2]);
        }
    }
    if (codexModel) result.model = codexModel;
    if (codexContextWindow) result.contextWindow = codexContextWindow;
    if (codexAutoCompactLimit) result.autoCompactLimit = codexAutoCompactLimit;
    if (codexMaxOutput) result.maxOutput = codexMaxOutput;
    const win = toModelWindow(codexModel, codexContextWindow, codexMaxOutput);
    if (win) result.modelWindows = [win];
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

/** Built-in managed (OAuth-logged-in) model API hosts — absent from
 *  config.toml entirely, so the launcher falls back to them when the user
 *  declares no provider/model endpoints at all (qoder/trae precedent). */
export const KIMI_DEFAULT_MODEL_HOSTS = ["api.kimi.com", "api.kimi.ai"];

/** Managed-login model gateways (global/CN + legacy) plus the official raw
 *  API hosts the minimax_api BYOK default resolves to — absent from
 *  config.yaml, so the launcher falls back to them when no provider base
 *  URL is declared (kimi/qoder default-hosts precedent). */
export const MCODE_DEFAULT_MODEL_HOSTS = [
    "agent.minimax.io",
    "agent.minimax.cn",
    "agent.minimaxi.com",
    "api.minimax.io",
    "api.minimaxi.com",
];

/** Split a TOML table header into path parts, honoring quoted segments
 *  (`[providers."managed:kimi-code"]` → ["providers", "managed:kimi-code"]). */
function tomlPathParts(header: string): string[] {
    const parts: string[] = [];
    let cur = "";
    let dq = false;
    let sq = false;
    for (const ch of header) {
        if (ch === '"' && !sq) dq = !dq;
        else if (ch === "'" && !dq) sq = !sq;
        else if (ch === "." && !dq && !sq) { parts.push(cur); cur = ""; }
        else cur += ch;
    }
    parts.push(cur);
    return parts.map((p) => p.trim());
}

interface KimiModelState {
    modelId?: string;
    window?: number;
    windowOverride?: number;
    baseUrl?: string;
}

export function parseKimiToml(text: string): KimiConfig {
    const result: KimiConfig = { providers: {} };
    const modelState = new Map<string, KimiModelState>();
    let parts: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const tableMatch = /^\[\[?(.+?)\]\]?$/.exec(line);
        if (tableMatch) {
            parts = tomlPathParts(tableMatch[1]);
            continue;
        }
        const strMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
        const numMatch = /^([A-Za-z0-9_.-]+)\s*=\s*([0-9]+)\b/.exec(line);
        if (!strMatch && !numMatch) continue;
        const key = (strMatch ?? numMatch)![1];
        const strVal = strMatch ? (strMatch[2] !== undefined ? strMatch[2] : strMatch[3]) : undefined;
        const numVal = numMatch ? Number(numMatch[2]) : undefined;
        if (parts.length === 0) {
            if (key === "default_model" && strVal !== undefined) result.defaultModel = strVal;
        } else if (parts[0] === "providers") {
            const name = parts[1];
            if (!name) continue;
            const prov = result.providers[name] ??= {};
            if (parts.length === 2) {
                if (key === "base_url" && strVal !== undefined) prov.baseUrl = strVal;
            } else if (parts.length === 3 && parts[2] === "env" && strVal !== undefined && /_BASE_URL$/.test(key)) {
                if (!prov.baseUrl) prov.baseUrl = strVal;
            }
        } else if (parts[0] === "models") {
            const alias = parts[1];
            if (!alias) continue;
            const st = modelState.get(alias) ?? {};
            if (parts.length === 2) {
                if (key === "model" && strVal !== undefined) st.modelId = strVal;
                else if (key === "max_context_size" && numVal !== undefined) st.window = numVal;
                else if (key === "base_url" && strVal !== undefined) st.baseUrl = strVal;
            } else if (parts.length === 3 && parts[2] === "overrides") {
                if (key === "max_context_size" && numVal !== undefined) st.windowOverride = numVal;
            }
            modelState.set(alias, st);
        }
    }
    const windows: ModelWindow[] = [];
    const modelUrls: string[] = [];
    for (const [alias, st] of modelState) {
        const win = toModelWindow(st.modelId ?? alias, st.windowOverride ?? st.window);
        if (win) windows.push(win);
        if (st.baseUrl) modelUrls.push(st.baseUrl);
    }
    if (windows.length > 0) result.models = windows;
    if (modelUrls.length > 0) result.modelUrls = modelUrls;
    return result;
}

export function resolveKimiHome(env: NodeJS.ProcessEnv = process.env): string {
    return nonEmpty(env.KIMI_CODE_HOME) ? env.KIMI_CODE_HOME : path.join(os.homedir(), ".kimi-code");
}

export function readKimiConfig(kimiHome: string, env: NodeJS.ProcessEnv = process.env): KimiConfig {
    const cfgPath = path.join(kimiHome, "config.toml");
    let text: string;
    try {
        text = fs.readFileSync(cfgPath, "utf8");
    } catch {
        return { providers: {} };
    }
    const config = parseKimiToml(text);
    // Env channels that redirect model traffic without touching config.toml:
    // KIMI_MODEL_* synthesizes an in-memory provider (beats default_model),
    // KIMI_CODE_BASE_URL overrides the managed OAuth provider's base URL.
    const envUrls: string[] = [];
    if (nonEmpty(env.KIMI_MODEL_BASE_URL)) envUrls.push(env.KIMI_MODEL_BASE_URL!);
    if (nonEmpty(env.KIMI_CODE_BASE_URL)) envUrls.push(env.KIMI_CODE_BASE_URL!);
    if (envUrls.length > 0) config.envUrls = envUrls;
    if (nonEmpty(env.KIMI_MODEL_NAME)) {
        const size = parseInt(env.KIMI_MODEL_MAX_CONTEXT_SIZE ?? "", 10);
        const win = toModelWindow(env.KIMI_MODEL_NAME!, Number.isFinite(size) && size > 0 ? size : 262144);
        if (win) config.models = [...(config.models ?? []), win];
    }
    return config;
}

/** Trim a YAML line to its content: drop whole-line comments and trailing
 *  ` # ...` comments (a `#` inside quotes is data, e.g. URL fragments). */
function yamlLineContent(raw: string): string | null {
    const t = raw.trim();
    if (!t || t.startsWith("#")) return null;
    let dq = false;
    let sq = false;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (ch === '"' && !sq) dq = !dq;
        else if (ch === "'" && !dq) sq = !sq;
        else if (ch === "#" && !dq && !sq && (i === 0 || t[i - 1] === " " || t[i - 1] === "\t")) {
            const cut = t.slice(0, i).trimEnd();
            return cut.length > 0 ? cut : null;
        }
    }
    return t;
}

function unquoteYaml(value: string): string {
    const v = value.trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
        return v.slice(1, -1);
    }
    return v;
}

// `mcode provider add` reserves these keys for built-in providers; anything
// else under custom_provider is user BYOK config.
const MCODE_RESERVED_PROVIDER_KEYS = new Set(["minimax", "minimax_api", "provider", "custom_provider"]);

/** Targeted block-YAML reader for mcode's config.yaml (no YAML dependency —
 *  same targeted-parser discipline as parseOmpYaml/parseDshSettingsYaml).
 *  Extracts only what routing needs: minimax_api.baseURL,
 *  custom_provider.<key>.options.baseURL, and custom_provider.<key>.models.<id>.limit. */
export function parseMcodeYaml(text: string): McodeConfig {
    const result: McodeConfig = { providers: {} };
    const limits = new Map<string, { context?: number; output?: number }>();
    const stack: { indent: number; key: string }[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = yamlLineContent(raw);
        if (line === null) continue;
        const colon = line.indexOf(":");
        if (colon <= 0) continue;
        const indent = raw.length - raw.trimStart().length;
        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
        const key = unquoteYaml(line.slice(0, colon));
        const value = unquoteYaml(line.slice(colon + 1).trim());
        stack.push({ indent, key });
        const p = stack.map((s) => s.key);
        if (p[0] === "minimax_api" && p.length === 2 && p[1] === "baseURL" && value) {
            result.providers["minimax_api"] ??= {};
            result.providers["minimax_api"]!.baseUrl = value;
        } else if (p[0] === "custom_provider") {
            const prov = p[1];
            if (!prov || MCODE_RESERVED_PROVIDER_KEYS.has(prov)) continue;
            if (p.length === 4 && p[2] === "options" && p[3] === "baseURL" && value) {
                result.providers[prov] ??= {};
                if (!result.providers[prov]!.baseUrl) result.providers[prov]!.baseUrl = value;
            } else if (p.length === 6 && p[2] === "models" && p[4] === "limit" && (p[5] === "context" || p[5] === "output")) {
                const n = Number(value);
                if (!Number.isFinite(n) || n <= 0) continue;
                const lim = limits.get(p[3]) ?? {};
                if (p[5] === "context") lim.context = n;
                else lim.output = n;
                limits.set(p[3], lim);
            }
        }
    }
    if (limits.size > 0) {
        result.models = [...limits.entries()]
            .map(([id, lim]) => toModelWindow(id, lim.context, lim.output))
            .filter((w): w is ModelWindow => w !== null);
    }
    return result;
}

/** Copilot CLI (GitHub) model hosts, cert-MITM'd so `bili copilot` compresses
 *  the model traffic. The binary is closed-source Go (net/http honors
 *  HTTPS_PROXY + SSL_CERT_FILE); the family is api.githubcopilot.com plus the
 *  per-plan subdomains from GitHub's own CI firewall allowlist for the CLI. */
export const COPILOT_DEFAULT_MODEL_HOSTS = [
    "api.githubcopilot.com",
    "api.individual.githubcopilot.com",
    "api.business.githubcopilot.com",
    "api.enterprise.githubcopilot.com",
];

/** Amp (Sourcegraph) backend host, cert-MITM'd so `bili amp` compresses the
 *  model traffic. Closed-source Go like copilot; ampcode.com carries both the
 *  model leg and the control plane (/api/internal, /api/telemetry). */
export const AMP_DEFAULT_MODEL_HOSTS = ["ampcode.com"];

/** goose directory layout (mirrors its paths.rs): GOOSE_PATH_ROOT (absolute)
 *  holds config/, data/, state/, .agents/; without it the home scatters across
 *  XDG dirs under author "Block" (state falls back to data when
 *  XDG_STATE_HOME is unset — etcetera's state_dir() returns None then). */
export interface GooseDirs {
    configDir: string;
    dataDir: string;
    stateDir: string;
    agentsDir: string;
}

export function resolveGooseDirs(env: NodeJS.ProcessEnv = process.env): GooseDirs {
    const root = nonEmpty(env.GOOSE_PATH_ROOT) ? env.GOOSE_PATH_ROOT! : undefined;
    if (root) {
        return {
            configDir: path.join(root, "config"),
            dataDir: path.join(root, "data"),
            stateDir: path.join(root, "state"),
            agentsDir: path.join(root, ".agents"),
        };
    }
    const h = os.homedir();
    const configDir = path.join(nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME! : path.join(h, ".config"), "goose");
    const dataDir = path.join(nonEmpty(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME! : path.join(h, ".local", "share"), "Block", "goose");
    const stateDir = nonEmpty(env.XDG_STATE_HOME) ? path.join(env.XDG_STATE_HOME!, "Block", "goose") : dataDir;
    return { configDir, dataDir, stateDir, agentsDir: path.join(dataDir, ".agents") };
}

export function readGooseConfig(dirs: GooseDirs, env: NodeJS.ProcessEnv = process.env): GooseConfig {
    const result: GooseConfig = { customProviders: {} };
    if (nonEmpty(env.GOOSE_PROVIDER)) {
        result.activeProvider = env.GOOSE_PROVIDER!;
    } else {
        try {
            const text = fs.readFileSync(path.join(dirs.configDir, "config.toml"), "utf8");
            const m = /^active_provider\s*=\s*["']([^"']+)["']/m.exec(text);
            if (m?.[1]) result.activeProvider = m[1];
        } catch {}
    }
    let entries: string[] = [];
    try {
        entries = fs.readdirSync(path.join(dirs.configDir, "custom_providers"));
    } catch {}
    for (const name of entries.sort()) {
        if (!name.endsWith(".toml")) continue;
        let txt: string;
        try {
            txt = fs.readFileSync(path.join(dirs.configDir, "custom_providers", name), "utf8");
        } catch {
            continue;
        }
        const m = /^\s*base_url\s*=\s*["']([^"']+)["']/m.exec(txt);
        if (m?.[1]) result.customProviders[name.replace(/\.toml$/, "")] = m[1];
    }
    return result;
}

/** mcode's install dir (launchers at <dir>/bin/mcode): MCODE_INSTALL_DIR or
 *  ~/.minimax-code (installer default). */
export function resolveMcodeInstallDir(env: NodeJS.ProcessEnv = process.env): string {
    return nonEmpty(env.MCODE_INSTALL_DIR) ? env.MCODE_INSTALL_DIR! : path.join(os.homedir(), ".minimax-code");
}

/** Data dirs whose config.yaml files carry provider base URLs: an explicit
 *  MINIMAX_DATA_DIR/MAVIS_DATA_DIR points at exactly one profile dir;
 *  otherwise union-scan ~/.minimax plus every ~/.minimax-<profile> (the
 *  active-profile selection logic lives in mcode; a superset whitelist is
 *  safe — extra hosts only matter if traffic actually flows to them). */
export function mcodeConfigFiles(env: NodeJS.ProcessEnv = process.env): string[] {
    if (nonEmpty(env.MINIMAX_DATA_DIR) || nonEmpty(env.MAVIS_DATA_DIR)) {
        const dir = nonEmpty(env.MINIMAX_DATA_DIR) ? env.MINIMAX_DATA_DIR! : env.MAVIS_DATA_DIR!;
        return [path.join(dir, "config.yaml")];
    }
    const home = os.homedir();
    const files = [path.join(home, ".minimax", "config.yaml")];
    try {
        for (const name of fs.readdirSync(home)) {
            if (name.startsWith(".minimax-")) files.push(path.join(home, name, "config.yaml"));
        }
    } catch {}
    return files;
}

export function readMcodeConfig(env: NodeJS.ProcessEnv = process.env): McodeConfig {
    const merged: McodeConfig = { providers: {} };
    const windows = new Map<string, ModelWindow>();
    for (const file of mcodeConfigFiles(env)) {
        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            continue;
        }
        const cfg = parseMcodeYaml(text);
        for (const [name, prov] of Object.entries(cfg.providers)) {
            if (!prov.baseUrl) continue;
            merged.providers[name] ??= {};
            if (!merged.providers[name]!.baseUrl) merged.providers[name]!.baseUrl = prov.baseUrl;
        }
        for (const w of cfg.models ?? []) {
            const prev = windows.get(w.id);
            if (!prev || w.contextWindow > prev.contextWindow) {
                // Replacing on a larger window must not drop an already-known
                // larger maxOutput (file order must not decide the outcome).
                if (prev && prev.maxOutput !== undefined && (w.maxOutput === undefined || prev.maxOutput > w.maxOutput)) {
                    w.maxOutput = prev.maxOutput;
                }
                windows.set(w.id, w);
            } else if (w.maxOutput !== undefined && (prev.maxOutput === undefined || w.maxOutput > prev.maxOutput)) {
                prev.maxOutput = w.maxOutput;
            }
        }
    }
    if (windows.size > 0) merged.models = [...windows.values()];
    return merged;
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
                const models = (val as { models?: unknown }).models;
                const windows: ModelWindow[] = [];
                if (Array.isArray(models)) {
                    for (const m of models) {
                        if (!m || typeof m !== "object") continue;
                        const fields = m as { id?: unknown; contextWindow?: unknown; maxTokens?: unknown; maxOutputTokens?: unknown };
                        const win = toModelWindow(fields.id, fields.contextWindow, fields.maxTokens ?? fields.maxOutputTokens);
                        if (win) windows.push(win);
                    }
                }
                providers[name] = {
                    ...(typeof baseUrl === "string" ? { baseUrl } : {}),
                    ...(windows.length > 0 ? { models: windows } : {}),
                };
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
    // `models:` subsection: `- id: <x>` (any deeper indent) starts a model
    // entry, a deeper `contextWindow: <n>` completes it.
    let modelsIndent = -1;
    let dashIndent = -1;
    let pending: { id: string | undefined; contextWindow?: number; maxOutput?: number } | undefined;
    const flushPending = (): void => {
        if (pending === undefined || currentProvider === null) { pending = undefined; return; }
        const win = toModelWindow(pending.id, pending.contextWindow, pending.maxOutput);
        if (win) {
            const prov = result.providers[currentProvider]!;
            prov.models = [...(prov.models ?? []), win];
        }
        pending = undefined;
    };
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
            modelsIndent = -1;
            dashIndent = -1;
            flushPending();
            const m = /^([A-Za-z0-9_.-]+):/.exec(trimmed);
            if (m) {
                currentProvider = m[1];
                if (!result.providers[currentProvider]) result.providers[currentProvider] = {};
            } else {
                currentProvider = null;
            }
        } else if (indent > providerIndent && currentProvider) {
            const idMatch = /^-\s+id:\s*(\S+)/.exec(trimmed);
            if (modelsIndent >= 0 && indent > modelsIndent && idMatch) {
                flushPending();
                pending = { id: idMatch[1] };
                dashIndent = indent;
            } else if (modelsIndent >= 0 && dashIndent >= 0 && indent > dashIndent) {
                const cw = /^contextWindow:\s*([0-9]+)/.exec(trimmed);
                if (cw && pending !== undefined) pending.contextWindow = Number(cw[1]);
                const mo = /^maxTokens:\s*([0-9]+)/.exec(trimmed);
                if (mo && pending !== undefined) pending.maxOutput = Number(mo[1]);
            } else if (/^models:\s*(#.*)?$/.test(trimmed)) {
                modelsIndent = indent;
                dashIndent = -1;
                flushPending();
            } else if (modelsIndent < 0 || indent <= modelsIndent) {
                const m = /^baseUrl:\s*(\S+)/.exec(trimmed);
                if (m) result.providers[currentProvider]!.baseUrl = m[1];
            }
        }
    }
    flushPending();
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
    const candidates = new Map<string, string>();
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
                // hermes accepts base_url / url / api (priority order) — collect
                // all and resolve after the scan.
                const apiMatch = /^(base_url|url|api):\s*(\S+)/.exec(trimmed);
                if (apiMatch) candidates.set(`${current}\u0000${apiMatch[1]}`, apiMatch[2]);
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
    for (const name of Object.keys(result.providers)) {
        const pick = candidates.get(`${name}\u0000base_url`) ?? candidates.get(`${name}\u0000url`) ?? candidates.get(`${name}\u0000api`);
        if (pick !== undefined) result.providers[name].api = pick;
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

export const OPENCODE_CONFIG_FILES = ["opencode.jsonc", "opencode.json", "config.json"] as const;

export function resolveOpencodeConfigFile(env: NodeJS.ProcessEnv): string {
    if (nonEmpty(env.OPENCODE_CONFIG)) return env.OPENCODE_CONFIG;
    const xdg = nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
    // Mirror opencode's own discovery (globalConfigFile): first existing file, .jsonc preferred.
    const dir = path.join(xdg, "opencode");
    for (const file of OPENCODE_CONFIG_FILES) {
        const candidate = path.join(dir, file);
        if (fs.existsSync(candidate)) return candidate;
    }
    return path.join(dir, "opencode.jsonc");
}

// The complete set of files whose contents feed config.opencode (exactly what
// readOpencodeConfigRoot reads): the three global candidates + an explicit
// OPENCODE_CONFIG when set. The discovery mtime cache must watch this same set
// or edits go stale (#1411).
export function opencodeConfigFiles(env: NodeJS.ProcessEnv): string[] {
    const xdg = nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
    const dir = path.join(xdg, "opencode");
    const files = OPENCODE_CONFIG_FILES.map((f) => path.join(dir, f));
    if (nonEmpty(env.OPENCODE_CONFIG)) files.push(env.OPENCODE_CONFIG);
    return files;
}

// opencode accepts JSONC (comments, trailing commas) in every config file; a strict
// JSON.parse silently yields "no config" for .jsonc users.
export function parseConfigText(text: string): Record<string, unknown> | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        const errors: ParseError[] = [];
        parsed = parseJsonc(text, errors, { allowTrailingComma: true });
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return undefined;
}

function readConfigFileRoot(file: string): Record<string, unknown> | undefined {
    try {
        return parseConfigText(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

// Deep merge mirroring opencode's own loader (remeda mergeDeep): plain objects
// recurse, arrays/primitives are replaced by the later file. Top-level spread
// would drop earlier files' provider entries whenever a later file also has a
// top-level provider key.
function mergeConfigDeep(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(source)) {
        const existing = out[key];
        out[key] =
            value !== null && typeof value === "object" && !Array.isArray(value) &&
            existing !== null && typeof existing === "object" && !Array.isArray(existing)
                ? mergeConfigDeep(existing as Record<string, unknown>, value as Record<string, unknown>)
                : value;
    }
    return out;
}

// Mirror opencode's global merge (config.json → opencode.json → opencode.jsonc,
// later wins). Needed because opencode seeds a near-empty opencode.jsonc when no
// config exists yet, so single-file reads miss the real config in opencode.json.
// A user-set OPENCODE_CONFIG is layered ON TOP of that merge — opencode loads
// the globals first and merges the explicit file over them, it does not replace
// them — so providers living only in the global files stay visible.
export function readOpencodeConfigRoot(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
    let root: Record<string, unknown> | undefined;
    const xdg = nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
    const dir = path.join(xdg, "opencode");
    for (const file of ["config.json", "opencode.json", "opencode.jsonc"]) {
        const next = readConfigFileRoot(path.join(dir, file));
        if (next !== undefined) root = root === undefined ? next : mergeConfigDeep(root, next);
    }
    if (nonEmpty(env.OPENCODE_CONFIG)) {
        const next = readConfigFileRoot(env.OPENCODE_CONFIG);
        if (next !== undefined) root = root === undefined ? next : mergeConfigDeep(root, next);
    }
    return root;
}

// Base dir for re-anchoring relative local plugin specs when the launcher
// clones the merged config into a temp dir (#826): opencode resolves a relative
// spec against the directory of the file that DECLARED it (at load time, before
// merging), so the surviving array's base is the last readable file in the same
// load order as readOpencodeConfigRoot that declares the key — arrays are
// replaced wholesale by later files. The three global files share one dir, so
// only a user-set OPENCODE_CONFIG elsewhere can shift the base.
export function opencodePluginBaseDir(env: NodeJS.ProcessEnv, key: "plugin" | "plugins"): string {
    const oc = env.OPENCODE_CONFIG;
    if (nonEmpty(oc)) {
        const parsed = readConfigFileRoot(oc);
        if (parsed !== undefined && key in parsed) return path.dirname(oc);
    }
    const xdg = nonEmpty(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config");
    return path.join(xdg, "opencode");
}

export function parseOpencodeProviders(parsed: Record<string, unknown> | undefined): OpencodeConfig {
    const providers: Record<string, OpencodeProvider> = {};
    if (parsed !== undefined) {
        const root = parsed;
        const provRoot = root.provider;
        if (provRoot && typeof provRoot === "object" && !Array.isArray(provRoot)) {
            for (const [name, value] of Object.entries(provRoot)) {
                if (!value || typeof value !== "object" || Array.isArray(value)) continue;
                const opts = (value as Record<string, unknown>).options;
                if (opts && typeof opts === "object" && !Array.isArray(opts)) {
                    const baseURL = (opts as Record<string, unknown>).baseURL;
                    if (typeof baseURL === "string") providers[name] = { baseURL };
                }
                const modelsRoot = (value as Record<string, unknown>).models;
                if (modelsRoot && typeof modelsRoot === "object" && !Array.isArray(modelsRoot) && providers[name]) {
                    const windows: ModelWindow[] = [];
                    for (const [modelId, mv] of Object.entries(modelsRoot as Record<string, unknown>)) {
                        if (!mv || typeof mv !== "object") continue;
                        const limit = (mv as Record<string, unknown>).limit;
                        if (typeof limit === "number") {
                            const win = toModelWindow(modelId, limit);
                            if (win) windows.push(win);
                        } else if (limit && typeof limit === "object" && !Array.isArray(limit)) {
                            const l = limit as { context?: unknown; output?: unknown };
                            const win = toModelWindow(modelId, l.context, l.output);
                            if (win) windows.push(win);
                        }
                    }
                    if (windows.length > 0) providers[name].models = windows;
                }
            }
        }
    }
    return { providers };
}

export function readOpencodeConfig(file: string): OpencodeConfig {
    return parseOpencodeProviders(readConfigFileRoot(file));
}

export interface OpencodeProjectProviderView {
    baseURL?: string;
    file: string;
}

export interface OpencodeProjectLayer {
    providers: Record<string, OpencodeProjectProviderView>;
}

function findGitRoot(start: string): string | undefined {
    let cur = start;
    for (;;) {
        if (fs.existsSync(path.join(cur, ".git"))) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) return undefined;
        cur = parent;
    }
}

// Mirrors opencode's own project-config discovery (verified against
// opencode 1.14.46, #843): from cwd up to the git root (or filesystem root
// when outside any repo), every level contributes <dir>/opencode.json{,c}
// plus <dir>/.opencode/opencode.json{,c}; nearest level wins per provider id.
// These files outrank $OPENCODE_CONFIG, so they can silently override the
// launcher's rewrite delivery.
export function readOpencodeProjectLayer(cwd: string): OpencodeProjectLayer {
    const start = path.resolve(cwd);
    const gitRoot = findGitRoot(start);
    const dirs: string[] = [];
    let cur = start;
    for (;;) {
        dirs.push(cur);
        if (cur === gitRoot) break;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
    }
    dirs.reverse();
    const providers: Record<string, OpencodeProjectProviderView> = {};
    for (const dir of dirs) {
        const candidates = [
            path.join(dir, "opencode.json"),
            path.join(dir, "opencode.jsonc"),
            path.join(dir, ".opencode", "opencode.json"),
            path.join(dir, ".opencode", "opencode.jsonc"),
        ];
        for (const file of candidates) {
            const parsed = readConfigFileRoot(file);
            if (!parsed) continue;
            const provRoot = parsed.provider;
            if (!provRoot || typeof provRoot !== "object" || Array.isArray(provRoot)) continue;
            for (const [name, value] of Object.entries(provRoot as Record<string, unknown>)) {
                if (!value || typeof value !== "object" || Array.isArray(value)) continue;
                const opts = (value as Record<string, unknown>).options;
                const rawBase = opts && typeof opts === "object" && !Array.isArray(opts) ? (opts as Record<string, unknown>).baseURL : undefined;
                const baseURL = typeof rawBase === "string" && rawBase !== "" ? rawBase : undefined;
                const prev = providers[name];
                if (!prev) {
                    providers[name] = baseURL !== undefined ? { baseURL, file } : { file };
                } else if (baseURL !== undefined) {
                    prev.baseURL = baseURL;
                    prev.file = file;
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

// #1151: ZCode v3.14+ stores personal providers in provider_config.json
// (zai-org/ZCode packages/provider-node/src/runtime-paths.ts). The legacy
// config.json is imported once when the personal file is absent and then
// frozen (no double-write), so discovery must read both and merge.
export function parseZcodePersonalConfig(obj: unknown): ZcodeConfig {
    const result: ZcodeConfig = { providers: {} };
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return result;
    const cfg = (obj as { config?: unknown }).config;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return result;
    const rulesField = (cfg as { providerConfigRules?: unknown }).providerConfigRules;
    if (!rulesField || typeof rulesField !== "object" || Array.isArray(rulesField)) return result;
    const rules = (rulesField as { providerRules?: unknown }).providerRules;
    if (!Array.isArray(rules)) return result;
    for (const rule of rules) {
        if (!rule || typeof rule !== "object" || Array.isArray(rule)) continue;
        const r = rule as { providerId?: unknown; providerName?: unknown; config?: unknown };
        const key = nonEmpty(r.providerId) ? r.providerId.trim() : nonEmpty(r.providerName) ? r.providerName.trim() : "";
        if (!key) continue;
        const cfgObj = r.config && typeof r.config === "object" && !Array.isArray(r.config) ? (r.config as { api?: unknown }).api : undefined;
        const baseUrl = cfgObj && typeof cfgObj === "object" && !Array.isArray(cfgObj) ? (cfgObj as { baseUrl?: unknown }).baseUrl : undefined;
        if (typeof baseUrl === "string" && baseUrl.length > 0) result.providers[key] = { baseURL: baseUrl };
    }
    return result;
}

// Upstream path truth (zai-org/ZCode): getDataBaseDir() = ZCODE_DATA_BASE_DIR
// > home; getZCodeDataRootDir() = join(base, ".zcode"); both provider stores
// live under <root>/v2/; the personal file may be relocated wholesale via
// ZCODE_PERSONAL_PROVIDER_CONFIG_FILE (provider-runtime-env.ts). Legacy bili
// treated ZCODE_DATA_BASE_DIR as the .zcode root itself — kept as a compat
// candidate below, but the upstream derivation is canonical.
export function zcodeDataRoot(env: NodeJS.ProcessEnv): string {
    const base = env.ZCODE_DATA_BASE_DIR?.trim();
    return base !== undefined && base.length > 0 ? path.join(base, ".zcode") : path.join(os.homedir(), ".zcode");
}

export function zcodeStoreFileFor(env: NodeJS.ProcessEnv, kind: "new" | "legacy"): string {
    if (kind === "new") {
        const explicit = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
        if (explicit !== undefined && explicit.length > 0) return explicit;
    }
    return path.join(zcodeDataRoot(env), "v2", kind === "new" ? "provider_config.json" : "config.json");
}

export function resolveZcodeHome(env: NodeJS.ProcessEnv): string {
    return nonEmpty(env.ZCODE_DATA_BASE_DIR) ? env.ZCODE_DATA_BASE_DIR : path.join(os.homedir(), ".zcode");
}

export function zcodePersonalConfigFiles(zcodeHome: string, env: NodeJS.ProcessEnv): string[] {
    return [...new Set([zcodeStoreFileFor(env, "new"), path.join(zcodeHome, "v2", "provider_config.json")])];
}

export function zcodeLegacyConfigFiles(zcodeHome: string, env: NodeJS.ProcessEnv): string[] {
    return [...new Set([zcodeStoreFileFor(env, "legacy"), path.join(zcodeHome, "v2", "config.json")])];
}

export function readZcodeConfig(zcodeHome: string, env: NodeJS.ProcessEnv = process.env): ZcodeConfig {
    const merged: ZcodeConfig = { providers: {} };
    for (const file of zcodeLegacyConfigFiles(zcodeHome, env)) {
        for (const [name, prov] of Object.entries(parseZcodeConfig(readJsonFile(file)).providers)) {
            if (merged.providers[name] === undefined) merged.providers[name] = prov;
        }
    }
    for (const file of zcodePersonalConfigFiles(zcodeHome, env)) {
        for (const [name, prov] of Object.entries(parseZcodePersonalConfig(readJsonFile(file)).providers)) {
            merged.providers[name] = prov;
        }
    }
    return merged;
}

export function loadClientConfig(env: NodeJS.ProcessEnv, cwd: string): ClientConfig {
    const home = os.homedir();
    const config: ClientConfig = {};
    config.claude = readClaudeSettings(home, cwd, env);
    const codexHome = nonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex");
    config.codex = readCodexConfig(codexHome);
    config.pi = readPiConfig(resolvePiHome(env));
    config.zcode = readZcodeConfig(resolveZcodeHome(env), env);
    config.omp = readOmpConfig(resolveOmpHome(env));
    config.opencode = parseOpencodeProviders(readOpencodeConfigRoot(env));
    config.hermes = readHermesConfig(resolveHermesHome(env));
    config.dsh = readDshConfig(resolveDshHome(env));
    config.codebuddy = readCodebuddyConfig(resolveCodebuddyHome(env), cwd, env);
    config.qoder = readQoderConfig(resolveQoderHome(env), env);
    config.trae = readTraeConfig(env);
    config.kimi = readKimiConfig(resolveKimiHome(env), env);
    config.gemini = readGeminiEnvConfig(env);
    config.iflow = readIflowEnvConfig(env);
    config.mcode = readMcodeConfig(env);
    config.aider = readAiderConfig(env, cwd);
    config.goose = readGooseConfig(resolveGooseDirs(env), env);
    return config;
}

/** Base-URL env vars honored by aider's provider stack (litellm), verified
 *  against litellm sources (#1048): OPENAI_BASE_URL/OPENAI_API_BASE (openai
 *  family), ANTHROPIC_API_BASE/ANTHROPIC_BASE_URL (anthropic), GEMINI_API_BASE
 *  (gemini), DEEPSEEK_API_BASE (deepseek), plus AIDER_OPENAI_API_BASE —
 *  aider's configargparse auto_env_var_prefix form of --openai-api-base. */
export const AIDER_BASE_URL_ENVS = [
    "OPENAI_API_BASE",
    "OPENAI_BASE_URL",
    "AIDER_OPENAI_API_BASE",
    "ANTHROPIC_API_BASE",
    "ANTHROPIC_BASE_URL",
    "GEMINI_API_BASE",
    "DEEPSEEK_API_BASE",
];

/** Fallback MITM whitelist when no endpoint is declared anywhere (#1048):
 *  the two most common aider targets. */
export const AIDER_DEFAULT_MODEL_HOSTS = [
    "api.openai.com",
    "api.anthropic.com",
];

/** Read-only scan of `.aider.conf.yml` files for the `openai-api-base` key —
 *  aider's only base-URL setting in conf files (mirrors its CLI flag name).
 *  Precedence follows aider's own resolution (configargparse applies later
 *  default_config_files entries over earlier ones; aider lists them
 *  cwd → git root → home): home > git root > cwd. Only top-level scalar
 *  values are parsed; anything else is ignored. */
export function readAiderConfUrls(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
    const home = nonEmpty(env.HOME) ? env.HOME! : os.homedir();
    const candidates = [path.join(home, ".aider.conf.yml")];
    let dir = cwd;
    while (true) {
        if (fs.existsSync(path.join(dir, ".git"))) {
            candidates.push(path.join(dir, ".aider.conf.yml"));
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    candidates.push(path.join(cwd, ".aider.conf.yml"));
    for (const file of candidates) {
        let text: string;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch {
            continue;
        }
        for (const line of text.split(/\r?\n/)) {
            const m = /^openai-api-base:\s*(.+?)\s*$/.exec(line);
            if (!m) continue;
            let value = m[1]!;
            if (value.length >= 2 &&
                ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
                value = value.slice(1, -1);
            }
            if (value.trim().length > 0) return [value.trim()];
        }
    }
    return [];
}

/** Scan aider CLI args for endpoint declarations: `--openai-api-base <url>`
 *  (also `--openai-api-base=<url>`) and `--set-env NAME=value` where NAME is
 *  one of AIDER_BASE_URL_ENVS (aider exports --set-env values into the child
 *  env at startup, so they redirect model traffic like the env channel). */
export function discoverAiderArgUrls(clientArgs: string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < clientArgs.length; i++) {
        const a = clientArgs[i]!;
        if (a === "--openai-api-base" && i + 1 < clientArgs.length) {
            out.push(clientArgs[i + 1]!);
            i++;
        } else if (a.startsWith("--openai-api-base=")) {
            out.push(a.slice("--openai-api-base=".length));
        } else if (a === "--set-env" && i + 1 < clientArgs.length) {
            const kv = clientArgs[i + 1]!;
            const eq = kv.indexOf("=");
            if (eq > 0 && AIDER_BASE_URL_ENVS.includes(kv.slice(0, eq))) out.push(kv.slice(eq + 1));
            i++;
        } else if (a.startsWith("--set-env=")) {
            const kv = a.slice("--set-env=".length);
            const eq = kv.indexOf("=");
            if (eq > 0 && AIDER_BASE_URL_ENVS.includes(kv.slice(0, eq))) out.push(kv.slice(eq + 1));
        }
    }
    return out;
}

/** Discover aider's model endpoints from its runtime channels: inherited env
 *  (the launcher inherits the caller's shell, and aider/litellm read these at
 *  startup) plus `.aider.conf.yml` files. The CLI channel (--openai-api-base /
 *  --set-env) is merged by the launcher via discoverAiderArgUrls. Nothing is
 *  written — env-only, per #1048. */
export function readAiderConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AiderConfig {
    const urls: string[] = [];
    const seen = new Set<string>();
    const add = (raw: string | undefined): void => {
        if (!nonEmpty(raw)) return;
        const v = raw!.trim();
        if (seen.has(v)) return;
        seen.add(v);
        urls.push(v);
    };
    for (const name of AIDER_BASE_URL_ENVS) add(env[name]);
    for (const u of readAiderConfUrls(cwd, env)) add(u);
    return { baseUrls: urls };
}

/** The client a launcher run targets. Scopes model-window collection so a
 *  launched client's own declarations are authoritative (#436: launching
 *  `bili omp` with omp's models.yml declaring 131072 must not be overridden by
 *  another client's larger declaration for the same model id). */
export type ModelWindowScope = "claude" | "codex" | "pi" | "omp" | "opencode" | "hermes" | "dsh" | "codebuddy" | "qoder" | "trae" | "jcode" | "kimi" | "gemini" | "iflow" | "qwen" | "mcode" | "aider" | "copilot" | "amp" | "goose";

/** Collect per-model context windows from client configs the launcher can
 *  read (pi models.json, omp models.yml, opencode opencode.json, codex
 *  config.toml). With `scope`, ONLY that client's declarations are collected —
 *  the launched client's config is authoritative for its own proxy (#436:
 *  cross-client max-wins silently discarded the user's smaller configured
 *  window). Without `scope`, merges every client (legacy behavior). Same model
 *  id under multiple providers of the same client → the LARGEST window wins
 *  (the client will route by id; the proxy only needs the denominator). */
export function collectModelWindows(config: ClientConfig, scope?: ModelWindowScope): Record<string, number> {
    const out: Record<string, number> = {};
    const add = (wins: ModelWindow[] | undefined): void => {
        for (const w of wins ?? []) {
            if (!out[w.id] || w.contextWindow > out[w.id]) out[w.id] = w.contextWindow;
        }
    };
    if (scope) {
        if (scope === "codex") add(config.codex?.modelWindows);
        else if (scope === "pi") for (const p of Object.values(config.pi?.providers ?? {})) add(p.models);
        else if (scope === "omp") for (const p of Object.values(config.omp?.providers ?? {})) add(p.models);
        else if (scope === "opencode") for (const p of Object.values(config.opencode?.providers ?? {})) add(p.models);
        else if (scope === "codebuddy") add(config.codebuddy?.models);
        else if (scope === "kimi") add(config.kimi?.models);
        else if (scope === "mcode") add(config.mcode?.models);
        return out;
    }
    for (const p of Object.values(config.pi?.providers ?? {})) add(p.models);
    for (const p of Object.values(config.omp?.providers ?? {})) add(p.models);
    for (const p of Object.values(config.opencode?.providers ?? {})) add(p.models);
    add(config.codex?.modelWindows);
    add(config.codebuddy?.models);
    add(config.kimi?.models);
    add(config.mcode?.models);
    return out;
}

/** Configured max output per model id (#971): the same sources as
 *  collectModelWindows, reduced to the id → maxOutput map the launcher hands
 *  the proxy via BILI_LAUNCHER_MODEL_MAX_OUTPUTS. */
export function collectModelMaxOutputs(config: ClientConfig, scope?: ModelWindowScope): Record<string, number> {
    const out: Record<string, number> = {};
    const add = (wins: ModelWindow[] | undefined): void => {
        for (const w of wins ?? []) {
            if (w.maxOutput === undefined) continue;
            if (!out[w.id] || w.maxOutput > out[w.id]) out[w.id] = w.maxOutput;
        }
    };
    if (scope) {
        if (scope === "codex") add(config.codex?.modelWindows);
        else if (scope === "pi") for (const p of Object.values(config.pi?.providers ?? {})) add(p.models);
        else if (scope === "omp") for (const p of Object.values(config.omp?.providers ?? {})) add(p.models);
        else if (scope === "opencode") for (const p of Object.values(config.opencode?.providers ?? {})) add(p.models);
        else if (scope === "codebuddy") add(config.codebuddy?.models);
        else if (scope === "kimi") add(config.kimi?.models);
        else if (scope === "mcode") add(config.mcode?.models);
        return out;
    }
    for (const p of Object.values(config.pi?.providers ?? {})) add(p.models);
    for (const p of Object.values(config.omp?.providers ?? {})) add(p.models);
    for (const p of Object.values(config.opencode?.providers ?? {})) add(p.models);
    add(config.codex?.modelWindows);
    add(config.codebuddy?.models);
    add(config.kimi?.models);
    add(config.mcode?.models);
    return out;
}
