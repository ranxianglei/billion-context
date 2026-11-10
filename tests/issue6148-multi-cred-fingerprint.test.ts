// #6148: outbound credential identity must be insertion-order independent and
// must cover EVERY distinct credential the lane forwards. A shared gateway
// `authorization` plus a per-account `x-api-key` used to fingerprint only the
// FIRST recognized header in insertion order: reordering flipped the digest
// (the #4204 governor's holds missed on reorder), and the second credential
// was invisible (another account behind the same gateway inherited — and could
// clear on success — the first account's 429 hold). The fix collects all
// recognized headers, dedupes by normalized value, and hashes the SORTED set;
// single-distinct-value sets stay byte-identical to the pre-fix behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialFingerprint } from "../src/cache-ledger.ts";
import {
    activeThrottleHolds,
    noteUpstreamThrottle429,
    noteUpstreamThrottleResolved,
    upstreamThrottleGate,
    _resetUpstreamThrottleForTest,
} from "../src/upstream-throttle.ts";

const URL_A = "http://z.example/api/coding/paas/v4/chat/completions";
// The issue's synthetic pair: shared gateway credential + per-account key.
const H_AUTH_FIRST = { authorization: "Bearer gateway-key", "x-api-key": "account-a" };
const H_KEY_FIRST = { "x-api-key": "account-a", authorization: "Bearer gateway-key" };
const H_ACCOUNT_B = { authorization: "Bearer gateway-key", "x-api-key": "account-b" };
// Integer-second timestamp: keeps any Retry-After fixtures exact.
const T0 = 1_000_000;

function throttleReject(url: string, headers: Record<string, string>, now?: number) {
    return upstreamThrottleGate(url, headers, now).reject;
}

const KNOB_ENVS = [
    "BILI_THROTTLE_429",
    "BILI_THROTTLE_429_MAX_CONSECUTIVE",
    "BILI_THROTTLE_429_BASE_DELAY_MS",
    "BILI_THROTTLE_429_MAX_DELAY_MS",
] as const;

