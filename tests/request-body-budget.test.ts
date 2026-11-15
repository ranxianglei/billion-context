import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync, deflateRawSync, brotliCompressSync } from "node:zlib";
import { decodeRequestBody, DecompressedTooLargeError } from "../src/content-encoding.ts";
import { checkOutboundBody, DecodedRequestAdmission, DecodedRequestBusyError, LARGE_DECODED_ADMISSION_BYTES, MAX_REQUEST_BYTES, MAX_DECODED_REQUEST_BYTES, OutboundBodyTooLargeError } from "../src/request-body-budget.ts";
import { fetchWithTimeout, _liveUpstreamTimersForTest } from "../src/fetch-util.ts";

// #3128: assert the LEGACY byte-budget behavior at the old 100/200/100 MiB caps. Pin the
// knobs to those exact values so these stay independent of the new 5 GiB shipped defaults
// (the defaults themselves are covered by knobs-config-precedence). node --test isolates
// each file's process, so this cannot leak into other suites.
process.env.BILI_RECEIVE_BODY_BYTES = "104857600";
process.env.BILI_DECODED_BODY_BYTES = "209715200";
process.env.BILI_OUTBOUND_BODY_BYTES = "104857600";

test("large decoded admission: normal requests free, two large slots, third busy — at both the receive cap and the #5794 32MiB cost band", () => {
    // The slot counter is module-global, so the whole budget's behavior is
    // pinned in ONE sequential test (top-level tests in a file run
    // concurrently; two tests each grabbing two slots would starve each
    // other regardless of release hygiene).
    //
    // Phase 1 — legacy receive-cap shape (pinned 100MiB above). Under the
    // #5794 cost band the 100MiB-class body is itself LARGE (the band is
    // below it), so "normal requests stay free" is pinned at a genuinely
    // normal size and the two-slot/behind-it semantics keep their shape.
    const a = new DecodedRequestAdmission(), b = new DecodedRequestAdmission(), c = new DecodedRequestAdmission();
    try {
        // Normal-sized requests stay free regardless of the large budget.
        c.observe(1_000_000);
        // Two large slots, third busy.
        a.observe(MAX_REQUEST_BYTES + 1);
        b.observe(MAX_DECODED_REQUEST_BYTES);
        assert.throws(() => c.observe(MAX_REQUEST_BYTES + 1), DecodedRequestBusyError);
        a.release(); a.release();
        c.observe(MAX_REQUEST_BYTES + 1);
        assert.throws(() => a.observe(MAX_REQUEST_BYTES + 1), DecodedRequestBusyError);
    } finally { a.release(); b.release(); c.release(); }

    // Phase 2 — #5794 cost band: the 51.2 MiB incident body (29,619 messages,
    // ~6s of event loop per round, 747s FATAL → self-restart → every session's
    // cache cold) sits BELOW the 100MiB receive cap pinned above — the old
    // threshold let it through the slot budget entirely. The cost band closes
    // that gap without touching the operator's receive limit:
    // min(receive cap, 32MiB) is monotonic, so a smaller operator cap still
    // binds (the same expression the legacy phase already exercises at
    // 100MiB > 32MiB — here the band itself is the binding side).
    const band = LARGE_DECODED_ADMISSION_BYTES;
    assert.ok(band < MAX_REQUEST_BYTES, "the band sits below the pinned 100MiB receive cap");
    const f = new DecodedRequestAdmission(), g = new DecodedRequestAdmission(), h = new DecodedRequestAdmission();
    try {
        // Exactly at the band: free (same >-not-≥ convention as the receive cap).
        f.observe(band);
        // Just over: two slots, third busy.
        f.observe(band + 1);  // f.admitted is still false (band was free) → takes slot 1
        g.observe(band + 1);  // slot 2
        assert.throws(() => h.observe(band + 1), DecodedRequestBusyError);
        f.release();
        f.observe(band + 1);  // re-admit after release (idempotent within a request)
    } finally { f.release(); g.release(); h.release(); }
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
