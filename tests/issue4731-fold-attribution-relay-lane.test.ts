// #4731 regression: #3307 P2-A's wire-measured fold attribution read the
// pending evidence straight off session.transient, but #4430 moved the relay-lane
// pending evidence into the per-request AsyncLocalStorage capture — on every
// wrapped lane (streaming, loop rounds, non-streaming) the slot was always
// undefined and the whole compensation block was dead. These pin the fix on the
// lane production actually runs: each request cycle gets its OWN withCacheCapture
// scope (exactly what relay.ts forward() does per request), so the first settle
// moves body1 into transient.settledBody and the second settle must find body2 in
// its capture while reading the settled baseline from transient. The client-rewrite
// negative pins that curIn comes from the SAME capture (fixing only curB would
// bypass the #3023 guard on wrapped lanes).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { noteForwardedBody, noteInboundMessages, settleUsageReport, getCacheLedger, withCacheCapture } from "../src/cache-ledger.ts";
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
const inbound = (msgs: string[]): CoreMessage[] => msgs.map((c) => ({ role: "user", content: c })) as unknown as CoreMessage[];
const T0 = Date.now() - 3_600_000;

function settle(session: Session, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

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

test("P2-A on the relay (wrapped) lane: wire mid-history break attributes the fold", async () => {
    const s = makeSessionWithInflatedPrefix();
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "b", "c", "d"]));
        settle(s, 100_000, 99_000);
    });
    pushFold(s, T0 + 500);
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "SUMMARY", "c", "d"]));
        settle(s, 100_000, 30_000);
    });
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.ok(line.foldSeq !== null, "the fold's re-pay must be attributed via the wire-measured prefix even when the evidence lives in the ALS capture (pre-fix the block was dead on this lane)");
    assert.notEqual(line.seam, 1, "an attributed fold must not flag as an unexplained seam");
});

test("P2-A on the relay (wrapped) lane: a client-side inbound rewrite still blocks the credit (#3023)", async () => {
    const s = makeSessionWithInflatedPrefix();
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "b", "c"]));
        noteInboundMessages(s, inbound(["a", "b", "c"]));
        settle(s, 100_000, 99_000);
    });
    pushFold(s, T0 + 500);
    await withCacheCapture(s, async () => {
        noteForwardedBody(s, body(["a", "X2", "c"]));
        noteInboundMessages(s, inbound(["a", "CHANGED", "c"]));
        settle(s, 100_000, 30_000);
    });
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.foldSeq, null, "the clientBreak guard must fire on the wrapped lane too — pinning that curIn is read from the capture, not bypassed via stale/undefined transient");
    assert.equal(line.prov, "client", "classified client-side (#3023)");
});

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
