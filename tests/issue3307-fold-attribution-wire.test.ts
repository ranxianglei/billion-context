// #3307 P2-A regression: a stateless proxy client resends its full un-shrunken
// history every turn, so the snapshot-based fold prefix X (prefixTokensBeforeRef)
// far exceeds the billed input and decomposeSample zeroes structuralExcess — the
// fold's re-pay then falls into the unattributed seam bucket instead of being
// credited to the fold. P2-A measures the stable prefix off the wire (byte-LCP of
// this outbound vs the previous, scaled to billed input) and min()s it into X, so
// a genuine bili-side mid-history break attributes to its fold again. These pin the
// fix AND its two guards: a pure tail-append must NOT be credited to a pending fold
// (no false credit on normal growth), and a client-side inbound rewrite (#3023) must
// NOT be mis-credited either.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { noteForwardedBody, noteInboundMessages, settleUsageReport, getCacheLedger } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `foldwire-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
// Anchor in the past relative to the live clock: settleUsageReport stamps each
// sample with Date.now(), so a pushed fold's createdAt must precede it to become
// pending (a fixed future literal would silently drop the fold from the window).
const T0 = Date.now() - 3_600_000;

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

// Snapshot whose pre-fold prefix sums to 49*6000 = 294000 tokens — larger than any
// billed input below, so the UNcorrected firstFoldStartTokens zeroes structuralExcess
// exactly like the production stateless-resend case.
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

test("P2-A: inflated snapshot X + wire mid-history break attributes the fold (not a seam)", () => {
    const s = makeSessionWithInflatedPrefix();
    noteForwardedBody(s, body(["a", "b", "c", "d"]));
    settle(s, T0, 100_000, 99_000);
    pushFold(s, T0 + 500);
    // Next turn: a summary replaces message[1] (mid-history break), big residual.
    noteForwardedBody(s, body(["a", "SUMMARY", "c", "d"]));
    settle(s, T0 + 1000, 100_000, 30_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.ok(line.foldSeq !== null, "the fold's re-pay must be attributed via the wire-measured prefix (uncorrected X=294000 would zero structuralExcess)");
    assert.notEqual(line.seam, 1, "an attributed fold must not flag as an unexplained seam");
});

test("P2-A: a pure tail-append with a pending inflated-X fold is NOT credited to the fold", () => {
    const s = makeSessionWithInflatedPrefix();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, T0, 100_000, 99_000);
    pushFold(s, T0 + 500);
    // Pure tail append — no mid-history break, so the wire correction must not fire.
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0 + 1000, 100_000, 30_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.foldSeq, null, "tail-append growth must not be credited to the fold");
    assert.equal(led.agg.providerSideMisses, 1, "the tail-append miss stays provider-side");
    assert.notEqual(line.seam, 1);
});

test("P2-A: a client-side inbound rewrite is NOT credited to a pending fold (#3023)", () => {
    const s = makeSessionWithInflatedPrefix();
    noteForwardedBody(s, body(["a", "b", "c"]));
    noteInboundMessages(s, [{ role: "user", content: "a" }, { role: "user", content: "b" }, { role: "user", content: "c" }] as unknown as CoreMessage[]);
    settle(s, T0, 100_000, 99_000);
    pushFold(s, T0 + 500);
    // Outbound mid-break AND inbound mid-rewrite (index 1 changed) — host churn, not bili.
    noteForwardedBody(s, body(["a", "X2", "c"]));
    noteInboundMessages(s, [{ role: "user", content: "a" }, { role: "user", content: "CHANGED" }, { role: "user", content: "c" }] as unknown as CoreMessage[]);
    settle(s, T0 + 1000, 100_000, 30_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.foldSeq, null, "client rewrite must not be credited to the fold");
    assert.equal(line.prov, "client", "classified client-side (#3023)");
    assert.equal(led.agg.clientInserts, 1);
});
