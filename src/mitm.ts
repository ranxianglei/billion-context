import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { ensureRootCA, getSecureContext } from "./ca.js";
import { connectThroughProxy } from "./upstream-proxy.js";

/** Domains we transparently MITM: the model-inference endpoints of the
 *  providers billion-context targets. Everything else (banking, mail, …) is
 *  pure tunnelled — we never decrypt it. This whitelist is the security
 *  boundary: expanding it expands the set of hosts whose TLS we terminate. */
const DEFAULT_MITM_DOMAINS = [
    "open.bigmodel.cn",
    "api.anthropic.com",
    "api.openai.com",
    "chatgpt.com",
];

/** Socket property that carry the real upstream origin to handle().
 *  handle()'s resolveUpstream reads this so a MITM request (path like
 *  `/api/anthropic/v1/messages`, no `/bili/` prefix) still resolves to the
 *  host the CONNECT tunnel targeted. */
export const MITM_UPSTREAM_KEY = "__biliMitmUpstream";

/** True if `host` should be MITM-decrypted. Matches by exact hostname or a
 *  domain suffix (so `api.openai.com` and `chatgpt.com` both work, and
 *  subdomains like `edge.chatgpt.com` are covered). */
export function isMitmHost(host: string, extra: string[] = []): boolean {
    const h = host.toLowerCase();
    const all = [...DEFAULT_MITM_DOMAINS, ...extra].map((d) => d.toLowerCase());
    return all.some((d) => h === d || h.endsWith("." + d));
}

type Logger = (msg: string) => void;

/** Attach a CONNECT handler to `server` enabling transparent MITM mode.
 *
 *  Flow:
 *    1. Client (ZCode with httpProxy set) issues CONNECT host:443.
 *    2. If host is on the whitelist → terminate TLS locally with a
 *       root-CA-signed cert, then hand the decrypted socket back to the SAME
 *       http server via emit('connection', tlsSocket). The existing handle()
 *       pipeline (prepare* → inject compress → forward) runs unchanged, with
 *       the socket marked so resolveUpstream knows the real upstream.
 *    3. If host is NOT on the whitelist → blind TCP tunnel (CONNECT 200 +
 *       bidirectional pipe). We never see the cleartext.
 *
 *  This means MITM mode reuses 100% of the existing request pipeline — no
 *  second code path for compression/forwarding. */
export function setupMitm(
    server: http.Server,
    extraDomains: string[] = [],
    log: Logger = () => {},
    resolveProxyUrl?: (host: string) => string | undefined,
): void {
    ensureRootCA();
    server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
        const { hostname, port } = parseHostPort(req.url ?? "");
        if (!hostname) {
            clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
            clientSocket.end();
            return;
        }
        const targetPort = port || 443;
        if (!isMitmHost(hostname, extraDomains)) {
            const proxyUrl = resolveProxyUrl?.(hostname);
            tunnelThrough(clientSocket, hostname, targetPort, head, log, proxyUrl);
            return;
        }
        doMitm(server, clientSocket, hostname, targetPort, head, log);
    });
}

function parseHostPort(s: string): { hostname: string; port: number } {
    // req.url in a CONNECT is "host:port".
    const i = s.lastIndexOf(":");
    if (i > 0) {
        const p = parseInt(s.slice(i + 1), 10);
        if (Number.isFinite(p)) return { hostname: s.slice(0, i), port: p };
    }
    return { hostname: s, port: 443 };
}

/** Pure TCP tunnel for non-whitelisted hosts. We establish a connection to the
 *  real upstream and pipe bytes both ways without ever inspecting them.
 *  `proxyUrl` (optional) routes the outbound through an HTTP CONNECT proxy. */
