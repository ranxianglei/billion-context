// #2131: seam forensics above SEAM_BODY_CAP (512 KiB). Bodies stored clipped
// parse to zero messages, so the parse-derived arms go blind and pairs were
// mislabeled: growth that crossed the cap booked as a client rewind (the
// clipped side reads as 0 messages), a sanctioned trim back under the cap
// booked as a provider-side miss, and SeamEvents carried 0/0 counts instead
// of the real ones. The send chokepoints now capture the exact message count
// alongside the (possibly clipped) body, and detectSeam decides those shapes
// from byte evidence + exact counts. Purely diagnostic — no wire change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `cap-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const T0 = Date.parse("2026-09-28T10:00:00Z");
const CAP = 512 * 1024;

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

// 32 messages x 18 KiB ≈ 577 KiB: over the cap, with message 32 starting past
// the cap (≈559 KiB) and message 6 starting well inside it (≈108 KiB).
const BIG = Array.from({ length: 32 }, (_, i) => `${i}${"x".repeat(17_983)}`);
const bigA = JSON.stringify({ model: "m", messages: BIG.map((c) => ({ role: "user", content: c })) });
assert.ok(bigA.length > CAP, "fixture must exceed the forensics cap");

test("capped pair, identical recorded head, tail grew: provider-side, not suspect", () => {
    const s = makeSession();
    noteForwardedBody(s, bigA, 32);
    settle(s, T0, 100_000, 99_000);
    const appended = JSON.stringify({ model: "m", messages: [...BIG.map((c) => ({ role: "user", content: c })), { role: "user", content: "n1" }, { role: "user", content: "n2" }] });
    assert.ok(appended.length > CAP, "appended fixture must stay over the cap");
    noteForwardedBody(s, appended, 34);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 0, "stable-head capped append must not cry seam");
    assert.equal(led.agg.providerSideMisses, 1);
    assert.equal(led.agg.rewinds, 0);
});

test("growth crossing the cap with exact count growth: provider-side, not rewind", () => {
    const s = makeSession();
    const small = JSON.stringify({ model: "m", messages: [{ role: "user", content: "a".repeat(1000) }, { role: "user", content: "b".repeat(1000) }] });
    assert.ok(small.length < CAP, "prior fixture must sit under the cap");
    noteForwardedBody(s, small, 2);
    settle(s, T0, 100_000, 99_000);
    // Same two messages plus one huge one: pure tail growth across the cap.
    const grown = JSON.stringify({ model: "m", messages: [{ role: "user", content: "a".repeat(1000) }, { role: "user", content: "b".repeat(1000) }, { role: "user", content: "c".repeat(600_000) }] });
    assert.ok(grown.length > CAP, "grown fixture must cross the cap");
    noteForwardedBody(s, grown, 3);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.rewinds, 0, "crossing-cap growth must not book as client rewind");
    assert.equal(led.agg.providerSideMisses, 1);
    assert.equal(led.agg.seamSuspects, 0);
});

test("trim back under the cap, whole payload a byte prefix of the recorded head: rewind, not provider-side", () => {
    const s = makeSession();
    const overCapOne = JSON.stringify({ model: "m", messages: [{ role: "user", content: "y".repeat(600_000) }] });
    assert.ok(overCapOne.length > CAP, "prior fixture must exceed the cap");
    noteForwardedBody(s, overCapOne, 1);
    settle(s, T0, 100_000, 99_000);
    const trimmed = JSON.stringify({ model: "m", messages: [{ role: "user", content: "y".repeat(90_000) }] });
    assert.ok(trimmed.length < CAP, "trimmed fixture must sit under the cap");
    // A JSON array diverges from its own longer superstring only in the
    // closing-bracket region — everything before it is byte-identical.
    assert.ok(overCapOne.startsWith(trimmed.slice(0, trimmed.length - 4)), "fixture: all but the closing region survives");
    noteForwardedBody(s, trimmed, 1);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.rewinds, 1, "sanctioned trim re-bill books as rewind");
    assert.equal(led.agg.providerSideMisses, 0, "must not be re-labeled provider-side by the byte-stable arm");
    assert.equal(led.agg.seamSuspects, 0);
});

test("visible break inside the recorded region stays a suspect, with EXACT counts in the event", () => {
    const s = makeSession();
    noteForwardedBody(s, bigA, 32);
    settle(s, T0, 100_000, 99_000);
    const msgs = BIG.map((c) => ({ role: "user", content: c }));
    msgs[5] = { role: "user", content: `BROKEN${"w".repeat(17_977)}` };
    msgs.push({ role: "user", content: "n1" });
    const broken = JSON.stringify({ model: "m", messages: msgs });
    noteForwardedBody(s, broken, 33);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1);
    assert.equal(led.agg.providerSideMisses, 0);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.seam, 1);
    const ev = led.seamEvents?.[0];
    assert.ok(ev, "seam event recorded");
    // Both sides clipped: per-message forensics is blind (msgIndex null — position
    // unknowable, #2339), but the byte LCP still proves the break sits INSIDE the
    // recorded region...
    assert.ok(ev!.lcpBytes > 0 && ev!.lcpBytes < CAP, "byte LCP lands inside the recorded head");
    // ...and the send-time counts replace the parse-blind zeros.
    assert.equal(ev!.prevMsgs, 32, "exact prior count, not the parse-blind zero");
    assert.equal(ev!.curMsgs, 33, "exact current count, not the parse-blind zero");
    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.suspects, 1);
    assert.equal(report.seam.events.length, 1);
});

test("identical recorded head with equal counts (edit beyond the cap): proven stable within recorded evidence", () => {
    const s = makeSession();
    noteForwardedBody(s, bigA, 32);
    settle(s, T0, 100_000, 99_000);
    const msgs = BIG.map((c) => ({ role: "user", content: c }));
    msgs[31] = { role: "user", content: `EDITED${"v".repeat(17_977)}` };
    const edited = JSON.stringify({ model: "m", messages: msgs });
    noteForwardedBody(s, edited, 32);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    // Message 32 starts past the cap, so every recorded byte survived: the
    // ledger can only prove stability up to the evidence limit — provider-side.
    assert.equal(led.agg.providerSideMisses, 1);
    assert.equal(led.agg.seamSuspects, 0);
    assert.equal(led.agg.rewinds, 0);
});
