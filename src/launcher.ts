/**
 * `bili <client>` launcher — brings up the proxy on an independent port and
 * points a coding agent at it, auto-proxying BOTH schemes without editing the
 * client's config files:
 *   - HTTPS upstreams → cert MITM (HTTPS_PROXY + the proxy's MITM CA, with the
 *     discovered hosts whitelisted for TLS interception).
 *   - HTTP upstreams → `/bili/` baseURL rewrite (cert MITM can't intercept
 *     plaintext), applied via the client's own mechanism: codex `-c key=value`,
 *     claude `ANTHROPIC_BASE_URL` env, pi via an isolated `PI_CODING_AGENT_DIR`
 *     pointing at a temp copy of the pi home with a rewritten `models.json`.
 *
 *   bili pi     [-- client args...]   HTTPS_PROXY + NODE_EXTRA_CA_CERTS
 *   bili codex  [-- client args...]   HTTPS_PROXY + SSL_CERT_FILE
 *   bili claude [-- client args...]   HTTPS_PROXY + NODE_EXTRA_CA_CERTS
 *   bili test pi                      non-polluting pi smoke test
 *
 * The real upstream hosts are DISCOVERED by reading (never editing) the
 * client's own config: pi's `~/.pi/agent/models.json` providers, Codex's
 * `~/.codex/config.toml`, Claude's hardcoded api.anthropic.com. HTTPS hosts are
 * whitelisted for MITM so the proxy TLS-terminates exactly them and
 * blind-tunnels the rest; HTTP hosts are routed through the `/bili/` rewrite.
 * Compression rides the existing MITM + `/bili/` pipelines.
 *
 * Lifecycle: a proxy already listening on the requested port is REUSED
 * (not owned). Otherwise a detached proxy child is spawned on that port (or a
 * free one) and OWNED — it is killed when the client exits.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type StdioOptions } from "node:child_process";
import { DEFAULT_MITM_DOMAINS } from "./mitm.js";
import { isProxyInstanceFile, isPidAlive, readProxyInstanceFile, type ProxyInstanceFile } from "./instance.js";
import { selfPackageRoot, isBiliPiEntry, ompPluginLoadedFrom } from "./plugin-install.js";

/** Absolute path of a file inside our dist/, resolved via the package root
 * (import.meta.url-based) so it survives global-installed symlink bins
 * (~/.local/bin/bili → .../node_modules/billion-context) — process.argv[1]
 * stays at the symlink and would break path.resolve(dirname(argv[1]), ...). */
function selfDistFile(name: string): string {
    return path.join(selfPackageRoot(), "dist", name);
}
import { nonEmpty, resolvePiHome, resolveOmpHome, resolveHermesHome, resolveDshHome, loadClientConfig, collectModelWindows, type ClientConfig, type CodexConfig, resolveOpencodeConfigFile, type OpencodeConfig, type OpencodeProvider, type HermesConfig, type HermesProvider } from "./client-config.js";
import { loadRoutes, resolveConfiguredContextLimit, lookupContextLimit, type ProviderRoutes } from "./config.js";
import { contextFromRegistry } from "./registry.js";

export {
    type ClaudeSettings,
    type CodexProvider,
    type CodexConfig,
    type PiProvider,
    type PiConfig,
    type ClientConfig,
    type ZcodeProvider,
    type ZcodeConfig,
    readClaudeSettings,
    parseCodexToml,
    readCodexConfig,
    readPiConfig,
    loadClientConfig,
    parseZcodeConfig,
    readZcodeConfig,
    resolvePiHome,
    type OmpProvider,
    type OmpConfig,
    readOmpConfig,
    parseOmpYaml,
    resolveOmpHome,
    readHermesConfig,
    parseHermesYaml,
    resolveHermesHome,
    readDshConfig,
    parseDshSettingsYaml,
    resolveDshHome,
    resolveOpencodeConfigFile,
    readOpencodeConfig,
    type OpencodeConfig,
    type OpencodeProvider,
} from "./client-config.js";

export const LAUNCHER_DEFAULT_HOST = "127.0.0.1";
export const LAUNCHER_DEFAULT_PORT = 8787;
export const LAUNCH_CLIENTS = ["pi", "codex", "claude", "omp", "opencode", "hermes", "dsh", "pi-test"] as const;
export type ClientName = (typeof LAUNCH_CLIENTS)[number];
export type BaseClientName = "claude" | "codex" | "pi" | "omp" | "opencode" | "hermes" | "dsh";

const HEALTH_PATH = "/__bili/health";
const HEALTH_POLL_INTERVAL_MS = 200;
const SPAWN_WAIT_MS = 20000;
const PROBE_TIMEOUT_MS = 1500;

const DEFAULT_MITM_DOMAIN_SET = new Set(DEFAULT_MITM_DOMAINS.map((d) => d.toLowerCase()));

export interface SpawnChild {
    pid: number;
    unref?: () => void;
    kill?: (signal?: NodeJS.Signals) => boolean;
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export type SpawnFn = (
    command: string,
    args: readonly string[],
    options: { detached?: boolean; stdio?: StdioOptions; env?: NodeJS.ProcessEnv; shell?: boolean },
) => SpawnChild;

export interface LaunchOptions {
    host: string;
    port: number;
    passthrough: boolean;
    debug: boolean;
    mitmDomains?: string[];
    /** Per-model context windows read from the client's own config (pi
     *  models.json / omp models.yml / …). Handed to the spawned proxy via
     *  BILI_LAUNCHER_MODEL_WINDOWS so the nudge denominator matches the
     *  client's real window instead of the built-in table guess. */
    modelWindows?: Record<string, number>;
}

export interface ProxyHandle {
    origin: string;
    port: number;
    child?: SpawnChild;
    logPath?: string;
    attached?: boolean;
}

export interface LauncherDeps {
    fetchImpl?: (url: string) => Promise<{ ok: boolean }>;
    fetchHealthInfo?: (origin: string) => Promise<{ ok: boolean; instanceId?: string } | undefined>;
    readInstanceFile?: () => ProxyInstanceFile | { origin: string } | undefined;
    spawnImpl?: SpawnFn;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
}

export function isLaunchClient(value: string): value is ClientName {
    return (LAUNCH_CLIENTS as readonly string[]).includes(value);
}

export function baseClientName(client: ClientName): BaseClientName {
    return client === "pi-test" ? "pi" : client;
}

/** `pi-test` injects `--no-extensions` so the billion-context-pi client extension doesn't double-compress alongside the proxy. */
export function piTestArgs(client: ClientName, clientArgs: string[]): string[] {
    return client === "pi-test" ? ["--no-extensions", ...clientArgs] : clientArgs;
}

export function proxyOrigin(host: string, port: number): string {
    return `http://${host}:${port}`;
}

export function healthUrl(origin: string): string {
    return origin + HEALTH_PATH;
}

export function wrapUpstream(origin: string, upstream: string): string {
    const u = upstream.replace(/\/+$/, "");
    const prefix = origin + "/bili/";
    if (u.startsWith(prefix)) return u;
    return prefix + u;
}

/** Inverse of wrapUpstream: recover the real upstream from a `<…>/bili/<real>` URL. */
export function unwrapUpstream(url: string): string {
    const idx = url.indexOf("/bili/");
    return idx >= 0 ? url.slice(idx + "/bili/".length) : url;
}

export interface HttpRewrite {
    key: string;
    realUpstream: string;
}

export interface DiscoveredRoutes {
    httpsDomains: string[];
    httpRewrites: HttpRewrite[];
    httpsRewrites: HttpRewrite[];
}

export function resolveCaCertPath(env: NodeJS.ProcessEnv): string {
    const base = env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
    return path.join(base, "billion-context", "ca", "root-ca.pem");
}

export function resolveCombinedCaPath(env: NodeJS.ProcessEnv): string {
    const base = env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
    return path.join(base, "billion-context", "ca", "combined-ca.pem");
}

export function extractDomains(upstreams: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of upstreams) {
        if (!nonEmpty(raw)) continue;
        let url: URL;
        try {
            url = new URL(unwrapUpstream(raw));
        } catch {
            continue;
        }
        if (url.protocol !== "https:") continue;
        const host = url.hostname;
        if (!host || seen.has(host)) continue;
        seen.add(host);
        out.push(host);
    }
    return out;
}

export function discoverRoutes(client: ClientName, config: ClientConfig): DiscoveredRoutes {
    const httpsDomains: string[] = [];
    const httpRewrites: HttpRewrite[] = [];
    const httpsRewrites: HttpRewrite[] = [];
    const httpsSeen = new Set<string>();
    const rewriteKeys = new Set<string>();
    const httpsRewriteKeys = new Set<string>();
    const classify = (raw: string | undefined, key: string): void => {
        if (!nonEmpty(raw)) return;
        let url: URL;
        try {
            url = new URL(unwrapUpstream(raw));
        } catch {
            return;
        }
        if (url.protocol === "https:") {
            const host = url.hostname;
            if (host && !httpsSeen.has(host.toLowerCase())) {
                httpsSeen.add(host.toLowerCase());
                httpsDomains.push(host);
            }
            // Wrapped HTTPS (/bili/<https>): rewrite client base_url to the RAW
            // https upstream so HTTPS_PROXY routes it through the cert MITM.
            if (raw !== unwrapUpstream(raw) && !httpsRewriteKeys.has(key)) {
                httpsRewriteKeys.add(key);
                httpsRewrites.push({ key, realUpstream: unwrapUpstream(raw) });
            }
        } else if (url.protocol === "http:") {
            if (!rewriteKeys.has(key)) {
                rewriteKeys.add(key);
                httpRewrites.push({ key, realUpstream: unwrapUpstream(raw) });
            }
        }
    };

    if (client === "claude") {
        // Claude Code's undici fetch ignores HTTPS_PROXY, so cert MITM cannot
        // intercept it. Route every upstream — raw HTTP, raw HTTPS, or already
        // wrapped at a previous proxy origin — through the /bili/ URL form via
        // ANTHROPIC_BASE_URL instead (claude honors that env var natively).
        const raw = nonEmpty(config.claude?.anthropicBaseUrl) ? config.claude!.anthropicBaseUrl! : "https://api.anthropic.com";
        const real = unwrapUpstream(raw);
        try {
            const url = new URL(real);
            if ((url.protocol === "https:" || url.protocol === "http:") && !rewriteKeys.has("ANTHROPIC_BASE_URL")) {
                rewriteKeys.add("ANTHROPIC_BASE_URL");
                httpRewrites.push({ key: "ANTHROPIC_BASE_URL", realUpstream: real });
            }
        } catch {
            // Unparseable base URL: leave routes empty (proxy still runs; claude
            // falls back to its own default endpoint).
        }
    } else if (client === "pi") {
        for (const [name, prov] of Object.entries(config.pi?.providers ?? {})) {
            classify(prov.baseUrl, name);
        }
    } else if (client === "omp") {
        for (const [name, prov] of Object.entries(config.omp?.providers ?? {})) {
            classify(prov.baseUrl, name);
        }
    } else if (client === "opencode") {
        for (const [name, prov] of Object.entries(config.opencode?.providers ?? {})) {
            classify(prov.baseURL, name);
        }
    } else if (client === "hermes") {
        // hermes rides /bili/ for EVERY upstream (http AND https): its httpx
        // client builds its own CA bundle from certifi, so cert-MITM would
        // need extra trust config. Wrapping the URL form needs no cert at all.
        const hermesSeen = new Set<string>();
        for (const [name, prov] of Object.entries(config.hermes?.providers ?? {})) {
            if (!nonEmpty(prov.api)) continue;
            const real = unwrapUpstream(prov.api!);
            try {
                const url = new URL(real);
                if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                if (hermesSeen.has(name)) continue;
                hermesSeen.add(name);
                rewriteKeys.add(name);
                httpRewrites.push({ key: name, realUpstream: real });
            } catch {
                // Unparseable endpoint: skip.
            }
        }
    } else if (client === "dsh") {
        // dsh (deepseek-harness) has no proxy/CA knobs in its fetch stack:
        // every configured upstream rides the /bili/ URL form. The built-in
        // deepseek-official route is captured via $DEEPSEEK_BASE_URL in
        // runLaunch; user-configured settings.yaml endpoints here.
        const dshSeen = new Set<string>();
        let anon = 0;
        for (const raw of config.dsh?.baseUrls ?? []) {
            const real = unwrapUpstream(raw);
            try {
                const url = new URL(real);
                if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                if (dshSeen.has(real)) continue;
                dshSeen.add(real);
                anon += 1;
                rewriteKeys.add(`dsh-${anon}`);
                httpRewrites.push({ key: `dsh-${anon}`, realUpstream: real });
            } catch {
                // Unparseable endpoint: skip.
            }
        }
    } else {
        for (const [name, prov] of Object.entries(config.codex?.providers ?? {})) {
            classify(prov.baseUrl, `model_providers.${name}.base_url`);
        }
        classify(config.codex?.openaiBaseUrl, "openai_base_url");
    }

    return { httpsDomains, httpRewrites, httpsRewrites };
}

