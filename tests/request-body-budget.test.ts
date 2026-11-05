import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateRawSync, brotliCompressSync } from "node:zlib";
import { decodeRequestBody, DecompressedTooLargeError } from "../src/content-encoding.ts";
import { checkOutboundBody, DecodedRequestAdmission, DecodedRequestBusyError, MAX_REQUEST_BYTES, MAX_DECODED_REQUEST_BYTES, OutboundBodyTooLargeError } from "../src/request-body-budget.ts";
import { fetchWithTimeout, _liveUpstreamTimersForTest } from "../src/fetch-util.ts";

// #3128: assert the LEGACY byte-budget behavior at the old 100/200/100 MiB caps. Pin the
// knobs to those exact values so these stay independent of the new 5 GiB shipped defaults
// (the defaults themselves are covered by knobs-config-precedence). node --test isolates
// each file's process, so this cannot leak into other suites.
process.env.BILI_RECEIVE_BODY_BYTES = "104857600";
process.env.BILI_DECODED_BODY_BYTES = "209715200";
process.env.BILI_OUTBOUND_BODY_BYTES = "104857600";

test("large decoded admission keeps normal requests free, limits two large requests, and releases idempotently", () => {
    const a = new DecodedRequestAdmission(), b = new DecodedRequestAdmission(), c = new DecodedRequestAdmission();
    try {
        c.observe(MAX_REQUEST_BYTES);
        a.observe(MAX_REQUEST_BYTES + 1);
        a.observe(MAX_DECODED_REQUEST_BYTES);
        b.observe(MAX_REQUEST_BYTES + 1);
        assert.throws(() => c.observe(MAX_REQUEST_BYTES + 1), DecodedRequestBusyError);
        a.release(); a.release();
        c.observe(MAX_REQUEST_BYTES + 1);
        assert.throws(() => a.observe(MAX_REQUEST_BYTES + 1), DecodedRequestBusyError);
    } finally { a.release(); b.release(); c.release(); }
});

test("every stacked decode retains its hard cap and resource failures do not fall back to raw deflate", async () => {
    const raw = Buffer.alloc(8192, 65);
    for (const [encoding, input] of [["gzip", gzipSync(raw)], ["gzip, br", brotliCompressSync(gzipSync(raw))], ["deflate", deflateRawSync(raw)]] as const) {
        await assert.rejects(decodeRequestBody(encoding, input, 4096), DecompressedTooLargeError);
        await assert.rejects(decodeRequestBody(encoding, input, 16_384, { onBytes: () => { throw new DecodedRequestBusyError(); } }), DecodedRequestBusyError);
    }
});

test("decoding stops on client cancellation, including a pre-aborted signal", async () => {
    const ac = new AbortController();
    const input = gzipSync(Buffer.alloc(100_000, 65));
    let chunks = 0;
    await assert.rejects(decodeRequestBody("gzip", input, 200_000, { signal: ac.signal, onBytes: () => { chunks++; ac.abort(); } }), { name: "AbortError" });
    assert.equal(chunks, 1);
    await assert.rejects(decodeRequestBody("gzip", input, 200_000, { signal: ac.signal }), { name: "AbortError" });
});

test("outbound budget counts UTF-8 bytes and refuses before fetch or upstream watchdog allocation", async () => {
    const unicode = "界".repeat(Math.floor(MAX_REQUEST_BYTES / 3) + 1);
    assert.throws(() => checkOutboundBody(unicode), OutboundBodyTooLargeError);
    const timers = _liveUpstreamTimersForTest();
    await assert.rejects(fetchWithTimeout("http://127.0.0.1:1", { method: "POST", body: unicode }), OutboundBodyTooLargeError);
    assert.equal(_liveUpstreamTimersForTest(), timers);
    checkOutboundBody(Buffer.alloc(1));
});
