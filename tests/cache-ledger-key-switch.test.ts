import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildSessionCacheReport,
    credentialFingerprint,
    handleAcpCache,
    noteForwardedBody,
    settleUsageReport,
} from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

const T0 = Date.parse("2026-10-04T10:00:00Z");

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `ksw-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function fp(secret: string): string {
    const f = credentialFingerprint({ authorization: `Bearer ${secret}` });
    assert.ok(f !== undefined, "fingerprint must resolve");
    return f;
}

function turn(session: Session, body: string, keyFp: string | undefined, at: number, total: number, cached: number | null): void {
    noteForwardedBody(session, body, 4, keyFp);
    settleUsageReport(session, { total, reportedCached: cached, protocol: "openai", upstream: "https://relay.example" }, undefined);
    // settleUsageReport stamps Date.now() — nothing here depends on wall clock,
    // but keep the ledger ordering deterministic for readers.
    const led = (session.metadata as Record<string, { lines: Array<{ at: number }> }> & object)["cacheLedger"]!;
    led.lines[led.lines.length - 1]!.at = at;
}

test("credentialFingerprint hashes recognized headers, never stores the raw key (#2131)", () => {
    assert.equal(credentialFingerprint(undefined), undefined);
    assert.equal(credentialFingerprint({}), undefined);
    assert.equal(credentialFingerprint({ "content-type": "application/json" }), undefined);
    const a = credentialFingerprint({ Authorization: "Bearer sk-live-secret-aaa" });
    const b = credentialFingerprint({ "X-Api-Key": "sk-live-secret-aaa" });
    const c = credentialFingerprint({ authorization: "Bearer sk-live-secret-bbb" });
    assert.match(a!, /^sha256:[0-9a-f]{12}$/);
    // Case-insensitive header names + cross-header same-secret stability.
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(!a!.includes("sk-live"));
});

test("key switch flags the first sample after a rotation and attributes its residual (#2131)", () => {
    const session = makeSession();
    session.metadata.lastModel = "glm-5.3";
    const keyA = fp("sk-account-one");
    const keyB = fp("sk-account-two");
    turn(session, "b1", keyA, T0 + 1000, 10_000, 9000);
    turn(session, "b2", keyA, T0 + 2000, 10_500, 10_000);
    // Same URL, same model, same wire — only the relay rotated the account.
    turn(session, "b3", keyB, T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    assert.equal(r.keySwitches.count, 1);
    // missed 11000 = growth 500 (new content) + 10500 re-billed stable prefix.
    assert.equal(r.keySwitches.missedTokens, 10_500);
    const ev = r.keySwitches.events[0]!;
    assert.equal(ev.seq, 3);
    assert.equal(ev.from, keyA);
    assert.equal(ev.to, keyB);
    assert.equal(ev.attributed, 10_500);
    const l3 = r.lines.find((l) => l.seq === 3)!;
    assert.equal(l3.newContent, 500);
    assert.equal(l3.ttlRepay, 10_500);
    assert.equal(r.modelSwitches.count, 0);
    assert.equal(r.invalidation.key, 10_500);
    // The URL-granular dimension stays silent — this is exactly the rotation
    // an upstream-switch identity cannot see.
    assert.equal(r.upstreamSwitches.count, 0);
    assert.equal(r.totals.residual, 0);
    assert.equal(r.totals.balanced, true);
});

test("cold rounds after a key switch stay charged to the rotation; a warm line closes the window (#2131)", () => {
    const session = makeSession();
    session.metadata.lastModel = "glm-5.3";
    const keyA = fp("sk-account-one");
    const keyB = fp("sk-account-two");
    turn(session, "b1", keyA, T0 + 1000, 10_000, 9000);
    turn(session, "b2", keyA, T0 + 2000, 10_500, 10_000);
    turn(session, "b3", keyB, T0 + 3000, 11_000, 0); // the switch itself
    turn(session, "b4", keyB, T0 + 4000, 11_200, 3_000); // cold tail, same key
    turn(session, "b5", keyB, T0 + 5000, 11_400, 11_000); // warm → close
    turn(session, "b6", keyB, T0 + 6000, 11_600, 4_000); // cold again, no open window
    const led = (session.metadata as Record<string, { lines: Array<{ seq: number; cause?: string }> }> & object)["cacheLedger"]!;
    const causeOf = (n: number) => led.lines.find((l) => l.seq === n)?.cause;
    assert.equal(causeOf(4), "key");
    assert.equal(causeOf(5), undefined);
    assert.equal(causeOf(6), undefined);
    const r = buildSessionCacheReport(session);
    // One discrete event; the tail rides the cold-window charge.
    assert.equal(r.keySwitches.count, 1);
    assert.ok(r.keySwitches.missedTokens >= 10_500);
});

test("lanes without credential capture never fabricate switch events (#2131)", () => {
    const session = makeSession();
    session.metadata.lastModel = "glm-5.3";
    turn(session, "b1", undefined, T0 + 1000, 10_000, 9000);
    const keyA = fp("sk-account-one");
    turn(session, "b2", keyA, T0 + 2000, 10_500, 10_000);
    // First known fingerprint: no prior known → no switch possible.
    turn(session, "b3", undefined, T0 + 3000, 11_000, 0);
    // A↦unknown↦A with no real rotation: the unknown lane must not fabricate
    // a switch by advancing (or clearing) the known baseline.
    turn(session, "b4", keyA, T0 + 4000, 11_500, 10_500);
    const r = buildSessionCacheReport(session);
    assert.equal(r.keySwitches.count, 0);
    assert.equal(r.keySwitches.missedTokens, 0);
    assert.deepEqual(r.keySwitches.events, []);
});

test("a byte-identical re-note without headers inherits the prior fingerprint (#2131 non-streaming settle)", () => {
    const session = makeSession();
    session.metadata.lastModel = "glm-5.3";
    const keyA = fp("sk-account-one");
    noteForwardedBody(session, "same-body", 4, keyA);
    // The non-streaming settle re-notes the same wireBody without headers.
    noteForwardedBody(session, "same-body", 4);
    settleUsageReport(session, { total: 10_000, reportedCached: 9_000, protocol: "openai", upstream: "https://relay.example" }, undefined);
    const r = buildSessionCacheReport(session);
    const l1 = r.lines.find((l) => l.seq === 1)!;
    assert.equal(l1.keyFp, keyA);
});

test("a model change outranks a co-occurring key change; the shadowed counter stays silent (#2131 #2784)", () => {
    const session = makeSession();
    session.metadata.lastModel = "glm-5.3";
    const keyA = fp("sk-account-one");
    const keyB = fp("sk-account-two");
    turn(session, "b1", keyA, T0 + 1000, 10_000, 9_000);
    turn(session, "b2", keyA, T0 + 2000, 10_500, 10_000);
    session.metadata.lastModel = "deepseek-v4.1";
    turn(session, "b3", keyB, T0 + 3000, 11_000, 0);
    const r = buildSessionCacheReport(session);
    // ONE narrative cause per line (#2784): the model switch narrates it; the rotation that rode
    // along on the same request no longer books its own zero-token event. The raw observation
    // stays on the line itself (kw flag + fingerprint pair).
    assert.equal(r.modelSwitches.count, 1);
    assert.equal(r.keySwitches.count, 0);
    assert.deepEqual(r.keySwitches.events, []);
    // The partition charges the residual to the model only.
    assert.equal(r.modelSwitches.missedTokens, 10_500);
    assert.equal(r.keySwitches.missedTokens, 0);
    assert.equal(r.invalidation.model, 10_500);
    assert.equal(r.invalidation.key, 0);
    assert.equal(r.totals.residual, 0);
});

test("handleAcpCache surfaces a KEY SWITCHES section and never the raw credential (#2131)", () => {
    const session = makeSession();
    session.metadata.lastModel = "glm-5.3";
    const secret = "sk-live-rotation-secret";
    const keyA = fp(`${secret}-a`);
    const keyB = fp(`${secret}-b`);
    turn(session, "b1", keyA, T0 + 1000, 10_000, 9_000);
    turn(session, "b2", keyA, T0 + 2000, 10_500, 10_000);
    turn(session, "b3", keyB, T0 + 3000, 11_000, 0);

    const text = handleAcpCache(session, { detail: "full" }).text;
    assert.ok(text.includes("KEY SWITCHES (relay account rotation)"), "dedicated section expected");
    assert.ok(text.includes(`${keyA} → ${keyB}`), "fingerprint pair expected");
    assert.ok(text.includes("key switch:"), "invalidation line expected");
    assert.ok(!text.includes(secret), "raw credential must never render");

    const quiet = makeSession();
    quiet.metadata.lastModel = "glm-5.3";
    turn(quiet, "b1", fp("sk-single-account"), T0 + 1000, 10_000, 9_000);
    const text2 = handleAcpCache(quiet).text;
    assert.ok(!text2.includes("KEY SWITCHES"), "no rotation → no section");
});