export function discoverDomains(client: ClientName, config: ClientConfig): string[] {
    return discoverRoutes(client, config).httpsDomains;
}

export function buildPiEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv, HTTPS_PROXY: origin, NODE_EXTRA_CA_CERTS: caPath, BILLION_CONTEXT_PROXY: origin };
}

export function buildCodexEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv, HTTPS_PROXY: origin, SSL_CERT_FILE: caPath, BILLION_CONTEXT_PROXY: origin };
}

export function buildCodexArgs(
    origin: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    extra: string[],
): string[] {
    const args: string[] = [];
    for (const r of httpRewrites) {
        args.push("-c", `${r.key}=${wrapUpstream(origin, r.realUpstream)}`);
    }
    for (const r of httpsRewrites) {
        args.push("-c", `${r.key}=${r.realUpstream}`);
    }
    args.push(...extra);
    return args;
}

/**
 * PR-D (#321): budget alignment for launcher-spawned agents. Resolves the
 * context window bili will use as its compression denominator for `model` —
 * the same chain the proxy applies, minus the per-request-only sources
 * (anthropic-beta header, plugin report, launcher window):
 *   per-route per-model config declaration → built-in CONTEXT_LIMIT_TABLE
 *   → models.dev registry (snapshot-first, offline-safe).
 */
export async function resolveLauncherWindow(
    model: string | undefined,
    routes: ProviderRoutes,
    upstreamUrl: string | undefined,
): Promise<number | undefined> {
    if (!model) return undefined;
    let host: string | undefined;
    if (upstreamUrl) {
        try {
            host = new URL(upstreamUrl).hostname;
        } catch {
            host = undefined;
        }
    }
    return (
        resolveConfiguredContextLimit(routes, upstreamUrl, model) ??
        lookupContextLimit(model) ??
        (await contextFromRegistry(model, host))
    );
}

/**
 * PR-D (#321): codex's auto-compact budget is keyed off the window CODEX
 * believes the model has (its bundled model table — bili has no say in it),
 * while bili's ACP compression is keyed off bili's own window resolution.
 * Two uncoordinated budgets (#292): when bili's window exceeds codex's
 * perception, codex's ledger (server-reported usage, which bili sees) crosses
 * codex's ~90% threshold first and fires its native compaction ahead of ACP.
 *
 * Injecting `-c model_context_window=<W> -c model_auto_compact_token_limit=<W>`
 * (W = bili's effective window) makes codex's auto-compact threshold 90%×W —
 * ACP (≈55%×W) always fires first, and codex's LOCAL compaction (benign for
 * bili: same-session truncation the kernel deactivates by message id) only
 * backstops when ACP fails, before codex's 95% hard cap. codex clamps both
 * values to its own max_context_window, so an over-generous W degrades to
 * codex's own perception instead of overshooting.
 *
 * Returns [] (no injection) when:
 *  - no model is configured (nothing to resolve a window for),
 *  - the user already set `model_context_window` in codex's config.toml
 *    (bili's proxy uses exactly that value as its launcher window — the
 *    budget is already aligned by the user's own declaration),
 *  - bili resolves no window for the model (no authoritative value to inject).
 * A user-set `model_auto_compact_token_limit` is honored (not overridden).
 */
/** The base URL codex will actually call: the selected provider's
 *  `base_url`, else top-level `openai_base_url`, else codex's built-in
 *  OpenAI default (model-provider-info: `https://api.openai.com/v1`). */
export function codexUpstreamUrl(codex: CodexConfig | undefined): string {
    const provider = codex?.modelProvider ? codex?.providers?.[codex.modelProvider]?.baseUrl : undefined;
    return provider ?? codex?.openaiBaseUrl ?? "https://api.openai.com/v1";
}

export async function resolveCodexBudgetArgs(opts: {
    model: string | undefined;
    clientWindow: number | undefined;
    clientAutoCompactLimit: number | undefined;
    routes: ProviderRoutes;
    upstreamUrl: string | undefined;
}): Promise<string[]> {
    const { model, clientWindow, clientAutoCompactLimit, routes, upstreamUrl } = opts;
    if (!model || clientWindow) return [];
    const window = await resolveLauncherWindow(model, routes, upstreamUrl);
    if (!window) return [];
    const limit = clientAutoCompactLimit ?? window;
    return ["-c", `model_context_window=${window}`, "-c", `model_auto_compact_token_limit=${limit}`];
}

/**
 * PR-D (#321): claude-code's auto-compact window is a single env knob —
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` outranks settings and is clamped DOWN to
 * the model window claude itself perceives (never up), so injecting bili's
 * window is always safe: it tightens claude's threshold to bili's budget when
 * bili's window is smaller, and is a no-op when it is larger.
 *
 * Returns {} (no injection) when: no model resolvable, the user already set
 * an explicit auto-compact window (settings `autoCompactWindow` or
 * `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, or a shell-exported env var), or
 * bili resolves no window for the model.
 */
export async function resolveClaudeBudgetEnv(opts: {
    model: string | undefined;
    userAutoCompactWindow: number | undefined;
    shellAutoCompactWindow: string | undefined;
    routes: ProviderRoutes;
    upstreamUrl: string | undefined;
}): Promise<NodeJS.ProcessEnv> {
    const { model, userAutoCompactWindow, shellAutoCompactWindow, routes, upstreamUrl } = opts;
    if (!model || userAutoCompactWindow !== undefined || nonEmpty(shellAutoCompactWindow)) return {};
    const window = await resolveLauncherWindow(model, routes, upstreamUrl);
    if (!window) return {};
    return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) };
}

export function buildClaudeEnv(
    origin: string,
    caPath: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv, HTTPS_PROXY: origin, NODE_EXTRA_CA_CERTS: caPath, BILLION_CONTEXT_PROXY: origin };
    const r = httpRewrites.find((rw) => rw.key === "ANTHROPIC_BASE_URL");
    if (r) env.ANTHROPIC_BASE_URL = wrapUpstream(origin, r.realUpstream);
    const hr = httpsRewrites.find((rw) => rw.key === "ANTHROPIC_BASE_URL");
    if (hr) env.ANTHROPIC_BASE_URL = hr.realUpstream;
    return env;
}

// --- Launcher plugin mode (#162): inject the MCP shell + session hooks as
// spawn-time flags, never touching host config files on disk. ---

/** Direct-URL mode: the host talks to the proxy via the /bili/ prefix (no
 *  MITM/CA). OPT-IN via BILI_LAUNCHER_DIRECT=1 — the default keeps the
 *  transparent-proxy (MITM) route so existing `bili claude` / `bili codex`
 *  setups behave exactly as before: OAuth-subscription traffic and custom
 *  relay endpoints (ANTHROPIC_BASE_URL / codex provider config) keep working.
 *  Direct mode changes what the host points at, so it must be a deliberate
 *  choice, not a silent upgrade. */
export function launcherDirectUrl(env: NodeJS.ProcessEnv): boolean {
    return env.BILI_LAUNCHER_DIRECT === "1";
}

/** True when the host points at self-hosted inference: loopback, RFC1918,
 *  link-local, IPv6 ULA, or an mDNS/LAN name. Those servers (sglang/vllm/
 *  ollama/llama.cpp) do not understand codex's `namespace` tool type, so
 *  MCP-injected tools would be silently invisible to the model. */
