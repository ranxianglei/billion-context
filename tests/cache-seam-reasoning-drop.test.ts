// #651/#3198: the compress-reasoning round-close rewrite is a KNOWN
// once-per-round mid-history change (compress.reasoning.drop, default on).
// The ledger must attribute the miss it bills to the new reasoningDrop bucket
// (prov="reasoning", ℞ report section) instead of an unexplained ⚠ CACHE SEAM —
// the seam panic that opened #3198.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, noteReasoningDropPlan, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `rdrop-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });

function settle(session: Session, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

function lastLine(session: Session) {
    const led = getCacheLedger(session);
    return { led, line: led.lines[led.lines.length - 1]! };
}

test("reasoning drop: round-close growth books prov=reasoning, not a seam", () => {
    const s = makeSession();
    // Baseline: round in flight (empty drop plan) — primes the key.
    noteReasoningDropPlan(s, new Set());
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, 100_000, 99_000);
    // Round closes: plan grows, outbound view drops that round's reasoning →
    // mid-history rewrite + big residual on the next settle.
    noteReasoningDropPlan(s, new Set(["r1", "r2"]));
    noteForwardedBody(s, body(["a", "B2", "c"]));
    settle(s, 100_000, 20_000);
    const { led, line } = lastLine(s);
    assert.equal(line.prov, "reasoning", "attributed to the reasoning-drop bucket");
    assert.equal(line.seam, undefined, "must NOT flag an unexplained seam");
    assert.equal(led.agg.seamSuspects, 0);
    assert.equal(led.agg.reasoningDropMisses, 1);
    assert.ok(led.agg.reasoningDropMissed > 0);
    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.reasoningDrop.count, 1);
    const text = handleAcpCache(s).text;
    assert.match(text, /COMPRESS-REASONING DROP/);
    assert.doesNotMatch(text, /⚠ CACHE SEAM/);
});

test("reasoning drop: first observation in a process only primes (no stamp)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, 100_000, 99_000);
    // No prior plan observation (restart case): the already-dropped view is
    // steady; a miss here must NOT borrow the attribution.
    noteReasoningDropPlan(s, new Set(["r1"]));
    noteForwardedBody(s, body(["a", "B"]));
    settle(s, 100_000, 20_000);
    const { led, line } = lastLine(s);
    assert.equal(line.prov, undefined);
    assert.equal(line.seam, 1, "falls through to the unexplained seam arm");
    assert.equal(led.agg.reasoningDropMisses, 0);
});

test("reasoning drop: stamp is consumed once — a later identical miss is a seam again", () => {
    const s = makeSession();
    noteReasoningDropPlan(s, new Set());
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, 100_000, 99_000);
    noteReasoningDropPlan(s, new Set(["r1"]));
    noteForwardedBody(s, body(["a", "B2", "c"]));
    settle(s, 100_000, 20_000);
    // Same round-close window is over; a second unexplained break without new
    // growth books as a seam.
    noteForwardedBody(s, body(["a", "XX", "c"]));
    settle(s, 100_000, 20_000);
    const { led, line } = lastLine(s);
    assert.equal(line.seam, 1);
    assert.equal(led.agg.reasoningDropMisses, 1, "first miss consumed the stamp");
    assert.equal(led.agg.seamSuspects, 1);
});

test("reasoning drop: no plan growth (same plan) never books", () => {
    const s = makeSession();
    noteReasoningDropPlan(s, new Set(["r1"]));
    noteForwardedBody(s, body(["a", "b"]));
    settle(s, 100_000, 99_000);
    noteReasoningDropPlan(s, new Set(["r1"]));
    noteForwardedBody(s, body(["a", "B"]));
    settle(s, 100_000, 20_000);
    const { led, line } = lastLine(s);
    assert.equal(line.prov, undefined);
    assert.equal(led.agg.reasoningDropMisses, 0);
    assert.equal(led.agg.seamSuspects, 1);
});
