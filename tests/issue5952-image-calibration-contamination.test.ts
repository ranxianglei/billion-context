import assert from "node:assert/strict";
import { mkdtempSync, rmSync as rmrf } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
// #2129: the measurement-state round-trip pins the legacy storage layer;
// the unified default hangs these bare-store tests.
process.env.BILI_STORAGE_UNIFIED = "legacy";

import { createCore, createInitialState, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { noteCalibrationPair, settleOverflowCalibration, settleUsageReport, withCacheCapture } from "../src/cache-ledger.ts";
import { SessionStore } from "../src/persist.ts";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import type { Session } from "../src/session.ts";
import { CALIBRATION_PROVENANCE_TEXT_ONLY, currentCalibrationFactor } from "../src/util.ts";

// #5952: request usage containing images contaminated the text-only estimate
// calibration, and concurrent settlement read shared prepare facts — so a
// stale mixed-modal multiplier could reject a fitting payload after a model
// switch. The fix pairs each settle with the final wire estimate of ITS OWN
// request (per-request capture, #4430 discipline): image-bearing samples
// never train the text multiplier, and a published factor only decides when
// every sample in its ring came from a text-only wire estimate
// (provenance "text-only-v1").

const ORIGIN = "http://a";

let seq = 0;
function makeSession(id?: string): Session {
    seq += 1;
    return {
        id: id ?? `i5952-${seq}`,
        metadata: { lastModel: "gpt-x" },
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

type Pair = { estimate: number; imageTokens: number; origin: string; model?: string };

async function settleWithPair(s: Session, pair: Pair, billed: number, prepareEst?: number): Promise<void> {
    // prepareEst: what prepare-*.ts wrote into the shared slot — the
    // contaminated value in the bug (text + image reserve), or a concurrent
    // request's prepare value.
    if (prepareEst !== undefined) {
        s.stats.lastLocalTextEstimate = prepareEst;
        s.stats.lastLocalTextEstimateOrigin = pair.origin;
    }
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, pair);
        settleUsageReport(s, { total: billed, reportedCached: null, upstream: pair.origin });
    });
}

test("#5952: image-bearing usage never trains the text multiplier", async () => {
    const s = makeSession();
    const st = s.stats;
    // Two consistent image-bearing samples: prepare recorded the contaminated
    // estimate (text 10000 + image reserve 17000); billed 15000. Pre-fix the
    // shared slot trained k̂ = 15000/27000 ≈ 0.556.
    await settleWithPair(s, { estimate: 10000, imageTokens: 17000, origin: ORIGIN, model: "gpt-x" }, 15000, 27000);
    await settleWithPair(s, { estimate: 10000, imageTokens: 17000, origin: ORIGIN, model: "gpt-x" }, 15000, 27000);
    assert.equal(st.calibratedEstimate, undefined, "image-contaminated samples must not publish a text factor");
    assert.equal(st.calibratedEstimateProvenance, undefined);
    assert.equal(st.calibrationRing, undefined, "skipped samples leave no ring evidence");
});

test("#5952: a text-only final wire estimate trains the multiplier from its own pair", async () => {
    const s = makeSession();
    const st = s.stats;
    // The shared slot holds a DIFFERENT (concurrent/stale) prepare value: the
    // settle must use its own capture pair (10000), not the slot (20000).
    await settleWithPair(s, { estimate: 10000, imageTokens: 0, origin: ORIGIN, model: "gpt-x" }, 5000, 20000);
    assert.equal(st.calibratedEstimate, undefined, "one sample must not publish");
    await settleWithPair(s, { estimate: 10000, imageTokens: 0, origin: ORIGIN, model: "gpt-x" }, 5000, 20000);
    assert.equal(st.calibratedEstimate, 0.5, "two agreeing text-only samples publish their own ratio, not the shared slot's 0.25");
    assert.equal(st.calibratedEstimateProvenance, CALIBRATION_PROVENANCE_TEXT_ONLY);
    assert.equal(currentCalibrationFactor(st, "gpt-x"), 0.5, "a text-only factor applies on its route+model");
    assert.deepEqual(st.calibrationRing?.provenances, [CALIBRATION_PROVENANCE_TEXT_ONLY, CALIBRATION_PROVENANCE_TEXT_ONLY]);
});

