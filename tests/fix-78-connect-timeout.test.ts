import assert from "node:assert";
import net from "node:net";
import test from "node:test";

import { connectDirect, connectThroughProxy, parseHttpProxy, _setConnectFactoryForTest } from "../src/upstream-proxy.ts";

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

test("IPv6 proxy URLs expose an unbracketed socket hostname", () => {
    for (const scheme of ["http", "https"]) {
        const proxy = parseHttpProxy(`${scheme}://[::1]:8080`);
        assert.equal(proxy?.host, "::1");
        assert.equal(proxy?.url, `${scheme}://[::1]:8080/`, "the URL retains authority brackets");
    }
});

for (const proxied of [false, true]) {
    test(`IPv6 loopback ${proxied ? "proxy" : "direct"} connection accepts bracketed authorities`, async (t) => {
        const peers: net.Socket[] = [];
        const server = net.createServer((socket) => {
            peers.push(socket);
            if (proxied) socket.once("data", () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "::1", resolve);
            });
        } catch (error) {
            if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) {
                t.skip("IPv6 loopback is unavailable on this host");
                return;
            }
            throw error;
        }
        try {
            const port = (server.address() as net.AddressInfo).port;
            const socket = proxied
                ? await connectThroughProxy("upstream.example", 443, `http://[::1]:${port}`)
                : await connectDirect("[::1]", port);
            socket.destroy();
        } finally {
            for (const peer of peers) peer.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
}

test("CONNECT uses a bracketed authority for a bare IPv6 target", async () => {
    let request = "";
    const peers: net.Socket[] = [];
    const server = net.createServer((socket) => {
        peers.push(socket);
        socket.once("data", (data) => {
            request = data.toString();
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        });
    });
    server.listen(0, "127.0.0.1");
    await listen(server);
    try {
        const port = (server.address() as net.AddressInfo).port;
        const socket = await connectThroughProxy("2001:db8::1", 443, `http://127.0.0.1:${port}`);
        socket.destroy();
        assert.match(request, /^CONNECT \[2001:db8::1\]:443 HTTP\/1\.1\r\n/);
        assert.match(request, /\r\nHost: \[2001:db8::1\]:443\r\n/);
    } finally {
        for (const peer of peers) peer.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
