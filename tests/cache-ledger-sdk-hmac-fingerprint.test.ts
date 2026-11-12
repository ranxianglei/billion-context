import test from "node:test";
import assert from "node:assert/strict";
import { credentialFingerprint } from "../src/cache-ledger.ts";

/**
 * #1884 resign lane / #4204 / #3376 / #2131: SDK-HMAC-SHA256 authorization
 * headers are RE-SIGNED on every request — the Signature component is an
 * HMAC over the per-request date and body, so two requests from the same
 * upstream account carry different header bytes. credentialFingerprint
 * hashed the raw line, giving every request a UNIQUE identity: the #4204
 * governor's 429 holds never matched (the resign lane never throttled), the
 * #3376 keepalive snapshot deleted itself after every forward, and #2131
 * cache-sample attribution fragmented into one bucket per request. The
 * stable credential on that line is the Access key id — the fingerprint must
 * capture only that.
 *
 * Header shape as produced by src/apig-resign.ts:292:
 *   SDK-HMAC-SHA256 Access=AKxxxx,SignedHeaders=a;b,Signature=hex
 */

const line = (ak: string, sig: string, date: string): string =>
    `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=content-type;host;x-sdk-date,Signature=${sig} x-sdk-date=${date}`;

test("credentialFingerprint: SDK-HMAC re-signed lines fold onto the Access key id", () => {
    const a = credentialFingerprint({ authorization: line("AKLA_4444", "deadbeef".repeat(8), "20261023T120000Z") });
    const b = credentialFingerprint({ authorization: line("AKLA_4444", "cafebabe".repeat(8), "20261023T130000Z") });
    assert.equal(a, b, "same Access key, different per-request Signature/date → SAME fingerprint");
});

test("credentialFingerprint: different Access keys stay distinct (and distinct from bearer)", () => {
    const a = credentialFingerprint({ authorization: line("AKLA_4444", "aa", "d1") });
    const b = credentialFingerprint({ authorization: line("AKLA_OTHER", "aa", "d1") });
    assert.notEqual(a, b, "a different Access key is a different credential");
    assert.notEqual(a, credentialFingerprint({ authorization: "Bearer AKLA_4444" }), "resign lane never aliases onto the bearer envelope");
});

test("credentialFingerprint: bearer path unchanged (regression)", () => {
    assert.equal(credentialFingerprint({ authorization: "Bearer sk-live-one" }), credentialFingerprint({ "x-api-key": "sk-live-one" }), "bearer/x-api-key unification still holds");
    assert.notEqual(credentialFingerprint({ authorization: "Bearer sk-live-one" }), credentialFingerprint({ authorization: "Bearer sk-live-two" }));
});
