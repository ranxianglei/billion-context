/**
 * Upstream proxy support.
 *
 * Allows billion-context to route its OWN outbound connections (to the model
 * providers) through an HTTP proxy. Typical use case: a Codex user behind the
 * GFW already runs v2rayA; configuring billion-context's upstream proxy lets
 * `api.openai.com` traffic reach the model instead of timing out.
 *
 * TWO outbound paths must support this:
 *   1. `/bili/` path-mode requests — forwarded via `fetch()`. We inject an
 *      undici `ProxyAgent` as the fetch `dispatcher`.
 *   2. MITM mode — `CONNECT <host>:443` tunnels. We establish the outbound
 *      connection by talking CONNECT to the proxy, then run TLS over the
 *      resulting tunnel.
 *
 * Only HTTP proxies are supported (`http://host:port`). SOCKS5 is intentionally
 * out of scope for now.
 */
import net from "node:net";
import tls from "node:tls";
import { ProxyAgent } from "undici";
import type { ProviderRoutes } from "./config.js";

/** Per-URL proxy cache so we don't construct a new ProxyAgent per request. */
const dispatcherCache = new Map<string, ProxyAgent>();

/** Parse a proxy URL. Returns undefined if `proxy` is empty or not an http(s)
 *  URL (we only support HTTP forward proxies, not SOCKS, for now). */
export function parseHttpProxy(proxy?: string): { url: string; host: string; port: number } | undefined {
    if (!proxy || typeof proxy !== "string") return undefined;
    try {
        const u = new URL(proxy);
        // We accept http:// (standard HTTP forward proxy). https:// would mean
        // TLS to the proxy itself — uncommon for local proxies; reject to keep
        // the MITM path simple. socks5:// is not supported yet.
        if (u.protocol !== "http:") return undefined;
        const port = u.port ? parseInt(u.port, 10) : 80;
        if (!Number.isFinite(port)) return undefined;
        return { url: `${u.protocol}//${u.hostname}:${port}`, host: u.hostname, port };
    } catch {
        return undefined;
    }
}

/**
 * Resolve the effective proxy for a given upstream URL.
 *
 * Rule: per-URL `route.proxy` overrides the global `globalProxy`. Neither set
 * → undefined (direct connect). Uses the same longest-prefix match as
 * resolveContextLimit so `https://api.openai.com/v1` and a MITM virtual URL
 * `https://api.openai.com` both match a key like `https://api.openai.com`.
 */
export function resolveProxy(
    routes: ProviderRoutes,
    globalProxy: string | undefined,
    upstreamUrl: string | undefined,
): string | undefined {
    if (!upstreamUrl) return parseHttpProxy(globalProxy)?.url;
    let bestKey = "";
    for (const key of Object.keys(routes)) {
        if (upstreamUrl === key || upstreamUrl.startsWith(key + "/")) {
            if (key.length > bestKey.length) bestKey = key;
        }
    }
    // Child overrides parent. Empty string on the route means "explicitly
    // direct" (override the global). Otherwise fall back to global.
    if (bestKey) {
        const routeProxy = routes[bestKey].proxy;
        if (routeProxy !== undefined) return parseHttpProxy(routeProxy)?.url;
    }
    return parseHttpProxy(globalProxy)?.url;
}

/** Get (or create) a cached undici ProxyAgent for `proxyUrl`. Returns undefined
 *  for direct connect. Used by the fetch (`/bili/`) path. Returned as a plain
 *  object so callers don't need to import the undici Dispatcher type.
 *  Call `resetProxyCache()` on config hot-reload to release ProxyAgents whose
 *  URL was removed/changed (otherwise they'd leak for the process lifetime). */
export function proxyDispatcher(proxyUrl: string | undefined): object | undefined {
    if (!proxyUrl) return undefined;
    let agent = dispatcherCache.get(proxyUrl);
    if (!agent) {
        agent = new ProxyAgent({ uri: proxyUrl });
        dispatcherCache.set(proxyUrl, agent);
    }
    return agent;
}

/** Release all cached ProxyAgents. Called on config hot-reload so agents for
 *  proxy URLs that were removed/changed don't leak. Safe to call anytime;
 *  the next proxyDispatcher() call re-creates the needed agent lazily. */
export function resetProxyCache(): void {
    for (const agent of dispatcherCache.values()) {
        try { agent.close(); } catch { /* best-effort */ }
    }
    dispatcherCache.clear();
}

