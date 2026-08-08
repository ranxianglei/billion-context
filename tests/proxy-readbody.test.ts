import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { BodyTooLargeError, readBody } from "../src/server.ts";
import { MAX_REQUEST_BYTES } from "../src/fetch-util.ts";

test("readBody: returns buffer for a normal request", async () => {
    const buf = Buffer.from("hello");
    const req = Readable.from([buf]) as never;
    const out = await readBody(req);
    assert.equal(out.toString("utf8"), "hello");
});

test("readBody: rejects with BodyTooLargeError when body exceeds MAX_REQUEST_BYTES (no req.destroy)", async () => {
    // Two chunks that together exceed MAX_REQUEST_BYTES. We emit the first
    // (over-limit) chunk and expect a rejection of the right kind BEFORE any
    // destroy would have run. The fix removed req.destroy() so the client
    // connection stays open for handle() to write a 413.
    const req = new EventEmitter();
    let destroyed = false;
    Object.defineProperty(req, "destroy", { value: () => { destroyed = true; }, configurable: true });
    const p = readBody(req as never);
    // Emit a chunk large enough to trip the limit.
    (req as EventEmitter).emit("data", Buffer.alloc(MAX_REQUEST_BYTES + 1));
    await assert.rejects(p, (e: unknown) => {
        assert.ok(e instanceof BodyTooLargeError, `expected BodyTooLargeError, got ${(e as Error)?.constructor?.name}`);
        return true;
    });
    assert.equal(destroyed, false, "req.destroy() must NOT be called (it cuts off the 413 response)");
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
