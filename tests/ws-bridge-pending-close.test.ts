import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { once } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { installWebSocketBridge, type WsBridgeCodec } from "../src/ws-bridge.ts";

const headers = { "x-bili-plugin": "close-fixture", "x-bili-plugin-conversation": "pending-close" };

function fixture(proxied: boolean) {
    const server = http.createServer((_req, res) => res.writeHead(404).end());
    let created = 0;
    const codec: WsBridgeCodec = {
        name: "close-fixture", pluginMarker: "close-fixture",
        matchUpgrade: () => "https://pending-admission.example/echo",
        createSession: () => {
            created++;
            return { onMessage() {}, onClose() {}, shutdown() {} };
        },
    };
    const handler = installWebSocketBridge(server, async () => {}, () => {}, [codec], () => (proxied ? "http://127.0.0.1:3128" : undefined));
    return { server, handler, created: () => created };
}

test("server close does not admit a WebSocket whose destination check has not settled", async () => {
    const { server, handler, created } = fixture(true);
    let closed = Promise.resolve();
    server.on("upgrade", (request, socket, head) => {
        assert.equal(handler(request, socket, head), true);
        closed = new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const peer = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { headers });
    const peerClosed = new Promise<void>((resolve) => peer.on("close", () => resolve()));
    peer.on("error", () => {});
    try {
        const outcome = await Promise.race([
            new Promise<string>((resolve) => peer.on("open", () => resolve("opened"))),
            peerClosed.then(() => "closed"),
        ]);
        assert.equal(outcome, "closed", "shutdown must not create a session after its teardown pass");
        await closed;
        assert.equal(created(), 0);
    } finally {
        peer.terminate();
        await peerClosed;
        await closed;
    }
});

test("server close releases an upgrade socket without waiting for DNS admission", async (t) => {
    const lookupEntered = Promise.withResolvers<void>();
    const lookupReleased = Promise.withResolvers<Array<{ address: string; family: number }>>();
    const lookup = t.mock.method(dns, "lookup", async () => {
        lookupEntered.resolve();
        return lookupReleased.promise;
    });
    syncBuiltinESMExports();
    const { server, handler, created } = fixture(false);
    server.on("upgrade", (request, socket, head) => { assert.equal(handler(request, socket, head), true); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const peer = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { headers });
    const peerClosed = new Promise<void>((resolve) => peer.on("close", () => resolve()));
    peer.on("error", () => {});
    let closed: Promise<void> | undefined;
    try {
        await lookupEntered.promise;
        closed = new Promise<void>((resolve) => server.close(() => resolve()));
        const outcome = await Promise.race([closed.then(() => "closed"), delay(500).then(() => "still waiting for DNS")]);
        assert.equal(outcome, "closed");
        await peerClosed;
        lookupReleased.resolve([{ address: "203.0.113.1", family: 4 }]);
        await delay(0);
        assert.equal(created(), 0, "a late successful DNS answer cannot revive the upgrade");
    } finally {
        lookupReleased.resolve([]);
        lookup.mock.restore();
        syncBuiltinESMExports();
        peer.terminate();
        await peerClosed;
        if (closed) await closed;
        else { server.close(); await once(server, "close"); }
    }
});
