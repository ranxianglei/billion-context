import test from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { decodeRequestBody } from "../src/content-encoding.ts";

const JSON_BODY = Buffer.from('{"model":"gpt-5","input":"hello"}');

test("decodeRequestBody leaves identity requests untouched", async () => {
    const decoded = await decodeRequestBody(undefined, JSON_BODY, 1024);
    assert.equal(decoded.body, JSON_BODY);
    assert.equal(decoded.decoded, false);
});

test("decodeRequestBody supports gzip and stacked codings", async () => {
    const gzip = gzipSync(JSON_BODY);
    assert.deepEqual((await decodeRequestBody("gzip", gzip, 1024)).body, JSON_BODY);
    const stacked = brotliCompressSync(gzip);
    assert.deepEqual((await decodeRequestBody("gzip, br", stacked, 1024)).body, JSON_BODY);
});

test("decodeRequestBody supports Codex Desktop zstd bodies on Node 20+", async () => {
    const zstd = Buffer.from("KLUv/SAhCQEAeyJtb2RlbCI6ImdwdC01IiwiaW5wdXQiOiJoZWxsbyJ9", "base64");
    assert.deepEqual((await decodeRequestBody("zstd", zstd, 1024)).body, JSON_BODY);
});

test("decodeRequestBody rejects unsupported encodings and oversized output", async () => {
    await assert.rejects(() => decodeRequestBody("snappy", Buffer.from("x"), 1024), /unsupported/);
    await assert.rejects(() => decodeRequestBody("gzip", gzipSync(Buffer.alloc(4096)), 128));
});
