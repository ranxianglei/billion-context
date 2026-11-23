import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { connectThroughProxy } from "../src/upstream-proxy.ts";
import { setupMitm } from "../src/mitm.ts";

const responseHead = "HTTP/1.1 200 Connection Established\r\n\r\n";
const greeting = Buffer.from([0, 1, 2, 13, 10, 127, 128, 254, 255]);

async function withProxy(reply: (socket: net.Socket) => void, run: (url: string) => Promise<void>): Promise<void> {
    const peers: net.Socket[] = [];
    const server = net.createServer(socket => {
        peers.push(socket);
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

function receive(socket: net.Socket, expected: Buffer, initial: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [initial];
        let received = initial.length;
        const cleanup = (): void => {
            clearTimeout(timer);
            socket.removeListener("data", onData);
            socket.removeListener("error", onError);
        };
        const onError = (error: Error): void => { cleanup(); reject(error); };
        const onData = (chunk: Buffer): void => {
            chunks.push(chunk);
            received += chunk.length;
            if (received >= expected.length) {
                cleanup();
                resolve(Buffer.concat(chunks));
            }
        };
        const timer = setTimeout(() => onError(new Error(`only received ${received}/${expected.length} tunnel bytes`)), 1000);
        if (received >= expected.length) {
            cleanup();
            resolve(initial);
            return;
        }
        socket.on("data", onData);
        socket.once("error", onError);
    });
}

for (const fragmented of [false, true]) {
    test(`CONNECT preserves binary data after ${fragmented ? "fragmented" : "complete"} response headers`, async () => {
        await withProxy(socket => {
            if (fragmented) {
                socket.write(responseHead.slice(0, -2));
                setImmediate(() => socket.write(Buffer.concat([Buffer.from("\r\n"), greeting])));
            } else socket.write(Buffer.concat([Buffer.from(responseHead), greeting]));
        }, async url => {
            const socket = await connectThroughProxy("greeting.example.invalid", 2525, url);
            try {
                assert.deepEqual(await receive(socket, greeting), greeting);
            } finally {
                socket.destroy();
            }
        });
    });
}

for (const coalesced of [false, true]) {
    test(`CONNECT retains ${coalesced ? "coalesced" : "subsequent"} bytes while its owner prepares`, async () => {
        await withProxy(socket => {
            if (coalesced) socket.write(Buffer.concat([Buffer.from(responseHead), greeting]));
            else {
                socket.write(responseHead);
                setImmediate(() => socket.write(greeting));
            }
        }, async url => {
            const socket = await connectThroughProxy("greeting.example.invalid", 2525, url);
            try {
                await new Promise(resolve => setTimeout(resolve, 50));
                assert.deepEqual(await receive(socket, greeting), greeting);
            } finally {
                socket.destroy();
            }
        });
    });
}

test("the real blind-tunnel pipe forwards a server greeting from the proxy handshake", async () => {
    await withProxy(socket => socket.write(Buffer.concat([Buffer.from(responseHead), greeting])), async url => {
        const bili = http.createServer();
        const peers: net.Socket[] = [];
        bili.on("connection", socket => peers.push(socket));
        setupMitm(bili, [], () => {}, () => url);
        bili.listen(0, "127.0.0.1");
        await once(bili, "listening");
        const request = http.request({
            host: "127.0.0.1", port: (bili.address() as net.AddressInfo).port,
            method: "CONNECT", path: "greeting.example.invalid:2525",
        });
        const connected = once(request, "connect");
        request.end();
        let client: net.Socket | undefined;
        try {
            const [response, socket, head] = await connected as [http.IncomingMessage, net.Socket, Buffer];
            client = socket;
            assert.equal(response.statusCode, 200);
            assert.deepEqual(await receive(socket, greeting, head), greeting);
        } finally {
            client?.destroy();
            request.destroy();
            for (const peer of peers) peer.destroy();
            await new Promise<void>(resolve => bili.close(() => resolve()));
        }
    });
});

test("a completed CONNECT still forwards traffic sent after a client request", async () => {
    await withProxy(socket => {
        socket.write(responseHead);
        socket.once("data", chunk => socket.write(chunk));
    }, async url => {
        const socket = await connectThroughProxy("echo.example.invalid", 2525, url);
        try {
            const reply = receive(socket, greeting);
            socket.write(greeting);
            assert.deepEqual(await reply, greeting);
        } finally {
            socket.destroy();
        }
    });
});

test("CONNECT does not hand a refused proxy response to the tunnel owner", async () => {
    await withProxy(socket => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"), async url => {
        await assert.rejects(connectThroughProxy("example.invalid", 443, url), /407 Proxy Authentication Required/);
    });
});
