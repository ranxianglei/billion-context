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

test("non-overflow 4xx and success codes are excluded (no false alarm on auth/malformed)", () => {
    assert.equal(isMarkerlessOverflowReject(200, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(401, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(429, GENERIC_BODY), false);
});
