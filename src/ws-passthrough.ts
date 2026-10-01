import type http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { readMitmUpstream } from "./mitm.js";
import { connectThroughProxy, resolveProxy, type ProxyFallbackOptions } from "./upstream-proxy.js";
import { checkTunnelDestination, type TunnelCheckContext } from "./tunnel-guard.js";
import { maskUrlsInText } from "./log-mask.js";
import type { ProviderRoutes } from "./config.js";

// #1467 Phase 1: opt-in transparent WebSocket relay. When ws.passthrough is
// enabled, a WS upgrade addressed to the proxy is replayed to the real
// upstream and — on 101 — the two sides are piped as OPAQUE byte streams.
// Frames are never parsed (no protocol dependency), which is precisely why
// these sessions get NO compression; everything else in the pipeline is
// untouched. Default config never reaches this code: the upgrade listener
// keeps answering the Codex fast-fallback 426 (#2).

const WS_HANDSHAKE_TIMEOUT_MS = 15_000;
const HEAD_MAX_BYTES = 64 * 1024;

export interface WsDestination {
    /** Canonical origin of the real upstream, e.g. `wss://api.openai.com`. */
    origin: string;
    /** Origin-form path+query to request on the upstream. */
    targetPath: string;
    /** Authority for the replayed Host header. */
    hostHeader: string;
    /** True when the connection was MITM-terminated: the destination was
     *  already admitted at CONNECT time (whitelist + client-class gates), so
     *  the /bili/-style tunnel admission must NOT run again here. */
    viaMitm: boolean;
}

/** Resolve where a WebSocket upgrade should be relayed. Returns undefined for
 *  anything unroutable — plain origin-form paths (no destination can be
 *  inferred), non-ws(s) URLs, malformed input — and the caller falls back to
 *  the standard 426 answer.
 *
 *  Supported forms:
 *   - MITM-terminated socket (marker stamped by doMitm): the decrypted
 *     request's origin-form path against the CONNECT'd model host.
 *   - `/bili/ws(s)://host[:port]/path[?query]` zero-config embedded form.
 *   - absolute-form `ws(s)://host[:port]/path[?query]`. */
export function resolveWsDestination(req: http.IncomingMessage, socket: net.Socket | undefined): WsDestination | undefined {
    const mitmUpstream = readMitmUpstream(socket);
    if (mitmUpstream) {
        let markerHost: string;
        try {
            markerHost = new URL(mitmUpstream).host;
        } catch {
            return undefined;
        }
        if (!markerHost) return undefined;
        let targetPath = req.url ?? "/";
        if (!targetPath.startsWith("/")) {
            try {
                const u = new URL(targetPath);
                targetPath = `${u.pathname}${u.search}`;
            } catch {
                return undefined;
            }
        }
        return { origin: `wss://${markerHost}`, targetPath, hostHeader: markerHost, viaMitm: true };
    }
    let target = req.url ?? "";
    if (target.startsWith("/bili/")) target = target.slice("/bili/".length);
    let u: URL;
    try {
        u = new URL(target);
    } catch {
        return undefined;
    }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return undefined;
    if (!u.host) return undefined;
    return { origin: `${u.protocol}//${u.host}`, targetPath: `${u.pathname}${u.search}`, hostHeader: u.host, viaMitm: false };
}

export interface WsUpgradeDeps extends TunnelCheckContext {
    routes: ProviderRoutes;
    proxy?: string;
    proxyFallback?: ProxyFallbackOptions;
    log: (level: string, msg: string) => void;
}

/** Rebuild the handshake request head for the upstream: every inbound header
 *  verbatim except Host (replaced by the destination authority) and proxy
 *  hop-by-hop headers that must not be forwarded onward. Header names keep
 *  Node's lowercased form, which is wire-legal. */
export function buildUpgradeHead(req: http.IncomingMessage, targetPath: string, hostHeader: string): string {
    const lines = [`${req.method ?? "GET"} ${targetPath} HTTP/1.1`];
    for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (lower === "host" || lower === "proxy-authorization" || lower.startsWith("proxy-")) continue;
        if (lower === "x-forwarded-for" || lower === "x-forwarded-host" || lower === "x-forwarded-proto" || lower === "x-real-ip") continue;
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    lines.push(`Host: ${hostHeader}`);
    return lines.join("\r\n") + "\r\n\r\n";
}

function readResponseHead(socket: net.Socket, timeoutMs: number): Promise<{ head: string; rest: Buffer }> {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0);
        const timer = setTimeout(() => fail(new Error(`upstream handshake response timed out after ${timeoutMs}ms`)), timeoutMs);
        function fail(err: Error): void {
            clearTimeout(timer);
            socket.removeListener("data", onData);
            socket.removeListener("error", onError);
            reject(err);
        }
        function onData(chunk: Buffer): void {
            buf = Buffer.concat([buf, chunk]);
            const idx = buf.indexOf("\r\n\r\n");
            if (idx !== -1) {
                clearTimeout(timer);
                socket.removeListener("data", onData);
                socket.removeListener("error", onError);
                resolve({ head: buf.subarray(0, idx + 4).toString("latin1"), rest: buf.subarray(idx + 4) });
            } else if (buf.length > HEAD_MAX_BYTES) {
                fail(new Error("upstream response head exceeds 64KB"));
            }
        }
        function onError(err: Error): void {
            fail(err);
        }
        socket.on("data", onData);
        socket.on("error", onError);
    });
}

