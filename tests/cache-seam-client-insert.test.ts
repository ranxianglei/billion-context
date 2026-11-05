// #3023: client-side mid-history rewrite attribution. detectSeam's legacy
// fall-through booked EVERY unexplained outbound mid-history divergence as a
// "suspected rebuild seam" — but when the CLIENT's own resent list broke
// mid-list (host plugin insert, paste hoisting, re-render — the #2997 dsh
// forensics), bili's faithful rebuild merely carried the host's churn to the
// wire. noteInboundMessages captures the inbound view (per-message
// fingerprints + role/len/class meta, never raw content) with the same
// prev/cur pairing as noteForwardedBody; when the inbound pair itself breaks
// mid-list the residual books into the client bucket (prov:"client"), NOT
// the seam bucket. Inbound prefix-stable / tail-append / missing-capture /
// above-cap pairs keep the legacy seam behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, noteInboundMessages, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { CoreMessage } from "acp-kernel";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `client-insert-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
const T0 = Date.parse("2026-10-13T10:00:00Z");

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

const inbound = (msgs: string[]): CoreMessage[] => msgs.map((c) => ({ role: "user", content: c })) as unknown as CoreMessage[];

test("client insert: inbound mid-list break books the client bucket, not the seam bucket", () => {
    const s = makeSession();
    noteInboundMessages(s, inbound(["a", "b", "c"]));
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    // Client inserts X at index 1: inbound [a,X,b,c], outbound carries it mid-list.
    noteInboundMessages(s, inbound(["a", "X", "b", "c"]));
    noteForwardedBody(s, body(["a", "X", "b", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.prov, "client", "residual booked client-owned");
    assert.equal(line.seam, undefined, "NOT a seam suspect");
    assert.equal(led.agg.clientInserts, 1);
    assert.ok(led.agg.clientInsertMissed > 0);
    assert.equal(led.agg.seamSuspects, 0);
    const ev = led.seamEvents?.[0];
    assert.ok(ev?.client, "seam event carries client forensics");
    assert.equal(ev!.client!.idx, 1);
    assert.equal(ev!.client!.role, "user");
    assert.equal(ev!.client!.cls, "text");
    assert.ok(ev!.client!.len > 0);
    assert.equal(ev!.msgIndex, 1, "outbound also diverges at message[1]");
    // /acp-cache text + web payload surface the bucket.
    const text = handleAcpCache(s).text;
    assert.match(text, /CLIENT MID-HISTORY REWRITE/);
    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.client.count, 1);
    assert.ok(report.seam.client.missed > 0);
});

test("client rewrite at the SAME index (no count change) also books client", () => {
    const s = makeSession();
    noteInboundMessages(s, inbound(["a", "b", "c"]));
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    noteInboundMessages(s, inbound(["a", "B2", "c"]));
    noteForwardedBody(s, body(["a", "B2", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.clientInserts, 1);
    assert.equal(led.agg.seamSuspects, 0);
    assert.equal(led.seamEvents?.[0]?.client?.idx, 1);
});

test("inbound prefix-stable with mid outbound break stays a seam suspect (genuine bili rebuild)", () => {
    const s = makeSession();
    noteInboundMessages(s, inbound(["a", "b", "c"]));
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    // Clean tail-append on the client side, but the OUTBOUND rebuild rewrote
    // message[1] — that divergence is bili's own doing.
    noteInboundMessages(s, inbound(["a", "b", "c", "d"]));
    noteForwardedBody(s, body(["a", "B2", "c", "d"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.seam, 1, "legacy seam bucket preserved");
    assert.equal(line.prov, undefined);
    assert.equal(led.agg.clientInserts, 0);
    const ev = led.seamEvents?.[0];
    assert.equal(ev?.client, undefined, "no client forensics on a genuine seam");
});

test("no inbound capture (legacy lane) keeps the seam bucket", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, body(["a", "B2", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1);
    assert.equal(led.agg.clientInserts, 0);
});

test("above-cap inbound lists decline to classify (arm guard)", () => {
    const s = makeSession();
    const big = (fill: string): CoreMessage[] => inbound(Array.from({ length: 8193 }, (_, i) => (i === 1 ? fill : `m${i}`)));
    noteInboundMessages(s, big("b"));
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    noteInboundMessages(s, big("X"));
    noteForwardedBody(s, body(["a", "X", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    // fps were not recorded (above INBOUND_MSG_CAP) — the arm must NOT
    // misread the empty arrays as "identical prefix" nor fabricate a client
    // index; the sample keeps the legacy seam bucket.
    assert.equal(led.agg.seamSuspects, 1);
    assert.equal(led.agg.clientInserts, 0);
});
