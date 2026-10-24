// #4397: the grand-ledger unattributed residual ("upstream TTL/eviction/wire
// rewrite") lumped every body-forensics outcome into one opaque bucket, and the
// dominant-residual warning declared "NOT a bili bug" even when forensics actually
// suspected a mid-history break. CACHE INVALIDATION now reconciles the residual
// over the seam buckets (provider-side / TTL / client / rewind / orphan-sweep /
// suspect), and the warning reports the split when suspects are material. Also:
// provider-side misses are stamped with whether bili's render tags were active on
// send (the #2483 stateful-relay signature) at both send chokepoints. Purely
// diagnostic — no wire change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, noteInboundMessages, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i4397-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const T0 = Date.parse("2026-10-24T10:00:00Z");
const CAP = 512 * 1024;

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

// 32 messages x 18 KiB ≈ 577 KiB: over the forensics cap (same fixture family as #2131).
const BIG = Array.from({ length: 32 }, (_, i) => `${i}${"x".repeat(17_983)}`);
const bigA = JSON.stringify({ model: "m", messages: BIG.map((c) => ({ role: "user", content: c })) });
assert.ok(bigA.length > CAP, "fixture must exceed the forensics cap");

const appended = JSON.stringify({ model: "m", messages: [...BIG.map((c) => ({ role: "user", content: c })), { role: "user", content: "n1" }, { role: "user", content: "n2" }] });
assert.ok(appended.length > CAP, "appended fixture must stay over the cap");

const inbound = (a: string, b: string, c: string) => [
    { role: "user", content: a },
    { role: "user", content: b },
    { role: "user", content: c },
] as unknown as Parameters<typeof noteInboundMessages>[1];

test("unattributed residual is reconciled over the forensics buckets", () => {
    const s = makeSession();
    noteForwardedBody(s, bigA, 32);
    settle(s, T0, 100_000, 99_000);
    // (a) stable-head capped append → provider-side miss
    noteForwardedBody(s, appended, 34);
    settle(s, T0 + 1000, 100_000, 20_000);
    // (b) mid-list break, no settled inbound pair yet → suspected seam
    const msgsB = BIG.map((c) => ({ role: "user", content: c }));
    msgsB[5] = { role: "user", content: `BROKEN${"w".repeat(17_977)}` };
    msgsB.push({ role: "user", content: "n1" });
    noteForwardedBody(s, JSON.stringify({ model: "m", messages: msgsB }), 33);
    noteInboundMessages(s, inbound("A1", "B1", "C1"));
    settle(s, T0 + 2000, 100_000, 20_000);
    // (c) same outbound break shape, but the client's own resent list broke mid-list → host-owned
    const msgsC = BIG.map((c) => ({ role: "user", content: c }));
    msgsC[7] = { role: "user", content: `HOST${"z".repeat(17_981)}` };
    msgsC.push({ role: "user", content: "n1" });
    noteForwardedBody(s, JSON.stringify({ model: "m", messages: msgsC }), 33);
    noteInboundMessages(s, inbound("A1", "B2", "C1"));
    settle(s, T0 + 3000, 100_000, 20_000);

    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1);
    assert.equal(led.agg.seamSuspects, 1);
    assert.equal(led.agg.clientInserts, 1);
    const r = buildSessionCacheReport(s);
    const booked = r.seam.providerSide.missed + r.seam.missed + r.seam.client.missed + r.seam.rewinds.missed + r.seam.orphanSweep.missed + r.seam.providerTtl.missed;
    assert.ok(booked <= r.invalidation.remaining, "forensics buckets must stay inside the residual");
    const text = handleAcpCache(s).text;
    assert.match(text, /of which the unattributed .*tok: body forensics booked/);
    assert.match(text, /provider-side miss .*\(1\)/);
    assert.match(text, /suspected mid-history break .*\(1\)/);
    assert.match(text, /client mid-history rewrite .*\(1\)/);
    // no render-tags stamp anywhere in this session
    assert.equal(r.seam.taggedSide.count, 0);
    assert.doesNotMatch(text, /sent WITH bili render tags active/);
});

test("provider-side miss sent with render tags active is tagged (#2483 signature)", () => {
    const s = makeSession();
    noteForwardedBody(s, bigA, 32);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, appended, 34, undefined, undefined, true);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1);
    assert.equal(led.agg.taggedSideMisses, 1);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.rt, 1);
    assert.equal(led.agg.taggedSideMissed, line.tr);
    const r = buildSessionCacheReport(s);
    assert.deepEqual(r.seam.taggedSide, { count: 1, missed: line.tr });
    assert.match(handleAcpCache(s).text, /sent WITH bili render tags active \(#4397\)/);
});

test("provider-side miss without render tags stays untagged", () => {
    const s = makeSession();
    noteForwardedBody(s, bigA, 32);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, appended, 34, undefined, undefined, false);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1);
    assert.equal(led.agg.taggedSideMisses, 0);
    assert.equal(led.agg.taggedSideMissed, 0);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.rt, undefined);
    const r = buildSessionCacheReport(s);
    assert.deepEqual(r.seam.taggedSide, { count: 0, missed: 0 });
    assert.doesNotMatch(handleAcpCache(s).text, /sent WITH bili render tags active/);
});

test("dominant residual with a suspected break reports the split, not 'NOT a bili bug'", () => {
    const s = makeSession();
    const small = JSON.stringify({ model: "m", messages: [{ role: "user", content: "a".repeat(50_000) }] });
    noteForwardedBody(s, small, 1);
    settle(s, T0, 100_000, 99_000);
    const broken = JSON.stringify({ model: "m", messages: [{ role: "user", content: `BROKEN${"w".repeat(49_994)}` }, { role: "user", content: "n1" }] });
    noteForwardedBody(s, broken, 2);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1);
    const text = handleAcpCache(s).text;
    assert.match(text, /body forensics split it:/);
    assert.doesNotMatch(text, /NOT a bili bug/);
});

test("dominant residual with NO suspected break keeps the #1847 provider-side wording", () => {
    const s = makeSession();
    noteForwardedBody(s, bigA, 32);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, appended, 34);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 0);
    assert.equal(led.agg.providerSideMisses, 1);
    const text = handleAcpCache(s).text;
    assert.match(text, /NOT a bili bug/);
    assert.doesNotMatch(text, /body forensics split it/);
    assert.match(text, /of which the unattributed .*tok: body forensics booked provider-side miss/);
});

test("pre-change persisted ledger without taggedSide counters normalizes on load", () => {
    const s = makeSession();
    noteForwardedBody(s, bigA, 32);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, appended, 34);
    settle(s, T0 + 1000, 100_000, 20_000);
    const raw = (s.metadata as unknown as { cacheLedger: { agg: Record<string, unknown> } }).cacheLedger;
    delete raw.agg.taggedSideMisses;
    delete raw.agg.taggedSideMissed;
    const again = getCacheLedger(s);
    assert.equal(again.agg.taggedSideMisses, 0);
    assert.equal(again.agg.taggedSideMissed, 0);
    const r = buildSessionCacheReport(s);
    assert.deepEqual(r.seam.taggedSide, { count: 0, missed: 0 });
    assert.equal(handleAcpCache(s).outcome, "success");
});
