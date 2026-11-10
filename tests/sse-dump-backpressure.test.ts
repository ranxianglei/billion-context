import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { dumpStreamToFile } from "../src/server/stream-io.ts";
import { rmrf } from "./tmp-rm.ts";

async function within<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("dump stream test timed out")), 3_000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

test("SSE dump honors sink backpressure and waits for final flush", async (t) => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "bili-dump-pressure-"));
    let firstWrite!: () => void;
    const started = new Promise<void>((resolve) => { firstWrite = resolve; });
    let finalEntered!: () => void;
    const finalizing = new Promise<void>((resolve) => { finalEntered = resolve; });
    let releaseWrite: (() => void) | undefined;
    let releaseFinal: (() => void) | undefined;
    let written = 0;
    const sink = new Writable({
        highWaterMark: 1024,
        write(chunk: Buffer, _encoding, callback) {
            written += chunk.length;
            if (releaseWrite === undefined && written === 1024) {
                releaseWrite = callback;
                firstWrite();
            } else callback();
        },
        final(callback) {
            releaseFinal = callback;
            finalEntered();
        },
    });
    let produced = 0;
    const upstream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (produced === 512) controller.close();
            else {
                produced++;
                controller.enqueue(Buffer.alloc(1024));
            }
        },
    });
    let finished = false;
    let dumping: Promise<void> | undefined;
    try {
        t.mock.method(fs, "createWriteStream", () => sink as fs.WriteStream);
        syncBuiltinESMExports();
        dumping = dumpStreamToFile(upstream, dir, "stream.sse").then(() => { finished = true; });
        await within(started);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(produced < 512, "a blocked sink must not drain the entire source");
        assert.equal(finished, false);
        releaseWrite!();
        releaseWrite = undefined;
        await within(finalizing);
        assert.equal(finished, false, "dump is incomplete until the sink's final callback");
        releaseFinal!();
        releaseFinal = undefined;
        await within(dumping);
        assert.equal(written, 512 * 1024);
        assert.equal(upstream.locked, false);
    } finally {
        releaseWrite?.();
        releaseFinal?.();
        sink.destroy();
        await dumping?.catch(() => {});
        t.mock.restoreAll();
        syncBuiltinESMExports();
        rmrf(dir);
    }
});

test("SSE dump cancels the source when the destination fails", async (t) => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "bili-dump-error-"));
    let cancelled = false;
    let produced = 0;
    const upstream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (produced++ < 512) controller.enqueue(Buffer.alloc(1024));
            else controller.close();
        },
        cancel() { cancelled = true; },
    });
    const sink = new Writable({
        highWaterMark: 1024,
        write(_chunk, _encoding, callback) {
            callback(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
        },
    });
    try {
        t.mock.method(fs, "createWriteStream", () => sink as fs.WriteStream);
        syncBuiltinESMExports();
        await within(dumpStreamToFile(upstream, dir, "stream.sse"));
        assert.equal(cancelled, true);
        assert.equal(upstream.locked, false);
    } finally {
        sink.destroy();
        if (!upstream.locked) await upstream.cancel().catch(() => {});
        t.mock.restoreAll();
        syncBuiltinESMExports();
        rmrf(dir);
    }
});
