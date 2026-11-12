import test from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { decodeRequestBody, DecompressedTooLargeError } from "../src/content-encoding.ts";
import { DecodedRequestBusyError } from "../src/request-body-budget.ts";

const hasNativeZstd = typeof zlib.createZstdDecompress === "function";
const plain = Buffer.from('{"model":"gpt-5","input":"hello"}');
const encoded = Buffer.from("KLUv/SAhCQEAeyJtb2RlbCI6ImdwdC01IiwiaW5wdXQiOiJoZWxsbyJ9", "base64");

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
    assert.deepEqual((await decodeRequestBody("zstd", Buffer.concat([encoded, encoded]), 1024)).body,
        Buffer.concat([plain, plain]));
    assert.deepEqual((await decodeRequestBody("zstd, gzip", zlib.gzipSync(encoded), 1024)).body, plain);
    await assert.rejects(decodeRequestBody("zstd, gzip", zlib.gzipSync(encoded), plain.length - 1),
        DecompressedTooLargeError);
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
