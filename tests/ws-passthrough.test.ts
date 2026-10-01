import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { MITM_UPSTREAM_KEY } from "../src/mitm.ts";
import { resolveWsDestination, buildUpgradeHead } from "../src/ws-passthrough.ts";

/** #1467 Phase 1: opt-in transparent WebSocket passthrough. With
 *  ws.passthrough ON, upgrades addressed to `/bili/ws(s)://…`, absolute-form
 *  `ws(s)://…`, or MITM-terminated connections are relayed to the real
 *  upstream and piped as opaque bytes (NO compression); unroutable upgrades
 *  still answer the Codex fast-fallback 426 (#2). Direct destinations pass
 *  the #409 admission checks; blind tunnels carry WS bytes without this
 *  feature at all. All ports come from listen(0) (§7.2 determinism). */

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

function baseOpts(wsPassthrough: boolean, mitm: ProxyOptions["mitm"]): ProxyOptions {
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
        wsPassthrough,
    };
}

function handshake(target: string, hostPort: string, extra = ""): string {
    return (
        `GET ${target} HTTP/1.1\r\n` +
        `Host: ${hostPort}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        extra +
        "\r\n"
    );
}

interface FakeWsUpstream {
    port: number;
    firstHead: Promise<string>;
    close(): Promise<void>;
}

/** Raw-TCP stand-in for a WebSocket upstream. "ok" answers the handshake
 *  with a fixed 101 head, pushes one server→client byte string shortly
 *  after, and echoes every subsequent byte (proving both pipe directions).
 *  "unauthorized" answers 401 + JSON body and closes. */
function startFakeWs(mode: "ok" | "unauthorized"): Promise<FakeWsUpstream> {
    const { promise: headPromise, resolve: resolveHead } = Promise.withResolvers<string>();
    const server = net.createServer((socket) => {
        let buf = Buffer.alloc(0);
        let consumed = 0;
        let answered = false;
        socket.on("data", (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);
            const idx = buf.indexOf("\r\n\r\n");
            if (!answered && idx !== -1) {
                answered = true;
                resolveHead(buf.subarray(0, idx + 4).toString("latin1"));
                if (mode === "unauthorized") {
                    const body = JSON.stringify({ error: "missing api key" });
                    socket.write(
                        "HTTP/1.1 401 Unauthorized\r\n" +
                        "Content-Type: application/json\r\n" +
                        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
                        "Connection: close\r\n" +
                        "\r\n" +
                        body,
                    );
                    socket.end();
                    return;
                }
                socket.write(
                    "HTTP/1.1 101 Switching Protocols\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: k82xYo2WQZx6R/hmBJ5QH6kN7FE=\r\n" +
                    "\r\n",
                );
                setTimeout(() => socket.write("S-PUSH"), 20);
            }
            if (mode === "ok" && idx !== -1) {
                const tail = buf.subarray(Math.max(consumed, idx + 4));
                consumed = Math.max(consumed, idx + 4);
                if (tail.length > 0) socket.write(tail);
            }
        });
        socket.on("error", () => {});
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve({
            port: (server.address() as { port: number }).port,
            firstHead: headPromise,
            close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
        }));
    });
}

interface RelayResult {
    head: string;
    body: string;
    closed: boolean;
}

/** Sends a raw upgrade request, optionally writes one client→upstream frame
 *  right after the response head arrives, and collects everything received. */
function relaySession(port: number, rawRequest: string, frame?: string): Promise<RelayResult> {
    const { promise, resolve, reject } = Promise.withResolvers<RelayResult>();
    const socket = net.connect(port, "127.0.0.1", () => socket.write(rawRequest));
    let buf = "";
    let finished = false;
    let closed = false;
    const finish = (): void => {
        if (finished) return;
        finished = true;
        socket.destroy();
        const headEnd = buf.indexOf("\r\n\r\n");
        resolve({ head: buf.slice(0, headEnd + 4), body: buf.slice(headEnd + 4), closed });
    };
    socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("latin1");
        if (!finished && buf.includes("\r\n\r\n")) {
            if (frame !== undefined) socket.write(frame);
            setTimeout(finish, 150);
        }
    });
    socket.on("close", () => {
        closed = true;
        finish();
    });
    socket.once("error", reject);
    setTimeout(finish, 5000);
    return promise;
}

test("ws passthrough: 101 + bidirectional frame round-trip for /bili/ws:// embedded form", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const fake = await startFakeWs("ok");
    try {
        const server = await startServer(baseOpts(true, { enabled: false, domains: [] }));
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const result = await relaySession(
                port,
                handshake(`/bili/ws://127.0.0.1:${fake.port}/realtime`, `127.0.0.1:${port}`, "X-Auth-Token: secret-token-123\r\n"),
                "C-PING",
            );
            assert.match(result.head, /^HTTP\/1\.1 101/);
            assert.match(result.head, /sec-websocket-accept: k82xYo2WQZx6R\/hmBJ5QH6kN7FE=/i);
            assert.ok(result.body.includes("S-PUSH"), "upstream→client direction must carry pushed bytes");
            assert.ok(result.body.includes("C-PING"), "client→upstream direction must be echoed back");

            const received = await withTimeout(fake.firstHead, 5000, "fake upstream handshake");
            assert.match(received, /^GET \/realtime HTTP\/1\.1\r\n/);
            assert.ok(received.toLowerCase().includes(`host: 127.0.0.1:${fake.port}`), "Host must be rewritten to the destination authority");
            assert.ok(!received.toLowerCase().includes(`host: 127.0.0.1:${port}`), "the proxy's own Host must not leak upstream");
            assert.ok(received.toLowerCase().includes("x-auth-token: secret-token-123"), "client headers other than hop-by-hop pass through verbatim");
        } finally {
            await close(server);
            server.closeAllConnections?.();
        }
    } finally {
        await fake.close();
    }
});