/** Establish a TCP connection to `host:port`, through an HTTP proxy if one is
 *  configured. `proxyUrl` is the resolved proxy (from resolveProxy) or
 *  undefined for direct connect.
 *
 *  For direct connect: `net.connect(port, host)`.
 *  For proxied connect: connect to the proxy, send
 *    `CONNECT host:port HTTP/1.1\r\nHost: host:port\r\n\r\n`, wait for
 *    `HTTP/1.1 200`, then return the socket (the tunnel is now transparent).
 *  Throws on any failure (proxy refused, non-200, connection reset). */
export function connectThroughProxy(
    host: string,
    port: number,
    proxyUrl: string | undefined,
): Promise<net.Socket> {
    if (!proxyUrl) {
        // Direct connect — the common, fast path.
        return new Promise((resolve, reject) => {
            const sock = net.connect(port, host);
            sock.once("connect", () => resolve(sock));
            sock.once("error", reject);
        });
    }
    const proxy = parseHttpProxy(proxyUrl);
    if (!proxy) {
        // Malformed proxy URL — fall back to direct rather than crash.
        return new Promise((resolve, reject) => {
            const sock = net.connect(port, host);
            sock.once("connect", () => resolve(sock));
            sock.once("error", reject);
        });
    }
    return new Promise((resolve, reject) => {
        const sock = net.connect(proxy.port, proxy.host);
        let established = false;
        // Internal timeout for the CONNECT handshake (proxy → upstream). If the
        // proxy is slow/unresponsive the outer 15s tunnel timer would still
        // fire, but a dedicated handshake timeout fails faster and surfaces a
        // clearer error ("CONNECT handshake timeout") in the log.
        const handshakeTimer = setTimeout(() => {
            if (!established) {
                sock.destroy();
                reject(new Error(`upstream proxy CONNECT ${host}:${port} handshake timeout`));
            }
        }, 10000);
        const cleanup = (err: Error) => {
            clearTimeout(handshakeTimer);
            if (!established) sock.destroy();
            reject(err);
        };
        sock.once("error", cleanup);
        sock.once("connect", () => {
            // Send CONNECT to the proxy to open a tunnel to host:port.
            const connectReq =
                `CONNECT ${host}:${port} HTTP/1.1\r\n` +
                `Host: ${host}:${port}\r\n` +
                `Proxy-Connection: Keep-Alive\r\n\r\n`;
            sock.write(connectReq);
            // Read the proxy's HTTP response. We only need the status line +
            // the blank-line terminator; body (if any) is not expected for a
            // successful CONNECT.
            let buf = "";
            const onLine = (data: Buffer) => {
                buf += data.toString("utf8");
                const end = buf.indexOf("\r\n\r\n");
                if (end === -1) return;
                sock.removeListener("data", onLine);
                const head = buf.slice(0, end);
                const rest = Buffer.from(buf.slice(end + 4), "utf8");
                // Status line: "HTTP/1.1 200 Connection Established\r\n..."
                const statusLine = head.split("\r\n")[0] ?? "";
                if (!/^HTTP\/1\.[01]\s+2\d\d/.test(statusLine)) {
                    cleanup(new Error(`upstream proxy CONNECT ${host}:${port} failed: ${statusLine}`));
                    return;
                }
                established = true;
                clearTimeout(handshakeTimer);
                // If the proxy pipelined any early bytes after the 200, push
                // them back so the TLS handshake sees them.
                if (rest.length > 0) sock.unshift(rest);
                resolve(sock);
            };
            sock.on("data", onLine);
            sock.once("error", cleanup);
        });
    });
}

/** Connect to `host:port` over TLS, through a proxy if configured. Used by the
 *  MITM path: after terminating the client's TLS, we re-establish a TLS
 *  connection to the REAL upstream. If a proxy is configured, the TLS runs
 *  over a CONNECT tunnel to that proxy. */
export async function connectTlsThroughProxy(
    host: string,
    port: number,
    proxyUrl: string | undefined,
    servername?: string,
): Promise<tls.TLSSocket> {
    const sock = await connectThroughProxy(host, port, proxyUrl);
    return tls.connect({
        socket: sock,
        servername: servername ?? host,
        // Let Node pick ALPN; we must accept h2 here because the real upstream
        // (api.openai.com etc.) may negotiate it and we forward raw bytes in
        // the blind-tunnel path. The MITM-decrypt path forces http/1.1 on the
        // CLIENT side but the UPSTREAM side can be anything.
    });
}