function tunnelThrough(
    clientSocket: net.Socket,
    host: string,
    port: number,
    head: Buffer,
    log: Logger,
    proxyUrl?: string,
): void {
    // Outbound connect: direct, or via HTTP CONNECT proxy if configured. The
    // proxy case is async (handshake) so we bridge with a promise.
    let upstream: net.Socket | undefined;
    let established = false;
    const connectTimer = setTimeout(() => {
        if (!established) {
            log(`tunnel ${host}:${port} connect timeout`);
            clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
            if (upstream) upstream.destroy();
            clientSocket.destroy();
        }
    }, 15000);
    connectThroughProxy(host, port, proxyUrl).then((sock) => {
        upstream = sock;
        upstream.on("connect", () => {
            clearTimeout(connectTimer);
            established = true;
            clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) upstream!.write(head);
            upstream!.pipe(clientSocket);
            clientSocket.pipe(upstream!);
        });
        const cleanup = (where: string, err: Error) => {
            clearTimeout(connectTimer);
            if (!established) {
                log(`tunnel ${host}:${port} ${where} failed: ${err.message}`);
                clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            }
            clientSocket.destroy();
            upstream?.destroy();
        };
        upstream.on("error", (e) => cleanup("upstream", e));
        clientSocket.on("error", (e) => cleanup("client", e));
    }).catch((err: Error) => {
        clearTimeout(connectTimer);
        log(`tunnel ${host}:${port} connect failed: ${err.message}`);
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
    });
}

/** MITM the connection: terminate TLS with our signed cert, then inject the
 *  decrypted socket into the http server as if it were a fresh connection. */
function doMitm(
    server: http.Server,
    clientSocket: net.Socket,
    host: string,
    port: number,
    head: Buffer,
    log: Logger,
): void {
    // Acknowledge the CONNECT first, THEN upgrade. The client waits for 200
    // before starting its TLS handshake, so head is virtually always empty —
    // but if the client pipelined early bytes, push them back so the TLS
    // layer sees them.
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) clientSocket.unshift(head);

    let tlsSocket: tls.TLSSocket;
    try {
        tlsSocket = new tls.TLSSocket(clientSocket, {
            isServer: true,
            secureContext: getSecureContext(host),
            // Force HTTP/1.1 over the tunnel. We only parse HTTP/1; if a client
            // negotiates h2 via ALPN our http parser could not handle it.
            ALPNProtocols: ["http/1.1"],
        });
    } catch (e) {
        log(`mitm ${host}:${port} TLS setup failed: ${(e as Error).message}`);
        clientSocket.destroy();
        return;
    }
    // Mark the socket so resolveUpstream() can recover the real origin. handle()
    // sees the decrypted request as a plain POST /api/anthropic/v1/messages —
    // with this marker it routes to https://<host> instead of the default.
    (tlsSocket as unknown as Record<string, unknown>)[MITM_UPSTREAM_KEY] = `https://${host}`;
    // A TLS handshake error (client rejects our cert, abrupt disconnect,
    // reset) emits "error" on the TLSSocket. Without a listener Node treats
    // it as an uncaught exception and crashes the whole proxy. Destroy the
    // underlying socket and log — mirrors tunnelThrough()'s error handling.
    tlsSocket.on("error", (err: Error) => {
        log(`mitm ${host}:${port} TLS error: ${err.message}`);
        tlsSocket.destroy();
        clientSocket.destroy();
    });
    // Hand the decrypted TLS socket to the http server's connection listener.
    // The server treats it as a new TCP connection and runs its HTTP parser on
    // the cleartext bytes — exactly the same path as a direct (non-proxy)
    // request, so handle()/forward() work unmodified.
    server.emit("connection", tlsSocket);
    log(`mitm ${host}:${port} tunnel established (TLS terminated locally)`);
}

/** Read the MITM upstream marker from a request's underlying socket.
 *  Returns undefined for non-MITM (direct /bili/ or control) requests. */
export function readMitmUpstream(socket: net.Socket | tls.TLSSocket | undefined): string | undefined {
    if (!socket) return undefined;
    return (socket as unknown as Record<string, unknown>)[MITM_UPSTREAM_KEY] as string | undefined;
}
