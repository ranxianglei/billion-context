import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { connectThroughProxy } from "../src/upstream-proxy.ts";
import { setupMitm } from "../src/mitm.ts";

const limit = 64 * 1024;
const tooLarge = /upstream proxy CONNECT response header is too large/;

function responseHead(bytes: number): Buffer {
    const prefix = "HTTP/1.1 200 Connection Established\r\nX-Pad: ";
    return Buffer.from(prefix + "x".repeat(bytes - prefix.length - 4) + "\r\n\r\n");
}

async function withProxy(reply: (socket: net.Socket) => void, run: (url: string) => Promise<void>): Promise<void> {
    const peers: net.Socket[] = [];
    const server = net.createServer(socket => {
        peers.push(socket);
        socket.on("error", () => {});
        socket.once("data", () => reply(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        await run(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    } finally {
        for (const peer of peers) peer.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}

for (const bytes of [limit - 1, limit, limit + 1, 80 * 1024]) {
    for (const splitDelimiter of [false, true]) {
        test(`CONNECT enforces ${bytes}-byte response head with split delimiter=${splitDelimiter}`, async () => {
            const head = responseHead(bytes);
            await withProxy(socket => {
                if (splitDelimiter) {
                    socket.write(head.subarray(0, -3));
                    void delay(5).then(() => { if (!socket.destroyed) socket.write(head.subarray(-3)); });
                } else socket.write(head);
            }, async url => {
                const connected = connectThroughProxy("example.invalid", 443, url);
                if (bytes > limit) {
                    await assert.rejects(connected.then(socket => { socket.destroy(); }), tooLarge);
                } else {
                    const socket = await connected;
                    assert.equal(socket.destroyed, false);
                    socket.destroy();
                }
            });
        });
    }
}

test("CONNECT retains the existing bound before any header delimiter arrives", async () => {
    const head = responseHead(80 * 1024);
    head.fill(120, head.length - 4);
    await withProxy(socket => { socket.write(head); }, async url => {
        await assert.rejects(connectThroughProxy("example.invalid", 443, url), tooLarge);
    });
});

const payload = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 256));

for (const bytes of [1024, limit]) {
    test(`CONNECT excludes 256 KiB tunnel data from a ${bytes}-byte header budget`, async () => {
        await withProxy(socket => { socket.end(Buffer.concat([responseHead(bytes), payload])); }, async url => {
            const socket = await connectThroughProxy("example.invalid", 443, url);
            const chunks: Buffer[] = [];
            try {
                for await (const chunk of socket) chunks.push(chunk as Buffer);
                assert.deepEqual(Buffer.concat(chunks), payload);
            } finally {
                socket.destroy();
            }
        });
    });
}

for (const oversized of [false, true]) {
    test(`blind tunnel ${oversized ? "rejects an oversized head" : "forwards large data after a bounded head"}`, async () => {
        await withProxy(socket => {
            socket.end(Buffer.concat([responseHead(oversized ? 80 * 1024 : 1024), payload]));
        }, async url => {
            const bili = http.createServer();
            const peers: net.Socket[] = [];
            bili.on("connection", socket => peers.push(socket));
            setupMitm(bili, [], () => {}, () => url);
            bili.listen(0, "127.0.0.1");
            await once(bili, "listening");
            const request = http.request({
                host: "127.0.0.1", port: (bili.address() as net.AddressInfo).port,
                method: "CONNECT", path: "example.invalid:2525",
            });
            const connected = once(request, "connect");
            request.end();
            let client: net.Socket | undefined;
            try {
                const [response, socket, head] = await connected as [http.IncomingMessage, net.Socket, Buffer];
                client = socket;
                assert.equal(response.statusCode, oversized ? 502 : 200);
                if (!oversized) {
                    const chunks: Buffer[] = [head];
                    for await (const chunk of socket) chunks.push(chunk as Buffer);
                    assert.deepEqual(Buffer.concat(chunks), payload);
                }
            } finally {
                client?.destroy();
                request.destroy();
                for (const peer of peers) peer.destroy();
                await new Promise<void>(resolve => bili.close(() => resolve()));
            }
        });
    });
}
