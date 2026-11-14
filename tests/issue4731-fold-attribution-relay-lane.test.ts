// #4731 regression (relay/wrapped lane): the P2-A wire gate must NOT credit a
// pure tail-append to a pending fold even when the pending evidence is read from
// the #4430 ALS capture. The positive (mid-history break fires) and the #3023
// client-rewrite negative are already pinned on this lane by
// issue4731-cache-capture-pair.test.ts; this adds the tail-append guard on the
// capture path (its loop-lane twin lives in issue3307-fold-attribution-wire).
// Each request cycle gets its OWN withCacheCapture scope — exactly what
// relay.ts forward() does per request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger, withCacheCapture } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `foldwire-relay-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
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

test("P2-A on the relay (wrapped) lane: a pure tail-append is NOT credited to the fold", async () => {
    const s = makeSessionWithInflatedPrefix();
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "b"]));
        settle(s, 100_000, 99_000);
    });
    pushFold(s, T0 + 500);
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "b", "c"]));
        settle(s, 100_000, 30_000);
    });
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.foldSeq, null, "tail-append growth must not be credited to the fold on the wrapped lane either");
    assert.notEqual(line.seam, 1);
});
