/**
 * `bili <client>` launcher — brings up the proxy on an independent port and
 * points a coding agent at it, auto-proxying BOTH schemes without editing the
 * client's config files:
 *   - HTTPS upstreams → cert MITM (HTTPS_PROXY + the proxy's MITM CA, with the
 *     discovered hosts whitelisted for TLS interception).
 *   - HTTP upstreams → `/bili/` baseURL rewrite (cert MITM can't intercept
 *     plaintext), applied via the client's own mechanism: codex `-c key=value`,
 *     claude `ANTHROPIC_BASE_URL` env, pi via `registerProvider` in the bili
 *     extension (#535 — manifest passed through BILI_PROVIDER_REWRITES).
 *
 *   bili pi     [-- client args...]   HTTPS_PROXY + NODE_EXTRA_CA_CERTS
 *   bili codex  [-- client args...]   HTTPS_PROXY + SSL_CERT_FILE
 *   bili claude [-- client args...]   HTTPS_PROXY + NODE_EXTRA_CA_CERTS
 *   bili kimi   [-- client args...]   HTTPS_PROXY + NODE_EXTRA_CA_CERTS (cert-MITM)
 *   bili aider  [-- client args...]   HTTPS_PROXY + SSL_CERT_FILE/REQUESTS_CA_BUNDLE (cert-MITM)
 *   bili crush  [-- client args...]   HTTPS_PROXY + SSL_CERT_FILE (cert-MITM)
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
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync, type StdioOptions } from "node:child_process";
import { DEFAULT_MITM_DOMAINS } from "./mitm.js";
import {
    claimStartingMarker,
    clearStartingMarker,
    discoverLiveInstances,
    entryScriptFingerprint,
    isPidAlive,
    isProxyInstanceFile,
    lanePreferredPort,
    readProxyInstanceFile,
    readStartingMarker,
    removeStartingMarker,
    writeZonePort,
    type ProxyInstanceFile,
    type ProxyStartingMarker,
} from "./instance.js";
import { selfPackageRoot, isBiliPiEntry, ompPluginLoadedFrom, dshNativeInstalled, claudeNativeInstalled } from "./plugin-install.js";
import { applyOmpFirstEventTimeout } from "./agent/native-bootstrap.js";
import { log as teeLog } from "./logger.js";
import { winCmdUnsafeToken, winCmdRefusalError } from "./win-cmd.js";

/** Absolute path of a file inside our dist/, resolved via the package root
 * (import.meta.url-based) so it survives global-installed symlink bins
 * (~/.local/bin/bili → .../node_modules/billion-context) — process.argv[1]
 * stays at the symlink and would break path.resolve(dirname(argv[1]), ...). */
function selfDistFile(name: string): string {
    return path.join(selfPackageRoot(), "dist", name);
}
import { nonEmpty, resolvePiHome, resolveOmpHome, resolveDshHome, resolveCodexHome, resolveCodexEffectiveView, loadClientConfig, collectModelWindows, collectModelMaxOutputs, type ClientConfig, type CodexConfig, resolveOpencodeConfigFile, readOpencodeConfigRoot, opencodePluginBaseDir, type OpencodeConfig, type OpencodeProvider, type HermesConfig, type HermesProvider, qoderIsCnSite, QODER_DEFAULT_MODEL_HOSTS, resolveTraeHome, readTraeConfig, TRAE_DEFAULT_MODEL_HOSTS, JCODE_DEFAULT_MODEL_HOSTS, type TraeConfig, resolveKimiHome, readKimiConfig, parseKimiToml, KIMI_DEFAULT_MODEL_HOSTS, QWEN_DEFAULT_MODEL_HOSTS, type KimiConfig, type KimiProvider, readOpencodeProjectLayer, type OpencodeProjectLayer, readMcodeConfig, resolveMcodeInstallDir, MCODE_DEFAULT_MODEL_HOSTS, type McodeConfig, discoverAiderArgUrls, AIDER_DEFAULT_MODEL_HOSTS, COPILOT_DEFAULT_MODEL_HOSTS, AMP_DEFAULT_MODEL_HOSTS, CRUSH_DEFAULT_MODEL_HOSTS, ZED_DEFAULT_MODEL_HOSTS, readZedConfig, resolveGooseDirs, readGooseConfig, type GooseConfig, type GooseDirs } from "./client-config.js";
import { allowDshCompactionState, loadRoutes, resolveConfiguredContextLimit, lookupContextLimit, resolveNativeAttachExternal, resolveMitmDomains, resolveNonHttpProviders, type ProviderRoutes } from "./config.js";
import { discoverMitmDomains } from "./discover.js";
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
    resolveCodexHome,
    resolveTraeHome,
    readTraeConfig,
    TRAE_DEFAULT_MODEL_HOSTS,
    JCODE_DEFAULT_MODEL_HOSTS,
    type TraeConfig,
    resolveOpencodeConfigFile,
    readOpencodeConfig,
    readOpencodeConfigRoot,
    type OpencodeConfig,
    type OpencodeProvider,
    readOpencodeProjectLayer,
    type OpencodeProjectLayer,
    type CodebuddyConfig,
    readCodebuddyConfig,
    parseCodebuddyModelsJson,
    resolveCodebuddyHome,
    readQoderConfig,
    resolveQoderHome,
    qoderIsCnSite,
    QODER_DEFAULT_MODEL_HOSTS,
    type QoderConfig,
    parseKimiToml,
    readKimiConfig,
    resolveKimiHome,
    KIMI_DEFAULT_MODEL_HOSTS,
    type KimiConfig,
    type KimiProvider,
    QWEN_DEFAULT_MODEL_HOSTS,
    parseMcodeYaml,
    readMcodeConfig,
    resolveMcodeInstallDir,
    mcodeConfigFiles,
    MCODE_DEFAULT_MODEL_HOSTS,
    type McodeConfig,
    readAiderConfig,
    readAiderConfUrls,
    discoverAiderArgUrls,
    AIDER_DEFAULT_MODEL_HOSTS,
    AIDER_BASE_URL_ENVS,
    type AiderConfig,
    COPILOT_DEFAULT_MODEL_HOSTS,
    AMP_DEFAULT_MODEL_HOSTS,
    CRUSH_DEFAULT_MODEL_HOSTS,
    readCrushConfig,
    ZED_DEFAULT_MODEL_HOSTS,
    readZedConfig,
    resolveGooseDirs,
    readGooseConfig,
    type GooseConfig,
    type GooseDirs,
} from "./client-config.js";
import { conflictRemediation } from "./conflict-watch.js";
import { conflictScanEnabled, isDesignBenign, scanClientPlugins } from "./thirdparty-scan.js";

export const LAUNCHER_DEFAULT_HOST = "127.0.0.1";
export const LAUNCH_CLIENTS = ["pi", "codex", "claude", "omp", "opencode", "hermes", "dsh", "codebuddy", "qoder", "trae", "jcode", "kimi", "gemini", "iflow", "qwen", "mcode", "aider", "copilot", "amp", "crush", "zed", "goose", "antigravity", "pi-test"] as const;
export type ClientName = (typeof LAUNCH_CLIENTS)[number];
type BaseClientName = "claude" | "codex" | "pi" | "omp" | "opencode" | "hermes" | "dsh" | "codebuddy" | "qoder" | "trae" | "jcode" | "kimi" | "gemini" | "iflow" | "qwen" | "mcode" | "aider" | "copilot" | "amp" | "crush" | "zed" | "goose" | "antigravity";

const HEALTH_PATH = "/__bili/health";
const HEALTH_POLL_INTERVAL_MS = 200;
const SPAWN_WAIT_MS = 20000;
// #2187: grace beyond the initial wait for a LIVE child still starting.
// Spawn-window startups have been observed taking 26-45s on slow Windows
// machines (AV / first-run disk activity); the one-shot 20s budget misread
// that as failure and left the lane degraded for the whole session.
const SLOW_START_GRACE_MS = 40_000;
// Total wait for a live child: initial window + grace. A child that EXITS or
// fails to spawn still fails fast (the poll loop breaks on exit/error).
export const SPAWN_BUDGET_MS = SPAWN_WAIT_MS + SLOW_START_GRACE_MS;
const PROBE_TIMEOUT_MS = 1500;
// #707/#2187: max age of a starting marker still treated as an in-progress
// bring-up. A well-behaved starter resolves within SPAWN_BUDGET_MS (a live
// child may take the whole budget); the slack covers slow disks and client
// teardown before it clears the marker.
const STARTING_MARKER_TTL_MS = SPAWN_BUDGET_MS + 30_000;
// #1903: budget for the post-exit re-discovery below. A spawned child dying
// before becoming healthy is evidence the port it wanted is HELD — but our
// one-shot discovery snapshot may predate the holder publishing its identity
// record (a manual `bili start` accepts TCP before its 'listening' callback
// writes proxy-origin / registry markers). Refresh the snapshot on this
// bounded retry instead of failing from a stale view.
const POST_EXIT_REDISCOVERY_MS = 3000;

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
    options: { detached?: boolean; stdio?: StdioOptions; env?: NodeJS.ProcessEnv; shell?: boolean; windowsVerbatimArguments?: boolean; windowsHide?: boolean },
) => SpawnChild;

interface LaunchOptions {
    host: string;
    port: number;
    passthrough: boolean;
    debug: boolean;
    mitmDomains?: string[];
    /** Parent pid the spawned proxy's watchdog tracks (#964). Defaults to
     *  the CALLER's pid (launcher process). The claude SessionStart hook
     *  passes its OWN parent — claude's pid — because the hook process
     *  itself exits immediately after bring-up. */
    parentPid?: number;
    /** Per-model context windows read from the client's own config (pi
     *  models.json / omp models.yml / …). Handed to the spawned proxy via
     *  BILI_LAUNCHER_MODEL_WINDOWS so the nudge denominator matches the
     *  client's real window instead of the built-in table guess. */
    modelWindows?: Record<string, number>;
    /** Per-model configured max output (#971), same sources as
     *  modelWindows. Handed to the spawned proxy via
     *  BILI_LAUNCHER_MODEL_MAX_OUTPUTS for the output-headroom reservation. */
    modelMaxOutputs?: Record<string, number>;
    /** Pin opts.port: an EADDRINUSE at bind fails loud (child exits 1)
     * instead of the launcher default of port-hopping +1 (#964 — the claude
     * native posture dials a STATIC url baked into settings.json; a proxy
     * that silently landed on port+1 would strand every model request). */
    strictPort?: boolean;
    /** #1225: which client/lane this launch belongs to. Recorded by the
     *  spawned child (BILI_LAUNCHER_LANE) and compared on attach: two
     *  DIFFERENT declared lanes never share an instance, while an undeclared
     *  side (manual `bili start` daemon, pre-#1225 instance) stays a
     *  wildcard. Without this, pi and codex with identical config shape
     *  silently shared one proxy and cross-wrote each other's state. */
    lane?: string;
}

interface ProxyHandle {
    origin: string;
    port: number;
    child?: SpawnChild;
    logPath?: string;
    attached?: boolean;
    /** #1322: attach succeeded but the proxy REFUSED the session-watcher
     *  registration (409 — it has no session-lifecycle watchdog, i.e. it was
     *  started without BILI_PARENT_PID, e.g. manually on a stable port). The
     *  proxy will outlive every session and ignore config edits until killed;
     *  host-native bootstraps must surface this instead of staying silent. */
    refusedWatcher?: boolean;
}

export interface LauncherDeps {
    fetchImpl?: (url: string) => Promise<{ ok: boolean }>;
    fetchHealthInfo?: (origin: string) => Promise<HealthInfo | undefined>;
    /** #1335: resolves the attach-gate escape hatch. Default reads env
     *  BILI_NATIVE_ATTACH_EXTERNAL > config `native.attachExternal` > false. */
    resolveAttachExternal?: () => boolean;
    readInstanceFile?: () => ProxyInstanceFile | { origin: string } | undefined;
    spawnImpl?: SpawnFn;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** #519 native mode: the proxy entry script to spawn. The launcher
     *  default (process.argv[1]) is WRONG inside a host process like pi —
     *  pi-native.ts passes its own package's dist/index.js instead. */
    scriptPath?: string;
    /** #819: explicit Node executable for spawning the proxy. Inside a host
     *  process (opencode/pi native binary) process.execPath is NOT Node;
     *  defaults to resolveNodeRuntime(). */
    nodeRuntime?: string;
    /** #1190: watcher registration for ATTACHED shared proxies — tells the
     *  proxy's parent-gone watchdog which owner pid to track, so the proxy
     *  dies only after the LAST owner exits (#7/#1183). Default POSTs to
     *  <origin>/__bili/watcher; 409 (daemon proxy) is refused-and-silent at
     *  THIS layer but flags the handle (#1322), any other failure warns and
     *  degrades to the single-owner watchdog behavior. */
    registerWatcher?: (origin: string, pid: number) => Promise<WatcherRegistration>;
    /** #1623: diagnostic sink for attach-decision outcomes (probe drops,
     *  compatibility skips, gate refusals) — these used to be silent, which
     *  made "why did we spawn instead of attach" undiagnosable. Default tees
     *  to bili.log + stderr. */
    attachDiag?: (msg: string) => void;
    /** #1292: simulated OS for spawn planning and platform-gated arg
     *  construction — tests drive win32 paths from a POSIX host. Defaults
     *  to process.platform. */
    platform?: NodeJS.Platform;
    /** #1660: zone-port seam for tests. The preferred port a lane'd launch
     *  tries before the proxy child's +1 ladder (default: the lane's sticky
     *  record > zone base, instance.ts), and the sticky-settle write
     *  (default: stateDir()/port-zone.json). Tests inject pure sinks so a
     *  lane'd fake launch never touches the developer's real zone record. */
    zonePreferredPort?: (lane: string) => number;
    writeZonePort?: (lane: string, port: number) => void;
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

/** Loopback destinations (localhost / ::1 / 127.x). dsh's fetch stack bypasses
 *  proxy envs for these unconditionally (LOOPBACK_NO_PROXY), so they are the
 *  only upstreams that need the /bili/ URL rewrite (#535 phase 4). */
export function isLoopbackHost(host: string): boolean {
    const h = host.toLowerCase();
    if (h === "localhost" || h === "::1" || h === "[::1]") return true;
    // Dotted-quad 127/8 only — not "first label starts with 127" (that would
    // misclassify hostnames like 127.evil.com, #544 review nit).
    return /^127\.\d+\.\d+\.\d+$/.test(h);
}

export interface HttpRewrite {
    key: string;
    realUpstream: string;
}

export interface DiscoveredRoutes {
    httpsDomains: string[];
    httpRewrites: HttpRewrite[];
    httpsRewrites: HttpRewrite[];
    // Plaintext-http upstreams routed purely via HTTP_PROXY absolute-form
    // forward-proxy requests (no URL rewriting). dsh/kimi today, and never
    // loopback — both bypass proxy envs for loopback targets unconditionally,
    // so those ride httpRewrites instead (dsh: #535 phase 4; kimi: #757).
    httpEnvRoutes: string[];
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

/** Shared accumulator for the per-client branches of {@link discoverRoutes}
 *  (#1440 P3-A1): the six locals every family helper below reads and writes.
 *  Field semantics identical to the pre-refactor locals of the same names. */
interface DiscoverAcc {
    httpsDomains: string[];
    httpRewrites: HttpRewrite[];
    httpsRewrites: HttpRewrite[];
    httpEnvRoutes: string[];
    httpsSeen: Set<string>;
    rewriteKeys: Set<string>;
}

/** Family F1 — relay wrap for single-base-URL clients (claude, codebuddy's
 *  base-URL leg, gemini, iflow, antigravity): unwrap the configured base URL
 *  (the built-in `fallback` when unset/blank) and route it through the /bili/
 *  URL form as a single httpRewrites entry under `key`, for any http(s)
 *  upstream. Unparseable base URLs leave routes empty. Semantics extracted
 *  byte-for-byte from those five branches. */
function relayWrapRoute(acc: DiscoverAcc, cfgRaw: string | undefined, fallback: string, key: string): void {
    const raw = nonEmpty(cfgRaw) ? cfgRaw : fallback;
    const real = unwrapUpstream(raw);
    try {
        const url = new URL(real);
        if ((url.protocol === "https:" || url.protocol === "http:") && !acc.rewriteKeys.has(key)) {
            acc.rewriteKeys.add(key);
            acc.httpRewrites.push({ key, realUpstream: real });
        }
    } catch {
        // Unparseable base URL: leave routes empty (proxy still runs; the
        // client falls back to its own default endpoint).
    }
}

/** Family F2 — static cert-MITM host whitelist (qoder, trae, jcode, qwen,
 *  copilot, amp, and the static legs of crush/zed): add each host to the
 *  https inventory (deduped, lowercased; `stripPort` reduces `host:port` to
 *  the port-less hostname so the entry matches the port-less SNI whitelist).
 *  Semantics extracted byte-for-byte from those branches. */
function addStaticHosts(acc: DiscoverAcc, hosts: readonly string[], stripPort: boolean): void {
    for (const h of hosts) {
        const host = (stripPort ? h.split(":", 2)[0]! : h).toLowerCase();
        if (host && !acc.httpsSeen.has(host)) {
            acc.httpsSeen.add(host);
            acc.httpsDomains.push(host);
        }
    }
}

/** Family F3 — proxy-routable URL-set walk with the loopback carve-out (dsh,
 *  kimi, mcode, aider): per raw URL — unwrap, parse, dedupe by the unwrapped
 *  upstream, then split by destination: loopback → /bili/ rewrite inventory
 *  under a numbered `<keyPrefix>-N` key; https remote → cert-MITM whitelist;
 *  plain-http remote → HTTP_PROXY env routes. `skipWrappedLoopback` (kimi,
 *  mcode) ignores loopbacks the user already wrapped at a previous proxy
 *  origin; `anonCountsAll` (dsh) numbers keys across EVERY accepted unique
 *  URL instead of only loopbacks (dsh counted uniques pre-refactor, the
 *  others counted loopbacks). Semantics extracted byte-for-byte from those
 *  branches. */
function addProxyUrlSet(acc: DiscoverAcc, urls: readonly string[], keyPrefix: string, skipWrappedLoopback: boolean, anonCountsAll: boolean): void {
    const seen = new Set<string>();
    let anon = 0;
    for (const raw of urls) {
        const real = unwrapUpstream(raw);
        try {
            const url = new URL(real);
            if (url.protocol !== "http:" && url.protocol !== "https:") continue;
            if (seen.has(real)) continue;
            seen.add(real);
            if (anonCountsAll) anon += 1;
            if (isLoopbackHost(url.hostname)) {
                if (skipWrappedLoopback && raw !== real) continue;
                if (!anonCountsAll) anon += 1;
                const key = `${keyPrefix}-${anon}`;
                acc.rewriteKeys.add(key);
                acc.httpRewrites.push({ key, realUpstream: real });
            } else if (url.protocol === "https:") {
                const host = url.hostname.toLowerCase();
                if (host && !acc.httpsSeen.has(host)) {
                    acc.httpsSeen.add(host);
                    acc.httpsDomains.push(host);
                }
            } else if (!acc.httpEnvRoutes.includes(real)) {
                acc.httpEnvRoutes.push(real);
            }
        } catch {
            // Unparseable endpoint: skip.
        }
    }
}

export function discoverRoutes(client: ClientName, config: ClientConfig): DiscoveredRoutes {
    const acc: DiscoverAcc = {
        httpsDomains: [],
        httpRewrites: [],
        httpsRewrites: [],
        httpEnvRoutes: [],
        httpsSeen: new Set<string>(),
        rewriteKeys: new Set<string>(),
    };
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
            if (host && !acc.httpsSeen.has(host.toLowerCase())) {
                acc.httpsSeen.add(host.toLowerCase());
                acc.httpsDomains.push(host);
            }
            // Wrapped HTTPS (/bili/<https>): rewrite client base_url to the RAW
            // https upstream so HTTPS_PROXY routes it through the cert MITM.
            if (raw !== unwrapUpstream(raw) && !httpsRewriteKeys.has(key)) {
                httpsRewriteKeys.add(key);
                acc.httpsRewrites.push({ key, realUpstream: unwrapUpstream(raw) });
            }
        } else if (url.protocol === "http:") {
            if (!acc.rewriteKeys.has(key)) {
                acc.rewriteKeys.add(key);
                acc.httpRewrites.push({ key, realUpstream: unwrapUpstream(raw) });
            }
        }
    };

