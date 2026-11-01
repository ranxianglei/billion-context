import test from "node:test";
import assert from "node:assert/strict";
import { inspectContextOverflow, isMarkerlessOverflowReject } from "../src/util.ts";

// #4452: an intermediate gateway that rewrites a payload-size rejection into one
// generic body (Cherry Studio strips the token counts / window) defeats the
// overflow MARKER gate — inspectContextOverflow returns isOverflow:false, so the
// whole self-heal never engages and the route starves of calibration. The relay
// must surface that shape explicitly (isMarkerlessOverflowReject) instead of the
// opaque `← upstream 413` line. Gate discipline (#3617): assert BOTH directions —
// the marker-less SIZE verdict (413) IS flagged, and anything self-heal already
// handles (a real marker, a 5xx, a non-size 4xx) is NOT.
//
// #4452 follow-up: the generic 400 is NOT a size verdict. Every ordinary
// malformed / schema-invalid / role-rejected request across relays answers with
// the SAME opaque body, so diagnosing an unmarked 400 as markerless overflow
// manufactured a false overflow warning for requests that carry no evidence of
// being too large at all.

// Verbatim from the #4438/#4452 field report — identical for every request id.
const GENERIC_BODY = '{"error":{"message":"Internal server error","type":"invalid_request_error","code":"bad_request"}}';

// A schema/malformed 400 body in the shape a strict backend emits.
const MALFORMED_BODY = '{"error":{"message":"Invalid request: messages[3].content must be a string or an array","type":"invalid_request_error","code":"invalid_value"}}';

const OPENAI_OVERFLOW_BODY = JSON.stringify({
    error: {
        message:
            "This model's maximum context length is 128000 tokens. However, you requested 132096 tokens (your request used 20 inputs and 4096 output tokens). Please reduce the length of the inputs or output.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
    },
});

const CJK_OVERFLOW_BODY = JSON.stringify({ error: { message: "上下文长度超出限制", type: "invalid_request_error" } });

test("generic gateway body on 413 is the markerless SIZE verdict and is flagged", () => {
    // The first-order failure: the marker gate itself says "not overflow".
    assert.equal(inspectContextOverflow(413, GENERIC_BODY).isOverflow, false);
    // …yet a 413 whose body dropped the marker is exactly the shape the relay
    // must flag as self-heal-starved.
    assert.equal(isMarkerlessOverflowReject(413, GENERIC_BODY), true);
});

test("an unmarked 400 is NOT diagnosed as overflow (generic malformed/schema rejection)", () => {
    // Neither body is overflow evidence: no status semantics and no marker.
    assert.equal(inspectContextOverflow(400, GENERIC_BODY).isOverflow, false);
    assert.equal(isMarkerlessOverflowReject(400, GENERIC_BODY), false);
    // The same must hold for a clearly schema-shaped 400 body.
    assert.equal(inspectContextOverflow(400, MALFORMED_BODY).isOverflow, false);
    assert.equal(isMarkerlessOverflowReject(400, MALFORMED_BODY), false);
});

test("an unmarked 413 is not double-counted as a marker overflow", () => {
    // 413 without a marker: the self-heal gate is closed, which is exactly why
    // the warning exists; it must never claim isOverflow.
    assert.equal(inspectContextOverflow(413, MALFORMED_BODY).isOverflow, false);
    assert.equal(isMarkerlessOverflowReject(413, MALFORMED_BODY), true);
});

test("a body WITH an overflow marker is NOT markerless (self-heal engages normally)", () => {
    assert.equal(inspectContextOverflow(400, OPENAI_OVERFLOW_BODY).isOverflow, true);
    assert.equal(isMarkerlessOverflowReject(400, OPENAI_OVERFLOW_BODY), false);
    assert.equal(inspectContextOverflow(413, OPENAI_OVERFLOW_BODY).isOverflow, true);
    assert.equal(isMarkerlessOverflowReject(413, OPENAI_OVERFLOW_BODY), false);
});

test("a CJK-marked overflow body is NOT markerless", () => {
    assert.equal(inspectContextOverflow(400, CJK_OVERFLOW_BODY).isOverflow, true);
    assert.equal(isMarkerlessOverflowReject(400, CJK_OVERFLOW_BODY), false);
    assert.equal(isMarkerlessOverflowReject(413, CJK_OVERFLOW_BODY), false);
});

test("5xx is excluded — those already self-heal via the local estimate (#604)", () => {
    assert.equal(isMarkerlessOverflowReject(502, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(503, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(507, GENERIC_BODY), false);
});

test("non-overflow 4xx and success codes are excluded (no false alarm on auth/malformed)", () => {
    assert.equal(isMarkerlessOverflowReject(200, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(401, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(404, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(422, GENERIC_BODY), false);
    assert.equal(isMarkerlessOverflowReject(429, GENERIC_BODY), false);
});
