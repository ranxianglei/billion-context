import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_REQUEST_BYTES } from "./fetch-util.js";
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

export type WsBridgeLog = (level: "debug" | "info" | "warn", message: string) => void;

export interface WsBridgeSession {
    /** A client frame arrived. */
    onMessage(data: Buffer, binary: boolean): void;
    /** The client socket closed; release session-owned resources. */
    onClose(code: number): void;
    /** The server is shutting down; fail in-flight exchanges and drop upstream transports. */
    shutdown(reason: string): void;
    /**
     * Optional resource accounting for the #1926 observability surface
     * (`/__bili/stats` + the idle-retention warn line). Implementations report
     * the bytes their checkpoints retain and whether an exchange is in flight.
     */
    stats?(): { retainedBytes?: number; inFlight?: boolean };
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

export interface WsBridgeStats {
    connections: { codec: string; connection: number; idleMs: number; retainedBytes?: number; inFlight?: boolean }[];
}

export interface WsBridgeHandle {
    /** The upgrade handler; wire into the http server's "upgrade" event. */
    (req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean;
    /** #1926 observability: live connections, idle age, retained bytes. */
    stats(): WsBridgeStats;
}

export interface WsBridgeOptions {
    /** Clock injection for tests. */
    now?: () => number;
    /** Idle-scan cadence (ms); default 60_000. */
    scanMs?: number;
    /** Idle threshold (ms) before the retention warn line fires; default 30 min, 0 disables. */
    idleWarnMs?: number;
}

interface BridgeEntry {
    session: WsBridgeSession;
    peer: WebSocket;
    codec: string;
    connection: number;
    label: string;
    lastActivityAt: number;
    idleWarned: boolean;
}

export function installWebSocketBridge(
    server: http.Server,
    dispatch: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
    log: (level: string, message: string) => void,
    codecs: readonly WsBridgeCodec[],
    options: WsBridgeOptions = {},
): WsBridgeHandle {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_BYTES, perMessageDeflate: false });
    const sessions = new Set<BridgeEntry>();
    let connectionId = 0;
    const now = options.now ?? Date.now;
    const scanMs = options.scanMs ?? 60_000;
    const idleWarnSeconds = Number(process.env.BILI_WS_IDLE_WARN_SECONDS ?? 1800);
    // Non-numeric or negative env values fall back to the 30-minute default instead of silently disabling the scan (sibling-knob convention, e.g. BILI_MODEL_INFO_RETRY_MS).
    const idleWarnMs = options.idleWarnMs ?? (Number.isFinite(idleWarnSeconds) && idleWarnSeconds >= 0 ? idleWarnSeconds : 1800) * 1000;
    // #1926: idle client peers pin one live upstream connection plus both
    // checkpoints each, with no reclamation until the client closes. Until
    // idle-close (a)/(b) is verified against the retry-full contract, surface
    // the retention: one warn line per idle episode per connection (reset on
    // activity), and per-connection stats via `stats()` below.
    const scanner = idleWarnMs > 0 && scanMs > 0 ? setInterval(() => {
        for (const entry of sessions) {
            const idleMs = now() - entry.lastActivityAt;
            if (entry.idleWarned || idleMs < idleWarnMs) continue;
            entry.idleWarned = true;
            const retained = entry.session.stats?.().retainedBytes;
            log("warn", `${entry.label} idle ${Math.round(idleMs / 1000)}s: socket pins a live upstream connection and checkpoints${retained === undefined ? "" : ` (retained≈${retained} bytes)`} — no reclamation until client close (#1926)`);
        }
    }, scanMs) : undefined;
    scanner?.unref();
    const close = server.close.bind(server);
    server.close = callback => {
        const live = [...sessions];
        sessions.clear(); // exactly-once: the 'close' event backstop below must not re-run
        scanner?.close();
        for (const { session } of live) session.shutdown("server-close");
        for (const peer of wss.clients) peer.terminate();
        return close(callback);
    };
    server.on("close", () => {
        scanner?.close();
        for (const { session } of sessions) session.shutdown("server-close");
        for (const peer of wss.clients) peer.terminate();
        wss.close();
    });
    const upgrade = (source: http.IncomingMessage, socket: Duplex, head: Buffer): boolean => {
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
            const verdict = await checkTunnelDestination(upstream, { selfPort: source.socket.localPort, clientLoopback: true, allowlist: tunnelAllowlistFromEnv() });
            if (!verdict.ok) {
                socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            if (socket.destroyed) return;
            wss.handleUpgrade(source, socket, head, peer => {
                const connection = ++connectionId;
                const label = `[${codec.name}] [conn=${connection}] [session=${JSON.stringify(conversationId.slice(0, 128))}]`;
                const trace: WsBridgeLog = (level, message) => log(level, `${label} ${message}`);
                const session = codec.createSession({ log: trace, peer, source, upstreamUrl: upstream, dispatch, codec });
                const entry: BridgeEntry = { session, peer, codec: codec.name, connection, label, lastActivityAt: now(), idleWarned: false };
                sessions.add(entry);
                peer.on("error", () => {});
                peer.on("close", (code: number) => {
                    session.onClose(code);
                    sessions.delete(entry);
                });
                peer.on("message", (data: Buffer, binary: boolean) => {
                    entry.lastActivityAt = now();
                    entry.idleWarned = false;
                    session.onMessage(data, binary);
                });
            });
        })().catch(() => {
            log("warn", `[${codec.name}] upgrade failed`);
            if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        });
        return true;
    };
    const stats = (): WsBridgeStats => ({
        connections: [...sessions].map(entry => {
            const entryStats = entry.session.stats?.();
            return { codec: entry.codec, connection: entry.connection, idleMs: Math.max(0, now() - entry.lastActivityAt), retainedBytes: entryStats?.retainedBytes, inFlight: entryStats?.inFlight };
        }),
    });
    return Object.assign(upgrade, { stats });
}
