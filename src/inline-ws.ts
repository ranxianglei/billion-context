// Loopback-only WebSocket bridge for the inline engine (#3278 follow-up).
//
// The pi inline lane compresses in-process: model HTTP traffic rides the
// pseudo-origin (INLINE_ORIGIN) through installInlineTransport. Codex's
// Responses WebSocket lane cannot — a WS connect needs a REAL, dialable
// listener, and "billion-context.inline" never resolves. So the inline engine
// now boots the SAME ws-bridge the spawned server serves (src/ws-bridge.ts),
// bound to 127.0.0.1 on an ephemeral port. Admission is loopback-only inside
// installWebSocketBridge itself (isLoopbackAddress on the peer), the tunnel
// destination guard still applies, and the server is unref'd — it can never
// keep the host process alive nor be reached from another machine.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { installWebSocketBridge } from "./ws-bridge.js";
import { codexResponsesCodec, responsesCodec } from "./responses-ws.js";

interface InlineWsBridge {
    /** HTTP-shaped origin of the loopback listener ("http://127.0.0.1:PORT").
     *  The native WS wrapper rewrites codex Responses URLs to
     *  ws://<origin>/bili/<upstream> — scheme split per rewriteCodexResponsesWsUrl. */
    origin: string;
    /** Stop the listener and every live session (server.close is wrapped by
     *  installWebSocketBridge to shut sessions down). Never throws. */
    close(): Promise<void>;
}

/**
 * Boot the loopback WS bridge on 127.0.0.1:0.
 *
 * `dispatchHttp` drives the shared request pipeline for WS-lane envelopes
 * (the codecs rebuild in-process HTTP envelopes and hand them here). It must
 * be the BARE pipeline drive — sessions wrap their dispatch call in
 * withFetchTransport(their own WS-backed fetch), and an inner transport wrap
 * here would override the session's upstream and push the model turn onto
 * plain HTTP, silently changing the lane's wire shape.
 */
export async function startInlineWsBridge(options: {
    dispatchHttp: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
    log: (level: string, message: string) => void;
    /** #2124 parity with startServer(): lets checkTunnelDestination know when
     *  a destination resolves remotely (upstream proxy owns DNS). */
    isEgressProxied?: (destinationUrl: string) => boolean;
    /** #300/#3073 hop-chain instance identity, same as the spawned server. */
    instanceId?: string;
}): Promise<InlineWsBridge> {
    const server = http.createServer((req, res) => {
        // The bridge serves upgrades only. Plain HTTP landing here means a
        // client dialed the loopback port without an Upgrade header — answer
        // with the protocol's own "use WebSocket" status, not a stack trace.
        res.writeHead(426, { "content-type": "text/plain; charset=utf-8" });
        res.end("bili inline WS bridge: WebSocket upgrade required\n");
    });
    const upgrade = installWebSocketBridge(
        server,
        options.dispatchHttp,
        options.log,
        [responsesCodec, codexResponsesCodec],
        options.isEgressProxied,
        options.instanceId,
    );
    server.on("upgrade", (source, socket, head) => {
        if (upgrade(source, socket, head)) return;
        socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    // Never pin the host's event loop: the engine dies with its process.
    server.unref();
    const { port } = server.address() as AddressInfo;
    options.log("info", `[inline] codex WS bridge listening on 127.0.0.1:${port} (loopback only)`);
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>(resolve => {
                server.close(() => resolve());
                // installWebSocketBridge wraps close() to also shut sessions;
                // the wrapped close still calls through, so one call suffices.
            }),
    };
}