test("#5952: interleaved image/text settles — only the text request trains", async () => {
    const s = makeSession();
    const st = s.stats;
    let releaseBPrepared!: () => void;
    let releaseASettled!: () => void;
    const bPrepared = new Promise<void>((r) => { releaseBPrepared = r; });
    const aSettled = new Promise<void>((r) => { releaseASettled = r; });
    const runA = withCacheCapture(s, async () => {
        // Image request notes its final wire estimate, then waits: a
        // concurrent text request prepares (overwriting the shared slot)
        // before A settles.
        noteCalibrationPair(s, { estimate: 10000, imageTokens: 17000, origin: ORIGIN, model: "gpt-x" });
        await bPrepared;
        settleUsageReport(s, { total: 15000, reportedCached: null, upstream: ORIGIN });
        releaseASettled();
    });
    const runB = withCacheCapture(s, async () => {
        s.stats.lastLocalTextEstimate = 8000;
        s.stats.lastLocalTextEstimateOrigin = ORIGIN;
        noteCalibrationPair(s, { estimate: 8000, imageTokens: 0, origin: ORIGIN, model: "gpt-x" });
        releaseBPrepared();
        await aSettled;
        settleUsageReport(s, { total: 4000, reportedCached: null, upstream: ORIGIN });
    });
    await Promise.all([runA, runB]);
    // A's image sample must not count as the second sample, even though the
    // shared slot held a matching estimate (8000) when it settled: pre-fix
    // the ring held [1.875] (15000/8000) here.
    assert.deepEqual(st.calibrationRing?.values, [0.5], "only the text request's sample may enter the ring");
    assert.equal(st.calibratedEstimate, undefined, "one text sample alone must not publish");
    // A second text-only settle publishes with text-only provenance.
    await settleWithPair(s, { estimate: 8000, imageTokens: 0, origin: ORIGIN, model: "gpt-x" }, 4000, 8000);
    assert.equal(st.calibratedEstimate, 0.5);
    assert.equal(st.calibratedEstimateProvenance, CALIBRATION_PROVENANCE_TEXT_ONLY);
});

test("currentCalibrationFactor: a factor without text-only provenance never decides (#5952)", () => {
    assert.equal(currentCalibrationFactor({ calibratedEstimate: 0.5 }, "gpt-x"), undefined, "legacy factor without provenance is inert");
    assert.equal(currentCalibrationFactor({ calibratedEstimate: 0.5, calibratedEstimateProvenance: "other" }, "gpt-x"), undefined, "unknown provenance is inert");
    assert.equal(
        currentCalibrationFactor({ calibratedEstimate: 0.5, calibratedEstimateProvenance: CALIBRATION_PROVENANCE_TEXT_ONLY }, "gpt-x"),
        0.5,
        "a text-only factor applies",
    );
    assert.equal(
        currentCalibrationFactor({ calibratedEstimate: 0.5, calibratedEstimateProvenance: CALIBRATION_PROVENANCE_TEXT_ONLY, calibratedEstimateModel: "gpt-y" }, "gpt-x"),
        undefined,
        "cross-model still absent",
    );
});

