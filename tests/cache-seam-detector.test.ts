// #1592-family seam detector: settleUsageReport pairs consecutive outbound
// bodies (noteForwardedBody) and, when a sample's miss carries NO structural
// attribution (no fold owner, no model/wire/upstream switch, no restart) and a
// substantive residual, records a SeamEvent (first-divergence byte offset +
// message index), flags the ledger line, and surfaces a ⚠ CACHE SEAM section
// in /acp-cache. Purely diagnostic — the closure math is untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, noteClientAbort, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `seam-${seq}`,
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

test("seam detector: unexplained mid-history break yields a SeamEvent with byte/message forensics", () => {
    const s = makeSession();
    // Baseline turn: healthy hit, body A recorded.
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    // Next turn: body B diverges at message index 1, huge unexplained residual,
    // no fold / switch / restart anywhere.
    noteForwardedBody(s, body(["a", "B2", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.seam, 1, "second line must be flagged seam");
    assert.equal(led.agg.seamSuspects, 1);
    assert.ok(led.agg.seamMissed > 0);
    const ev = led.seamEvents?.[0];
    assert.ok(ev, "seam event recorded");
    assert.equal(ev!.msgIndex, 1, "first divergent element is messages[1]");
    assert.ok(ev!.lcpBytes > 0 && ev!.lcpBytes < body(["a", "b", "c"]).length, "byte LCP lands inside body A");
    assert.equal(ev!.prevMsgs, 3);
    assert.equal(ev!.curMsgs, 3);
    // /acp-cache surfaces the section.
    const text = handleAcpCache(s).text;
    assert.match(text, /CACHE SEAM/);
    assert.match(text, /message\[1\]/);
    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.suspects, 1);
    assert.equal(report.seam.events.length, 1);
});

test("seam detector: structural attributions and small residuals never flag", () => {
    const s = makeSession();
    // healthy baseline with a KNOWN model (both sides known is what makes the
    // next line a real switch)
    (s.metadata as Record<string, unknown>).lastModel = "gpt-x";
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    // (a) model switch line — attributed, must NOT flag even with huge miss
    (s.metadata as Record<string, unknown>).lastModel = "gpt-y";
    noteForwardedBody(s, body(["a", "B"]));
    settle(s, T0 + 1000, 100_000, 10_000);
    let led = getCacheLedger(s);
    assert.notEqual(led.lines[led.lines.length - 1]!.seam, 1, "model-switch line must not flag");
    // (b) small residual — below both floors — must NOT flag (model stays gpt-y)
    noteForwardedBody(s, body(["a", "C"]));
    settle(s, T0 + 3000, 100_000, 97_000);
    led = getCacheLedger(s);
    assert.notEqual(led.lines[led.lines.length - 1]!.seam, 1, "small-residual line must not flag");
    // (c) unmeasured sample (no cache report) must NOT flag
    noteForwardedBody(s, body(["a", "D"]));
    settleUsageReport(s, { total: 100_000, reportedCached: null, output: 0, protocol: "openai", upstream: "http://u" });
    led = getCacheLedger(s);
    assert.notEqual(led.lines[led.lines.length - 1]!.seam, 1, "unknown-cache line must not flag");
    assert.equal(led.agg.seamSuspects, 0);
    assert.equal(buildSessionCacheReport(s).seam.suspects, 0);
    assert.ok(!handleAcpCache(s).text.includes("CACHE SEAM"), "no seam section when nothing flagged");
});

test("seam detector: fold-owned misses never flag (the sanctioned anchor cost)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    // Simulate a fold becoming pending right before the next settle: push a
    // block and let detectNewFolds run inside recordCacheSample.
    const st = s.state as unknown as { blocks: Array<Record<string, unknown>> };
    st.blocks.push({ blockId: "b1", createdAt: T0 + 500, compressedTokens: 30_000, summary: "x".repeat(200), startRef: "m00002" });
    noteForwardedBody(s, body(["a", "SUMMARY"]));
    settle(s, T0 + 1000, 100_000, 40_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.ok(line.foldSeq !== null, "rig sanity: the miss is fold-owned");
    assert.notEqual(line.seam, 1, "fold-attributed miss must not flag as seam");
});

test("seam detector: lane without body capture flags the aggregate but records no event", () => {
    const s = makeSession();
    settle(s, T0, 100_000, 99_000); // no noteForwardedBody at all
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "aggregate flag still set");
    assert.equal(led.seamEvents, undefined, "no forensic event without bodies");
    assert.match(handleAcpCache(s).text, /aggregate flag only/);
});

