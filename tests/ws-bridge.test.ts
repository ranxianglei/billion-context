import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import { AddressInfo } from "node:net";
import WebSocket from "ws";
import { installWebSocketBridge, type WsBridgeCodec, type WsBridgeSession } from "../src/ws-bridge.ts";

// #1467 phase-2 shell: the bridge must be codec-agnostic. These tests drive
// it with a synthetic second codec (not the Responses one) to prove the
// admission table, frame dispatch, and shutdown lifecycle are generic.

class RecordingSession implements WsBridgeSession {
    static readonly live = new Set<RecordingSession>();
    readonly events: string[] = [];
    shutdowns: string[] = [];
    retainedBytes = 4096;
    constructor(readonly context: Parameters<WsBridgeCodec["createSession"]>[0]) {
        RecordingSession.live.add(this);
        context.log("info", `fake socket connected upstream=${context.upstreamUrl}`);
    }
    onMessage(data: Buffer, binary: boolean): void {
        this.events.push(`message:${binary ? "bin" : "text"}:${data.toString()}`);
        this.context.peer.send(`echo:${data.toString()}`);
    }
    onClose(code: number): void {
        this.events.push(`close:${code}`);
        RecordingSession.live.delete(this);
    }
    shutdown(reason: string): void {
        this.shutdowns.push(reason);
    }
    stats(): { retainedBytes: number; inFlight: boolean } {
        return { retainedBytes: this.retainedBytes, inFlight: this.events.length === 1 };
    }
}

const fakeCodec: WsBridgeCodec = {
    name: "fake-ws",
    pluginMarker: "fakehost",
    matchUpgrade: url => /^\/bili\/fake\/(https?:\/\/[^/]+\/echo)$/.exec(url ?? "")?.[1],
    createSession: context => new RecordingSession(context),
};

