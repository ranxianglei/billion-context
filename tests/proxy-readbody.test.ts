import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { BodyTooLargeError, readBody } from "../src/server.ts";
import { MAX_REQUEST_BYTES } from "../src/fetch-util.ts";

// #3128: assert the LEGACY byte-budget behavior at the old 100 MiB cap. Pin the knob to
// that exact value so this stays independent of the new 5 GiB shipped default (the default
// itself is covered by knobs-config-precedence). node --test isolates each file's process.
process.env.BILI_RECEIVE_BODY_BYTES = "104857600";
process.env.BILI_DECODED_BODY_BYTES = "209715200";
process.env.BILI_OUTBOUND_BODY_BYTES = "104857600";

test("readBody: returns buffer for a normal request", async () => {
    const buf = Buffer.from("hello");
    const req = Readable.from([buf]) as never;
    const out = await readBody(req);
    assert.equal(out.toString("utf8"), "hello");
});

for (const outcome of ["success", "error"] as const) {
    test(`readBody: releases its request listeners after ${outcome}`, async () => {
        const req = new EventEmitter();
        const externalListener = () => {};
        const events = ["data", "end", "error", "close"] as const;
        for (const event of events) req.on(event, externalListener);
        const pending = readBody(req as never);
        req.emit("data", Buffer.from("hello"));
        if (outcome === "success") {
            req.emit("end");
            assert.equal((await pending).toString("utf8"), "hello");
        } else {
            const error = new Error("read failure");
            const rejection = assert.rejects(pending, (actual: unknown) => actual === error);
            req.emit("error", error);
            await rejection;
        }
        for (const event of events) {
            assert.deepEqual(req.listeners(event), [externalListener], `${event}: readBody must remove only its own listener`);
        }
    });
}

for (const withError of [false, true]) {
    test(`readBody: real IncomingMessage cancellation ${withError ? "with" : "without"} an error settles and cleans up`, { timeout: 2000 }, async () => {
        const req = new IncomingMessage(new Socket());
        const error = withError ? new Error("client disconnected") : undefined;
        const closed = new Promise<void>((resolve) => req.once("close", resolve));
        const pending = readBody(req);
        const rejection = assert.rejects(pending, (actual: unknown) => withError ? actual === error : actual instanceof Error);
        req.push(Buffer.from("hello"));
        setImmediate(() => req.destroy(error));
        await rejection;
        await closed;
        for (const event of ["data", "end", "error", "close"]) assert.equal(req.listenerCount(event), 0, event);
    });
}

test("readBody: a real IncomingMessage over the limit keeps BodyTooLargeError through destroy", { timeout: 2000 }, async (t) => {
    const previousLimit = process.env.BILI_RECEIVE_BODY_BYTES;
    process.env.BILI_RECEIVE_BODY_BYTES = "8";
    t.after(() => { process.env.BILI_RECEIVE_BODY_BYTES = previousLimit; });
    const req = new IncomingMessage(new Socket());
    const closed = new Promise<void>((resolve) => req.once("close", resolve));
    const pending = readBody(req);
    const rejection = assert.rejects(pending, (error: unknown) => error instanceof BodyTooLargeError && error.limit === 8);
    req.push(Buffer.from("1234"));
    req.push(Buffer.from("56789"));
    await rejection;
    await closed;
    assert.equal(req.destroyed, true);
    for (const event of ["data", "end", "error", "close"]) assert.equal(req.listenerCount(event), 0, event);
});

test("readBody: rejects with BodyTooLargeError AND destroys socket when body exceeds MAX_REQUEST_BYTES", async () => {
    const req = new EventEmitter();
    let destroyed = false;
    Object.defineProperty(req, "destroy", { value: () => { destroyed = true; }, configurable: true });
    const p = readBody(req as never);
    (req as EventEmitter).emit("data", Buffer.alloc(MAX_REQUEST_BYTES + 1));
    await assert.rejects(p, (e: unknown) => {
        assert.ok(e instanceof BodyTooLargeError, `expected BodyTooLargeError, got ${(e as Error)?.constructor?.name}`);
        return true;
    });
    assert.equal(destroyed, true, "req.destroy() must be called on over-limit (Bug C)");
});

test("readBody: BodyTooLargeError carries the limit", async () => {
    const req = new EventEmitter();
    Object.defineProperty(req, "destroy", { value: () => {}, configurable: true });
    const p = readBody(req as never);
    (req as EventEmitter).emit("data", Buffer.alloc(MAX_REQUEST_BYTES + 100));
    try {
        await p;
        assert.fail("should have rejected");
    } catch (e) {
        assert.ok(e instanceof BodyTooLargeError);
        if (e instanceof BodyTooLargeError) assert.equal(e.limit, MAX_REQUEST_BYTES);
    }
});