test("seam events are bounded (ring keeps the last 8)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a"]));
    settle(s, T0, 100_000, 99_000);
    for (let i = 0; i < 12; i++) {
        noteForwardedBody(s, body(["a", `v${i}`]));
        settle(s, T0 + 1000 * (i + 2), 100_000, 20_000);
    }
    const led = getCacheLedger(s);
    assert.equal(led.seamEvents?.length, 8, "bounded ring");
    // #2059: the first transition (["a"] -> ["a","v0"]) is a pure tail append and is
    // now attributed provider-side; the remaining 11 mutate slot 1 (mid-history breaks).
    assert.equal(led.agg.seamSuspects, 11, "aggregate counts all seam-suspects");
    assert.equal(led.agg.providerSideMisses, 1, "the single append is provider-side");
});

test("seam detector: client rewind (fewer messages) attributes to HISTORY REWOUND, not a seam", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    // Client reverted to message 1 — big miss, fewer elements.
    noteForwardedBody(s, body(["a"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.rewinds, 1);
    assert.ok(led.agg.rewindMissed > 0);
    assert.equal(led.agg.seamSuspects, 0, "rewind must not cry seam");
    const text = handleAcpCache(s).text;
    assert.match(text, /HISTORY REWOUND/);
    assert.ok(!/CACHE SEAM \(/.test(text), "no seam section for a pure rewind");
});

test("seam detector: byte-stable resend attributes to PROVIDER-SIDE MISS, not a seam", () => {
    const s = makeSession();
    const same = body(["a", "b"]);
    noteForwardedBody(s, same);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, same);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1);
    assert.ok(led.agg.providerSideMissed > 0);
    assert.equal(led.agg.seamSuspects, 0, "stable wire must not cry seam");
    assert.match(handleAcpCache(s).text, /PROVIDER-SIDE MISS/);
});

test("seam detector: PROVIDER-SIDE MISS section mentions the stateful-upstream render-tag check (#2483)", () => {
    const s = makeSession();
    const same = body(["a", "b"]);
    noteForwardedBody(s, same);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, same);
    settle(s, T0 + 1000, 100_000, 20_000);
    const text = handleAcpCache(s).text;
    assert.match(text, /PROVIDER-SIDE MISS/);
    assert.match(text, /stateful-upstream check \(#2483\)/);
    assert.match(text, /diagnostics\.renderNone=true/);
});

test("seam detector: tail-append turn attributes to PROVIDER-SIDE MISS, not a seam (#2059)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    // Next turn APPENDS one message; the previous list is a byte-identical prefix,
    // upstream gave no cache. The whole-body LCP test can't see this (the body grew),
    // so pre-fix it falsely cried seam.
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1, "tail-append miss is provider-side");
    assert.ok(led.agg.providerSideMissed > 0);
    assert.equal(led.agg.seamSuspects, 0, "tail-append must not cry seam");
    assert.notEqual(led.lines[led.lines.length - 1]!.seam, 1);
    const text = handleAcpCache(s).text;
    assert.match(text, /PROVIDER-SIDE MISS/);
    assert.ok(!/CACHE SEAM \(/.test(text), "no seam section for a pure tail-append miss");
});

test("seam detector: multi-message tail append also attributes to PROVIDER-SIDE MISS (#2059)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, body(["a", "b", "c", "d"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1);
    assert.equal(led.agg.seamSuspects, 0, "appending several messages is still a pure tail growth");
});

test("seam detector: a REAL mid-history break (0 < msgIndex < prevMsgs) stays a seam-suspect (#2059)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    // Diverges at messages[1]: a genuine mid-history rewrite, NOT a tail append —
    // the #2059 reclassification must not swallow it.
    noteForwardedBody(s, body(["a", "B2", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "mid-history break stays a seam-suspect");
    assert.equal(led.agg.providerSideMisses, 0, "must not be swallowed into provider-side");
    assert.equal(led.lines[led.lines.length - 1]!.seam, 1);
    assert.equal(led.seamEvents?.[0]?.msgIndex, 1);
});

test("seam detector: a head break (msgIndex == 0) stays a seam-suspect (#2059)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    // The very first message diverges — not a tail append, must stay flagged.
    noteForwardedBody(s, body(["A", "b"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "head break stays a seam-suspect");
    assert.equal(led.agg.providerSideMisses, 0);
    assert.equal(led.lines[led.lines.length - 1]!.seam, 1);
    assert.equal(led.seamEvents?.[0]?.msgIndex, 0);
});

test("seam detector: an over-cap prior body keeps an append miss a seam-suspect, never a false provider-side (#2059)", () => {
    const s = makeSession();
    // Over-cap prior body is stored truncated → parses to zero messages, so the
    // message-level forensics are untrustworthy; the guard must keep it out of the
    // provider-side reclassification.
    noteForwardedBody(s, JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(600 * 1024) }] }));
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, body(["q", "r"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "truncated-pair miss stays a seam-suspect");
    assert.equal(led.agg.providerSideMisses, 0, "truncated bodies must not be read as provider-side");
});

