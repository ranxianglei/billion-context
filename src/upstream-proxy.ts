import { execFileSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import { Pool, ProxyAgent } from "undici";
import type { ProviderRoutes } from "./config.js";
import { log as loggerLog } from "./logger.js";
import { maskHostInText, maskUrlForLog } from "./log-mask.js";
import { upstreamTimeoutMs } from "./fetch-util.js";
import { classifyUpstreamFailure, hintWithSkippedProxy, isTlsTrustCode, redactProxyUrl, tlsTrustRemediation, type SkippedProxyInfo, type UpstreamFailureDetail } from "./upstream-fail.js";
import { presentedCertOf } from "./upstream-cert-probe.js";
import { extraCaConfigured, upstreamCaIdentity, upstreamExtraCa } from "./upstream-ca.js";
import { proxyKeepAliveMaxMs as knobProxyKeepAliveMaxMs } from "./knobs.js";

type ParsedHttpProxy = {
    url: string;
    host: string;
    port: number;
    protocol: "http:" | "https:";
    authorization?: string;
};

export type ProxyFallbackOptions = {
    httpProxy?: string;
    httpsProxy?: string;
    allProxy?: string;
    noProxy?: string;
    biliPort?: number;
    systemProxy?: WindowsSystemProxy;
    globalSource?: "bili-env" | "web-manual" | "config" | "auto" | "direct";
    /** True only when the user EXPLICITLY set proxy mode "direct". The default
     *  unset mode also parses as "direct" but means "no preference" — in that
     *  case an empty globalProxy must fall through to env proxy discovery. */
    explicitDirect?: boolean;
    /** #2809: true only when NO proxy mode was set anywhere (unset → defaults
     *  to direct). Unlike explicitDirect (which gates the SHORT-CIRCUIT), this
     *  only arms the diagnostic peek: a fail-fast failure may name the proxy
     *  the auto chain would have picked. Egress stays direct either way. */
    defaultDirect?: boolean;
};

export type UpstreamProxyDecision = {
    proxy?: string;
    source: string;
    autoConfigUrl?: string;
    /** #2809: set when the decision is default-direct while the auto chain
     *  WOULD have picked a proxy for this host. Diagnostic-only — never read
     *  by egress decisions, only by failure renderers (log/502/alert). */
    skippedProxy?: SkippedProxyInfo;
};

type WindowsSystemProxy = {
    enabled: boolean;
    http?: string;
    https?: string;
    bypass?: string;
    autoConfigUrl?: string;
};

type UpstreamConnectionStatus = {
    url?: string;
    proxy?: string;
    connected?: boolean;
    error?: string;
    checkedAt?: string;
};

const dispatcherCache = new Map<string, ProxyAgent>();
let lastConnection: UpstreamConnectionStatus = {};
let windowsProxyCache: { at: number; value: WindowsSystemProxy } | undefined;

function defaultPort(protocol: string): number {
    return protocol === "https:" ? 443 : 80;
}

function hostIsLoopback(host: string): boolean {
    const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
    return normalized === "localhost" ||
        normalized === "0.0.0.0" ||
        normalized === "::" ||
        normalized === "::1" ||
        normalized === "0:0:0:0:0:0:0:1" ||
        normalized.startsWith("127.") ||
        normalized.startsWith("::ffff:127.") ||
        /^::ffff:7f[0-9a-f]{2}:/.test(normalized);
}

function proxyAuthorization(url: URL): string | undefined {
    if (!url.username && !url.password) return undefined;
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function parseHttpProxy(proxy?: string, biliPort?: number): ParsedHttpProxy | undefined {
    if (!proxy || typeof proxy !== "string" || !proxy.trim()) return undefined;
    const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(proxy.trim()) ? proxy.trim() : `http://${proxy.trim()}`;
    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        return undefined;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return undefined;
    const port = url.port ? Number.parseInt(url.port, 10) : defaultPort(url.protocol);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    if (biliPort && hostIsLoopback(url.hostname) && port === biliPort) {
        throw new Error(`upstream proxy would loop back into bili: ${redactProxyUrl(url.href)}`);
    }
    return {
        url: url.href,
        host: url.hostname,
        port,
        protocol: url.protocol,
        ...(proxyAuthorization(url) ? { authorization: proxyAuthorization(url) } : {}),
    };
}

/** Non-http(s) scheme of a proxy value (e.g. "socks5h"), or undefined when the
 *  value is empty/unparseable/http(s). MUST stay in sync with parseHttpProxy's
 *  schemeless `http://` normalization — otherwise a bare `host:port` would be
 *  flagged unsupported while parseHttpProxy accepts it. */
export function unsupportedProxyScheme(proxy?: string): string | undefined {
    if (!proxy || typeof proxy !== "string" || !proxy.trim()) return undefined;
    const candidate = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(proxy.trim()) ? proxy.trim() : `http://${proxy.trim()}`;
    let url: URL;
    try {
        url = new URL(candidate);
    } catch {
        return undefined;
    }
    return url.protocol === "http:" || url.protocol === "https:" ? undefined : url.protocol.replace(/:$/, "");
}

const warnedUnsupportedSchemes = new Set<string>();

function warnUnsupportedScheme(source: string, value: string, scheme: string): void {
    const key = `${source}\u0000${scheme}`;
    if (warnedUnsupportedSchemes.has(key)) return;
    warnedUnsupportedSchemes.add(key);
    loggerLog("warn", `[upstream-proxy] ignoring ${source}=${redactProxyUrl(value)}: scheme "${scheme}" is not supported — only http:// and https:// proxy origins work. For Clash/mihomo, point bili at the same mixed port over http:// (e.g. http://127.0.0.1:7890).`);
}

export function validateHttpProxy(proxy: string | undefined, biliPort?: number): void {
    if (!proxy?.trim()) return;
    const scheme = unsupportedProxyScheme(proxy);
    if (scheme) {
        throw new Error(`upstream proxy uses unsupported scheme "${scheme}" (${redactProxyUrl(proxy)}) — only http:// and https:// proxies are supported; for Clash/mihomo use the same mixed port over http:// (e.g. http://127.0.0.1:7890)`);
    }
    if (!parseHttpProxy(proxy, biliPort)) {
        throw new Error(`upstream proxy must be an HTTP/HTTPS proxy origin: ${redactProxyUrl(proxy)}`);
    }
}

function targetUrl(upstreamUrl: string | undefined): URL | undefined {
    if (!upstreamUrl) return undefined;
    try {
        return new URL(upstreamUrl.replace(/^mitm:\/\//, "https://"));
    } catch {
        return undefined;
    }
}

function parseFallbackProxy(proxy: string | undefined, biliPort?: number): ParsedHttpProxy | undefined {
    try {
        return parseHttpProxy(proxy, biliPort);
    } catch {
        return undefined;
    }
}

type NoProxyOptions = {
    /** Windows ProxyOverride grammar (#2502): mid-token `*` entries (Clash's default
     *  bypass list is `localhost;127.*;192.168.*;…;<local>`) glob-match the hostname —
     *  `.` stays literal, `*` matches any characters. NO_PROXY lists keep their
     *  conventional grammar where `*` only appears as a standalone item. */
    windowsBypass?: boolean;
};

function wildcardHostMatch(host: string, token: string): boolean {
    const pattern = "^" + token.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
    return new RegExp(pattern).test(host);
}

export function matchesNoProxy(target: URL, noProxy: string | undefined, options: NoProxyOptions = {}): boolean {
    if (!noProxy) return false;
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = target.port ? Number.parseInt(target.port, 10) : defaultPort(target.protocol);
    for (const raw of noProxy.split(/[;,]/)) {
        let token = raw.trim().toLowerCase();
        if (!token) continue;
        if (token === "*") return true;
        if (token === "<local>" && !host.includes(".")) return true;
        let tokenPort: number | undefined;
        if (token.startsWith("[")) {
            const bracket = token.indexOf("]");
            if (bracket > 0 && token[bracket + 1] === ":") {
                tokenPort = Number.parseInt(token.slice(bracket + 2), 10);
                token = token.slice(1, bracket);
            } else token = token.replace(/^\[|\]$/g, "");
        } else {
            const colon = token.lastIndexOf(":");
            if (colon > 0 && token.indexOf(":") === colon && /^\d+$/.test(token.slice(colon + 1))) {
                tokenPort = Number.parseInt(token.slice(colon + 1), 10);
                token = token.slice(0, colon);
            }
        }
        if (tokenPort !== undefined && tokenPort !== port) continue;
        if (options.windowsBypass && !token.startsWith("*") && token.includes("*") && wildcardHostMatch(host, token)) return true;
        const suffix = token.startsWith("*.") ? token.slice(1) : token.startsWith(".") ? token : undefined;
        if (suffix ? host.endsWith(suffix) || host === suffix.slice(1) : host === token) return true;
    }
    return false;
}

function parseWindowsProxyServer(value: string): Pick<WindowsSystemProxy, "http" | "https"> {
    const trimmed = value.trim();
    if (!trimmed) return {};
    if (!trimmed.includes("=")) {
        const normalized = parseHttpProxy(trimmed)?.url;
        return normalized ? { http: normalized, https: normalized } : {};
    }
    const result: Pick<WindowsSystemProxy, "http" | "https"> = {};
    for (const item of trimmed.split(";")) {
        const [scheme, address] = item.split("=", 2).map((part) => part?.trim());
        const normalizedScheme = scheme?.toLowerCase();
        if ((normalizedScheme === "http" || normalizedScheme === "https") && address) {
            const normalized = parseHttpProxy(address)?.url;
            if (normalized) result[normalizedScheme] = normalized;
        }
    }
    return result;
}

function registryValue(output: string, name: string): string | undefined {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return output.match(new RegExp(`^\\s*${escaped}\\s+REG_\\w+\\s+(.+)$`, "mi"))?.[1]?.trim();
}

function readWindowsSystemProxy(): WindowsSystemProxy {
    if (process.platform !== "win32") return { enabled: false };
    const now = Date.now();
    if (windowsProxyCache && now - windowsProxyCache.at < 5000) return windowsProxyCache.value;
    let value: WindowsSystemProxy = { enabled: false };
    try {
        const output = execFileSync("reg", [
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        ], { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
        const enabledRaw = registryValue(output, "ProxyEnable");
        const enabled = enabledRaw === "0x1" || enabledRaw === "1";
        const staticProxy = enabled ? parseWindowsProxyServer(registryValue(output, "ProxyServer") ?? "") : {};
        value = {
            enabled,
            ...staticProxy,
            ...(registryValue(output, "ProxyOverride") ? { bypass: registryValue(output, "ProxyOverride") } : {}),
            ...(registryValue(output, "AutoConfigURL") ? { autoConfigUrl: registryValue(output, "AutoConfigURL") } : {}),
        };
    } catch {
    }
    windowsProxyCache = { at: now, value };
    return value;
}

export function resolveProxyDecision(
    routes: ProviderRoutes,
    globalProxy: string | undefined,
    upstreamUrl: string | undefined,
    fallback: ProxyFallbackOptions = {},
): UpstreamProxyDecision {
    const target = targetUrl(upstreamUrl);
    let bestKey = "";
    if (upstreamUrl) {
        for (const key of Object.keys(routes)) {
            if (upstreamUrl === key || upstreamUrl.startsWith(key + "/")) {
                if (key.length > bestKey.length) bestKey = key;
            }
        }
    }
    if (bestKey) {
        const routeProxy = routes[bestKey].proxy;
        if (routeProxy !== undefined) {
            if (!routeProxy.trim()) return { source: "provider-direct" };
            const parsed = parseHttpProxy(routeProxy, fallback.biliPort);
            if (!parsed) throw new Error(`invalid per-URL upstream proxy for ${bestKey}: ${redactProxyUrl(routeProxy)}`);
            return { proxy: parsed.url, source: "provider" };
        }
    }
    if (globalProxy === "" && fallback.explicitDirect) {
        // #2809: unset mode defaults to direct like explicit "direct", but means
        // "no preference". Peek at what the auto chain WOULD have picked so
        // failure diagnostics can name the skipped proxy. Egress stays direct
        // either way — only the diagnostic payload changes (#346/#357 intact).
        if (!fallback.defaultDirect) return { source: "direct" };
        const peek = autoDetectProxy(target, fallback);
        return peek.proxy ? { source: "direct", skippedProxy: { proxy: peek.proxy, source: peek.source } } : { source: "direct" };
    }
    const explicit = parseHttpProxy(globalProxy, fallback.biliPort)?.url;
    if (explicit) return { proxy: explicit, source: fallback.globalSource ?? "global" };
    return autoDetectProxy(target, fallback);
}

/** Auto-detect tail shared by the normal flow and the #2809 default-direct
 *  peek: NO_PROXY → env tier → Windows bypass → Windows system proxy → direct. */
function autoDetectProxy(target: URL | undefined, fallback: ProxyFallbackOptions): UpstreamProxyDecision {
    if (target && matchesNoProxy(target, fallback.noProxy)) return { source: "no-proxy" };
    const environmentCandidates: Array<[string, string | undefined]> = target?.protocol === "http:"
        ? [["HTTP_PROXY", fallback.httpProxy], ["ALL_PROXY", fallback.allProxy]]
        : [["HTTPS_PROXY", fallback.httpsProxy], ["HTTP_PROXY", fallback.httpProxy], ["ALL_PROXY", fallback.allProxy]];
    for (const [source, value] of environmentCandidates) {
        const parsed = parseFallbackProxy(value, fallback.biliPort);
        if (parsed) return { proxy: parsed.url, source };
        if (!value) continue;
        const scheme = unsupportedProxyScheme(value);
        if (scheme) warnUnsupportedScheme(source, value, scheme);
    }
    const system = fallback.systemProxy ?? readWindowsSystemProxy();
    if (target && matchesNoProxy(target, system.bypass, { windowsBypass: true })) {
        return { source: "windows-bypass", ...(system.autoConfigUrl ? { autoConfigUrl: system.autoConfigUrl } : {}) };
    }
    const systemValue = target?.protocol === "http:" ? system.http : system.https ?? system.http;
    const systemScheme = unsupportedProxyScheme(systemValue);
    if (systemValue && systemScheme) warnUnsupportedScheme("windows-system", systemValue, systemScheme);
    const systemProxy = parseFallbackProxy(systemValue, fallback.biliPort)?.url;
    if (systemProxy) {
        return {
            proxy: systemProxy,
            source: "windows-system",
            ...(system.autoConfigUrl ? { autoConfigUrl: system.autoConfigUrl } : {}),
        };
    }
    return { source: "direct", ...(system.autoConfigUrl ? { autoConfigUrl: system.autoConfigUrl } : {}) };
}

export function resolveProxy(
    routes: ProviderRoutes,
    globalProxy: string | undefined,
    upstreamUrl: string | undefined,
    fallback: ProxyFallbackOptions = {},
): string | undefined {
    return resolveProxyDecision(routes, globalProxy, upstreamUrl, fallback).proxy;
}

/** Keep-alive reuse ceiling for PROXIED dispatchers (#1263): common proxies
 *  recycle idle tunnels on a 60s-ish cadence; undici honors server
 *  Keep-Alive hints up to its 600s max, so a reused-just-recycled socket is
 *  the classic "first request after idle dies with ECONNRESET" pattern.
 *  Capping our reuse window BELOW the common recycle cadence trades a few
 *  reconnects for that failure mode. Default 55s; env-tunable; 0 = uncapped
 *  (undici defaults). Read per call so tests tune it live. */
export const PROXY_KEEPALIVE_MAX_MS = 55_000;

export function proxyKeepAliveMaxMs(): number {
    return knobProxyKeepAliveMaxMs();
}

/** Proxy dispatchers carry the same timeout policy as direct ones (#551):
 *  headersTimeout/bodyTimeout on the ProxyAgent cover every origin pool it
 *  creates (undici spreads its options into the internal Agent), while the
 *  explicit factory/clientFactory set them on hops undici builds with a bare
 *  `{ connect }` option bag (proxy-side CONNECT client, HTTP/1 proxy wrapper).
 *  Proxied pools additionally cap keep-alive reuse (#1263) — see
 *  PROXY_KEEPALIVE_MAX_MS. */
export function proxyDispatcher(proxyUrl: string | undefined, timeoutMs?: number): object | undefined {
    if (!proxyUrl) return undefined;
    const t = timeoutMs ?? upstreamTimeoutMs();
    const ka = proxyKeepAliveMaxMs();
    // #3776: include the CA identity in the key so a configured/rotated network.caFile rotates the cached agent.
    const key = `${proxyUrl}\u0000${t}\u0000${ka}\u0000${upstreamCaIdentity()}`;
    let agent = dispatcherCache.get(key);
    if (!agent) {
        const withTimeouts = (options: object): object => {
            const capped: Record<string, unknown> = { ...options, headersTimeout: t, bodyTimeout: t };
            if (ka > 0) {
                capped.keepAliveTimeout = Math.min(typeof capped.keepAliveTimeout === "number" ? capped.keepAliveTimeout : ka, ka);
                capped.keepAliveMaxTimeout = ka;
            }
            return capped;
        };
        const base = {
            uri: proxyUrl,
            headersTimeout: t,
            bodyTimeout: t,
            factory: (origin: URL, options: object) => new Pool(origin, withTimeouts(options) as ConstructorParameters<typeof Pool>[1]),
            clientFactory: (origin: URL, options: object) => new Pool(origin, withTimeouts(options) as ConstructorParameters<typeof Pool>[1]),
        };
        // #3776: trust the merged CA bundle for end-to-end TLS to the target through the tunnel.
        const ca = upstreamExtraCa();
        const withConnect = ca ? { ...base, connect: { ca } } : base;
        agent = ka > 0
            ? new ProxyAgent({ ...withConnect, keepAliveTimeout: ka, keepAliveMaxTimeout: ka })
            : new ProxyAgent(withConnect);
        dispatcherCache.set(key, agent);
    }
    return agent;
}

export function resetProxyCache(): void {
    for (const agent of dispatcherCache.values()) {
        try { void agent.close().catch(() => undefined); } catch { }
    }
    dispatcherCache.clear();
    lastConnection = {};
}

function openProxySocket(proxy: ParsedHttpProxy): net.Socket {
    if (proxy.protocol === "https:") {
        return tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host });
    }
    return net.connect(proxy.port, proxy.host);
}

const CONNECT_TIMEOUT_MS = 10_000;

// Test seam: lets tests substitute a connect factory that never completes,
// so the direct-path timeout can be asserted in milliseconds instead of
// simulating a black-holed port (ESM namespaces are immutable — the repo's
// established _...ForTest pattern instead of module mocking).
let connectFactory: (port: number, host: string) => net.Socket = (port, host) => net.connect(port, host);

export function _setConnectFactoryForTest(factory: ((port: number, host: string) => net.Socket) | undefined): void {
    connectFactory = factory ?? ((port, host) => net.connect(port, host));
}

/** Plain (non-proxied) outbound TCP connect with a bounded handshake:
 *  a black-holed upstream (firewall drop, routing hole) must fail in seconds,
 *  not after the OS default ~127s (tcp_syn_retries). Mirrors the proxied
 *  branch's 10s handshake timeout (see #78). */
export function connectDirect(host: string, port: number, timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = connectFactory(port, host);
        let settled = false;
        const finishError = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(error);
        };
        const timer = setTimeout(() => finishError(new Error(`upstream connect ${host}:${port} timed out after ${timeoutMs}ms`)), timeoutMs);
        socket.once("error", finishError);
        socket.once("connect", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(socket);
        });
    });
}