export function isPrivateUpstreamHost(raw: string): boolean {
    let host: string;
    try {
        host = new URL(raw).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal")) return true;
    if (host.startsWith("[")) host = host.slice(1, -1);
    if (host.includes(":")) {
        if (host === "::1" || host === "::") return true;
        const first = host.split(":")[0] ?? "";
        if (/^f[cd]/.test(first)) return true;
        if (/^fe[89ab]/.test(first)) return true;
        const dotted = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
        if (dotted && isPrivateIPv4(dotted[1]!)) return true;
        const hex = /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
        if (hex) {
            const w1 = Number.parseInt(hex[1]!, 16);
            const w2 = Number.parseInt(hex[2]!, 16);
            if (isPrivateIPv4(`${w1 >> 8}.${w1 & 0xff}.${w2 >> 8}.${w2 & 0xff}`)) return true;
        }
        return false;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host);
    return false;
}

function isPrivateIPv4(host: string): boolean {
    const a = Number.parseInt(host.split(".")[0] ?? "", 10);
    const b = Number.parseInt(host.split(".")[1] ?? "", 10);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

/** Plugin-in-launcher MCP injection is ON by default for claude/codex
 *  (zero-config, mirroring the pi/omp/opencode auto-injection): the launcher
 *  injects a single `bili` MCP server so the host gets native tools instead
 *  of wire-injected ones. `BILI_LAUNCHER_PLUGIN=0` is the kill switch back to
 *  pure wire mode — for hosts older than the verified builds (claude 2.1.227,
 *  codex 0.147.0) that have not been tested against `--mcp-config` /
 *  `-c mcp_servers.*`. pi/omp/opencode/hermes/dsh are always excluded — they
 *  have their own native plugin surface (or none).
 *
 *  codex auto-fallback: codex 0.147 ships MCP tools to the model as a
 *  `namespace` tool type. Self-hosted upstreams (sglang/vllm/ollama) do not
 *  parse it — the injected tools become silently invisible and the model
 *  fumbles for them. When the codex upstream is a local/private endpoint and
 *  the user has not chosen explicitly, wire mode (flat tools every server
 *  understands) is the sane default. `BILI_LAUNCHER_PLUGIN=1` forces plugin
 *  mode regardless of the upstream. */
export function launcherInjectMcp(env: NodeJS.ProcessEnv, base: string, codexUpstream?: string): boolean {
    if (base === "pi" || base === "omp" || base === "opencode" || base === "hermes" || base === "dsh") return false;
    if (env.BILI_LAUNCHER_PLUGIN === "0") return false;
    if (base === "codex" && env.BILI_LAUNCHER_PLUGIN === undefined && codexUpstream !== undefined && isPrivateUpstreamHost(codexUpstream)) {
        return false;
    }
    return true;
}

/** Ephemeral MCP config for --mcp-config / -c mcp_servers.bili.*: a single
 *  "bili" stdio server running dist/mcp.js. Args are kept flat so codex's
 *  TOML value parser stays happy. */
export function buildMcpConfig(origin: string): { mcpServers: { bili: { command: string; args: string[]; env: Record<string, string> } } } {
    const script = selfDistFile("mcp.js");
    return {
        mcpServers: {
            bili: {
                command: process.execPath,
                args: [script],
                env: { BILI_MCP_PROXY: origin },
            },
        },
    };
}

/** Ephemeral Claude Code settings for --settings: direct-URL mode only needs
 *  the base URL, which we pass via spawn env (ANTHROPIC_BASE_URL) — no
 *  settings file, no hooks. Session registration happens inside the MCP
 *  shell (CLAUDE_CODE_SESSION_ID is passed to MCP children by claude
 *  itself, verified 2.1.227). */
export function buildClaudePluginEnv(origin: string, directUrl: boolean, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (!directUrl) return baseEnv;
    const upstream = baseEnv.BILI_CLAUDE_UPSTREAM?.trim() || "https://api.anthropic.com";
    return { ...baseEnv, ANTHROPIC_BASE_URL: wrapUpstream(origin, upstream) };
}

/** Codex: -c inline overrides for the bili MCP server only.
 *
 *  `conversationId` is a per-spawn UUID injected as BILI_CONVERSATION_ID:
 *  codex passes no session id to MCP children (verified codex-cli 0.147.0),
 *  so the MCP shell uses this to self-register headlessly; the first model
 *  request that creates a NEW session consumes the registration and binds
 *  the conversation (MITM route — in direct-URL mode the model traffic does
 *  not reach the proxy and the binding cannot happen, see the direct-mode
 *  warning). Without it every native tool call fails with "no conversation
 *  id". */
export function buildCodexMcpArgs(origin: string, conversationId: string): string[] {
    const script = selfDistFile("mcp.js");
    return [
        "-c",
        `mcp_servers.bili.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.bili.args=${JSON.stringify([script])}`,
        "-c",
        `mcp_servers.bili.env.BILI_MCP_PROXY=${JSON.stringify(origin)}`,
        "-c",
        `mcp_servers.bili.env.BILI_CONVERSATION_ID=${JSON.stringify(conversationId)}`,
    ];
}

/**
 * Shared persistent-overlay machinery for home-dir-based launchers (pi / omp /
 * hermes). The overlay (`<realHome>-bili`) symlinks every real-home entry
 * except the launcher-generated file (models.json / models.yml / config.yaml),
 * which is rewritten in place atomically.
 *
 * The overlay is PERSISTENT and never deleted: these agents record absolute
 * paths derived from their home override into shared state (resume pointers
 * like omp's `terminal-sessions/<tty>`, fork metadata, session references in
 * history dbs), so an ephemeral temp home removed on exit leaves dangling
 * pointers — the agent's history becomes invisible — and any state the agent
 * created inside the temp home (entries the real home lacks) is destroyed.
 * A stable overlay keeps every recorded path resolvable forever and lets
 * overlay-created state survive across runs.
 *
 * Refresh semantics on every launch: stale `.file.pid.tmp` drafts are dropped;
 * dead or mis-targeted symlinks are re-pointed; real files/dirs that shadow a
 * real-home entry are merged into the real home (recursively; mtime-newer-wins
 * for files, losers preserved as `<name>.bili-conflict`) and only removed from
 * the overlay when the merge fully succeeded; entries the real home lacks are
 * kept as-is. A `.bili-launch.pid` marker warns when two launches share the
 * overlay (each launch rewrites the generated file with its own proxy origin).
 */
function overlayLockPath(overlay: string): string {
    return path.join(overlay, ".bili-launch.pid");
}

function livePidHoldsOverlay(overlay: string): number | undefined {
    let raw: string | undefined;
    try {
        raw = fs.readFileSync(overlayLockPath(overlay), "utf8");
    } catch {
        return undefined;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return undefined;
    try {
        process.kill(pid, 0);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    }
    return pid;
}

/**
 * Link one real-home entry into the overlay. The reparse-point kind is chosen
 * explicitly from the target's type: on Windows a directory must be a junction
 * (privilege-free, unambiguous) — libuv's type-omitted default creates a
 * file-tag symlink for dirs that Win32 readdir(withFileTypes) and some
 * backup/indexers don't follow (#381 review) — while a file is a 'file'
 * symlink (needs SeCreateSymbolicLinkPrivilege). Non-Windows ignores the type,
 * so "dir"/"file" are just plain symlinks there. On EPERM/EACCES/EINVAL — the
 * default for an unprivileged Windows process, #381 — a file falls back to a
 * privilege-free hardlink (same volume, write-through) → copy; a directory
 * retries the junction.
 */
function linkOverlayEntry(realHome: string, overlay: string, entry: string): boolean {
    const target = path.join(realHome, entry);
    const link = path.join(overlay, entry);
    let st: fs.Stats;
    try {
        st = fs.lstatSync(target);
    } catch {
        return false;
    }
    const kind: "dir" | "file" | "junction" = st.isDirectory()
        ? (process.platform === "win32" ? "junction" : "dir")
        : "file";
    try {
        fs.symlinkSync(target, link, kind);
        return true;
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EPERM" && code !== "EACCES" && code !== "EINVAL") return false;
    }
    if (st.isDirectory()) {
        try {
            fs.symlinkSync(target, link, "junction");
            return true;
        } catch {
            return false;
        }
    }
    try {
        fs.linkSync(target, link);
        return true;
    } catch {
        try {
            fs.copyFileSync(target, link);
            return true;
        } catch {
            return false;
        }
    }
}

/** True when overlayPath hardlinks realPath (same dev+ino, nlink>1) — the
 *  Windows file fallback (#381). Its writes already reached the real home, so
 *  on refresh it is re-pointed (drop + re-link), never merged back. */
function isWriteThroughHardlink(overlayPath: string, realPath: string, st: fs.Stats): boolean {
    if (st.isDirectory() || st.isSymbolicLink() || st.nlink <= 1) return false;
    try {
        const realSt = fs.lstatSync(realPath);
        return st.dev === realSt.dev && st.ino === realSt.ino;
    } catch {
        return false;
    }
}

/** SQLite set for a main-db name: the db plus its WAL, shared-memory, and
 *  rollback-journal sidecars. A WAL/journal is only valid against its exact
 *  main db, so the set must move as a unit — splitting it corrupts the
 *  database (#381). */
function sqliteSetMembers(base: string): string[] {
    return [base, `${base}-wal`, `${base}-shm`, `${base}-journal`];
}

/** A `<name>.bili-conflict` target that does not already exist, so a retry
 *  round never silently overwrites a previous round's preserved loser (#381
 *  review): renameSync clobbers an existing target, so append `.1`, `.2`, …
 *  until the name is free. */
function freeConflictName(dst: string): string {
    let candidate = `${dst}.bili-conflict`;
    let n = 1;
    while (n < 100000) {
        try {
            fs.lstatSync(candidate);
            candidate = `${dst}.bili-conflict.${n}`;
            n += 1;
        } catch {
            return candidate;
        }
    }
    return candidate;
}

/** Move a SQLite set (see sqliteSetMembers) from overlay to real home as one
 *  unit (#381). The authoritative generation is decided ONCE by the main db's
 *  mtime — a WAL/journal is only valid against its exact main db, so the whole
 *  set must come from a single side: per-member mtime adjudication could splice
 *  a newer main db with a newer WAL from the other side and corrupt the
 *  database. The winner's members become the real home's active set; every
 *  losing member is preserved as `<name>.bili-conflict` (never overwritten). A
 *  set with no main db on either side (orphan sidecars) is stale residue and is
 *  preserved wholesale as conflicts, never moved in as an active db. If any
 *  rename fails (real db open/locked on Windows) the moved ones roll back and
 *  the set stays for the next launch. */
function mergeSqliteSet(overlay: string, realHome: string, base: string): boolean {
    const members = sqliteSetMembers(base);
    const statFile = (dir: string, m: string): fs.Stats | undefined => {
        try {
            const st = fs.lstatSync(path.join(dir, m));
            return st.isFile() ? st : undefined;
        } catch {
            return undefined;
        }
    };
    const oMain = statFile(overlay, base);
    const rMain = statFile(realHome, base);
    let winner: "overlay" | "real" | "orphan";
    if (oMain && rMain) winner = rMain.mtimeMs >= oMain.mtimeMs ? "real" : "overlay";
    else if (oMain) winner = "overlay";
    else if (rMain) winner = "real";
    else winner = "orphan";
    const undo: (() => void)[] = [];
    const rollback = (): void => {
        for (const step of undo.reverse()) {
            try {
                step();
            } catch {}
        }
        undo.length = 0;
    };
    const movePreserving = (src: string, dst: string): void => {
        let dstStat: fs.Stats | undefined;
        try {
            dstStat = fs.lstatSync(dst);
        } catch {}
        if (dstStat) {
            if (dstStat.isDirectory()) throw new Error("target is a directory");
            const conflict = freeConflictName(dst);
            fs.renameSync(dst, conflict);
            undo.push(() => fs.renameSync(conflict, dst));
        }
        fs.renameSync(src, dst);
        undo.push(() => fs.renameSync(dst, src));
    };
    const preserveAsConflict = (src: string, name: string): void => {
        const conflict = freeConflictName(path.join(realHome, name));
        fs.renameSync(src, conflict);
        undo.push(() => fs.renameSync(conflict, src));
    };
    try {
        for (const m of members) {
            const o = statFile(overlay, m);
            const r = statFile(realHome, m);
            if (winner === "overlay") {
                if (o) movePreserving(path.join(overlay, m), path.join(realHome, m));
                else if (r) preserveAsConflict(path.join(realHome, m), m);
            } else if (winner === "real") {
                if (o) preserveAsConflict(path.join(overlay, m), m);
            } else {
                if (o) preserveAsConflict(path.join(overlay, m), m);
                else if (r) preserveAsConflict(path.join(realHome, m), m);
            }
        }
        return true;
    } catch {
        rollback();
        return false;
    }
}

function refreshOverlayHome(realHome: string, overlay: string, generatedFile: string | string[]): boolean {
    const generatedFiles = new Set(Array.isArray(generatedFile) ? generatedFile : [generatedFile]);
    const isGeneratedDraft = (name: string): boolean =>
        [...generatedFiles].some((g) => name.startsWith(`.${g}.`) && name.endsWith(".tmp"));
    try {
        fs.mkdirSync(overlay, { recursive: true });
    } catch {
        return false;
    }
    const holder = livePidHoldsOverlay(overlay);
    if (holder !== undefined) {
        console.error(
            `bili: another bili launch (pid ${holder}) is using ${overlay} — concurrent launches share this overlay and the last one's proxy port wins in the generated config.`,
        );
    }
    try {
        fs.writeFileSync(overlayLockPath(overlay), `${process.pid}\n`);
    } catch {}
    const realEntries = new Set<string>();
    try {
        for (const entry of fs.readdirSync(realHome)) realEntries.add(entry);
    } catch {}
    try {
        let overlayEntries: string[];
        try {
            overlayEntries = fs.readdirSync(overlay);
        } catch {
            overlayEntries = [];
        }
        // SQLite sets in the overlay root move as a unit (#381). A set whose
        // main db is a write-through hardlink keeps its -wal/-shm in the
        // overlay (SQLite recovers them in place on next open) and only
        // re-points the db; any other set moves wholesale.
        const dbSets: { base: string; keepSidecars: boolean }[] = [];
        for (const entry of overlayEntries) {
            if (!entry.endsWith(".db") || generatedFiles.has(entry)) continue;
            const members = sqliteSetMembers(entry);
            if (!members.some((m) => m !== entry && overlayEntries.includes(m))) continue;
            let mainSt: fs.Stats | undefined;
            try {
                mainSt = fs.lstatSync(path.join(overlay, entry));
            } catch {}
            const keepSidecars =
                mainSt !== undefined && isWriteThroughHardlink(path.join(overlay, entry), path.join(realHome, entry), mainSt);
            dbSets.push({ base: entry, keepSidecars });
        }
        const skipEntries = new Set<string>();
        for (const { base, keepSidecars } of dbSets) {
            for (const m of sqliteSetMembers(base)) {
                if (keepSidecars ? m !== base : true) skipEntries.add(m);
            }
        }
        for (const entry of overlayEntries) {
            if (generatedFiles.has(entry)) continue;
            const overlayPath = path.join(overlay, entry);
            if (isGeneratedDraft(entry)) {
                try {
                    fs.unlinkSync(overlayPath);
                } catch {}
                continue;
            }
            if (skipEntries.has(entry)) continue;
            let st: fs.Stats;
            try {
                st = fs.lstatSync(overlayPath);
            } catch {
                continue;
            }
            if (st.isSymbolicLink()) {
                let target: string | undefined;
                try {
                    target = fs.readlinkSync(overlayPath);
                } catch {}
                const wanted = realEntries.has(entry) ? path.join(realHome, entry) : undefined;
                if (!wanted || target !== wanted) {
                    try {
                        fs.unlinkSync(overlayPath);
                    } catch {}
                }
            } else if (realEntries.has(entry)) {
                const realPath = path.join(realHome, entry);
                if (isWriteThroughHardlink(overlayPath, realPath, st)) {
                    try {
                        fs.unlinkSync(overlayPath);
                    } catch {}
                } else if (mergeOverlayEntry(overlayPath, realPath, generatedFiles)) {
                    try {
                        fs.rmSync(overlayPath, { recursive: true, force: true });
                    } catch {}
                } else {
                    console.error(`bili: could not merge ${overlayPath} into ${realHome} — kept in place, resolve manually.`);
                }
            }
        }
        for (const { base, keepSidecars } of dbSets) {
            if (keepSidecars) continue;
            if (!mergeSqliteSet(overlay, realHome, base)) {
                console.error(
                    `bili: could not merge the SQLite set ${base} / ${base}-wal / ${base}-shm into ${realHome} ` +
                        `(the real db is likely open/locked) — kept in the overlay, retry on the next launch.`,
                );
            }
        }
        let accessible = 0;
        let total = 0;
        const linkFailures: string[] = [];
        for (const entry of realEntries) {
            if (generatedFiles.has(entry)) continue;
            total += 1;
            const overlayPath = path.join(overlay, entry);
            let present = false;
            try {
                fs.lstatSync(overlayPath);
                present = true;
            } catch {}
            // A correct link left in place by the per-entry loop (or a SQLite
            // set that failed to merge and rolled back) already makes the entry
            // accessible — re-linking would EEXIST, so skip it.
            if (present) {
                accessible += 1;
                continue;
            }
            if (linkOverlayEntry(realHome, overlay, entry)) {
                accessible += 1;
            } else {
                linkFailures.push(entry);
            }
        }
        if (total > 0 && accessible === 0) {
            console.error(
                `bili: overlay ${overlay} is HOLLOW — none of ${total} real-home entries is reachable ` +
                    `(on Windows, symlink creation is denied without Developer Mode and the junction/hardlink/copy fallbacks also failed). ` +
                    `The client will start from its real home without the bili config rewrite.`,
            );
            return false;
        }
        if (linkFailures.length > 0) {
            console.error(
                `bili: overlay ${overlay} — could not link ${linkFailures.length} entr${linkFailures.length === 1 ? "y" : "ies"}: ${linkFailures.join(", ")}. ` +
                    `The client may miss those (on Windows, enable Developer Mode for full symlink support).`,
            );
        }
    } catch {}
    return true;
}

function mergeOverlayEntry(src: string, dst: string, excludedNames?: ReadonlySet<string>): boolean {
    let st: fs.Stats;
    try {
        st = fs.lstatSync(src);
    } catch {
        return true;
    }
    let dstStat: fs.Stats | undefined;
    try {
        dstStat = fs.lstatSync(dst);
    } catch {}
    if (st.isDirectory()) {
        if (dstStat && !dstStat.isDirectory()) {
            try {
                fs.renameSync(dst, freeConflictName(dst));
                dstStat = undefined;
            } catch {
                return false;
            }
        }
        try {
            fs.mkdirSync(dst, { recursive: true });
        } catch {
            return false;
        }
        let entries: string[];
        try {
            entries = fs.readdirSync(src);
        } catch {
            return false;
        }
        let ok = true;
        for (const entry of entries) {
            // #410: generated configs must never merge back into the real
            // home, at ANY depth — a nested promote bakes proxy URLs into
            // the user's real config.
            if (excludedNames?.has(entry)) continue;
            if (!mergeOverlayEntry(path.join(src, entry), path.join(dst, entry), excludedNames)) ok = false;
        }
        return ok;
    }
    if (dstStat && dstStat.isDirectory()) {
        try {
            fs.renameSync(src, freeConflictName(dst));
            return true;
        } catch {
            return false;
        }
    }
    if (st.isSymbolicLink()) {
        if (dstStat) {
            try {
                fs.unlinkSync(src);
            } catch {}
            return true;
        }
        try {
            fs.renameSync(src, dst);
        } catch {
            return false;
        }
        return true;
    }
    if (dstStat && dstStat.mtimeMs >= st.mtimeMs) {
        try {
            fs.renameSync(src, freeConflictName(dst));
            return true;
        } catch {
            return false;
        }
    }
    if (dstStat) {
        try {
            fs.renameSync(dst, freeConflictName(dst));
        } catch {
            return false;
        }
    }
    try {
        fs.renameSync(src, dst);
        return true;
    } catch {
        return false;
    }
}

/** True when the real pi settings.json already loads a bili plugin entry —
 *  in that case the launcher must NOT add `-e dist/agent/pi.js` on top (pi
 *  keeps both loaded and same-name tools/commands clash). */
function piPluginInstalled(piHome: string): boolean {
    const root = selfPackageRoot();
    if (!root) return false;
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(piHome, "settings.json"), "utf8")) as { packages?: unknown };
        const list = Array.isArray(parsed.packages) ? parsed.packages.map(String) : [];
        return list.some((p) => isBiliPiEntry(p, root));
    } catch {
        return false;
    }
}