test("seam detector: abort correlation marks missed samples near a client abort", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    noteClientAbort(s);
    noteForwardedBody(s, body(["a", "B"]));
    settle(s, T0 + 500, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.abortCorrelated, 1);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.abortedNear, 1);
    assert.equal(line.seam, 1, "still a seam candidate — correlation is orthogonal");
    assert.match(handleAcpCache(s).text, /ABORT-CORRELATED/);
});

test("seam detector: pre-upgrade ledger shape normalizes attribution counters (no NaN after reload)", () => {
    const s = makeSession();
    const led = getCacheLedger(s);
    const agg = led.agg as Partial<typeof led.agg>;
    delete agg.providerSideMisses;
    delete agg.providerSideMissed;
    delete agg.rewinds;
    delete agg.rewindMissed;
    delete agg.abortCorrelated;
    const norm = getCacheLedger(s);
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    noteClientAbort(s);
    noteForwardedBody(s, body(["a"]));
    settle(s, T0 + 500, 100_000, 20_000);
    assert.equal(norm.agg.rewinds, 1, "rewind counter works after normalization");
    assert.equal(norm.agg.abortCorrelated, 1, "abort counter works after normalization");
    assert.ok(Number.isFinite(norm.agg.providerSideMisses), "untouched counters stay numeric");
    const report = buildSessionCacheReport(s);
    for (const v of [report.seam.providerSide.count, report.seam.providerSide.missed, report.seam.rewinds.count, report.seam.rewinds.missed, report.seam.abortCorrelated]) {
        assert.ok(Number.isFinite(v), `report value finite: ${v}`);
    }
});

// #2339: msgsOf read only `.messages`, so every Responses (`input`) / Google
// (`contents`) pair parsed to zero messages — the fallback msgIndex 0 rendered
// as a real "message[0]", and the #2059 tail-append arm went dead on those wires.
const respBody = (items: string[], stream: boolean, tools: Array<Record<string, unknown>>): string =>
    JSON.stringify({ model: "m", input: items.map((c) => ({ type: "message", role: "user", content: [{ type: "input_text", text: c }] })), stream, tools });

test("seam detector: Responses-wire tail-append with trailing fields attributes provider-side (#2339)", () => {
    const s = makeSession();
    const tools = [{ name: "read_file" }];
    noteForwardedBody(s, respBody(["a", "b"], false, tools));
    settle(s, T0, 100_000, 99_000);
    // Pure tail append; trailing fields after `input` put the byte-divergence
    // point beyond the 4-byte closing-region tolerance, so only the parsed
    // element walk can prove the prior list survived. Pre-fix it fell through
    // to suspect = a false seam event.
    noteForwardedBody(s, respBody(["a", "b", "c"], true, tools));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1, "Responses-wire tail-append miss is provider-side");
    assert.equal(led.agg.seamSuspects, 0, "must not cry a false seam");
    assert.notEqual(led.lines[led.lines.length - 1]!.seam, 1);
});

test("seam detector: Responses-wire mid-history break localizes the divergent input element (#2339)", () => {
    const s = makeSession();
    const tools = [{ name: "read_file" }];
    noteForwardedBody(s, respBody(["a", "b", "c"], true, tools));
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, respBody(["a", "B2", "c"], true, tools));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "mid-history break stays a seam-suspect");
    assert.equal(led.agg.providerSideMisses, 0, "must not be swallowed into provider-side");
    assert.equal(led.seamEvents?.[0]?.msgIndex, 1, "element walk works on the `input` array");
});

test("seam detector: Google-native tail-append attributes provider-side (#2339)", () => {
    const s = makeSession();
    const googBody = (items: string[]): string =>
        JSON.stringify({ model: "m", contents: items.map((c) => ({ role: "user", parts: [{ text: c }] })), generationConfig: { temperature: 0 } });
    noteForwardedBody(s, googBody(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, googBody(["a", "b", "c"]));
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.providerSideMisses, 1, "contents-wire tail-append miss is provider-side");
    assert.equal(led.agg.seamSuspects, 0, "must not cry a false seam");
});

test("seam detector: capped pair reports msgIndex null (unknown position), never fallback 0 (#2339)", () => {
    const s = makeSession();
    noteForwardedBody(s, JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(600 * 1024) }] }), 148);
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, body(["q", "r"]), 151);
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.seamSuspects, 1, "truncated-pair miss stays a seam-suspect");
    const ev = led.seamEvents?.[0];
    assert.ok(ev, "seam event recorded");
    assert.equal(ev!.msgIndex, null, "position unknowable when a side parses to no list — never the fallback 0");
    assert.equal(ev!.prevMsgs, 148, "send-time exact counts still reported");
    assert.equal(ev!.curMsgs, 151);
    const text = handleAcpCache(s).text;
    assert.match(text, /divergence ≥.*at message\[\?\] of 148→151/, "report renders the unknown-position token, not message[0]");
    assert.equal(buildSessionCacheReport(s).seam.events[0]?.msgIndex, null, "UI data carries null, rendered as '?' by the client guard");
});