function makePreflightFixture() {
    const core = createCore();
    const config = defaultConfig(262144);
    // No range can qualify, so a non-fitting verdict never spends a
    // summarization call: the test judges the estimate, not the fold walk.
    config.compress.minCompressRange = 300000;
    const messages: CoreMessage[] = [{ id: "m1", role: "user", contentType: "text", text: "f".repeat(160000) }];
    const session: Session = {
        id: "i5952-preflight",
        meta: {},
        metadata: { lastModel: "gpt-x" },
        state: createInitialState(),
        stats: { requests: 1, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        pendingRetrievals: [],
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
    const deps: PreflightDeps = {
        core, session, config, prompts: defaultPrompts, protocol: "openai",
        url: "http://127.0.0.1:9/v1/chat/completions", headers: {}, model: "gpt-x",
        log: () => {},
        upstreamOrigin: ORIGIN, wireOverhead: 22000, imageReserve: 17000,
    };
    return { messages, session, deps };
}

test("#5952: a stale multiplier without text-only provenance never rejects a fitting payload", async () => {
    const { messages, session, deps } = makePreflightFixture();
    // The incident's stale factor: k̂=4, route+model match, NO provenance
    // (pre-upgrade/legacy shape) — a model switch just happened.
    session.stats.calibratedEstimate = 4;
    session.stats.calibratedEstimateOrigin = ORIGIN;
    session.stats.calibratedEstimateModel = "gpt-x";
    const result = await preflightCompress(deps, messages);
    // The kernel's rendered view adds a few ref-tag tokens over the raw
    // input estimate (~79K raw vs ~265K calibrated), so judge by the wide
    // gap, not the exact count.
    assert.ok(result.payloadEstimate < 100000, `stale k̂=4 must not scale the estimate (got ${result.payloadEstimate})`);
    assert.equal(result.fitsWindow, true, "the unchanged payload fits the 262144 window on the raw scale");
});

test("#5952: a text-only-provenance multiplier still decides preflight", async () => {
    const { messages, session, deps } = makePreflightFixture();
    session.stats.calibratedEstimate = 4;
    session.stats.calibratedEstimateOrigin = ORIGIN;
    session.stats.calibratedEstimateModel = "gpt-x";
    session.stats.calibratedEstimateProvenance = CALIBRATION_PROVENANCE_TEXT_ONLY;
    const result = await preflightCompress(deps, messages);
    assert.ok(result.payloadEstimate > 240000, `a proven text-only factor must still scale the estimate (got ${result.payloadEstimate})`);
    assert.equal(result.fitsWindow, false, "the calibrated payload genuinely exceeds the window");
});

test("#5952: overflow calibration inherits the capture-pair provenance", async () => {
    const s = makeSession();
    const st = s.stats;
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10000, imageTokens: 17000, origin: ORIGIN, model: "gpt-x" });
        settleOverflowCalibration(s, 15000, ORIGIN);
    });
    assert.equal(st.calibratedEstimate, undefined, "an image-bearing overflow must not teach");
    assert.equal(st.calibrationRing, undefined);
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 10000, imageTokens: 0, origin: ORIGIN, model: "gpt-x" });
        settleOverflowCalibration(s, 5000, ORIGIN);
    });
    await withCacheCapture(s, async () => {
        noteCalibrationPair(s, { estimate: 20000, imageTokens: 0, origin: ORIGIN, model: "gpt-x" });
        settleOverflowCalibration(s, 11000, ORIGIN);
    });
    assert.equal(st.calibratedEstimate, 0.525, "two agreeing text-only overflow samples publish their mean");
    assert.equal(st.calibratedEstimateProvenance, CALIBRATION_PROVENANCE_TEXT_ONLY);
});

test("#5952: text-only provenance survives a reload round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5952-rt-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
        const s: Session = {
            id: "i5952-rt",
            meta: {},
            metadata: {},
            state: createInitialState(),
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        };
        s.stats.calibratedEstimate = 0.5;
        s.stats.calibratedEstimateOrigin = ORIGIN;
        s.stats.calibratedEstimateProvenance = CALIBRATION_PROVENANCE_TEXT_ONLY;
        s.stats.calibrationRing = { origin: ORIGIN, model: "gpt-x", values: [0.5, 0.5], provenances: [CALIBRATION_PROVENANCE_TEXT_ONLY, CALIBRATION_PROVENANCE_TEXT_ONLY] };
        await store.writeNow(s);
        await store.flushAll([]);
        const back = new SessionStore({ dir, debounceMs: 5, enabled: true }).loadSync("i5952-rt");
        assert.ok(back, "session reloaded");
        assert.equal(back.stats.calibratedEstimateProvenance, CALIBRATION_PROVENANCE_TEXT_ONLY, "published provenance round-trips");
        assert.deepEqual(back.stats.calibrationRing?.provenances, [CALIBRATION_PROVENANCE_TEXT_ONLY, CALIBRATION_PROVENANCE_TEXT_ONLY], "ring provenance round-trips");
        assert.equal(currentCalibrationFactor(back.stats, "gpt-x"), 0.5, "the restored factor still decides");
    } finally {
        rmrf(dir, { recursive: true, force: true });
    }
});