function writeOverlayFileAtomic(overlay: string, fileName: string, contents: string): void {
    const draft = path.join(overlay, `.${fileName}.${process.pid}.tmp`);
    try {
        fs.writeFileSync(draft, contents);
        fs.renameSync(draft, path.join(overlay, fileName));
    } catch {
        try {
            fs.rmSync(draft, { force: true });
        } catch {}
    }
}

function writePiCompactionDisabledSettings(piHome: string, overlay: string): void {
    let settings: Record<string, unknown> = {};
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(piHome, "settings.json"), "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            settings = parsed as Record<string, unknown>;
        }
    } catch {}
    const compactionRaw = settings.compaction;
    const compaction =
        compactionRaw && typeof compactionRaw === "object" && !Array.isArray(compactionRaw)
            ? { ...(compactionRaw as Record<string, unknown>) }
            : {};
    compaction.enabled = false;
    settings.compaction = compaction;
    writeOverlayFileAtomic(overlay, "settings.json", JSON.stringify(settings, null, 2));
}

export function preparePiHttpRewrite(
    piHome: string,
    origin: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
): string | undefined {
    if (!fs.existsSync(piHome)) return undefined;
    const overlay = `${piHome}-bili`;
    // #447: the overlay always carries a settings.json disabling pi's native
    // auto-compaction (its summarizer must never fire alongside bili's ACP
    // compression); models.json is generated only when present, so both stay
    // out of the real-home symlink set.
    const generated: string[] = ["settings.json"];
    let modelsRoot: Record<string, unknown> | undefined;
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(piHome, "models.json"), "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            modelsRoot = parsed as Record<string, unknown>;
            generated.push("models.json");
        }
    } catch {}
    if (!refreshOverlayHome(piHome, overlay, generated)) return undefined;
    if (modelsRoot) {
        const providersVal = modelsRoot.providers;
        if (providersVal && typeof providersVal === "object" && !Array.isArray(providersVal)) {
            const providers = providersVal as Record<string, unknown>;
            for (const r of httpRewrites) {
                const prov = providers[r.key];
                if (prov && typeof prov === "object" && !Array.isArray(prov)) {
                    const p = prov as { baseUrl?: unknown };
                    const existing = typeof p.baseUrl === "string" ? p.baseUrl : r.realUpstream;
                    p.baseUrl = wrapUpstream(origin, unwrapUpstream(existing));
                }
            }
            for (const r of httpsRewrites) {
                const prov = providers[r.key];
                if (prov && typeof prov === "object" && !Array.isArray(prov)) {
                    const p = prov as { baseUrl?: unknown };
                    p.baseUrl = r.realUpstream;
                }
            }
        }
        writeOverlayFileAtomic(overlay, "models.json", JSON.stringify(modelsRoot));
    }
    writePiCompactionDisabledSettings(piHome, overlay);
    return overlay;
}

/**
 * omp counterpart of preparePiHttpRewrite: line-based (indentation-tracked)
 * models.yml rewrite (HTTP → /bili/ wrap, wrapped-HTTPS → raw https for cert
 * MITM) riding the persistent `<ompHome>-bili` overlay from
 * refreshOverlayHome — comments, ordering and formatting are preserved
 * verbatim, and the real models.yml is never touched.
 */
function atomicWriteTextFile(filePath: string, contents: string): void {
    const draft = `${filePath}.${process.pid}.bili-tmp`;
    try {
        fs.writeFileSync(draft, contents);
        fs.renameSync(draft, filePath);
    } catch {
        try {
            fs.rmSync(draft, { force: true });
        } catch {}
        throw new Error(`bili: could not write ${filePath}`);
    }
}

export function liveProxyPorts(): Set<number> {
    const ports = new Set<number>();
    const inst = readProxyInstanceFile();
    if (isProxyInstanceFile(inst)) {
        if (isPidAlive(inst.pid)) ports.add(inst.port);
    } else if (inst) {
        try {
            ports.add(new URL(inst.origin).port === "" ? 80 : Number(new URL(inst.origin).port));
        } catch {}
    }
    return ports;
}