test("ws passthrough: bytes pipelined behind the handshake request are forwarded upstream", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const fake = await startFakeWs("ok");
    try {
        const server = await startServer(baseOpts(true, { enabled: false, domains: [] }));
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            // One single write: handshake request + trailing frame bytes, sent
            // BEFORE any 101 — Node hands the trailing bytes to the upgrade
            // handler as its `head` argument; they must reach the upstream.
            const raw = handshake(`/bili/ws://127.0.0.1:${fake.port}/realtime`, `127.0.0.1:${port}`) + "C-EARLY";
            const result = await relaySession(port, raw);
            assert.match(result.head, /^HTTP\/1\.1 101/);
            assert.ok(result.body.includes("C-EARLY"), "pipelined post-request bytes must reach the upstream (echoed back), not be dropped");
        } finally {
            await close(server);
            server.closeAllConnections?.();
        }
    } finally {
        await fake.close();
    }
});

test("ws passthrough: absolute-form ws:// target is relayed", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const fake = await startFakeWs("ok");
    try {
        const server = await startServer(baseOpts(true, { enabled: false, domains: [] }));
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const result = await relaySession(port, handshake(`ws://127.0.0.1:${fake.port}/abs`, `127.0.0.1:${port}`));
            assert.match(result.head, /^HTTP\/1\.1 101/);
            assert.ok(result.body.includes("S-PUSH"));
            const received = await withTimeout(fake.firstHead, 5000, "fake upstream handshake");
            assert.match(received, /^GET \/abs HTTP\/1\.1\r\n/);
        } finally {
            await close(server);
            server.closeAllConnections?.();
        }
    } finally {
        await fake.close();
    }
});

