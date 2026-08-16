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
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type StdioOptions } from "node:child_process";
import { DEFAULT_MITM_DOMAINS } from "./mitm.js";
import { nonEmpty, resolvePiHome, loadClientConfig, type ClientConfig } from "./client-config.js";

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
} from "./client-config.js";

export const LAUNCHER_DEFAULT_HOST = "127.0.0.1";
export const LAUNCHER_DEFAULT_PORT = 8787;
export const LAUNCH_CLIENTS = ["pi", "codex", "claude", "pi-test"] as const;
export type ClientName = (typeof LAUNCH_CLIENTS)[number];
export type BaseClientName = "claude" | "codex" | "pi";

const HEALTH_PATH = "/__bili/health";
const HEALTH_POLL_INTERVAL_MS = 200;
const SPAWN_WAIT_MS = 20000;
const PROBE_TIMEOUT_MS = 1500;

const DEFAULT_MITM_DOMAIN_SET = new Set(DEFAULT_MITM_DOMAINS.map((d) => d.toLowerCase()));
function coveredByDefaultMitm(host: string): boolean {
    const h = host.toLowerCase();
    return DEFAULT_MITM_DOMAINS.some((d) => h === d || h.endsWith("." + d));
}
function domainsNeedFreshProxy(domains: string[] | undefined): boolean {
    if (!domains || domains.length === 0) return false;
    return domains.some((d) => !coveredByDefaultMitm(d));
}

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
}

export interface ProxyHandle {
    origin: string;
    port: number;
    reused: boolean;
    child: SpawnChild | null;
    logPath?: string;
}