    if (client === "claude") {
        // Claude Code's undici fetch ignores HTTPS_PROXY, so cert MITM cannot
        // intercept it. Route every upstream — raw HTTP, raw HTTPS, or already
        // wrapped at a previous proxy origin — through the /bili/ URL form via
        // ANTHROPIC_BASE_URL instead (claude honors that env var natively).
        // Unparseable base URL: leave routes empty (proxy still runs; claude
        // falls back to its own default endpoint).
        relayWrapRoute(acc, config.claude?.anthropicBaseUrl, "https://api.anthropic.com", "ANTHROPIC_BASE_URL");
    } else if (client === "codebuddy") {
        // codebuddy (Tencent CodeBuddy Code CLI) honors CODEBUDDY_BASE_URL
        // natively; its ModelProvider is the OpenAI SDK, so model traffic is
        // OpenAI chat completions (POST <base>/chat/completions) — bili routes
        // it through the openai adapter by path. Every upstream is routed
        // through the /bili/ URL form. The CN platform default endpoint is the
        // verified fallback; the international build defaults to
        // https://www.codebuddy.ai/v2 (product.json), so other deployments
        // must set CODEBUDDY_BASE_URL in settings.json or the shell.
        // models.json per-model urls BYPASS CODEBUDDY_BASE_URL, so they are
        // collected as MITM-whitelist inventory only, never rewritten (v1).
        // Unparseable base URL: leave routes empty (proxy still runs;
        // codebuddy falls back to its own default endpoint).
        relayWrapRoute(acc, config.codebuddy?.codebuddyBaseUrl, "https://tencent.sso.codebuddy.cn/v2", "CODEBUDDY_BASE_URL");
        for (const rawModelUrl of config.codebuddy?.modelUrls ?? []) {
            try {
                const url = new URL(unwrapUpstream(rawModelUrl));
                if (url.protocol !== "https:") continue;
                const host = url.hostname;
                if (host && !acc.httpsSeen.has(host.toLowerCase())) {
                    acc.httpsSeen.add(host.toLowerCase());
                    acc.httpsDomains.push(host);
                }
            } catch {
                // Unparseable model url: skip.
            }
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
        // #535 phase 2: hermes rides its httpx proxy env for every upstream —
        // https via CONNECT + cert MITM (host whitelisted for the CA),
        // plain-http via absolute-form forward-proxy requests the server
        // understands. No URL rewriting anywhere, so the real config.yaml is
        // never touched. httpRewrites is inventory-only here: it feeds the
        // banner and the no-provider warning; the child never consumes it.
        const hermesSeen = new Set<string>();
        for (const [name, prov] of Object.entries(config.hermes?.providers ?? {})) {
            if (!nonEmpty(prov.api)) continue;
            const real = unwrapUpstream(prov.api!);
            try {
                const url = new URL(real);
                if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                if (hermesSeen.has(name)) continue;
                hermesSeen.add(name);
                if (url.protocol === "https:") {
                    const host = url.hostname.toLowerCase();
                    if (host && !acc.httpsSeen.has(host)) {
                        acc.httpsSeen.add(host);
                        acc.httpsDomains.push(host);
                    }
                } else if (!acc.rewriteKeys.has(name)) {
                    acc.rewriteKeys.add(name);
                    acc.httpRewrites.push({ key: name, realUpstream: real });
                }
            } catch {
                // Unparseable endpoint: skip.
            }
        }
    } else if (client === "dsh") {
        // #535 phase 4: split by destination. dsh's fetch stack honors proxy
        // envs EXCEPT for an unconditional loopback bypass (LOOPBACK_NO_PROXY —
        // "the bypass is not optional"), so only non-loopback upstreams can
        // ride the proxy: https → cert MITM (host whitelisted below), plain
        // http → absolute-form forward-proxy requests (httpEnvRoutes).
        // Loopback destinations (http OR https) still need the /bili/ URL
        // rewrite in settings.yaml — the documented file exception. The
        // built-in deepseek-official route is captured via $DEEPSEEK_BASE_URL
        // in runLaunch.
        addProxyUrlSet(acc, config.dsh?.baseUrls ?? [], "dsh", false, true);
    } else if (client === "kimi") {
        // #757: Kimi Code honors standard proxy envs for all outbound traffic
        // EXCEPT an unconditional loopback NO_PROXY bypass (verified against
        // the v0.42.0 binary), so only non-loopback upstreams can ride the
        // proxy: https → cert MITM (host whitelisted below), plain http →
        // absolute-form forward-proxy requests (httpEnvRoutes). Loopback
        // destinations need a manual /bili/ prefix in config.toml — inventory
        // only here, feeding the banner. Endpoints the user already wrapped
        // (raw !== real) are skipped so they don't trigger the warning.
        const kimiUrls: string[] = [];
        for (const prov of Object.values(config.kimi?.providers ?? {})) {
            if (nonEmpty(prov.baseUrl)) kimiUrls.push(prov.baseUrl!);
        }
        for (const raw of [...(config.kimi?.modelUrls ?? []), ...(config.kimi?.envUrls ?? [])]) {
            kimiUrls.push(raw);
        }
        addProxyUrlSet(acc, kimiUrls, "kimi", true, false);
        if (kimiUrls.length === 0) {
            for (const h of KIMI_DEFAULT_MODEL_HOSTS) {
                if (!acc.httpsSeen.has(h)) {
                    acc.httpsSeen.add(h);
                    acc.httpsDomains.push(h);
                }
            }
        }
    } else if (client === "mcode") {
        // #1050: MiniMax Code honors standard proxy envs for all outbound
        // traffic EXCEPT an unconditional loopback NO_PROXY bypass (verified
        // against @minimax-ai/code 0.4.12, packages/tui/src/cli/network-proxy.ts),
        // same shape as kimi above. Loopback upstreams need a manual /bili/
        // prefix in config.yaml — inventory only, feeding the banner.
        const mcodeUrls: string[] = [];
        for (const prov of Object.values(config.mcode?.providers ?? {})) {
            if (nonEmpty(prov.baseUrl)) mcodeUrls.push(prov.baseUrl!);
        }
        addProxyUrlSet(acc, mcodeUrls, "mcode", true, false);
        if (mcodeUrls.length === 0) {
            for (const h of MCODE_DEFAULT_MODEL_HOSTS) {
                if (!acc.httpsSeen.has(h)) {
                    acc.httpsSeen.add(h);
                    acc.httpsDomains.push(h);
                }
            }
        }
    } else if (client === "qoder") {
        // #653: qoder's model endpoint scheme is hardcoded https with no
        // base-URL override env, so /bili/ rewrites cannot reach it — cert
        // MITM is the only route (qoder honors HTTPS_PROXY +
        // NODE_EXTRA_CA_CERTS). Whitelist is the binary's static host map
        // (prod + regional + CN gateway); an explicit QODER_MODEL_SERVER_HOST
        // REPLACES it (qoder's own resolution order: env > static map).
        addStaticHosts(acc, nonEmpty(config.qoder?.modelServerHost) ? [config.qoder!.modelServerHost!] : QODER_DEFAULT_MODEL_HOSTS, false);
    } else if (client === "trae") {
        // #655: Trae CLI is a closed Go binary (no base-URL override) that
        // honors HTTPS_PROXY; the model API host is TRAE_CLI_API_HOST or the
        // default enterprise gateway. Whitelist the host(s) for cert-MITM so
        // the proxy can compress the model traffic. No /bili/ rewrite (the
        // scheme is hardcoded https).
        // MITM whitelist matches the port-less SNI hostname (isMitmHost), so
        // reduce host:port to its host or the entry never matches.
        addStaticHosts(acc, nonEmpty(config.trae?.modelApiHost) ? [config.trae!.modelApiHost!] : TRAE_DEFAULT_MODEL_HOSTS, true);
    } else if (client === "jcode") {
        // jcode keeps provider base URLs in ~/.jcode/config.toml; there is no
        // TOML reader yet (add one for per-provider discovery). Whitelist the
        // default zai coding endpoint so the proxy compresses that leg;
        // loopback legs (local model servers, MCP) stay direct via NO_PROXY.
        addStaticHosts(acc, JCODE_DEFAULT_MODEL_HOSTS, true);
    } else if (client === "gemini") {
        // #1047: gemini-cli's @google/genai client switches to GATEWAY mode
        // whenever GOOGLE_GEMINI_BASE_URL is set and sends model traffic
        // DIRECTLY to that URL (its model-call fetch ignores proxy envs), so
        // the /bili/ URL form is the only route. The SDK appends
        // `<apiVersion>/models/…` itself (default v1beta), so wrap the bare
        // host origin — no /v1beta suffix. A user-exported base URL is a
        // relay: wrap IT instead of the stock endpoint (claude semantics).
        // Unparseable base URL: leave routes empty (proxy still runs;
        // gemini-cli falls back to its own default endpoint).
        relayWrapRoute(acc, config.gemini?.baseUrl, "https://generativelanguage.googleapis.com", "GOOGLE_GEMINI_BASE_URL");
    } else if (client === "iflow") {
        // #1047: iFlow CLI honors IFLOW_BASE_URL natively; its stock endpoint
        // is apis.iflow.cn/v1 (OpenAI wire — bili routes it by path). Same
        // relay-wrap semantics as gemini.
        // Unparseable base URL: leave routes empty (proxy still runs;
        // iFlow falls back to its own default endpoint).
        relayWrapRoute(acc, config.iflow?.baseUrl, "https://apis.iflow.cn/v1", "IFLOW_BASE_URL");
    } else if (client === "qwen") {
        // #1047: qwen-code is a heavily diverged multi-protocol fork of
        // gemini-cli with NO base-URL override env for routing; its undici
        // stack honors HTTPS_PROXY (setGlobalDispatcher(EnvHttpProxyAgent)),
        // so cert-MITM is the only route. Whitelist the stock DashScope/Qwen
        // gateways + common third-party provider hosts; custom relays go
        // through --mitm-domain.
        addStaticHosts(acc, QWEN_DEFAULT_MODEL_HOSTS, false);
    } else if (client === "antigravity") {
        // #2115: Antigravity's model channel runs inside the closed Go
        // language_server, which honors the undocumented CLOUD_CODE_URL env
        // override (verified in the v2.19.1 binary: "Overriding
        // CloudCodeServerURL via CLOUD_CODE_URL environment variable"). The
        // stock endpoint is cloudcode-pa.googleapis.com; bili recognizes the
        // wire by path (:streamGenerateContent et al. → google adapter). A
        // user-exported CLOUD_CODE_URL is a relay: wrap IT instead of the
        // stock endpoint (claude semantics). Fallback if Google removes the
        // knob: cert-MITM (the server honors HTTPS_PROXY, no pinning) — see
        // CLIENTS.md (Gemini family section).
        // Unparseable base URL: leave routes empty (proxy still runs;
        // Antigravity falls back to its own default endpoint).
        relayWrapRoute(acc, config.antigravity?.baseUrl, "https://cloudcode-pa.googleapis.com", "CLOUD_CODE_URL");
    } else if (client === "aider") {
        // #1048: aider's Python stack (litellm → httpx, plus requests) honors
        // standard proxy envs for all outbound traffic, so no URL rewriting
        // exists or is needed — only destination routing: https upstreams get
        // cert MITM (host whitelisted below), non-loopback plain-http ride
        // absolute-form forward-proxy requests (httpEnvRoutes). Loopback
        // destinations stay direct via NO_PROXY and are inventory-only
        // (compressing them would require editing .aider.conf.yml, which the
        // zero-config-change contract forbids). Endpoints come from runtime
        // env + .aider.conf.yml + CLI args (merged by runLaunch); nothing
        // declared → the common defaults.
        addProxyUrlSet(acc, config.aider?.baseUrls ?? [], "aider", false, false);
        if ((config.aider?.baseUrls ?? []).length === 0) {
            for (const h of AIDER_DEFAULT_MODEL_HOSTS) {
                if (!acc.httpsSeen.has(h)) {
                    acc.httpsSeen.add(h);
                    acc.httpsDomains.push(h);
                }
            }
        }
    } else if (client === "copilot") {
        // #1049: closed Go binary, no base-URL override — cert-MITM is the only
        // route (Go net/http honors HTTPS_PROXY + SSL_CERT_FILE). Whitelist is
        // GitHub's own CI firewall allowlist for the CLI: api.githubcopilot.com
        // plus the per-plan subdomains.
        addStaticHosts(acc, COPILOT_DEFAULT_MODEL_HOSTS, true);
    } else if (client === "amp") {
        // #1049: closed Go binary like copilot; ampcode.com carries both the
        // model leg and the control plane, so one entry covers both.
        addStaticHosts(acc, AMP_DEFAULT_MODEL_HOSTS, true);
    } else if (client === "crush") {
        // #2340: open-source Go binary — cert-MITM like amp/copilot (net/http
        // honors HTTPS_PROXY; CA rides SSL_CERT_FILE). Whitelist the built-in
        // provider hosts plus custom provider base_urls discovered from
        // crush.json (readCrushConfig, https only); exotic relays ride
        // --mitm-domain.
        addStaticHosts(acc, CRUSH_DEFAULT_MODEL_HOSTS, true);
        for (const raw of config.crush?.baseUrls ?? []) {
            try {
                if (new URL(raw).protocol !== "https:") continue;
                const host = new URL(raw).hostname.toLowerCase();
                if (host && !acc.httpsSeen.has(host)) {
                    acc.httpsSeen.add(host);
                    acc.httpsDomains.push(host);
                }
            } catch {}
        }
    } else if (client === "zed") {
        // #2340: open-source Rust editor — cert-MITM like jcode (reqwest
        // honors HTTPS_PROXY; CA rides SSL_CERT_FILE via openssl-probe env
        // probing on Linux). Whitelist the built-in provider hosts plus
        // custom provider api_urls discovered from settings.json
        // (readZedConfig, https only); exotic relays ride --mitm-domain.
        addStaticHosts(acc, ZED_DEFAULT_MODEL_HOSTS, true);
        for (const raw of config.zed?.baseUrls ?? []) {
            try {
                if (new URL(raw).protocol !== "https:") continue;
                const host = new URL(raw).hostname.toLowerCase();
                if (host && !acc.httpsSeen.has(host)) {
                    acc.httpsSeen.add(host);
                    acc.httpsDomains.push(host);
                }
            } catch {
                continue;
            }
        }
    } else if (client === "goose") {
        // #1049: release builds wire reqwest with rustls (webpki roots), so the
        // proxy's CA is untrusted and cert-MITM cannot reach goose at all — every
        // model leg is redirected straight at the proxy as plain HTTP instead.
        // Custom declarative providers ride httpRewrites (delivered through a
        // regenerated config overlay in prepareGooseHome; loopback included,
        // since the rewrite IS the delivery mechanism here, unlike dsh/kimi);
        // the built-in openai/anthropic legs are covered by *_HOST env overrides
        // injected in runLaunch. No MITM domains exist for this client.
        const seen = new Set<string>();
        for (const [name, raw] of Object.entries(config.goose?.customProviders ?? {})) {
            const real = unwrapUpstream(raw);
            try {
                const url = new URL(real);
                if (url.protocol !== "http:" && url.protocol !== "https:") continue;
                if (seen.has(real)) continue;
                seen.add(real);
                acc.rewriteKeys.add(name);
                acc.httpRewrites.push({ key: name, realUpstream: real });
            } catch {}
        }
    } else {
        for (const [name, prov] of Object.entries(config.codex?.providers ?? {})) {
            classify(prov.baseUrl, `model_providers.${name}.base_url`);
        }
        classify(config.codex?.openaiBaseUrl, "openai_base_url");
    }

    const { httpsDomains, httpRewrites, httpsRewrites, httpEnvRoutes } = acc;
    return { httpsDomains, httpRewrites, httpsRewrites, httpEnvRoutes };
}

export function discoverDomains(client: ClientName, config: ClientConfig): string[] {
    return discoverRoutes(client, config).httpsDomains;
}

export function buildPiEnv(
    origin: string,
    caPath: string,
    baseEnv: NodeJS.ProcessEnv,
    httpRewrites: HttpRewrite[] = [],
    httpsRewrites: HttpRewrite[] = [],
    mitmHosts: string[] = [],
    nonHttpProviders: string[] = [],
): NodeJS.ProcessEnv {
    // #535: provider URL rewrites ride env, not a generated models.json —
    // the bili extension (agent/pi.js) consumes this manifest at load and
    // overrides each provider's baseUrl via registerProvider before any
    // model traffic. https upstreams whose models.json baseUrl was already
    // hand-wrapped to `<origin>/bili/https://...` (README Option 2) ALSO
    // need an entry — with the RAW https value, which repoints them off the
    // stale embedded origin onto the cert-MITM path (HTTPS_PROXY + CA).
    const manifest: Record<string, string> = {};
    for (const r of httpRewrites) {
        if (r.key.length === 0 || r.realUpstream.length === 0) continue;
        manifest[r.key] = wrapUpstream(origin, r.realUpstream);
    }
    for (const r of httpsRewrites) {
        if (r.key.length === 0 || r.realUpstream.length === 0) continue;
        manifest[r.key] = r.realUpstream;
    }
    return {
        ...baseEnv,
        HTTPS_PROXY: origin,
        NODE_EXTRA_CA_CERTS: caPath,
        BILLION_CONTEXT_PROXY: origin,
        ...(Object.keys(manifest).length > 0 ? { BILI_PROVIDER_REWRITES: JSON.stringify(manifest) } : {}),
        // #1403: the extension stamps prompt_cache_key only for destinations on
        // this list (or /bili/-wrapped URLs) — exactly the hosts the proxy will
        // MITM-decrypt and strip it from. Blind-tunnel destinations must NOT be
        // stamped or strict-schema upstreams 400 the foreign field.
        ...(mitmHosts.length > 0 ? { BILI_MITM_HOSTS: mitmHosts.join(",") } : {}),
        // #1392: the extension's ownsCompaction reads this to narrow its non-http(s) veto.
        ...(nonHttpProviders.length > 0 ? { BILI_NON_HTTP_PROVIDERS: nonHttpProviders.join(",") } : {}),
    };
}

// --- #1440 P3: one preset table + one builder behind the per-client
// buildXxxEnv wrappers. Every client shares the same core —
// `{ ...baseEnv, HTTPS_PROXY=<origin>, <CA var(s)>=<caPath>,
// BILLION_CONTEXT_PROXY=<origin> }` — plus optional static extras (NO_PROXY
// loopback pairs), an aider-only conditional HTTP_PROXY, and/or the single
// base-URL override env resolved from discovered rewrites (http upstreams →
// /bili/-wrapped value, https upstreams → raw value; when both exist the
// https entry wins, matching the historical sequential assignment). buildPiEnv
// (JSON manifest + host list envs) and buildClaudePluginEnv (direct-URL mode,
// returns baseEnv untouched) stay bespoke above/below this table. ---
type LauncherEnvClient = "codex" | "trae" | "jcode" | "aider" | "copilot" | "amp" | "claude" | "codebuddy" | "qoder" | "gemini" | "iflow" | "qwen" | "antigravity" | "zed";

interface EnvClientPreset {
    /** CA path is written to every listed env var. */
    caKeys: readonly string[];
    /** emit HTTPS_PROXY=<origin>; false for gateway/base-URL routing clients (no proxy env at all). */
    proxy: boolean;
    /** emit HTTP_PROXY=<origin> only when the wrapper's routeHttp param is true (aider). */
    httpProxyOnRouteHttp: boolean;
    /** extra static key/value pairs appended after BILLION_CONTEXT_PROXY, in order. */
    extras?: readonly (readonly [string, string])[];
    /** base-URL override env(s) filled from rewrites — first entry is the rewrite lookup key, the rest are mirrors set to the same value. */
    baseUrlKeys?: readonly string[];
}

const LAUNCHER_LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";

const ENV_CLIENTS: Record<LauncherEnvClient, EnvClientPreset> = {
    codex: { caKeys: ["SSL_CERT_FILE"], proxy: true, httpProxyOnRouteHttp: false },
    // #655: trae is a Go binary like codex — the CA rides SSL_CERT_FILE (the
    // combined bundle, since it replaces Go's system trust store).
    trae: { caKeys: ["SSL_CERT_FILE"], proxy: true, httpProxyOnRouteHttp: false },
    // jcode is Rust reqwest: CA rides SSL_CERT_FILE (combined bundle).
    // NO_PROXY keeps loopback legs (local model endpoints, MCP) direct.
    jcode: {
        caKeys: ["SSL_CERT_FILE"],
        proxy: true,
        httpProxyOnRouteHttp: false,
        extras: [["NO_PROXY", LAUNCHER_LOOPBACK_NO_PROXY], ["no_proxy", LAUNCHER_LOOPBACK_NO_PROXY]],
    },
    // #1048: aider's Python stack trusts the CA through two different readers
    // — httpx (litellm's HTTP layer) honors SSL_CERT_FILE with REPLACE
    // semantics (hence the combined bundle carrying system roots so
    // blind-tunneled hosts still validate), and requests honors
    // REQUESTS_CA_BUNDLE. HTTP_PROXY is only set when a plaintext-http
    // upstream actually routes through it (absolute-form forward-proxy).
    // NO_PROXY keeps loopback legs (local ollama/vllm servers) direct.
    aider: {
        caKeys: ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"],
        proxy: true,
        httpProxyOnRouteHttp: true,
        extras: [["NO_PROXY", LAUNCHER_LOOPBACK_NO_PROXY], ["no_proxy", LAUNCHER_LOOPBACK_NO_PROXY]],
    },
    // #1049: copilot is a Go binary like codex/trae — the CA rides SSL_CERT_FILE
    // (the combined bundle, since it replaces Go's system trust store).
    copilot: { caKeys: ["SSL_CERT_FILE"], proxy: true, httpProxyOnRouteHttp: false },
    // #1049: amp is a Go binary like copilot — same cert-MITM contract.
    amp: { caKeys: ["SSL_CERT_FILE"], proxy: true, httpProxyOnRouteHttp: false },
    claude: { caKeys: ["NODE_EXTRA_CA_CERTS"], proxy: true, httpProxyOnRouteHttp: false, baseUrlKeys: ["ANTHROPIC_BASE_URL"] },
    codebuddy: { caKeys: ["NODE_EXTRA_CA_CERTS"], proxy: true, httpProxyOnRouteHttp: false, baseUrlKeys: ["CODEBUDDY_BASE_URL"] },
    /** #653: qoder's model endpoint scheme is hardcoded https (no base-URL
     *  override env), so the launcher can only route it via cert MITM: its
     *  built-in undici stack honors HTTPS_PROXY, and NODE_EXTRA_CA_CERTS is
     *  ADDITIVE (unlike codex's SSL_CERT_FILE), so the plain root CA suffices.
     *  No base-URL rewrite of any kind. */
    qoder: { caKeys: ["NODE_EXTRA_CA_CERTS"], proxy: true, httpProxyOnRouteHttp: false },
    // #2340: Zed is a Rust reqwest client — same env contract as jcode. The
    // CA rides SSL_CERT_FILE: Zed's rustls resolves roots through
    // rustls-platform-verifier -> rustls-native-certs -> openssl-probe, which
    // reads SSL_CERT_FILE/SSL_CERT_DIR first (Linux; macOS/Windows platform
    // verifiers ignore env files — system trust store there). NO_PROXY keeps
    // loopback providers (ollama/lmstudio) and MCP legs direct.
    zed: {
        caKeys: ["SSL_CERT_FILE"],
        proxy: true,
        httpProxyOnRouteHttp: false,
        extras: [["NO_PROXY", LAUNCHER_LOOPBACK_NO_PROXY], ["no_proxy", LAUNCHER_LOOPBACK_NO_PROXY]],
    },
    // No proxy/CA env: model traffic goes straight to the loopback proxy via
    // GOOGLE_GEMINI_BASE_URL (GATEWAY mode), never through HTTPS_PROXY.
    gemini: { caKeys: [], proxy: false, httpProxyOnRouteHttp: false, baseUrlKeys: ["GOOGLE_GEMINI_BASE_URL"] },
    // iFlow accepts case variants of the base-URL env; set both documented
    // forms so whichever the client reads first wins.
    iflow: { caKeys: [], proxy: false, httpProxyOnRouteHttp: false, baseUrlKeys: ["IFLOW_BASE_URL", "IFLOW_baseUrl"] },
    /** #1047: qwen-code honors HTTPS_PROXY + NODE_EXTRA_CA_CERTS (undici,
     *  additive CA semantics like qoder); NO_PROXY keeps loopback legs direct. */
    qwen: {
        caKeys: ["NODE_EXTRA_CA_CERTS"],
        proxy: true,
        httpProxyOnRouteHttp: false,
        extras: [["NO_PROXY", LAUNCHER_LOOPBACK_NO_PROXY], ["no_proxy", LAUNCHER_LOOPBACK_NO_PROXY]],
    },
    /** #2115: CLOUD_CODE_URL points language_server straight at the loopback
     *  proxy; no proxy/CA env needed (the override IS the route). */
    antigravity: { caKeys: [], proxy: false, httpProxyOnRouteHttp: false, baseUrlKeys: ["CLOUD_CODE_URL"] },
};

function buildClientEnv(
    preset: EnvClientPreset,
    origin: string,
    caPath: string,
    baseEnv: NodeJS.ProcessEnv,
    rewrites?: { httpRewrites: HttpRewrite[]; httpsRewrites: HttpRewrite[] },
    routeHttp?: boolean,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    if (preset.proxy) env.HTTPS_PROXY = origin;
    if (preset.httpProxyOnRouteHttp && routeHttp === true) env.HTTP_PROXY = origin;
    for (const k of preset.caKeys) env[k] = caPath;
    env.BILLION_CONTEXT_PROXY = origin;
    for (const [k, v] of preset.extras ?? []) env[k] = v;
    const baseUrlKeys = preset.baseUrlKeys ?? [];
    if (baseUrlKeys.length > 0 && rewrites !== undefined) {
        const r = rewrites.httpRewrites.find((rw) => rw.key === baseUrlKeys[0]);
        if (r) for (const k of baseUrlKeys) env[k] = wrapUpstream(origin, r.realUpstream);
        const hr = rewrites.httpsRewrites.find((rw) => rw.key === baseUrlKeys[0]);
        if (hr) for (const k of baseUrlKeys) env[k] = hr.realUpstream;
    }
    return env;
}

export function buildCodexEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.codex, origin, caPath, baseEnv);
}

export function buildTraeEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.trae, origin, caPath, baseEnv);
}

export function buildJcodeEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.jcode, origin, caPath, baseEnv);
}

export function buildAiderEnv(origin: string, caBundle: string, baseEnv: NodeJS.ProcessEnv, routeHttp: boolean): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.aider, origin, caBundle, baseEnv, undefined, routeHttp);
}

export function buildCopilotEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.copilot, origin, caPath, baseEnv);
}

export function buildAmpEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.amp, origin, caPath, baseEnv);
}

export function buildCrushEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // #2340: crush is a Go binary like amp/copilot — same cert-MITM contract
    // (net/http honors HTTPS_PROXY; the combined CA bundle replaces Go's
    // system trust store via SSL_CERT_FILE).
    return { ...baseEnv, HTTPS_PROXY: origin, SSL_CERT_FILE: caPath, BILLION_CONTEXT_PROXY: origin };
}

export function buildZedEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // #2340: Rust reqwest + rustls (roots via openssl-probe read
    // SSL_CERT_FILE first on Linux) — the jcode env contract; NO_PROXY keeps
    // loopback providers direct.
    return buildClientEnv(ENV_CLIENTS.zed, origin, caPath, baseEnv);
}

export function buildCodexArgs(
    origin: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    extra: string[],
): string[] {
    // #2197: codex applies repeated -c left-to-right, LAST WINS (verified
    // 0.147.0), so the transport substitution must come AFTER the user's own
    // argv — otherwise a user `-c <same key>` silently wins and the request
    // bypasses the proxy. The TARGET itself is already chosen from the merged
    // effective view (profile + CLI overrides), so appending never hides a
    // user-selected endpoint behind a stale one.
    // #2260(D): "after the user's argv" means after the user's FLAGS, not
    // after their positionals — everything past a `--` is positional to
    // codex's parser, so appending there turns the rewrites into prompt text
    // and the traffic bypasses the proxy. Insert before the first `--` when
    // one exists; all user flag tokens still precede the rewrites, keeping
    // last-wins intact.
    const rewrites: string[] = [];
    for (const r of httpRewrites) {
        rewrites.push("-c", `${r.key}=${wrapUpstream(origin, r.realUpstream)}`);
    }
    for (const r of httpsRewrites) {
        rewrites.push("-c", `${r.key}=${r.realUpstream}`);
    }
    if (rewrites.length === 0) return [...extra];
    const at = codexRewriteInsertionIndex(extra);
    return [...extra.slice(0, at), ...rewrites, ...extra.slice(at)];
}

/** codex subcommand flags that take NO value (clap booleans). Used only to
 * decide whether the trailing non-dash token is a free-standing positional
 * (safe insertion point) — see codexRewriteInsertionIndex. */
const CODEX_BOOLEAN_FLAGS = new Set([
    "--skip-git-repo-check",
    "--last",
    "--full-auto",
    "--dangerously-bypass-approvals-and-sandbox",
    "--no-daemon",
    "--search",
    "--no-search",
    "--help",
    "--version",
]);

/** Where buildCodexArgs splices its rewrites into the user's argv.
 *
 * #2260(D): everything past a `--` is positional to codex's parser, so the
 * rewrites must land BEFORE it (appending turned them into prompt text and
 * silently bypassed the proxy).
 *
 * #2281: codex-cli 0.147.0 parses `exec resume` such that a `-c` flag placed
 * AFTER the positional prompt silently DROPS an earlier `-c model=…` on the
 * same command line (bisected 2026-10-07: resume + trailing `-c` loses the
 * override; fresh exec, or resume without a trailing `-c`, both keep it).
 * Since the rewrites ARE trailing `-c` flags, appending them after the user's
 * prompt broke every `bili codex exec resume … <prompt>` turn for users
 * passing `-c model=…` — the model silently reverted to the config default.
 * Insert before the `resume` subcommand when present (any `-c` AFTER
 * `resume` suppresses the user's earlier `-c`s — verified against 0.147.0:
 * [-c model=B, resume, --last, -c provider…, prompt] still drops model=B),
 * otherwise before the trailing prompt — but ONLY when the last token is
 * provably a free-standing positional (its predecessor is a known boolean
 * flag or itself a positional) — never between a value-taking flag and its
 * value, and never into flags we do not recognise (those keep the legacy
 * append, which is at worst today's behavior). */
function codexRewriteInsertionIndex(extra: readonly string[]): number {
    const sep = extra.indexOf("--");
    if (sep !== -1) return sep;
    const resume = extra.indexOf("resume");
    if (resume !== -1) return resume; // keep every -c ahead of the resume subcommand
    const last = extra.length - 1;
    if (last < 0) return 0;
    if (extra[last].startsWith("-")) return extra.length; // flags-only tail — append
    const prev = last >= 1 ? extra[last - 1] : undefined;
    if (prev === undefined || !prev.startsWith("-") || CODEX_BOOLEAN_FLAGS.has(prev)) return last;
    return extra.length; // prev may be a value-taking flag whose value IS the last token — do not split
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
 * ACP (≈55%×W) always fires first, and codex's LOCAL compaction only
 * backstops when ACP fails, before codex's 95% hard cap. Local compaction is
 * NOT benign when it does fire across a fold boundary (#2372): the compacted
 * replay replaces the folded head wholesale, so the proxy detects the
 * signature (summary template + decimated fold coverage) and rebases the ACP
 * state onto the compacted view (src/server/prepare-responses.ts). Keeping
 * ACP first just minimizes how often that recovery path runs. codex clamps
 * both values to its own max_context_window, so an over-generous W degrades
 * to codex's own perception instead of overshooting.
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
    return buildClientEnv(ENV_CLIENTS.claude, origin, caPath, baseEnv, { httpRewrites, httpsRewrites });
}

/** codebuddy budget alignment (#321 pattern, mirrors resolveClaudeBudgetEnv):
 *  inject CODEBUDDY_AUTO_COMPACT_WINDOW so codebuddy's native auto-compact
 *  threshold matches bili's compress budget. Returns {} (no injection) when:
 *  no model resolvable, the user already set an explicit auto-compact window
 *  (settings `autoCompactWindow` or a shell-exported
 *  CODEBUDDY_AUTO_COMPACT_WINDOW), or bili resolves no window for the model. */
export async function resolveCodebuddyBudgetEnv(opts: {
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
    return { CODEBUDDY_AUTO_COMPACT_WINDOW: String(window) };
}

export function buildCodebuddyEnv(
    origin: string,
    caPath: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.codebuddy, origin, caPath, baseEnv, { httpRewrites, httpsRewrites });
}

export function buildQoderEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.qoder, origin, caPath, baseEnv);
}

export function buildGeminiEnv(
    origin: string,
    caPath: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.gemini, origin, caPath, baseEnv, { httpRewrites, httpsRewrites });
}

