import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSessionCacheReport, getCacheLedger, handleAcpCache, recordCacheSample } from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

function session(id: string): Session {
    return {
        id, metadata: {}, stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

const T0 = Date.parse("2026-10-01T00:00:00Z");

test("cache reports remain available when one size bucket exceeds the argument limit", () => {
    const s = session("large-cache-bucket");
    const count = 150_000;
    for (let index = 0; index < count; index++) {
        recordCacheSample(s, { at: T0 + index * 1000, input: 10_000, cached: index === count - 1 ? 5_000 : 9_000 });
    }
    const summary = handleAcpCache(s);
    const full = handleAcpCache(s, { detail: "full" });
    assert.deepEqual([summary.outcome, full.outcome], ["success", "success"], `${summary.text}\n${full.text}`);
    assert.match(summary.text, /ACP CACHE REPORT \(large-cache-bucket\)/);
    assert.match(full.text, /LINE ITEMS \(last 512 of 150000\):/);
    const report = buildSessionCacheReport(s);
    assert.deepEqual(report.stability.sizeBuckets, [{ lo: 0, hi: 20_000, n: count, hitMedian: 90, hitMin: 50 }]);
    assert.equal(report.totals.requests, count);
    assert.equal(report.totals.balanced, true);
    assert.equal(report.lines.length, count);
    assert.equal(report.linesOmitted, 0);
    assert.equal(getCacheLedger(s).lines.length, count);
});

test("bucket minima and medians keep their numeric values and unknown exclusions", () => {
    const s = session("small-cache-buckets");
    const samples = [
        { input: 40_000, cached: 10_000 },
        { input: 10_000, cached: 3_331 },
        { input: 10_000, cached: 10_000 },
        { input: 40_000, cached: 0 },
        { input: 10_000, cached: 0 },
        { input: 40_000, cached: 40_000 },
        { input: 10_000, cached: null },
        { input: 0, cached: 0 },
    ];
    samples.forEach((sample, index) => recordCacheSample(s, { at: T0 + index * 1000, ...sample }));
    const report = buildSessionCacheReport(s);
    assert.deepEqual(report.stability.sizeBuckets, [
        { lo: 0, hi: 20_000, n: 3, hitMedian: 33.3, hitMin: 0 },
        { lo: 40_000, hi: 60_000, n: 3, hitMedian: 25, hitMin: 0 },
    ]);
    assert.equal(report.unmeasured.samples, 1);
});

test("size buckets keep ascending order and the existing 24-bucket display cap", () => {
    const s = session("cache-bucket-cap");
    for (let index = 26; index >= 0; index--) {
        const input = index * 20_000 + 10_000;
        recordCacheSample(s, { at: T0 + (26 - index) * 1000, input, cached: input / 2 });
    }
    assert.deepEqual(buildSessionCacheReport(s).stability.sizeBuckets, Array.from({ length: 24 }, (_, index) => ({
        lo: index * 20_000, hi: (index + 1) * 20_000, n: 1, hitMedian: 50, hitMin: 50,
    })));
    assert.deepEqual(buildSessionCacheReport(session("empty-cache-buckets")).stability.sizeBuckets, []);
});
