import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
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