export function buildIflowEnv(
    origin: string,
    caPath: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.iflow, origin, caPath, baseEnv, { httpRewrites, httpsRewrites });
}

export function buildQwenEnv(origin: string, caPath: string, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.qwen, origin, caPath, baseEnv);
}

export function buildAntigravityEnv(
    origin: string,
    caPath: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
    return buildClientEnv(ENV_CLIENTS.antigravity, origin, caPath, baseEnv, { httpRewrites, httpsRewrites });
}

/**
 * #653: qoder's auto-compact window is a single env knob —
 * `QODER_AUTOCOMPACT_WINDOW` (`QODERCN_` prefix on the CN site) caps the
 * effective context window (`min(modelWindow, env)`), so injecting bili's
 * window is always safe (same #321 pattern as claude).
 *
 * Returns {} (no injection) when: no model resolvable, the user already set
 * an explicit auto-compact window (shell-exported env var), or bili resolves
 * no window for the model. qoder's model catalog is server-driven, so its
 * model names are usually absent from bili's configured limits and the
 * models.dev registry — the common outcome is no injection, with the user's
 * own `QODER_AUTOCOMPACT_WINDOW` as the fallback (issue #653 open question 3).
 */
export async function resolveQoderBudgetEnv(opts: {
    model: string | undefined;
    userAutoCompactWindow: string | undefined;
    windowKey: string;
    routes: ProviderRoutes;
    upstreamUrl: string | undefined;
}): Promise<NodeJS.ProcessEnv> {
    const { model, userAutoCompactWindow, windowKey, routes, upstreamUrl } = opts;
    if (!model || nonEmpty(userAutoCompactWindow)) return {};
    const window = await resolveLauncherWindow(model, routes, upstreamUrl);
    if (!window) return {};
    return { [windowKey]: String(window) };
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
 *  mode regardless of the upstream.
 *
 *  codebuddy is always excluded too: its `--mcp-config` compatibility is not
 *  yet verified against a real build, so v1 runs pure wire mode (the proxy
 *  injects the context tools on the wire). kimi is excluded as well: its
 *  mcp.json path is hardcoded in the binary with no ephemeral-config flag,
 *  so v1 runs pure wire mode (#757). gemini/iflow/qwen (#1047) are excluded
 *  like codebuddy: their MCP-injection flags are unverified, v1 is pure wire.
 *  copilot/amp/crush/goose are excluded likewise: closed or unverified MCP
 *  surfaces, v1 runs pure wire mode (#1049 / #2340). antigravity is excluded too
 *  (#2115): its model channel is a closed Go binary with no MCP-injection
 *  flag — v1 runs pure wire mode. */
export function launcherInjectMcp(env: NodeJS.ProcessEnv, base: string, codexUpstream?: string): boolean {
    if (base === "pi" || base === "omp" || base === "opencode" || base === "hermes" || base === "dsh" || base === "codebuddy" || base === "qoder" || base === "trae" || base === "jcode" || base === "kimi" || base === "gemini" || base === "iflow" || base === "qwen" || base === "antigravity" || base === "mcode" || base === "aider" || base === "copilot" || base === "amp" || base === "crush" || base === "zed" || base === "goose") return false;
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

/** #1292: native-install ANTHROPIC_BASE_URL override as --settings args.
 *  On Windows every claude launch rides a .cmd shim through cmd.exe, which
 *  strips embedded quotes (#679) — an inline settings JSON arrives quoteless
 *  and claude dies with "Invalid JSON provided to --settings". There the same
 *  object goes via a temp file whose path carries no quotes (same fix class
 *  as codex's #681 overlay); claude accepts a file path for --settings with
 *  identical precedence to the inline string. POSIX keeps the inline form —
 *  no shell re-parses argv there. */
export function buildClaudeSettingsArg(platform: NodeJS.Platform, override: string): { clientArgs: string[]; tmpFile?: string } {
    const payload = JSON.stringify({ env: { ANTHROPIC_BASE_URL: override } });
    if (platform !== "win32") return { clientArgs: ["--settings", payload] };
    const tmpFile = path.join(os.tmpdir(), `bili-claude-settings-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, payload);
    return { clientArgs: ["--settings", tmpFile], tmpFile };
}

/** #681/#1802: how the bili MCP server reaches the spawned codex, and why
 *  EVERY launch that needs the overlay points CODEX_HOME at it on every
 *  platform. Windows launches codex through a .cmd shim via cmd.exe, where a
 *  `-c mcp_servers.bili.*` value embedding an absolute path carries both
 *  quotes and spaces — cmd.exe strips the TOML-required quotes (it has no
 *  literal-quote escape), leaving malformed TOML. So the server definition is
 *  delivered via a file: a persistent <CODEX_HOME>-bili overlay whose merged
 *  config.toml holds [mcp_servers.bili]. POSIX could still take inline `-c`
 *  args (no shell re-parses argv), but since #1802 the overlay doubles as the
 *  carrier of a generated .env pinning the launcher's routing (see
 *  renderCodexDotEnv) — one mechanism on all platforms beats two.
 *  `conversationId` is a per-spawn UUID for BILI_CONVERSATION_ID: codex passes
 *  no session id to MCP children (verified codex-cli 0.147.0), so the MCP
 *  shell self-registers headlessly with it; the first model request creating a
 *  NEW session consumes the registration and binds the conversation (MITM
 *  route — in direct-URL mode the model traffic does not reach the proxy and
 *  the binding cannot happen). When the overlay cannot be built the injection
 *  degrades to nothing (wire mode still compresses server-side) with a
 *  warning. OverlayBusyError (#1952: another live launch owns the overlay) is
 *  PROPAGATED, not degraded — runLaunch aborts the launch, because degrading
 *  to the real home would silently drop the MCP tools and the .env protection. */
export function prepareCodexMcpInjection(opts: {
    codexHome: string;
    origin: string;
    caPath: string;
    conversationId?: string;
    manageRouting: boolean;
}): { clientArgs: string[]; envPatch: Record<string, string>; warning?: string } {
    const overlay = prepareCodexHome({
        codexHome: opts.codexHome,
        origin: opts.origin,
        caPath: opts.caPath,
        conversationId: opts.conversationId,
        manageRouting: opts.manageRouting,
    });
    if (!overlay) {
        const losses = [
            opts.conversationId !== undefined ? "launching without native bili MCP tools" : null,
            opts.manageRouting ? "the user's $CODEX_HOME/.env may override the injected proxy/CA" : null,
        ].filter((s): s is string => s !== null);
        return {
            clientArgs: [],
            envPatch: {},
            warning: `could not prepare the codex overlay (<CODEX_HOME>-bili) — ${losses.join("; ")}; wire-injected compression is still active.`,
        };
    }
    return { clientArgs: [], envPatch: { CODEX_HOME: overlay } };
}

/**
 * Shared persistent-overlay machinery for the remaining home-dir launcher
 * (dsh; pi/omp/hermes went file-free in #535 — env routing + extension, no
 * overlay). The overlay (`<realHome>-bili`) symlinks every real-home entry
 * except the launcher-generated file (settings.yaml), which is rewritten in
 * place atomically.
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
 * kept as-is.
 *
 * Ownership (#1952): the overlay is EXCLUSIVE per live launch. Before any
 * merge/write, refresh takes an atomic lease (`<overlay>/.bili-launch.lock/`
 * dir + owner record with pid + token); a second live launch refuses with
 * OverlayBusyError instead of clobbering the first one's generated .env / MCP
 * config / pid marker (the old warn-and-continue behavior let the last writer
 * win the routing). Stale leases from crashed launches are reclaimed
 * automatically (dead owner pid); a partially written owner record reads as
 * BUSY — conservative, manual unlock is deleting the lock dir. The legacy
 * `.bili-launch.pid` marker is still honored as a liveness hint so a pre-#1952
 * launch (which creates no lock dir) keeps its overlay too. runLaunch releases
 * the lease in its finally, after the client exits and the proxy is stopped.
 */
function overlayLockPath(overlay: string): string {
    return path.join(overlay, ".bili-launch.pid");
}

// Conservative liveness for ownership decisions (unlike instance.ts'
// isPidAlive): any kill error other than ESRCH reads as ALIVE, so a lease is
// never reclaimed from an owner we cannot verify.
function holderPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

function livePidHoldsOverlay(overlay: string): number | undefined {
    let raw: string | undefined;
    try {
        raw = fs.readFileSync(overlayLockPath(overlay), "utf8");
    } catch {
        return undefined;
    }
    const pid = Number.parseInt(raw.trim(), 10);
    if (pid === process.pid) return undefined;
    return holderPidAlive(pid) ? pid : undefined;
}

/** #1952: thrown when another LIVE bili launch owns the shared `-bili`
 *  overlay. The refused launch made no writes — the holder's generated files
 *  stay byte-identical. Manual unlock (crashed holder whose pid was reused, or
 *  any stuck state): delete `<overlay>/.bili-launch.lock/`. */
export class OverlayBusyError extends Error {
    readonly code = "BILI_OVERLAY_BUSY";
    constructor(readonly overlay: string, readonly holderPid?: number) {
        super(
            (holderPid !== undefined
                ? `another bili launch (pid ${holderPid}) is using the shared overlay ${overlay} — only one bili launch per home runs at a time; wait for it to exit`
                : `the shared overlay ${overlay} is held by a launch whose owner record is incomplete or unverifiable — if no bili launch of this home is running, remove ${overlayLeaseDir(overlay)} to unlock`)
                + " (this launch made no changes)",
        );
        this.name = "OverlayBusyError";
    }
}

function overlayLeaseDir(overlay: string): string {
    return path.join(overlay, ".bili-launch.lock");
}

function overlayOwnerPath(overlay: string): string {
    return path.join(overlayLeaseDir(overlay), "owner.json");
}

interface OverlayLeaseRecord {
    dir: string;
    ownerFile: string;
    token: string;
}

let activeOverlayLease: OverlayLeaseRecord | undefined;

function writeOwner(ownerFile: string, token: string): void {
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, ts: Date.now() }, null, 2));
}

function readOwner(ownerFile: string): { pid?: number; token?: string } {
    try {
        const rec = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as Record<string, unknown>;
        return {
            ...(typeof rec.pid === "number" ? { pid: rec.pid } : {}),
            ...(typeof rec.token === "string" ? { token: rec.token } : {}),
        };
    } catch {
        return {};
    }
}

/** #1952: atomically claim exclusive ownership of the overlay before any
 *  refresh/write (see the module doc above). Reentrant within one process —
 *  sequential prepares in the same launch (or test suite) just refresh the
 *  record. Throws OverlayBusyError when a foreign live launch holds it. */
export function acquireOverlayLease(overlay: string): void {
    // Cross-version guard first: pre-#1952 launches leave only the legacy
    // marker. A live foreign pid in it means an older bili owns the overlay —
    // refuse rather than clobber its generated files.
    const legacyHolder = livePidHoldsOverlay(overlay);
    if (legacyHolder !== undefined) throw new OverlayBusyError(overlay, legacyHolder);
    const dir = overlayLeaseDir(overlay);
    const ownerFile = overlayOwnerPath(overlay);
    const take = (): boolean => {
        const token = randomUUID();
        try {
            fs.mkdirSync(dir);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            return false;
        }
        try {
            writeOwner(ownerFile, token);
        } catch {
            // Crash window between mkdir and the owner write: the bare dir
            // stays — an incomplete record reads as busy (manual unlock).
        }
        activeOverlayLease = { dir, ownerFile, token };
        return true;
    };
    if (take()) return;
    const owner = readOwner(ownerFile);
    if (owner.pid === process.pid) {
        try {
            const token = randomUUID();
            writeOwner(ownerFile, token);
            activeOverlayLease = { dir, ownerFile, token };
        } catch {
            activeOverlayLease = undefined;
        }
        return;
    }
    if (owner.pid !== undefined && !holderPidAlive(owner.pid)) {
        // Stale lease from a crashed launch: reclaim once. The atomic mkdir in
        // take() stays the arbiter if another reclaim runs in parallel.
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
        if (take()) return;
    }
    throw new OverlayBusyError(overlay, owner.pid);
}

/** Release the lease taken by acquireOverlayLease (runLaunch's finally).
 *  Token-verified: a record rewritten out from under us (reclaimed) is left
 *  untouched. Idempotent. */
export function releaseOverlayLease(): void {
    const lease = activeOverlayLease;
    activeOverlayLease = undefined;
    if (lease === undefined) return;
    try {
        if (readOwner(lease.ownerFile).token !== lease.token) return;
        fs.rmSync(lease.dir, { recursive: true, force: true });
    } catch {}
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

/** True when a top-level home entry names a SQLite main database: a known db
 *  extension, or a live sidecar sibling (-wal/-shm/-journal) that only SQLite
 *  produces next to its main db. Sidecar-named entries never qualify. The
 *  suffix list must stay broader than ".db" — codex keeps its databases as
 *  *.sqlite, and missing one re-opens the per-file splice (#1917). */
export function isSqliteMain(name: string, siblings: ReadonlySet<string>): boolean {
    const lower = name.toLowerCase();
    if (lower.endsWith("-wal") || lower.endsWith("-shm") || lower.endsWith("-journal")) return false;
    if (lower.endsWith(".db") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) return true;
    return siblings.has(`${name}-wal`) || siblings.has(`${name}-shm`) || siblings.has(`${name}-journal`);
}

/** Overlay-local provenance of the private SQLite copies (#1919). Maps each
 *  base db name to the sha256 + size of every set member at the moment
 *  copySqliteSet copied it into the overlay, so mergeSqliteSet can tell "this
 *  side is bili's own unmodified generation from the previous launch" — the
 *  NORMAL steady state under copy-on-launch — from "this side advanced on its
 *  own" (a concurrent plain run), which is the only true divergence. Since
 *  #2195 this snapshot also decides the MERGE WINNER (not just whether the
 *  loser may be dropped silently): a WAL-only commit leaves the main db's
 *  bytes AND mtime untouched, so only provenance can tell the generations apart. */
export const SQLITE_ORIGIN_FILE = ".bili-sqlite-origin.json";
type SqliteOriginMap = Record<string, Record<string, { h: string; s: number }>>;

function readSqliteOrigin(overlay: string): SqliteOriginMap {
    try {
        const raw: unknown = JSON.parse(fs.readFileSync(path.join(overlay, SQLITE_ORIGIN_FILE), "utf8"));
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) return raw as SqliteOriginMap;
    } catch {}
    return {};
}

function writeSqliteOrigin(overlay: string, map: SqliteOriginMap): void {
    try {
        const dst = path.join(overlay, SQLITE_ORIGIN_FILE);
        const tmp = `${dst}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(map));
        fs.renameSync(tmp, dst);
    } catch {}
}

function sha256File(p: string): string | undefined {
    const hash = createHash("sha256");
    let fd: number | undefined;
    try {
        fd = fs.openSync(p, "r");
        const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
        for (;;) {
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) break;
            hash.update(n === buf.length ? buf : buf.subarray(0, n));
        }
        return hash.digest("hex");
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            } catch {}
        }
    }
}

/** Record what now sits in the overlay for this base (post-copy) so the next
 *  merge-back can recognize bili's own unmodified generations (#1919). Only a
 *  recorded MAIN makes the entry usable; sidecar entries are best-effort. */
function recordSqliteOrigin(overlay: string, base: string): void {
    const members: Record<string, { h: string; s: number }> = {};
    for (const m of sqliteSetMembers(base)) {
        let st: fs.Stats;
        try {
            st = fs.lstatSync(path.join(overlay, m));
        } catch {
            continue;
        }
        if (!st.isFile()) continue;
        const h = sha256File(path.join(overlay, m));
        if (h === undefined) continue;
        members[m] = { h, s: st.size };
    }
    if (members[base] === undefined) return;
    const map = readSqliteOrigin(overlay);
    map[base] = members;
    writeSqliteOrigin(overlay, map);
}

/** How one side's SQLite set compares to the origin snapshot bili recorded
 *  when it copied the set into the overlay (#1919/#2195):
 *   "unchanged" — every currently-present member still matches its recorded
 *     size+hash. A recorded sidecar may be ABSENT now: a checkpoint deletes an
 *     empty WAL without touching the main.
 *   "changed"   — a commit (or other advance) landed here: the main or a
 *     commit-bearing member differs from the record, or a commit-bearing
 *     member appeared that the copy never held. A zero-byte -wal is NOT one:
 *     merely OPENING a WAL-mode db creates an empty -wal plus a -shm (and
 *     reading rewrites the -shm), so neither alone proves a business commit.
 *   "unknown"   — no usable snapshot (first launch, upgrade mid-cycle, manual
 *     deletion): NOTHING can be claimed about this side's age; callers must
 *     fall back conservatively instead of assuming a winner.
 *  The same snapshot serves both sides because the copy is byte-exact. */
type SqliteSideState = "unchanged" | "changed" | "unknown";

function sqliteSideVsOrigin(overlay: string, dir: string, base: string): SqliteSideState {
    const rec = readSqliteOrigin(overlay)[base];
    if (rec === undefined || rec[base] === undefined) return "unknown";
    const matches = (m: string, st: fs.Stats): boolean => {
        const info = rec[m];
        if (info === undefined) return false;
        if (st.size !== info.s) return false;
        const h = sha256File(path.join(dir, m));
        return h !== undefined && h === info.h;
    };
    let mainSt: fs.Stats;
    try {
        mainSt = fs.lstatSync(path.join(dir, base));
    } catch {
        return "changed"; // the recorded main vanished: not the copied generation
    }
    if (!mainSt.isFile() || !matches(base, mainSt)) return "changed";
    for (const m of sqliteSetMembers(base)) {
        if (m === base || m === `${base}-shm`) continue;
        let st: fs.Stats;
        try {
            st = fs.lstatSync(path.join(dir, m));
        } catch {
            continue;
        }
        if (!st.isFile()) return "changed";
        if (rec[m] !== undefined) {
            if (!matches(m, st)) return "changed";
        } else if (!(m.endsWith("-wal") && st.size === 0)) {
            return "changed"; // commit-bearing member the copy never held
        }
    }
    return "unchanged";
}

/** Copy a real-home SQLite set into the overlay as PRIVATE regular files
 *  (#1917). A main db must never be file-linked across the two homes: SQLite
 *  names its -wal/-shm relative to the path it was opened through, so two
 *  paths over one inode grow independent WALs that do not coordinate —
 *  concurrent writers lose committed rows and crash recovery corrupts the db
 *  (sqlite.org/howtocorrupt.html#multiple_links_to_the_same_file). Copying the
 *  whole set keeps a crashed launch's WAL recoverable against its exact main
 *  db; the set merges back as a unit on exit (mergeSqliteSet). On success the
 *  copied bytes are recorded as the set's origin snapshot (#1919). Returns
 *  false when the base db could not be copied. */
function copySqliteSet(realHome: string, overlay: string, base: string): boolean {
    let ok = true;
    for (const m of sqliteSetMembers(base)) {
        let st: fs.Stats;
        try {
            st = fs.lstatSync(path.join(realHome, m));
        } catch {
            continue;
        }
        if (!st.isFile()) continue;
        try {
            fs.copyFileSync(path.join(realHome, m), path.join(overlay, m));
        } catch {
            ok = false;
        }
    }
    let mainInOverlay = false;
    try {
        mainInOverlay = fs.lstatSync(path.join(overlay, base)).isFile();
    } catch {}
    if (!mainInOverlay) ok = false;
    else recordSqliteOrigin(overlay, base);
    return ok;
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
 *  unit (#381). The authoritative generation is decided ONCE per set — never
 *  per member, because a WAL/journal is only valid against its exact main db:
 *  per-member adjudication could splice a newer main db with a newer WAL from
 *  the other side and corrupt the database. Winner selection (#2195): provenance
 *  against the copy-time origin snapshot first — a side still byte-identical to
 *  what bili copied cannot outrank a side that committed, because a commit may
 *  touch ONLY the WAL (the main keeps its old bytes AND old mtime) and a file
 *  copy can carry the source mtime forward; then the main db's mtime when both
 *  sides advanced independently or no usable snapshot exists. The winner's
 *  members become the real home's active set. When BOTH sides hold a main, the
 *  loser still byte-identical to the origin snapshot is bili's own unmodified
 *  generation, dropped silently; a loser that differs from it (or whose
 *  provenance is unknown) is a true divergence, preserved as
 *  `<name>.bili-conflict` with a loud warning (never overwritten). A
 *  set with no main db on either side (orphan sidecars) is stale residue and is
 *  preserved wholesale as conflicts, never moved in as an active db. If any
 *  rename fails (real db open/locked on Windows) the moved ones roll back and
 *  the set stays for the next launch. Pre-fix overlays file-linked the main db
 *  into the overlay (symlink, or write-through hardlink on Windows): such a
 *  shared link is dropped here — its per-path -wal/-shm sidecars cannot be
 *  replayed against a main the other path may have advanced, so they are
 *  quarantined as conflicts, never merged (#1917). */
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
    let oMain = statFile(overlay, base);
    const rMain = statFile(realHome, base);
    // Legacy shared-main migration (#1917), see doc above. The overlay entry
    // IS the real main (same inode / same target) — dropping the link loses
    // nothing; only the untrusted sidecars are quarantined below.
    let sharedLink: "symlink" | "hardlink" | undefined;
    try {
        const lst = fs.lstatSync(path.join(overlay, base));
        if (lst.isSymbolicLink()) {
            // Compare RESOLVED paths, not the raw link string: relative or
            // differently-spelled targets ("../real/state_5.sqlite") still name
            // the same file and must be migrated, not silently kept.
            try {
                if (fs.realpathSync(path.join(overlay, base)) === fs.realpathSync(path.join(realHome, base))) sharedLink = "symlink";
            } catch {}
        } else if (lst.isFile() && rMain !== undefined && isWriteThroughHardlink(path.join(overlay, base), path.join(realHome, base), lst)) {
            sharedLink = "hardlink";
        }
    } catch {}
    if (sharedLink !== undefined) {
        try {
            fs.unlinkSync(path.join(overlay, base));
        } catch {
            console.error(`bili: could not drop the ${sharedLink}-shared ${path.join(overlay, base)} (likely locked) — retry on the next launch.`);
            return false;
        }
        oMain = undefined;
        console.error(
            `bili: ${path.join(overlay, base)} was shared with ${realHome} via a ${sharedLink} (legacy layout, #1917) — dropped; ` +
                `its -wal/-shm sidecars left in the overlay are quarantined as .bili-conflict, not replayed onto the shared main.`,
        );
    }
    let winner: "overlay" | "real" | "orphan";
    if (oMain && rMain) {
        // #2195: provenance first, mtime second. A SQLite commit may touch ONLY
        // the WAL — the main db keeps its old bytes AND its old mtime — and a
        // file copy can carry the source mtime forward (measured on Windows),
        // so a main-mtime comparison alone selects the STALE generation exactly
        // when the copy preserved timestamps and the newer commit is WAL-only.
        // Against the copy-time origin snapshot the unmodified side is provably
        // the redundant one, whichever way the mtimes fall. Mtime stays in play
        // only when BOTH sides advanced independently (true #1917 divergence)
        // or no usable snapshot exists to prove anything (unknown → conservative).
        const oSide = sqliteSideVsOrigin(overlay, overlay, base);
        const rSide = sqliteSideVsOrigin(overlay, realHome, base);
        if (oSide === "changed" && rSide === "unchanged") winner = "overlay";
        else if (rSide === "changed" && oSide === "unchanged") winner = "real";
        else if (oSide === "unchanged" && rSide === "unchanged") winner = "real"; // byte-equivalent generations; fixed pick
        else winner = rMain.mtimeMs >= oMain.mtimeMs ? "real" : "overlay";
    } else if (oMain) winner = "overlay";
    else if (rMain) winner = "real";
    else winner = "orphan";
    // Both sides hold a main. Under copy-on-launch that is the NORMAL steady
    // state (#1919), not a divergence signal: every launch's copy phase leaves
    // a fresh overlay copy next to the previous launch's merged-back db, so
    // after the first launch both sides ALWAYS hold a main — even when nothing
    // ran concurrently. The loser still byte-identical to the origin snapshot
    // (sqliteSideVsOrigin === "unchanged") is bili's own unmodified generation,
    // redundant with the winner's — drop it silently. Only a loser that differs
    // from what bili copied (or whose provenance is unknown) is a true
    // divergence (concurrent plain run) and keeps the loud warning + conflict
    // preservation. Any failure of the stale check or of the silent drop falls
    // through to that conservative path: no data loss, at worst one extra
    // warning/conflict file.
    if (oMain !== undefined && rMain !== undefined) {
        const stale = sqliteSideVsOrigin(overlay, winner === "real" ? overlay : realHome, base) === "unchanged";
        let dropped = true;
        if (stale) {
            const loserDir = winner === "real" ? overlay : realHome;
            for (const m of members) {
                let st: fs.Stats | undefined;
                try {
                    st = fs.lstatSync(path.join(loserDir, m));
                } catch {}
                if (st === undefined || !st.isFile()) continue;
                try {
                    fs.unlinkSync(path.join(loserDir, m));
                } catch {
                    dropped = false;
                }
            }
        }
        if (!stale || !dropped) {
            console.error(
                `bili: both ${overlay} and ${realHome} held a distinct ${base} — kept the winning generation (${winner}), ` +
                    `the other side is preserved as .bili-conflict. Concurrent plain/bili runs diverge by design (#1917); ` +
                    `check the conflict file if you expect rows from both.` +
                    (stale && !dropped
                        ? " Removing the verified-stale copy only partially succeeded (locked members) — those are preserved as .bili-conflict too."
                        : ""),
            );
        }
    }
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

export function refreshOverlayHome(realHome: string, overlay: string, generatedFile: string | string[]): boolean {
    const generatedFiles = new Set(Array.isArray(generatedFile) ? generatedFile : [generatedFile]);
    const isGeneratedDraft = (name: string): boolean =>
        [...generatedFiles].some((g) => name.startsWith(`.${g}.`) && name.endsWith(".tmp"));
    try {
        fs.mkdirSync(overlay, { recursive: true });
    } catch {
        return false;
    }
    // #1952: exclusive ownership BEFORE any merge/write — a foreign live
    // launch holding this overlay gets a hard refusal (OverlayBusyError), not
    // the old warn-and-clobber. The marker below stays informational.
    acquireOverlayLease(overlay);
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
        // SQLite sets in the overlay root take this path WHOLESALE (#381/#1917),
        // whatever sidecars exist right now: a cleanly closed launch leaves a
        // lone main db, a crashed one leaves the full set, and neither may reach
        // the per-file merge loop below — that loop would splice a newer main db
        // with a newer WAL from the other side and corrupt the database.
        // Membership is by name (isSqliteMain), not by sidecar presence. Legacy
        // file-linked mains are migrated inside mergeSqliteSet (link dropped,
        // sidecars quarantined as conflicts).
        const overlayEntrySet = new Set(overlayEntries);
        const dbSets: string[] = [];
        for (const entry of overlayEntries) {
            if (generatedFiles.has(entry) || !isSqliteMain(entry, overlayEntrySet)) continue;
            let st: fs.Stats;
            try {
                st = fs.lstatSync(path.join(overlay, entry));
            } catch {
                continue;
            }
            if (!st.isFile() && !st.isSymbolicLink()) continue;
            dbSets.push(entry);
        }
        const skipEntries = new Set<string>();
        for (const base of dbSets) {
            for (const m of sqliteSetMembers(base)) skipEntries.add(m);
        }
        for (const entry of overlayEntries) {
            // SQLITE_ORIGIN_FILE is bili's own overlay-local metadata (#1919) —
            // never merge it back into the real home.
            if (generatedFiles.has(entry) || entry === SQLITE_ORIGIN_FILE) continue;
            const overlayPath = path.join(overlay, entry);
            if (isGeneratedDraft(entry) || entry === `${SQLITE_ORIGIN_FILE}.tmp`) {
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
        // A SUCCESSFUL merge can introduce a db the real home did not hold
        // when realEntries was snapshotted above (fresh home + db created by
        // this launch's client) — the copy phase below must re-import it or
        // the next launch's active home starts with no database (#1951).
        const mergedBases = new Set<string>();
        for (const base of dbSets) {
            if (mergeSqliteSet(overlay, realHome, base)) mergedBases.add(base);
            else {
                console.error(
                    `bili: could not merge the SQLite set ${base} / ${base}-wal / ${base}-shm into ${realHome} ` +
                        `(the real db is likely open/locked) — kept in the overlay, retry on the next launch.`,
                );
            }
        }
        // Real-home SQLite sets are COPIED into the overlay, never file-linked
        // (#1917, see copySqliteSet). Their sidecars travel with the base: an
        // individually linked/copied sidecar would share state across the two
        // paths again, so sidecars are skipped here entirely.
        // Regular files only: a DIRECTORY named like a db must be mirrored by
        // the ordinary link path below, not routed into copySqliteSet where it
        // would fail and land in linkFailures.
        const realDbBases = new Set<string>();
        for (const entry of realEntries) {
            if (generatedFiles.has(entry) || !isSqliteMain(entry, realEntries)) continue;
            let st: fs.Stats;
            try {
                st = fs.lstatSync(path.join(realHome, entry));
            } catch {
                continue;
            }
            if (!st.isFile()) continue;
            realDbBases.add(entry);
        }
        // Merged-in bases are sqlite mains by construction (dbSets came from
        // isSqliteMain) and a successful merge guarantees their main now sits
        // in the real home — they join the copy inventory even though they were
        // absent from the pre-merge realEntries snapshot (#1951).
        for (const base of mergedBases) realDbBases.add(base);
        const realDbMembers = new Set<string>();
        for (const base of realDbBases) {
            for (const m of sqliteSetMembers(base)) realDbMembers.add(m);
        }
        let accessible = 0;
        let total = 0;
        const linkFailures: string[] = [];
        const copyPhaseEntries = [...realEntries];
        for (const base of mergedBases) {
            if (!realEntries.has(base)) copyPhaseEntries.push(base);
        }
        for (const entry of copyPhaseEntries) {
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
            if (realDbBases.has(entry)) {
                if (copySqliteSet(realHome, overlay, entry)) accessible += 1;
                else linkFailures.push(entry);
                continue;
            }
            if (realDbMembers.has(entry)) continue;
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
export function piPluginInstalled(piHome: string): boolean {
    const root = selfPackageRoot();
    if (!root) return false;
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(piHome, "settings.json"), "utf8")) as { packages?: unknown };
        const list = Array.isArray(parsed.packages) ? parsed.packages.map(String) : [];
        return list.some((p) => isBiliPiEntry(p, root) && piEntryLoadable(p));
    } catch {
        return false;
    }
}

/** A settings packages entry only counts as installed when pi can actually
 *  load it: npm: entries are pi-managed, absolute entries must exist on disk.
 *  A dead path that merely LOOKS like ours (hand-edited settings, moved
 *  install, another machine's path) must not suppress the launcher's -e
 *  fallback — that leaves pi with no plugin at all: no /acp, no provider
 *  rewrites, and the traffic silently bypasses the proxy (#1318). Same
 *  discipline ompPluginLoadedFrom already applies to omp config entries. */
function piEntryLoadable(entry: string): boolean {
    return entry.startsWith("npm:") || fs.existsSync(entry);
}

function writeOverlayFileAtomic(overlay: string, fileName: string, contents: string, mode?: number): void {
    const draft = path.join(overlay, `.${fileName}.${process.pid}.tmp`);
    try {
        fs.writeFileSync(draft, contents, { mode });
        fs.renameSync(draft, path.join(overlay, fileName));
    } catch {
        try {
            fs.rmSync(draft, { force: true });
        } catch {}
    }
}

/**
 * Atomic text write via rename (draft + rename, never a torn file) — used for
 * the generated overlay files (e.g. dsh's rewritten settings.yaml) and the
 * dead-proxy-URL unpacker below.
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

/** dsh loopback exception (#535 phase 4): dsh's fetch stack bypasses proxy
 *  envs for loopback targets unconditionally, so ONLY loopback upstreams need
 *  the /bili/ URL rewrite. A persistent `<dshHome>-bili` overlay (every
 *  ~/.dsh sibling symlinked so credentials/profiles/sessions stay shared)
 *  holds a rewritten copy of settings.yaml; matching baseURL/baseUrl/base_url
 *  values are rewrapped as origin + "/bili/" + raw upstream. The real ~/.dsh
 *  is never touched. Returns the overlay dir (undefined when the settings
 *  file is unreadable or nothing is rewritable). */
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

interface GooseOverlay {
    root: string;
    realConfigDir: string;
    patchedFiles: Set<string>;
    snapshot: Map<string, string>;
}

/** #1049: synthetic GOOSE_PATH_ROOT for `bili goose`. The overlay's config/ is
 *  GENERATED every launch (fresh copy of the real config dir with the matched
 *  custom_providers base_urls re-pointed at the proxy); data/, state/, .agents/
 *  are SYMLINKS to the real dirs so sessions, auth and agents keep working. It
 *  deliberately does NOT reuse refreshOverlayHome: that loop unlinks any
 *  symlink whose target is not an entry of the single real home it was given,
 *  and goose's home is scattered across XDG dirs unless GOOSE_PATH_ROOT is set.
 *  Returns undefined when nothing can be prepared (caller warns and launches
 *  without compression of the custom-provider legs). A non-symlink where a
 *  symlink belongs means possible user data — abort rather than delete. */
export function prepareGooseHome(env: NodeJS.ProcessEnv, origin: string, rewrites: HttpRewrite[]): GooseOverlay | undefined {
    if (rewrites.length === 0) return undefined;
    const dirs = resolveGooseDirs(env);
    const root = nonEmpty(env.GOOSE_PATH_ROOT) ? `${env.GOOSE_PATH_ROOT!}-bili` : `${dirs.configDir}-bili`;
    try {
        fs.mkdirSync(root, { recursive: true });
    } catch {
        return undefined;
    }
    for (const [name, target] of [["data", dirs.dataDir], ["state", dirs.stateDir], [".agents", dirs.agentsDir]] as const) {
        fs.mkdirSync(target, { recursive: true });
        const link = path.join(root, name);
        try {
            const st = fs.lstatSync(link);
            if (st.isSymbolicLink()) {
                if (fs.readlinkSync(link) !== target) {
                    fs.rmSync(link);
                    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
                }
            } else {
                return undefined;
            }
        } catch {
            try {
                fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
            } catch {
                return undefined;
            }
        }
    }
    const cfg = path.join(root, "config");
    try {
        fs.rmSync(cfg, { recursive: true, force: true });
    } catch {}
    try {
        fs.mkdirSync(cfg, { recursive: true });
    } catch {
        return undefined;
    }
    let realEntries: string[] = [];
    try {
        realEntries = fs.readdirSync(dirs.configDir);
    } catch {}
    for (const name of realEntries) {
        try {
            fs.cpSync(path.join(dirs.configDir, name), path.join(cfg, name), { recursive: true });
        } catch {}
    }
    const wrapSet = new Set(rewrites.map((r) => r.realUpstream));
    const patchedFiles = new Set<string>();
    let cpEntries: string[] = [];
    try {
        cpEntries = fs.readdirSync(path.join(cfg, "custom_providers"));
    } catch {}
    for (const name of cpEntries) {
        if (!name.endsWith(".toml")) continue;
        const file = path.join(cfg, "custom_providers", name);
        let txt: string;
        try {
            txt = fs.readFileSync(file, "utf8");
        } catch {
            continue;
        }
        const eol = txt.includes("\r\n") ? "\r\n" : "\n";
        let changed = false;
        const lines = txt.split(/\r?\n/).map((line) => {
            const m = /^(\s*base_url\s*=\s*)(["'])([^"']+)\2(\s*(?:#.*)?)$/.exec(line);
            if (!m) return line;
            const rawUrl = m[3];
            if (!/^https?:\/\//i.test(rawUrl)) return line;
            const real = unwrapUpstream(rawUrl);
            if (!wrapSet.has(real)) return line;
            changed = true;
            return `${m[1]}${m[2]}${wrapUpstream(origin, real)}${m[2]}${m[4] ?? ""}`;
        });
        if (changed) {
            try {
                fs.writeFileSync(file, lines.join(eol));
                patchedFiles.add(path.join("custom_providers", name));
            } catch {}
        }
    }
    const snapshot = new Map<string, string>();
    const walk = (dir: string): void => {
        let entries: string[] = [];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            const p = path.join(dir, name);
            const st = fs.lstatSync(p);
            if (st.isDirectory()) {
                walk(p);
            } else if (st.isFile() && !patchedFiles.has(path.relative(cfg, p))) {
                try {
                    snapshot.set(path.relative(cfg, p), fs.readFileSync(p, "utf8"));
                } catch {}
            }
        }
    };
    walk(cfg);
    return { root, realConfigDir: dirs.configDir, patchedFiles, snapshot };
}

/** #1049: merge-back for the goose overlay — user edits made inside the
 *  generated config tree (new provider files, active_provider switches, ...)
 *  land in the REAL config dir so the next plain `goose` run sees them. Files
 *  bili patched itself never round-trip (their wrapped URLs would leak into
 *  the real config); deletions are not propagated. */
export function finalizeGooseHome(overlay: GooseOverlay): void {
    const cfg = path.join(overlay.root, "config");
    const walk = (dir: string): void => {
        let entries: string[] = [];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            return;
        }
        for (const name of entries) {
            const p = path.join(dir, name);
            let st;
            try {
                st = fs.lstatSync(p);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                walk(p);
                continue;
            }
            if (!st.isFile()) continue;
            const rel = path.relative(cfg, p);
            if (overlay.patchedFiles.has(rel)) continue;
            let cur: string;
            try {
                cur = fs.readFileSync(p, "utf8");
            } catch {
                continue;
            }
            if (overlay.snapshot.get(rel) === cur) continue;
            const dest = path.join(overlay.realConfigDir, rel);
            try {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, cur);
            } catch {}
        }
    };
    walk(cfg);
}

/** Strip any existing [mcp_servers.bili] block from codex config text so the
 *  launcher can append a fresh one without duplicating the table. Table
 *  boundaries follow plugin-install.ts `codexRemove`. */
function stripCodexBiliBlock(text: string): string {
    const m = /^[ \t]*\[mcp_servers\.bili\][ \t]*$/m.exec(text);
    if (m === null) return text;
    const start = m.index;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const after = text.slice(start);
    const firstNewline = after.indexOf("\n");
    const nextTable = firstNewline < 0 ? -1 : after.slice(firstNewline + 1).search(/^[ \t]*\[/m);
    const end = nextTable >= 0 ? start + firstNewline + 1 + nextTable : text.length;
    return (text.slice(0, lineStart).replace(/\n+$/, "\n") + text.slice(end)).replace(/^\n+/, "");
}

/** Real config.toml text with the launcher's [mcp_servers.bili] merged in: a
 *  pre-existing block (e.g. from `bili plugin install codex`) is replaced by
 *  the current launch's command/args/env — adding the per-spawn
 *  BILI_CONVERSATION_ID the persistent install lacks. Values are
 *  JSON.stringify'd exactly like plugin-install.ts `codexBlock`, which yields
 *  valid TOML basic strings (both escape backslashes as \\). */
function mergeCodexBiliBlock(text: string, origin: string, conversationId: string): string {
    const script = selfDistFile("mcp.js");
    const block =
        "\n[mcp_servers.bili]\n" +
        `command = ${JSON.stringify(process.execPath)}\n` +
        `args = [${JSON.stringify(script)}]\n` +
        `env = { BILI_MCP_PROXY = ${JSON.stringify(origin)}, BILI_CONVERSATION_ID = ${JSON.stringify(conversationId)} }\n`;
    const base = stripCodexBiliBlock(text);
    return base + (base.endsWith("\n") || base.length === 0 ? "" : "\n") + block;
}

/** #1802: keys whose values must reflect THIS launch's routing when codex
 *  reads $CODEX_HOME/.env — its load_dotenv() calls set_var() UNCONDITIONALLY
 *  for every non-CODEX_-prefixed key on top of the launcher's spawn env, so a
 *  user .env pointing at e.g. a socks5h proxy silently re-routes the client
 *  off bili after spawn (and codex's custom-CA rustls HTTP stack cannot speak
 *  SOCKS at all). Matched case-insensitively; a replaced line keeps the user's
 *  original key spelling. */
const CODEX_DOTENV_MANAGED = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "BILLION_CONTEXT_PROXY"] as const;

/** Pure renderer for the generated overlay .env (#1802): every user line is
 *  preserved verbatim (comments, order, quoting) except managed-key lines,
 *  which are rewritten to this launch's values; absent managed keys are
 *  appended. Values stay unquoted while they match dotenv-safe characters,
 *  otherwise JSON.stringify'd into a quoted basic string. */
export function renderCodexDotEnv(userText: string | undefined, values: { origin: string; caPath: string }): string {
    const formatted = (value: string): string => (/^[A-Za-z0-9:._/,\-]+$/.test(value) ? value : JSON.stringify(value));
    const managed: Record<string, string> = {
        HTTP_PROXY: values.origin,
        HTTPS_PROXY: values.origin,
        ALL_PROXY: values.origin,
        NO_PROXY: "localhost,127.0.0.1,::1",
        SSL_CERT_FILE: values.caPath.split("\\").join("/"),
        BILLION_CONTEXT_PROXY: values.origin,
    };
    const lines = (userText ?? "").split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of lines) {
        const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/.exec(line);
        if (m !== null && m[1] !== undefined && (CODEX_DOTENV_MANAGED as readonly string[]).includes(m[1].toUpperCase())) {
            out.push(`${m[1]}=${formatted(managed[m[1].toUpperCase()])}`);
            seen.add(m[1].toUpperCase());
            continue;
        }
        out.push(line);
    }
    for (const key of CODEX_DOTENV_MANAGED) {
        if (!seen.has(key)) out.push(`${key}=${formatted(managed[key])}`);
    }
    return `${out.join("\n")}\n`;
}

/** #1965: exit-time merge-back for the persistent codex overlay — the safe
 *  counterpart to refreshOverlayHome's startup fold. Call it after the client
 *  (and its db-holding processes) has exited, while this launch's pid marker
 *  still names us as the overlay's holder, so no other bili run is mid-write
 *  on the same overlay.
 *
 *  What moves back into the real home:
 *   - SQLite sets (main + WAL/SHM/journal) merge as ONE generation via
 *     mergeSqliteSet: winner by provenance against the copy-time origin
 *     snapshot (#2195; #1919), main-db mtime only when both sides advanced
 *     or no snapshot exists; the loser is dropped silently when still
 *     byte-identical to the snapshot, otherwise preserved as .bili-conflict
 *     (#1917). Any rename failure
 *     (real db open/locked — e.g. a concurrent native codex on Windows) rolls
 *     the set back and it stays in the overlay for the next launch's startup
 *     merge;
 *   - private regular files/dirs created under the overlay root during the
 *     run merge back under the same mtime-adjudicated, conflict-preserving
 *     rules as the startup path (mergeOverlayEntry);
 *   - entries SHARED with the real home (symlink/junction/write-through
 *     hardlink) are skipped — their writes already landed in the real home;
 *   - this launch's generated files (.env, MCP config.toml), bili's own
 *     metadata (.bili-sqlite-origin.json, .bili-launch.pid) and their drafts
 *     never leave the overlay.
 *
 *  Guarantee boundary: normal client exit only (a killed/crashed launcher
 *  skips finally; its data stays recoverable in the overlay and is folded by
 *  the next launch's refreshOverlayHome). A concurrent NATIVE codex writing
 *  the real home during finalize is handled per set: Windows' open-file lock
 *  makes the rename fail → rollback + retry-next-launch; on POSIX the rename
 *  succeeds under open handles and the #1917 divergence contract applies
 *  (both generations survive, loser as .bili-conflict).
 *
 *  Returns true when nothing remains pending in the overlay. */
export function finalizeCodexHome(realHome: string, overlay: string, generatedFiles?: readonly string[]): boolean {
    const generatedSet = new Set<string>(generatedFiles ?? []);
    const isExcluded = (name: string): boolean =>
        name === SQLITE_ORIGIN_FILE ||
        name === `${SQLITE_ORIGIN_FILE}.tmp` ||
        name === path.basename(overlayLockPath(overlay)) ||
        name === path.basename(overlayLeaseDir(overlay)) || // release-failure residue must never merge into the real home
        generatedSet.has(name) ||
        [...generatedSet].some((g) => name.startsWith(`.${g}.`) && name.endsWith(".tmp"));
    let overlayEntries: string[];
    try {
        overlayEntries = fs.readdirSync(overlay);
    } catch {
        return true;
    }
    const entrySet = new Set(overlayEntries);
    const dbBases: string[] = [];
    for (const entry of overlayEntries) {
        if (isExcluded(entry) || !isSqliteMain(entry, entrySet)) continue;
        let st: fs.Stats;
        try {
            st = fs.lstatSync(path.join(overlay, entry));
        } catch {
            continue;
        }
        if (!st.isFile() && !st.isSymbolicLink()) continue;
        dbBases.push(entry);
    }
    const skipMembers = new Set<string>();
    for (const base of dbBases) {
        for (const m of sqliteSetMembers(base)) skipMembers.add(m);
    }
    let ok = true;
    for (const entry of overlayEntries) {
        if (isExcluded(entry) || skipMembers.has(entry)) continue;
        const p = path.join(overlay, entry);
        let st: fs.Stats;
        try {
            st = fs.lstatSync(p);
        } catch {
            continue;
        }
        if (st.isSymbolicLink()) continue;
        if (!st.isDirectory() && !st.isFile()) continue;
        if (st.isFile() && isWriteThroughHardlink(p, path.join(realHome, entry), st)) continue;
        if (mergeOverlayEntry(p, path.join(realHome, entry), generatedSet)) {
            try {
                fs.rmSync(p, { recursive: true, force: true });
            } catch {}
            // Cold-start thread records keep absolute rollout paths in the overlay.
            if (st.isDirectory() && !linkOverlayEntry(realHome, overlay, entry)) {
                ok = false;
                console.error(`bili: could not relink ${p} after exit-time write-back — data is in ${realHome}, but recorded overlay paths may not resolve.`);
            }
        } else {
            ok = false;
            console.error(`bili: could not merge ${p} into ${realHome} at exit — kept in the overlay, resolve manually.`);
        }
    }
    for (const base of dbBases) {
        if (!mergeSqliteSet(overlay, realHome, base)) {
            ok = false;
            console.error(
                `bili: could not merge the SQLite set ${base} / ${base}-wal / ${base}-shm into ${realHome} at exit ` +
                    `(the real db is likely open/locked) — kept in the overlay, retry on the next launch.`,
            );
        }
    }
    return ok;
}

/** #681/#1802: persistent <CODEX_HOME>-bili overlay. Carries (a) the bili MCP
 *  server in a merged config.toml when a per-spawn conversationId is given
 *  (inline `-c` args cannot survive cmd.exe on Windows), and (b) whenever the
 *  launcher injected proxy routing (manageRouting), a generated .env pinning
 *  exactly that routing, so the user's own $CODEX_HOME/.env can no longer
 *  override it after spawn (#1802). Every other real-home entry is shared
 *  (auth.json, sessions, model settings survive) EXCEPT SQLite databases
 *  (*.db / *.sqlite / *.sqlite3 at the home root), which get a private
 *  per-launch copy merged back as a unit on exit — file-linking them across
 *  the two homes lets two paths grow independent WALs over one inode and lose
 *  committed writes (#1917). Generated files are rewritten each launch and
 *  never linked back nor merged into the real home.
 *  The overlay's .env and config.toml are refresh-protected on EVERY launch,
 *  so a stale generated copy can never merge back into the real home even
 *  when a later launch does not generate it (#1802 review; config.toml
 *  symmetric to .env, #1965). On normal exit the run's data is written back
 *  into the real home by finalizeCodexHome (#1965); generated files stay
 *  overlay-local throughout.
 *  Returns the overlay dir to point CODEX_HOME at, or undefined when it cannot
 *  be built (caller degrades: wire-injected compression still works, native
 *  MCP tools / the .env protection do not). Throws OverlayBusyError BEFORE any
 *  write when another live launch owns the overlay (#1952) — callers abort. */
export function prepareCodexHome(opts: {
    codexHome: string;
    origin: string;
    caPath: string;
    conversationId?: string;
    manageRouting: boolean;
}): string | undefined {
    const { codexHome, origin, caPath, conversationId, manageRouting } = opts;
    let userEnvText: string | undefined;
    let manageDotEnv = manageRouting;
    if (manageRouting) {
        try {
            userEnvText = fs.readFileSync(path.join(codexHome, ".env"), "utf8");
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
                // Present but unreadable: a substitute .env would drop the
                // user's own variables (often secrets) from the effective env
                // — keep the legacy shared link and warn instead.
                console.error(`bili: ${path.join(codexHome, ".env")} is not readable — keeping the shared .env, so the injected proxy/CA may be overridden by it.`);
                manageDotEnv = false;
            }
        }
    }
    // ".env" and "config.toml" are ALWAYS refresh-protected, even on launches
    // that do not generate them: a previous routed/MCP launch may have left an
    // owned copy in the overlay, and letting refresh treat it as user data
    // would merge it back into the real home (#1802 review; config.toml
    // symmetric to .env, #1965).
    const generatedFiles: string[] = [".env", "config.toml"];
    const overlay = `${codexHome}-bili`;
    if (!refreshOverlayHome(codexHome, overlay, generatedFiles)) return undefined;
    if (manageDotEnv) {
        try {
            const st = fs.lstatSync(path.join(overlay, ".env"));
            // Pre-#1802 overlays share .env with the real home (symlink, or a
            // write-through hardlink where symlinks are unavailable): unlink
            // before writing so the generated file stops touching the real one.
            if (st.isSymbolicLink() || isWriteThroughHardlink(path.join(overlay, ".env"), path.join(codexHome, ".env"), st)) {
                fs.unlinkSync(path.join(overlay, ".env"));
            }
        } catch {}
        writeOverlayFileAtomic(overlay, ".env", renderCodexDotEnv(userEnvText, { origin, caPath }), 0o600);
    } else {
        // Non-generating launch: .env must end up SHARED with the real home
        // (or absent) — drop any owned residue and re-link from the real one.
        const envPath = path.join(overlay, ".env");
        const realEnvPath = path.join(codexHome, ".env");
        let needsLink = false;
        try {
            const st = fs.lstatSync(envPath);
            const shared = st.isSymbolicLink()
                ? fs.readlinkSync(envPath) === realEnvPath
                : isWriteThroughHardlink(envPath, realEnvPath, st);
            if (!shared) {
                fs.unlinkSync(envPath);
                needsLink = true;
            }
        } catch {
            needsLink = true;
        }
        if (needsLink) {
            try {
                fs.lstatSync(realEnvPath);
                linkOverlayEntry(codexHome, overlay, ".env");
            } catch {}
        }
    }
    if (conversationId !== undefined) {
        let txt = "";
        try {
            txt = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
        } catch {}
        writeOverlayFileAtomic(overlay, "config.toml", mergeCodexBiliBlock(txt, origin, conversationId));
    } else {
        // Non-MCP launch: config.toml must end up SHARED with the real home
        // (or absent) — drop any owned residue from a previous MCP launch and
        // re-link from the real one (mirror of the .env handling above).
        const cfgPath = path.join(overlay, "config.toml");
        const realCfgPath = path.join(codexHome, "config.toml");
        let needsLink = false;
        try {
            const st = fs.lstatSync(cfgPath);
            const shared = st.isSymbolicLink()
                ? fs.readlinkSync(cfgPath) === realCfgPath
                : isWriteThroughHardlink(cfgPath, realCfgPath, st);
            if (!shared) {
                fs.unlinkSync(cfgPath);
                needsLink = true;
            }
        } catch {
            needsLink = true;
        }
        if (needsLink) {
            try {
                fs.lstatSync(realCfgPath);
                linkOverlayEntry(codexHome, overlay, "config.toml");
            } catch {}
        }
    }
    return overlay;
}

/** #941: the launcher's --patch overlay now carries the FULL native plugin
 *  (tools + session-bound /acp + fetch intercept), not just the /acp panel —
 *  plus the compaction-basic auto:false override so dsh's native
 *  auto-compaction stands down for the bili proxy (a patch replaces the
 *  target row's whole config, and dsh-base ships compaction-basic with no
 *  config, so {auto:false} is complete). Lives in the persistent
 *  `<dshHome>-bili` dir, INDEPENDENT of the settings.yaml rewrite — the
 *  plugin is injected even when the user has no custom providers (pure
 *  built-in deepseek route). Returns the patch file path (undefined when it
 *  could not be written — dsh then just boots without the plugin). */
const DSH_BARE_ENTRY = "billion-context";

/** #1590: shim package making the bare `billion-context` root resolvable from the two
 *  anchors dsh uses at runtime, without touching dsh's own tree:
 *  - the ESM host import is anchored at the active PROFILE dir, whose walk-up
 *    reaches <DSH_HOME>/node_modules (every profile lives under DSH_HOME);
 *  - the client scanner's CJS resolve anchors inside dsh's install tree and
 *    only reaches a global npm prefix through NODE_PATH, which the launcher
 *    seeds with the same dir. The shim is a minimal package.json carrying the
 *  `dsh.client` declaration the scanner reads plus two SYMLINKS into bili's
 *  live dist — an auto-update that moves dist self-heals on the next launch.
 *  Returns false when nothing was written (existing shims stay untouched). */
export function writeDshClientShimFiles(shimDir: string, hostBundle: string, clientBundle: string, version: string): boolean {
    try {
        if (!fs.existsSync(hostBundle) || !fs.existsSync(clientBundle)) return false;
        fs.rmSync(shimDir, { recursive: true, force: true });
        fs.mkdirSync(shimDir, { recursive: true });
        fs.writeFileSync(
            path.join(shimDir, "package.json"),
            `${JSON.stringify({
                name: "billion-context",
                version,
                type: "module",
                exports: { ".": "./index.js", "./dsh": "./index.js", "./dsh/package.json": "./package.json", "./client": "./bundle.js" },
                dsh: { client: { platform: "web" } },
            })}\n`,
        );
        fs.symlinkSync(hostBundle, path.join(shimDir, "index.js"));
        fs.symlinkSync(clientBundle, path.join(shimDir, "bundle.js"));
        return true;
    } catch {
        return false;
    }
}

/** #1590: place the shim under a DSH_HOME variant (base home and/or the
 *  launcher's overlay copy — overlay/profiles is a symlink back to the base
 *  profiles, so both walk-up interpretations are covered). No-op when bili's
 *  own dist bundles are missing (e.g. tests running before a build). */
export function writeDshClientShim(dshHome: string): boolean {
    const hostBundle = selfDistFile("agent/dsh-native.js");
    const clientBundle = selfDistFile("agent/dsh-native-client.js");
    let version = "0.0.0";
    try {
        version = JSON.parse(fs.readFileSync(path.join(selfPackageRoot(), "package.json"), "utf8")).version ?? version;
    } catch {}
    return writeDshClientShimFiles(path.join(dshHome, "node_modules", "billion-context"), hostBundle, clientBundle, version);
}

/** #1590: entry name for the launcher's --patch overlay. The BARE package
 *  specifier "billion-context" (package root — never a subpath: dsh's client
 *  scanner drops subpath entry names in exactPackageSpecifier) lets dsh load
 *  the host half AND its client scanner attach the browser half (the "bili设置"
 *  settings entry) — but only when the package root import lands on the dsh
 *  host module, i.e. when the shim above (whose "." export points at
 *  dsh-native) sits in this DSH_HOME's walk-up chain. Probed by resolving the
 *  root specifier and checking the resolved file IS the host half: a stale or
 *  foreign install (root "." pointing elsewhere, e.g. the CLI entry) or a
 *  broken shim (dangling symlink) degrades to the legacy file URL (host half
 *  only) instead of failing dsh boot or importing the wrong module. */
export function dshPluginEntry(dshHome: string): string {
    try {
        const entry = createRequire(path.join(dshHome, "probe.cjs")).resolve(DSH_BARE_ENTRY);
        const real = fs.realpathSync(entry);
        if (!fs.existsSync(real) || !real.endsWith(path.join("agent", "dsh-native.js"))) throw new Error("root import does not resolve to the dsh host half");
        return DSH_BARE_ENTRY;
    } catch {}
    return pathToFileURL(selfDistFile("agent/dsh-native.js")).href;
}

export function writeDshAcpPatch(dshHome: string, entryName?: string): string | undefined {
    const pluginUrl = entryName ?? pathToFileURL(selfDistFile("agent/dsh-native.js")).href;
    const dir = `${dshHome}-bili`;
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {
        return undefined;
    }
    writeOverlayFileAtomic(
        dir,
        ".bili-acp.patch.yml",
        `- insert:\n    - id: bili-native\n      name: ${pluginUrl}\n- id: compaction-basic\n  config:\n    auto: false\n# #2605: keep in sync with dsh.bundle.patch.yml — a patch replaces the row's whole config, so every default code is restated\n- id: llm-deepseek\n  config:\n    retryPolicy:\n      mode: normal\n      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]\n- id: llm-deepseek-account\n  config:\n    retryPolicy:\n      mode: normal\n      retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, MALFORMED_RESPONSE]\n`,
    );
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

export function parseOpencodeMajor(output: string): number | undefined {
    const m = /(\d+)\s*\./.exec(output);
    return m ? parseInt(m[1], 10) : undefined;
}

const ocMajorCache = new Map<string, number>();

/** Major version of an OpenCode CLI binary via `--version` (cached per path).
 *  Probe failure defaults to 1 — the legacy file-path plugin injection that
 *  OpenCode 1.x understands — so a broken probe can never break a launch. */
export function opencodeMajorVersion(command: string): number {
    const hit = ocMajorCache.get(command);
    if (hit !== undefined) return hit;
    let major = 1;
    try {
        const out = execFileSync(command, ["--version"], { timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        const parsed = parseOpencodeMajor(out);
        if (parsed !== undefined) major = parsed;
    } catch {}
    ocMajorCache.set(command, major);
    return major;
}

/** #1867: true when the user already pinned codex's run mode themselves — an
 *  explicit `--no-daemon` (embedded) or `--remote [url]` (remote app server).
 *  In either case bili must not add its own `--no-daemon`: the first would be a
 *  duplicate, and codex hard-errors on --no-daemon combined with --remote. */
export function codexRunModePinned(args: readonly string[]): boolean {
    return args.some((a) => a === "--no-daemon" || a === "--remote" || a.startsWith("--remote="));
}

const codexNoDaemonCache = new Map<string, boolean>();

/** #1867: whether a Codex CLI binary accepts `--no-daemon`, probed from its
 *  `--help` output (cached per resolved command). The probe spawns the binary
 *  exactly the way runClient will (planClientSpawn) with a short timeout; any
 *  failure defaults to false — injecting a flag the binary does not know would
 *  break the launch, while skipping it only restores the pre-probe behavior.
 *  Mirrors the opencodeMajorVersion() precedent. spawnSync (not execFileSync):
 *  its options accept windowsVerbatimArguments, which the #679 cmd.exe wrap needs. */
export function codexSupportsNoDaemon(
    command: string,
    prefixArgs: readonly string[],
    platform: NodeJS.Platform = process.platform,
): boolean {
    const key = JSON.stringify([command, ...prefixArgs]);
    const hit = codexNoDaemonCache.get(key);
    if (hit !== undefined) return hit;
    let supported = false;
    try {
        const plan = planClientSpawn(command, [...prefixArgs, "--help"], process.env, platform);
        const res = spawnSync(plan.command, plan.args, {
            timeout: 5000,
            stdio: ["ignore", "pipe", "ignore"],
            windowsVerbatimArguments: plan.windowsVerbatimArguments,
            windowsHide: true,
        });
        // line-anchored exact-flag match: clap lists each option on its own
        // indented line; \b would fail anyway since '-' is not a word char
        if (res.status === 0 && !res.error) supported = /(?:^|\n)[ \t]*--no-daemon[ \t]*(?:\r?\n|$)/.test(res.stdout.toString("utf8"));
    } catch {}
    codexNoDaemonCache.set(key, supported);
    return supported;
}

/**
 * opencode counterpart of preparePiHttpRewrite: write a full copy of the user's
 * (JSONC-tolerant, merged) config with the discovered providers' baseURL
 * rewritten (HTTP → /bili/ wrap, wrapped-HTTPS → raw https for cert MITM) into
 * a temp dir, and point OPENCODE_CONFIG at it. The real config files are never
 * touched. Relative local plugin specs (./x, ../x) are re-anchored to absolute
 * paths before the copy is written — opencode resolves them against the
 * declaring file's dir, which the clone no longer is (#826). With pluginDirMode
 * (OpenCode 2.x), the plugin rides as a temp directory whose index.js
 * re-exports pluginPath — 2.x rejects bare file paths in `plugin`. Also strips
 * opencode-acp entries (#920; see below), recording the first stripped spec in
 * env["BILI_OPENCODE_ACP_SPEC"]. Returns the temp config FILE path (undefined
 * when there is nothing to do).
 */
export function prepareOpencodeHttpRewrite(
    userRoot: Record<string, unknown> | undefined,
    origin: string,
    httpRewrites: HttpRewrite[],
    httpsRewrites: HttpRewrite[],
    pluginPath?: string,
    pluginDirMode?: boolean,
    env: NodeJS.ProcessEnv = process.env,
): string | undefined {
    if (httpRewrites.length === 0 && httpsRewrites.length === 0 && !pluginPath) return undefined;
    // deep-clone: the rewrite below mutates provider entries, and the caller's
    // root (a merged read of the user's config) must stay pristine
    const root: Record<string, unknown> = structuredClone(userRoot ?? {});
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-opencode-"));
    let pluginEntry = pluginPath;
    if (pluginPath && pluginDirMode) {
        const wrapDir = path.join(tmp, "plugin");
        fs.mkdirSync(wrapDir);
        fs.writeFileSync(path.join(wrapDir, "index.js"), `export { default } from ${JSON.stringify(pluginPath)};\n`);
        pluginEntry = wrapDir;
    }
    if (pluginEntry) {
        // copy, don't filter: non-string entries (v1 tuple form [spec, options])
        // are valid Specs and must survive the clone
        const plugins = Array.isArray(root.plugin) ? [...(root.plugin as unknown[])] : [];
        if (!plugins.includes(pluginEntry)) plugins.push(pluginEntry);
        root.plugin = plugins;
    }
    // ACP owns compression in launcher mode: disable the host's native
    // auto-compaction so it cannot destroy ACP-tagged context. The key is
    // unknown (and ignored) on OpenCode 1.x, so this is safe on both
    // generations; user-set fields (keep/buffer) survive via the merge.
    const existingCompaction = root.compaction;
    root.compaction = {
        ...(existingCompaction && typeof existingCompaction === "object" && !Array.isArray(existingCompaction) ? existingCompaction as Record<string, unknown> : {}),
        auto: false,
    };
    // #920: strip opencode-acp entries from the clone — the host must not load
    // it armed (its config hook globally self-disables on /bili/ baseURLs and
    // eagerly adopts every session). The thin plugin imports the same package
    // as a library instead and gates its hooks on legacy sessions. The first
    // stripped spec is handed to the child via env so the bridge imports the
    // exact copy the host would have loaded (state-format compatibility).
    let strippedAcpSpec: string | undefined;
    for (const key of ["plugin", "plugins"] as const) {
        if (!Array.isArray(root[key])) continue;
        const baseDir = opencodePluginBaseDir(env, key);
        root[key] = (root[key] as unknown[])
            .filter((entry) => {
                const spec = opencodeAcpPluginSpec(entry);
                if (spec === undefined) return true;
                strippedAcpSpec ??= spec;
                return false;
            })
            .map((entry) => absolutizePluginEntry(baseDir, entry));
    }
    if (strippedAcpSpec) env["BILI_OPENCODE_ACP_SPEC"] = strippedAcpSpec;
    const tmpFile = path.join(tmp, "opencode.json");
    fs.writeFileSync(tmpFile, JSON.stringify(root));
    return tmpFile;
}

/** Returns the plugin spec when `entry` references the opencode-acp package
 *  (npm spec, local path, or github spec), else undefined. Matches the package
 *  name exactly — `my-opencode-acp-fork` does not match. */
function opencodeAcpPluginSpec(entry: unknown): string | undefined {
    let spec: unknown;
    if (typeof entry === "string") spec = entry;
    else if (Array.isArray(entry) && typeof entry[0] === "string") spec = entry[0];
    else if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) spec = (entry as Record<string, unknown>).package;
    if (typeof spec !== "string" || spec.length === 0) return undefined;
    const base = path.basename(spec);
    return base === "opencode-acp" || base.startsWith("opencode-acp@") ? spec : undefined;
}

function isRelativeLocalPluginSpec(spec: unknown): spec is string {
    return typeof spec === "string" && spec.startsWith(".") && !path.isAbsolute(spec);
}

function absolutizePluginEntry(baseDir: string, entry: unknown): unknown {
    if (typeof entry === "string") {
        return isRelativeLocalPluginSpec(entry) ? path.resolve(baseDir, entry) : entry;
    }
    if (Array.isArray(entry) && entry.length > 0 && typeof entry[0] === "string") {
        // v1 tuple form [spec, options?] — only the spec is location-bound
        if (!isRelativeLocalPluginSpec(entry[0])) return entry;
        return [path.resolve(baseDir, entry[0]), ...entry.slice(1)];
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry) && "package" in entry) {
        const obj = entry as Record<string, unknown>;
        if (isRelativeLocalPluginSpec(obj.package)) return { ...obj, package: path.resolve(baseDir, obj.package as string) };
    }
    return entry;
}

export function opencodeEffectiveCwd(clientArgs: readonly string[]): string {
    for (let i = 0; i < clientArgs.length; i++) {
        const arg = clientArgs[i];
        if (arg === "--dir") return path.resolve(clientArgs[i + 1] ?? ".");
        if (arg.startsWith("--dir=")) return path.resolve(arg.slice("--dir=".length));
    }
    return process.cwd();
}

function isBiliRouted(baseURL: string, httpsDomains: ReadonlySet<string>): boolean {
    if (unwrapUpstream(baseURL) !== baseURL) return true;
    let url: URL;
    try {
        url = new URL(baseURL);
    } catch {
        return false;
    }
    return url.protocol === "https:" && httpsDomains.has(url.hostname.toLowerCase());
}

// #843: project-layer opencode config outranks the launcher's $OPENCODE_CONFIG
// rewrite delivery, so providers defined there bypass the proxy silently.
export function opencodeProjectBypassWarnings(
    layer: OpencodeProjectLayer,
    routes: DiscoveredRoutes,
): string[] {
    const warnings: string[] = [];
    const httpsDomains = new Set(routes.httpsDomains.map((d) => d.toLowerCase()));
    const rewrittenKeys = new Set([...routes.httpRewrites, ...routes.httpsRewrites].map((r) => r.key));
    for (const [name, view] of Object.entries(layer.providers)) {
        if (!view.baseURL || isBiliRouted(view.baseURL, httpsDomains)) continue;
        if (rewrittenKeys.has(name)) {
            warnings.push(
                `bili: ${view.file} redefines provider "${name}" in opencode's project layer, which outranks the launcher's rewritten $OPENCODE_CONFIG — "${name}" traffic will NOT go through the proxy (no compression). Move the provider to your global opencode config to restore compression.`,
            );
        } else {
            warnings.push(
                `bili: provider "${name}" is defined only in opencode's project layer (${view.file}) — the launcher never sees it, so no rewrite was applied and "${name}" traffic will NOT go through the proxy (no compression). Move it to your global opencode config to enable compression.`,
            );
        }
    }
    return warnings;
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
    /** Responder's OS pid from /__bili/health. #1753: the spawn-wait
     *  fallback uses this to verify the healthy responder on the preferred
     *  port is the child WE spawned (and not a foreign proxy squatting it). */
    pid?: number;
    /** #1330: watchdog state from /__bili/health. Absent on pre-#1330 builds —
     *  unverifiable lifecycle, which the #1335 attach gate treats as unarmed.
     *  #1753 (shutdown side): `watchers` is the live watcher-pid set — the
     *  launcher consults it at client exit so a spawned-but-SHARED instance
     *  is spared for its remaining owners instead of group-killed. */
    watchdog?: { armed: boolean; watchers?: number[] };
}

async function fetchHealthInfoDefault(origin: string): Promise<HealthInfo | undefined> {
    try {
        const res = await fetch(healthUrl(origin), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return undefined;
        const data = (await res.json()) as { ok?: boolean; instanceId?: string; pid?: unknown; watchdog?: unknown };
        const info: HealthInfo = { ok: Boolean(data.ok), instanceId: typeof data.instanceId === "string" ? data.instanceId : undefined };
        if (typeof data.pid === "number") info.pid = data.pid;
        if (data.watchdog && typeof data.watchdog === "object" && typeof (data.watchdog as { armed?: unknown }).armed === "boolean") {
            const wd = data.watchdog as { armed: boolean; watchers?: unknown };
            const watchers = Array.isArray(wd.watchers) ? wd.watchers.filter((w): w is number => typeof w === "number") : undefined;
            info.watchdog = { armed: wd.armed, watchers };
        }
        return info;
    } catch {
        return undefined;
    }
}

/** Outcome of a session-watcher registration attempt (#1190). */
export type WatcherRegistration = "ok" | "refused" | "failed";

/** #1190: an ATTACHED shared proxy belongs to whoever SPAWNED it — its
 *  parent-gone watchdog tracks THAT owner's pid, so without registration the
 *  first owner's exit kills every attached session (#7/#1183). Registering our
 *  own owner makes the proxy die only after the LAST owner exits. Never throws:
 *  a failed registration degrades to the pre-fix single-owner behavior.
 *  #1322: returns the outcome so callers can surface a refusal — attaching to
 *  a daemon proxy means the "dies with the session" contract is void. */
export async function registerWatcherDefault(origin: string, pid: number): Promise<WatcherRegistration> {
    try {
        const res = await fetch(`${origin}/__bili/watcher`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pid }),
            signal: AbortSignal.timeout(2_000),
        });
        // 409 = daemon proxy (watchdog unarmed) — nothing to register there;
        // silence stays at this layer, the handle carries the flag instead.
        if (!res.ok) {
            if (res.status === 409) return "refused";
            console.error(`bili: watcher registration returned HTTP ${res.status} — the shared proxy may exit when its first owner does`);
            return "failed";
        }
        return "ok";
    } catch (err) {
        console.error(`bili: watcher registration failed — the shared proxy may exit when its first owner does (${err instanceof Error ? err.message : String(err)})`);
        return "failed";
    }
}

/** #707: the marker's owner must still be plausibly mid-bring-up — alive AND
 *  young. A crashed starter leaves a dead-owner marker; a hung one ages out. */
function isStartingMarkerActive(marker: ProxyStartingMarker, nowMs: number): boolean {
    return isPidAlive(marker.pid) && nowMs - marker.startedAt < STARTING_MARKER_TTL_MS;
}

/** #1225: reuse requires identical CODE, not just identical config shape —
 *  same version number with different dist contents (local rebuild, npm link,
 *  unpublished branch) must not be served by the stale instance. codeFingerprint
 *  is the attaching side's hash of the script it WOULD spawn; undefined means
 *  it cannot be verified, which is treated as incompatible (never attach). */
/** #1623: undefined = compatible; otherwise the FIRST failing check as a
 *  stable reason code, so attach diagnostics can say WHICH field rejected a
 *  live candidate instead of dropping it silently. */
function instanceCompatible(inst: ProxyInstanceFile, opts: LaunchOptions, codeFingerprint?: string): string | undefined {
    if (inst.codeFingerprint === undefined || inst.codeFingerprint !== codeFingerprint) return "code-fingerprint-mismatch";
    if (opts.lane !== undefined && inst.lane !== undefined && inst.lane !== opts.lane) return "lane-mismatch";
    if (inst.host !== opts.host || inst.passthrough !== opts.passthrough) return "host-or-passthrough-mismatch";
    const wantDomains = opts.mitmDomains ?? [];
    if (inst.mitmDomains.length !== wantDomains.length || inst.mitmDomains.some((d, i) => d !== wantDomains[i])) return "mitm-domains-mismatch";
    const wantWindows = opts.modelWindows ?? {};
    const keys = Object.keys(wantWindows);
    if (Object.keys(inst.modelWindows).length !== keys.length) return "model-windows-mismatch";
    if (!keys.every((k) => inst.modelWindows[k] === wantWindows[k])) return "model-windows-mismatch";
    const wantMax = opts.modelMaxOutputs ?? {};
    const maxKeys = Object.keys(wantMax);
    if (Object.keys(inst.modelMaxOutputs ?? {}).length !== maxKeys.length) return "model-max-outputs-mismatch";
    return maxKeys.every((k) => (inst.modelMaxOutputs ?? {})[k] === wantMax[k]) ? undefined : "model-max-outputs-mismatch";
}

/** #1232: every healthy live instance — not just the last writer of the
 *  single proxy-origin file. With per-lane proxies (#1225/#1231) that file
 *  points at whichever instance registered LAST, which may be another
 *  client's, so the attach decision unions the file view with the
 *  multi-instance registry (every instance self-registers on startup) and
 *  health-probes each candidate in parallel. */
async function probeLiveInstances(
    readInstance: () => ProxyInstanceFile | { origin: string } | undefined,
    fetchHealthInfo: (origin: string) => Promise<HealthInfo | undefined>,
    diag?: (msg: string) => void,
): Promise<Array<{ inst: ProxyInstanceFile; health: HealthInfo }>> {
    const seen = new Map<string, ProxyInstanceFile>();
    const inst = readInstance();
    if (isProxyInstanceFile(inst)) seen.set(inst.instanceId || inst.origin, inst);
    for (const live of discoverLiveInstances()) seen.set(live.instanceId || live.origin, live);
    const checked = await Promise.all(
        [...seen.values()].map(async (c): Promise<{ inst: ProxyInstanceFile; health: HealthInfo } | undefined> => {
            if (!isPidAlive(c.pid)) { diag?.(`native-attach: drop ${c.origin} (pid ${c.pid}): owner process gone`); return undefined; }
            const health = await fetchHealthInfo(c.origin);
            if (!health || !health.ok) { diag?.(`native-attach: drop ${c.origin} (pid ${c.pid}): health probe failed`); return undefined; }
            if (health.instanceId !== undefined && health.instanceId !== c.instanceId) { diag?.(`native-attach: drop ${c.origin} (pid ${c.pid}): instance id mismatch (${c.instanceId} vs ${health.instanceId})`); return undefined; }
            return { inst: c, health };
        }),
    );
    return checked.filter((c): c is { inst: ProxyInstanceFile; health: HealthInfo } => c !== undefined);
}

/** #1335: the attach gate — a listener may be attached to only when its
 *  health reports an ARMED session-lifecycle watchdog, or the user explicitly
 *  opted in via native.attachExternal / BILI_NATIVE_ATTACH_EXTERNAL. A missing
 *  watchdog field (pre-#1330 build) is unverifiable and refused by default:
 *  those are exactly the stale manually-started daemons behind #1322, and
 *  riding them pins every session to possibly-old code that outlives it. */
function attachGateAllows(health: HealthInfo, attachExternal: boolean): boolean {
    if (attachExternal) return true;
    return health.watchdog?.armed === true;
}

/** #1660: the user-sovereignty zone marker — neither a declared lane nor a
 *  launcher launch token exists only for a manually started `bili start`
 *  daemon. By definition the user maintains it (they typed the command; it
 *  has no session lifecycle BY DESIGN, not by drift), so lanes may attach to
 *  it despite the unarmed watchdog — code-fingerprint and config-shape
 *  compatibility still apply, and an older build stays incompatible. */
function isUserZoneInstance(inst: ProxyInstanceFile): boolean {
    return inst.lane === undefined && inst.launchToken === undefined;
}

function gateRefusalMessage(inst: ProxyInstanceFile, health: HealthInfo): string {
    const reason = health.watchdog && health.watchdog.armed === false
        ? "it reports NO session-lifecycle watchdog (started without BILI_PARENT_PID, e.g. manual `bili start`)"
        : "it does not report watchdog state (older bili build) — its lifecycle is unverifiable";
    return `bili: refusing to attach to ${inst.origin} (pid ${inst.pid}) — ${reason}. It would outlive this session and ignore config edits until killed (#1322/#1335). Starting a session-owned proxy instead; set native.attachExternal=true or BILI_NATIVE_ATTACH_EXTERNAL=1 to attach anyway.`;
}

/** #1232: choose the attach target among healthy candidates. Must be
 *  compatible (code fingerprint + config shape + lane rules) and, under
 *  strictPort, bound to our exact port. Same declared lane beats wildcard —
 *  concurrent same-lane launches must converge on the lane's own instance,
 *  not a general-purpose daemon either could use — newest within class. */
function pickAttachable(
    candidates: Array<{ inst: ProxyInstanceFile; health: HealthInfo }>,
    opts: LaunchOptions,
    codeFingerprint: string | undefined,
    attachExternal: boolean,
    refusedLog: Set<string>,
    diag?: (msg: string) => void,
): ProxyInstanceFile | undefined {
    let best: ProxyInstanceFile | undefined;
    let bestClass = 2;
    let bestStartedAt = Number.NEGATIVE_INFINITY;
    for (const c of candidates) {
        const incompatible = instanceCompatible(c.inst, opts, codeFingerprint);
        if (incompatible !== undefined) { diag?.(`native-attach: skip ${c.inst.origin} (pid ${c.inst.pid}): incompatible (${incompatible})`); continue; }
        if (opts.strictPort && c.inst.port !== opts.port) { diag?.(`native-attach: skip ${c.inst.origin} (pid ${c.inst.pid}): port mismatch`); continue; }
        // #1335: lifecycle gate — an unarmed (or unverifiable) listener is
        // never an attach target by default; log the refusal once per origin.
        // #1660: a user-zone instance (manual `bili start`) is exempt — the
        // missing watchdog is the user's deliberate posture, not drift.
        if (!attachGateAllows(c.health, attachExternal) && !isUserZoneInstance(c.inst)) {
            if (!refusedLog.has(c.inst.origin)) {
                refusedLog.add(c.inst.origin);
                console.error(gateRefusalMessage(c.inst, c.health));
                diag?.(gateRefusalMessage(c.inst, c.health));
            }
            continue;
        }
        const cls = opts.lane !== undefined && c.inst.lane === opts.lane ? 0 : 1;
        if (cls < bestClass || (cls === bestClass && c.inst.startedAt > bestStartedAt)) {
            best = c.inst;
            bestClass = cls;
            bestStartedAt = c.inst.startedAt;
        }
    }
    return best;
}

/** #707: wait for another launcher's in-flight bring-up to produce a live
 *  instance. Bounded by SPAWN_BUDGET_MS — the starter's own live-child wait
 *  has the same envelope (#2187); bailing earlier would double-spawn against
 *  a still-starting child; breaks early when the starting marker disappears
 *  (starter gave up / crashed). The final probe closes the
 *  deadline-boundary sliver: the starter's own poll window ends ~now, and its
 *  success path clears the marker — indistinguishable from a failure bail
 *  without one last look. */
async function waitForStarterInstance(
    readInstance: () => ProxyInstanceFile | { origin: string } | undefined,
    fetchHealthInfo: (origin: string) => Promise<HealthInfo | undefined>,
    now: () => number,
    sleepImpl: (ms: number) => Promise<void>,
    opts: LaunchOptions,
    codeFingerprint: string | undefined,
    attachExternal: boolean,
    refusedLog: Set<string>,
    diag?: (msg: string) => void,
): Promise<ProxyInstanceFile | undefined> {
    const deadline = now() + SPAWN_BUDGET_MS;
    const probe = async (): Promise<ProxyInstanceFile | undefined> =>
        pickAttachable(await probeLiveInstances(readInstance, fetchHealthInfo, diag), opts, codeFingerprint, attachExternal, refusedLog, diag);
    let inst: ProxyInstanceFile | undefined;
    while (now() < deadline) {
        await sleepImpl(HEALTH_POLL_INTERVAL_MS);
        inst = await probe();
        if (inst) break;
        const still = readStartingMarker();
        if (!still || !isStartingMarkerActive(still, now())) break;
    }
    return inst ?? (await probe());
}

/** #1623: the probe-only half of ensureProxyRunning's attach decision — a
 *  live, compatible, gate-passing instance WITHOUT spawning, waiting for
 *  starters, or registering a watcher. For zcode exit-handoff and watchdog
 *  drift-repair, where bringing up a NEW proxy would be wrong. */
export async function findLiveAttachableInstance(
    opts: LaunchOptions,
    deps: LauncherDeps = {},
): Promise<ProxyInstanceFile | undefined> {
    const fetchHealthInfo = deps.fetchHealthInfo ?? fetchHealthInfoDefault;
    const readInstance = deps.readInstanceFile ?? readProxyInstanceFile;
    const attachExternal = (deps.resolveAttachExternal ?? resolveNativeAttachExternal)();
    const probed = await probeLiveInstances(readInstance, fetchHealthInfo, deps.attachDiag);
    return pickAttachable(probed, opts, entryScriptFingerprint(deps.scriptPath ?? process.argv[1]), attachExternal, new Set(), deps.attachDiag);
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

function pickEphemeralPort(host = LAUNCHER_DEFAULT_HOST): Promise<number> {
    return new Promise((resolve, reject) => {
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
}

const INHERITED_PROXY_VARS = [
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "no_proxy",
    "NO_PROXY",
];

export function stripInheritedProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const cleaned: NodeJS.ProcessEnv = { ...env };
    for (const key of INHERITED_PROXY_VARS) delete cleaned[key];
    return cleaned;
}

/** #1012: capture the user's proxy vars BEFORE stripping, so the launcher can
 *  forward them to the proxy child under dedicated BILI_INHERITED_* names.
 *  The child itself runs with a clean env (e1c6c92: shell proxies must not
 *  hijack model egress), but its AUXILIARY egress (MITM blind tunnels for
 *  client-side MCP/web traffic) needs the user's proxy to reach hosts the
 *  client could reach before #890 stripped its env. Uppercase wins over
 *  lowercase, matching config.ts's own-env precedence. */
export function captureInheritedProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const captured: NodeJS.ProcessEnv = {};
    const pairs: Array<[string, string | undefined, string | undefined]> = [
        ["BILI_INHERITED_HTTP_PROXY", env.HTTP_PROXY, env.http_proxy],
        ["BILI_INHERITED_HTTPS_PROXY", env.HTTPS_PROXY, env.https_proxy],
        ["BILI_INHERITED_ALL_PROXY", env.ALL_PROXY, env.all_proxy],
        ["BILI_INHERITED_NO_PROXY", env.NO_PROXY, env.no_proxy],
    ];
    for (const [name, upper, lower] of pairs) {
        const value = (upper ?? lower ?? "").trim();
        if (value) captured[name] = value;
    }
    return captured;
}

function proxyStartArgs(opts: LaunchOptions): string[] {
    const args = ["start", "--host", opts.host, "--port", String(opts.port)];
    if (opts.passthrough) args.push("--passthrough");
    if (opts.debug) args.push("--debug");
    return args;
}

/** #1887: ask a candidate Windows `node.exe` which real Node executable it runs.
 *  A plain node prints its own execPath; a re-exec wrapper (mise/asdf/fnm-style
 *  native shim) prints the real node behind it. Runs with the caller's env/cwd
 *  so the wrapper's version selection matches what the actual spawn would get.
 *  Any failure (timeout, non-node, empty output) yields undefined so the caller
 *  falls back to the candidate unchanged — never worse than today. */
export function probeNodeWrapperTarget(candidate: string, env: NodeJS.ProcessEnv): string | undefined {
    try {
        const out = execFileSync(candidate, ["-p", "process.execPath"], {
            windowsHide: true,
            timeout: 5000,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });
        const p = out.trim();
        return p.length > 0 ? p : undefined;
    } catch {
        return undefined;
    }
}

/** #819: resolve the executable that runs the proxy entry script. In a plain
 *  Node CLI, process.execPath is correct; inside a host process (the opencode
 *  or pi native binary) it is the HOST executable — spawning it with a .js
 *  argv passes the script to the wrong program. A live Node always wins, then
 *  an explicit BILLION_CONTEXT_NODE override, then a PATH search, then #1429:
 *  well-known install locations a GUI/Electron host's minimal PATH (launchd on
 *  macOS, the Windows GUI session) omits, then — as a last resort under an
 *  Electron host — the host's own binary run as Node via ELECTRON_RUN_AS_NODE=1
 *  (the runAsNode fuse, on by default in standard builds; ensureProxyRunning
 *  forces that var into the child env). */
export function resolveNodeRuntime(
    execPath: string = process.execPath,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    existsImpl: (p: string) => boolean = fs.existsSync,
    electronVersion: string | undefined = typeof process.versions.electron === "string" ? process.versions.electron : undefined,
    probeWrapper: (candidate: string, env: NodeJS.ProcessEnv) => string | undefined = probeNodeWrapperTarget,
): string {
    const base = path.basename(execPath).toLowerCase();
    if (base === "node" || base === "node.exe") return execPath;
    const override = typeof env.BILLION_CONTEXT_NODE === "string" ? env.BILLION_CONTEXT_NODE.trim() : "";
    if (override.length > 0 && existsImpl(override)) return override;
    // #1887: a PATH-resolved `node.exe` may be a re-exec wrapper (mise/asdf/fnm
    // native shim) that spawns the real Node as a CHILD — detached+windowsHide
    // hide only the direct child, so the wrapper's child keeps a visible console
    // for the proxy's whole life. Follow such a wrapper to the real node it runs
    // (one hop), so we spawn a directly-controllable executable. Live-node and
    // explicit-override paths above are deliberately NOT probed: a running node
    // is already real, and an explicit user choice is honored verbatim.
    const resolveDiscovered = (candidate: string): string => {
        if (platform !== "win32") return candidate;
        const target = probeWrapper(candidate, env);
        if (target && target.trim().length > 0) {
            const resolved = target.trim();
            if (existsImpl(resolved) && resolved.toLowerCase() !== candidate.toLowerCase()) {
                teeLog("info", `bili: ${candidate} is a Windows node wrapper resolving to ${resolved} — spawning the real Node directly (#1887)`);
                return resolved;
            }
        }
        return candidate;
    };
    // join with the SIMULATED platform's separators: a posix-style PATH on
    // win32 (and vice versa) must not be normalized through the host's
    // path.join, or the candidates no longer match what existsImpl expects.
    const sep = platform === "win32" ? ";" : ":";
    const names = platform === "win32" ? ["node.exe"] : ["node"];
    // #1429: after PATH, probe install locations a GUI/Electron host's minimal
    // PATH (launchd on macOS / the Windows GUI session) omits. A real node
    // found here still wins over the Electron-binary-as-node fallback below.
    const home = platform === "win32" ? env.USERPROFILE ?? "" : env.HOME ?? "";
    const voltaHome = platform === "win32"
        ? env.VOLTA_HOME ?? (home ? home + "/Tools/volta" : "")
        : home ? home + "/.volta" : "";
    const extraDirs = platform === "win32"
        ? [
            "C:/Program Files/nodejs",
            env.LOCALAPPDATA ? env.LOCALAPPDATA + "/Programs/nodejs" : "",
            voltaHome ? voltaHome + "/bin" : "",
          ]
        : [
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/opt/local/bin",
            voltaHome ? voltaHome + "/bin" : "",
            home ? home + "/.local/bin" : "",
          ];
    for (const dir of [...(env.PATH ?? "").split(sep), ...extraDirs]) {
        if (!dir) continue;
        for (const name of names) {
            // separator-preserving concatenation: never normalize — win32
            // accepts forward slashes, and normalizing through path.join
            // would rewrite a posix-style entry on a win32 host (or the
            // reverse), missing the file existsImpl would find.
            const candidate = dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + "/" + name;
            if (existsImpl(candidate)) return resolveDiscovered(candidate);
        }
    }
    // #1429: last resort inside an Electron host — its own binary runs as plain
    // Node when ELECTRON_RUN_AS_NODE=1 is honored. Only reached when NO real
    // node exists anywhere above; ensureProxyRunning forces that var so the
    // child actually runs Node instead of relaunching the desktop app.
    if (electronVersion && electronVersion.length > 0) return execPath;
    throw new Error("bili: cannot find a Node runtime to spawn the proxy (this process is not Node) — set BILLION_CONTEXT_NODE");
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
    const registerWatcher = deps.registerWatcher ?? registerWatcherDefault;
    // #1335: attach-gate escape hatch, resolved once per bring-up (env > file >
    // false). One knob for every lane — explicit user-directed attaches (kimi/dsh
    // BILLION_CONTEXT_ATTACH / preset BILLION_CONTEXT_PROXY) never pass through
    // this discovery path at all, so they are exempt by construction.
    const attachExternal = (deps.resolveAttachExternal ?? resolveNativeAttachExternal)();
    // Refusal log dedup: pickAttachable runs again on every starter-poll tick,
    // so each refused origin is announced exactly once per bring-up.
    const refusedLog = new Set<string>();
    const attachDiag = deps.attachDiag ?? ((msg: string) => teeLog("info", msg));
    // Same expression as the spawn path's BILI_PARENT_PID: one owner-pid
    // semantic for spawned AND attached proxies (#1190).
    const watchPid = opts.parentPid ?? process.pid;
    // #1190: every ATTACH registers our owner pid with the shared proxy's
    // watchdog so its exit cannot kill the sessions still riding on it
    // (#7/#1183). Awaited before returning: a spawner that dies right after a
    // second session attaches must not beat the registration to the grace
    // window.
    const attachTo = async (inst: ProxyInstanceFile): Promise<ProxyHandle> => {
        console.error(`bili: attaching to running proxy at ${inst.origin} (pid ${inst.pid})`);
        const reg = await registerWatcher(inst.origin, watchPid);
        // #1322: a refusal means the shared proxy has NO session-lifecycle
        // watchdog (started without BILI_PARENT_PID, e.g. manually on a stable
        // port) — it will outlive every session; host-native bootstraps must
        // say so instead of silently serving a voided lifecycle contract.
        const handle: ProxyHandle = { origin: inst.origin, port: inst.port, attached: true };
        if (reg === "refused") handle.refusedWatcher = true;
        return handle;
    };
    const script = deps.scriptPath ?? process.argv[1];
    const codeFingerprint = entryScriptFingerprint(script);

    // #394/#417: a healthy proxy with a compatible config is SHARED, not
    // doubled — two concurrent launches of the same client would otherwise
    // spawn two writers over one sessions dir. #1225 tightens "compatible":
    // same code AND same declared lane, not just same config shape. #1232:
    // candidates come from every live registry entry, not only the last
    // writer of the single proxy-origin file (that pointer can belong to
    // another client's per-lane proxy).
    const probed = await probeLiveInstances(readInstance, fetchHealthInfo, attachDiag);
    const existing = pickAttachable(probed, opts, codeFingerprint, attachExternal, refusedLog, attachDiag);
    if (existing) {
        // strictPort (#964) is enforced inside pickAttachable: the client
        // dials a STATIC url — attaching to a healthy proxy on a DIFFERENT
        // port would strand every request.
        return attachTo(existing);
    }
    if (!attachExternal && opts.strictPort) {
        // #1335: the only compatible listener is an unarmed one squatting OUR
        // pinned port — self-managed fallback is impossible here (we cannot
        // bind that port either). Fail fast with an actionable error instead
        // of burning SPAWN_WAIT_MS into a confusing EADDRINUSE.
        const squatter = probed.find((c) => c.inst.port === opts.port && instanceCompatible(c.inst, opts, codeFingerprint) === undefined);
        if (squatter) {
            throw new Error(
                `bili: port ${opts.port} is held by a lifecycle-less bili proxy at ${squatter.inst.origin} (pid ${squatter.inst.pid}) — ` +
                    `the #1335 attach gate refuses it by default and this launch pins the port, so no session-owned proxy can bind it either. ` +
                    `Kill that process (kill ${squatter.inst.pid}) or set native.attachExternal=true / BILI_NATIVE_ATTACH_EXTERNAL=1 to attach to it anyway.`,
            );
        }
    }

    // #707: cross-process startup window — another launcher may be mid-bring-up
    // right now (its child hasn't bound yet, so no instance record exists and
    // the attach above saw nothing). Wait for ITS instance instead of spawning
    // a second writer over the same sessions dir. In-process dedup is separate
    // (singleFlight, #706); this is the cross-process half.
    const waitForOtherStarter = async (): Promise<ProxyHandle | undefined> => {
        console.error("bili: another bili launch is bringing up a proxy — waiting for it instead of spawning a second");
        const waited = await waitForStarterInstance(readInstance, fetchHealthInfo, now, sleepImpl, opts, codeFingerprint, attachExternal, refusedLog, attachDiag);
        if (waited) {
            return attachTo(waited);
        }
        // starter failed/timed out (or incompatible config) — caller falls
        // through and spawns itself, as before
        return undefined;
    };
    // #1225: an in-flight starter of a DIFFERENT declared lane can never
    // produce an instance we may attach to — waiting would only stall this
    // launch behind its SPAWN_BUDGET_MS window. Undeclared lanes wildcard.
    const starterLaneMatches = (m: ProxyStartingMarker): boolean =>
        opts.lane === undefined || m.lane === undefined || m.lane === opts.lane;
    const marker = readStartingMarker();
    if (marker) {
        if (!isStartingMarkerActive(marker, now())) {
            removeStartingMarker();
        } else if (starterLaneMatches(marker)) {
            const attached = await waitForOtherStarter();
            if (attached) return attached;
        }
    }

    // #407: no probe-release-rebind. The child binds the preferred port
    // itself and retries on EADDRINUSE, reporting the real origin through
    // the instance file via this launchToken.
    const launchToken = randomUUID();
    // #1660: a lane'd launch with no explicit port binds the SELF-MANAGED
    // ZONE — the lane's sticky port (a past ladder drift it still points at)
    // else the zone base — instead of an OS-assigned ephemeral. An undeclared
    // lane (manual `bili start`, the user zone on 8787) keeps the ephemeral
    // default. The child's EADDRINUSE +1 ladder covers the pick/spawn race
    // AND a squatted preferred port (zero-config resolution: the lane lands
    // on base+1 and records it sticky; #1660).
    const zoneLane = opts.lane !== undefined && opts.port <= 0 ? opts.lane : undefined;
    const preferredPort = deps?.zonePreferredPort ?? lanePreferredPort;
    const port = opts.port > 0
        ? opts.port
        : zoneLane !== undefined
          ? preferredPort(zoneLane)
          : await pickEphemeralPort(opts.host);
    const settleZonePort = (settled: number): void => {
        if (zoneLane !== undefined) (deps?.writeZonePort ?? writeZonePort)(zoneLane, settled);
    };
    if (!script) throw new Error("bili: cannot resolve launcher script path");
    const logPath = path.join(os.tmpdir(), `bili-proxy-${port}.log`);
    const logFd = fs.openSync(logPath, "a");
    // #707: publish the starting marker BEFORE spawning so concurrent launches
    // wait for this bring-up instead of double-spawning. The O_EXCL claim is
    // the cross-process arbiter: the read above is only a fast path, so a
    // loser of the claim must re-check and wait instead of spawning blindly.
    // Cleared on every terminal path below; a hard crash leaves a stale marker
    // that the dead-owner/TTL check treats as inert.
    const claimMarker = (): boolean =>
        claimStartingMarker({ token: launchToken, pid: process.pid, host: opts.host, port, startedAt: now(), lane: opts.lane });
    let claimed = claimMarker();
    if (!claimed) {
        const holder = readStartingMarker();
        if (holder && isStartingMarkerActive(holder, now())) {
            if (starterLaneMatches(holder)) {
                // Lost the read→claim race to a live starter — honor its bring-up.
                const attached = await waitForOtherStarter();
                if (attached) return attached;
                claimed = claimMarker();
            }
            // #1225: live but a DIFFERENT lane — spawn without coordinating,
            // and leave its marker ALONE: removing it would break THAT
            // starter's coordination with its own same-lane launches.
        } else {
            // Stale or unreadable (crash mid-write): safe to remove — while any
            // marker file exists, O_EXCL bars a newer claimant, so we cannot
            // clobber a live coordinator. Retry once to take the slot.
            removeStartingMarker();
            claimed = claimMarker();
        }
        // Still unclaimed (unwritable state dir, or lost the retry race):
        // degrade to pre-#707 behavior — spawn without coordinating.
    }
    try {
        let child: SpawnChild;
        try {
            child = spawnImpl(
                deps.nodeRuntime ?? resolveNodeRuntime(),
                [script, ...proxyStartArgs({ ...opts, port })],
                {
                    detached: true,
                    windowsHide: true,
                    stdio: ["ignore", logFd, logFd],
                    env: {
                        ...stripInheritedProxy(process.env),
                        ...captureInheritedProxyEnv(process.env),
                        // #1429: inside an Electron host the resolved runtime may be this
                        // same binary run as Node — force it so the child runs Node instead
                        // of relaunching the desktop app. Harmless to a real node (ignored).
                        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
                        BILI_LAUNCH_TOKEN: launchToken,
                        BILI_PARENT_PID: String(opts.parentPid ?? process.pid),
                        ...(opts.lane ? { BILI_LAUNCHER_LANE: opts.lane } : {}),
                        ...(opts.mitmDomains && opts.mitmDomains.length
                            ? { BILI_MITM_DOMAINS: opts.mitmDomains.join(",") }
                            : {}),
                        ...(opts.modelWindows && Object.keys(opts.modelWindows).length > 0
                            ? { BILI_LAUNCHER_MODEL_WINDOWS: JSON.stringify(opts.modelWindows) }
                            : {}),
                        ...(opts.modelMaxOutputs && Object.keys(opts.modelMaxOutputs).length > 0
                            ? { BILI_LAUNCHER_MODEL_MAX_OUTPUTS: JSON.stringify(opts.modelMaxOutputs) }
                            : {}),
                        ...(opts.strictPort ? { BILI_STRICT_PORT: "1" } : {}),
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

        // #401/#480: fail fast when OUR spawned child dies before becoming
        // healthy — otherwise a startup crash (bad config, missing upstream, …)
        // burns the whole spawn wait budget before erroring.
        let childExit: { code: number | null; signal: string | null } | undefined;
        // #809/D: an async spawn failure (EACCES/ENOENT on the resolved runtime)
        // emits 'error', not 'exit'. Unhandled, it becomes an uncaughtException
        // that kills the host process; capture it so we fail fast with the cause.
        let childError: unknown;
        // #1753: announce a healthy-but-foreign responder on the preferred port
        // at most once — silence would hide exactly the misroute this fix closes.
        let squatterAnnounced = false;
        child.on?.("exit", (...rest: unknown[]) => {
            childExit = {
                code: typeof rest[0] === "number" ? rest[0] : null,
                signal: typeof rest[1] === "string" ? rest[1] : null,
            };
        });
        child.on?.("error", (...rest: unknown[]) => {
            childError = rest[0];
        });

        const deadline = now() + SPAWN_BUDGET_MS;
        // #2187: announce the phase boundary once — a live child past the
        // initial window is still being waited for, and the log is the only
        // place to see that the budget was extended instead of failing.
        let slowStartNoticed = false;
        while (now() < deadline) {
            if (childExit || childError !== undefined) break;
            if (!slowStartNoticed && now() >= deadline - SLOW_START_GRACE_MS) {
                slowStartNoticed = true;
                console.error(
                    `bili: spawned proxy not healthy after ${SPAWN_WAIT_MS}ms — child pid ${child.pid ?? "?"} is still starting up; extending wait to ${SPAWN_BUDGET_MS}ms total (log: ${logPath})`,
                );
            }
            await sleepImpl(HEALTH_POLL_INTERVAL_MS);
            const inst = readInstance();
            if (isProxyInstanceFile(inst) && inst.launchToken === launchToken) {
                if (await probeHealth(inst.origin, fetchImpl)) {
                    // #1660: settle the lane's sticky record on the port the
                    // child actually bound (preferred or laddered) so every
                    // later launch of this lane tries it first.
                    settleZonePort(inst.port);
                    return { origin: inst.origin, port: inst.port, child, logPath };
                }
                continue;
            }
            // Fallback for a child that cannot write the instance file (broken
            // state dir) or an old pre-handshake binary: only trust the preferred
            // origin when NO record vouches for it — a LIVE record's owner owns
            // the discovery surface and our child is retry-binding elsewhere.
            // A stale record (dead pid / legacy plain) cannot vouch for anything.
            // #1753: "healthy on the preferred port" alone is NOT proof the
            // responder is our child — a foreign proxy can be squatting exactly
            // that port (which is WHY our child laddered away). Verify the
            // responder's pid matches the spawned child before exporting its
            // origin to the client; otherwise keep waiting for the launchToken
            // handshake instead of pinning the client to an instance the attach
            // gate (#1225) itself would have rejected.
            const stale = !isProxyInstanceFile(inst) || !isPidAlive(inst.pid);
            if (stale) {
                const preferredOrigin = proxyOrigin(opts.host, port);
                const info = await fetchHealthInfo(preferredOrigin);
                if (info?.ok && child.pid !== undefined && info.pid === child.pid) {
                    settleZonePort(port);
                    return { origin: preferredOrigin, port, child, logPath };
                }
                if (info?.ok && !squatterAnnounced) {
                    squatterAnnounced = true;
                    console.error(
                        `bili: port ${port} answers health${info.pid !== undefined ? ` (pid ${info.pid})` : ""} but is not the proxy this launcher spawned (child pid ${child.pid ?? "?"}) — waiting for the spawned instance to report its real origin`,
                    );
                }
            }
        }
        // #1903: bounded re-discovery after a fast child death — same
        // discovery+attach decision as the one-shot probe above, re-run on a
        // short budget so a listener whose identity record published during
        // our spawn attempt is still attachable instead of mistaken for air.
        const rediscoverAfterChildExit = async (): Promise<ProxyHandle | undefined> => {
            console.error(
                `bili: spawned proxy exited before becoming healthy — re-checking for a late-publishing listener on port ${port} before failing`,
            );
            const rediscoveryDeadline = now() + POST_EXIT_REDISCOVERY_MS;
            while (now() < rediscoveryDeadline) {
                await sleepImpl(HEALTH_POLL_INTERVAL_MS);
                const probedAgain = await probeLiveInstances(readInstance, fetchHealthInfo, attachDiag);
                const late = pickAttachable(probedAgain, opts, codeFingerprint, attachExternal, refusedLog, attachDiag);
                if (late) {
                    console.error(`bili: attached to ${late.origin} (pid ${late.pid}) — it published its instance record after the initial discovery`);
                    return attachTo(late);
                }
            }
            return undefined;
        };
        if (childError !== undefined) {
            const detail = childError instanceof Error ? childError.message : String(childError);
            throw new Error(`bili: proxy spawn failed (${detail}) (log: ${logPath})`);
        }
        if (childExit) {
            // #1903: the child died before becoming healthy. Under strictPort
            // that death is almost certainly EADDRINUSE — proof the pinned port
            // is held by a listener our one-shot discovery above missed because
            // its identity record published AFTER that snapshot (a manual
            // `bili start` accepts TCP before its 'listening' callback writes
            // proxy-origin / registry markers; CI flake on PR #1896). The spawn
            // attempt just proved occupancy: refresh the stale snapshot on a
            // bounded budget and attach if the late publisher shows up; when
            // nothing appears, fall through to the original error below.
            const retried = await rediscoverAfterChildExit();
            if (retried) return retried;
            const detail = childExit.code !== null
                ? `code ${childExit.code}`
                : childExit.signal ? `signal ${childExit.signal}` : "unknown reason";
            throw new Error(`bili: proxy child exited before becoming healthy (${detail}) (log: ${logPath})`);
        }
        // #2260(A)/#2187: the timeout is the ONE terminal path where the
        // spawned child is STILL ALIVE. Abandoning it leaked a detached proxy
        // per failed bring-up — dsh plan-time retries re-arm every 10s, so a
        // persistently slow host accumulated ~1 zombie per ~70s (each also
        // stranding the lane sticky-port ladder). Hard-kill before failing.
        killAbandonedChild(child);
        console.error(
            `bili: killed spawned proxy (pid ${child.pid ?? "?"}) after ${SPAWN_BUDGET_MS}ms without health — it never became ready and would otherwise outlive this failure (log: ${logPath})`,
        );
        throw new Error(`bili: proxy did not become healthy within ${SPAWN_BUDGET_MS}ms (log: ${logPath})`);
    } finally {
        if (claimed) clearStartingMarker(launchToken);
    }
}

/** #2260(A)/#2187: unconditional hard-kill of a spawned-but-abandoned proxy
 *  child, all platforms. Deliberately NOT stopProxy(): its win32 path returns
 *  without killing because the #414 design assumes THIS process exits ≤2s
 *  later, letting the child's BILI_PARENT_PID watch run the graceful path —
 *  an assumption that does not hold when the spawner keeps living (plugin
 *  lane: long-lived desktop host), where the abandoned child would leak
 *  forever. The victim never became healthy, so it served no traffic and
 *  holds no sessions; SIGKILL loses nothing and reaches even a hung event
 *  loop (SIGTERM would wait for a stuck loop to drain). Stale instance
 *  records left behind are inert by the dead-pid checks in discovery. */
function killAbandonedChild(child: SpawnChild | undefined): void {
    if (!child || child.pid === undefined || child.pid <= 0) return;
    if (process.platform !== "win32") {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch {
            /* group already gone */
        }
    }
    try {
        child.kill?.("SIGKILL");
    } catch {}
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

/** #1753 (shutdown side): the wrapper's exit path used to kill the instance
 *  it spawned unconditionally — taking down every ATTACHED session riding
 *  that shared instance (live incident: exiting one `bili pi` killed the
 *  proxy another live `bili pi` was watching; the client burned its 3
 *  retries and died until some later wrapper re-spawned an instance on the
 *  same port). The server's watcher-set watchdog (#7) already implements
 *  the correct "die when the LAST owner exits" semantics; this guard defers
 *  to it: if /__bili/health still lists watchers other than ourselves, the
 *  instance is spared and the server retires it after its last watcher
 *  leaves (WATCHER_IDLE_GRACE_MS). Health-parse failures degrade to the old
 *  behavior (kill), which is safe: nothing else claims the instance. */
export async function stopProxyGuarded(
    handle: ProxyHandle,
    fetchHealthInfo: (origin: string) => Promise<HealthInfo | undefined>,
): Promise<void> {
    if (handle.attached) return;
    const child = handle.child;
    if (!child || child.pid === undefined) return;
    if (process.platform === "win32") {
        // #414: POSIX-only kill path; win32 relies on the server-side
        // parent-gone watchdog, which already honors the watcher set.
        return;
    }
    let info: HealthInfo | undefined;
    try {
        info = await fetchHealthInfo(handle.origin);
    } catch {
        info = undefined;
    }
    const watchers = info?.ok ? (info.watchdog?.watchers ?? []) : [];
    const others = watchers.filter((w) => w !== process.pid);
    if (others.length > 0) {
        console.error(
            `bili: sparing the shared proxy at ${handle.origin} — ${others.length} other watcher${others.length === 1 ? "" : "s"} still attached; it will retire when the last one exits`,
        );
        return;
    }
    stopProxy(handle);
}

/** #1952: the shared overlay is owned by another live launch — stop THIS
 *  launch's proxy (plainly throwing here would leak the detached proxy child,
 *  since prepare runs after ensureProxyRunning) and exit non-zero. The client
 *  is never spawned on this path. */
async function abortLaunchOnBusyOverlay(handle: ProxyHandle, err: OverlayBusyError, deps: LauncherDeps): Promise<void> {
    console.error(`bili: ${err.message}`);
    await stopProxyGuarded(handle, deps.fetchHealthInfo ?? fetchHealthInfoDefault);
    process.exit(1);
}

/** #679: quote one token for cmd.exe's line parser. Only whitespace-bearing
 *  tokens get wrapped in double quotes, so a space-free launch produces a
 *  byte-identical line to the old shell:true form. Pure formatter: callers
 *  must pre-validate their tokens through the #2196 safe-set guard
 *  (winCmdUnsafeToken) — an embedded double quote stays bare here only
 *  because such tokens never reach this path anymore. */
export function quoteWinToken(token: string): string {
    if (!/\s/.test(token) || token.includes('"')) return token;
    return `"${token}"`;
}

/** #679: full command line for `comspec /d /s /c <line>` — tokens quoted as
 *  needed, wrapped in one extra outer pair that cmd's /s strips before
 *  parsing the inner tokens with their own quoting intact (the documented /s
 *  form; same trick cross-spawn uses). */
export function buildWindowsCommandLine(cmd: string, args: readonly string[]): string {
    return `"${[cmd, ...args].map(quoteWinToken).join(" ")}"`;
}

/** #679: which spawn form a resolved client needs on Windows. Only .cmd/.bat
 *  shims and unresolved bare names need cmd.exe — CreateProcess cannot
 *  execute a batch file, and an extensionless name needs cmd's PATHEXT
 *  resolution. Everything else (.exe, node, an existing path with an
 *  extension) spawns directly and the OS quotes the executable and argv
 *  itself, spaces included. shell:true is never used anymore: no DEP0190, no
 *  cmd.exe re-splitting of spaced paths at their first space (which truncated
 *  both the command and its args).
 *  #2196: the comspec form re-feeds user argv into cmd.exe's LINE parser,
 *  which has no escape mechanism — so before building the line, every token
 *  (command included) must pass the safe-set guard; unsafe tokens throw with
 *  an actionable error instead of being mangled or interpreted silently. */
export function planClientSpawn(
    cmd: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
    if (platform !== "win32") return { command: cmd, args: [...args] };
    const lower = cmd.toLowerCase();
    const base = cmd.slice(Math.max(cmd.lastIndexOf("/"), cmd.lastIndexOf("\\")) + 1);
    const needsCmd = lower.endsWith(".cmd") || lower.endsWith(".bat") || !path.extname(base);
    if (!needsCmd) return { command: cmd, args: [...args] };
    const tokens = [cmd, ...args];
    tokens.forEach((token, i) => {
        const reason = winCmdUnsafeToken(token);
        if (reason) throw winCmdRefusalError(
            i === 0 ? "resolved command" : `argument #${i - 1}`,
            reason,
            "Set BILI_CLIENT_BIN to the native executable (e.g. the real codex.exe) or to a script entry run under node, or reword the argument.",
        );
    });
    const comspec = nonEmpty(env.COMSPEC) ? env.COMSPEC : "cmd.exe";
    return {
        command: comspec,
        args: ["/d", "/s", "/c", buildWindowsCommandLine(cmd, args)],
        windowsVerbatimArguments: true,
    };
}

export function runClient(
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    deps?: { spawnImpl?: SpawnFn; platform?: NodeJS.Platform },
): Promise<number> {
    // #679: never shell:true — besides DEP0190, cmd.exe re-splits the unquoted
    // line on whitespace and truncated spaced client/-e paths at their first
    // space; planClientSpawn picks the direct-vs-comspec form instead.
    const spawnImpl = deps?.spawnImpl ?? (spawn as SpawnFn);
    const plan = planClientSpawn(cmd, args, env, deps?.platform);
    return new Promise((resolve, reject) => {
        const child = spawnImpl(plan.command, plan.args, { stdio: "inherit", env, windowsVerbatimArguments: plan.windowsVerbatimArguments, windowsHide: true });
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

/** #2196: given a resolved codex .cmd/.bat shim, locate the official npm
 *  package's JS entry when this is a trusted npm install layout: the shim sits
 *  beside <dir>/node_modules/@openai/codex whose package.json is named
 *  "@openai/codex" and declares a resolvable "codex" bin entry, AND the shim
 *  text references that package (npm-generated shims always do; a hand-written
 *  codex.cmd placed beside an unrelated tree must not hijack the launch).
 *  Running that entry under Node reproduces exactly what the shim does — its
 *  vendor-binary lookup, env init, signal forwarding — while Node's own
 *  CreateProcess argv encoding carries user arguments verbatim instead of
 *  cmd.exe mangling them (#2196). Returns undefined for any other layout
 *  (yarn-classic .bin trees, pnpm store shims without the local node_modules
 *  link, ...): those keep the legacy cmd path under the safe-set guard. */
export function resolveCodexOfficialJsEntry(shimPath: string): string | undefined {
    const pkgDir = path.join(path.dirname(shimPath), "node_modules", "@openai", "codex");
    let pkgJson: unknown;
    try {
        pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    } catch {
        return undefined;
    }
    if (!pkgJson || typeof pkgJson !== "object") return undefined;
    const meta = pkgJson as { name?: unknown; bin?: unknown };
    if (meta.name !== "@openai/codex") return undefined;
    let rel: string | undefined;
    if (typeof meta.bin === "string") rel = meta.bin;
    else if (meta.bin && typeof meta.bin === "object" && !Array.isArray(meta.bin)) {
        const v = (meta.bin as Record<string, unknown>)["codex"];
        if (typeof v === "string") rel = v;
    }
    if (!rel) return undefined;
    const entry = path.resolve(pkgDir, rel);
    try {
        if (!fs.statSync(entry).isFile()) return undefined;
    } catch {
        return undefined;
    }
    try {
        const shimText = fs.readFileSync(shimPath, "utf8").slice(0, 65536);
        if (!shimText.includes("@openai\\codex") && !shimText.includes("@openai/codex")) return undefined;
    } catch {
        return undefined;
    }
    return entry;
}

/** #2196: Windows-only codex resolution that never routes through cmd.exe's
 *  line parser when it can be avoided: per PATH directory the native
 *  codex.exe wins over codex.cmd/codex.bat (earliest directory still wins
 *  overall), and a .cmd/.bat hit is upgraded to `node <official bin/codex.js>`
 *  whenever the trusted npm layout is present. Returns undefined when no
 *  codex.{exe,cmd,bat} exists anywhere — the caller falls through to the
 *  generic resolution (which also covers the extensionless case). */
function resolveCodexWin32(env: NodeJS.ProcessEnv): { command: string; prefixArgs: string[] } | undefined {
    const p = env.PATH;
    if (!p) return undefined;
    for (const dir of p.split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of [".exe", ".cmd", ".bat"]) {
            const f = path.join(dir, "codex" + ext);
            try {
                if (fs.existsSync(f) && fs.statSync(f).isFile()) {
                    if (ext === ".exe") return { command: f, prefixArgs: [] };
                    const entry = resolveCodexOfficialJsEntry(f);
                    if (entry) return { command: process.execPath, prefixArgs: [entry] };
                    return { command: f, prefixArgs: [] };
                }
            } catch {}
        }
    }
    return undefined;
}

// First alias present on PATH (per-client alias chains differ only in name order).
function firstOnPath(names: readonly string[], env: NodeJS.ProcessEnv): string | undefined {
    for (const name of names) {
        const resolved = resolveOnPath(name, env);
        if (resolved) return resolved;
    }
    return undefined;
}

// Ordered extension probe for an install-dir binary base path (Windows shims land
// as .cmd/.bat/.exe); returns the first existing candidate, else the bare base.
function probeInstalledBin(base: string, exts: readonly string[]): string {
    for (const ext of exts) {
        const candidate = base + ext;
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // Unreadable candidate: fall through to the next extension.
        }
    }
    return base;
}

export function resolveClientCommand(
    client: ClientName,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
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
    if (client === "codebuddy") {
        return { command: firstOnPath(["codebuddy", "cbc"], env) ?? "codebuddy", prefixArgs: [] };
    }
    if (client === "qoder") {
        // npm bin names: `qoder` (primary) with `qodercli` as the alternate
        // registration (both packages ship either).
        return { command: firstOnPath(["qoder", "qodercli"], env) ?? "qoder", prefixArgs: [] };
    }
    if (client === "trae") {
        return { command: firstOnPath(["traecli", "trae-cli", "trae"], env) ?? "traecli", prefixArgs: [] };
    }
    if (client === "kimi") {
        // install.sh / npm postinstall both place the binary at <KIMI_CODE_HOME>/bin/kimi.
        const resolved = resolveOnPath("kimi", env);
        if (resolved) return { command: resolved, prefixArgs: [] };
        return { command: path.join(resolveKimiHome(env), "bin", "kimi"), prefixArgs: [] };
    }
    if (client === "mcode") {
        // Installer / npm @minimax-ai/code place the launcher at
        // <MCODE_INSTALL_DIR|~/.minimax-code>/bin/mcode (mcode.cmd/.ps1 on Windows).
        const resolved = resolveOnPath("mcode", env);
        if (resolved) return { command: resolved, prefixArgs: [] };
        const binBase = path.join(resolveMcodeInstallDir(env), "bin", "mcode");
        return { command: probeInstalledBin(binBase, platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""]), prefixArgs: [] };
    }
    if (client === "antigravity") {
        // #2115: the CLI binary is named `agy` (Gemini CLI successor), not
        // `antigravity`; install.sh places it at ~/.local/bin/agy (Windows:
        // %LOCALAPPDATA%\agy\bin\agy.exe).
        const resolved = resolveOnPath("agy", env);
        if (resolved) return { command: resolved, prefixArgs: [] };
        const base = platform === "win32"
            ? path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "agy", "bin", "agy")
            : path.join(os.homedir(), ".local", "bin", "agy");
        return { command: probeInstalledBin(base, platform === "win32" ? [".exe", ""] : [""]), prefixArgs: [] };
    }
    if (client === "codex" && platform === "win32") {
        // #2196: the default npm install is a codex.cmd shim whose %*
        // forwarding re-parses every user argument through cmd.exe (embedded
        // quotes split tokens, %VAR% expands, &|<>^() execute). Prefer forms
        // that never enter that parser; a leftover .cmd/.bat only reaches
        // cmd.exe when neither exists — where the safe-set guard in
        // planClientSpawn then refuses argv it cannot carry verbatim instead
        // of corrupting it silently.
        const win32Hit = resolveCodexWin32(env);
        if (win32Hit) return win32Hit;
    }
    const resolved = resolveOnPath(client, env);
    return { command: resolved ?? client, prefixArgs: [] };
}

interface RunLaunchParams {
    client: ClientName;
    clientArgs: string[];
    mitmDomains?: string[];
    overrides: Record<string, string | undefined>;
}

function parsePort(raw: string | undefined): number {
    // 0 = no explicit --port → spawn on an OS-assigned ephemeral port (#446)
    if (!raw || !raw.trim()) return 0;
    const port = parseInt(raw, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
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

    const base = baseClientName(params.client);
    // #535: for pi and omp, discovery must read the REAL home — a stale
    // inherited PI_CODING_AGENT_DIR (legacy overlay launch) would discover
    // routes from an old overlay's rewritten models.json/models.yml.
    const discoveryEnv =
        base === "pi" || base === "omp" ? { ...process.env, PI_CODING_AGENT_DIR: undefined } : process.env;
    // #1206: surface co-resident third-party compression plugins BEFORE the
    // first message — two compressors on one conversation double-compress and
    // corrupt message refs, so warn at launch time, not after damage.
    if (conflictScanEnabled(process.env)) {
        try {
            const scan = scanClientPlugins(base, { env: discoveryEnv, cwd: process.cwd() });
            for (const f of scan.findings) {
                if (isDesignBenign(f, base)) {
                    console.error(`bili: note: ${f.entry} present (${f.source}) — bili's own ${f.client} sibling compressor; it stands down / is absorbed while bili owns this session, no action needed (#920/#2045).`);
                    continue;
                }
                const risk = f.match === "known"
                    ? "It is bili's sibling compressor — two compressors on one conversation will double-compress and corrupt message refs."
                    : "Its name matches compression keywords — IF it also compresses context, the two compressors will double-compress and corrupt message refs.";
                console.error(`bili: WARNING: co-resident compression plugin on ${base}: ${f.entry} (${f.source}). ${risk} (#1206) — disable the other plugin, or don't route this client through bili.`);
                // #2219: actionable follow-up — how to stop THIS client's own
                // compaction (same per-client map as acp_status / web banner).
                console.error(`bili:   fix (${base}): ${conflictRemediation(base)}`);
            }
        } catch {
            // The scan is diagnostic only — never block client startup on it.
        }
    }
    const config = loadClientConfig(discoveryEnv, process.cwd());
    if (base === "codex") {
        // #2197: codex resolves providers from base config + -p profile file
        // overlay + -c/-m CLI overrides; discovery, budget alignment and the
        // MCP/flat-tool decision must all use that merged view or a
        // profile-only provider bypasses the proxy entirely. Same CODEX_HOME
        // resolution loadClientConfig used above. Fail BEFORE the proxy is
        // spawned (a refusal after ensureProxyRunning leaks a detached child).
        const eff = resolveCodexEffectiveView(resolveCodexHome(discoveryEnv), config.codex ?? { providers: {} }, params.clientArgs);
        if (eff.fatal) {
            console.error(`bili: ${eff.fatal}`);
            process.exit(2);
        }
        if (eff.profileMissing) {
            console.error(`bili: codex profile "${eff.profile}" has no ${resolveCodexHome(discoveryEnv)}/${eff.profile}.config.toml — codex runs on the base config only, so routing follows the base config too.`);
        } else if (eff.profile) {
            console.error(`bili: codex profile "${eff.profile}" loaded — route discovery uses the merged base+profile+CLI view.`);
        }
        config.codex = eff.config;
    }
    let routes = discoverRoutes(base, config);
    if (base === "aider") {
        // #1048: the CLI channel (--openai-api-base / --set-env) outranks env
        // and conf files in aider's own resolution order; merge it into the
        // discovered set before routing so it lands in the MITM whitelist.
        const argUrls = discoverAiderArgUrls(params.clientArgs);
        if (argUrls.length > 0) {
            config.aider = { baseUrls: dedupeInOrder([...(config.aider?.baseUrls ?? []), ...argUrls]) };
            routes = discoverRoutes(base, config);
        }
    }
    const aiderDeclared = base === "aider" && ((config.aider?.baseUrls ?? []).length > 0 || (params.mitmDomains ?? []).length > 0);
    // #535: pi's REAL home — resolvePiHome honors a possibly-stale inherited
    // PI_CODING_AGENT_DIR (e.g. launching `bili pi` from inside a shell that
    // a legacy bili overlay launch exported it into); the new file-free
    // design must never let that redirect pi at an old overlay dir.
    const piRealHome = resolvePiHome({ ...process.env, PI_CODING_AGENT_DIR: undefined });
    // #535 phase 3: omp's REAL home, resolved with the same stale-inheritance
    // strip as pi (resolveOmpHome honors PI_CODING_AGENT_DIR too).
    const ompRealHome = resolveOmpHome({ ...process.env, PI_CODING_AGENT_DIR: undefined });
    // #535: validate extension availability BEFORE spawning the proxy — a
    // refusal after ensureProxyRunning would leak a detached proxy child.
    if (base === "pi" && (routes.httpRewrites.length > 0 || routes.httpsRewrites.length > 0)) {
        const piExt = selfDistFile("agent/pi.js");
        const extAvailable = (piExt !== undefined && fs.existsSync(piExt)) || piPluginInstalled(piRealHome);
        if (!extAvailable) {
            throw new Error(
                "bili: pi needs provider URL rewrites but the bili extension cannot load " +
                    "(dist/agent/pi.js missing and the plugin is not installed in ~/.pi/agent/settings.json) — " +
                    "reinstall billion-context or run `bili plugin install pi`",
            );
        }
    }
    if (base === "omp" && routes.httpRewrites.length > 0) {
        const ompExt = selfDistFile("agent/omp.js");
        const extAvailable = (ompExt !== undefined && fs.existsSync(ompExt)) || ompPluginLoadedFrom(ompRealHome);
        if (!extAvailable) {
            throw new Error(
                "bili: omp needs provider URL rewrites but the bili extension cannot load " +
                    "(dist/agent/omp.js missing and the plugin is not installed in ~/.omp/agent/config.yml) — " +
                    "reinstall billion-context or run `bili plugin install omp`",
            );
        }
    }
    // bili's own route graph (same sources the spawned proxy child reads —
    // used to resolve the budget-alignment window, #321).
    const biliRoutes = loadRoutes(process.env);
    const domains = dedupeInOrder([...routes.httpsDomains, ...(params.mitmDomains ?? [])]);
    // #1403: mirror the proxy's EXACT MITM whitelist (built-in defaults ∪
    // config-file/BILI_MITM_DOMAINS tier as the spawned child will see it ∪
    // launcher-discovered domains ∪ dynamic client-config discovery) so the
    // pi/omp extension stamps prompt_cache_key only for destinations the proxy
    // will decrypt and strip it from. Blind-tunnel destinations get no stamp —
    // strict-schema upstreams 400 the foreign top-level field otherwise.
    const childMitmEnv: NodeJS.ProcessEnv =
        domains.length > 0
            ? { BILI_MITM_DOMAINS: domains.join(",") }
            : { BILI_MITM_DOMAINS: process.env.BILI_MITM_DOMAINS };
    const extMitmHosts = base === "pi" || base === "omp"
        ? dedupeInOrder([...DEFAULT_MITM_DOMAINS, ...resolveMitmDomains(childMitmEnv), ...domains, ...discoverMitmDomains(discoveryEnv)])
        : [];
    const extNonHttpProviders = base === "pi" || base === "omp" ? resolveNonHttpProviders(process.env) : [];
    const handle = await ensureProxyRunning({ host, port, passthrough, debug, lane: base, strictPort: port > 0, mitmDomains: domains, modelWindows: collectModelWindows(config, base), modelMaxOutputs: collectModelMaxOutputs(config, base) }, deps);
    console.error(
        `bili: started proxy at ${handle.origin} (MITM domains: ${domains.length ? domains.join(", ") : "defaults"})` +
            ((base !== "kimi" && base !== "mcode" && base !== "aider" && routes.httpRewrites.length > 0) ? ` (HTTP /bili/ rewrites: ${routes.httpRewrites.length})` : "") +
            (routes.httpsRewrites.length > 0 ? ` (HTTPS cert rewrites: ${routes.httpsRewrites.length})` : "") +
            (routes.httpEnvRoutes.length > 0 ? ` (HTTP proxy-env routes: ${routes.httpEnvRoutes.length})` : "") +
            (params.client === "pi-test" ? " (no extensions)" : ""),
    );
    if (handle.logPath) {
        console.error(`bili: proxy log: ${handle.logPath}`);
    }

    const ca = resolveCaCertPath(process.env);
    let env: NodeJS.ProcessEnv;
    let clientArgs = params.clientArgs;
    let opencodeTmpFile: string | undefined;
    let dshOverlayHome: string | undefined;
    let gooseOverlay: GooseOverlay | undefined;
    let codexOverlay: { realHome: string; overlay: string; generated: readonly string[] } | undefined;
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
        } else if (base === "qoder") {
            console.error(
                "bili: BILI_LAUNCHER_DIRECT has no effect for qoder — its model endpoint scheme is hardcoded https with no base-URL override env, so qoder always runs in cert-MITM mode.",
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
        // #535: file-free injection — no overlay, no PI_CODING_AGENT_DIR
        // redirect. pi runs on its REAL home: provider baseUrls are overridden
        // at extension load from the env manifest (registerProvider; see
        // buildPiEnv), and the old settings.json compaction-off generation is
        // replaced by the extension's session_before_compact cancel.
        env = buildPiEnv(origin, ca, stripInheritedProxy(process.env), routes.httpRewrites, routes.httpsRewrites, extMitmHosts, extNonHttpProviders);
        // #535: never let a stale inherited overlay redirect (from a legacy
        // launch or a shell exported inside one) leak into the child — pi
        // always runs on its REAL home now.
        delete env.PI_CODING_AGENT_DIR;
        // Native tooling out of the box: when the user has NOT installed the
        // plugin, ride pi's `-e <file>` (loads for this run only, writes
        // nothing) instead of leaving them on wire-mode fallback. When they
        // HAVE installed it, settings.json already loads it — adding `-e` too
        // would double-register.
        const piExt = selfDistFile("agent/pi.js");
        if (piExt && fs.existsSync(piExt) && !piPluginInstalled(piRealHome)) {
            clientArgs = ["-e", piExt, ...clientArgs];
        }
    } else if (base === "omp") {
        // #535 phase 3: file-free — omp is pi-based and runs on its REAL home
        // (no overlay, no PI_CODING_AGENT_DIR redirect). Provider baseUrls are
        // overridden at extension load from the env manifest (omp's fork keeps
        // pi's registerProvider), and AUTO native compaction is cancelled by
        // the extension (#851): session_before_compact carries no reason field,
        // so the plugin cancels only passes announced via auto_compaction_start
        // (the native summarizer would destroy the ACP-tagged context); manual
        // /compact stays user-owned and its surviving summary is archived by
        // the proxy on session_compact. https upstreams ride cert-MITM like pi.
        env = buildPiEnv(origin, ca, stripInheritedProxy(process.env), routes.httpRewrites, [], extMitmHosts, extNonHttpProviders);
        delete env.PI_CODING_AGENT_DIR;
        // #1774: the child always rides bili's proxy here, so a long preflight can
        // hold the first SSE event well past OMP's default 300s first-parsed-event
        // watchdog — export a wider first-event budget unless the user pinned one.
        applyOmpFirstEventTimeout(env);
        const ompExt = selfDistFile("agent/omp.js");
        if (ompExt && fs.existsSync(ompExt) && !ompPluginLoadedFrom(ompRealHome)) {
            clientArgs = ["-e", ompExt, ...clientArgs];
        }
    } else if (base === "opencode") {
        // opencode: HTTPS upstreams ride cert-MITM (HTTPS_PROXY + CA); plaintext
        // HTTP upstreams get a /bili/-rewritten copy of opencode.json via
        // OPENCODE_CONFIG (real config untouched). #920: the temp-config clone
        // strips any opencode-acp entry — the thin plugin imports that package
        // as a library instead (legacy sessions keep working in-process), and
        // loading it armed would re-arm its global /bili/ self-disable.
        // BILLION_CONTEXT_PROXY activates the thin plugin itself. Base env is
        // stripped like hermes/dsh/kimi/qoder/trae/jcode (#890): undici/Bun prefer
        // lowercase http(s)_proxy over the uppercase injected below, so an
        // inherited lowercase var would silently route model traffic around bili.
        env = { ...stripInheritedProxy(process.env), HTTPS_PROXY: origin, NODE_EXTRA_CA_CERTS: ca, BILLION_CONTEXT_PROXY: origin };
        const opencodePlugin = selfDistFile("agent/opencode.js");
        const opencodePluginPath = opencodePlugin && fs.existsSync(opencodePlugin) ? opencodePlugin : undefined;
        const ocDirMode = opencodePluginPath !== undefined && opencodeMajorVersion(resolveClientCommand("opencode", process.env).command) >= 2;
        opencodeTmpFile = prepareOpencodeHttpRewrite(readOpencodeConfigRoot(process.env), origin, routes.httpRewrites, routes.httpsRewrites, opencodePluginPath, ocDirMode, env);
        if (opencodeTmpFile) env.OPENCODE_CONFIG = opencodeTmpFile;
        for (const warning of opencodeProjectBypassWarnings(readOpencodeProjectLayer(opencodeEffectiveCwd(clientArgs)), routes)) {
            console.error(warning);
        }
    } else if (base === "hermes") {
        // #535 phase 2: file-free — no overlay HERMES_HOME, no config.yaml
        // runs on its REAL home — including a user-set HERMES_HOME (discovery
        // resolved the same path, so the MITM whitelist matches). Its httpx
        // stack resolves ONE proxy env var (HTTPS_PROXY first) for both
        // schemes: https upstreams ride CONNECT + cert MITM, plain-http
        // upstreams ride absolute-form forward-proxy requests the server
        // understands. CA trust (#1375): current hermes resolves the main
        // client via agent/ssl_verify.py — platform store + per-provider
        // ssl_ca_cert, ambient trust only through SSL_CERT_FILE (OpenSSL
        // replace semantics → the COMBINED bundle keeps blind-tunnelled hosts
        // validating against public roots, #152). HERMES_CA_BUNDLE stays set
        // for older builds and hermes' auth flows, which still read it.
        // Sessions bind by persisted content-prefix affinity when no identity
        // carrier is present (anonymous requests are accepted, #286).
        env = stripInheritedProxy(process.env);
        env.HTTPS_PROXY = origin;
        env.HERMES_CA_BUNDLE = ca;
        env.SSL_CERT_FILE = resolveCombinedCaPath(process.env);
        if (routes.httpRewrites.length === 0 && routes.httpsDomains.length === 0) {
            console.error(
                "bili: no hermes providers found in ~/.hermes/config.yaml — traffic will NOT go through the proxy (configure a provider first).",
            );
        }
    } else if (base === "dsh") {
        // #535 phase 4: split by destination (see discoverRoutes). Non-loopback
        // upstreams ride the proxy envs — https via CONNECT + cert MITM
        // (HTTPS_PROXY + CA), plain-http via absolute-form forward-proxy
        // requests (HTTP_PROXY). The COMBINED bundle goes to BOTH SSL_CERT_FILE
        // (OpenSSL replace-semantics readers) and NODE_EXTRA_CA_CERTS (Node
        // append-semantics readers): dsh is a Node program, but Windows' official
        // Node ignores SSL_CERT_FILE and trusts only NODE_EXTRA_CA_CERTS (#710),
        // so both must be set for the MITM CA to be trusted cross-platform. The
        // combined bundle carries system roots, so blind-tunneled hosts still
        // validate under either mechanism. The built-in deepseek-official route
        // stays captured through $DEEPSEEK_BASE_URL (resolution order: settings
        // baseURL ?? env ?? default, so a user setting wins and this env is the
        // no-settings fallback). ONLY loopback destinations take the settings.yaml
        // /bili/ rewrite below (persistent overlay DSH_HOME ~/.dsh-bili; real
        // ~/.dsh never touched) — dsh bypasses proxy envs for loopback
        // unconditionally. Proxy envs are set only when something actually routes
        // through them, so a launch with no non-loopback custom providers behaves
        // exactly as before.
        const usesProxyEnv = routes.httpsDomains.length > 0 || routes.httpEnvRoutes.length > 0;
        env = usesProxyEnv ? stripInheritedProxy(process.env) : { ...process.env };
        env.BILLION_CONTEXT_PROXY = origin;
        env.DEEPSEEK_BASE_URL = wrapUpstream(origin, "https://api.deepseek.com");
        if (usesProxyEnv) {
            const caBundle = resolveCombinedCaPath(process.env);
            env.HTTPS_PROXY = origin;
            env.SSL_CERT_FILE = caBundle;
            env.NODE_EXTRA_CA_CERTS = caBundle;
        }
        if (routes.httpEnvRoutes.length > 0) env.HTTP_PROXY = origin;
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
        try {
            dshOverlayHome = routes.httpRewrites.length > 0 ? prepareDshHome(dshHomeDir, origin, routes.httpRewrites) : undefined;
        } catch (err) {
            if (!(err instanceof OverlayBusyError)) throw err;
            await abortLaunchOnBusyOverlay(handle, err, deps);
            return;
        }
        if (dshOverlayHome) {
            env.DSH_HOME = dshOverlayHome;
        } else if (routes.httpRewrites.length > 0) {
            console.error(
                "bili: dsh settings.yaml could not be rewritten (unreadable or no matching endpoints) — loopback custom providers will NOT go through the proxy; other routes still do.",
            );
        } else if (!usesProxyEnv) {
            console.error(
                "bili: no custom providers found in ~/.dsh/settings.yaml — proxying the built-in deepseek route via DEEPSEEK_BASE_URL only.",
            );
        }
        // Native /acp command rides a --patch overlay (independent of the
        // settings rewrite above) unless a persistent `bili plugin install dsh`
        // already provides it — a second `id: bili-native` insert would trip
        // cordis' duplicate-entry-id check and hard-fail dsh boot.
        // #1590: seed the resolvable shim under BOTH DSH_HOME variants (the
        // overlay's profiles symlink back to the base home, so ESM walk-up
        // from the real profile path lands there) and point the client
        // scanner's CJS resolution at the base one through NODE_PATH —
        // together they let dsh attach our browser half (the settings entry)
        // alongside the host plugin in every lane.
        writeDshClientShim(dshHomeDir);
        if (dshOverlayHome !== undefined) writeDshClientShim(dshOverlayHome);
        const dshNm = path.join(dshHomeDir, "node_modules");
        const prevNodePath = env.NODE_PATH;
        env.NODE_PATH = prevNodePath !== undefined && prevNodePath.length > 0 ? `${dshNm}${path.delimiter}${prevNodePath}` : dshNm;
        let dshAcpPatch: string | undefined;
        if (!dshNativeInstalled()) {
            dshAcpPatch = writeDshAcpPatch(dshHomeDir, dshPluginEntry(dshOverlayHome ?? dshHomeDir));
        } else if (allowDshCompactionState(process.env).enabled !== true) {
            // #2360 §3: native install owns the plugin chain — the overlay patch
            // above would insert a SECOND bili-native entry and hard-fail dsh
            // boot, and DSH mounts compaction in an agent preset whose nested
            // rows no patch layer can address by id (#1772/#2360) — so
            // compaction-basic auto:false is NOT in force unless the user
            // applies the #2474 full-snapshot override of preset-standard in
            // their profile's cordis.patch.yml, and dsh native compaction
            // stays armed otherwise. Say so at launch instead of leaving the
            // user to discover a landed checkpoint through destroyed-substrate
            // errors; the live protection is the proxy's wire-level refusal on
            // every lane (openai/anthropic/responses).
            console.error(
                "bili: dsh native install detected — the launcher's compaction-basic auto:false overlay patch is skipped (a second bili-native entry would hard-fail dsh boot), and DSH mounts compaction in an agent preset whose nested rows no patch layer can address by id (#1772/#2360): dsh native compaction stays ARMED unless you apply the #2474 full-snapshot override of the preset-standard row in your profile's cordis.patch.yml (config replaces wholesale — see the plugin's boot warning for the exact recipe). Protection is bili's wire-level refusal of dsh compaction calls on all lanes (openai/anthropic/responses, #1729/#2193/#2360) — if you see 'compression substrate appears destroyed' or chained 'compress FAILED' errors, a dsh checkpoint has landed outside bili's knowledge.",
            );
        }
        if (dshAcpPatch) clientArgs = dshArgsWithPatch(clientArgs, dshAcpPatch);
    } else if (base === "kimi") {
        // #757: cert-MITM like hermes/dsh — Kimi Code honors standard proxy
        // envs for all outbound traffic EXCEPT an unconditional loopback
        // NO_PROXY bypass (verified against the v0.42.0 binary). Non-loopback
        // https rides CONNECT + cert MITM; non-loopback plain-http rides
        // absolute-form forward-proxy requests. The COMBINED bundle goes to
        // BOTH SSL_CERT_FILE (OpenSSL replace-semantics readers) and
        // NODE_EXTRA_CA_CERTS (Node append-semantics readers; Windows' official
        // Node ignores SSL_CERT_FILE, #710). Loopback endpoints are inventoried
        // only — no rewrite channel exists without editing the user's
        // config.toml. No budget env: kimi's native auto-compaction fires at
        // W − reserved_context_size (~95% of window), which ACP compression
        // (~55% once windows align via BILI_LAUNCHER_MODEL_WINDOWS) precedes.
        const usesProxyEnv = routes.httpsDomains.length > 0 || routes.httpEnvRoutes.length > 0;
        env = usesProxyEnv ? stripInheritedProxy(process.env) : { ...process.env };
        if (usesProxyEnv) {
            const caBundle = resolveCombinedCaPath(process.env);
            env.HTTPS_PROXY = origin;
            env.SSL_CERT_FILE = caBundle;
            env.NODE_EXTRA_CA_CERTS = caBundle;
            if (routes.httpEnvRoutes.length > 0) env.HTTP_PROXY = origin;
        }
        if (routes.httpRewrites.length > 0) {
            console.error(
                `bili: ${routes.httpRewrites.length} loopback endpoint(s) in ${resolveKimiHome(process.env)}/config.toml bypass Kimi Code's unconditional loopback NO_PROXY rule and will NOT go through the proxy — prefix their base_url with ${origin}/bili/ manually to compress them.`,
            );
        } else if (!usesProxyEnv) {
            console.error(
                `bili: no routable providers found in ${resolveKimiHome(process.env)}/config.toml — traffic will NOT go through the proxy (configure a provider first).`,
            );
        }
    } else if (base === "mcode") {
        // #1050: cert-MITM like kimi — MiniMax Code honors standard proxy envs
        // for all outbound traffic EXCEPT an unconditional loopback NO_PROXY
        // bypass (verified against @minimax-ai/code 0.4.12, packages/tui/src/cli/network-proxy.ts).
        // Non-loopback https rides CONNECT + cert MITM; non-loopback plain-http
        // rides absolute-form forward-proxy requests. The COMBINED bundle goes
        // to BOTH SSL_CERT_FILE and NODE_EXTRA_CA_CERTS (#710). Loopback
        // endpoints are inventoried only — no rewrite channel exists without
        // editing the user's config.yaml. No budget env: mcode's built-in
        // auto-compaction fires on input-token footprint, which ACP compression
        // precedes once windows align via BILI_LAUNCHER_MODEL_WINDOWS.
        const usesProxyEnv = routes.httpsDomains.length > 0 || routes.httpEnvRoutes.length > 0;
        env = usesProxyEnv ? stripInheritedProxy(process.env) : { ...process.env };
        if (usesProxyEnv) {
            const caBundle = resolveCombinedCaPath(process.env);
            env.HTTPS_PROXY = origin;
            env.SSL_CERT_FILE = caBundle;
            env.NODE_EXTRA_CA_CERTS = caBundle;
            if (routes.httpEnvRoutes.length > 0) env.HTTP_PROXY = origin;
        }
        const mcodeConfigPath = `${process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim() || path.join(os.homedir(), ".minimax")}/config.yaml`;
        if (routes.httpRewrites.length > 0) {
            console.error(
                `bili: ${routes.httpRewrites.length} loopback endpoint(s) in your MiniMax Code ${mcodeConfigPath} (profile variants ~/.minimax-<profile>/config.yaml count too) bypass its unconditional loopback NO_PROXY rule and will NOT go through the proxy — prefix their base_url with ${origin}/bili/ manually to compress them.`,
            );
        } else if (!usesProxyEnv) {
            console.error(
                `bili: no routable providers found in your MiniMax Code ${mcodeConfigPath} — traffic will NOT go through the proxy (configure a provider first).`,
            );
        }
    } else if (base === "qoder") {
        // #653: cert-MITM only — the model endpoint scheme is hardcoded https
        // (no base-URL override env), so /bili/ rewrites cannot reach it.
        // qoder's undici stack honors HTTPS_PROXY + NODE_EXTRA_CA_CERTS
        // (additive, so the plain root CA suffices). Proxy vars are fully
        // stripped (same contract as hermes). QODER_MODEL_TRANSPORT=http
        // forces the OpenAI chat-completions wire: the default transport is a
        // server feature-gate whose `legacy` fallback wire is unverified
        // (#653 open question 1). The env prefix family follows the CN-site
        // detection (qoderIsCnSite).
        env = buildQoderEnv(origin, ca, stripInheritedProxy(process.env));
        const qoderPrefix = qoderIsCnSite(process.env) ? "QODERCN" : "QODER";
        env[`${qoderPrefix}_MODEL_TRANSPORT`] = "http";
        const qoderBudget = await resolveQoderBudgetEnv({
            model: nonEmpty(process.env[`${qoderPrefix}_MODEL`]) ? process.env[`${qoderPrefix}_MODEL`] : config.qoder?.model,
            userAutoCompactWindow: process.env[`${qoderPrefix}_AUTOCOMPACT_WINDOW`],
            windowKey: `${qoderPrefix}_AUTOCOMPACT_WINDOW`,
            routes: biliRoutes,
            upstreamUrl: `https://${config.qoder?.modelServerHost ?? QODER_DEFAULT_MODEL_HOSTS[0]}`,
        });
        Object.assign(env, qoderBudget);
        if (qoderBudget[`${qoderPrefix}_AUTOCOMPACT_WINDOW`] !== undefined) {
            console.error(`bili: qoder budget aligned — ${qoderPrefix}_AUTOCOMPACT_WINDOW=${qoderBudget[`${qoderPrefix}_AUTOCOMPACT_WINDOW`]}`);
        }
    } else if (base === "trae") {
        // #655: cert-MITM like codex/qoder (Go binary honors HTTPS_PROXY; CA
        // via SSL_CERT_FILE combined bundle). No budget env (the CLI manages
        // its own context window) and no transport forcing — the wire is the
        // proprietary /api/ide/v2/llm_raw_chat, recognized as OpenAI by the
        // proxy.
        env = buildTraeEnv(origin, resolveCombinedCaPath(process.env), stripInheritedProxy(process.env));
    } else if (base === "jcode") {
        // Rust reqwest honors HTTPS_PROXY + SSL_CERT_FILE; NO_PROXY keeps the
        // loopback legs (unsloth endpoint, MCP) out of the proxy.
        env = buildJcodeEnv(origin, resolveCombinedCaPath(process.env), stripInheritedProxy(process.env));
    } else if (base === "gemini") {
        // #1047: GOOGLE_GEMINI_BASE_URL points gemini-cli's genai client
        // straight at the loopback proxy (GATEWAY auth mode); no proxy/CA env.
        env = buildGeminiEnv(origin, ca, routes.httpRewrites, routes.httpsRewrites, stripInheritedProxy(process.env));
        if (routes.httpRewrites.length === 0 && routes.httpsRewrites.length === 0) {
            console.error(
                "bili: no routable gemini upstream found (unparseable GOOGLE_GEMINI_BASE_URL?) — traffic will NOT go through the proxy.",
            );
        }
    } else if (base === "iflow") {
        // #1047: IFLOW_BASE_URL points iFlow straight at the loopback proxy
        // (OpenAI wire); no proxy/CA env.
        env = buildIflowEnv(origin, ca, routes.httpRewrites, routes.httpsRewrites, stripInheritedProxy(process.env));
        if (routes.httpRewrites.length === 0 && routes.httpsRewrites.length === 0) {
            console.error(
                "bili: no routable iFlow upstream found (unparseable IFLOW_BASE_URL?) — traffic will NOT go through the proxy.",
            );
        }
    } else if (base === "qwen") {
        // #1047: cert-MITM only — qwen-code has no base-URL override env, so
        // the stock DashScope/Qwen gateways (+ --mitm-domain extras) are
        // whitelisted for the proxy's CA. NODE_EXTRA_CA_CERTS is additive, so
        // the plain root CA suffices.
        env = buildQwenEnv(origin, resolveCaCertPath(process.env), stripInheritedProxy(process.env));
    } else if (base === "antigravity") {
        // #2115: CLOUD_CODE_URL points language_server straight at the loopback
        // proxy (undocumented override verified in the v2.19.1 binary); no
        // proxy/CA env needed. Fallback if Google removes the knob: cert-MITM
        // (the server honors HTTPS_PROXY, no pinning) — CLIENTS.md.
        env = buildAntigravityEnv(origin, ca, routes.httpRewrites, routes.httpsRewrites, stripInheritedProxy(process.env));
        if (routes.httpRewrites.length === 0 && routes.httpsRewrites.length === 0) {
            console.error(
                "bili: no routable antigravity upstream found (unparseable CLOUD_CODE_URL?) — traffic will NOT go through the proxy.",
            );
        }
    } else if (base === "aider") {
        // #1048: cert-MITM like jcode/kimi — aider's Python stack (litellm →
        // httpx, plus requests) honors standard proxy envs for all outbound
        // traffic; the combined bundle goes to BOTH SSL_CERT_FILE (httpx /
        // OpenSSL replace semantics) and REQUESTS_CA_BUNDLE (requests).
        // NO_PROXY keeps loopback legs (local ollama/vllm servers) direct.
        // No budget env and no native mode: aider has no tool-injection seam
        // (its hook surface is shell commands around edits/notifications, not
        // conversation tools), so the proxy owns compression in wire mode.
        const usesProxyEnv = routes.httpsDomains.length > 0 || routes.httpEnvRoutes.length > 0;
        env = usesProxyEnv
            ? buildAiderEnv(origin, resolveCombinedCaPath(process.env), stripInheritedProxy(process.env), routes.httpEnvRoutes.length > 0)
            : { ...process.env };
        if (routes.httpRewrites.length > 0) {
            console.error(
                `bili: ${routes.httpRewrites.length} loopback endpoint(s) declared for aider bypass NO_PROXY and will NOT go through the proxy — point their base URL at ${origin}/bili/<url> manually (e.g. via --openai-api-base) to compress them.`,
            );
        } else if (!usesProxyEnv) {
            console.error(
                "bili: no routable aider endpoint found — traffic will NOT go through the proxy.",
            );
        } else if (!aiderDeclared) {
            console.error(
                `bili: no aider endpoint declared (OPENAI_API_BASE / --openai-api-base / .aider.conf.yml) — assuming ${AIDER_DEFAULT_MODEL_HOSTS.join(" + ")}; pass --mitm-domain <host> for other relays.`,
            );
        }
    } else if (base === "copilot") {
        // #1049: cert-MITM like codex/trae (Go net/http honors HTTPS_PROXY; CA
        // via SSL_CERT_FILE combined bundle). No budget env — the CLI manages
        // its own context window.
        env = buildCopilotEnv(origin, resolveCombinedCaPath(process.env), stripInheritedProxy(process.env));
    } else if (base === "amp") {
        // #1049: cert-MITM like copilot; ampcode.com carries both the model
        // leg and the control plane, so the single whitelist entry covers both.
        env = buildAmpEnv(origin, resolveCombinedCaPath(process.env), stripInheritedProxy(process.env));
    } else if (base === "crush") {
        // #2340: cert-MITM like amp/copilot — Go net/http honors HTTPS_PROXY
        // and the combined CA bundle via SSL_CERT_FILE. Whitelist = built-in
        // provider hosts + crush.json custom base_urls (discoverRoutes).
        env = buildCrushEnv(origin, resolveCombinedCaPath(process.env), stripInheritedProxy(process.env));
    } else if (base === "zed") {
        // #2340: cert-MITM like jcode — Rust reqwest honors HTTPS_PROXY; the
        // combined CA bundle rides SSL_CERT_FILE (openssl-probe reads it first
        // on Linux). Whitelist = built-in provider hosts + settings.json
        // custom api_urls (discoverRoutes). Loopback legs stay direct
        // (NO_PROXY).
        env = buildZedEnv(origin, resolveCombinedCaPath(process.env), stripInheritedProxy(process.env));
    } else if (base === "goose") {
        // #1049: rustls release builds won't trust bili's CA, so no proxy envs
        // at all — every model leg is redirected straight at the proxy as
        // plain HTTP instead: built-in openai/anthropic via their *_HOST
        // session-override envs (honored above any persisted config, stable
        // across mid-session provider switches), custom declarative providers
        // via a regenerated GOOSE_PATH_ROOT overlay (real config untouched,
        // user edits merged back in finalizeGooseHome). Inherited proxy vars
        // are stripped: the plain-HTTP model legs must never detour through a
        // corporate forward proxy.
        env = { ...stripInheritedProxy(process.env), BILLION_CONTEXT_PROXY: origin };
        env.OPENAI_HOST = wrapUpstream(origin, "https://api.openai.com");
        env.ANTHROPIC_HOST = wrapUpstream(origin, "https://api.anthropic.com");
        if (routes.httpRewrites.length > 0) {
            const overlay = prepareGooseHome(process.env, origin, routes.httpRewrites);
            if (overlay) {
                gooseOverlay = overlay;
                env.GOOSE_PATH_ROOT = overlay.root;
            } else {
                console.error("bili: goose custom-provider rewrite unavailable (overlay could not be prepared) — those endpoints will NOT go through the proxy");
            }
        }
        const active = config.goose?.activeProvider;
        if (active && active !== "openai" && active !== "anthropic" && !(active in (config.goose?.customProviders ?? {}))) {
            console.error(`bili: goose active provider "${active}" has no override seam (not built-in openai/anthropic, not a discovered custom provider) — its model traffic will NOT go through the proxy`);
        }
    } else if (base === "codex") {
        // Per-spawn conversation id for the MCP shell's headless
        // self-registration (codex provides no session id of its own).
        const codexConversationId = injectMcp ? randomUUID() : undefined;
        const codexCaPath = resolveCombinedCaPath(process.env);
        if (directUrl) {
            env = { ...process.env, BILLION_CONTEXT_PROXY: origin };
        } else {
            env = buildCodexEnv(origin, codexCaPath, stripInheritedProxy(process.env));
            clientArgs = buildCodexArgs(origin, routes.httpRewrites, routes.httpsRewrites, clientArgs);
            if (!codexRunModePinned(params.clientArgs)) {
                const { command: codexBin, prefixArgs: codexPrefix } = resolveClientCommand(base, process.env, deps.platform ?? process.platform);
                if (codexSupportsNoDaemon(codexBin, codexPrefix, deps.platform ?? process.platform)) {
                    clientArgs = ["--no-daemon", ...clientArgs];
                    console.error("bili: codex pinned to embedded mode (--no-daemon) — the launcher proxy is session-scoped; a shared background server would outlive it and bypass compression.");
                }
            }
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
        }
        // #1802: every routed launch points CODEX_HOME at the overlay so the
        // generated .env pins this launch's proxy/CA against the user's own
        // $CODEX_HOME/.env (load_dotenv overrides spawn env after start);
        // direct-URL launches only need it to carry the MCP server block.
        if (!directUrl || (injectMcp && codexConversationId !== undefined)) {
            const codexRealHome = resolveCodexHome(process.env);
            let inj: ReturnType<typeof prepareCodexMcpInjection>;
            try {
                inj = prepareCodexMcpInjection({
                    codexHome: codexRealHome,
                    origin,
                    caPath: codexCaPath,
                    conversationId: codexConversationId,
                    manageRouting: !directUrl,
                });
            } catch (err) {
                if (!(err instanceof OverlayBusyError)) throw err;
                await abortLaunchOnBusyOverlay(handle, err, deps);
                return;
            }
            if (inj.clientArgs.length > 0) clientArgs = [...inj.clientArgs, ...clientArgs];
            Object.assign(env, inj.envPatch);
            if (inj.warning) console.error(`bili: ${inj.warning}`);
            // #1965: remember the exact home pair this launch used so a clean
            // exit can write the run's data back into the REAL home. Only set
            // when the overlay actually became CODEX_HOME — a failed prepare
            // degrades to running directly on the real home, where nothing
            // needs writing back.
            const activeOverlay = inj.envPatch.CODEX_HOME;
            if (activeOverlay !== undefined) {
                const generated: string[] = [".env"];
                if (codexConversationId !== undefined) generated.push("config.toml");
                codexOverlay = { realHome: codexRealHome, overlay: activeOverlay, generated };
            }
        }
    } else if (base === "codebuddy") {
        env = buildCodebuddyEnv(origin, ca, routes.httpRewrites, routes.httpsRewrites, stripInheritedProxy(process.env));
        const codebuddyBudget = await resolveCodebuddyBudgetEnv({
            model: config.codebuddy?.model,
            userAutoCompactWindow: config.codebuddy?.autoCompactWindow,
            shellAutoCompactWindow: process.env.CODEBUDDY_AUTO_COMPACT_WINDOW,
            routes: biliRoutes,
            upstreamUrl: config.codebuddy?.codebuddyBaseUrl ?? "https://tencent.sso.codebuddy.cn/v2",
        });
        Object.assign(env, codebuddyBudget);
        if (codebuddyBudget.CODEBUDDY_AUTO_COMPACT_WINDOW !== undefined) {
            console.error(`bili: codebuddy budget aligned — CODEBUDDY_AUTO_COMPACT_WINDOW=${codebuddyBudget.CODEBUDDY_AUTO_COMPACT_WINDOW}`);
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
        // #964 coexistence: a native install (`bili plugin install claude`)
        // pins env.ANTHROPIC_BASE_URL to the STABLE port in user settings —
        // without an override claude would dial the static port, where the
        // SessionStart hook deliberately spawns nothing (BILLION_CONTEXT_PROXY
        // is set below), and every model request would fail. Route claude at
        // THIS launcher's own proxy instead: process env + `--settings` JSON
        // both carry the same /bili/ URL (settings precedence: CLI > user, but
        // belt-and-braces covers builds where the settings env block beats
        // inherited process env). The upstream is the user's real relay
        // (BILI_CLAUDE_UPSTREAM beats discovery), UNWRAPPED first — with the
        // native block installed, discovery reads the managed static URL.
        if (claudeNativeInstalled()) {
            const relay = (env.BILI_CLAUDE_UPSTREAM?.trim() || undefined) ?? unwrapUpstream(config.claude?.anthropicBaseUrl ?? "https://api.anthropic.com");
            const override = wrapUpstream(origin, relay);
            env.ANTHROPIC_BASE_URL = override;
            env.BILLION_CONTEXT_PROXY = origin;
            const settingsArg = buildClaudeSettingsArg(deps.platform ?? process.platform, override);
            if (settingsArg.tmpFile) tmpFiles.push(settingsArg.tmpFile);
            clientArgs = [...settingsArg.clientArgs, ...clientArgs];
            console.error(`bili: claude native install detected — overriding its static ANTHROPIC_BASE_URL with this launcher's proxy (${override}); the SessionStart hook stays dormant for this session.`);
        }
        if (injectMcp) {
            const mcpFile = path.join(os.tmpdir(), `bili-mcp-${Date.now()}.json`);
            fs.writeFileSync(mcpFile, JSON.stringify(buildMcpConfig(origin)));
            tmpFiles.push(mcpFile);
            clientArgs = ["--mcp-config", mcpFile, ...clientArgs];
        }
    }

    const { command, prefixArgs } = resolveClientCommand(base, process.env, deps.platform ?? process.platform);
    const effectiveClientArgs = piTestArgs(params.client, clientArgs);
    let code = 0;
    try {
        code = await runClient(command, [...prefixArgs, ...effectiveClientArgs], env, {
            spawnImpl: deps.spawnImpl,
            platform: deps.platform,
        });
    } catch (err) {
        console.error(`bili: failed to launch ${params.client}: ${err instanceof Error ? err.message : String(err)}`);
        code = 1;
    } finally {
        await stopProxyGuarded(handle, deps.fetchHealthInfo ?? fetchHealthInfoDefault);
        // #2195: the exit merge-back must run while this launch STILL holds the
        // exclusive overlay lease — releasing first lets a concurrent launch
        // acquire the overlay and start its own copy/write cycle mid-merge.
        if (gooseOverlay) {
            try {
                finalizeGooseHome(gooseOverlay);
            } catch {}
        }
        if (codexOverlay) {
            try {
                finalizeCodexHome(codexOverlay.realHome, codexOverlay.overlay, codexOverlay.generated);
            } catch {}
        }
        releaseOverlayLease();
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

interface RunTestPiParams {
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
    const handle = await ensureProxyRunning({ host, port, passthrough, debug, lane: "pi", strictPort: port > 0, mitmDomains: domains, modelWindows: collectModelWindows(config, "pi"), modelMaxOutputs: collectModelMaxOutputs(config, "pi") }, deps);
    console.error(
        `bili: started proxy at ${handle.origin} (MITM domains: ${domains.length ? domains.join(", ") : "defaults"})`,
    );
    if (handle.logPath) {
        console.error(`bili: proxy log: ${handle.logPath}`);
    }

    const ca = resolveCaCertPath(process.env);
    const env = buildPiEnv(handle.origin, ca, stripInheritedProxy(process.env));
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
        await stopProxyGuarded(handle, deps.fetchHealthInfo ?? fetchHealthInfoDefault);
    }
    process.exit(code ?? 0);
}
