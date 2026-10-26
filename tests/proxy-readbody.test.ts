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

// #4753: the old implementation never removed its listeners, so the closure holding
// every network chunk stayed attached to the request for its whole life. These pins
// cover all four settlement paths, including the five-byte repro from the issue.
const READBODY_EVENTS = ["data", "end", "error", "close"] as const;
function assertNoReadBodyListeners(req: EventEmitter, label: string): void {
    for (const ev of READBODY_EVENTS) {
        assert.equal(req.listenerCount(ev), 0, `${label}: no leftover "${ev}" listeners`);
    }
}

test("readBody: detaches all owned listeners on success (five-byte repro)", async () => {
    const req = Readable.from([Buffer.from("hello")]) as unknown as EventEmitter & Readable;
    const out = await readBody(req as never);
    assert.equal(out.toString("utf8"), "hello");
    assertNoReadBodyListeners(req, "success");
});

test("readBody: detaches all owned listeners on error", async () => {
    const req = new EventEmitter();
    Object.defineProperty(req, "destroy", { value: () => {}, configurable: true });
    const p = readBody(req as never);
    req.emit("data", Buffer.from("hel"));
    req.emit("error", new Error("socket hang up"));
    await assert.rejects(p, /socket hang up/);
    assertNoReadBodyListeners(req, "error");
});

test("readBody: close before end settles as an abort instead of dangling", async () => {
    const req = new EventEmitter();
    Object.defineProperty(req, "destroy", { value: () => {}, configurable: true });
    const p = readBody(req as never);
    req.emit("data", Buffer.from("hel"));
    req.emit("close");
    await assert.rejects(p, /aborted before body completed/);
    assertNoReadBodyListeners(req, "close-before-end");
});

test("readBody: detaches all owned listeners when the body exceeds the limit", async () => {
    const req = new EventEmitter();
    let destroyed = false;
    Object.defineProperty(req, "destroy", { value: () => { destroyed = true; }, configurable: true });
    const p = readBody(req as never);
    req.emit("data", Buffer.alloc(MAX_REQUEST_BYTES + 1));
    await assert.rejects(p, BodyTooLargeError);
    assert.equal(destroyed, true);
    assertNoReadBodyListeners(req, "over-limit");
});
