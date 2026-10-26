import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { settleOverflowCalibration, settleUsageReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

// #3900/#4079: a route that only ever overflows never settles a usage report,
// so the local estimator's calibre never self-corrects — preflight keeps
// judging "fits" on the low estimate and the same doomed body is re-forwarded
// (and rejected) forever. The 400 body states the rejected payload's OWN
// message-token count (#3450 parseOverflowCounts) — a usage-grade measurement
// of the exact body whose local estimate prepare recorded as the pending k̂
// pair. settleOverflowCalibration feeds that measurement through the SAME
// ring discipline a usage settle uses (plausibility band, ≥2 agreeing
// samples, publish clamps, route+model provenance) and retires the consumed
// pair so a later report can never mispair it (#1933 F1).

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i3900-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

// What prepare does at send time: note the pending pair for the body about
// to go upstream (#1933 F1).
function notePair(s: Session, est: number, origin: string, model?: string): void {
    if (model !== undefined) s.metadata = { lastModel: model };
    s.stats.lastLocalTextEstimate = est;
    s.stats.lastLocalTextEstimateOrigin = origin;
}

test("settleOverflowCalibration: two agreeing overflow counts publish k̂ exactly like a usage settle", () => {
    const s = makeSession();
    const st = s.stats;
    notePair(s, 20_000, "http://a", "gpt-x");
    settleOverflowCalibration(s, 40_000, "http://a");
    assert.equal(st.calibratedEstimate, undefined, "one overflow sample must not publish");
    assert.equal(st.calibrationRing?.values.length, 1);
    assert.equal(st.calibrationRing?.model, "gpt-x");
    assert.equal(st.lastLocalTextEstimate, undefined, "the consumed pair retires (#1933 F1)");
    assert.equal(st.lastLocalTextEstimateOrigin, undefined);
    // A same-request refold (#1195) re-runs prepare → a fresh pair for the
    // folded body before its send; the second agreeing count publishes.
    notePair(s, 10_000, "http://a", "gpt-x");
    settleOverflowCalibration(s, 20_100, "http://a");
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 2.005) < 1e-9, `expected mean (2.0 + 2.01)/2 = 2.005, got ${st.calibratedEstimate}`);
    assert.equal(st.calibratedEstimateOrigin, "http://a");
    assert.equal(st.calibratedEstimateModel, "gpt-x");
    assert.equal(st.lastLocalTextEstimate, undefined, "pair retired again — never left dangling");
});

test("settleOverflowCalibration: rejects what a usage settle rejects — absurd ratio, route mismatch, non-positive", () => {
    const s = makeSession();
    const st = s.stats;
    notePair(s, 20_000, "http://a", "gpt-x");
    settleOverflowCalibration(s, 4_000_000, "http://a"); // ratio 200 — outside the plausibility band
    assert.equal(st.calibrationRing?.values.length, 0, "out-of-band sample not admitted into the ring");
    notePair(s, 20_000, "http://b", "gpt-x");
    settleOverflowCalibration(s, 40_000, "http://a"); // pending pair is on ANOTHER route
    assert.equal(st.calibrationRing?.values.length, 0, "route mismatch must not ingest");
    notePair(s, 20_000, "http://a", "gpt-x");
    settleOverflowCalibration(s, 0, "http://a");
    settleOverflowCalibration(s, -5, "http://a");
    assert.equal(st.calibrationRing?.values.length, 0, "non-positive measurement is a no-op");
    settleOverflowCalibration(s, 40_000, "http://a");
    assert.equal(st.calibrationRing?.values.length, 1, "a well-formed sample still lands after the rejects");
});

test("settleOverflowCalibration: interleaves with real usage settles in ONE ring — and the usage path keeps its meter writes", () => {
    const s = makeSession();
    const st = s.stats;
    notePair(s, 20_000, "http://a", "gpt-x");
    settleOverflowCalibration(s, 40_000, "http://a"); // sample 1 from a rejection
    notePair(s, 20_000, "http://a", "gpt-x");
    settleUsageReport(s, { total: 40_000, reportedCached: null, upstream: "http://a" }); // sample 2 from usage
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 2) < 1e-9, "overflow and usage samples blend in the same ring");
    assert.equal(st.calibrationRing?.values.length, 2);
    // The overflow path must NOT have grabbed the usage-only meter fields.
    assert.equal(st.lastInputTokensSource, "usage");
    assert.equal(st.lastInputTokens, 40_000);
    assert.equal(st.lastUsageGradeTokens, 40_000);
});
