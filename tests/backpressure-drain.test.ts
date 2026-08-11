import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { awaitDrain } from "../src/server.js";

// Regression for the session-freeze bug: every stream-write backpressure wait
// in forward() used `res.once("drain")` only. When the client stopped reading
// mid-stream (connection dropped), 'drain' never fired, the request hung
// forever, and with it the session lock chain — freezing every later request
// on that session until the proxy was restarted.
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