export interface LauncherDeps {
    fetchImpl?: (url: string) => Promise<{ ok: boolean }>;
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
        const u = config.claude?.anthropicBaseUrl;
        if (nonEmpty(u)) classify(u, "ANTHROPIC_BASE_URL");
        else classify("https://api.anthropic.com", "ANTHROPIC_BASE_URL");
    } else if (client === "pi") {
        for (const [name, prov] of Object.entries(config.pi?.providers ?? {})) {
            classify(prov.baseUrl, name);
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
 *  MITM/CA). Default ON for claude/codex; set BILI_LAUNCHER_MITM=1 to keep
 *  the old transparent-proxy route (needed for OAuth-subscription traffic). */
export function launcherDirectUrl(env: NodeJS.ProcessEnv): boolean {
    return env.BILI_LAUNCHER_MITM !== "1";
}

/** Ephemeral MCP config for --mcp-config / -c mcp_servers.bili.*: a single
 *  "bili" stdio server running dist/mcp.js. Args are kept flat so codex's
 *  TOML value parser stays happy. */
export function buildMcpConfig(origin: string): { mcpServers: { bili: { command: string; args: string[]; env: Record<string, string> } } } {
    const script = process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "mcp.js") : "bili-mcp";
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

/** Codex: -c inline overrides for the bili MCP server only. */
export function buildCodexMcpArgs(origin: string): string[] {
    const script = process.argv[1] ? path.resolve(path.dirname(process.argv[1]), "mcp.js") : "bili-mcp";
    return [
        "-c",
        `mcp_servers.bili.command=${JSON.stringify(process.execPath)}`,
        "-c",
        `mcp_servers.bili.args=${JSON.stringify([script])}`,
        "-c",
        `mcp_servers.bili.env.BILI_MCP_PROXY=${JSON.stringify(origin)}`,
    ];
}

export function preparePiHttpRewrite(
    piHome: string,
    origin: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
): string | undefined {
    if (httpRewrites.length === 0 && httpsRewrites.length === 0) return undefined;
    const modelsPath = path.join(piHome, "models.json");
    let txt: string;
    try {
        txt = fs.readFileSync(modelsPath, "utf8");
    } catch {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(txt);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const root = parsed as Record<string, unknown>;
    const providersVal = root.providers;
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-"));
    try {
        for (const entry of fs.readdirSync(piHome)) {
            if (entry === "models.json") continue;
            try {
                fs.symlinkSync(path.join(piHome, entry), path.join(tmp, entry));
            } catch {}
        }
    } catch {}
    fs.writeFileSync(path.join(tmp, "models.json"), JSON.stringify(root));
    return tmp;
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
    const spawnImpl = deps.spawnImpl ?? (spawn as SpawnFn);
    const now = deps.now ?? Date.now;
    const sleepImpl = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const preferredOrigin = proxyOrigin(opts.host, opts.port);
    if (!domainsNeedFreshProxy(opts.mitmDomains) && (await probeHealth(preferredOrigin, fetchImpl))) {
        return { origin: preferredOrigin, port: opts.port, reused: true, child: null };
    }

    const port = await findFreePort(opts.port, opts.host);
    const spawnedOrigin = proxyOrigin(opts.host, port);

    const script = process.argv[1];
    if (!script) throw new Error("bili: cannot resolve launcher script path");
    const logPath = path.join(os.tmpdir(), `bili-proxy-${port}.log`);
    const logFd = fs.openSync(logPath, "a");
    let child: SpawnChild;
    try {
        child = spawnImpl(
            process.execPath,
            [script, ...proxyStartArgs({ ...opts, port, debug: true })],
            {
                detached: true,
                stdio: ["ignore", logFd, logFd],
                env: {
                    ...stripInheritedProxy(process.env),
                    ...(opts.mitmDomains && opts.mitmDomains.length
                        ? { BILI_MITM_DOMAINS: opts.mitmDomains.join(",") }
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
        if (await probeHealth(spawnedOrigin, fetchImpl)) {
            return { origin: spawnedOrigin, port, reused: false, child, logPath };
        }
    }
    throw new Error(`bili: proxy did not become healthy at ${spawnedOrigin} within ${SPAWN_WAIT_MS}ms`);
}

export function stopProxy(handle: ProxyHandle): void {
    const child = handle.child;
    if (!child || child.pid === undefined) return;
    if (process.platform !== "win32" && child.pid > 0) {
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
    const domains = dedupeInOrder([...routes.httpsDomains, ...(params.mitmDomains ?? [])]);
    const handle = await ensureProxyRunning({ host, port, passthrough, debug, mitmDomains: domains }, deps);
    console.error(
        `bili: ${handle.reused ? "reusing existing" : "started"} proxy at ${handle.origin} (MITM domains: ${domains.length ? domains.join(", ") : "defaults"})` +
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
    let piTmpHome: string | undefined;
    const tmpFiles: string[] = [];
    const directUrl = launcherDirectUrl(process.env);
    const injectMcp = base !== "pi" && process.env.BILI_LAUNCHER_PLUGIN !== "0";
    const origin = handle.origin;
    if (base === "pi") {
        env = buildPiEnv(origin, ca, process.env);
        piTmpHome = preparePiHttpRewrite(resolvePiHome(process.env), origin, routes.httpRewrites, routes.httpsRewrites);
        if (piTmpHome) env.PI_CODING_AGENT_DIR = piTmpHome;
    } else if (base === "codex") {
        if (directUrl) {
            env = { ...process.env, BILLION_CONTEXT_PROXY: origin };
            clientArgs = [...buildCodexMcpArgs(origin), ...clientArgs];
        } else {
            env = buildCodexEnv(origin, resolveCombinedCaPath(process.env), process.env);
            clientArgs = buildCodexArgs(origin, routes.httpRewrites, routes.httpsRewrites, clientArgs);
            if (injectMcp) clientArgs = [...buildCodexMcpArgs(origin), ...clientArgs];
        }
    } else {
        env = directUrl
            ? buildClaudePluginEnv(origin, true, process.env)
            : buildClaudeEnv(origin, ca, routes.httpRewrites, routes.httpsRewrites, process.env);
        if (directUrl) env.BILLION_CONTEXT_PROXY = origin;
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
        if (!handle.reused) stopProxy(handle);
        if (piTmpHome) {
            try {
                fs.rmSync(piTmpHome, { recursive: true, force: true });
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
    const handle = await ensureProxyRunning({ host, port, passthrough, debug, mitmDomains: domains }, deps);
    console.error(
        `bili: ${handle.reused ? "reusing existing" : "started"} proxy at ${handle.origin} (MITM domains: ${domains.length ? domains.join(", ") : "defaults"})`,
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
        if (!handle.reused) stopProxy(handle);
    }
    process.exit(code ?? 0);
}
