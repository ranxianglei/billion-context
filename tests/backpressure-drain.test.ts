import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { awaitDrain, pipeThrough } from "../src/server/stream-io.js";
import { pipePluginChatWithStrip } from "../src/plugin.js";

// Regression for the session-freeze bug (#100): every stream-write backpressure
// wait used `res.once("drain")` only. When the client stopped reading mid-stream
// (connection dropped), 'drain' never fired, the request hung forever with no log
// or error, leaking the request's finally-blocks (in-flight counter, timers) and
// freezing everything else on that session until the proxy was restarted.

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let t: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            p,
            new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
        ]);
    } finally {
        clearTimeout(t);
    }
}

test("awaitDrain stays pending until drain, close, or error", async () => {
    const res = new EventEmitter() as never;
    let resolved = false;
    const p = awaitDrain(res).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolved, false, "must still be pending before any event");
    (res as EventEmitter).emit("drain");
    await p;
    assert.equal(resolved, true, "drain resolves");
});

test("awaitDrain resolves on client close (the bug: drain never fires)", async () => {
    const res = new EventEmitter() as never;
    let resolved = false;
    const p = awaitDrain(res).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(resolved, false, "must still be pending before close");
    (res as EventEmitter).emit("close");
    await p;
    assert.equal(resolved, true, "close must resolve so the stream loop can finish");
});

test("awaitDrain resolves on error", async () => {
    const res = new EventEmitter() as never;
    let resolved = false;
    const p = awaitDrain(res).then(() => { resolved = true; });
    (res as EventEmitter).emit("error");
    await p;
    assert.equal(resolved, true, "error must resolve");
});

test("awaitDrain removes its one-shot listeners once resolved (no listener leak)", async () => {
    const res = new EventEmitter();
    void awaitDrain(res as never);
    assert.equal(res.listenerCount("drain"), 1, "drain listener armed while pending");
    assert.equal(res.listenerCount("close"), 1, "close listener armed while pending");
    assert.equal(res.listenerCount("error"), 1, "error listener armed while pending");
    res.emit("drain");
    assert.equal(res.listenerCount("drain"), 0, "drain listener removed after resolving");
    assert.equal(res.listenerCount("close"), 0, "close listener removed after resolving");
    assert.equal(res.listenerCount("error"), 0, "error listener removed after resolving");
});

test("awaitDrain resolves immediately for an already-dead response without registering listeners", async () => {
    let listenerCalls = 0;
    const res = { destroyed: true, writableEnded: false, once: () => { listenerCalls += 1; } };
    await withTimeout(awaitDrain(res), 50, "awaitDrain on dead response");
    assert.equal(listenerCalls, 0, "no listeners may accumulate on a dead response");
});

class CloseOnceRes extends EventEmitter {
    destroyed = false;
    writableEnded = false;
    write(): boolean {
        if (!this.destroyed) {
            this.destroyed = true;
            setImmediate(() => this.emit("close"));
        }
        return false;
    }
    end(): void { this.writableEnded = true; }
}

test("consecutive backpressure waits after a single close do not hang", async () => {
    const raw = new CloseOnceRes();
    const res = raw as unknown as Parameters<typeof awaitDrain>[0];
    await withTimeout((async () => {
        if (!raw.write()) await awaitDrain(res);
        if (!raw.write()) await awaitDrain(res);
        raw.end();
    })(), 500, "second backpressure wait after disconnect");
});

function connectThenDestroyAfter(port: number, dataEvents: number): Promise<void> {
    return new Promise((resolve) => {
        let settled = false;
        const safety = setTimeout(() => done(), 10000);
        const done = (): void => {
            if (!settled) {
                settled = true;
                clearTimeout(safety);
                resolve();
            }
        };
        const req = http.get({ host: "127.0.0.1", port }, (clientRes) => {
            let n = 0;
            clientRes.on("data", () => {
                n += 1;
                if (n >= dataEvents) {
                    req.destroy();
                    done();
                }
            });
            clientRes.on("end", done);
            clientRes.on("error", done);
        });
        req.on("error", done);
    });
}

test("pipeThrough ends promptly when the client disconnects mid-stream (#100 repro)", async () => {
    const chunk = Buffer.alloc(16 * 1024, 7);
    const upstream = new ReadableStream<Uint8Array>({
        start(c) {
            for (let i = 0; i < 400; i++) c.enqueue(chunk);
            c.close();
        },
    });
    let resolveFinished!: () => void;
    const finished = new Promise<void>((r) => { resolveFinished = r; });
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        void pipeThrough(upstream, res).then(() => resolveFinished());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
        await connectThenDestroyAfter(port, 3);
        await withTimeout(finished, 5000, "pipeThrough did not finish after client disconnect");
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
});

test("plugin chat strip pipe ends promptly when the client disconnects mid-stream (#100 primary path)", async () => {
    const pad = "x".repeat(16 * 1024 - 96);
    const frames: string[] = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "qwen", stop_reason: null, stop_sequence: null, usage: { input_tokens: 10 } } })}\n\n`,
    ];
    for (let i = 0; i < 400; i++) {
        frames.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: pad } })}\n\n`);
    }
    frames.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    const enc = new TextEncoder();
    let i = 0;
    const upstream = new ReadableStream<Uint8Array>({
        pull(c) {
            if (i < frames.length) c.enqueue(enc.encode(frames[i++]));
            else c.close();
        },
    });
    let resolveFinished!: () => void;
    const finished = new Promise<void>((r) => { resolveFinished = r; });
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        void pipePluginChatWithStrip(upstream, res, "anthropic").then(() => resolveFinished());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
        await connectThenDestroyAfter(port, 3);
        await withTimeout(finished, 5000, "chat strip pipe did not finish after client disconnect");
    } finally {
        server.closeAllConnections?.();
        server.close();
    }
});
