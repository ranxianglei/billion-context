// #7528: P2-A (#3307's fold re-pay wire correction) was gated to bodies at or
// below SEAM_BODY_CAP (512 KiB) AND to a non-null parse-derived msgIndex. A
// pair clipped at the cap parses to zero messages on BOTH sides, so msgIndex
// is null and the correction never fired on clipped bodies — exactly the
// large-body stateless-resend population where the X-space mismatch is worst
// (DSH desktop: 91 samples / 14.49M tok stuck in the seam bucket). When BOTH
// bodies are clipped, the byte position alone proves a mid-region break (a
// tail append diverges at the body end, past the head). These pin the relaxed
// gate AND its two negatives: a clipped pure tail-append must NOT be credited
// to a pending fold, and the asymmetric clip (one side whole) must stay on
// the parse gate — a clipped superstring can read as a pure byte prefix of
// the whole side, where byte evidence alone cannot rule out an append.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `capfold-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const T0 = Date.now() - 3_600_000;
const CAP = 512 * 1024;

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

// 32 messages x 18 KiB ≈ 577 KiB: over the cap, with message 6 starting well
// inside the recorded head (≈108 KiB).
const BIG = Array.from({ length: 32 }, (_, i) => `${i}${"x".repeat(17_983)}`);
const bigBody = JSON.stringify({ model: "m", messages: BIG.map((c) => ({ role: "user", content: c })) });
assert.ok(bigBody.length > CAP, "fixture must exceed the forensics cap");

// Snapshot whose pre-fold prefix sums to 49*6000 = 294000 tokens — larger than
// any billed input below, so the UNcorrected firstFoldStartTokens zeroes
// structuralExcess exactly like the production stateless-resend case.
function makeSessionWithInflatedPrefix(): Session {
    const s = makeSession();
    const st = s.state as unknown as { tokenSnapshot: Record<string, number>; messageRefs: { byRef: Record<string, string> } };
    for (let i = 1; i <= 49; i++) {
        const r = `m${String(i).padStart(5, "0")}`;
        st.tokenSnapshot[r] = 6000;
        st.messageRefs.byRef[r] = `raw_${i}`;
    }
    return s;
}

function pushFold(s: Session, at: number): void {
    const st = s.state as unknown as { blocks: Array<Record<string, unknown>> };
    // startRef m00050 -> prefixTokensBeforeRef sums m00001..m00049 = 294000.
    st.blocks.push({ blockId: "b1", createdAt: at, compressedTokens: 30_000, summary: "x".repeat(200), startRef: "m00050" });
}

test("clipped pair, mid-head break, pending inflated-X fold: attributed to the fold, not a seam (#7528)", () => {
    const s = makeSessionWithInflatedPrefix();
    noteForwardedBody(s, bigBody, 32);
    settle(s, T0, 100_000, 99_000);
    pushFold(s, T0 + 500);
    // Message 5 replaced (fold carrier) — break at ≈108 KiB, inside the head.
    const msgs = BIG.map((c) => ({ role: "user", content: c }));
    msgs[5] = { role: "user", content: `SUMMARY${"w".repeat(17_977)}` };
    const broken = JSON.stringify({ model: "m", messages: msgs });
    assert.ok(broken.length > CAP, "broken fixture must stay over the cap");
    noteForwardedBody(s, broken, 32);
    settle(s, T0 + 1000, 100_000, 30_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.ok(line.foldSeq !== null, "the clipped-body mid-head break must attribute to the pending fold via the byte gate (uncorrected X=294000 would zero structuralExcess)");
    assert.notEqual(line.seam, 1, "an attributed fold must not flag as an unexplained seam");
});

test("clipped pair, pure tail-append, pending inflated-X fold: NOT credited to the fold", () => {
    const s = makeSessionWithInflatedPrefix();
    noteForwardedBody(s, bigBody, 32);
    settle(s, T0, 100_000, 99_000);
    pushFold(s, T0 + 500);
    const appended = JSON.stringify({ model: "m", messages: [...BIG.map((c) => ({ role: "user", content: c })), { role: "user", content: "n1" }, { role: "user", content: "n2" }] });
    assert.ok(appended.length > CAP, "appended fixture must stay over the cap");
    noteForwardedBody(s, appended, 34);
    settle(s, T0 + 1000, 100_000, 30_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.foldSeq, null, "a clipped tail-append must not be credited to the fold (byte gate: lcp reaches the head end)");
    assert.equal(led.agg.providerSideMisses, 1, "the tail-append miss stays provider-side");
    assert.notEqual(line.seam, 1);
});

test("asymmetric clip (prior whole, current clipped) with a stable prefix: NOT credited to the fold", () => {
    const s = makeSessionWithInflatedPrefix();
    const small = JSON.stringify({ model: "m", messages: [{ role: "user", content: "a".repeat(100_000) }, { role: "user", content: "b".repeat(100_000) }] });
    assert.ok(small.length < CAP, "prior fixture must sit under the cap");
    noteForwardedBody(s, small, 2);
    settle(s, T0, 100_000, 99_000);
    pushFold(s, T0 + 500);
    // Same two messages plus one huge one: the whole prior body survives as a
    // byte prefix of the clipped current head — byte evidence alone cannot
    // rule out an append, so the parse gate must keep this out.
    const grown = JSON.stringify({ model: "m", messages: [{ role: "user", content: "a".repeat(100_000) }, { role: "user", content: "b".repeat(100_000) }, { role: "user", content: "c".repeat(600_000) }] });
    assert.ok(grown.length > CAP, "grown fixture must cross the cap");
    noteForwardedBody(s, grown, 3);
    settle(s, T0 + 1000, 100_000, 30_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.foldSeq, null, "the asymmetric-clip append must not be credited to the fold");
    assert.notEqual(line.seam, 1);
});
