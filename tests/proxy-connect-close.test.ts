import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { connectThroughProxy } from "../src/upstream-proxy.ts";

async function withProxy(reply: (socket: net.Socket) => void, run: (url: string) => Promise<void>): Promise<void> {
    const peers: net.Socket[] = [];
    const server = net.createServer((socket) => {
        peers.push(socket);
        socket.once("data", () => reply(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        await run(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    } finally {
        for (const peer of peers) peer.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

for (const prefix of ["", "HTTP/1.1 200 Connection Established\r\nProxy-Agent: incomplete"]) {
    test(`CONNECT rejects promptly when proxy closes ${prefix ? "during headers" : "without headers"}`, async () => {
        await withProxy(socket => socket.end(prefix), async (url) => {
            const result = connectThroughProxy("upstream.example", 443, url).then(
                socket => { socket.destroy(); return "unexpected success"; },
                (error: unknown) => error,
            );
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const outcome = await Promise.race([
                    result,
                    new Promise<string>(resolve => { timer = setTimeout(() => resolve("still pending after proxy EOF"), 1000); }),
                ]);
                assert.ok(outcome instanceof Error, String(outcome));
                assert.match(outcome.message, /closed.*CONNECT|CONNECT.*closed/i);
            } finally {
                clearTimeout(timer);
                // Baseline also drains its existing 10s timeout so no test
                // leaves a live handshake timer behind after the assertion.
                await result;
            }
        });
    });
}

test("a successful CONNECT hands terminal events to the tunnel owner", async () => {
    await withProxy(socket => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.once("data", data => socket.end(data));
    }, async (url) => {
        const socket = await connectThroughProxy("upstream.example", 443, url);
        const echoed = new Promise<string>((resolve, reject) => {
            let body = "";
            socket.on("data", data => { body += data.toString(); });
            socket.once("end", () => resolve(body));
            socket.once("error", reject);
        });
        socket.write("tunnel payload");
        assert.equal(await echoed, "tunnel payload");
        socket.destroy();
    });
});

test("proxy refusal still reports the received HTTP status", async () => {
    await withProxy(socket => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"), async (url) => {
        await assert.rejects(connectThroughProxy("upstream.example", 443, url), /407 Proxy Authentication Required/);
    });
});
