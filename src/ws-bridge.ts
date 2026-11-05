import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { limitsReceiveBytes } from "./knobs.js";
import { checkTunnelDestination, tunnelAllowlistFromEnv } from "./tunnel-guard.js";
import { isLoopbackAddress } from "./util.js";

// Generic WebSocket bridge (#1467 phase-2 shell).
//
// The bridge owns everything protocol-independent about intercepting a
// WebSocket client: admission (loopback source, bili plugin lane markers,
// tunnel-destination guard), the upgrade handshake, per-connection
// bookkeeping, and server-shutdown teardown. Each protocol rides as a codec
// that parses client frames into HTTP-shaped envelopes, runs them through the
// ordinary ACP request pipeline (`dispatch`), and carries the pipeline's
// outbound fetches back over a WebSocket transport.
//
// Compression is inherently protocol-aware: folding history requires knowing
// where the history lives in the wire format, so an unknown protocol cannot
// be compressed — it stays on the #1472 transparent passthrough lane. The
// codec table is the extension point: a new wire protocol is a new codec
// file plus one registration entry, with zero shell changes.

type WsBridgeLog = (level: "debug" | "info" | "warn", message: string) => void;

export interface WsBridgeSession {
    /** A client frame arrived. */
    onMessage(data: Buffer, binary: boolean): void;
    /** The client socket closed; release session-owned resources. */
    onClose(code: number): void;
    /** The server is shutting down; fail in-flight exchanges and drop upstream transports. */
    shutdown(reason: string): void;
}

export interface WsBridgeContext {
    /** Per-connection labeled logger (connection id + conversation id). */
    log: WsBridgeLog;
    /** The upgraded client socket. */
    peer: WebSocket;
    /** The original HTTP upgrade request (headers reused for envelope reconstruction). */
    source: http.IncomingMessage;
    /** Upstream URL the codec extracted from the request path. */
    upstreamUrl: string;
    /** The ACP request pipeline entry point (compression, preflight, tools, usage). */
    dispatch: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
    /** The codec that claimed this upgrade (per-protocol transport policy). */
    codec: WsBridgeCodec;
    /** #300/#3073: this server's per-instance identity. Codecs that own their
     *  upstream WebSocket transport stamp it into x-bili-hop on EVERY upstream
     *  handshake — probe and turns alike — so a chained bili sees one
     *  consistent processor marker instead of marker-less probes. */
    instanceId?: string;
}

export interface WsBridgeCodec {
    /** Log label and admission identity, e.g. "responses-ws". */
    name: string;
    /**
     * Required `x-bili-plugin` marker value (bili plugin lane identity).
     * Prefix-lane codecs (no plugin marker on the wire) omit this and admit
     * on their transport headers instead — same trust level as prefix-mode
     * HTTP: loopback client, conversation header, tunnel-guarded upstream.
     */
    pluginMarker?: string;
    /**
     * Header carrying the client's conversation id. Defaults to the plugin
     * lane header; prefix-lane codecs point this at their client's own
     * session header (e.g. codex sends `session-id`).
     */
    conversationHeader?: string;
    /** Return the upstream URL when this codec claims the upgrade path, else undefined. */
    matchUpgrade(url: string | undefined): string | undefined;
    /**
     * Clients of this codec may send an explicit `stream: true` flag inside
     * response.create frames. Default keeps the strict policy — the flag must
     * not appear at all (opencode frames carry no stream field; the lane adds
     * its own). Codex always sends stream:true, so its codec opts in.
     */
    readonly allowStreamFlag?: boolean;
    /** Per-connection session factory; log the "connected" line from here. */
    createSession(context: WsBridgeContext): WsBridgeSession;
}

export function installWebSocketBridge(
    server: http.Server,
    dispatch: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
    log: (level: string, message: string) => void,
    codecs: readonly WsBridgeCodec[],
    /** #2124: whether a WS-upstream destination's egress leaves through an upstream proxy (its hostname is then resolved remotely by that proxy, not the local resolver). */
    isEgressProxied?: (destinationUrl: string) => boolean,
    /** #300/#3073: this server's per-instance identity for the x-bili-hop chain stamp (see WsBridgeContext.instanceId). */
    instanceId?: string,
): (req: http.IncomingMessage, socket: Duplex, head: Buffer) => boolean {
    const wss = new WebSocketServer({ noServer: true, maxPayload: limitsReceiveBytes(), perMessageDeflate: false });
    const sessions = new Set<{ session: WsBridgeSession; peer: WebSocket }>();
    let connectionId = 0;
    const close = server.close.bind(server);
    server.close = callback => {
        const live = [...sessions];
        sessions.clear(); // exactly-once: the 'close' event backstop below must not re-run
        for (const { session } of live) session.shutdown("server-close");
        for (const peer of wss.clients) peer.terminate();
        return close(callback);
    };
    server.on("close", () => {
        for (const { session } of sessions) session.shutdown("server-close");
        for (const peer of wss.clients) peer.terminate();
        wss.close();
    });
    return (source, socket, head) => {
        const admitted = isLoopbackAddress(source.socket.remoteAddress);
        const claim = admitted ? codecs.flatMap(candidate => {
            const conversation = source.headers[candidate.conversationHeader ?? "x-bili-plugin-conversation"];
            const conversationId = typeof conversation === "string" ? conversation : "";
            if (conversationId.trim().length === 0) return [];
            if (candidate.pluginMarker !== undefined && source.headers["x-bili-plugin"] !== candidate.pluginMarker) return [];
            const upstream = candidate.matchUpgrade(source.url);
            return upstream === undefined ? [] : [{ codec: candidate, upstream, conversationId }];
        })[0] : undefined;
        if (!claim) return false;
        const { codec, upstream, conversationId } = claim;
        // Stamp the codec name onto the upgrade request BEFORE the session is
        // created: codecs rebuild in-process HTTP envelopes from `source`, so
        // every envelope inherits this marker and the request pipeline can tell
        // a WS-lane envelope from an omp-style HTTP request (#1897 demotion
        // must not fire here — this lane IS the conversation mainline, and its
        // side requests are identified by the #1699 persona header instead).
        source.headers["x-bili-ws-lane"] = codec.name;
        void (async () => {
            const verdict = await checkTunnelDestination(upstream, { selfPort: source.socket.localPort, clientLoopback: true, allowlist: tunnelAllowlistFromEnv(), egressProxied: isEgressProxied?.(upstream) });
            if (!verdict.ok) {
                socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            if (socket.destroyed) return;
            wss.handleUpgrade(source, socket, head, peer => {
                const label = `[${codec.name}] [conn=${++connectionId}] [session=${JSON.stringify(conversationId.slice(0, 128))}]`;
                const trace: WsBridgeLog = (level, message) => log(level, `${label} ${message}`);
                const session = codec.createSession({ log: trace, peer, source, upstreamUrl: upstream, dispatch, codec, instanceId });
                const entry = { session, peer };
                sessions.add(entry);
                peer.on("error", () => {});
                peer.on("close", (code: number) => {
                    session.onClose(code);
                    sessions.delete(entry);
                });
                peer.on("message", (data: Buffer, binary: boolean) => session.onMessage(data, binary));
            });
        })().catch(() => {
            log("warn", `[${codec.name}] upgrade failed`);
            if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        });
        return true;
    };
}
