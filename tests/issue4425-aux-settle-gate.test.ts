import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { getCacheLedger, noteLocalTextEstimate, settleUsageReport } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

// #4425: auxiliary small requests (classify / title-gen sidecars) that slip past
// the side-request lane's evidence allowlist shared the main session id and ran
// settleUsageReport's FULL decision-layer effect set on the main ledger —
// clearing the emergency shrink arm, wiping overflow evidence, burning the
// post-rebuild meter anchor, consuming/rolling the main turn's k̂ pending pair,
// and booking cache-ledger lines whose body pairing points at the aux request.
// Fix: a magnitude gate at the single settle chokepoint (NON_MAIN_USAGE_RATIO:
// a sample billing <1/10 of the established session load is billing-only) plus
// a prepare-side clobber guard (noteLocalTextEstimate refuses aux-sized
// denominators). #3617 discipline: BOTH directions asserted — aux settles must
// not destroy main state, and main settles must not be suppressed by the gate.

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i4425-${seq}`,
        metadata: {},
        // The billing counters start at zero in production (createStats) —
        // settleUsageReport accumulates with += and would NaN on a bare {}.
        stats: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0 },
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function mainSettle(s: Session, total: number): void {
    settleUsageReport(s, { total, reportedCached: Math.round(total * 0.8), output: 1000, protocol: "openai", upstream: "http://u" });
}

test("aux settle is billing-only: arm, evidence, rebuild anchor, k̂ pair and cache ledger all survive", () => {
    const s = makeSession();
    const st = s.stats;
    mainSettle(s, 300_000);

    // What an overflow round leaves armed before the next main turn:
    const armedAt = Date.now();
    st.emergencyShrinkAt = armedAt;
    st.emergencyShrinkEstimate = 1_100_000;
    st.overflowArmTokens = 700_000;
    st.overflowArmCompletionReserve = 40_000;
    s.metadata["postRebuildAnchor"] = { tokens: 48_000, remainingPrepares: 3 };
    // Main N+1 prepares its pending k̂ pair…
    noteLocalTextEstimate(s, 310_000, "http://u");
    const linesBefore = getCacheLedger(s).lines.length;
    const samplesBefore = st.cacheSamples ?? 0;

    // …and an unrecognized aux request settles in between with a tiny total.
    settleUsageReport(s, { total: 4_733, reportedCached: 100, output: 50, protocol: "openai", upstream: "http://u" });

    assert.equal(st.emergencyShrinkAt, armedAt, "the emergency shrink arm must survive the aux settle");
    assert.equal(st.emergencyShrinkEstimate, 1_100_000);
    assert.equal(st.overflowArmTokens, 700_000, "the overflow arm must survive");
    assert.equal(st.overflowArmCompletionReserve, 40_000, "the proven completion reservation must survive");
    assert.deepEqual(s.metadata["postRebuildAnchor"], { tokens: 48_000, remainingPrepares: 3 }, "the post-rebuild meter anchor must survive");
    assert.equal(st.lastLocalTextEstimate, 310_000, "the main turn's pending k̂ pair must survive unconsumed");
    assert.equal(st.lastLocalTextEstimateOrigin, "http://u");
    assert.equal(st.lastInputTokens, 300_000, "the usage anchor must not be rewritten by the aux sample");
    assert.equal(st.lastUsageGradeTokens, 300_000);
    assert.equal(st.lastInputTokensSource, "usage");
    assert.equal(st.cachedTokens, 240_000, "no aux cache sample may be booked");
    assert.equal(st.cacheSamples, samplesBefore, "no aux cache sample may be counted");
    assert.equal(getCacheLedger(s).lines.length, linesBefore, "no aux ledger line may be booked");
    assert.equal(st.inputTokens, 304_733, "raw billing stays honest: the aux tokens were really billed");
    assert.equal(st.calibrationRing, undefined, "the aux settle must not touch the calibration ring");
});

test("main settles keep running the full effect set (the gate must not over-suppress)", () => {
    const s = makeSession();
    const st = s.stats;
    mainSettle(s, 300_000);
    st.emergencyShrinkAt = Date.now();
    st.emergencyShrinkEstimate = 1_100_000;
    st.overflowArmTokens = 700_000;
    s.metadata["postRebuildAnchor"] = { tokens: 48_000, remainingPrepares: 3 };
    noteLocalTextEstimate(s, 310_000, "http://u");
    const linesBefore = getCacheLedger(s).lines.length;
    const samplesBefore = st.cacheSamples ?? 0;

    settleUsageReport(s, { total: 310_000, reportedCached: 250_000, output: 1000, protocol: "openai", upstream: "http://u" });

    assert.equal(st.emergencyShrinkAt, undefined, "a real usage report retires the arm");
    assert.equal(st.overflowArmTokens, undefined, "a real usage report retires the overflow evidence");
    assert.equal(s.metadata["postRebuildAnchor"], undefined, "a real usage report retires the rebuild anchor");
    assert.equal(st.lastInputTokens, 310_000, "the main sample re-anchors");
    assert.equal((st.cacheSamples ?? 0) - samplesBefore, 1, "the main cache sample is counted");
    assert.equal(getCacheLedger(s).lines.length, linesBefore + 1, "the main ledger line is booked");
    assert.equal(st.lastLocalTextEstimate, undefined, "the main pair is consumed by its own report");
});

test("fresh sessions and constant-small upstreams bootstrap freely (#1820 B / #1839 G1 invariants)", () => {
    const s = makeSession();
    settleUsageReport(s, { total: 5_000, reportedCached: null, protocol: "openai", upstream: "http://u" });
    assert.equal(s.stats.lastInputTokens, 5_000, "the first sample anchors even when tiny");
    for (let i = 0; i < 3; i++) {
        settleUsageReport(s, { total: 5_000, reportedCached: null, protocol: "openai", upstream: "http://u" });
    }
    assert.equal(s.stats.lastInputTokens, 5_000, "a constant-small upstream keeps settling every turn");
});

test("armed round: the aux stays out, the recovery re-anchor gets in (#4383 shape)", () => {
    const s = makeSession();
    const st = s.stats;
    mainSettle(s, 300_000);
    // armFailureShrink shape: the char-based estimate overshoots real billing ~4.4×.
    st.lastInputTokens = 1_100_000;
    st.lastInputTokensSource = "estimate";
    st.emergencyShrinkAt = Date.now();
    st.emergencyShrinkEstimate = 1_100_000;

    settleUsageReport(s, { total: 4_733, reportedCached: 0, protocol: "openai", upstream: "http://u" });
    assert.equal(st.lastInputTokens, 1_100_000, "the aux sample must not re-anchor off the arm");
    assert.equal(st.lastInputTokensSource, "estimate");
    assert.notEqual(st.emergencyShrinkAt, undefined, "the arm survives the aux settle");

    // The retry of the same body lands: real usage ≈ 23% of the arm estimate.
    settleUsageReport(s, { total: 252_154, reportedCached: 200_000, protocol: "openai", upstream: "http://u" });
    assert.equal(st.lastInputTokens, 252_154, "the recovery must re-anchor");
    assert.equal(st.lastInputTokensSource, "usage");
    assert.equal(st.emergencyShrinkAt, undefined, "the recovery retires the arm");
});

test("post-fold: the unfolded re-request bills pre-fold scale and passes; the shrunken steady state continues", () => {
    const s = makeSession();
    const st = s.stats;
    mainSettle(s, 300_000);
    // A fold applied mid-stream: credit accrues, the anchor nets down.
    st.compressCreditTokens = 252_000;
    st.lastInputTokens = 48_000;

    // The post-fold re-request re-sends the UNFOLDED history — it bills pre-fold size.
    settleUsageReport(s, { total: 300_000, reportedCached: null, protocol: "openai", upstream: "http://u" });
    assert.equal(st.lastInputTokens, 48_000, "credit nets the re-request back to the folded size");

    // Steady state on the folded size keeps settling (prepare zeroes the credit each turn).
    st.compressCreditTokens = 0;
    settleUsageReport(s, { total: 49_000, reportedCached: 40_000, protocol: "openai", upstream: "http://u" });
    assert.equal(st.lastInputTokens, 49_000, "folded-scale main turns are never gated");
});

test("k̂ starvation: aux prepare+settle between main turns must not eat the main pair (facet 4)", () => {
    const s = makeSession();
    const st = s.stats;
    // Main N: prepare pair, settle it.
    noteLocalTextEstimate(s, 280_000, "http://u");
    settleUsageReport(s, { total: 280_000, reportedCached: null, protocol: "openai", upstream: "http://u" });
    // Main N+1 prepares its pair…
    noteLocalTextEstimate(s, 300_000, "http://u");
    // …an aux request prepares in between (tiny body)…
    noteLocalTextEstimate(s, 4_000, "http://u");
    assert.equal(st.lastLocalTextEstimate, 300_000, "the aux-sized body must not clobber the outstanding main pair");
    assert.equal(st.lastLocalTextEstimateOrigin, "http://u");
    // …and settles.
    settleUsageReport(s, { total: 4_733, reportedCached: 0, protocol: "openai", upstream: "http://u" });
    assert.equal(st.lastLocalTextEstimate, 300_000, "the aux settle must not consume the main pair");
    // Main N+1 settles: its own pair, its own billing — consistent, admitted.
    settleUsageReport(s, { total: 305_000, reportedCached: null, protocol: "openai", upstream: "http://u" });
    assert.equal(st.lastLocalTextEstimate, undefined, "the main pair is consumed by its own report");
    assert.deepEqual(
        st.calibrationRing?.values,
        [1, 305_000 / 300_000],
        "the ring learns the MAIN pairs' ratios — without the guard the aux settle would have taught a (4_000, 4_733) mispair instead",
    );
});

test("noteLocalTextEstimate: only strictly-below-1/10 bodies are refused; grown bodies and fresh slots record freely", () => {
    const s = makeSession();
    noteLocalTextEstimate(s, 300_000, "http://u");
    noteLocalTextEstimate(s, 29_999, "http://u");
    assert.equal(s.stats.lastLocalTextEstimate, 300_000, "just below 1/10 of the outstanding pair is refused");
    noteLocalTextEstimate(s, 30_000, "http://u");
    assert.equal(s.stats.lastLocalTextEstimate, 30_000, "at exactly 1/10 the write goes through (only strictly smaller is blocked)");
    noteLocalTextEstimate(s, 400_000, "http://u");
    assert.equal(s.stats.lastLocalTextEstimate, 400_000, "a grown main body replaces the pair");
    const fresh = makeSession();
    noteLocalTextEstimate(fresh, 4_000, "http://u");
    assert.equal(fresh.stats.lastLocalTextEstimate, 4_000, "no outstanding pair: record freely");
});

test("settle gate boundary: strictly below 1/10 of the established scale is non-main", () => {
    const at = makeSession();
    mainSettle(at, 100_000);
    settleUsageReport(at, { total: 10_000, reportedCached: null, protocol: "openai", upstream: "http://u" });
    assert.equal(at.stats.lastInputTokens, 10_000, "at exactly 1/10 the sample is main-grade and re-anchors");

    const below = makeSession();
    mainSettle(below, 100_000);
    settleUsageReport(below, { total: 9_999, reportedCached: null, protocol: "openai", upstream: "http://u" });
    assert.equal(below.stats.lastInputTokens, 100_000, "just below 1/10 it is aux-grade and must not re-anchor");
});
