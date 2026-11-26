import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { requestModelFromBody, requestModelScanCountForTest } from "../src/upstream-throttle.ts";

// #5865-P2 (throttle review F1): the pre-ingest early-hold gate (handle.ts)
// and the full 429 gate (relay.ts) both call requestModelFromBody on the SAME
// request body — a multi-MiB walk (~1 ms/MiB) paid twice per proxied POST.
// The fix memoizes {body identity → model} on a request-scoped cacheHost (the
// IncomingMessage) so the second gate reuses the first scan's result. This
// pins "one real scan, two gate calls" via the test counter, plus the
// correctness guards: a rewritten body re-scans, no-cacheHost callers never
// memoize, and memos never leak across hosts.

function bigBody(model: string): string {
    return JSON.stringify({ model, messages: Array.from({ length: 2000 }, () => "x".repeat(64)) });
}

test("#5865-P2: one scan serves both gates of a request", () => {
    const host = {};
    const body = bigBody("glm-5.2");
    const before = requestModelScanCountForTest();
    assert.equal(requestModelFromBody(body, host), "glm-5.2");
    assert.equal(requestModelFromBody(body, host), "glm-5.2", "second gate call is memoized");
    assert.equal(requestModelScanCountForTest() - before, 1, "exactly one real scan for two gate calls");
});

test("#5865-P2: a rewritten body re-scans (identity-checked, not value-cached)", () => {
    const host = {};
    const before = requestModelScanCountForTest();
    requestModelFromBody(bigBody("glm-5.2"), host);
    assert.equal(requestModelFromBody(bigBody("glm-5.3"), host), "glm-5.3");
    assert.equal(requestModelScanCountForTest() - before, 2, "different body object → fresh scan");
});

test("#5865-P2: no cacheHost → legacy behavior, always scans", () => {
    const body = bigBody("glm-5.2");
    const before = requestModelScanCountForTest();
    requestModelFromBody(body);
    requestModelFromBody(body);
    assert.equal(requestModelScanCountForTest() - before, 2);
});

test("#5865-P2: memo does not leak across hosts", () => {
    const host1 = {};
    const host2 = {};
    const body = bigBody("glm-5.2");
    const before = requestModelScanCountForTest();
    requestModelFromBody(body, host1);
    assert.equal(requestModelFromBody(body, host2), "glm-5.2");
    assert.equal(requestModelScanCountForTest() - before, 2, "each host scans once");
    // host1's memo is still intact afterwards
    requestModelFromBody(body, host1);
    assert.equal(requestModelScanCountForTest() - before, 2);
});