/** #410: repair a real config that had proxy-prefixed URLs baked in. The
 *  original upstream is embedded in the /bili/ path, so dead-origin wraps
 *  unpack mechanically; a LIVE origin is left alone (the user may have
 *  pointed the config at a running proxy deliberately). */
export function unpackDeadProxyUrlsInFile(filePath: string, livePorts: Set<number>): number {
    let txt: string;
    try {
        txt = fs.readFileSync(filePath, "utf8");
    } catch {
        return 0;
    }
    const re = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/bili\/(https?:\/\/\S+)/g;
    let changed = 0;
    const out = txt.replace(re, (full, portStr: string, raw: string) => {
        if (livePorts.has(Number(portStr))) return full;
        changed += 1;
        return raw;
    });
    if (changed === 0) return 0;
    try {
        atomicWriteTextFile(filePath, out);
    } catch {
        return 0;
    }
    return changed;
}

function mergeOmpCompactionDisabledYaml(text: string): string {
    const lines = text.split(/\r?\n/);
    let compactionLine = -1;
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const indent = rawLine.length - rawLine.trimStart().length;
        if (indent === 0 && /^compaction:\s*(#.*)?$/.test(trimmed)) {
            compactionLine = i;
            break;
        }
    }
    if (compactionLine === -1) {
        const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
        return `${base}compaction:\n  enabled: false\n`;
    }
    for (let i = compactionLine + 1; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const indent = rawLine.length - rawLine.trimStart().length;
        if (indent === 0) break;
        if (/^enabled:/.test(trimmed)) {
            const leading = rawLine.slice(0, rawLine.length - rawLine.trimStart().length);
            const commentMatch = /\s+#.*$/.exec(rawLine);
            const comment = commentMatch ? commentMatch[0] : "";
            lines[i] = `${leading}enabled: false${comment}`;
            return lines.join("\n");
        }
    }
    let childIndent = 2;
    for (let i = compactionLine + 1; i < lines.length; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const indent = rawLine.length - rawLine.trimStart().length;
        if (indent === 0) break;
        childIndent = indent;
        break;
    }
    lines.splice(compactionLine + 1, 0, `${" ".repeat(childIndent)}enabled: false`);
    return lines.join("\n");
}

function writeOmpCompactionDisabledConfig(ompHome: string, overlay: string): void {
    // omp reads config.yml at runtime (settings.json is only a one-time migration
    // source, renamed to .bak). Merge compaction.enabled=false over the real
    // config.yml / config.yaml / settings.json so the native auto-compaction
    // never fires alongside bili's ACP compression. JSON is a valid YAML subset,
    // so the settings.json fallback is written as JSON and parsed by omp fine.
    let base: string | undefined;
    let baseIsJson = false;
    for (const name of ["config.yml", "config.yaml"]) {
        try {
            base = fs.readFileSync(path.join(ompHome, name), "utf8");
            break;
        } catch {}
    }
    if (base === undefined) {
        try {
            base = fs.readFileSync(path.join(ompHome, "settings.json"), "utf8");
            baseIsJson = true;
        } catch {}
    }
    let merged: string;
    if (base === undefined) {
        merged = "compaction:\n  enabled: false\n";
    } else if (baseIsJson) {
        let settings: Record<string, unknown> = {};
        try {
            const parsed: unknown = JSON.parse(base);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                settings = parsed as Record<string, unknown>;
            }
        } catch {}
        const compactionRaw = settings.compaction;
        const compaction =
            compactionRaw && typeof compactionRaw === "object" && !Array.isArray(compactionRaw)
                ? { ...(compactionRaw as Record<string, unknown>) }
                : {};
        compaction.enabled = false;
        settings.compaction = compaction;
        merged = JSON.stringify(settings, null, 2);
    } else {
        merged = mergeOmpCompactionDisabledYaml(base);
    }
    writeOverlayFileAtomic(overlay, "config.yml", merged);
}

export function prepareOmpHttpRewrite(
    ompHome: string,
    origin: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
): string | undefined {
    if (!fs.existsSync(ompHome)) return undefined;
    const overlay = `${ompHome}-bili`;
    // #449: the overlay always carries a config.yml disabling omp's native
    // auto-compaction (its summarizer must never fire alongside bili's ACP
    // compression); models.yml is generated only when present, so both stay
    // out of the real-home symlink set.
    const generated: string[] = ["config.yml"];
    const modelsPath = path.join(ompHome, "models.yml");
    const unpacked = unpackDeadProxyUrlsInFile(modelsPath, liveProxyPorts());
    if (unpacked > 0) {
        console.error(`bili: unpacked ${unpacked} dead proxy URL(s) from the real ${modelsPath}`);
    }
    let modelsText: string | undefined;
    try {
        modelsText = fs.readFileSync(modelsPath, "utf8");
        generated.push("models.yml");
    } catch {}
    if (!refreshOverlayHome(ompHome, overlay, generated)) return undefined;
    if (modelsText !== undefined) {
        const httpMap = new Map(httpRewrites.map((r) => [r.key, wrapUpstream(origin, r.realUpstream)]));
        const httpsMap = new Map(httpsRewrites.map((r) => [r.key, r.realUpstream]));
        const lines = modelsText.split(/\r?\n/);
        let providersIndent = -1;
        let providerIndent = -1;
        let currentProvider: string | null = null;
        for (let i = 0; i < lines.length; i++) {
            const rawLine = lines[i];
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
                currentProvider = m ? m[1] : null;
            } else if (indent > providerIndent && currentProvider) {
                const baseMatch = /^(baseUrl:\s*)(\S+)/.exec(trimmed);
                if (baseMatch) {
                    const target = httpMap.get(currentProvider) ?? httpsMap.get(currentProvider);
                    if (target) {
                        const leading = rawLine.slice(0, rawLine.length - rawLine.trimStart().length);
                        const commentMatch = /\s+#.*$/.exec(rawLine);
                        const comment = commentMatch ? commentMatch[0] : "";
                        lines[i] = `${leading}baseUrl: ${target}${comment}`;
                    }
                }
            }
        }
        writeOverlayFileAtomic(overlay, "models.yml", lines.join("\n"));
    }
    writeOmpCompactionDisabledConfig(ompHome, overlay);
    return overlay;
}

/**
 * hermes counterpart of prepareOmpHttpRewrite: a persistent `<hermesHome>-bili`
 * overlay (every ~/.hermes sibling symlinked so skills/memories/sessions stay
 * shared) holding a rewritten copy of config.yaml. Every provider endpoint
 * line (api: / base_url: / url:) is rewrapped as origin + "/bili/" + raw
 * upstream — http AND https alike, since hermes's httpx stack can't consume
 * the MITM CA without extra trust config. The real ~/.hermes is never
 * touched. Returns the overlay dir (undefined when nothing is rewritable).
 */
