import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { decodeRequestBody } from "../src/content-encoding.ts";

if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error("This benchmark requires a Node version with native zstd compression");
}
const input = Buffer.alloc(16 * 1024 * 1024);
input.fill("a representative repeated conversation entry; 中文 content.\n");
const encoded = zlib.zstdCompressSync(input);
const synchronousMs = [], totalMs = [];
for (let iteration = 0; iteration < 6; iteration++) {
    const started = performance.now();
    const pending = decodeRequestBody("zstd", encoded, input.length);
    const returned = performance.now();
    const decoded = await pending;
    const completed = performance.now();
    assert.deepEqual(decoded.body, input);
    if (iteration > 0) {
        synchronousMs.push(returned - started);
        totalMs.push(completed - started);
    }
}
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({
    node: process.version, bytes: input.length, compressed: encoded.length,
    warmup: 1, samples: 5,
    medianSynchronousMs: median(synchronousMs), medianTotalMs: median(totalMs),
    synchronousMs, totalMs,
}));
