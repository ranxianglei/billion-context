import { execFileSync } from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import { ProxyAgent } from "undici";
import type { ProviderRoutes } from "./config.js";

export type ParsedHttpProxy = {
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
};

export type UpstreamProxyDecision = {
    proxy?: string;
    source: string;
    autoConfigUrl?: string;
};

export type WindowsSystemProxy = {
    enabled: boolean;
    http?: string;
    https?: string;
    bypass?: string;
    autoConfigUrl?: string;
};

export type UpstreamConnectionStatus = {
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

export function redactProxyUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        if (url.username || url.password) {
            url.username = "***";
            url.password = "***";
        }
        return url.href;
    } catch {
        return "(invalid proxy URL)";
    }
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

export function validateHttpProxy(proxy: string | undefined, biliPort?: number): void {
    if (!proxy?.trim()) return;
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

export function matchesNoProxy(target: URL, noProxy: string | undefined): boolean {
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

export function readWindowsSystemProxy(): WindowsSystemProxy {
    if (process.platform !== "win32") return { enabled: false };
    const now = Date.now();
    if (windowsProxyCache && now - windowsProxyCache.at < 5000) return windowsProxyCache.value;
    let value: WindowsSystemProxy = { enabled: false };
    try {
        const output = execFileSync("reg", [
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
        ], { encoding: "utf8", windowsHide: true, timeout: 3000 });
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
    if (globalProxy === "" && fallback.explicitDirect) return { source: "direct" };
    const explicit = parseHttpProxy(globalProxy, fallback.biliPort)?.url;
    if (explicit) return { proxy: explicit, source: fallback.globalSource ?? "global" };
    if (target && matchesNoProxy(target, fallback.noProxy)) return { source: "no-proxy" };
    const environmentCandidates: Array<[string, string | undefined]> = target?.protocol === "http:"
        ? [["HTTP_PROXY", fallback.httpProxy], ["ALL_PROXY", fallback.allProxy]]
        : [["HTTPS_PROXY", fallback.httpsProxy], ["HTTP_PROXY", fallback.httpProxy], ["ALL_PROXY", fallback.allProxy]];
    for (const [source, value] of environmentCandidates) {
        const parsed = parseFallbackProxy(value, fallback.biliPort);
        if (parsed) return { proxy: parsed.url, source };
    }
    const system = fallback.systemProxy ?? readWindowsSystemProxy();
    if (target && matchesNoProxy(target, system.bypass)) {
        return { source: "windows-bypass", ...(system.autoConfigUrl ? { autoConfigUrl: system.autoConfigUrl } : {}) };
    }
    const systemValue = target?.protocol === "http:" ? system.http : system.https ?? system.http;
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

export function proxyDispatcher(proxyUrl: string | undefined): object | undefined {
    if (!proxyUrl) return undefined;
    let agent = dispatcherCache.get(proxyUrl);
    if (!agent) {
        agent = new ProxyAgent({ uri: proxyUrl });
        dispatcherCache.set(proxyUrl, agent);
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

export async function connectTlsThroughProxy(
    host: string,
    port: number,
    proxyUrl: string | undefined,
    servername?: string,
): Promise<tls.TLSSocket> {
    const socket = await connectThroughProxy(host, port, proxyUrl);
    return tls.connect({ socket, servername: servername ?? host });
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

export function formatUpstreamError(error: unknown, url: string, proxyUrl?: string): string {
    const chain = errorChain(error);
    const fields = ["code", "errno", "syscall", "address", "port"];
    const parts: string[] = [];
    for (const field of fields) {
        const value = chain.find((entry) => entry[field] !== undefined)?.[field];
        if (value !== undefined) parts.push(`${field}=${String(value)}`);
    }
    const messages = chain.map((entry) => String(entry.message ?? "")).filter(Boolean);
    if (messages.length > 0) parts.push(`message=${messages.join(" <- ")}`);
    parts.push(`url=${url}`);
    parts.push(`proxy=${redactProxyUrl(proxyUrl) ?? "direct"}`);
    return parts.join(" ");
}

export function recordUpstreamConnection(url: string, proxyUrl: string | undefined, error?: unknown): void {
    lastConnection = {
        url,
        proxy: redactProxyUrl(proxyUrl),
        connected: error === undefined,
        ...(error === undefined ? {} : { error: formatUpstreamError(error, url, proxyUrl) }),
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
}
