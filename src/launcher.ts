/**
 * `bili <client>` launcher — brings up the proxy on an independent port and
 * points a coding agent at it via HTTPS_PROXY + the proxy's MITM CA, without
 * editing the client's config files.
 *
 *   bili pi     [-- client args...]   HTTPS_PROXY + NODE_EXTRA_CA_CERTS
 *   bili codex  [-- client args...]   HTTPS_PROXY + SSL_CERT_FILE
 *   bili claude [-- client args...]   HTTPS_PROXY + NODE_EXTRA_CA_CERTS
 *   bili test pi                      non-polluting pi smoke test
 *
 * The real upstream HTTPS hosts are DISCOVERED by reading (never editing) the
 * client's own config: pi's ~/.pi/agent/models.json providers, Codex's
 * ~/.codex/config.toml, Claude's hardcoded api.anthropic.com. Every HTTPS host
 * found is whitelisted for MITM, so the proxy TLS-terminates exactly the hosts
 * the client actually uses and blind-tunnels the rest. HTTP / localhost
 * providers go direct (no MITM). Compression rides the existing MITM pipeline.
 *
 * Lifecycle: a proxy already listening on the requested port is REUSED
 * (not owned). Otherwise a detached proxy child is spawned on that port (or a
 * free one) and OWNED — it is killed when the client exits.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_MITM_DOMAINS } from "./mitm.js";

export const LAUNCHER_DEFAULT_HOST = "127.0.0.1";
export const LAUNCHER_DEFAULT_PORT = 8787;
export const LAUNCH_CLIENTS = ["pi", "codex", "claude"] as const;
export type ClientName = (typeof LAUNCH_CLIENTS)[number];

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
    options: { detached?: boolean; stdio?: "ignore" | "inherit"; env?: NodeJS.ProcessEnv },
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

export interface ClientConfig {
    claude?: ClaudeSettings;
    codex?: CodexConfig;
    pi?: PiConfig;
}

function nonEmpty(s: unknown): s is string {
    return typeof s === "string" && s.trim().length > 0;
}

export function resolveCaCertPath(env: NodeJS.ProcessEnv): string {
    const base = env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
    return path.join(base, "billion-context", "ca", "root-ca.pem");
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

export function discoverDomains(client: ClientName, config: ClientConfig): string[] {
    if (client === "claude") return ["api.anthropic.com"];
    if (client === "pi") {
        const urls: string[] = [];
        for (const prov of Object.values(config.pi?.providers ?? {})) {
            if (nonEmpty(prov.baseUrl)) urls.push(prov.baseUrl);
        }
        return extractDomains(urls);
    }
    const urls: string[] = [];
    for (const prov of Object.values(config.codex?.providers ?? {})) {
        if (nonEmpty(prov.baseUrl)) urls.push(prov.baseUrl);
    }
    if (nonEmpty(config.codex?.openaiBaseUrl)) urls.push(config.codex!.openaiBaseUrl!);
    return extractDomains(urls);
}

export function buildPiEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv, HTTPS_PROXY: origin, NODE_EXTRA_CA_CERTS: caPath };
}

export function buildCodexEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv, HTTPS_PROXY: origin, SSL_CERT_FILE: caPath };
}

export function buildClaudeEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv, HTTPS_PROXY: origin, NODE_EXTRA_CA_CERTS: caPath };
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
    const child = spawnImpl(process.execPath, [script, ...proxyStartArgs({ ...opts, port })], {
        detached: true,
        stdio: "ignore",
        env: {
            ...process.env,
            ...(opts.mitmDomains && opts.mitmDomains.length
                ? { BILI_MITM_DOMAINS: opts.mitmDomains.join(",") }
                : {}),
        },
    });
    try {
        child.unref?.();
    } catch {}

    const deadline = now() + SPAWN_WAIT_MS;
    while (now() < deadline) {
        await sleepImpl(HEALTH_POLL_INTERVAL_MS);
        if (await probeHealth(spawnedOrigin, fetchImpl)) {
            return { origin: spawnedOrigin, port, reused: false, child };
        }
    }
    throw new Error(`bili: proxy did not become healthy at ${spawnedOrigin} within ${SPAWN_WAIT_MS}ms`);
}

export function stopProxy(handle: ProxyHandle): void {
    const child = handle.child;
    if (!child || child.pid === undefined) return;
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
        const child = spawnImpl(cmd, args, { stdio: "inherit", env });
        child.on?.("error", (...rest: unknown[]) => reject(rest[0]));
        child.on?.("exit", (...rest: unknown[]) => {
            const code = rest[0];
            const signal = rest[1];
            resolve(signal ? 130 : typeof code === "number" ? code : 0);
        });
    });
}

export function isOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
    const p = env.PATH;
    if (!p) return false;
    return p.split(":").some((dir) => {
        if (!dir) return false;
        try {
            const f = path.join(dir, name);
            return fs.existsSync(f) && fs.statSync(f).isFile();
        } catch {
            return false;
        }
    });
}

export function resolveClientCommand(
    client: ClientName,
    env: NodeJS.ProcessEnv,
): { command: string; prefixArgs: string[] } {
    if (client === "pi") {
        const piBin = env.PI_BIN?.trim();
        if (piBin) return { command: piBin, prefixArgs: [] };
        if (isOnPath("pi", env)) return { command: "pi", prefixArgs: [] };
        const cli = path.join(
            os.homedir(),
            ".pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        );
        return { command: process.execPath, prefixArgs: [cli] };
    }
    return { command: client, prefixArgs: [] };
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
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

export function loadClientConfig(env: NodeJS.ProcessEnv, cwd: string): ClientConfig {
    const home = os.homedir();
    const config: ClientConfig = {};
    config.claude = readClaudeSettings(home, cwd);
    const codexHome = nonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex");
    config.codex = readCodexConfig(codexHome);
    const piHome = nonEmpty(env.PI_HOME) ? env.PI_HOME : path.join(home, ".pi", "agent");
    config.pi = readPiConfig(piHome);
    return config;
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
    const domains = dedupeInOrder([
        ...discoverDomains(params.client, config),
        ...(params.mitmDomains ?? []),
    ]);
    const handle = await ensureProxyRunning({ host, port, passthrough, debug, mitmDomains: domains }, deps);
    console.error(
        `bili: ${handle.reused ? "reusing existing" : "started"} proxy at ${handle.origin} (MITM domains: ${domains.length ? domains.join(", ") : "defaults"})`,
    );

    const ca = resolveCaCertPath(process.env);
    let env: NodeJS.ProcessEnv;
    if (params.client === "pi") env = buildPiEnv(handle.origin, ca, process.env);
    else if (params.client === "codex") env = buildCodexEnv(handle.origin, ca, process.env);
    else env = buildClaudeEnv(handle.origin, ca, process.env);

    const { command, prefixArgs } = resolveClientCommand(params.client, process.env);
    let code = 0;
    try {
        code = await runClient(command, [...prefixArgs, ...params.clientArgs], env, {
            spawnImpl: deps.spawnImpl,
        });
    } catch (err) {
        console.error(`bili: failed to launch ${params.client}: ${err instanceof Error ? err.message : String(err)}`);
        code = 1;
    } finally {
        if (!handle.reused) stopProxy(handle);
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
