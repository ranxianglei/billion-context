import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCacheReport, type CacheSample, type FoldEvent, type CompressionBlock } from "acp-kernel";
import { buildSessionCacheReport, handleAcpCache, recordCacheFoldsFromBlocks, recordCacheSample } from "../src/cache-ledger.ts";
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

    // t=1000: cold start, 10% miss → all residual.
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
    assert.equal(inc.totals.input, batch.totals.input);
    assert.equal(inc.totals.cached, batch.totals.cached);
    assert.equal(inc.totals.newContent, batch.totals.newContent);
    assert.equal(inc.totals.compRepay, batch.totals.compRepay);
    assert.equal(inc.totals.ttlRepay, batch.totals.ttlRepay);
    assert.equal(inc.totals.residual, 0);
    assert.equal(inc.totals.balanced, true);

    // Hand-computed expectations.
    assert.equal(inc.totals.input, 30500);
    assert.equal(inc.totals.cached, 19000);
    assert.equal(inc.totals.newContent, 1500);
    assert.equal(inc.totals.compRepay, 1500);
    assert.equal(inc.totals.ttlRepay, 8500);
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

test("cold-start miss lands in the ttl bucket; pure append is new content", () => {
    const session = makeSession();
    recordCacheSample(session, { at: T0 + 1000, input: 1000, cached: 0 });
    recordCacheSample(session, { at: T0 + 2000, input: 2000, cached: 1000 });
    const r = buildSessionCacheReport(session);
    const l1 = r.lines.find((l) => l.seq === 1)!;
    assert.equal(l1.ttlRepay, 1000);
    assert.equal(l1.compRepay, 0);
    const l2 = r.lines.find((l) => l.seq === 2)!;
    assert.equal(l2.newContent, 1000);
    assert.equal(l2.ttlRepay, 0);
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

test("ring eviction keeps aggregates exact", () => {
    const session = makeSession();
    let input = 1000;
    for (let i = 0; i < 520; i++) {
        recordCacheSample(session, { at: T0 + 1000 + i * 60_000, input, cached: Math.floor(input * 0.9), output: 100 });
        input += 100;
    }
    const led = (session.metadata as Record<string, { lines: unknown[]; sampleSeq: number; agg: { requests: number; input: number } }> & object)["cacheLedger"]!;
    assert.equal(led.sampleSeq, 520);
    assert.equal(led.lines.length, 512);
    assert.equal(led.agg.requests, 520);
    const expectedInput = Array.from({ length: 520 }, (_, i) => 1000 + i * 100).reduce((a, b) => a + b, 0);
    assert.equal(led.agg.input, expectedInput);
    const r = buildSessionCacheReport(session);
    assert.equal(r.linesOmitted, 8);
    assert.equal(r.lines[0]!.seq, 9);
    assert.equal(r.totals.requests, 520);
    assert.equal(r.totals.balanced, true);
});

test("handleAcpCache renders the grand ledger with a closing identity", () => {
    const session = makeSession();
    withView20(session);
    recordCacheSample(session, { at: T0 + 1000, input: 10000, cached: 9000 });
    recordCacheFoldsFromBlocks(session, [block("b1", T0 + 1500, 5000, 8192, "m00010")], { V: 10000, Vp: 5000 });
    recordCacheSample(session, { at: T0 + 2000, input: 6000, cached: 1000 });
    const text = handleAcpCache(session);
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
    assert.match(handleAcpCache(session), /identity check\s+OK/);
});