async function harness(codecs: readonly WsBridgeCodec[], options: Parameters<typeof installWebSocketBridge>[4] = {}) {
    const server = http.createServer((_req, res) => res.writeHead(404).end());
    const logs: string[] = [];
    const handler = installWebSocketBridge(server, (_req, res) => { res.writeHead(200).end(); return Promise.resolve(); }, (level, message) => logs.push(`${level} ${message}`), codecs, options);
    server.on("upgrade", (req, socket, head) => { if (!handler(req, socket, head)) socket.destroy(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return { server, handler, logs, port: (server.address() as AddressInfo).port };
}

test("ws bridge: second codec claims its own path+marker and exchanges frames", async () => {
    const upstream = http.createServer();
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const { server, logs, port } = await harness([fakeCodec]);
    try {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/bili/fake/http://127.0.0.1:${upstreamPort}/echo`, {
            headers: { "x-bili-plugin": "fakehost", "x-bili-plugin-conversation": "ses_fake_1" },
        });
        const received = new Promise<string>(resolve => socket.on("message", data => resolve(data.toString())));
        socket.on("open", () => socket.send("hello"));
        assert.equal(await received, "echo:hello");
        const session = [...RecordingSession.live][0]!;
        socket.close(1000);
        await new Promise(resolve => socket.on("close", resolve));
        const deadline = Date.now() + 5000;
        while (!session.events.includes("close:1000") && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.deepEqual(session.events, ["message:text:hello", "close:1000"]);
        assert.ok(logs.some(line => line.includes("[fake-ws] [conn=1] [session=\"ses_fake_1\"] fake socket connected")));
    } finally {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => upstream.close(resolve));
    }
});

test("ws bridge: stats() reports live connections, idle age and retained bytes; idle warn fires once per episode (#1926)", async () => {
    const upstream = http.createServer();
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    let clock = 1_000_000;
    const { server, handler, logs, port } = await harness([fakeCodec], { now: () => clock, scanMs: 5, idleWarnMs: 1_800_000 });
    try {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/bili/fake/http://127.0.0.1:${upstreamPort}/echo`, {
            headers: { "x-bili-plugin": "fakehost", "x-bili-plugin-conversation": "ses_stats" },
        });
        await new Promise<void>((resolve, reject) => { socket.on("open", resolve); socket.on("error", reject); });
        socket.send("ping");
        await new Promise<void>(resolve => setTimeout(resolve, 25)); // let the frame land + one scan pass at idle ~0
        // Idle age grows with the injected clock.
        clock += 60_000;
        const early = handler.stats();
        assert.equal(early.connections.length, 1);
        assert.equal(early.connections[0].codec, "fake-ws");
        assert.equal(early.connections[0].retainedBytes, 4096);
        assert.equal(early.connections[0].inFlight, true);
        assert.ok(Math.abs(early.connections[0].idleMs - 60_000) < 1, `idleMs ${early.connections[0].idleMs}`);
        assert.ok(!logs.some(line => line.includes("(#1926)")), "no warn before the threshold");
        // Cross the idle threshold → exactly one warn line (seconds may lag the
        // threshold slightly — the scan runs on a wall-clock interval).
        clock += 1_800_000;
        const deadline = Date.now() + 5000;
        while (!logs.some(line => /idle 18\d\ds/.test(line) && line.includes("(#1926)")) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        const warns = logs.filter(line => line.includes("(#1926)"));
        assert.equal(warns.length, 1, `expected one idle warn, got: ${logs.join(" | ")}`);
        assert.ok(warns[0].includes("[fake-ws] [conn=1]"));
        assert.ok(warns[0].includes("retained≈4096 bytes"));
        // Activity resets the episode — a later idle crossing is a NEW warn,
        // but only one per episode.
        socket.send("pong");
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        clock += 2_400_000;
        const deadline2 = Date.now() + 5000;
        while (logs.filter(line => line.includes("(#1926)")).length < 2 && Date.now() < deadline2) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(logs.filter(line => line.includes("(#1926)")).length, 2, `second episode must warn exactly once, got: ${logs.join(" | ")}`);
        // Close removes the connection from stats().
        socket.close(1000);
        await new Promise(resolve => socket.on("close", resolve));
        const deadline3 = Date.now() + 5000;
        while (handler.stats().connections.length > 0 && Date.now() < deadline3) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(handler.stats().connections.length, 0);
    } finally {
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => upstream.close(resolve));
    }
});

test("ws bridge: marker mismatch or foreign path falls through unclaimed", async () => {
    const { server, handler } = await harness([fakeCodec]);
    try {
        const upgrade = (headers: Record<string, string>) => handler(
            Object.assign(new http.IncomingMessage(new net.Socket()), { url: "/bili/fake/http://127.0.0.1:9/echo", headers }),
            new Duplex(),
            Buffer.alloc(0),
        );
        assert.equal(upgrade({ "x-bili-plugin": "opencode", "x-bili-plugin-conversation": "ses" }), false);
        assert.equal(upgrade({ "x-bili-plugin-conversation": "ses" }), false);
        assert.equal(upgrade({ "x-bili-plugin": "fakehost" }), false);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test("ws bridge: server close shuts every session down and terminates peers", async () => {
    const upstream = http.createServer();
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    const { server, port } = await harness([fakeCodec]);
    try {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/bili/fake/http://127.0.0.1:${upstreamPort}/echo`, {
            headers: { "x-bili-plugin": "fakehost", "x-bili-plugin-conversation": "ses_fake_2" },
        });
        await new Promise<void>((resolve, reject) => { socket.on("open", resolve); socket.on("error", reject); });
        const session = [...RecordingSession.live].at(-1)!;
        const closed = new Promise<void>(resolve => socket.on("close", resolve));
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        await closed;
        assert.deepEqual(session.shutdowns, ["server-close"]);
        assert.equal(socket.readyState, WebSocket.CLOSED);
    } finally {
        await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
});
