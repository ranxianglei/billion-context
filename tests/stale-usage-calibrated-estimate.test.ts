import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, type CoreMessage } from "acp-kernel";
import { settleUsageReport, noteOutboundContextEstimates } from "../src/cache-ledger.ts";
import {
    usageAnchorCycleStale,
    calibratedLocalInputEstimate,
    statusInputBaseline,
    type Session,
} from "../src/session.ts";
import { effectiveTokenCount } from "../src/server.ts";

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        metadata: {},
        state: createInitialState(),
        createdAt: 1_000,
        lastSeen: 1_000,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        stats: {
            requests: 0,
            tokensSaved: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheSamples: 0,
            lastInputTokens: 0,
            compressCreditTokens: 0,
            contextTokens: 0,
            retrieveCalls: 0,
            retrieveHits: 0,
            retrieveMisses: 0,
            storedBytes: 0,
            storeBytesSaved: 0,
            rangeRestores: 0,
        },
    };
}

function makeMessages(chars: number): CoreMessage[] {
    return [{ id: "m00001", role: "user", contentType: "text", text: "x".repeat(chars) }];
}

test("usageAnchorCycleStale with calibrated estimate uses contextEstimateTokens instead of raw upper-bound estimate", () => {
    const session = makeSession("test-calibrated-stale-cycle");
    settleUsageReport(session, { total: 139_956, reportedCached: 120_000 }, 10_000);
    noteOutboundContextEstimates(session, {
        upperBound: 747_979,
        scaledText: 145_000,
        imageTokens: 0,
        calibrated: true,
    });
    assert.equal(usageAnchorCycleStale(session.stats), true);
    assert.equal(calibratedLocalInputEstimate(session.stats), 145_000);

    const eff = effectiveTokenCount(session, makeMessages(3_000_000));
    assert.equal(eff.source, "estimate");
    assert.equal(eff.tokens, 145_000);
    assert.equal(statusInputBaseline(session), 145_000);
});

test("estimate-sourced lastInputTokens with calibrated contextEstimateTokens preserves calibrated baseline", () => {
    const session = makeSession("test-calibrated-baseline-preservation");
    settleUsageReport(session, { total: 140_000, reportedCached: 120_000 }, 10_000);
    noteOutboundContextEstimates(session, {
        upperBound: 705_288,
        scaledText: 142_000,
        imageTokens: 0,
        calibrated: true,
    });
    session.stats.lastInputTokens = 705_288;
    session.stats.lastInputTokensSource = "estimate";

    assert.equal(calibratedLocalInputEstimate(session.stats), 142_000);
    const eff = effectiveTokenCount(session, makeMessages(3_000_000));
    assert.equal(eff.source, "usage");
    assert.equal(eff.tokens, 140_000);
});

test("uncalibrated contextEstimateTokens keeps the char-count upper bound on a stale cycle (negative direction)", () => {
    const session = makeSession("test-uncalibrated-stale-cycle");
    settleUsageReport(session, { total: 139_956, reportedCached: 120_000 }, 10_000);
    noteOutboundContextEstimates(session, {
        upperBound: 747_979,
        scaledText: 145_000,
        imageTokens: 0,
        calibrated: false,
    });
    assert.equal(usageAnchorCycleStale(session.stats), true);
    assert.equal(calibratedLocalInputEstimate(session.stats), 747_979);
    const eff = effectiveTokenCount(session, makeMessages(3_000_000));
    assert.equal(eff.source, "estimate");
    assert.equal(eff.tokens, 747_979);
    assert.equal(statusInputBaseline(session), 747_979);
});

test("never-reporting upstream keeps the fail-closed upper bound even when the estimate is calibrated (#553/#728 discipline)", () => {
    const session = makeSession("test-never-reporting-calibrated");
    noteOutboundContextEstimates(session, {
        upperBound: 705_288,
        scaledText: 142_000,
        imageTokens: 0,
        calibrated: true,
    });
    assert.equal(usageAnchorCycleStale(session.stats), false);
    assert.equal(calibratedLocalInputEstimate(session.stats), 705_288);
    const eff = effectiveTokenCount(session, makeMessages(3_000_000));
    assert.equal(eff.source, "estimate");
    assert.equal(eff.tokens, 705_288);
    assert.equal(statusInputBaseline(session), 0);
});