export function prepareHermesHome(
    hermesHome: string,
    origin: string,
    rewrites: HttpRewrite[],
): string | undefined {
    if (rewrites.length === 0) return undefined;
    const cfgPath = path.join(hermesHome, "config.yaml");
    let txt: string;
    try {
        txt = fs.readFileSync(cfgPath, "utf8");
    } catch {
        return undefined;
    }
    const wrapSet = new Set(rewrites.map((r) => r.realUpstream));
    const eol = txt.includes("\r\n") ? "\r\n" : "\n";
    const lines = txt.split(/\r?\n/);
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const m = /^(\s*(?:api|base_url|url):\s*)(\S+)(\s+#.*)?$/.exec(rawLine);
        if (!m) continue;
        const rawUrl = m[2].replace(/^["']|["']$/g, "");
        if (!/^https?:\/\//i.test(rawUrl)) continue;
        const real = unwrapUpstream(rawUrl);
        if (!wrapSet.has(real)) continue;
        lines[i] = `${m[1]}${wrapUpstream(origin, real)}${m[3] ?? ""}`;
        changed = true;
    }
    if (!changed) return undefined;
    const overlay = `${hermesHome}-bili`;
    if (!refreshOverlayHome(hermesHome, overlay, "config.yaml")) return undefined;
    writeOverlayFileAtomic(overlay, "config.yaml", lines.join(eol));
    return overlay;
}

/** Write the hermes session-identity plugin into the bili overlay home.
 *  Hermes sends NO conversation identity on the wire by default: its native
 *  `prompt_cache_key` support (transports/chat_completions.py) is gated on
 *  `supports_prompt_cache_key`, which no bundled provider profile enables —
 *  so every custom-provider request reaches the proxy anonymous and gets a
 *  400 (#286). User plugins under $HERMES_HOME/plugins/model-providers/<name>/
 *  override bundled profiles (discovery order bundled → user, last-writer-
 *  wins), and the profile hook `build_api_kwargs_extras(session_id=...)`
 *  receives the REAL hermes session id — its top_level return value is
 *  merged straight into the request body. The generated plugin subclasses
 *  the bundled "custom" profile and stamps prompt_cache_key = session_id,
 *  giving the proxy the same stable per-conversation id omp/pi provide.
 *  Registered names: "custom" (model.base_url / provider: custom) plus
 *  "custom:<name>" for every provider key bili rewrites (named providers
 *  resolve to that shape — agent_init only maps "custom"/"custom:<key>"
 *  to custom endpoints, and a bare "custom:<key>" lookup otherwise misses
 *  the profile registry and falls to the legacy no-pck path).
 *  Skipped (returns false) when the REAL ~/.hermes already has a plugins/
 *  dir — refreshOverlayHome symlinks it into the overlay, and writing
 *  through the symlink would mutate the user's real home. The proxy then
 *  400s anonymous requests with the fix-it message. */
export function writeHermesIdentityPlugin(hermesHome: string, overlay: string, rewrites: HttpRewrite[]): boolean {
    try {
        if (fs.existsSync(path.join(hermesHome, "plugins"))) return false;
    } catch {
        return false;
    }
    const dir = path.join("plugins", "model-providers", "bili-session-identity");
    try {
        fs.mkdirSync(path.join(overlay, dir), { recursive: true });
    } catch {
        return false;
    }
    const keys = rewrites.map((r) => r.key);
    const pluginDir = path.join(overlay, dir);
    try {
        fs.writeFileSync(path.join(pluginDir, "__init__.py"), hermesIdentityPluginSource(keys));
        fs.writeFileSync(path.join(pluginDir, "plugin.yaml"), [
        "name: bili-session-identity",
        "kind: model-provider",
        "version: 1.0.0",
        "description: billion-context session identity (installed by `bili hermes` — safe to delete)",
        "author: billion-context",
        "",
    ].join("\n"));
    } catch {
        return false;
    }
    try {
        return fs.existsSync(path.join(overlay, dir, "__init__.py"));
    } catch {
        return false;
    }
}

function hermesIdentityPluginSource(providerKeys: string[]): string {
    return [
        '"""Installed by `bili hermes` (billion-context) — safe to delete.',
        "",
        "Re-registers hermes's `custom` provider profile (plus a `custom:<name>`",
        "profile for every provider the proxy fronts) with one addition: the",
        "REAL hermes session id is sent as `prompt_cache_key` on every request,",
        "which the billion-context proxy uses as the stable conversation",
        'identity for its compression sessions. Removing this file restores',
        'stock behavior (no prompt_cache_key)."""',
        "from providers import get_provider_profile, register_provider",
        "from providers.base import ProviderProfile",
        "",
        `_PROVIDER_KEYS = ${JSON.stringify(providerKeys)}`,
        "",
        '_custom = get_provider_profile("custom")',
        "_BASE = type(_custom) if _custom is not None else ProviderProfile",
        "",
        "",
        "class _BiliSessionIdentity(_BASE):",
        "    def build_api_kwargs_extras(self, *, session_id=None, **ctx):",
        "        extra_body, top_level = _BASE.build_api_kwargs_extras(",
        "            self, session_id=session_id, **ctx",
        "        )",
        '        sid = str(session_id or "").strip()',
        "        if sid:",
        '            top_level.setdefault("prompt_cache_key", sid[:64])',
        "        return extra_body, top_level",
        "",
        "",
        "def _register(name, template, with_aliases):",
        "    fields = {}",
        "    if template is not None:",
        "        # Aliases are copied ONLY for the canonical custom",
        "        # re-registration: copying them onto custom:<name> entries",
        "        # would steal the aliases (register_provider re-points each",
        "        # alias at the registering name).",
        '        for attr in ((\"aliases\",) if with_aliases else ()) + (\"env_vars\", \"base_url\", \"default_max_tokens\"):',
        "            value = getattr(template, attr, None)",
        "            if value:",
        "                fields[attr] = value",
        "    register_provider(_BiliSessionIdentity(name=name, **fields))",
        "",
        "",
        "if _custom is not None:",
        '    _register("custom", _custom, True)',
        "for _key in _PROVIDER_KEYS:",
        '    _register("custom:" + _key, _custom, False)',
        "",
    ].join("\n");
}

/** dsh counterpart of prepareHermesHome: a persistent `<dshHome>-bili` overlay
 *  (every ~/.dsh sibling symlinked so credentials/profiles/sessions stay
 *  shared) holding a rewritten copy of settings.yaml. Every baseURL/baseUrl/
 *  base_url value is rewrapped as origin + "/bili/" + raw upstream — http AND
 *  https alike, since dsh's fetch stack exposes no proxy/CA trust knobs. The
 *  real ~/.dsh is never touched. Returns the overlay dir (undefined when the
 *  settings file is unreadable or nothing is rewritable). */
export function prepareDshHome(
    dshHome: string,
    origin: string,
    rewrites: HttpRewrite[],
): string | undefined {
    const cfgPath = path.join(dshHome, "settings.yaml");
    let txt: string;
    try {
        txt = fs.readFileSync(cfgPath, "utf8");
    } catch {
        return undefined;
    }
    const wrapSet = new Set(rewrites.map((r) => r.realUpstream));
    const eol = txt.includes("\r\n") ? "\r\n" : "\n";
    const lines = txt.split(/\r?\n/);
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
        const m = /^(\s*(?:baseURL|baseUrl|base_url):\s*)(\S+)(\s+#.*)?$/.exec(lines[i]);
        if (!m) continue;
        const rawUrl = m[2].replace(/^["']|["']$/g, "");
        if (!/^https?:\/\//i.test(rawUrl)) continue;
        const real = unwrapUpstream(rawUrl);
        if (!wrapSet.has(real)) continue;
        lines[i] = `${m[1]}${wrapUpstream(origin, real)}${m[3] ?? ""}`;
        changed = true;
    }
    if (!changed) return undefined;
    const overlay = `${dshHome}-bili`;
    if (!refreshOverlayHome(dshHome, overlay, "settings.yaml")) return undefined;
    writeOverlayFileAtomic(overlay, "settings.yaml", lines.join(eol));
    return overlay;
}

/** Write the `--patch` overlay file that inserts the bili /acp command
 *  plugin into whatever profile dsh boots. Lives in the persistent
 *  `<dshHome>-bili` dir, INDEPENDENT of the settings.yaml rewrite — the
 *  /acp command is injected even when the user has no custom providers
 *  (pure built-in deepseek route). Returns the patch file path (undefined
 *  when it could not be written — dsh then just boots without /acp). */
export function writeDshAcpPatch(dshHome: string): string | undefined {
    const pluginUrl = pathToFileURL(selfDistFile("agent/dsh-acp.js")).href;
    const dir = `${dshHome}-bili`;
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {
        return undefined;
    }
    writeOverlayFileAtomic(dir, ".bili-acp.patch.yml", `- insert:\n    - name: ${pluginUrl}\n`);
    const file = path.join(dir, ".bili-acp.patch.yml");
    try {
        return fs.existsSync(file) ? file : undefined;
    } catch {
        return undefined;
    }
}

/** Splice a `--patch <file>` flag into dsh's own flag namespace. dsh parses
 *  parent flags only before the first positional; the `web`/`plugin`
 *  subcommands reject parent flags, but `web` accepts its own --patch, and
 *  `plugin` (pnpm forwarding) plus `--dump-default-config` take none at all. */
export function dshArgsWithPatch(args: readonly string[], patchFile: string): string[] {
    if (args[0] === "plugin") return [...args];
    if (args[0] === "web") return ["web", "--patch", patchFile, ...args.slice(1)];
    if (args.includes("--dump-default-config")) return [...args];
    return ["--patch", patchFile, ...args];
}

/**
 * opencode counterpart of preparePiHttpRewrite: write a full copy of the user's
 * opencode.json with the discovered providers' baseURL rewritten (HTTP →
 * /bili/ wrap, wrapped-HTTPS → raw https for cert MITM) into a temp dir, and
 * point OPENCODE_CONFIG at it. The real opencode.json is never touched.
 * Returns the temp config FILE path (undefined when there is nothing to do or
 * the config can't be parsed).
 */
export function prepareOpencodeHttpRewrite(
    configFile: string,
    origin: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    pluginPath?: string,
): string | undefined {
    if (httpRewrites.length === 0 && httpsRewrites.length === 0 && !pluginPath) return undefined;
    let root: Record<string, unknown> = {};
    try {
        const txt = fs.readFileSync(configFile, "utf8");
        const parsed = JSON.parse(txt);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            root = { ...(parsed as Record<string, unknown>) };
        }
    } catch {
        // missing or invalid config — still emit a temp config so the plugin rides along
    }
    const provRoot = root.provider;
    if (provRoot && typeof provRoot === "object" && !Array.isArray(provRoot)) {
        const providers = provRoot as Record<string, unknown>;
        const rewrite = (rewrites: HttpRewrite[], wrap: boolean): void => {
            for (const r of rewrites) {
                const prov = providers[r.key];
                if (!prov || typeof prov !== "object" || Array.isArray(prov)) continue;
                const p = prov as { options?: { baseURL?: unknown } };
                if (!p.options || typeof p.options !== "object") continue;
                const existing = typeof p.options.baseURL === "string" ? p.options.baseURL : r.realUpstream;
                p.options.baseURL = wrap ? wrapUpstream(origin, unwrapUpstream(existing)) : r.realUpstream;
            }
        };
        rewrite(httpRewrites, true);
        rewrite(httpsRewrites, false);
    }
    if (pluginPath) {
        const plugins = Array.isArray(root.plugin) ? root.plugin.filter((p): p is string => typeof p === "string") : [];
        if (!plugins.includes(pluginPath)) plugins.push(pluginPath);
        root.plugin = plugins;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-opencode-"));
    const tmpFile = path.join(tmp, "opencode.json");
    fs.writeFileSync(tmpFile, JSON.stringify(root));
    return tmpFile;
}

function dedupeInOrder(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const d of list) {
        if (d && !seen.has(d)) {
            seen.add(d);
            out.push(d);
        }
    }
    return out;
}

async function defaultFetch(url: string): Promise<{ ok: boolean }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctrl.signal });
        return { ok: res.ok };
    } catch {
        return { ok: false };
    } finally {
        clearTimeout(t);
    }
}

async function probeHealth(
    origin: string,
    fetchImpl: (url: string) => Promise<{ ok: boolean }>,
): Promise<boolean> {
    try {
        const { ok } = await fetchImpl(healthUrl(origin));
        return ok;
    } catch {
        return false;
    }
}

interface HealthInfo {
    ok: boolean;
    instanceId?: string;
}

async function fetchHealthInfoDefault(origin: string): Promise<HealthInfo | undefined> {
    try {
        const res = await fetch(healthUrl(origin), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return undefined;
        const data = (await res.json()) as { ok?: boolean; instanceId?: string };
        return { ok: Boolean(data.ok), instanceId: typeof data.instanceId === "string" ? data.instanceId : undefined };
    } catch {
        return undefined;
    }
}

function instanceCompatible(inst: ProxyInstanceFile, opts: LaunchOptions): boolean {
    if (inst.host !== opts.host || inst.passthrough !== opts.passthrough) return false;
    const wantDomains = opts.mitmDomains ?? [];
    if (inst.mitmDomains.length !== wantDomains.length || inst.mitmDomains.some((d, i) => d !== wantDomains[i])) return false;
    const wantWindows = opts.modelWindows ?? {};
    const keys = Object.keys(wantWindows);
    if (Object.keys(inst.modelWindows).length !== keys.length) return false;
    return keys.every((k) => inst.modelWindows[k] === wantWindows[k]);
}

async function probeExistingInstance(
    readInstance: () => ProxyInstanceFile | { origin: string } | undefined,
    fetchHealthInfo: (origin: string) => Promise<HealthInfo | undefined>,
): Promise<ProxyInstanceFile | undefined> {
    const inst = readInstance();
    if (!isProxyInstanceFile(inst)) return undefined;
    if (!isPidAlive(inst.pid)) return undefined;
    const health = await fetchHealthInfo(inst.origin);
    if (!health || !health.ok) return undefined;
    if (health.instanceId !== undefined && health.instanceId !== inst.instanceId) return undefined;
    return inst;
}

export function findFreePort(preferred: number, host = LAUNCHER_DEFAULT_HOST): Promise<number> {
    const tryBind = (port: number): Promise<boolean> =>
        new Promise((resolve) => {
            const srv = net.createServer();
            srv.once("error", () => resolve(false));
            srv.once("listening", () => srv.close(() => resolve(true)));
            srv.listen(port, host);
        });
    return tryBind(preferred).then((free) => {
        if (free) return preferred;
        return new Promise<number>((resolve, reject) => {
            const srv = net.createServer();
            srv.once("error", reject);
            srv.listen(0, host, () => {
                const addr = srv.address();
                srv.close(() => {
                    if (addr && typeof addr === "object") resolve(addr.port);
                    else reject(new Error("could not allocate a free port"));
                });
            });
        });
    });
}

const INHERITED_PROXY_VARS = ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

export function stripInheritedProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const cleaned: NodeJS.ProcessEnv = { ...env };
    for (const key of INHERITED_PROXY_VARS) delete cleaned[key];
    return cleaned;
}

function proxyStartArgs(opts: LaunchOptions): string[] {
    const args = ["start", "--host", opts.host, "--port", String(opts.port)];
    if (opts.passthrough) args.push("--passthrough");
    if (opts.debug) args.push("--debug");
    return args;
}

export async function ensureProxyRunning(
    opts: LaunchOptions,
    deps: LauncherDeps = {},
): Promise<ProxyHandle> {
    const fetchImpl = deps.fetchImpl ?? defaultFetch;
    const fetchHealthInfo = deps.fetchHealthInfo ?? fetchHealthInfoDefault;
    const readInstance = deps.readInstanceFile ?? readProxyInstanceFile;
    const spawnImpl = deps.spawnImpl ?? (spawn as SpawnFn);
    const now = deps.now ?? Date.now;
    const sleepImpl = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    // #394/#417: a healthy proxy with a compatible config is SHARED, not
    // doubled — two concurrent launches of the same client would otherwise
    // spawn two writers over one sessions dir.
    const existing = await probeExistingInstance(readInstance, fetchHealthInfo);
    if (existing && instanceCompatible(existing, opts)) {
        console.error(`bili: attaching to running proxy at ${existing.origin} (pid ${existing.pid})`);
        return { origin: existing.origin, port: existing.port, attached: true };
    }

    // #407: no probe-release-rebind. The child binds the preferred port
    // itself and retries on EADDRINUSE, reporting the real origin through
    // the instance file via this launchToken.
    const launchToken = randomUUID();
    const port = opts.port;
    const script = process.argv[1];
    if (!script) throw new Error("bili: cannot resolve launcher script path");
    const logPath = path.join(os.tmpdir(), `bili-proxy-${port}.log`);
    const logFd = fs.openSync(logPath, "a");
    let child: SpawnChild;
    try {
        child = spawnImpl(
            process.execPath,
            [script, ...proxyStartArgs(opts)],
            {
                detached: true,
                stdio: ["ignore", logFd, logFd],
                env: {
                    ...stripInheritedProxy(process.env),
                    BILI_LAUNCH_TOKEN: launchToken,
                    BILI_PARENT_PID: String(process.pid),
                    ...(opts.mitmDomains && opts.mitmDomains.length
                        ? { BILI_MITM_DOMAINS: opts.mitmDomains.join(",") }
                        : {}),
                    ...(opts.modelWindows && Object.keys(opts.modelWindows).length > 0
                        ? { BILI_LAUNCHER_MODEL_WINDOWS: JSON.stringify(opts.modelWindows) }
                        : {}),
                },
            },
        );
    } finally {
        try {
            fs.closeSync(logFd);
        } catch {}
    }
    try {
        child.unref?.();
    } catch {}

    const deadline = now() + SPAWN_WAIT_MS;
    while (now() < deadline) {
        await sleepImpl(HEALTH_POLL_INTERVAL_MS);
        const inst = readInstance();
        if (isProxyInstanceFile(inst) && inst.launchToken === launchToken) {
            if (await probeHealth(inst.origin, fetchImpl)) {
                return { origin: inst.origin, port: inst.port, child, logPath };
            }
            continue;
        }
        // Fallback for a child that cannot write the instance file (broken
        // state dir) or an old pre-handshake binary: only trust the preferred
        // origin when NO record vouches for it — a LIVE record's owner owns
        // the discovery surface and our child is retry-binding elsewhere.
        // A stale record (dead pid / legacy plain) cannot vouch for anything.
        const stale = !isProxyInstanceFile(inst) || !isPidAlive(inst.pid);
        if (stale && (await probeHealth(proxyOrigin(opts.host, port), fetchImpl))) {
            return { origin: proxyOrigin(opts.host, port), port, child, logPath };
        }
    }
    throw new Error(`bili: proxy did not become healthy within ${SPAWN_WAIT_MS}ms (log: ${logPath})`);
}

export function stopProxy(handle: ProxyHandle): void {
    if (handle.attached) return;
    const child = handle.child;
    if (!child || child.pid === undefined) return;
    if (process.platform === "win32") {
        // #414: child.kill() on win32 is TerminateProcess — zero flush.
        // Launcher children watch BILI_PARENT_PID and run the graceful path
        // themselves once this process exits (≤2s later).
        return;
    }
    if (child.pid > 0) {
        try {
            process.kill(-child.pid);
        } catch {
            /* process-group kill failed (POSIX-only or already gone) */
        }
    }
    try {
        child.kill?.();
    } catch {}
}

export function runClient(
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    deps?: { spawnImpl?: SpawnFn },
): Promise<number> {
    const spawnImpl = deps?.spawnImpl ?? (spawn as SpawnFn);
    return new Promise((resolve, reject) => {
        const child = spawnImpl(cmd, args, { stdio: "inherit", env, shell: process.platform === "win32" });
        child.on?.("error", (...rest: unknown[]) => reject(rest[0]));
        child.on?.("exit", (...rest: unknown[]) => {
            const code = rest[0];
            const signal = rest[1];
            resolve(signal ? 130 : typeof code === "number" ? code : 0);
        });
    });
}

const PATH_EXTS = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];

