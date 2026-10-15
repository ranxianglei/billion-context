import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { BodyTooLargeError, readBody } from "../src/server.ts";
import { MAX_REQUEST_BYTES } from "../src/fetch-util.ts";

test("readBody: returns buffer for a normal request", async () => {
    const buf = Buffer.from("hello");
    const req = Readable.from([buf]) as never;
    const out = await readBody(req);
    assert.equal(out.toString("utf8"), "hello");
});

test("readBody: over-limit rejects with limit+seenBytes, pauses the stream, and does NOT destroy", async () => {
    const req = new Readable({ read() {} });
    const p = readBody(req as never);
    req.push(Buffer.alloc(MAX_REQUEST_BYTES / 2));
    req.push(Buffer.alloc(MAX_REQUEST_BYTES / 2 + 16));
    let settled: unknown;
    try {
        settled = await p;
        assert.fail("should have rejected");
    } catch (e) {
        assert.ok(e instanceof BodyTooLargeError, `expected BodyTooLargeError, got ${(e as Error)?.constructor?.name}`);
        assert.equal(e.limit, MAX_REQUEST_BYTES);
        assert.equal(e.seenBytes, MAX_REQUEST_BYTES + 16, "seenBytes is the count at the crossing, not the full length");
    }
    assert.equal(req.destroyed, false, "the socket must stay alive so the caller can deliver the 413 (#3128)");
    assert.ok(req.isPaused(), "the stream must be paused so the residual parks under backpressure");
    req.push(Buffer.alloc(1024));
    req.push(null);
    await new Promise((r) => setImmediate(r));
    assert.equal(req.destroyed, false, "late end/data after the cutoff must not destroy or double-settle");
});