test("ws passthrough: non-101 upstream answer is forwarded verbatim", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const fake = await startFakeWs("unauthorized");
    try {
        const server = await startServer(baseOpts(true, { enabled: false, domains: [] }));
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const result = await relaySession(port, handshake(`/bili/ws://127.0.0.1:${fake.port}/realtime`, `127.0.0.1:${port}`));
            assert.match(result.head, /^HTTP\/1\.1 401/);
            assert.match(result.body, /missing api key/);
            assert.equal(result.closed, true, "connection closes after the forwarded refusal");
        } finally {
            await close(server);
            server.closeAllConnections?.();
        }
    } finally {
        await fake.close();
    }
});

test("ws passthrough: upgrading to the proxy's own port is denied (self, #409)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const server = await startServer(baseOpts(true, { enabled: false, domains: [] }));
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        const result = await relaySession(port, handshake(`/bili/ws://127.0.0.1:${port}/x`, `127.0.0.1:${port}`));
        assert.match(result.head, /^HTTP\/1\.1 403/);
        assert.match(result.body, /"error"/);
    } finally {
        await close(server);
        server.closeAllConnections?.();
    }
});

test("ws passthrough: link-local metadata address is denied even for loopback clients", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const server = await startServer(baseOpts(true, { enabled: false, domains: [] }));
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        const result = await relaySession(port, handshake("/bili/ws://169.254.169.254/latest", `127.0.0.1:${port}`));
        assert.match(result.head, /^HTTP\/1\.1 403/);
    } finally {
        await close(server);
        server.closeAllConnections?.();
    }
});

test("ws passthrough: unroutable origin-form upgrade still answers the Codex 426", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const server = await startServer(baseOpts(true, { enabled: false, domains: [] }));
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
        const result = await relaySession(port, handshake("/backend-api/codex/responses/ws", `127.0.0.1:${port}`));
        assert.match(result.head, /^HTTP\/1\.1 426/);
        assert.match(result.body, /not supported/i);
        assert.equal(result.closed, true, "socket must be closed right after the 426");
    } finally {
        await close(server);
        server.closeAllConnections?.();
    }
});

test("ws traffic survives the blind tunnel unchanged (non-whitelisted CONNECT needs no opt-in)", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const fake = await startFakeWs("ok");
    try {
        const server = await startServer(baseOpts(false, { enabled: true, domains: [] }));
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const { promise, resolve, reject } = Promise.withResolvers<{ wsHead: string }>();
            const conn = net.connect(port, "127.0.0.1", () => {
                conn.write(`CONNECT 127.0.0.1:${fake.port} HTTP/1.1\r\nHost: 127.0.0.1:${fake.port}\r\n\r\n`);
            });
            let buf = "";
            let phase = 0;
            let headEnd = -1;
            const onData = (chunk: Buffer): void => {
                buf += chunk.toString("latin1");
                if (phase === 0) {
                    const idx = buf.indexOf("\r\n\r\n");
                    if (idx === -1) return;
                    if (!/^HTTP\/1\.1 200/.test(buf)) {
                        reject(new Error(`unexpected CONNECT answer: ${buf.slice(0, 60)}`));
                        return;
                    }
                    headEnd = idx + 4;
                    phase = 1;
                    conn.write(handshake("/realtime", `127.0.0.1:${fake.port}`));
                } else if (phase === 1) {
                    if (buf.slice(headEnd).includes("\r\n\r\n")) {
                        phase = 2;
                        conn.write("C-PING");
                    }
                } else if (buf.includes("C-PING")) {
                    conn.off("data", onData);
                    resolve({ wsHead: buf.slice(headEnd) });
                }
            };
            conn.on("data", onData);
            conn.once("error", reject);
            const timeout = setTimeout(() => reject(new Error("blind-tunnel WS relay timed out")), 5000);
            try {
                const { wsHead } = await promise;
                assert.match(wsHead, /^HTTP\/1\.1 101/);
            const received = await withTimeout(fake.firstHead, 5000, "fake upstream handshake");
                assert.match(received, /^GET \/realtime HTTP\/1\.1\r\n/);
            } finally {
                clearTimeout(timeout);
                conn.destroy();
            }
        } finally {
            await close(server);
            server.closeAllConnections?.();
        }
    } finally {
        await fake.close();
    }
});

