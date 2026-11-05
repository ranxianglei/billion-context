// #2982 (来源: #2980 分析「缓存变低,上游还总丢缓存」时发现): the per-call
// body-stability classifier had only head/append/mid and looked solely at the
// first diverging byte offset — never at where the messages array ENDS. Two
// harmless divergence families were therefore labelled "mid" (= "历史中段重写"):
//   1. trailing top-level parameter jitter (host computes max_tokens etc. per
//      turn — the divergence sits AFTER the message array);
//   2. ephemeral tail notes bili appends as trailing user messages (nudge /
//      imgNote / retrNote, src/server/prepare-openai.ts) appearing/vanishing
//      between adjacent requests (the divergence sits AT the shorter body's
//      array-closing bracket).
// Both leave every shared history byte untouched and the prefix cache intact —
// yet #2980's log showed 181/182 adjacent pairs flagged "mid" while hit rates
// stayed 90–95%+. The label masqueraded jitter as a high-severity symptom and
// nearly produced a false "bili IS rewriting mid-history" conclusion.
// Fix: a fourth class "tail" — in the would-be-mid branch only, scan the
// SHORTER full body for the top-level messages/input/contents array's closing
// bracket; lcp >= that offset ⇒ tail. Existing head/append/mid classes are
// unchanged (mid still fires when the break lands INSIDE the array).
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `tailclass-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function settle(session: Session, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

// ~9 KiB of shared history so every pair clears the 1 KiB head threshold.
const many = Array.from({ length: 30 }, (_, i) => `msg${i}-${"x".repeat(300)}`);
const msgs = many.map((c) => ({ role: "user", content: c }));
// Trailing top-level fields. Deliberately LONGER than the 64-byte append
// tolerance: with such tails a would-be-tail pair reaches the mid branch
// (this is exactly why #2980's dynamic-max_tokens sessions were all "mid").
const TAIL_A = '"max_tokens":16384,"top_p":0.9,"stop":["end-of-turn","stop-marker-one","stop-marker-two","presence-padding-field"]';
const TAIL_B = '"max_tokens":4096,"top_p":0.9,"stop":["end-of-turn","stop-marker-one","stop-marker-two","presence-padding-field"]';
const NUDGE = { role: "user", content: "[context nudge] You have used a lot of context — compress consumed ranges." };

test("identical messages, only trailing top-level params differ ⇒ bs=tail (was mislabelled mid)", () => {
    const s = makeSession();
    const b1 = `{"model":"m","messages":${JSON.stringify(msgs)},${TAIL_A}}`;
    const b2 = `{"model":"m","messages":${JSON.stringify(msgs)},${TAIL_B}}`;
    noteForwardedBody(s, b1);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "tail", "divergence is past the message-array end — trailing param jitter, not a history rewrite");
    // The LCP must land inside the trailing region, after the history.
    assert.ok(line.bl !== undefined && line.bl > b1.indexOf('"max_tokens"'), `bl=${line.bl} must be at/past the trailing fields`);
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.tail, 1);
    assert.equal(rep.stability.mid, 0, "no mid count may be charged for trailing jitter");
});

test("ephemeral tail note APPEARS between requests ⇒ bs=tail (was mislabelled mid)", () => {
    const s = makeSession();
    const base = `{"model":"m","messages":${JSON.stringify(msgs)},${TAIL_A}}`;
    const withNote = `{"model":"m","messages":${JSON.stringify([...msgs, NUDGE])},${TAIL_A}}`;
    noteForwardedBody(s, base);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, withNote);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "tail", "only the appended ephemeral user message differs — history bytes untouched");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.tail, 1);
    assert.equal(rep.stability.mid, 0);
});

test("ephemeral tail note VANISHES between requests ⇒ bs=tail (was mislabelled mid)", () => {
    const s = makeSession();
    const base = `{"model":"m","messages":${JSON.stringify(msgs)},${TAIL_A}}`;
    const withNote = `{"model":"m","messages":${JSON.stringify([...msgs, NUDGE])},${TAIL_A}}`;
    noteForwardedBody(s, withNote);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, base);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "tail", "removal direction: divergence at the shorter body's array-closing bracket");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.tail, 1);
    assert.equal(rep.stability.mid, 0);
});

test("rewriting the LAST message (same count) still classifies mid — boundary guard", () => {
    const s = makeSession();
    const b1 = JSON.stringify({ model: "m", messages: msgs });
    const changed = [...msgs];
    changed[changed.length - 1] = { role: "user", content: `REWRITTEN-${"y".repeat(300)}` };
    const b2 = JSON.stringify({ model: "m", messages: changed });
    noteForwardedBody(s, b1);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "mid", "break INSIDE the latest element is a real prefix break — tail must not swallow it");
});

test("genuine mid-history rewrite still classifies mid (regression mirror of #2131)", () => {
    const s = makeSession();
    const b1 = JSON.stringify({ model: "m", messages: msgs });
    const changed = [...msgs];
    changed[5] = { role: "user", content: `msg5-${"y".repeat(300)}` };
    const b2 = JSON.stringify({ model: "m", messages: changed });
    noteForwardedBody(s, b1);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "mid", "element 5 of 30 rewritten = real mid-history break");
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.mid, 1);
    assert.equal(rep.stability.tail, 0);
});

test("Responses wire (`input` key) trailing-param jitter ⇒ bs=tail", () => {
    const s = makeSession();
    const items = Array.from({ length: 30 }, (_, i) => ({ type: "message", role: "user", content: [{ type: "input_text", text: `item${i}-${"z".repeat(300)}` }] }));
    const r1 = `{"model":"m","input":${JSON.stringify(items)},"max_output_tokens":1000,"temperature":0.3,"top_logprobs":7,"trailing-padding-field":"ppppppppppppppppppppppppppppppppppppppppppppppppppppp"}`;
    const r2 = `{"model":"m","input":${JSON.stringify(items)},"max_output_tokens":500,"temperature":0.3,"top_logprobs":7,"trailing-padding-field":"ppppppppppppppppppppppppppppppppppppppppppppppppppppp"}`;
    noteForwardedBody(s, r1);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, r2);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "tail", "the scanner must recognize the Responses-wire `input` array, not just `messages`");
});

test("unparseable bodies fall back to mid without crashing (pre-fix behavior preserved)", () => {
    const s = makeSession();
    const g1 = `{"broken": "` + "a".repeat(3000);
    const g2 = `{"broken": "` + "a".repeat(1500) + "b" + "a".repeat(1499);
    noteForwardedBody(s, g1);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, g2);
    settle(s, 100_000, 90_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.be, 0);
    assert.equal(line.bs, "mid", "no message array locatable ⇒ keep the conservative pre-fix class");
});

test("report + acp-cache text surface the tail class", () => {
    const s = makeSession();
    const b1 = `{"model":"m","messages":${JSON.stringify(msgs)},${TAIL_A}}`;
    const b2 = `{"model":"m","messages":${JSON.stringify(msgs)},${TAIL_B}}`;
    noteForwardedBody(s, b1);
    settle(s, 100_000, 99_000);
    noteForwardedBody(s, b2);
    settle(s, 100_000, 90_000);
    const rep = buildSessionCacheReport(s);
    assert.equal(rep.stability.paired, 1);
    assert.equal(rep.stability.diverged, 1);
    assert.equal(rep.stability.tail, 1);
    assert.equal(rep.lines.at(-1)!.bodyClass, "tail");
    const text = handleAcpCache(s).text;
    assert.match(text, /BODY STABILITY/);
    assert.match(text, /tail\(params\/notes\) 1/);
    assert.match(text, /tail-region divergence/);
});