export function resolveOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
    const p = env.PATH;
    if (!p) return undefined;
    for (const dir of p.split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of PATH_EXTS) {
            const f = path.join(dir, name + ext);
            try {
                if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
            } catch {}
        }
    }
    return undefined;
}

export function isOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
    return resolveOnPath(name, env) !== undefined;
}

export function resolveClientCommand(
    client: ClientName,
    env: NodeJS.ProcessEnv,
): { command: string; prefixArgs: string[] } {
    const binOverride = env.BILI_CLIENT_BIN?.trim();
    if (binOverride) {
        const resolved = resolveOnPath(binOverride, env);
        return { command: resolved ?? binOverride, prefixArgs: [] };
    }
    if (client === "pi") {
        const piBin = env.PI_BIN?.trim();
        if (piBin) return { command: piBin, prefixArgs: [] };
        const piResolved = resolveOnPath("pi", env);
        if (piResolved) return { command: piResolved, prefixArgs: [] };
        const cli = path.join(
            os.homedir(),
            ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        );
        return { command: process.execPath, prefixArgs: [cli] };
    }
    const resolved = resolveOnPath(client, env);
    return { command: resolved ?? client, prefixArgs: [] };
}

export interface RunLaunchParams {
    client: ClientName;
    clientArgs: string[];
    mitmDomains?: string[];
    overrides: Record<string, string | undefined>;
}

function parsePort(raw: string | undefined): number {
    const port = raw && raw.trim() ? parseInt(raw, 10) : LAUNCHER_DEFAULT_PORT;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
        console.error(`bili: invalid --port "${raw}"`);
        process.exit(2);
    }
    return port;
}