test("resolveWsDestination: form matrix (MITM marker, /bili/ embedded, absolute-form, rejects)", () => {
    const mitmSocket = { [MITM_UPSTREAM_KEY]: "https://api.openai.com" } as unknown as net.Socket;
    const req = (url: string): http.IncomingMessage => ({ url, method: "GET" } as unknown as http.IncomingMessage);

    assert.deepEqual(resolveWsDestination(req("/backend-api/codex/responses/ws"), mitmSocket), {
        origin: "wss://api.openai.com",
        targetPath: "/backend-api/codex/responses/ws",
        hostHeader: "api.openai.com",
        viaMitm: true,
    });
    assert.deepEqual(resolveWsDestination(req("wss://api.openai.com/v1/realtime"), mitmSocket), {
        origin: "wss://api.openai.com",
        targetPath: "/v1/realtime",
        hostHeader: "api.openai.com",
        viaMitm: true,
    });
    assert.deepEqual(resolveWsDestination(req("/bili/wss://h.example:8443/p?a=1"), undefined), {
        origin: "wss://h.example:8443",
        targetPath: "/p?a=1",
        hostHeader: "h.example:8443",
        viaMitm: false,
    });
    assert.deepEqual(resolveWsDestination(req("ws://127.0.0.1:9/x"), undefined), {
        origin: "ws://127.0.0.1:9",
        targetPath: "/x",
        hostHeader: "127.0.0.1:9",
        viaMitm: false,
    });
    assert.equal(resolveWsDestination(req("/bili/http://h.example/p"), undefined), undefined);
    assert.equal(resolveWsDestination(req("/anything"), undefined), undefined);
    assert.equal(resolveWsDestination(req(""), undefined), undefined);
});

test("buildUpgradeHead: rewrites Host, strips proxy hop-by-hop, keeps everything else", () => {
    const r = {
        method: "GET",
        url: "/whatever",
        headers: {
            host: "127.0.0.1:9000",
            "proxy-authorization": "Basic xyz",
            "proxy-connect-info": "hop",
            "x-forwarded-for": "1.2.3.4",
            "x-forwarded-proto": "http",
            "x-real-ip": "5.6.7.8",
            upgrade: "websocket",
            connection: "Upgrade",
            "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
            "sec-websocket-version": "13",
            "x-auth-token": "secret",
        },
    } as unknown as http.IncomingMessage;

    const head = buildUpgradeHead(r, "/realtime", "api.openai.com");
    assert.ok(head.startsWith("GET /realtime HTTP/1.1\r\n"));
    assert.ok(head.endsWith("\r\n\r\n"));
    const lower = head.toLowerCase();
    assert.ok(lower.includes("host: api.openai.com\r\n"), "destination authority must become the Host header");
    assert.ok(!lower.includes("127.0.0.1:9000"), "inbound Host must not leak upstream");
    assert.ok(!lower.includes("proxy-authorization"), "proxy hop-by-hop headers must be stripped");
    assert.ok(!lower.includes("proxy-connect-info"), "proxy hop-by-hop headers must be stripped");
    assert.ok(!lower.includes("x-forwarded-for"), "forwarding headers must not be forged onward");
    assert.ok(!lower.includes("x-real-ip"), "forwarding headers must not be forged onward");
    assert.ok(lower.includes("upgrade: websocket\r\n"), "protocol-critical headers pass through");
    assert.ok(lower.includes(`sec-websocket-key: ${"dGhlIHNhbXBsZSBub25jZQ==".toLowerCase()}\r\n`), "handshake key passes through");
    assert.ok(lower.includes("x-auth-token: secret\r\n"), "client credentials pass through verbatim");
});
