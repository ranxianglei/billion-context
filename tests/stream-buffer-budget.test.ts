import assert from "node:assert/strict";
import test from "node:test";
import { bufferStreamIfFits, readStreamToBuffer } from "../src/server/stream-io.ts";

function source(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
        },
    });
}

test("inspection buffers a complete body at or below its byte budget", async () => {
    for (const cap of [0, 1, 4, 16]) {
        const bytes = Buffer.alloc(cap, 65);
        const stream = source([bytes.subarray(0, 1), Buffer.alloc(0), bytes.subarray(1)]);
        const result = await bufferStreamIfFits(stream, cap);
        assert.ok(Buffer.isBuffer(result));
        assert.deepEqual(result, bytes);
        assert.equal(stream.locked, false);
    }
});

test("overflow replays split UTF-8 bytes once and does not drain the unread tail", async () => {
    const bytes = Buffer.from("a😀b-remaining-tail");
    const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 4), bytes.subarray(4)];
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (reads < chunks.length) controller.enqueue(chunks[reads++]);
            else controller.close();
        },
    }, { highWaterMark: 0 });
    const result = await bufferStreamIfFits(stream, 3);
    assert.ok(!Buffer.isBuffer(result));
    assert.equal(reads, 2, "inspection stops at the first over-budget chunk");
    assert.deepEqual(Buffer.from(await new Response(result).arrayBuffer()), bytes);
    assert.equal(stream.locked, false);
});

test("cancelling an overflow before replay cancels and unlocks its source", async () => {
    const reason = new Error("client disconnected before replay");
    let cancelled: unknown;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(Buffer.from("over budget")); },
        cancel(value) { cancelled = value; },
    });
    const result = await bufferStreamIfFits(stream, 2);
    assert.ok(!Buffer.isBuffer(result));
    await result.cancel(reason);
    assert.equal(cancelled, reason);
    assert.equal(stream.locked, false);
});

test("cancelling a replay with a pending tail read releases both readers", async () => {
    const waiting = Promise.withResolvers<void>();
    let cancelled = false;
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (first) {
                first = false;
                controller.enqueue(Buffer.from("over budget"));
            } else waiting.resolve();
        },
        cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const result = await bufferStreamIfFits(stream, 2);
    assert.ok(!Buffer.isBuffer(result));
    const reader = result.getReader();
    assert.equal(Buffer.from((await reader.read()).value!).toString(), "over budget");
    const pending = reader.read();
    await waiting.promise;
    await reader.cancel();
    assert.equal((await pending).done, true);
    reader.releaseLock();
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
    assert.equal(result.locked, false);
});

test("source errors propagate before and after the buffer limit", async () => {
    for (const cap of [1, 100]) {
        const failure = new Error("source read failed");
        let first = true;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (first) {
                    first = false;
                    controller.enqueue(Buffer.from("prefix"));
                } else controller.error(failure);
            },
        }, { highWaterMark: 0 });
        await assert.rejects(async () => {
            const result = await bufferStreamIfFits(stream, cap);
            if (!Buffer.isBuffer(result)) await new Response(result).arrayBuffer();
        }, (error: unknown) => error === failure);
        assert.equal(stream.locked, false);
    }
});

test("the existing error-body reader still retains only its capped prefix", async () => {
    const stream = source([Buffer.from("prefix"), Buffer.from("tail")]);
    assert.equal((await readStreamToBuffer(stream, 3)).toString(), "pre");
    assert.equal(stream.locked, false);
});
