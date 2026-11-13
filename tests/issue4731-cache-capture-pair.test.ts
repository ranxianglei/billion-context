// #4731 regression: #3307 P2-A's wire fold attribution (the xMeasured block in
// recordCacheSample) read this request's pending body/inbound pair from
// session.transient — but since #4430 the relay lane keeps that pending
// evidence in the withCacheCapture ALS capture (session.transient.sentBody is
// never written there), so the block could never fire on exactly its target
// lane. The pair now comes from pendingEvidencePair (capture first, transient
// fallback) and BOTH sides from ONE source: a mixed read can pair an old body
// with new usage and mis-attribute a fold. These pin the fix on the relay
// lane, the #3023 inbound guard with capture-held evidence, the no-mis-pair
// negative (stale transient body + capture settle → no block), and the
// byte-identical loop-lane fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { CoreMessage } from "acp-kernel";
import { getCacheLedger, noteForwardedBody, noteInboundMessages, pendingEvidencePair, settleUsageReport, withCacheCapture } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `capture4731-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
const digest = (b: string): string => createHash("sha256").update(b).digest("hex");
const inbound = (texts: string[]): CoreMessage[] => texts.map((t) => ({ role: "user", content: t })) as unknown as CoreMessage[];
// Anchor in the past relative to the live clock: settleUsageReport stamps each
// sample with Date.now(), so a pushed fold's createdAt must precede it to stay
// inside the pending window.
const T0 = Date.now() - 3_600_000;

function settle(session: Session, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

// Snapshot whose pre-fold prefix sums to 49*6000 = 294000 tokens — larger than
// any billed input below, so the UNcorrected firstFoldStartTokens zeroes
// structuralExcess exactly like the production stateless-resend case (#3307).
function makeInflated(): Session {
    const s = makeSession();
    const st = s.state as unknown as { tokenSnapshot: Record<string, number>; messageRefs: { byRef: Record<string, string> } };
    for (let i = 1; i <= 49; i++) {
        const r = `m${String(i).padStart(5, "0")}`;
        st.tokenSnapshot[r] = 6000;
        st.messageRefs.byRef[r] = `raw_${i}`;
    }
    return s;
}

// startRef m00050 -> prefixTokensBeforeRef sums m00001..m00049 = 294000.
function pushFold(s: Session): void {
    const st = s.state as unknown as { blocks: Array<Record<string, unknown>> };
    st.blocks.push({ blockId: "b1", createdAt: T0 + 500, compressedTokens: 30_000, summary: "x".repeat(200), startRef: "m00050" });
}

test("#4731: relay-lane evidence held only in the ALS capture fires the wire fold attribution", async () => {
    const s = makeInflated();
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "b", "c", "d"]));
        settle(s, 100_000, 99_000);
    });
    pushFold(s);
    // Next turn on the SAME lane shape as relay.ts forward(): the send evidence
    // lives in a fresh capture; session.transient.sentBody stays undefined.
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "SUMMARY", "c", "d"]));
        settle(s, 100_000, 30_000);
    });
    assert.equal(s.transient?.sentBody, undefined, "sanity: on the relay lane the pending body never lands in transient");
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.ok(line.foldSeq !== null, "the fold's re-pay must be attributed from the CAPTURED body pair (pre-fix curB read transient and never fired)");
    assert.ok((line.cr ?? 0) > 0, "compRepay booked to the fold");
    assert.notEqual(line.seam, 1, "an attributed fold must not flag as an unexplained seam");
});

test("#4731: the #3023 client-rewrite guard still works with the pair held in the capture", async () => {
    const s = makeInflated();
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "b", "c"]));
        noteInboundMessages(s, inbound(["a", "b", "c"]));
        settle(s, 100_000, 99_000);
    });
    pushFold(s);
    // Outbound mid-break AND inbound mid-rewrite (index 1 changed) — host churn,
    // not bili. With a mixed read (curIn from the empty transient slot) the
    // clientBreak gate would be blind and the fold wrongly credited.
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "X2", "c"]));
        noteInboundMessages(s, inbound(["a", "CHANGED", "c"]));
        settle(s, 100_000, 30_000);
    });
    const led = getCacheLedger(s);
    const line = led.lines.at(-1)!;
    assert.equal(line.foldSeq, null, "client rewrite must not be credited to the fold");
    assert.equal(line.prov, "client", "classified client-side via the CAPTURED inbound pair (#3023)");
    assert.equal(led.agg.clientInserts, 1);
});

test("#4731: a stale transient body is not mis-paired with a capture's usage (old body + new usage → no block)", async () => {
    const s = makeInflated();
    // Baseline settle on the loop lane (no capture): transient slot in use.
    noteForwardedBody(s, body(["a", "b", "c", "d"]));
    settle(s, 100_000, 99_000);
    pushFold(s);
    // A loop-lane send that never settles leaves its mid-break body pending in
    // transient — reading THAT side while the usage belongs to a capture round
    // is exactly the mis-pair the same-source accessor forbids.
    noteForwardedBody(s, body(["a", "STALE", "c", "d"]));
    await withCacheCapture(s, async () => {
        // Capture holds NO send evidence (usage settled without a new send).
        settle(s, 100_000, 30_000);
    });
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.equal(line.foldSeq, null, "no body evidence in the capture → the block must not fire off the stale transient body");
    assert.equal(line.cr, 0);
});

test("#4731: loop-lane fallback stays byte-identical (transient-held pair still fires)", () => {
    const s = makeInflated();
    noteForwardedBody(s, body(["a", "b", "c", "d"]));
    settle(s, 100_000, 99_000);
    pushFold(s);
    noteForwardedBody(s, body(["a", "SUMMARY", "c", "d"]));
    settle(s, 100_000, 30_000);
    const line = getCacheLedger(s).lines.at(-1)!;
    assert.ok(line.foldSeq !== null, "outside any capture the pair falls back to transient and fires as before (#3307)");
});

test("#4731: pendingEvidencePair returns both sides from ONE source", async () => {
    const s = makeSession();
    // Stale pending pair from a loop-lane round that never settled.
    noteForwardedBody(s, body(["stale"]));
    noteInboundMessages(s, inbound(["stale"]));
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["fresh"]));
        const pair = pendingEvidencePair(s);
        assert.equal(pair.sentBody?.digest, digest(body(["fresh"])), "body side from the capture");
        assert.equal(pair.inBody, undefined, "inbound side from the SAME capture — the stale transient inBody must not leak in");
    });
    // Outside any capture the pair falls back to transient TOGETHER.
    const pair = pendingEvidencePair(s);
    assert.equal(pair.sentBody?.digest, digest(body(["stale"])));
    assert.equal(pair.inBody?.msgs, 1);
});