export function connectThroughProxy(host: string, port: number, proxyUrl: string | undefined): Promise<net.Socket> {
    if (!proxyUrl) {
        return connectDirect(host, port);
    }
    const proxy = parseHttpProxy(proxyUrl);
    if (!proxy) return Promise.reject(new Error(`invalid upstream proxy: ${redactProxyUrl(proxyUrl)}`));
    return new Promise((resolve, reject) => {
        const socket = openProxySocket(proxy);
        let settled = false;
        const finishError = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(error);
        };
        const timer = setTimeout(() => finishError(new Error(`upstream proxy CONNECT ${host}:${port} handshake timeout`)), CONNECT_TIMEOUT_MS);
        socket.once("error", finishError);
        const connectedEvent = proxy.protocol === "https:" ? "secureConnect" : "connect";
        socket.once(connectedEvent, () => {
            const headers = [
                `CONNECT ${host}:${port} HTTP/1.1`,
                `Host: ${host}:${port}`,
                "Proxy-Connection: Keep-Alive",
                ...(proxy.authorization ? [`Proxy-Authorization: ${proxy.authorization}`] : []),
                "",
                "",
            ];
            socket.write(headers.join("\r\n"));
            let buffer = Buffer.alloc(0);
            const onData = (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                const end = buffer.indexOf("\r\n\r\n");
                if (end < 0) {
                    if (buffer.length > 64 * 1024) finishError(new Error("upstream proxy CONNECT response header is too large"));
                    return;
                }
                socket.removeListener("data", onData);
                const head = buffer.subarray(0, end).toString("latin1");
                const statusLine = head.split("\r\n", 1)[0] ?? "";
                if (!/^HTTP\/1\.[01]\s+2\d\d(?:\s|$)/.test(statusLine)) {
                    finishError(new Error(`upstream proxy CONNECT ${host}:${port} failed: ${statusLine}`));
                    return;
                }
                settled = true;
                clearTimeout(timer);
                socket.removeListener("error", finishError);
                const rest = buffer.subarray(end + 4);
                if (rest.length > 0) socket.unshift(rest);
                resolve(socket);
            };
            socket.on("data", onData);
        });
    });
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
    const chain: Array<Record<string, unknown>> = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current && !seen.has(current)) {
        seen.add(current);
        if (current instanceof Error) {
            const record: Record<string, unknown> = { message: current.message };
            for (const key of ["code", "errno", "syscall", "address", "port"]) {
                const value = (current as unknown as Record<string, unknown>)[key];
                if (value !== undefined) record[key] = value;
            }
            chain.push(record);
            current = current.cause;
        } else {
            chain.push({ message: String(current) });
            break;
        }
    }
    return chain;
}

