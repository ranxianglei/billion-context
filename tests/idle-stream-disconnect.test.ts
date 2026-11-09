import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { pipeThrough } from "../src/server/stream-io.ts";

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(label)), 2_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

test("client disconnect releases an idle upstream reader", { timeout: 6_000 }, async () => {
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
            c.enqueue(Buffer.from("first chunk"));
        },
        cancel() { cancelled = true; },
    });
    let resolveFinished!: () => void;
    let rejectFinished!: (error: unknown) => void;
    const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
    });
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        void pipeThrough(upstream, res).then(resolveFinished, rejectFinished);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let request: http.ClientRequest | undefined;
    try {
        await within(new Promise<void>((resolve, reject) => {
            request = http.get({ host: "127.0.0.1", port: address.port }, (response) => {
                response.once("data", () => {
                    response.destroy();
                    request!.destroy();
                    resolve();
                });
                response.on("error", () => {});
            });
            request.on("error", reject);
        }), "client did not receive the initial chunk");
        await within(finished, "idle pipe did not finish after client disconnect");
        assert.equal(cancelled, true);
        assert.equal(upstream.locked, false);
    } finally {
        request?.destroy();
        if (!cancelled) controller.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await finished.catch(() => {});
    }
});

test("normal completion forwards every chunk without cancelling the source", async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(Buffer.from("hello "));
            controller.enqueue(Buffer.from("world"));
            controller.close();
        },
        cancel() { cancelled = true; },
    });
    const server = http.createServer((_req, res) => {
        void pipeThrough(upstream, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}`);
        assert.equal(await response.text(), "hello world");
        assert.equal(cancelled, false);
        assert.equal(upstream.locked, false);
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
