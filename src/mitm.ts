import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { ensureRootCA, getSecureContext } from "./ca.js";
import { connectThroughProxy } from "./upstream-proxy.js";
import { discoverMitmDomains } from "./discover.js";
import { isLoopbackAddress } from "./util.js";
import { maskHostForLog, maskHostPortForLog } from "./log-mask.js";

// Domains we transparently MITM. These are ONLY the model-inference endpoints
// hardcoded in client BINARIES with no config file to discover from
// (Claude=api.anthropic.com, codex-login=api.openai.com/chatgpt.com).
// Everything else is auto-discovered at runtime from each client's config
// (see discoverMitmDomains). Expanding this list expands the set of hosts
// whose TLS we terminate — the security boundary.
export const DEFAULT_MITM_DOMAINS = [
    "api.anthropic.com",
    "api.openai.com",
    "chatgpt.com",
];

/** Socket marker: when we MITM a CONNECT tunnel, we stash the original
 *  host the CONNECT tunnel targeted. */
export const MITM_UPSTREAM_KEY = "__biliMitmUpstream";

/** Max ms to wait for a MITM client to finish the TLS handshake after we
 *  return CONNECT 200. Bounds slowloris-style resource hold (a client that
 *  opens the tunnel but never sends/trickle-feeds its ClientHello).
 *  Env-overridable so tests can exercise the timeout path quickly. */
const MITM_HANDSHAKE_TIMEOUT_MS_DEFAULT = 10_000;
function mitmHandshakeTimeoutMs(): number {
    const v = Number.parseInt(process.env.BILI_MITM_HANDSHAKE_TIMEOUT_MS ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : MITM_HANDSHAKE_TIMEOUT_MS_DEFAULT;
}

/** True if `host` should be MITM-decrypted. Matches by exact hostname or a
 *  domain suffix (so `api.openai.com` and `chatgpt.com` both work, and
 *  subdomains like `edge.chatgpt.com` are covered). The candidate set is the
 *  binary-hardcoded DEFAULT_MITM_DOMAINS + caller-supplied extras + domains
 *  auto-discovered from client config files (see discoverMitmDomains). */
export function isMitmHost(host: string, extraDomains: string[] = []): boolean {
    const h = host.toLowerCase();
    const all = [...DEFAULT_MITM_DOMAINS, ...extraDomains, ...discoverMitmDomains()].map((d) => d.toLowerCase());
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
 *  Remote-client policy (#240): loopback clients get the full behavior above.
 *  When the server is explicitly bound to a non-loopback host
 *  (`--host 0.0.0.0` / LAN IP), `allowRemoteClients` lets remote clients use
 *  CONNECT — but ONLY for MITM-whitelisted hosts. Blind tunnels stay
 *  loopback-only so the proxy can never serve as an open TCP relay.
 *
 *  This means MITM mode reuses 100% of the existing request pipeline — no
 *  second code path for compression/forwarding. */
export function setupMitm(
    server: http.Server,
    extraDomains: string[] = [],
    log: Logger = () => {},
    resolveProxyUrl?: (host: string) => string | undefined,
    allowRemoteClients = false,
): void {
    ensureRootCA();
    server.on("connect", (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
        const remote = !isLoopbackAddress(clientSocket.remoteAddress);
        if (remote && !allowRemoteClients) {
            log(`CONNECT ${maskHostPortForLog(req.url ?? "")} rejected: non-loopback client ${clientSocket.remoteAddress} (bind a non-loopback --host to allow remote clients)`);
            // end() (not write+destroy) so the 403 bytes are flushed before close.
            clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
        }
        const { hostname, port } = parseHostPort(req.url ?? "");
        const targetPort = port || 443;
        if (!isMitmHost(hostname, extraDomains)) {
            if (remote) {
                // Blind tunnels are a loopback-only convenience: a remote
                // client must not use this proxy as an open TCP relay to
                // arbitrary hosts. Remote CONNECT is for MITM-whitelisted
                // model endpoints only.
                log(`CONNECT ${maskHostPortForLog(req.url ?? "")} rejected: remote client ${clientSocket.remoteAddress} tunneling non-whitelisted host`);
                clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
                return;
            }
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
    // connectThroughProxy resolves a socket that is ALREADY connected: direct
    // mode resolves on net.connect's 'connect' event; proxied mode resolves
    // after the CONNECT handshake returns 200. Either way we must NOT wait
    // for another 'connect' event here — Node does not replay it, so attaching
    // a listener in this .then() callback (the old code) never fires, and the
    // client would time out. Just start piping immediately.
    let established = false;
    let aborted = false;
    const connectTimer = setTimeout(() => {
        if (!established) {
            aborted = true;
            log(`tunnel ${maskHostForLog(host)}:${port} connect timeout`);
            clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\n\r\n");
            clientSocket.destroy();
        }
    }, 15000);
    connectThroughProxy(host, port, proxyUrl).then((upstream) => {
        if (aborted) {
            upstream.destroy();
            return;
        }
        established = true;
        clearTimeout(connectTimer);
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
        const cleanup = (where: string, err: Error) => {
            log(`tunnel ${maskHostForLog(host)}:${port} ${where} closed: ${err.message}`);
            upstream.destroy();
            clientSocket.destroy();
        };
        upstream.once("error", (e) => cleanup("upstream", e));
        clientSocket.once("error", (e) => cleanup("client", e));
    }).catch((err: Error) => {
        if (aborted) return;
        clearTimeout(connectTimer);
        log(`tunnel ${maskHostForLog(host)}:${port} connect failed: ${err.message}`);
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
        log(`mitm ${maskHostForLog(host)}:${port} TLS setup failed: ${(e as Error).message}`);
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
        log(`mitm ${maskHostForLog(host)}:${port} TLS error: ${err.message}`);
        tlsSocket.destroy();
        clientSocket.destroy();
    });
    // Slowloris guard: a client that issues CONNECT, gets the 200, then never
    // completes (or trickle-feeds) the TLS ClientHello would hold the socket
    // and our signed-cert context open indefinitely. Arm a handshake timeout;
    // clear it once the handshake completes ('secure'), or on error/close.
    const handshakeTimer = setTimeout(() => {
        log(`mitm ${maskHostForLog(host)}:${port} TLS handshake timeout`);
        tlsSocket.destroy();
        clientSocket.destroy();
    }, mitmHandshakeTimeoutMs());
    tlsSocket.once("secure", () => clearTimeout(handshakeTimer));
    tlsSocket.once("close", () => clearTimeout(handshakeTimer));
    tlsSocket.once("error", () => clearTimeout(handshakeTimer));
    // Hand the decrypted TLS socket to the http server's connection listener.
    // The server treats it as a new TCP connection and runs its HTTP parser on
    // the cleartext bytes — exactly the same path as a direct (non-proxy)
    // request, so handle()/forward() work unmodified.
    server.emit("connection", tlsSocket);
    log(`mitm ${maskHostForLog(host)}:${port} tunnel established (TLS terminated locally)`);
}

/** Read the MITM upstream marker from a request's underlying socket.
 *  Returns undefined for non-MITM (direct /bili/ or control) requests. */
export function readMitmUpstream(socket: net.Socket | tls.TLSSocket | undefined): string | undefined {
    if (!socket) return undefined;
    return (socket as unknown as Record<string, unknown>)[MITM_UPSTREAM_KEY] as string | undefined;
}
