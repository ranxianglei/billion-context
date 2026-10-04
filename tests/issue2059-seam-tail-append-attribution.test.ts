// detectSeam's provider-side criterion used to require byte-identity of the
// WHOLE previous body (lcpBytes >= cur.length). Conversational workloads append
// a new message every turn, so that condition is almost never satisfiable and
// the ordinary append-only turn was misreported as a "suspected mid-history
// prefix break". seamLcp already computes the stronger discriminator:
// msgIndex === prevMsgs means the previous message list survived byte-identical
// as a prefix of the current one, so every difference is appended tail and no
// prefix break exists. These tests pin all three classes: tail-append (provider
// side), head change (msgIndex === 0, unchanged) and mid-history change
// (0 < msgIndex < prevMsgs, unchanged). Purely diagnostic — forwarding is
// untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `seam-tail-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
const T0 = Date.parse("2026-09-28T10:00:00Z");

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

test("append-only turn (msgIndex === prevMsgs) is provider-side, not a seam suspect", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    // Next turn appends one message: identical prefix, divergence only in the tail.
    noteForwardedBody(s, body(["a", "b", "c", "d"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(led.agg.seamSuspects, 0, "no prefix break exists, so no seam suspect");
    assert.equal(line.seam, undefined, "the sample must not be flagged as a seam");
    assert.equal(led.seamEvents, undefined, "no forensic seam event for an appended tail");
    assert.equal(led.agg.providerSideMisses, 1, "the miss is provider-side");
    assert.ok(led.agg.providerSideMissed > 0, "and its tokens are booked there");
    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.suspects, 0);
    assert.equal(report.seam.providerSide.count, 1);
    const text = handleAcpCache(s);
    assert.match(text, /PROVIDER-SIDE MISS/);
    assert.ok(!/CACHE SEAM \(/.test(text), "no seam section for an append-only turn");
});

test("head change (msgIndex === 0) keeps the original seam classification", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, body(["A2", "b", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "HEAD0 is not an append-only tail");
    assert.equal(led.agg.providerSideMisses, 0);
    assert.equal(led.lines[led.lines.length - 1]!.seam, 1);
    assert.equal(led.seamEvents?.[0]?.msgIndex, 0);
    assert.match(handleAcpCache(s), /CACHE SEAM \(/);
});

test("mid-history change (0 < msgIndex < prevMsgs) keeps the original seam classification", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, body(["a", "B2", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "a real mid-history rewrite is still a seam suspect");
    assert.equal(led.agg.providerSideMisses, 0);
    const ev = led.seamEvents?.[0];
    assert.ok(ev, "forensic event recorded");
    assert.equal(ev!.msgIndex, 1);
    assert.equal(ev!.prevMsgs, 3);
    assert.equal(ev!.curMsgs, 3);
    assert.match(handleAcpCache(s), /divergence/);
});

test("byte-stable resend still takes the provider-side arm (no double count)", () => {
    const s = makeSession();
    const same = body(["a", "b"]);
    noteForwardedBody(s, same);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, same);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1, "exactly one attribution");
    assert.equal(led.agg.seamSuspects, 0);
});

test("clipped bodies never take the append-only arm; a break inside the recorded region stays a suspect", () => {
    const s = makeSession();
    // ~700KB single message: noteForwardedBody stores only the first 512KB, so the
    // recorded bytes cannot prove the truncated tail carried no break.
    const huge = "a".repeat(700 * 1024);
    noteForwardedBody(s, body([huge, "b"]));
    settle(s, T0, 700_000, 690_000);
    // Differs inside the RECORDED region (message[0]) with a longer tail too: the
    // truncated pair is byte-identical only over the head, so the byte-equality arm
    // cannot fire — anything the old code claimed here would have to come from the
    // append-only arm, which must demand untruncated evidence.
    noteForwardedBody(s, body([huge + "Z", "b", "c"]));
    settle(s, T0 + 1000, 700_000, 200_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 0, "truncated evidence must not assert provider-side");
    assert.equal(led.agg.seamSuspects, 1, "unverifiable prefix stays a seam suspect");
});