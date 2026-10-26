// #3769: attribute a proactive failed-compress cleanup (orphan rotation) in the
// cache ledger. detectOrphanSweeps watches the monotonic length of
// session.state.sweptOrphanCallIds between samples; when a mid-history break
// otherwise lands in the unexplained seam bucket AND a cleanup grew this turn,
// the residual books into its own bucket (prov:"orphan-sweep") instead of
// "no fold/switch/restart attribution". Gated on actual growth: no growth keeps
// the legacy seam bucket, and a resumed session's pre-existing sweeps baseline
// without being charged to the first sample.
import { test } from "node:test";
import assert from "node:assert/strict";
import { noteForwardedBody, settleUsageReport, getCacheLedger, buildSessionCacheReport, handleAcpCache } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `orphan-sweep-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const body = (msgs: string[]): string => JSON.stringify({ model: "m", messages: msgs.map((c) => ({ role: "user", content: c })) });
const T0 = Date.parse("2026-10-19T10:49:00Z");

function settle(session: Session, at: number, input: number, cached: number): void {
    settleUsageReport(session, { total: input, reportedCached: cached, output: 0, protocol: "openai", upstream: "http://u" });
}

test("cleanup growth + unattributed break books the orphan-sweep bucket, not the seam bucket", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000); // baseline: swept empty -> high-water 0
    // A proactive cleanup rotated two failed-compress records out of history this turn.
    s.state!.sweptOrphanCallIds = ["c1", "c2"];
    noteForwardedBody(s, body(["a", "B2", "c"])); // outbound mid-history break, no inbound capture
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.prov, "orphan-sweep", "residual booked to the cleanup");
    assert.equal(line.seam, undefined, "NOT a seam suspect");
    assert.equal(led.agg.orphanSweepSeams, 1);
    assert.ok(led.agg.orphanSweepMissed > 0);
    assert.equal(led.agg.seamSuspects, 0, "kept out of the unexplained tally");
    const report = buildSessionCacheReport(s);
    assert.equal(report.seam.orphanSweep.count, 1);
    assert.ok(report.seam.orphanSweep.missed > 0);
    assert.match(handleAcpCache(s).text, /ORPHAN CLEANUP SEAM/);
});

test("same break WITHOUT cleanup growth keeps the legacy seam bucket (arm is gated on growth)", () => {
    const s = makeSession();
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000);
    noteForwardedBody(s, body(["a", "B2", "c"])); // identical break, but nothing was swept
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    const line = led.lines[led.lines.length - 1]!;
    assert.equal(line.seam, 1, "legacy seam bucket preserved");
    assert.equal(line.prov, undefined);
    assert.equal(led.agg.orphanSweepSeams, 0);
    assert.equal(led.agg.seamSuspects, 1);
});

test("a resumed session's pre-existing sweeps baseline without charging the first sample", () => {
    const s = makeSession();
    s.state!.sweptOrphanCallIds = ["c1"]; // already swept before this process started
    noteForwardedBody(s, body(["a", "b", "c"]));
    settle(s, T0, 100_000, 99_000); // first observation baselines high-water at 1
    noteForwardedBody(s, body(["a", "B2", "c"])); // no NEW growth since baseline
    settle(s, T0 + 1000, 100_000, 20_000);
    const led = getCacheLedger(s);
    assert.equal(led.agg.orphanSweepSeams, 0, "pre-existing sweeps not charged to this sample");
    assert.equal(led.agg.seamSuspects, 1, "falls back to the legacy seam bucket");
});
