import assert from "node:assert";
import net from "node:net";
import test from "node:test";

import { connectDirect, connectThroughProxy, _setConnectFactoryForTest } from "../src/upstream-proxy.ts";

function listen(server: net.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return new Promise((resolve) => server.once("listening", resolve));
}

test("direct connect resolves against a real server", async () => {
    const server = net.createServer((sock) => sock.end());
    server.listen(0, "127.0.0.1");
    await listen(server);
    const port = (server.address() as { port: number }).port;
    try {
        const socket = await connectDirect("127.0.0.1", port);
        assert.ok(socket.readable && socket.writable, "resolved with a live socket");
        socket.destroy();
    } finally {
        server.close();
    }
});

test("connectThroughProxy delegates to the direct path when no proxy is set", async () => {
    const server = net.createServer((sock) => sock.end());
    server.listen(0, "127.0.0.1");
    await listen(server);
    const port = (server.address() as { port: number }).port;
    try {
        const socket = await connectThroughProxy("127.0.0.1", port, undefined);
        assert.ok(socket.readable && socket.writable);
        socket.destroy();
    } finally {
        server.close();
    }
});

test("direct connect fails fast (milliseconds, not the OS ~127s) when the connection hangs", async () => {
    // A socket that neither connects nor errors simulates a black-holed
    // upstream (firewall drops SYNs). The timeout handler must reject and
    // destroy the socket — that is the whole point of #78.
    const hung = new net.Socket();
    const destroyed = new Promise<void>((resolve) => hung.once("close", resolve));
    _setConnectFactoryForTest(() => hung);
    try {
        const t0 = Date.now();
        await assert.rejects(
            connectDirect("127.0.0.1", 1, 50),
            /upstream connect 127\.0\.0\.1:1 timed out after 50ms/,
        );
        assert.ok(Date.now() - t0 < 2_000, "rejected in milliseconds, not minutes");
        await destroyed; // the timeout handler destroyed the hung socket
    } finally {
        _setConnectFactoryForTest(undefined);
    }
});

test("direct connect: immediate errors (connection refused) still surface right away", async () => {
    // Find a closed port: listen, note it, close.
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await listen(server);
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const t0 = Date.now();
    await assert.rejects(connectDirect("127.0.0.1", port), /ECONNREFUSED/);
    assert.ok(Date.now() - t0 < 2_000, "refusal is immediate, not a timeout");
});