// #4403 P0-1: enterprise-interception signals available IN-PROCESS. A trust-code
// TLS failure is ambiguous between "scanner/corporate MITM re-signed it" and
// "hijacked DNS presented a forged cert"; these are the two in-process facts
// that tilt toward the former — a proxy in the path sitting on loopback/private
// space (corporate inspection proxies live there) or extra CA material already
// configured (the user is already on the trust-the-vendor-root path). When
// neither holds, the remediation must say "verify DNS first", not "install it".
export function tlsEnterpriseSignal(proxyUrl: string | undefined): boolean {
    if (extraCaConfigured()) return true;
    if (!proxyUrl) return false;
    try {
        return isLocalProxyTarget(new URL(proxyUrl).hostname);
    } catch {
        return false;
    }
}

function isLocalProxyTarget(host: string): boolean {
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^f[cd][0-9a-f]{2}:?/i.test(host) || /^fe80:/i.test(host)) return true;
    return false;
}

interface UpstreamFailureParts {
    /** Formatted one-line failure string (log line / 502 `detail` / circuit banner). */
    message: string;
    /** Machine-readable slice (#3776 sub-defect 3) surfaced in the egress 502 body. */
    detail: UpstreamFailureDetail;
}

export function describeUpstreamFailure(error: unknown, url: string, proxyUrl?: string, skipped?: SkippedProxyInfo): UpstreamFailureParts {
    const chain = errorChain(error);
    const kind = classifyUpstreamFailure(error, { viaProxy: proxyUrl !== undefined });
    const fields = ["code", "errno", "syscall", "address", "port"];
    const parts: string[] = [`kind=${kind}`];
    // Error text from undici/OS layers embeds the endpoint identity
    // ("connect ECONNREFUSED 10.0.0.5:8443", "getaddrinfo ENOTFOUND
    // relay.internal") — swap in the placeholder when the upstream is a
    // non-public host so the failure log leaks nothing either.
    const maskHostIn = (s: string): string => {
        try {
            return maskHostInText(s, new URL(url).hostname);
        } catch { /* not a URL — nothing to mask */ }
        return s;
    };
    let codeValue: unknown;
    for (const field of fields) {
        const value = chain.find((entry) => entry[field] !== undefined)?.[field];
        if (value !== undefined) {
            if (field === "code" && codeValue === undefined) codeValue = value;
            parts.push(`${field}=${maskHostIn(String(value))}`);
        }
    }
    const messages = chain.map((entry) => maskHostIn(String(entry.message ?? ""))).filter(Boolean);
    if (messages.length > 0) parts.push(`message=${messages.join(" <- ")}`);
    parts.push(`url=${maskUrlForLog(url)}`);
    parts.push(`proxy=${redactProxyUrl(proxyUrl) ?? "direct"}`);
    let hint = hintWithSkippedProxy(kind, skipped);
    // #3776/#4403: only TRUST-code TLS failures (interception/MITM) get the
    // detailed remediation — a plain protocol break (EPROTO) does not. The text
    // is branch-selected on the fired code + probe-captured cert + enterprise
    // signal so it never leads with "install the presented CA" under hijacking.
    // Flows to log line, 502 body, circuit banner.
    const trustCodeEntry = kind === "tls" ? chain.find((entry) => isTlsTrustCode(entry.code)) : undefined;
    const cert = trustCodeEntry !== undefined ? presentedCertOf(url) : undefined;
    if (trustCodeEntry !== undefined) {
        const trustCode = String(trustCodeEntry.code);
        let hostname: string | undefined;
        try { hostname = new URL(url).hostname; } catch { /* not a URL — nothing to cross-check */ }
        hint = `${hint}; ${tlsTrustRemediation({ code: trustCode, hostname, enterpriseSignal: tlsEnterpriseSignal(proxyUrl), ...(cert ? { cert } : {}) })}`;
        // #4403 P0-2: forensic certificate fields ride the free-text line AND
        // the structured 502 slice — the operator can tell "enterprise scanner"
        // from "link injection" in the log without reaching for openssl s_client.
        if (cert) {
            if (cert.remoteAddress !== undefined) parts.push(`probeRemote=${maskHostIn(cert.remoteAddress)}`);
            if (cert.subject !== undefined) parts.push(`certSubject="${maskHostIn(cert.subject)}"`);
            if (cert.issuer !== undefined) parts.push(`certIssuer="${maskHostIn(cert.issuer)}"`);
            if (cert.san !== undefined) parts.push(`certSan=[${maskHostIn(cert.san.join(", "))}]`);
            if (cert.fingerprint256 !== undefined) parts.push(`certFp256=${cert.fingerprint256}`);
        }
    }
    parts.push(`hint=${hint}`);
    const forensics = trustCodeEntry !== undefined && cert
        ? {
            ...(cert.remoteAddress !== undefined ? { remoteAddress: cert.remoteAddress } : {}),
            ...(cert.subject !== undefined ? { certSubject: cert.subject } : {}),
            ...(cert.issuer !== undefined ? { certIssuer: cert.issuer } : {}),
            ...(cert.san !== undefined ? { certSan: cert.san } : {}),
            ...(cert.fingerprint256 !== undefined ? { certFingerprint256: cert.fingerprint256 } : {}),
        }
        : {};
    return { message: parts.join(" "), detail: { kind, ...(codeValue !== undefined ? { code: String(codeValue) } : {}), hint, ...forensics } };
}

export function formatUpstreamError(error: unknown, url: string, proxyUrl?: string, skipped?: SkippedProxyInfo): string {
    return describeUpstreamFailure(error, url, proxyUrl, skipped).message;
}

export function recordUpstreamConnection(url: string, proxyUrl: string | undefined, error?: unknown, skipped?: SkippedProxyInfo): void {
    lastConnection = {
        url,
        proxy: redactProxyUrl(proxyUrl),
        connected: error === undefined,
        ...(error === undefined ? {} : { error: formatUpstreamError(error, url, proxyUrl, skipped) }),
        checkedAt: new Date().toISOString(),
    };
}

export function getUpstreamConnectionStatus(): UpstreamConnectionStatus {
    return { ...lastConnection };
}

export function _resetUpstreamProxyForTest(): void {
    resetProxyCache();
    lastConnection = {};
    windowsProxyCache = undefined;
    warnedUnsupportedSchemes.clear();
}