export async function runLaunch(params: RunLaunchParams, deps: LauncherDeps = {}): Promise<void> {
    const host = params.overrides.ACP_HOST?.trim() || LAUNCHER_DEFAULT_HOST;
    const port = parsePort(params.overrides.ACP_PORT ?? process.env.ACP_PORT);
    const passthrough = params.overrides.ACP_PASSTHROUGH === "1";
    const debug = params.overrides.ACP_DEBUG === "1";

    const config = loadClientConfig(process.env, process.cwd());
    const base = baseClientName(params.client);
    const routes = discoverRoutes(base, config);
    // bili's own route graph (same sources the spawned proxy child reads —
    // used to resolve the budget-alignment window, #321).
    const biliRoutes = loadRoutes(process.env);
    const domains = dedupeInOrder([...routes.httpsDomains, ...(params.mitmDomains ?? [])]);
    const handle = await ensureProxyRunning({ host, port, passthrough, debug, mitmDomains: domains, modelWindows: collectModelWindows(config, base) }, deps);
    console.error(
        `bili: started proxy at ${handle.origin} (MITM domains: ${domains.length ? domains.join(", ") : "defaults"})` +
            (routes.httpRewrites.length > 0 ? ` (HTTP /bili/ rewrites: ${routes.httpRewrites.length})` : "") +
            (routes.httpsRewrites.length > 0 ? ` (HTTPS cert rewrites: ${routes.httpsRewrites.length})` : "") +
            (params.client === "pi-test" ? " (no extensions)" : ""),
    );
    if (handle.logPath) {
        console.error(`bili: proxy log: ${handle.logPath}`);
    }

    const ca = resolveCaCertPath(process.env);
    let env: NodeJS.ProcessEnv;
    let clientArgs = params.clientArgs;
    let piOverlayHome: string | undefined;
    let ompOverlayHome: string | undefined;
    let opencodeTmpFile: string | undefined;
    let hermesOverlayHome: string | undefined;
    let dshOverlayHome: string | undefined;
    const tmpFiles: string[] = [];
    const directUrl = launcherDirectUrl(process.env);
    if (directUrl) {
        if (base === "codex") {
            console.error(
                "bili: direct-URL mode — codex's LLM traffic does NOT go through the proxy, so compression is not applied (only the bili MCP tool calls do). For full compression use the default MITM mode (unset BILI_LAUNCHER_DIRECT).",
            );
        } else if (base === "claude") {
            console.error(
                "bili: direct-URL mode — claude's ANTHROPIC_BASE_URL is overridden to the proxy; a pre-configured relay is bypassed unless BILI_CLAUDE_UPSTREAM=<relay> is set. OAuth-subscription traffic requires the default MITM mode.",
            );
        }
    }
    const codexUpstream = base === "codex" ? codexUpstreamUrl(config.codex) : undefined;
    const injectMcp = launcherInjectMcp(process.env, base, codexUpstream);
    if (injectMcp) {
        console.error(`bili: injecting native bili MCP tools for ${base} (disable with BILI_LAUNCHER_PLUGIN=0).`);
    } else if (base === "claude" || base === "codex") {
        if (process.env.BILI_LAUNCHER_PLUGIN === "0") {
            console.error("bili: native MCP tools disabled (BILI_LAUNCHER_PLUGIN=0) — running in pure wire mode.");
        } else {
            console.error(`bili: codex upstream ${codexUpstream} is local/private — self-hosted models cannot see codex namespace MCP tools; using wire-injected flat tools instead (force MCP with BILI_LAUNCHER_PLUGIN=1).`);
        }
    }
    const origin = handle.origin;
    if (base === "pi") {
        env = buildPiEnv(origin, ca, process.env);
        piOverlayHome = preparePiHttpRewrite(resolvePiHome(process.env), origin, routes.httpRewrites, routes.httpsRewrites);
        if (piOverlayHome) env.PI_CODING_AGENT_DIR = piOverlayHome;
        // Native tooling out of the box: when the user has NOT installed the
        // plugin, ride pi's `-e <file>` (loads for this run only, writes
        // nothing) instead of leaving them on wire-mode fallback. When they
        // HAVE installed it, settings.json (merged into the overlay home)
        // already loads it — adding `-e` too would double-register.
        const piExt = selfDistFile("agent/pi.js");
        if (piExt && fs.existsSync(piExt) && !piPluginInstalled(resolvePiHome(process.env))) {
            clientArgs = ["-e", piExt, ...clientArgs];
        }
    } else if (base === "omp") {
        // omp is pi-based: same env as pi (HTTPS_PROXY + CA + BILLION_CONTEXT_PROXY);
        // the /bili/ rewrite rides a persistent overlay PI_CODING_AGENT_DIR
        // (~/.omp/agent-bili; real models.yml untouched, session paths stay resolvable).
        env = buildPiEnv(origin, ca, process.env);
        ompOverlayHome = prepareOmpHttpRewrite(resolveOmpHome(process.env), origin, routes.httpRewrites, routes.httpsRewrites);
        if (ompOverlayHome) env.PI_CODING_AGENT_DIR = ompOverlayHome;
        // Native tooling out of the box (same rationale as pi): omp does NOT
        // ship the bili plugin — when the config carries no loadable entry,
        // ride omp's `-e <file>` (loads for this run only, writes nothing)
        // instead of dropping to wire-mode fallback. A loadable entry (the
        // overlay's generated config.yml preserves the real home's entries)
        // already provides the plugin; adding `-e` too would double-register.
        const ompExt = selfDistFile("agent/omp.js");
        if (ompExt && fs.existsSync(ompExt) && !ompPluginLoadedFrom(resolveOmpHome(process.env))) {
            clientArgs = ["-e", ompExt, ...clientArgs];
        }
    } else if (base === "opencode") {
        // opencode: HTTPS upstreams ride cert-MITM (HTTPS_PROXY + CA); plaintext
        // HTTP upstreams get a /bili/-rewritten copy of opencode.json via
        // OPENCODE_CONFIG (real config untouched). BILLION_CONTEXT_PROXY makes
        // opencode-acp self-disable so the proxy owns the ACP tools.
        env = { ...process.env, HTTPS_PROXY: origin, NODE_EXTRA_CA_CERTS: ca, BILLION_CONTEXT_PROXY: origin };
        const opencodePlugin = selfDistFile("agent/opencode.js");
        const opencodePluginPath = opencodePlugin && fs.existsSync(opencodePlugin) ? opencodePlugin : undefined;
        opencodeTmpFile = prepareOpencodeHttpRewrite(resolveOpencodeConfigFile(process.env), origin, routes.httpRewrites, routes.httpsRewrites, opencodePluginPath);
        if (opencodeTmpFile) env.OPENCODE_CONFIG = opencodeTmpFile;
    } else if (base === "hermes") {
        // hermes: no plugin, no MITM cert trust (httpx builds its own CA
        // bundle) — every upstream rides the /bili/ URL form via a persistent
        // overlay HERMES_HOME (~/.hermes-bili) whose config.yaml is rewritten.
        // skills/memories/sessions stay shared through symlinks; the real
        // ~/.hermes is never touched.
        env = { ...process.env };
        hermesOverlayHome = prepareHermesHome(resolveHermesHome(process.env), origin, routes.httpRewrites);
        if (hermesOverlayHome) {
            env.HERMES_HOME = hermesOverlayHome;
            // Session identity for the proxied custom providers: hermes sends
            // no conversation id on the wire, so the proxy 400s anonymous
            // requests (#286). The plugin stamps the real hermes session id as
            // prompt_cache_key. Skipped (identity stays anonymous) when the
            // real ~/.hermes already has a plugins/ dir — writing through the
            // overlay symlink would mutate the user's home.
            if (!writeHermesIdentityPlugin(resolveHermesHome(process.env), hermesOverlayHome, routes.httpRewrites)) {
                console.error(
                    "bili: ~/.hermes has its own plugins/ — skipping the session-identity plugin; hermes requests will be rejected by the proxy without an identity (see #286).",
                );
            }
        } else {
            console.error(
                routes.httpRewrites.length === 0
                    ? "bili: no hermes providers found in ~/.hermes/config.yaml — traffic will NOT go through the proxy (configure a provider first)."
                    : "bili: hermes config.yaml could not be rewritten (unreadable or no matching provider endpoints) — traffic will NOT go through the proxy.",
            );
        }
    } else if (base === "dsh") {
        // dsh (deepseek-harness): no plugin surface, no MITM cert trust (plain
        // fetch) — the built-in deepseek-official route is captured through
        // $DEEPSEEK_BASE_URL (its resolution order is settings baseURL ?? env
        // ?? https://api.deepseek.com, so a rewritten user setting wins and
        // this env is the no-settings fallback). Custom providers in
        // ~/.dsh/settings.yaml ride a persistent overlay DSH_HOME
        // (~/.dsh-bili); credentials/profiles/sessions stay shared through
        // symlinks and the real ~/.dsh is never touched.
        env = { ...process.env, BILLION_CONTEXT_PROXY: origin };
        env.DEEPSEEK_BASE_URL = wrapUpstream(origin, "https://api.deepseek.com");
        // Session identity for the proxy: dsh's pi-ai stack keys its
        // `prompt_cache_key` body field (the dsh session id) off
        // cacheRetention — every non-api.openai.com base URL defaults to
        // "short", which sends NO key and leaves the request anonymous (the
        // proxy then 400s, #286). "long" + compat.supportsLongCacheRetention
        // (true for deepseek/custom base URLs) makes every request carry
        // prompt_cache_key = the dsh session uuid. The extra
        // prompt_cache_retention field this also emits is stripped by the
        // proxy before forwarding upstream. A per-provider cacheRetention set
        // in the user's own settings.yaml still wins (explicit profile value
        // overrides the env fallback).
        env.PI_CACHE_RETENTION = "long";
        const dshHomeDir = resolveDshHome(process.env);
        dshOverlayHome = prepareDshHome(dshHomeDir, origin, routes.httpRewrites);
        if (dshOverlayHome) {
            env.DSH_HOME = dshOverlayHome;
        } else if (routes.httpRewrites.length > 0) {
            console.error(
                "bili: dsh settings.yaml could not be rewritten (unreadable or no matching endpoints) — custom providers will NOT go through the proxy; the built-in deepseek route still does.",
            );
        } else {
            console.error(
                "bili: no custom providers found in ~/.dsh/settings.yaml — proxying the built-in deepseek route via DEEPSEEK_BASE_URL only.",
            );
        }
        // Native /acp command rides a --patch overlay (independent of the
        // settings rewrite above), so it exists on every profile dsh boots.
        const dshAcpPatch = writeDshAcpPatch(dshHomeDir);
        if (dshAcpPatch) clientArgs = dshArgsWithPatch(clientArgs, dshAcpPatch);
    } else if (base === "codex") {
        // Per-spawn conversation id for the MCP shell's headless
        // self-registration (codex provides no session id of its own).
        const codexConversationId = injectMcp ? randomUUID() : undefined;
        if (directUrl) {
            env = { ...process.env, BILLION_CONTEXT_PROXY: origin };
            if (codexConversationId) clientArgs = [...buildCodexMcpArgs(origin, codexConversationId), ...clientArgs];
        } else {
            env = buildCodexEnv(origin, resolveCombinedCaPath(process.env), process.env);
            clientArgs = buildCodexArgs(origin, routes.httpRewrites, routes.httpsRewrites, clientArgs);
            const budgetArgs = await resolveCodexBudgetArgs({
                model: config.codex?.model,
                clientWindow: config.codex?.contextWindow,
                clientAutoCompactLimit: config.codex?.autoCompactLimit,
                routes: biliRoutes,
                upstreamUrl: codexUpstreamUrl(config.codex),
            });
            if (budgetArgs.length > 0) {
                clientArgs = [...budgetArgs, ...clientArgs];
                console.error(`bili: codex budget aligned — ${budgetArgs.slice(2).join(", ")} (model: ${config.codex?.model})`);
            }
            if (injectMcp && codexConversationId) clientArgs = [...buildCodexMcpArgs(origin, codexConversationId), ...clientArgs];
        }
    } else {
        env = directUrl
            ? buildClaudePluginEnv(origin, true, process.env)
            : buildClaudeEnv(origin, ca, routes.httpRewrites, routes.httpsRewrites, process.env);
        if (directUrl) env.BILLION_CONTEXT_PROXY = origin;
        const claudeBudget = await resolveClaudeBudgetEnv({
            model: nonEmpty(process.env.ANTHROPIC_MODEL) ? process.env.ANTHROPIC_MODEL : config.claude?.model,
            userAutoCompactWindow: config.claude?.autoCompactWindow,
            shellAutoCompactWindow: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
            routes: biliRoutes,
            upstreamUrl: config.claude?.anthropicBaseUrl ?? "https://api.anthropic.com",
        });
        Object.assign(env, claudeBudget);
        if (claudeBudget.CLAUDE_CODE_AUTO_COMPACT_WINDOW !== undefined) {
            console.error(`bili: claude budget aligned — CLAUDE_CODE_AUTO_COMPACT_WINDOW=${claudeBudget.CLAUDE_CODE_AUTO_COMPACT_WINDOW}`);
        }
        if (injectMcp) {
            const mcpFile = path.join(os.tmpdir(), `bili-mcp-${Date.now()}.json`);
            fs.writeFileSync(mcpFile, JSON.stringify(buildMcpConfig(origin)));
            tmpFiles.push(mcpFile);
            clientArgs = ["--mcp-config", mcpFile, ...clientArgs];
        }
    }

    const { command, prefixArgs } = resolveClientCommand(base, process.env);
    const effectiveClientArgs = piTestArgs(params.client, clientArgs);
    let code = 0;
    try {
        code = await runClient(command, [...prefixArgs, ...effectiveClientArgs], env, {
            spawnImpl: deps.spawnImpl,
        });
    } catch (err) {
        console.error(`bili: failed to launch ${params.client}: ${err instanceof Error ? err.message : String(err)}`);
        code = 1;
    } finally {
        stopProxy(handle);
        if (opencodeTmpFile) {
            try {
                fs.rmSync(path.dirname(opencodeTmpFile), { recursive: true, force: true });
            } catch {}
        }
        for (const f of tmpFiles) {
            try {
                fs.rmSync(f, { force: true });
            } catch {}
        }
    }
    process.exit(code ?? 0);
}

export interface RunTestPiParams {
    overrides: Record<string, string | undefined>;
    mitmDomains?: string[];
}

export async function runTestPi(params: RunTestPiParams, deps: LauncherDeps = {}): Promise<number> {
    const host = params.overrides.ACP_HOST?.trim() || LAUNCHER_DEFAULT_HOST;
    const port = parsePort(params.overrides.ACP_PORT ?? process.env.ACP_PORT);
    const passthrough = params.overrides.ACP_PASSTHROUGH === "1";
    const debug = params.overrides.ACP_DEBUG === "1";

    const config = loadClientConfig(process.env, process.cwd());
    const domains = dedupeInOrder([
        ...discoverDomains("pi", config),
        ...(params.mitmDomains ?? []),
    ]);
    const handle = await ensureProxyRunning({ host, port, passthrough, debug, mitmDomains: domains, modelWindows: collectModelWindows(config, "pi") }, deps);
    console.error(
        `bili: started proxy at ${handle.origin} (MITM domains: ${domains.length ? domains.join(", ") : "defaults"})`,
    );
    if (handle.logPath) {
        console.error(`bili: proxy log: ${handle.logPath}`);
    }

    const ca = resolveCaCertPath(process.env);
    const env = buildPiEnv(handle.origin, ca, process.env);
    const sessionDir = path.join(os.tmpdir(), `bili-pi-test-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    const args = [
        "-p",
        "--no-session",
        "--no-extensions",
        "--no-tools",
        "--no-context-files",
        "--session-dir",
        sessionDir,
        "--mode",
        "text",
        "Reply with exactly: OK",
    ];

    const { command, prefixArgs } = resolveClientCommand("pi", process.env);
    let code = 0;
    try {
        code = await runClient(command, [...prefixArgs, ...args], env, { spawnImpl: deps.spawnImpl });
    } catch (err) {
        console.error(`bili: pi test failed: ${err instanceof Error ? err.message : String(err)}`);
        code = 1;
    } finally {
        stopProxy(handle);
    }
    process.exit(code ?? 0);
}
