import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { settleUsageReport } from "../src/cache-ledger.ts";
import { type Session } from "../src/session.ts";

// #7778: 2-message side calls (title/review utility requests, ~2.5k local
// estimate but ~10.7k billed — dominated by the relay's fixed system+tools
// prefix that bili does NOT see in the body) sample a ratio ≈4.2, which is
// inside the plausibility band [0.2, 5] so it was admitted. Three in a row
// evicted the honest session-sized samples from the 3-slot calibrationRing,
// k̂ clamped to CALIBRATION_CLAMP_MAX=4, and the next real request estimated
// ×4 (104799 × 4 = 419196 vs target 244800) → a futile preflight_compress
// round → fail-fast 413. The mass-gate fixes this: a sample whose local
// estimate is a small fraction of the session's PEAK local estimate is
// side-call-shaped (fixed-overhead-dominated, biased ratio) and must never
// teach the ring. A ring armed by side calls before the first main request
// un-poisons as session-sized samples arrive (the 3-slot window evicts the
// poisoned samples over the next few main requests).

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i7778-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

// One settled pair (pending estimate + its usage report) on a route.
function pair(s: Session, est: number, origin: string, billed: number): void {
    s.stats.lastLocalTextEstimate = est;
    s.stats.lastLocalTextEstimateOrigin = origin;
    settleUsageReport(s, { total: billed, reportedCached: null, upstream: origin });
}

test("#7778: side calls do not poison the ring when the session-sized request came first", () => {
    const s = makeSession();
    const st = s.stats;
    const origin = "http://a";

    // Main request: est 100k, billed 210k, ratio 2.1. Sets the peak to 100k.
    pair(s, 100000, origin, 210000);
    assert.equal(st.calibratedEstimate, undefined, "one sample must not publish a factor");
    assert.deepEqual(st.calibrationRing?.values, [2.1]);
    assert.equal(st.calibrationPeakEstimate, 100000);

    // Side call 1: est 2500, billed 10663, ratio ≈4.27. Gated out (2500 < 25k).
    pair(s, 2500, origin, 10663);
    assert.deepEqual(st.calibrationRing?.values, [2.1], "side call must not enter the ring");
    assert.equal(st.calibratedEstimate, undefined, "side call must not publish a factor");
    assert.equal(st.calibrationPeakEstimate, 100000, "peak unchanged by a gated side call");

    // Side call 2: est 2500, billed 10677, ratio ≈4.27. Gated out.
    pair(s, 2500, origin, 10677);
    assert.deepEqual(st.calibrationRing?.values, [2.1], "side call 2 must not enter the ring");

    // Side call 3: est 2500, billed 10695, ratio ≈4.28. Gated out.
    pair(s, 2500, origin, 10695);
    assert.deepEqual(st.calibrationRing?.values, [2.1], "side call 3 must not enter the ring");
    assert.equal(st.calibratedEstimate, undefined, "3 side calls must not publish a factor");

    // Main request 2: est 100k, billed 220k, ratio 2.2. Admitted. Ring = [2.1, 2.2].
    pair(s, 100000, origin, 220000);
    assert.deepEqual(st.calibrationRing?.values, [2.1, 2.2]);
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 2.15) < 1e-9, `expected mean 2.15, got ${st.calibratedEstimate}`);
});

test("#7778: a ring armed by side calls before the first main request un-poisons as session-sized samples arrive", () => {
    const s = makeSession();
    const st = s.stats;
    const origin = "http://a";

    // Side call 1: est 2500, billed 10663, ratio ≈4.265. Peak = 2500. Admitted (no prior peak).
    pair(s, 2500, origin, 10663);
    assert.deepEqual(st.calibrationRing?.values, [10663 / 2500]);
    assert.equal(st.calibrationPeakEstimate, 2500);

    // Side call 2: est 2500, billed 10677, ratio ≈4.271. Peak = 2500. Admitted.
    pair(s, 2500, origin, 10677);
    assert.deepEqual(st.calibrationRing?.values, [10663 / 2500, 10677 / 2500]);
    // Two consistent samples (spread ≈1.0) → publish the clamped mean (≈4.27 → clamp 4).
    assert.equal(st.calibratedEstimate, 4, "poisoned factor published before the main request");

    // Main request: est 100k, billed 210k, ratio 2.1. Peak grows to 100k (NOT
    // reset — k̂ is a route+model property valid across size regimes). The
    // honest sample enters the ring; the poisoned samples are still there but
    // the mean starts to pull back toward the true k̂.
    pair(s, 100000, origin, 210000);
    assert.deepEqual(st.calibrationRing?.values, [10663 / 2500, 10677 / 2500, 2.1]);
    assert.equal(st.calibrationPeakEstimate, 100000, "peak grows, ring is NOT reset");

    // Main request 2: est 100k, billed 220k, ratio 2.2. The oldest poisoned
    // sample is evicted; the ring pulls further toward the true k̂.
    pair(s, 100000, origin, 220000);
    assert.deepEqual(st.calibrationRing?.values, [10677 / 2500, 2.1, 2.2]);

    // Main request 3: est 100k, billed 230k, ratio 2.3. Both poisoned samples
    // are evicted; the ring is clean and the factor converges to the true k̂.
    pair(s, 100000, origin, 230000);
    assert.deepEqual(st.calibrationRing?.values, [2.1, 2.2, 2.3]);
    assert.ok(Math.abs((st.calibratedEstimate ?? 0) - 2.2) < 1e-9, `expected mean 2.2, got ${st.calibratedEstimate}`);
});

test("#7778: session-sized requests are still admitted (mass-gate does not over-suppress)", () => {
    const s = makeSession();
    const st = s.stats;
    const origin = "http://a";

    // Main request 1: est 100k, billed 210k, ratio 2.1. Peak = 100k.
    pair(s, 100000, origin, 210000);
    assert.deepEqual(st.calibrationRing?.values, [2.1]);

    // A smaller-but-still-session-sized request: est 30k (30% of peak), billed 63k, ratio 2.1.
    // 30k >= 25k (25% of peak) → admitted.
    pair(s, 30000, origin, 63000);
    assert.deepEqual(st.calibrationRing?.values, [2.1, 2.1], "a 30%-of-peak request must be admitted");

    // A request just below the gate: est 20k (20% of peak), billed 42k, ratio 2.1.
    // 20k < 25k (25% of peak) → gated out.
    pair(s, 20000, origin, 42000);
    assert.deepEqual(st.calibrationRing?.values, [2.1, 2.1], "a 20%-of-peak request must be gated out");
});

test("#7778: the peak is per-session and a cross-route small request is gated by the session peak", () => {
    const s = makeSession();
    const st = s.stats;

    // Route A: a session-sized request sets the session peak to 100k.
    pair(s, 100000, "http://a", 210000);
    assert.equal(st.calibrationPeakEstimate, 100000);

    // Route B: a small request (est 3k, 3% of the session peak) is gated out
    // even though it is the peak on its own route — the mass-gate uses the
    // session peak (a conservative cross-route reference). The route-B ring
    // stays empty (no factor learned from a biased sample).
    pair(s, 3000, "http://b", 10500);
    assert.equal(st.calibrationPeakEstimate, 100000, "session peak unchanged by a gated cross-route request");
    assert.equal(st.calibrationRing?.origin, "http://a", "the route-A ring is untouched");
    assert.deepEqual(st.calibrationRing?.values, [2.1], "the route-A ring keeps its honest sample");
});
