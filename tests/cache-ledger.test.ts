import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCacheReport, type CacheSample, type FoldEvent, type CompressionBlock } from "acp-kernel";
import { buildSessionCacheReport, getCacheLedger, handleAcpCache, recordCacheFoldsFromBlocks, recordCacheSample, settleUsageReport, summarizePricedFolds } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `cl-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

/** tokenSnapshot: m00001..m00020 @ 500 tok each; byRef maps ref→raw. */
function withView20(session: Session): void {
    const st = session.state as { messageRefs: { byRaw: Record<string, string>; byRef: Record<string, string> }; tokenSnapshot: Record<string, number>; blocks: CompressionBlock[] };
    for (let i = 1; i <= 20; i++) {
        const ref = `m${String(i).padStart(5, "0")}`;
        st.messageRefs.byRef[ref] = `raw${i}`;
        st.messageRefs.byRaw[`raw${i}`] = ref;
        st.tokenSnapshot[ref] = 500;
    }
}

function block(id: string, at: number, S: number, sigmaChars: number, startRef?: string): CompressionBlock {
    return {
        blockId: id,
        createdAt: at,
        compressedTokens: S,
        summary: "s".repeat(sigmaChars),
        startRef,
    } as unknown as CompressionBlock;
}

const T0 = Date.parse("2026-09-15T10:00:00Z");

test("incremental ledger closes the same identity as kernel batch", () => {
    const session = makeSession();
    withView20(session);

    // t=1000: cold start, 10% miss — no baseline, so the whole residual is
    // initial content (#1891), not a prefix re-pay.
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    // t=1500: fold b1 removes 5000 tok, summary 2048 tok, diverges at m00010 (X=4500).
    recordCacheFoldsFromBlocks(session, [block("b1", T0 + 1500, 5000, 8192, "m00010")], { V: 10000, Vp: 5000 });
    // t=2000: post-fold cliff: 6000 billed, only 1000 cached.
    recordCacheSample(session, { at: T0 + 2000, input: 6000, cached: 1000 });
    // t=2500: fold b2 removes 2000 tok, diverges at m00015 (X=7000 — near the tail).
    recordCacheFoldsFromBlocks(session, [block("b2", T0 + 2500, 2000, 4096, "m00015")], { V: 6000, Vp: 4000 });
    // t=3000: growth 1000 + a miss beyond it with no structural excess.
    recordCacheSample(session, { at: T0 + 3000, input: 7000, cached: 2000 });
    // t=4000: warm append, fully explained by growth.
    recordCacheSample(session, { at: T0 + 4000, input: 7500, cached: 7000 });

    const rawSamples: CacheSample[] = [
        { at: T0 + 1000, input: 10000, cached: 9000 },
        { at: T0 + 2000, input: 6000, cached: 1000 },
        { at: T0 + 3000, input: 7000, cached: 2000 },
        { at: T0 + 4000, input: 7500, cached: 7000 },
    ];
    const rawFolds: FoldEvent[] = [
        { at: T0 + 1500, tokensCompressed: 5000, summaryTokens: 2048, firstFoldStartTokens: 4500, viewBefore: 10000, viewAfter: 5000 },
        { at: T0 + 2500, tokensCompressed: 2000, summaryTokens: 1024, firstFoldStartTokens: 7000, viewBefore: 6000, viewAfter: 4000 },
    ];

    const inc = buildSessionCacheReport(session);
    const batch = buildCacheReport(rawSamples, rawFolds);
    // Parity with kernel batch holds for every bucket EXCEPT the single
    // intentional #1891 divergence: the no-baseline opener's residual is
    // rebooked ttlRepay → newContent in the incremental ledger (the kernel
    // batch path still books it as ttlRepay; bili never renders that path).
    assert.equal(inc.totals.input, batch.totals.input);
    assert.equal(inc.totals.cached, batch.totals.cached);
    assert.equal(inc.totals.compRepay, batch.totals.compRepay);
    assert.equal(inc.totals.residual, 0);
    assert.equal(inc.totals.balanced, true);
    assert.equal(inc.totals.newContent, batch.totals.newContent + 1000, "opener residual moved into new content");
    assert.equal(inc.totals.ttlRepay, batch.totals.ttlRepay - 1000, "opener residual removed from ttl re-pay");

    // Hand-computed expectations.
    assert.equal(inc.totals.input, 30500);
    assert.equal(inc.totals.cached, 19000);
    assert.equal(inc.totals.newContent, 2500);
    assert.equal(inc.totals.compRepay, 1500);
    assert.equal(inc.totals.ttlRepay, 7500);
    // Line-level: the opener is no-baseline initial content. The nb flag lives
    // on the raw ledger line — report lines follow the kernel line shape.
    const rawOpener = getCacheLedger(session).lines[0]!;
    assert.equal(rawOpener.nb, 1);
    const opener = inc.lines.find((l) => l.seq === 1)!;
    assert.equal(opener.newContent, 1000);
    assert.equal(opener.ttlRepay, 0);
    // Line-level: the cliff request splits into comp 1500 (= input − X) / ttl 3500.
    const cliff = inc.lines.find((l) => l.seq === 2)!;
    assert.equal(cliff.missed, 5000);
    assert.equal(cliff.newContent, 0);
    assert.equal(cliff.compRepay, 1500);
    assert.equal(cliff.ttlRepay, 3500);
    assert.equal(cliff.foldSeq, 1);
    // Fold economics carry the measured values.
    const f1 = inc.folds.find((f) => f.seq === 1)!;
    assert.equal(f1.T, 1500);
    assert.equal(f1.hPct, 16.7);
    assert.equal(f1.S, 5000);
    assert.equal(f1.sigma, 2048);
    // k counts samples with f.at < s.at <= nextFold.at: only the @2000 cliff.
    assert.equal(f1.turnsToNextFold, 1);
});

test("incremental k spans ALL intermediate samples (parity with batch, #1286)", () => {
    const session = makeSession();
    withView20(session);
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 0 });
    // F1: S=12140, σ=1000 → breakevenTurns ≈ 2.5009 at the default {w:1,r:0.1,q:4}.
    recordCacheFoldsFromBlocks(session, [block("b1", T0 + 1500, 12140, 4000, "m00010")], { V: 10000, Vp: 5000 });
    recordCacheSample(session, { at: T0 + 2000, input: 10000, cached: 10000 });
    recordCacheSample(session, { at: T0 + 2600, input: 10000, cached: 10000 });
    recordCacheSample(session, { at: T0 + 3200, input: 10000, cached: 10000 });
    recordCacheFoldsFromBlocks(session, [block("b2", T0 + 4000, 2000, 4000, "m00015")], { V: 10000, Vp: 8000 });

    const rawSamples: CacheSample[] = [
        { at: T0 + 1000, input: 10000, cached: 0 },
        { at: T0 + 2000, input: 10000, cached: 10000 },
        { at: T0 + 2600, input: 10000, cached: 10000 },
        { at: T0 + 3200, input: 10000, cached: 10000 },
    ];
    const rawFolds: FoldEvent[] = [
        { at: T0 + 1500, tokensCompressed: 12140, summaryTokens: 1000, firstFoldStartTokens: 4500, viewBefore: 10000, viewAfter: 5000 },
        { at: T0 + 4000, tokensCompressed: 2000, summaryTokens: 1000, firstFoldStartTokens: 7000, viewBefore: 10000, viewAfter: 8000 },
    ];

    const inc = buildSessionCacheReport(session);
    const batch = buildCacheReport(rawSamples, rawFolds);
    assert.equal(inc.folds.length, batch.folds.length);
    for (let i = 0; i < inc.folds.length; i++) {
        const a = inc.folds[i]!;
        const b = batch.folds[i]!;
        for (const key of ["seq", "at", "S", "sigma", "Vprime", "hPct", "T", "requestsAfter", "savedSoFar", "turnsToNextFold", "netTokenDelta", "oneTimeCostUnits", "perTurnSavingUnits", "breakevenTurns", "paidBack", "cadenceOk"] as const) {
            assert.deepEqual(a[key], b[key], `fold ${i} ${key}: incremental ${String(a[key])} !== batch ${String(b[key])}`);
        }
    }
    for (const key of ["folds", "grossSaved", "repayCost", "summaryCost", "netTokens", "paidBackCount", "notPaidBackCount", "unobservedCount"] as const) {
        assert.deepEqual(inc.economics[key], batch.economics[key], `economics.${key}`);
    }

    // Hand-computed expectations: before #1286 the incremental path froze
    // F1.k at 1 (consumedFoldSeq gate ended its counting after one sample),
    // making paidBack false even though cadence (3) passes breakeven (≈2.5).
    const f1 = inc.folds.find((f) => f.seq === 1)!;
    assert.equal(f1.requestsAfter, 3);
    assert.equal(f1.turnsToNextFold, 3);
    assert.equal(f1.hPct, 100);
    assert.equal(f1.T, 0);
    assert.ok(Math.abs(f1.breakevenTurns! - 2.5008976660682225) < 1e-9);
    assert.equal(f1.paidBack, true);
    assert.equal(f1.cadenceOk, true);
    assert.equal(f1.savedSoFar, (12140 - 1000) * 3);
    const f2 = inc.folds.find((f) => f.seq === 2)!;
    assert.equal(f2.turnsToNextFold, null);
    // #2044: the last fold is now evaluable on the full post-fold window —
    // zero post-fold requests against a positive n* is NOT PAID BACK (yet),
    // no longer unobserved; cadenceOk stays null with no next fold.
    assert.equal(f2.paidBack, false);
    assert.equal(f2.cadenceOk, null);
    assert.equal(f2.requestsAfter, 0);
    assert.equal(inc.totals.balanced, true);
});

test("cold-start miss lands in the new-content bucket (no baseline, #1891); pure append is new content", () => {
    const session = makeSession();
    recordCacheSample(session, { at: T0 + 1000, input: 1000, cached: 0 });
    recordCacheSample(session, { at: T0 + 2000, input: 2000, cached: 1000 });
    const r = buildSessionCacheReport(session);
    const l1 = r.lines.find((l) => l.seq === 1)!;
    // #1891: no prior bill means nothing could have expired — the opener's
    // uncached input is initial content, not a prefix re-pay. (nb lives on the
    // raw ledger line — report lines follow the kernel line shape.)
    assert.equal(getCacheLedger(session).lines[0]!.nb, 1);
    assert.equal(l1.newContent, 1000);
    assert.equal(l1.ttlRepay, 0);
    assert.equal(l1.compRepay, 0);
    const l2 = r.lines.find((l) => l.seq === 2)!;
    assert.equal(l2.newContent, 1000);
    assert.equal(l2.ttlRepay, 0);
    assert.equal(r.initialBills.samples, 1);
    assert.equal(r.initialBills.inputTokens, 1000);
    assert.equal(r.totals.balanced, true);
});

test("bootstrap ignores pre-existing blocks; later blocks become folds", () => {
    const session = makeSession();
    withView20(session);
    const st = session.state as { blocks: CompressionBlock[] };
    st.blocks.push(block("b1", T0 + 100, 4000, 6400, "m00005"));
    st.blocks.push(block("b2", T0 + 200, 3000, 4800, "m00012"));
    recordCacheSample(session, { at: T0 + 1000, input: 9000, cached: 8000 });
    let led = (session.metadata as Record<string, { folds: unknown[]; lastBlockId: number }> & object)["cacheLedger"]!;
    assert.equal(led.folds.length, 0, "historical blocks are not folds");
    assert.equal(led.lastBlockId, 2);
    st.blocks.push(block("b3", T0 + 1500, 5000, 8192, "m00010"));
    recordCacheSample(session, { at: T0 + 2000, input: 5000, cached: 1000 });
    led = (session.metadata as Record<string, { folds: unknown[]; lastBlockId: number }> & object)["cacheLedger"]!;
    assert.equal(led.folds.length, 1);
    const r = buildSessionCacheReport(session);
    const l2 = r.lines.find((l) => l.seq === 2)!;
    assert.ok(l2.compRepay > 0, "post-bootstrap fold attributes re-pay");
    assert.equal(l2.foldSeq, 1);
});

test("plugin-mode lazy detection catches pi-created blocks at usage time", () => {
    const session = makeSession();
    withView20(session);
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    // pi compresses locally between requests; proxy sees the new block only
    // when the next request's state sync lands — no eager call here.
    const st = session.state as { blocks: CompressionBlock[] };
    st.blocks.push(block("b1", T0 + 1400, 5000, 8192, "m00010"));
    recordCacheSample(session, { at: T0 + 2000, input: 6000, cached: 1000 });
    const r = buildSessionCacheReport(session);
    assert.equal(r.folds.length, 1);
    const l2 = r.lines.find((l) => l.seq === 2)!;
    assert.equal(l2.compRepay, 1500);
    assert.equal(l2.ttlRepay, 3500);
    assert.equal(r.folds[0]!.T, 1500);
});

test("folds stamped after the current sample wait for the next one", () => {
    const session = makeSession();
    withView20(session);
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    recordCacheFoldsFromBlocks(session, [block("b1", T0 + 2500, 5000, 8192, "m00010")], { V: 10000, Vp: 5000 });
    // Sample before the fold's timestamp: nothing to attribute yet.
    recordCacheSample(session, { at: T0 + 2000, input: 10500, cached: 9000 });
    const mid = buildSessionCacheReport(session).lines.find((l) => l.seq === 2)!;
    assert.equal(mid.compRepay, 0);
    assert.equal(mid.newContent, 500);
    assert.equal(mid.ttlRepay, 1000);
    recordCacheSample(session, { at: T0 + 3000, input: 6000, cached: 1000 });
    const after = buildSessionCacheReport(session).lines.find((l) => l.seq === 3)!;
    assert.equal(after.compRepay, 1500);
    assert.equal(after.foldSeq, 1);
});

test("ledger retains every sample past the old 512 cap (#1489)", () => {
    const session = makeSession();
    let input = 1000;
    for (let i = 0; i < 600; i++) {
        recordCacheSample(session, { at: T0 + 1000 + i * 60_000, input, cached: Math.floor(input * 0.9), output: 100 });
        input += 100;
    }
    const led = (session.metadata as Record<string, { lines: unknown[]; sampleSeq: number; agg: { requests: number; input: number } }> & object)["cacheLedger"]!;
    assert.equal(led.sampleSeq, 600);
    assert.equal(led.lines.length, 600);
    assert.equal(led.agg.requests, 600);
    const expectedInput = Array.from({ length: 600 }, (_, i) => 1000 + i * 100).reduce((a, b) => a + b, 0);
    assert.equal(led.agg.input, expectedInput);
    const r = buildSessionCacheReport(session);
    assert.equal(r.linesOmitted, 0);
    assert.equal(r.lines[0]!.seq, 1);
    assert.equal(r.lines[r.lines.length - 1]!.seq, 600);
    assert.equal(r.totals.requests, 600);
    assert.equal(r.totals.balanced, true);
});

test("ledger retains every fold past the old 256 cap (#1489)", () => {
    const session = makeSession();
    for (let i = 1; i <= 260; i++) {
        recordCacheFoldsFromBlocks(session, [block(`b${i}`, T0 + i * 1000, 1000, 400)]);
    }
    const led = (session.metadata as Record<string, { folds: unknown[] }> & object)["cacheLedger"]!;
    assert.equal(led.folds.length, 260);
    const r = buildSessionCacheReport(session);
    assert.equal(r.folds.length, 260);
    assert.equal(r.folds[0]!.seq, 1);
    assert.equal(r.economics.folds, 260);
});

test("handleAcpCache full detail windows the text view past 512 lines (#1489)", () => {
    const session = makeSession();
    for (let i = 0; i < 600; i++) {
        recordCacheSample(session, { at: T0 + 1000 * i, input: 100000, cached: 99000 });
    }
    const full = handleAcpCache(session, { detail: "full" }).text;
    assert.match(full, /LINE ITEMS \(last 512 of 600\):/);
    const rows = full.split("\n").filter((l) => /\s+99\.0%\s/.test(l));
    assert.equal(rows.length, 512);
    const r = buildSessionCacheReport(session);
    assert.equal(r.lines.length, 600);
    assert.equal(r.linesOmitted, 0);
});

test("legacy-trimmed sessions keep their historical deficit honest through the window (#1489)", () => {
    const session = makeSession();
    for (let i = 0; i < 600; i++) {
        recordCacheSample(session, { at: T0 + 1000 * i, input: 100000, cached: 99000 });
    }
    const led = (session.metadata as Record<string, { lines: unknown[]; sampleSeq: number }> & object)["cacheLedger"]!;
    led.lines.splice(0, 88);
    assert.equal(led.lines.length, 512);
    assert.equal(led.sampleSeq, 600);
    for (let i = 0; i < 100; i++) {
        recordCacheSample(session, { at: T0 + 1000 * (600 + i), input: 100000, cached: 99000 });
    }
    const r = buildSessionCacheReport(session);
    assert.equal(r.lines.length, 612);
    assert.equal(r.linesOmitted, 88);
    const full = handleAcpCache(session, { detail: "full" }).text;
    assert.match(full, /LINE ITEMS \(last 512 of 700\):/);
});

test("handleAcpCache renders the grand ledger with a closing identity", () => {
    const session = makeSession();
    withView20(session);
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    recordCacheFoldsFromBlocks(session, [block("b1", T0 + 1500, 5000, 8192, "m00010")], { V: 10000, Vp: 5000 });
    recordCacheSample(session, { at: T0 + 2000, input: 6000, cached: 1000 });
    const text = handleAcpCache(session).text;
    assert.match(text, /ACP CACHE REPORT \(cl-\d+\)/);
    assert.match(text, /GRAND LEDGER/);
    assert.match(text, /identity check\s+OK/);
    assert.match(text, /FOLD ECONOMICS/);
    assert.match(text, /LINE ITEMS/);
});

test("empty session reports zero balanced totals", () => {
    const session = makeSession();
    const r = buildSessionCacheReport(session);
    assert.equal(r.totals.requests, 0);
    assert.equal(r.totals.balanced, true);
    assert.match(handleAcpCache(session).text, /identity check\s+OK/);
});

test("handleAcpCache defaults to summary; detail full restores the per-line listing", () => {
    const session = makeSession();
    withView20(session);
    for (let i = 0; i < 12; i++) {
        recordCacheSample(session, { at: T0 + 1000 * i, input: 100000, cached: 99000 });
    }
    recordCacheFoldsFromBlocks(session, [block("b1", T0 + 12500, 5000, 8192, "m00010")], { V: 10000, Vp: 5000 });
    for (let i = 0; i < 12; i++) {
        recordCacheSample(session, { at: T0 + 13000 + 1000 * i, input: 100000, cached: 99000 });
    }
    const summary = handleAcpCache(session).text;
    assert.match(summary, /\[summary — detail:"full" for every fold & line\]/);
    assert.match(summary, /no anomalies \(24 requests, median hit 99\.0%\)/);
    const full = handleAcpCache(session, { detail: "full" }).text;
    assert.ok(!full.includes("[summary"));
    const rows = full.split("\n").filter((l) => /\s+99\.0%\s/.test(l));
    assert.equal(rows.length, 24);
});

test("handleAcpCache rejects non-full detail values back to summary", () => {
    const session = makeSession();
    withView20(session);
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    assert.match(handleAcpCache(session, { detail: "everything" }).text, /\[summary/);
});

/** Two-fold session with ONE fully-cached sample between the folds (T stays 0,
 *  k=1 on both the incremental and kernel-batch paths): fold #1 S=5000 σ=1000,
 *  fold #2 S=1000 σ=100. */
function makeTwoFoldSession(): Session {
    const s = makeSession();
    recordCacheSample(s, { at: T0 + 1000, input: 100000, cached: 99000 });
    recordCacheFoldsFromBlocks(s, [block("b1", T0 + 1100, 5000, 4000)], { V: 100000, Vp: 96000 });
    recordCacheSample(s, { at: T0 + 2000, input: 96000, cached: 96000 });
    recordCacheFoldsFromBlocks(s, [block("b2", T0 + 3000, 1000, 400)], { V: 96000, Vp: 95100 });
    recordCacheSample(s, { at: T0 + 4000, input: 95100, cached: 95100 });
    return s;
}

test("unstamped sessions keep the pre-#1279 default profile and economics", () => {
    const r = buildSessionCacheReport(makeTwoFoldSession());
    assert.deepEqual(r.profile, { w: 1, r: 0.1, q: 4 });
    const f = r.folds[0]!;
    // (w−r)·T + q·σ − r·S with T=0 → 4·1000 − 0.1·5000
    assert.equal(f.oneTimeCostUnits, 3500);
    assert.equal(f.perTurnSavingUnits, 400);
});

test("stamped priceProfile re-prices fold economics end to end (#1279)", () => {
    const baseline = buildSessionCacheReport(makeTwoFoldSession());
    const ds = makeTwoFoldSession();
    ds.metadata.cachePriceProfile = { w: 1, r: 0.1, q: 1.5 };
    const r = buildSessionCacheReport(ds);

    assert.deepEqual(r.profile, { w: 1, r: 0.1, q: 1.5 });
    const fb = baseline.folds[0]!;
    const fd = r.folds[0]!;
    assert.equal(fd.T, fb.T);
    assert.equal(fd.S, fb.S);
    assert.equal(fd.sigma, fb.sigma);
    assert.equal(fd.netTokenDelta, fb.netTokenDelta);
    assert.equal(fd.turnsToNextFold, fb.turnsToNextFold);
    assert.equal(fb.oneTimeCostUnits, 3500);
    assert.equal(fd.oneTimeCostUnits, 1000);
    assert.equal(fb.perTurnSavingUnits, 400);
    assert.equal(fd.perTurnSavingUnits, 400);
    assert.equal(fb.breakevenTurns, 8.75);
    assert.equal(fd.breakevenTurns, 2.5);
    assert.equal(fb.paidBack, false);
    assert.equal(fd.paidBack, false);
    assert.match(handleAcpCache(ds).text, /FOLD ECONOMICS \(2 folds @ w=1 r=0\.1 q=1\.5\)/);

    const batch = buildCacheReport(
        [
            { at: T0 + 1000, input: 100000, cached: 99000 },
            { at: T0 + 2000, input: 96000, cached: 96000 },
            { at: T0 + 4000, input: 95100, cached: 95100 },
        ],
        [
            { at: T0 + 1100, tokensCompressed: 5000, summaryTokens: 1000, viewBefore: 100000, viewAfter: 96000 },
            { at: T0 + 3000, tokensCompressed: 1000, summaryTokens: 100, viewBefore: 96000, viewAfter: 95100 },
        ],
        { priceProfile: { w: 1, r: 0.1, q: 1.5 } },
    );
    const bf = batch.folds[0]!;
    assert.deepEqual(r.profile, batch.profile);
    assert.equal(fd.oneTimeCostUnits, bf.oneTimeCostUnits);
    assert.equal(fd.perTurnSavingUnits, bf.perTurnSavingUnits);
    assert.equal(fd.breakevenTurns, bf.breakevenTurns);
    assert.equal(fd.paidBack, bf.paidBack);
});

test("partial stamped profile falls back per field to kernel defaults (#1279)", () => {
    const s = makeTwoFoldSession();
    s.metadata.cachePriceProfile = { q: 2 };
    const r = buildSessionCacheReport(s);
    assert.deepEqual(r.profile, { w: 1, r: 0.1, q: 2 });
    assert.equal(r.folds[0]!.oneTimeCostUnits, 2 * 1000 - 0.1 * 5000);
});

test("corrupt stamped profile degrades to kernel defaults instead of poisoning the report (#1279)", () => {
    for (const bad of ["junk", [1, 0.1], null, { w: -1 }, { r: "cheap" }, { q: Number.NaN }]) {
        const s = makeTwoFoldSession();
        (s.metadata as Record<string, unknown>).cachePriceProfile = bad;
        const r = buildSessionCacheReport(s);
        assert.deepEqual(r.profile, { w: 1, r: 0.1, q: 4 }, JSON.stringify(bad));
        assert.equal(r.folds[0]!.oneTimeCostUnits, 3500, JSON.stringify(bad));
    }
});

test("registry-stamped sessions price fold economics in real money (#2478)", () => {
    const s = makeTwoFoldSession();
    s.metadata.cachePriceProfile = { w: 3, r: 0.3, q: 15 };
    s.metadata.cachePriceSource = {
        kind: "registry",
        modelKey: "anthropic/claude-sonnet-4-5",
        inputPerMtok: 3,
        cacheReadPerMtok: 0.3,
        outputPerMtok: 15,
    };
    const r = buildSessionCacheReport(s);
    const p = r.priced;
    assert.ok(p, "registry provenance produces a priced summary");
    // Absolute $/Mtok profile → kernel unit math IS microusd (scale=1).
    // Fold #1: oneTime = 15·1000 − 0.3·5000 = 13500, perTurn = 4000·0.3 = 1200,
    //           gross += 1200·2 = 2400, breakeven 11.25 > ra 2 → not paid back.
    // Fold #2: oneTime = 15·100 − 0.3·1000 = 1200, perTurn = 900·0.3 = 270,
    //          gross += 270·1 = 270, breakeven ≈ 4.44 > ra 1 → not paid back.
    assert.equal(p.scale, 1);
    assert.equal(p.grossUsd, 2670 / 1e6);
    assert.equal(p.oneTimeUsd, 14700 / 1e6);
    assert.equal(p.netUsd, (2670 - 14700) / 1e6);
    assert.deepEqual([p.paidBackCount, p.notPaidBackCount, p.unobservedCount], [0, 2, 0]);

    const text = handleAcpCache(s).text;
    assert.match(
        text,
        /PRICED ECONOMICS \(models\.dev anthropic\/claude-sonnet-4-5 @ in \$3\.00 · read \$0\.30 · out \$15\.0 per Mtok\)/,
    );
    // #2478 round 2: each $ figure pairs its kernel token figure (two-fold
    // session: grossSaved 8000+900=8900, netTokens 8900−0−1100=7800).
    assert.match(text, /gross saved ≈ \$0\.00 \(8900 tok\) · one-time cost ≈ \$0\.01 \(re-pay premium \+ summary output\) → net ≈ -\$0\.01 \(7800 tok\)/);
    assert.match(text, /verdict: 0 paid back · 2 not paid back · 0 unobserved/);
    assert.ok(
        text.indexOf("PRICED ECONOMICS") > text.indexOf("FOLD ECONOMICS"),
        "priced section follows the token-denominated FOLD ECONOMICS block",
    );
});

test("config-stamped sessions anchor the ratio profile to the models.dev input price (#2478)", () => {
    const s = makeTwoFoldSession();
    s.metadata.cachePriceProfile = { q: 4 };
    s.metadata.cachePriceSource = { kind: "config", modelKey: "anthropic/claude-sonnet-4-5", inputPerMtok: 3 };
    const r = buildSessionCacheReport(s);
    const p = r.priced;
    assert.ok(p);
    // Ratio profile {1, 0.1, 4} × $3/Mtok anchor: fold #1 units 3500/400 → gross += 800,
    // fold #2 units 300/90 → gross += 90; scale 3 turns input-token units into μ$.
    assert.equal(p.scale, 3);
    assert.equal(p.grossUsd, 890 * 3 / 1e6);
    assert.equal(p.oneTimeUsd, 3800 * 3 / 1e6);
    assert.equal(p.netUsd, (890 - 3800) * 3 / 1e6);
    const text = handleAcpCache(s).text;
    assert.match(
        text,
        /PRICED ECONOMICS \(configured priceProfile \(input-ratio\) anchored at \$3\.00\/Mtok input \(models\.dev anthropic\/claude-sonnet-4-5\)\)/,
    );
});

test("user costPerMtok config prices folds in real money without a models.dev anchor (#2478)", () => {
    const s = makeTwoFoldSession();
    s.metadata.cachePriceProfile = { w: 3, r: 0.3, q: 15 };
    s.metadata.cachePriceSource = { kind: "config", absolute: true, inputPerMtok: 3, cacheReadPerMtok: 0.3, outputPerMtok: 15 };
    const r = buildSessionCacheReport(s);
    const p = r.priced;
    assert.ok(p);
    // Absolute user config → scale 1 (no models.dev anchor needed); same unit
    // math as the registry stamp above.
    assert.equal(p.scale, 1);
    assert.equal(p.grossUsd, 2670 / 1e6);
    assert.equal(p.oneTimeUsd, 14700 / 1e6);
    assert.equal(p.netUsd, (2670 - 14700) / 1e6);
    const text = handleAcpCache(s).text;
    assert.match(text, /PRICED ECONOMICS \(configured costPerMtok @ in \$3\.00 · read \$0\.30 · out \$15\.0\)/);
});

test("unpriced or corrupt provenance leaves the report token-denominated (#2478)", () => {
    for (const bad of ["junk", { kind: "weird" }, { kind: "config" }, { kind: "config", modelKey: 42 }]) {
        const s = makeTwoFoldSession();
        (s.metadata as Record<string, unknown>).cachePriceSource = bad;
        const r = buildSessionCacheReport(s);
        assert.equal(r.priced, undefined, JSON.stringify(bad));
        assert.doesNotMatch(handleAcpCache(s).text, /PRICED ECONOMICS/, JSON.stringify(bad));
    }
    // A bare registry source assumes the stamped profile is already absolute
    // ($/Mtok) — server.ts stamps both together, so scale stays 1.
    const bare = makeTwoFoldSession();
    (bare.metadata as Record<string, unknown>).cachePriceSource = { kind: "registry" };
    assert.equal(buildSessionCacheReport(bare).priced?.scale, 1);
});

test("summarizePricedFolds mirrors the kernel verdict math in USD (#2478)", () => {
    // S ≤ σ → perTurn ≤ 0 → unobserved (kernel: breakeven null), cost still counted.
    // Config anchor $2/Mtok scales the ratio units (scale=2; registry would be 1).
    const p = summarizePricedFolds(
        [{ S: 1000, sigma: 1500, T: 0, requestsAfter: 5 }],
        { w: 1, r: 0.1, q: 4 },
        { kind: "config", inputPerMtok: 2 },
    )!;
    assert.deepEqual([p.paidBackCount, p.notPaidBackCount, p.unobservedCount], [0, 0, 1]);
    assert.equal(p.grossUsd, 0);
    assert.equal(p.oneTimeUsd, (4 * 1500 - 0.1 * 1000) * 2 / 1e6);
    assert.equal(p.netUsd, p.grossUsd - p.oneTimeUsd);
    // Paid-back boundary: breakeven exactly reached counts as paid back (ra ≥ n*).
    const pb = summarizePricedFolds(
        [{ S: 1000, sigma: 0, T: 0, requestsAfter: 10 }],
        { w: 1, r: 0.1, q: 4 },
        { kind: "registry", inputPerMtok: 1 },
    )!;
    // oneTime = 0, perTurn = 100 → breakeven 0 → paid back at any ra ≥ 0.
    assert.deepEqual([pb.paidBackCount, pb.notPaidBackCount, pb.unobservedCount], [1, 0, 0]);
    assert.equal(pb.grossUsd, 100 * 10 / 1e6);
    // Missing anchor on a ratio source → no pricing at all.
    assert.equal(summarizePricedFolds([{ S: 1000, sigma: 0, T: 0, requestsAfter: 1 }], { w: 1, r: 0.1, q: 4 }, { kind: "config" }), undefined);
});

test("model switch flags the first sample after a change and attributes its residual (#1535)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    recordCacheSample(session, { at: T0 + 2000, input: 10500, cached: 10000 });
    session.metadata.lastModel = "claude-opus-4-6";
    recordCacheSample(session, { at: T0 + 3000, input: 11000, cached: 0 });
    const r = buildSessionCacheReport(session);
    assert.equal(r.modelSwitches.count, 1);
    // missed 11000 = growth 500 (new content) + 10500 re-billed stable prefix.
    assert.equal(r.modelSwitches.missedTokens, 10500);
    const ev = r.modelSwitches.events[0]!;
    assert.equal(ev.seq, 3);
    assert.equal(ev.from, "gpt-5");
    assert.equal(ev.to, "claude-opus-4-6");
    assert.equal(ev.attributed, 10500);
    const l3 = r.lines.find((l) => l.seq === 3)!;
    assert.equal(l3.newContent, 500);
    assert.equal(l3.ttlRepay, 10500);
    assert.equal(l3.compRepay, 0);
    // Kernel buckets untouched — identity still closes exactly.
    assert.equal(r.totals.residual, 0);
    assert.equal(r.totals.balanced, true);
});

test("unknown or missing models never flag a switch (#1535)", () => {
    const session = makeSession();
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 2000, input: 10500, cached: 9500 });
    delete session.metadata.lastModel;
    recordCacheSample(session, { at: T0 + 3000, input: 11000, cached: 9500 });
    session.metadata.lastModel = "";
    recordCacheSample(session, { at: T0 + 4000, input: 11500, cached: 9500 });
    const r = buildSessionCacheReport(session);
    assert.equal(r.modelSwitches.count, 0);
    assert.equal(r.modelSwitches.missedTokens, 0);
    assert.deepEqual(r.modelSwitches.events, []);
});

test("round-trip A→B→A counts two switches (#1535)", () => {
    const session = makeSession();
    session.metadata.lastModel = "a";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    session.metadata.lastModel = "b";
    recordCacheSample(session, { at: T0 + 2000, input: 10000, cached: 0 });
    session.metadata.lastModel = "a";
    recordCacheSample(session, { at: T0 + 3000, input: 10000, cached: 0 });
    const r = buildSessionCacheReport(session);
    assert.equal(r.modelSwitches.count, 2);
    assert.equal(r.modelSwitches.missedTokens, 20000);
    assert.deepEqual(
        r.modelSwitches.events.map((e) => [e.from, e.to]),
        [
            ["a", "b"],
            ["b", "a"],
        ],
    );
});

test("switch aggregates stay exact across heavy sampling with a complete event list (#1535)", () => {
    const flat = { at: 0, input: 10000, cached: 9000 };
    const warm = { at: 0, input: 12000, cached: 12000 };
    const session = makeSession();
    session.metadata.lastModel = "m1";
    for (let i = 0; i < 100; i++) recordCacheSample(session, { ...flat, at: T0 + i * 60_000 });
    session.metadata.lastModel = "m2";
    recordCacheSample(session, { at: T0 + 100 * 60_000, input: 12000, cached: 0 });
    for (let i = 0; i < 512; i++) recordCacheSample(session, { ...warm, at: T0 + (101 + i) * 60_000 });
    const r = buildSessionCacheReport(session);
    assert.equal(r.modelSwitches.count, 1);
    // missed 12000 − growth 2000 (new content) = 10000 re-billed stable prefix.
    assert.equal(r.modelSwitches.missedTokens, 10000);
    // Lines are kept in full (#1489), so the event list is complete: the
    // switch line's predecessor survived and the from→to pair is intact.
    assert.equal(r.modelSwitches.events.length, 1);
    assert.deepEqual(r.modelSwitches.events[0]!, {
        seq: 101,
        at: T0 + 100 * 60_000,
        from: "m1",
        to: "m2",
        input: 12000,
        cached: 0,
        hitPct: 0,
        attributed: 10000,
    });
    assert.equal(r.totals.balanced, true);
});

test("pre-#1535 persisted ledgers normalize instead of NaN-ing (#1535)", () => {
    const session = makeSession();
    session.metadata["cacheLedger"] = {
        v: 1,
        lastBlockId: 0,
        consumedFoldSeq: 0,
        sampleSeq: 1,
        foldSeqCounter: 0,
        folds: [],
        lines: [{ seq: 1, at: T0, input: 10000, cached: 9000, output: 0, hitPct: 90, missed: 1000, nc: 0, cr: 0, tr: 1000, foldSeq: null }],
        agg: { requests: 1, input: 10000, cached: 9000, output: 0, nc: 0, cr: 0, tr: 1000 },
    };
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10500, cached: 10000 });
    const r = buildSessionCacheReport(session);
    assert.equal(r.modelSwitches.count, 0, "old line without model cannot flag");
    assert.doesNotMatch(JSON.stringify(r), /NaN/);
    assert.equal(r.totals.balanced, true);
});

test("handleAcpCache renders the model-switch section in both modes (#1535)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    session.metadata.lastModel = "claude-opus-4-6";
    recordCacheSample(session, { at: T0 + 2000, input: 11000, cached: 0 });
    const text = handleAcpCache(session).text;
    assert.match(text, /MODEL SWITCHES/);
    assert.match(text, /1 switch\(es\)/);
    assert.match(text, /gpt-5 → claude-opus-4-6/);
    assert.match(text, /attributed 10\.0K/);
    const full = handleAcpCache(session, { detail: "full" }).text;
    assert.match(full, /MODEL SWITCHES/);
    const none = makeSession();
    assert.match(handleAcpCache(none).text, /MODEL SWITCHES\n  none observed/);
});

test("unknown-cache sample is quarantined out of the closure, not booked as a miss (#1536)", () => {
    const session = makeSession();
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    // provider reports no cache tokens -> cached null (unmeasurable, not a 0% miss)
    recordCacheSample(session, { at: T0 + 2000, input: 11000, cached: null });
    recordCacheSample(session, { at: T0 + 3000, input: 11500, cached: 11000 });
    const r = buildSessionCacheReport(session);
    assert.equal(r.unmeasured.samples, 1);
    assert.equal(r.unmeasured.inputTokens, 11000);
    // the unknown line is dropped from the rendered set (it would be a bogus 0% row)
    assert.equal(r.lines.length, 2);
    assert.ok(!r.lines.some((l) => l.seq === 2));
    // closure still closes exactly over the measurable subset
    assert.equal(r.totals.residual, 0);
    assert.equal(r.totals.balanced, true);
});

test("unknown-cache sample must not eat a pending fold — the next measured sample still attributes compRepay (#1536)", () => {
    // Regression pin for the consume-cursor known-gate: an unmeasured sample
    // arriving between a fold and the next measured sample advances neither
    // consumedFoldSeq nor the fold owner's T; the measured sample that follows
    // still sees the fold as pending and charges its compRepay to the owner.
    // (Mutation check: dropping the `known &&` on the cursor advance makes the
    // unknown sample eat the fold — owner T stays 0 and line 3 loses foldSeq.)
    const session = makeSession();
    withView20(session);
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    // fold materializes between samples: covers m00001..m00010 (5000 tok)
    recordCacheFoldsFromBlocks(session, [block("b1", T0 + 1500, 5000, 400, "m00001")]);
    // unmeasured post-fold sample arrives FIRST — must not consume the fold
    recordCacheSample(session, { at: T0 + 2000, input: 11000, cached: null });
    // measured post-fold sample: re-sends the folded region → compRepay lands on the owner
    recordCacheSample(session, { at: T0 + 3000, input: 10500, cached: 9000 });
    const r = buildSessionCacheReport(session);
    const l3 = r.lines.find((l) => l.seq === 3)!;
    assert.ok(!r.lines.some((l) => l.seq === 2), "unknown line is quarantined out of the rendered set");
    assert.equal(l3.foldSeq, 1, "measured sample owns the fold’s compRepay");
    const fold = r.folds.find((f) => f.seq === 1)!;
    assert.ok(fold && fold.T > 0, "owner T > 0 — the fold’s re-pay reached its owner through the measured sample");
    assert.equal(r.unmeasured.samples, 1);
    assert.equal(r.totals.balanced, true);
});

test("wire-protocol switch is attributed as a distinct cause (#1536)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000, protocol: "anthropic" });
    recordCacheSample(session, { at: T0 + 2000, input: 11000, cached: 0, protocol: "openai" });
    const r = buildSessionCacheReport(session);
    assert.equal(r.wireSwitches.count, 1);
    assert.equal(r.wireSwitches.events[0]!.from, "anthropic");
    assert.equal(r.wireSwitches.events[0]!.to, "openai");
    assert.equal(r.modelSwitches.count, 0, "model did not change");
    assert.ok(r.invalidation.wire > 0);
    assert.equal(r.totals.balanced, true);
});

test("upstream-origin switch is attributed as a distinct cause (#1536)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000, protocol: "openai", upstream: "https://api.openai.com" });
    recordCacheSample(session, { at: T0 + 2000, input: 11000, cached: 0, protocol: "openai", upstream: "https://relay.example.com" });
    const r = buildSessionCacheReport(session);
    assert.equal(r.upstreamSwitches.count, 1);
    assert.equal(r.upstreamSwitches.events[0]!.from, "https://api.openai.com");
    assert.equal(r.upstreamSwitches.events[0]!.to, "https://relay.example.com");
    assert.equal(r.wireSwitches.count, 0, "wire did not change");
    assert.ok(r.invalidation.upstream > 0);
    assert.equal(r.totals.balanced, true);
});

test("first sample under a new daemon boot is attributed to restart/refork (#1536 #499)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    // simulate the ledger surviving a daemon restart: lastBoot points at another process
    (session.metadata["cacheLedger"] as Record<string, unknown>).lastBoot = "previous-boot";
    recordCacheSample(session, { at: T0 + 2000, input: 11000, cached: 0 });
    // next sample in the SAME boot must not re-flag
    recordCacheSample(session, { at: T0 + 3000, input: 11500, cached: 11000 });
    const r = buildSessionCacheReport(session);
    assert.equal(r.restartDrops.count, 1);
    assert.equal(r.restartDrops.events[0]!.to, "(restart)");
    assert.ok(r.invalidation.restart > 0);
    assert.equal(r.totals.balanced, true);
});

test("handleAcpCache renders the CACHE INVALIDATION breakdown incl. unmeasured (#1536)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000, protocol: "anthropic", upstream: "https://api.openai.com" });
    recordCacheSample(session, { at: T0 + 2000, input: 11000, cached: 0, protocol: "openai", upstream: "https://relay.example.com" });
    recordCacheSample(session, { at: T0 + 3000, input: 11500, cached: null });
    const text = handleAcpCache(session).text;
    assert.match(text, /CACHE INVALIDATION/);
    assert.match(text, /wire switch:/);
    assert.match(text, /upstream switch:/);
    assert.match(text, /restart\/refork:/);
    assert.match(text, /unmeasured .*excluded from hit rate/);
});

test("per-cause buckets partition a multi-flag sample's residual (#1847)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 10000, protocol: "anthropic", upstream: "https://a.example" });
    // one request where model AND wire AND upstream all change at once, cold prefix
    session.metadata.lastModel = "claude-opus";
    recordCacheSample(session, { at: T0 + 2000, input: 10000, cached: 0, protocol: "openai", upstream: "https://b.example" });
    const r = buildSessionCacheReport(session);
    assert.equal(r.totals.ttlRepay, 10000);
    // charged exactly ONCE, to the highest-priority dimension (model > wire > upstream)
    assert.equal(r.invalidation.model, 10000);
    assert.equal(r.invalidation.wire, 0);
    assert.equal(r.invalidation.upstream, 0);
    assert.equal(r.invalidation.restart, 0);
    const named = r.invalidation.model + r.invalidation.wire + r.invalidation.upstream + r.invalidation.restart;
    assert.equal(named, r.totals.ttlRepay, "buckets are a partition: named + remaining closes exactly");
    assert.equal(r.invalidation.remaining, 0);
    // event counts still reflect every observed change (only the CHARGING is deduped)
    assert.equal(r.modelSwitches.count, 1);
    assert.equal(r.wireSwitches.count, 1);
    assert.equal(r.upstreamSwitches.count, 1);
    assert.equal(r.totals.balanced, true);
});

test("switch is detected across an unmeasured boundary line (#1847)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 10000 });
    // client switches model but this request reports NO cache tokens (unmeasurable)
    session.metadata.lastModel = "claude-opus";
    recordCacheSample(session, { at: T0 + 2000, input: 10500, cached: null });
    // next MEASURED request on the new model: cold prefix re-bill
    recordCacheSample(session, { at: T0 + 3000, input: 11000, cached: 0 });
    const r = buildSessionCacheReport(session);
    assert.ok(r.modelSwitches.count >= 1, "the switch is observed");
    assert.ok(r.invalidation.model > 0, "cold tail after an unmeasured switch is charged to the switch");
    assert.ok(r.invalidation.remaining < r.totals.ttlRepay, "not everything is left unattributed");
});

test("post-switch cold rounds are attributed within a bounded window and stopped by a warm round (#1847)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 10000 });   // warm baseline
    session.metadata.lastModel = "claude-opus";
    recordCacheSample(session, { at: T0 + 2000, input: 10000, cached: 0 });        // switch, cold
    recordCacheSample(session, { at: T0 + 3000, input: 10000, cached: 0 });        // still cold (continuation)
    recordCacheSample(session, { at: T0 + 4000, input: 10000, cached: 10000 });    // warm -> retires the window
    recordCacheSample(session, { at: T0 + 5000, input: 10000, cached: 0 });        // later TTL miss, NOT the switch
    const r = buildSessionCacheReport(session);
    assert.equal(r.invalidation.model, 20000, "switch line + exactly one continuation round");
    assert.equal(r.invalidation.remaining, 10000, "the post-warm miss stays provider-side");
    assert.equal(r.totals.balanced, true);
});

test("unmeasured lines store a null hit rate, not a falsifiable 0% (#1847)", () => {
    const session = makeSession();
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    recordCacheSample(session, { at: T0 + 2000, input: 11000, cached: null });
    const led = (session.metadata as Record<string, { lines: Array<{ unk?: number; hitPct: number | null }> }> & object)["cacheLedger"]!;
    const unkLine = led.lines.find((l) => l.unk === 1)!;
    assert.equal(unkLine.hitPct, null, "unmeasured hit rate is null, not 0");
    const r = buildSessionCacheReport(session);
    assert.ok(!r.lines.some((l) => l.seq === 2), "still quarantined out of the rendered set");
});

test("a large never-caused unattributed residual gets an explicit provider-side hint, not silence (#1847)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    for (let i = 0; i < 5; i++) {
        recordCacheSample(session, { at: T0 + 1000 * (i + 1), input: 100000, cached: 90000 });
    }
    const text = handleAcpCache(session).text;
    assert.match(text, /CACHE INVALIDATION/);
    assert.match(text, /no observable cause|no cause observed/i);
    assert.match(text, /NOT a bili bug|not a bili bug/i);
});

test("post-switch cold-tail rounds stay attributed, not flagged as seam suspects (#1847)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    settleUsageReport(session, { total: 40000, reportedCached: 40000 });   // warm baseline
    session.metadata.lastModel = "claude-opus";
    settleUsageReport(session, { total: 40000, reportedCached: 0 });       // the switch itself (flagged)
    settleUsageReport(session, { total: 40000, reportedCached: 0 });       // cold-tail continuation
    const r = buildSessionCacheReport(session);
    assert.equal(r.seam.suspects, 0, "a cause-attributed cold-tail round is not a seam candidate");
    assert.equal(r.invalidation.model, 80000, "both cold rounds stay charged to the switch");
});

test("pre-#1847 ledger lines keep their historical per-event attribution (#1847)", () => {
    const session = makeSession();
    session.metadata.lastModel = "gpt-5";
    recordCacheSample(session, { at: T0 + 1000, input: 40000, cached: 40000 });
    session.metadata.lastModel = "claude-opus";
    recordCacheSample(session, { at: T0 + 2000, input: 40000, cached: 0 });
    // Emulate a ledger persisted before #1847: drop the new per-line `cause` field.
    const meta = (session.metadata as Record<string, { lines: Array<{ cause?: string }> }> & object)["cacheLedger"]!;
    delete meta.lines[1].cause;
    const r = buildSessionCacheReport(session);
    assert.equal(r.modelSwitches.events.length, 1);
    assert.equal(r.modelSwitches.events[0].attributed, 40000, "legacy sw line keeps its historical charge display");
    assert.doesNotMatch(handleAcpCache(session).text, /cold rounds/, "legacy charge is not mislabeled as post-switch cold tail");
});