function wrapTls(raw: net.Socket, host: string, timeoutMs: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            raw.destroy();
            reject(new Error(`TLS handshake timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const secure = tls.connect({ socket: raw, host, servername: net.isIP(host) ? undefined : host }, () => {
            clearTimeout(timer);
            resolve(secure);
        });
        secure.once("error", (err) => {
            clearTimeout(timer);
            secure.destroy();
            reject(err);
        });
    });
}

function sendErrorAndClose(client: net.Socket, status: string, message: string): void {
    if (client.destroyed) return;
    const body = JSON.stringify({ error: message });
    try {
        client.end(
            `HTTP/1.1 ${status}\r\n` +
            "Connection: close\r\n" +
            "Content-Type: application/json\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            "\r\n" +
            body,
        );
    } catch {
        client.destroy();
    }
}

/** Handle one WebSocket upgrade when ws.passthrough is enabled. Returns true
 *  when the upgrade was consumed (relayed, denied, or answered with an error)
 *  and false when it is unroutable — the caller then answers the standard 426. */
export async function handleWsUpgrade(req: http.IncomingMessage, client: net.Socket, deps: WsUpgradeDeps, head: Buffer = Buffer.alloc(0)): Promise<boolean> {
    const dest = resolveWsDestination(req, client);
    if (!dest) return false;
    client.on("error", () => {}); // client may vanish mid-write; don't let ECONNRESET crash the process

    if (!dest.viaMitm) {
        const verdict = await checkTunnelDestination(dest.origin, deps);
        if (!verdict.ok) {
            deps.log("warn", `[ws] denied ${maskUrlsInText(dest.origin)}: ${verdict.message}`);
            sendErrorAndClose(client, "403 Forbidden", verdict.message);
            return true;
        }
    }

    let u: URL;
    try {
        u = new URL(dest.origin);
    } catch {
        sendErrorAndClose(client, "502 Bad Gateway", "WebSocket upgrade: invalid upstream destination");
        return true;
    }
    const port = u.port !== "" ? Number(u.port) : u.protocol === "wss:" ? 443 : 80;

    let upstream: net.Socket;
    try {
        const proxyUrl = resolveProxy(deps.routes, deps.proxy, dest.origin, deps.proxyFallback);
        upstream = await connectThroughProxy(u.hostname, port, proxyUrl);
        if (client.destroyed) {
            upstream.destroy();
            return true;
        }
        if (u.protocol === "wss:") {
            upstream = await wrapTls(upstream, u.hostname, WS_HANDSHAKE_TIMEOUT_MS);
            if (client.destroyed) {
                upstream.destroy();
                return true;
            }
        }
    } catch (err) {
        deps.log("warn", `[ws] upstream connect failed ${maskUrlsInText(dest.origin)}: ${String(err)}`);
        sendErrorAndClose(client, "502 Bad Gateway", "WebSocket upgrade: upstream connection failed");
        return true;
    }

    upstream.write(buildUpgradeHead(req, dest.targetPath, dest.hostHeader));
    // Bytes the client pipelined behind its handshake request (Node hands them
    // over as the upgrade event's `head`): compliant clients send none, but a
    // pipelining client's early frames must not be silently dropped.
    if (head.length > 0) upstream.write(head);

    let headInfo: { head: string; rest: Buffer };
    try {
        headInfo = await readResponseHead(upstream, WS_HANDSHAKE_TIMEOUT_MS);
    } catch (err) {
        deps.log("warn", `[ws] handshake read failed ${maskUrlsInText(dest.origin)}: ${String(err)}`);
        upstream.destroy();
        sendErrorAndClose(client, "502 Bad Gateway", "WebSocket upgrade: upstream handshake failed");
        return true;
    }

    const statusLine = headInfo.head.split("\r\n", 1)[0] ?? "";
    const statusMatch = /^HTTP\/\d+\.\d+ (\d{3})(?: (.+))?$/.exec(statusLine);
    const status = statusMatch ? Number(statusMatch[1]) : 0;
    const reason = statusMatch?.[2] ?? "";

    client.write(headInfo.head);
    if (headInfo.rest.length > 0) client.write(headInfo.rest);

    if (status === 101) {
        // Opaque bidirectional pipe — frames pass through unexamined, so this
        // session gets NO compression (documented loudly at boot #1467).
        upstream.pipe(client);
        client.pipe(upstream);
        deps.log("info", `[ws] passthrough established ${maskUrlsInText(dest.origin)} (opaque relay, NO compression)`);
        const closeLog = (label: string): void => deps.log("debug", `[ws] relay closed (${label}) ${maskUrlsInText(dest.origin)}`);
        upstream.once("close", () => {
            closeLog("upstream");
            client.destroy();
        });
        client.once("close", () => {
            closeLog("client");
            upstream.destroy();
        });
        upstream.on("error", (err) => {
            deps.log("warn", `[ws] relay upstream error ${maskUrlsInText(dest.origin)}: ${String(err)}`);
            client.destroy();
        });
        client.on("error", (err) => {
            deps.log("warn", `[ws] relay client error ${maskUrlsInText(dest.origin)}: ${String(err)}`);
            upstream.destroy();
        });
    } else {
        // Honest propagation: the upstream's refusal IS the answer — forward
        // it verbatim instead of masking it behind a generic failure.
        upstream.pipe(client);
        upstream.once("close", () => client.destroy());
        client.once("close", () => upstream.destroy());
        deps.log("info", `[ws] upstream answered ${status} ${reason} to ${maskUrlsInText(dest.origin)} — forwarded verbatim (no upgrade)`);
    }
    return true;
}
