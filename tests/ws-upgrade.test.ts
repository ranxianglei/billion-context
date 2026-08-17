import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetForTest as resetCaForTest } from "../src/ca.ts";

/** #2 (codex WS stall): Codex prefers Responses-over-WebSocket when the
 *  provider advertises supports_websockets and only switches to HTTP POST
 *  fast when the WS handshake fails with HTTP 426 (anything else goes through
 *  the retry/backoff budget first — the reported 十几秒 stall). The proxy must
 *  therefore answer every WebSocket upgrade with a clean, immediately-closed
 *  426, both on plain connections and on MITM-decrypted TLS connections (the
 *  `bili codex` path). */

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const WS_HANDSHAKE =
    "GET /backend-api/codex/responses/ws HTTP/1.1\r\n" +
    "Host: api.openai.com\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
    "Sec-WebSocket-Version: 13\r\n" +
    "\r\n";

interface UpgradeResult {
    response: string;
    closed: boolean;
    elapsedMs: number;
}

/** Sends a raw WebSocket handshake and resolves once the server responds
 *  (capturing whether/how fast the connection is closed afterwards). */
function sendUpgrade(port: number, write: (socket: net.Socket) => void): Promise<UpgradeResult> {
    const { promise, resolve, reject } = Promise.withResolvers<UpgradeResult>();
    const started = Date.now();
    const socket = net.connect(port, "127.0.0.1", () => write(socket));
    let buf = "";
    let closed = false;
    const finish = (): void => {
        socket.destroy();
        resolve({ response: buf, closed, elapsedMs: Date.now() - started });
    };
    socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        if (buf.includes("\r\n\r\n")) {
            // Response head received — wait a bounded time for the close.
            setTimeout(finish, 100);
        }
    });
    socket.on("close", () => {
        closed = true;
    });
    socket.once("error", reject);
    setTimeout(() => finish(), 3000);
    return promise;
}

function baseOpts(mitm: ProxyOptions["mitm"]): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm,
    };
}

test("ws upgrade: answered with 426 + close on a plain connection", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const server = await startServer(baseOpts({ enabled: false, domains: [] }));
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        const result = await sendUpgrade(port, (socket) => socket.write(WS_HANDSHAKE));
        assert.match(result.response, /^HTTP\/1\.1 426/);
        assert.match(result.response, /connection: close/i);
        assert.match(result.response, /not supported/i);
        assert.equal(result.closed, true, "socket must be closed right after the 426");
    } finally {
        await close(server);
        server.closeAllConnections?.();
    }
});

test("ws upgrade: answered with 426 + close on an MITM-decrypted TLS connection (bili codex path)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ws-"));
    const prevDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmp;
    resetCaForTest();
    try {
        const server = await startServer(baseOpts({ enabled: true, domains: ["api.openai.com"] }));
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const { promise, resolve, reject } = Promise.withResolvers<{ statusLine: string; socket: net.Socket }>();
            const conn = net.connect(port, "127.0.0.1", () => {
                conn.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n");
            });
            let connectBuf = "";
            const onData = (chunk: Buffer): void => {
                connectBuf += chunk.toString("utf8");
                if (connectBuf.includes("\r\n\r\n")) {
                    conn.off("data", onData);
                    resolve({ statusLine: connectBuf.slice(0, connectBuf.indexOf("\r\n")), socket: conn });
                }
            };
            conn.on("data", onData);
            conn.once("error", reject);
            const { statusLine, socket } = await promise;
            assert.match(statusLine, /^HTTP\/1\.1 200/);

            const { promise: tlsPromise, resolve: resolveTls, reject: rejectTls } = Promise.withResolvers<UpgradeResult>();
            const tlsSock = tls.connect({ socket, rejectUnauthorized: false, servername: "api.openai.com" });
            const started = Date.now();
            let tlsBuf = "";
            let closed = false;
            tlsSock.on("secureConnect", () => tlsSock.write(WS_HANDSHAKE));
            const finish = (): void => {
                tlsSock.destroy();
                resolveTls({ response: tlsBuf, closed, elapsedMs: Date.now() - started });
            };
            tlsSock.on("data", (chunk: Buffer) => {
                tlsBuf += chunk.toString("utf8");
                if (tlsBuf.includes("\r\n\r\n")) setTimeout(finish, 100);
            });
            tlsSock.on("close", () => {
                closed = true;
            });
            tlsSock.once("error", rejectTls);
            setTimeout(finish, 3000);
            const result = await tlsPromise;
            assert.match(result.response, /^HTTP\/1\.1 426/);
            assert.match(result.response, /connection: close/i);
            assert.equal(result.closed, true, "TLS socket must be closed right after the 426");
        } finally {
            await close(server);
            server.closeAllConnections?.();
        }
    } finally {
        if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevDataHome;
        resetCaForTest();
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch {
            /* best-effort */
        }
    }
});