// Env beats the config file — pin every knob explicitly so the daemon's own
// ~/.config/billion-context/billion-context.json can never leak into a row.
function withKnobs(vars: Partial<Record<(typeof KNOB_ENVS)[number], string>>, fn: () => void): void {
    const saved: Record<string, string | undefined> = {};
    for (const k of KNOB_ENVS) saved[k] = process.env[k];
    try {
        for (const [k, v] of Object.entries(vars)) process.env[k] = v;
        fn();
    } finally {
        for (const k of KNOB_ENVS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

test("#6148: multi-credential fingerprint is insertion-order independent", () => {
    const a = credentialFingerprint(H_AUTH_FIRST);
    const b = credentialFingerprint(H_KEY_FIRST);
    assert.ok(a !== undefined, "a two-credential lane has a fingerprint");
    assert.equal(a, b, "same two credentials in reverse insertion order → SAME digest");
});

test("#6148: every distinct credential is part of the identity", () => {
    const a = credentialFingerprint(H_AUTH_FIRST);
    const b = credentialFingerprint(H_ACCOUNT_B);
    assert.ok(a !== undefined && b !== undefined);
    assert.notEqual(a, b, "changing the SECOND credential (authorization kept first) must flip the digest");
});

test("#6148: a multi-credential set is distinct from either single member", () => {
    const pair = credentialFingerprint(H_AUTH_FIRST);
    assert.ok(pair !== undefined);
    assert.notEqual(pair, credentialFingerprint({ authorization: "Bearer gateway-key" }), "pair ≠ gateway key alone");
    assert.notEqual(pair, credentialFingerprint({ "x-api-key": "account-a" }), "pair ≠ account key alone");
});

test("#6148: identical normalized values across headers still alias onto one credential (#2131)", () => {
    const both = credentialFingerprint({ authorization: "Bearer sk-live-one", "x-api-key": "sk-live-one" });
    assert.ok(both !== undefined);
    assert.equal(both, credentialFingerprint({ authorization: "Bearer sk-live-one" }), "duplicated value folds to the single-credential fingerprint");
    assert.equal(both, credentialFingerprint({ "x-api-key": "sk-live-one" }));
});

test("#6148: SDK-HMAC normalization holds inside a multi-credential set (#1884)", () => {
    const line = (ak: string, sig: string, date: string): string =>
        `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=content-type;host;x-sdk-date,Signature=${sig} x-sdk-date=${date}`;
    const a = credentialFingerprint({ authorization: line("AKLA_4444", "deadbeef".repeat(8), "20261023T120000Z"), "x-api-key": "acct-x" });
    const b = credentialFingerprint({ "x-api-key": "acct-x", authorization: line("AKLA_4444", "cafebabe".repeat(8), "20261023T130000Z") });
    assert.ok(a !== undefined && b !== undefined);
    assert.equal(a, b, "re-signed HMAC line + reordered headers → SAME set fingerprint");
    assert.notEqual(a, credentialFingerprint({ authorization: line("AKLA_OTHER", "aa", "d1"), "x-api-key": "acct-x" }), "different Access key ≠ same set");
});

test("#6148: header-name case and non-credential headers do not perturb the set", () => {
    const mixed = credentialFingerprint({ Authorization: "Bearer gateway-key", "X-Api-Key": "account-a", "content-type": "application/json" });
    assert.equal(mixed, credentialFingerprint(H_AUTH_FIRST));
});

test("#6148: empty / unrecognized inputs stay undefined (regression)", () => {
    assert.equal(credentialFingerprint(undefined), undefined);
    assert.equal(credentialFingerprint(null), undefined);
    assert.equal(credentialFingerprint({}), undefined);
    assert.equal(credentialFingerprint({ authorization: "   ", "x-api-key": "" }), undefined);
    assert.equal(credentialFingerprint({ "content-type": "application/json" }), undefined);
});

test("#6148: sorted-set join cannot collide on member boundaries", () => {
    const abC = credentialFingerprint({ authorization: "Bearer ab", "x-api-key": "c" });
    const aBc = credentialFingerprint({ authorization: "Bearer a", "x-api-key": "bc" });
    assert.ok(abC !== undefined && aBc !== undefined);
    assert.notEqual(abC, aBc, '["ab","c"] vs ["a","bc"] are different sets');
});

test("#6148: governor hold matches across header reorder (same credential set)", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_AUTH_FIRST, null, T0);
        assert.equal(activeThrottleHolds().length, 1, "one pool armed");
        const g = throttleReject(URL_A, H_KEY_FIRST, T0 + 100);
        assert.ok(g, "reordered same-set request must hit the ORIGINAL hold");
        assert.equal(g.status, 429);
        assert.equal(g.code, "bili_throttle_hold");
        assert.ok(throttleReject(URL_A, H_AUTH_FIRST, T0 + 200), "original ordering still matches the hold");
    });
});

test("#6148: an account sharing the gateway credential does not inherit or clear another account's hold", () => {
    withKnobs({ BILI_THROTTLE_429: "1", BILI_THROTTLE_429_MAX_CONSECUTIVE: "5", BILI_THROTTLE_429_BASE_DELAY_MS: "2000", BILI_THROTTLE_429_MAX_DELAY_MS: "30000" }, () => {
        _resetUpstreamThrottleForTest();
        noteUpstreamThrottle429(URL_A, H_AUTH_FIRST, null, T0);
        assert.equal(activeThrottleHolds().length, 1, "account-a pool armed");
        assert.equal(throttleReject(URL_A, H_ACCOUNT_B, T0 + 100), undefined, "account-b must NOT inherit account-a's hold");
        // account-b succeeding must NOT clear account-a's hold either.
        noteUpstreamThrottleResolved(URL_A, H_ACCOUNT_B, 200);
        assert.ok(throttleReject(URL_A, H_AUTH_FIRST, T0 + 200), "account-a's hold survives account-b's resolution");
        assert.equal(activeThrottleHolds().length, 1, "still exactly one pool armed");
    });
});
