import test from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { decodeRequestBody, DecompressedTooLargeError } from "../src/content-encoding.ts";
import { DecodedRequestBusyError } from "../src/request-body-budget.ts";

const hasNativeZstd = typeof zlib.createZstdDecompress === "function";
const plain = Buffer.from('{"model":"gpt-5","input":"hello"}');
const encoded = Buffer.from("KLUv/SAhCQEAeyJtb2RlbCI6ImdwdC01IiwiaW5wdXQiOiJoZWxsbyJ9", "base64");
const unknownSize = Buffer.from("KLUv/QAACQEAeyJtb2RlbCI6ImdwdC01IiwiaW5wdXQiOiJoZWxsbyJ9", "base64");
const checksummed = Buffer.from("KLUv/SQhCQEAeyJtb2RlbCI6ImdwdC01IiwiaW5wdXQiOiJoZWxsbyJ9TTP3+Q==", "base64");
const skippable = Buffer.from("5f2a4d1803000000010203", "hex");

test("zstd decoding can be cancelled after starting without processing the whole body", { skip: !hasNativeZstd }, async () => {
    const raw = Buffer.alloc(4 * 1024 * 1024, 65);
    const input = zlib.zstdCompressSync(raw);
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    let bytes = 0;
    const pending = decodeRequestBody("zstd", input, raw.length, {
        signal: controller.signal,
        onBytes: (count) => { bytes = count; },
    });
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.ok(bytes < raw.length);
});

test("cancelling one zstd decode does not cancel a concurrent request", { skip: !hasNativeZstd }, async () => {
    const controller = new AbortController();
    const cancelled = decodeRequestBody("zstd", encoded, 1024, { signal: controller.signal });
    const completed = decodeRequestBody("zstd", encoded, 1024);
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.deepEqual((await completed).body, plain);
});

test("zstd decoding stops if the byte observer cancels the final output chunk", { skip: !hasNativeZstd }, async () => {
    const controller = new AbortController();
    let chunks = 0;
    await assert.rejects(decodeRequestBody("zstd", encoded, 1024, {
        signal: controller.signal,
        onBytes: () => { chunks++; controller.abort(); },
    }), { name: "AbortError" });
    assert.equal(chunks, 1);
});

test("zstd decoding preserves exact byte limits and the resource-admission error", async () => {
    assert.deepEqual((await decodeRequestBody("zstd", encoded, plain.length)).body, plain);
    await assert.rejects(decodeRequestBody("zstd", encoded, plain.length - 1), DecompressedTooLargeError);
    const busy = new DecodedRequestBusyError();
    await assert.rejects(decodeRequestBody("zstd", encoded, 1024, {
        onBytes: () => { throw busy; },
    }), (error) => error === busy);
});

test("zstd decoding supports concatenated frames and stacked content encodings", async () => {
    const input = Buffer.concat([encoded, encoded]);
    const observed: number[] = [];
    assert.deepEqual((await decodeRequestBody("zstd", input, plain.length * 2, {
        onBytes: (count) => observed.push(count),
    })).body,
        Buffer.concat([plain, plain]));
    assert.equal(observed.at(-1), plain.length * 2);
    assert.ok(observed.every((count, i) => i === 0 || count >= observed[i - 1]));
    await assert.rejects(decodeRequestBody("zstd", input, plain.length * 2 - 1),
        (error) => error instanceof DecompressedTooLargeError && error.limit === plain.length * 2 - 1);
    const busy = new DecodedRequestBusyError();
    await assert.rejects(decodeRequestBody("zstd", input, 1024, {
        onBytes: (count) => { if (count > plain.length) throw busy; },
    }), (error) => error === busy);
    const controller = new AbortController();
    const reason = new Error("cancelled in the second frame");
    await assert.rejects(decodeRequestBody("zstd", input, 1024, {
        signal: controller.signal,
        onBytes: (count) => { if (count > plain.length) controller.abort(reason); },
    }), (error) => error === reason);
    assert.deepEqual((await decodeRequestBody("zstd, gzip", zlib.gzipSync(encoded), 1024)).body, plain);
    await assert.rejects(decodeRequestBody("zstd, gzip", zlib.gzipSync(encoded), plain.length - 1),
        DecompressedTooLargeError);
});

