import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionBlock } from "acp-kernel";
import { compactTokens, buildStatusLineStats, renderStatusLine } from "../src/status-line.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `sl-${seq}`,
        metadata: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, retrieveDropped: 0, retrieveDelivered: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function block(id: string, active: boolean): CompressionBlock {
    return { blockId: id, active } as unknown as CompressionBlock;
}

function setLedger(session: Session, agg: Record<string, number>, folds: Array<{ S: number; sigma: number; T: number; requestsAfter: number }>): void {
    (session.metadata as Record<string, unknown>)["cacheLedger"] = { v: 1, agg, folds };
}

test("compactTokens: canonical k/M rendering shared by every client surface", () => {
    assert.equal(compactTokens(0), "0");
    assert.equal(compactTokens(999), "999");
    assert.equal(compactTokens(1000), "1k");
    assert.equal(compactTokens(96_000), "96k");
    assert.equal(compactTokens(123_456), "123.5k");
    assert.equal(compactTokens(869_000), "869k");
    assert.equal(compactTokens(999_999), "1000k");
    assert.equal(compactTokens(1_700_000), "1.7M");
    assert.equal(compactTokens(12_345_678), "12.35M");
    assert.equal(compactTokens(-12_000), "-12k");
});

test("buildStatusLineStats: fresh session renders only the bare line inputs", () => {
    const s = makeSession();
    const st = buildStatusLineStats(s);
    assert.deepEqual(st, {
        contextTokens: 0,
        contextLimit: null,
        contextPct: null,
        savedTokens: 0,
        savedIsNet: false,
        blocksActive: 0,
        blocksTotal: 0,
        cacheHitPct: null,
        requests: 0,
        nudgeGrowth: null,
        nudgeStep: null,
    });
    // read-only contract: no ledger bootstrapped onto the session
    assert.deepEqual(Object.keys(s.metadata), []);
});

test("buildStatusLineStats: dual-source MAX and window percent", () => {
    const s = makeSession();
    s.stats.lastInputTokens = 96_000;
    s.stats.inputTokens = 100;
    s.stats.cachedTokens = 90;
    s.stats.requests = 3;
    (s.metadata as Record<string, unknown>)["effectiveContextLimit"] = 869_000;
    setLedger(s, { requests: 42, input: 500_000, cached: 480_000 }, []);
    const st = buildStatusLineStats(s);
    assert.equal(st.contextTokens, 96_000);
    assert.equal(st.contextLimit, 869_000);
    assert.equal(st.contextPct, 11);
    assert.equal(st.requests, 42);
    assert.equal(st.cacheHitPct, 96);
    // no folds → local estimate, not net
    assert.equal(st.savedIsNet, false);
});

test("buildStatusLineStats: fold economics match the web table (net may go negative)", () => {
    const s = makeSession();
    s.stats.tokensSaved = 5;
    setLedger(s, {}, [
        { S: 1_700_000, sigma: 0, T: 0, requestsAfter: 1 },
    ]);
    const st = buildStatusLineStats(s);
    assert.equal(st.savedIsNet, true);
    assert.equal(st.savedTokens, 1_700_000);

    // net can be negative when re-pay + summary cost exceed the avoidance
    const s2 = makeSession();
    setLedger(s2, {}, [
        { S: 10_000, sigma: 9_000, T: 5_000, requestsAfter: 1 },
    ]);
    const st2 = buildStatusLineStats(s2);
    assert.equal(st2.savedIsNet, true);
    assert.equal(st2.savedTokens, (10_000 - 9_000) * 1 - 5_000 - 9_000);
});

test("buildStatusLineStats: block counts and nudge slice", () => {
    const s = makeSession();
    (s.state as { blocks: CompressionBlock[] }).blocks.push(block("b1", true), block("b2", true), block("b3", false));
    const st = buildStatusLineStats(s, { breakdown: { growth: 12_000, nudgeGrowthTokens: 50_000 } });
    assert.equal(st.blocksActive, 2);
    assert.equal(st.blocksTotal, 3);
    assert.equal(st.nudgeGrowth, 12_000);
    assert.equal(st.nudgeStep, 50_000);
    const stNone = buildStatusLineStats(s);
    assert.equal(stNone.nudgeGrowth, null);
    assert.equal(stNone.nudgeStep, null);
    const stBad = buildStatusLineStats(s, { breakdown: { growth: Number.NaN, nudgeGrowthTokens: "50k" } });
    assert.equal(stBad.nudgeGrowth, null);
    assert.equal(stBad.nudgeStep, null);
});

test("renderStatusLine: min tier exact shape (the issue's example data)", () => {
    const s = makeSession();
    s.stats.lastInputTokens = 96_000;
    (s.metadata as Record<string, unknown>)["effectiveContextLimit"] = 869_000;
    setLedger(s, { requests: 42, input: 500_000, cached: 480_000 }, [{ S: 1_700_000, sigma: 0, T: 0, requestsAfter: 1 }]);
    (s.state as { blocks: CompressionBlock[] }).blocks.push(...Array.from({ length: 105 }, (_, i) => block(`b${i + 1}`, i < 35)));
    const st = buildStatusLineStats(s, { breakdown: { growth: 12_000, nudgeGrowthTokens: 50_000 } });
    assert.equal(renderStatusLine(st, "min"), "bili 11% 96k/869k · saved 1.7M · 35blk · cache 96%");
    assert.ok(renderStatusLine(st, "min").length <= 60, "min must fit a narrow bottom bar");
    assert.equal(renderStatusLine(st, "med"), "bili 11% 96k/869k · saved 1.7M · 35/105blk · cache 96% · 42req · nudge 12k/50k");
});

test("renderStatusLine: estimate marker, missing segments drop out, negative net shown", () => {
    const s = makeSession();
    s.stats.tokensSaved = 1_700_000;
    let st = buildStatusLineStats(s);
    assert.equal(renderStatusLine(st, "min"), "bili saved 1.7M~");

    const s2 = makeSession();
    s2.stats.lastInputTokens = 96_000;
    st = buildStatusLineStats(s2);
    assert.equal(renderStatusLine(st, "min"), "bili 96k");

    const s3 = makeSession();
    setLedger(s3, {}, [{ S: 10_000, sigma: 9_000, T: 5_000, requestsAfter: 1 }]);
    st = buildStatusLineStats(s3);
    assert.equal(renderStatusLine(st, "min"), "bili saved -13k");

    const s4 = makeSession();
    st = buildStatusLineStats(s4);
    assert.equal(renderStatusLine(st, "min"), "bili");
    assert.equal(renderStatusLine(st, "med"), "bili");
});
