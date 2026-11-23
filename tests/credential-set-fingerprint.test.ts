import assert from "node:assert/strict";
import test from "node:test";
import { credentialFingerprint } from "../src/cache-ledger.js";
import { _resetUpstreamThrottleForTest, noteUpstreamThrottle429, noteUpstreamThrottleResolved, upstreamThrottleGate } from "../src/upstream-throttle.js";

const first = { authorization: "Bearer gateway-key", "x-api-key": "account-a" };
const reordered = { "X-Api-Key": "account-a", Authorization: "Bearer gateway-key" };
const other = { authorization: "Bearer gateway-key", "x-api-key": "account-b" };

test("credential-set identity is independent of header insertion order and casing", () => {
    assert.equal(credentialFingerprint(first), credentialFingerprint(reordered));
});

test("every distinct credential contributes to identity", () => {
    assert.notEqual(credentialFingerprint(first), credentialFingerprint(other));
    assert.notEqual(credentialFingerprint(first), credentialFingerprint({ authorization: "Bearer account-a", "x-api-key": "gateway-key" }));
});

test("duplicate aliases for one credential preserve the single-key fingerprint", () => {
    const single = credentialFingerprint({ authorization: "Bearer same" });
    assert.equal(single, credentialFingerprint({ "x-api-key": "same", Authorization: " Bearer same ", "x-goog-api-key": "same" }));
    assert.equal(single, credentialFingerprint({ authorization: "Bearer same", "x-api-key": "", "content-type": "application/json" }));
    assert.equal(credentialFingerprint({ "x-api-key": " " }), undefined);
});

test("multi-header SDK-HMAC fingerprints ignore request signatures while preserving account isolation", () => {
    const signed = (key: string, signature: string) => `SDK-HMAC-SHA256 Access=${key}, SignedHeaders=content-type;x-sdk-date, Signature=${signature}`;
    const a = credentialFingerprint({ authorization: signed("AK_A", "first"), "api-key": "gateway" });
    const b = credentialFingerprint({ "Api-Key": "gateway", Authorization: signed("AK_A", "second") });
    const c = credentialFingerprint({ authorization: signed("AK_B", "second"), "api-key": "gateway" });
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test("a 429 hold survives header reordering and cannot block or be cleared by another credential set", () => {
    const keys = ["BILI_THROTTLE_429", "BILI_THROTTLE_429_BASE_DELAY_MS", "BILI_THROTTLE_429_MAX_DELAY_MS", "BILI_THROTTLE_429_MAX_CONSECUTIVE"] as const;
    const saved = keys.map((key) => process.env[key]);
    try {
        process.env.BILI_THROTTLE_429 = "1";
        process.env.BILI_THROTTLE_429_BASE_DELAY_MS = "2000";
        process.env.BILI_THROTTLE_429_MAX_DELAY_MS = "30000";
        process.env.BILI_THROTTLE_429_MAX_CONSECUTIVE = "5";
        _resetUpstreamThrottleForTest();
        const url = "https://multi-key.example/v1/messages";
        noteUpstreamThrottle429(url, first, null, 1000000);
        assert.equal(upstreamThrottleGate(url, reordered, 1000001).reject?.status, 429);
        assert.equal(upstreamThrottleGate(url, other, 1000001).reject, undefined);
        noteUpstreamThrottleResolved(url, other, 200, 1000002);
        assert.equal(upstreamThrottleGate(url, first, 1000003).reject?.status, 429);
        noteUpstreamThrottleResolved(url, reordered, 200, 1000004);
        assert.equal(upstreamThrottleGate(url, first, 1000005).reject, undefined);
    } finally {
        _resetUpstreamThrottleForTest();
        keys.forEach((key, index) => {
            if (saved[index] === undefined) delete process.env[key];
            else process.env[key] = saved[index];
        });
    }
});