test("zstd decoding accepts unknown-size and checksummed frames with interleaved skippable data", async () => {
    assert.deepEqual((await decodeRequestBody("zstd", unknownSize, plain.length)).body, plain);
    assert.deepEqual((await decodeRequestBody("zstd", checksummed, plain.length)).body, plain);
    const input = Buffer.concat([skippable, unknownSize, skippable, checksummed, skippable]);
    assert.deepEqual((await decodeRequestBody("zstd", input, plain.length * 2)).body,
        Buffer.concat([plain, plain]));
    assert.deepEqual((await decodeRequestBody("zstd", skippable, 0)).body, Buffer.alloc(0));
});

test("zstd decoding accepts RLE and compressed blocks", async () => {
    const rle = Buffer.from("28b52ffd20210b010041", "hex");
    assert.deepEqual((await decodeRequestBody("zstd", rle, 33)).body, Buffer.alloc(33, 65));
    const compressed = Buffer.from("KLUv/WDoAk0AABBBQQEA4yuABQ==", "base64");
    assert.deepEqual((await decodeRequestBody("zstd", compressed, 1000)).body, Buffer.alloc(1000, 65));
});

for (const [name, input] of [
    ["unknown-size block", unknownSize.subarray(0, -1)],
    ["checksum", checksummed.subarray(0, -1)],
    ["second frame", Buffer.concat([encoded, encoded.subarray(0, -1)])],
    ["skippable payload", skippable.subarray(0, -1)],
    ["trailing skippable payload", Buffer.concat([encoded, skippable.subarray(0, -1)])],
    ["frame header", encoded.subarray(0, 5)],
    ["block header", encoded.subarray(0, 8)],
] as const) {
    test(`zstd decoding rejects a truncated ${name}`, async () => {
        await assert.rejects(decodeRequestBody("zstd", input, 1024));
    });
}

test("zstd decoding keeps native checksum validation for later frames", { skip: !hasNativeZstd }, async () => {
    const corrupt = Buffer.from(checksummed);
    corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(decodeRequestBody("zstd", Buffer.concat([encoded, corrupt]), 1024));
});

test("zstd decoding rejects truncated input and respects pre-aborted requests", async () => {
    await assert.rejects(decodeRequestBody("zstd", encoded.subarray(0, -1), 1024));
    await assert.rejects(decodeRequestBody("zstd", Buffer.from("not a zstd frame"), 1024));
    const controller = new AbortController();
    const reason = new Error("already disconnected");
    controller.abort(reason);
    await assert.rejects(decodeRequestBody("zstd", encoded, 1024, { signal: controller.signal }),
        (error) => error === reason);
});

test("zstd decoding still works when node:zlib has no native zstd factory", () => {
    const contentEncoding = new URL("../src/content-encoding.ts", import.meta.url).href;
    const budget = new URL("../src/request-body-budget.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
        import assert from "node:assert/strict";
        import zlib from "node:zlib";
        import { syncBuiltinESMExports } from "node:module";
        Reflect.set(zlib, "createZstdDecompress", undefined);
        syncBuiltinESMExports();
        const { decodeRequestBody, DecompressedTooLargeError } = await import(${JSON.stringify(contentEncoding)});
        const { DecodedRequestBusyError } = await import(${JSON.stringify(budget)});
        const input = Buffer.from(${JSON.stringify(encoded.toString("base64"))}, "base64");
        const expected = Buffer.from(${JSON.stringify(plain.toString())});
        assert.deepEqual((await decodeRequestBody("zstd", input, expected.length)).body, expected);
        await assert.rejects(decodeRequestBody("zstd", input, expected.length - 1), DecompressedTooLargeError);
        await assert.rejects(decodeRequestBody("zstd", input, 1024, {
            onBytes: () => { throw new DecodedRequestBusyError(); },
        }), DecodedRequestBusyError);
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(decodeRequestBody("zstd", input, 1024, { signal: controller.signal }), { name: "AbortError" });
    `], { encoding: "utf8", timeout: 20_000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
});
