import test from "node:test";
import assert from "node:assert/strict";
import { inspectContextOverflow, isMarkerlessOverflowReject } from "../src/util.ts";

// #4452: an intermediate gateway that rewrites every overflow rejection into one
// generic body (Cherry Studio strips the token counts / window) defeats the
// overflow MARKER gate — inspectContextOverflow returns isOverflow:false, so the
// whole self-heal never engages and the route starves of calibration. The relay
// must surface that shape explicitly (isMarkerlessOverflowReject) instead of the
// opaque `← upstream 400` line. Gate discipline (#3617): assert BOTH directions —
// the marker-less shape IS flagged, and anything self-heal already handles (a real
// marker, a 5xx, a non-overflow 4xx) is NOT.

// Verbatim from the #4438/#4452 field report — identical for every request id.
const GENERIC_BODY = '{"error":{"message":"Internal server error","type":"invalid_request_error","code":"bad_request"}}';

const OPENAI_OVERFLOW_BODY = JSON.stringify({
    error: {
        message:
            "This model's maximum context length is 128000 tokens. However, you requested 132096 tokens (your request used 20 inputs and 4096 output tokens). Please reduce the length of the inputs or output.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
    },
});

const CJK_OVERFLOW_BODY = JSON.stringify({ error: { message: "上下文长度超出限制", type: "invalid_request_error" } });

// #6122 field case: bili's OWN oversize-gate refusal (native-intercept) came
// back through the client as a 400 and was logged as "no parseable overflow
// marker … CANNOT engage" — while it IS the definitive over-window proof.
const GATE_REJECTION_BODY = JSON.stringify({
    error: {
        type: "server_error",
        code: "bili_gate_oversize_refusal_unattributed",
        message:
            "billion-context refused this request locally: it is not attributed to any bili-managed session, and its core text is priced over the model's context window (conservative text pricing — every declared byte counts as text, and the bar is never assumed below the larger of the client-declared window and 1,000,000 tokens) — sending it directly to the provider can only be rejected (every retry re-sends the same oversized history, #4068). ",
        retryable: false,
    },
});

test("generic gateway body on 400 is overflow-shaped but carries no parseable marker", () => {
    // The first-order failure: the marker gate itself says "not overflow".
    assert.equal(inspectContextOverflow(400, GENERIC_BODY).isOverflow, false);
    // …yet it is exactly the shape the relay must now flag as self-heal-starved.
    assert.equal(isMarkerlessOverflowReject(400, GENERIC_BODY), true);
});

test("generic gateway body on 413 is also flagged", () => {
    assert.equal(inspectContextOverflow(413, GENERIC_BODY).isOverflow, false);
    assert.equal(isMarkerlessOverflowReject(413, GENERIC_BODY), true);
});

test("a body WITH an overflow marker is NOT markerless (self-heal engages normally)", () => {
    assert.equal(inspectContextOverflow(400, OPENAI_OVERFLOW_BODY).isOverflow, true);
    assert.equal(isMarkerlessOverflowReject(400, OPENAI_OVERFLOW_BODY), false);
});

test("a CJK-marked overflow body is NOT markerless", () => {
    assert.equal(inspectContextOverflow(400, CJK_OVERFLOW_BODY).isOverflow, true);
    assert.equal(isMarkerlessOverflowReject(400, CJK_OVERFLOW_BODY), false);
});

test("5xx is excluded — those already self-heal via the local estimate (#604)", () => {
    assert.equal(isMarkerlessOverflowReject(502, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(503, GENERIC_BODY), false);
});

test("#6122: bili's own oversize-gate refusal is NOT markerless — self-heal engages from it", () => {
    // The gate body IS the marker: it is bili's own definitive over-window
    // proof. Reading it as an opaque gateway rewrite (the #4452 warn) is what
    // left the #6122 child session 400-looping — the CANNOT-engage warning
    // fires on its own refusal.
    assert.equal(inspectContextOverflow(400, GATE_REJECTION_BODY).isOverflow, true);
    assert.equal(isMarkerlessOverflowReject(400, GATE_REJECTION_BODY), false);
    // …and the prose's "1,000,000 tokens" is a pricing floor, not a learnable
    // model window — the no-window arm must be what fires, not a 1M learning.
    assert.equal(inspectContextOverflow(400, GATE_REJECTION_BODY).window, undefined);
});

test("non-overflow 4xx and success codes are excluded (no false alarm on auth/malformed)", () => {
    assert.equal(isMarkerlessOverflowReject(200, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(401, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(429, GENERIC_BODY), false);
});
