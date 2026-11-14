import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompressionBlock } from "acp-kernel";
import { buildSessionCacheReport, getCacheLedger, recordCacheFoldsFromBlocks, recordCacheSample } from "../src/cache-ledger.ts";
import { createSession, type Session } from "../src/session.ts";

const T0 = Date.parse("2026-11-01T00:00:00Z");

function block(id: number, overrides: Partial<CompressionBlock> = {}): CompressionBlock {
    return {
        blockId: `b${id}`, runId: "fold-registration", tier: 1, summary: `summary ${id}`,
        directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
        compressedTokens: id * 100, createdAt: T0 + id, survivedCount: 0,
        generation: "young", active: true, ...overrides,
    };
}

function countFoldReads(session: Session): () => number {
    const ledger = getCacheLedger(session);
    let reads = 0;
    ledger.folds = new Proxy(ledger.folds, {
        get(target, key, receiver) {
            if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) reads++;
            return Reflect.get(target, key, receiver);
        },
    });
    return () => reads;
}

for (const prior of [0, 500]) {
    test(`a batch visits fold records linearly with ${prior} existing folds`, (t) => {
        const session = createSession(`fold-work-${prior}`);
        const count = 600;
        recordCacheFoldsFromBlocks(session, Array.from({ length: prior }, (_, i) => block(i + 1)));
        const reads = countFoldReads(session);
        recordCacheFoldsFromBlocks(session, Array.from({ length: count }, (_, i) => block(prior + i + 1)));
        const observed = reads();
        t.diagnostic(`${observed} fold reads for ${prior} existing + ${count} new records`);
        assert.ok(observed <= 3 * (prior + count), `${observed} fold reads for ${prior} existing + ${count} new records`);
        const ledger = getCacheLedger(session);
        assert.equal(ledger.folds.length, prior + count);
        assert.equal(ledger.foldSeqCounter, prior + count);
        assert.equal(ledger.folds.at(-1)?.k, null);
        assert.ok(ledger.folds.slice(0, -1).every((fold) => fold.k === 0));
    });
}

test("an empty call does not create a ledger or freeze an existing open fold", () => {
    const session = createSession("empty-fold-batch");
    recordCacheFoldsFromBlocks(session, []);
    assert.equal(session.metadata.cacheLedger, undefined);
    recordCacheFoldsFromBlocks(session, [block(1)]);
    const ledger = getCacheLedger(session);
    ledger.folds[0].requestsAfter = 2.5;
    const before = structuredClone(ledger);
    recordCacheFoldsFromBlocks(session, []);
    assert.deepEqual(ledger, before);
});

test("skipped blocks leave open folds and the block high-water mark untouched", () => {
    const session = createSession("old-fold-batch");
    recordCacheFoldsFromBlocks(session, [block(10)]);
    const ledger = getCacheLedger(session);
    ledger.folds[0].requestsAfter = 4;
    const before = structuredClone(ledger);
    const ignored = block(9);
    Object.defineProperty(ignored, "summary", { get: () => { throw new Error("old block summary must not be read"); } });
    recordCacheFoldsFromBlocks(session, [ignored, block(10), block(0)]);
    assert.deepEqual(ledger, before);
});

test("batch records preserve geometry, token rounding, timestamps, and insertion order", (t) => {
    const session = createSession("fold-values");
    session.state.messageRefs.byRef = { m00001: "raw-1", m00002: "raw-2", m00003: "raw-3" };
    session.state.tokenSnapshot = { m00001: 100, m00002: 200, m00003: 300 };
    t.mock.method(Date, "now", () => T0 + 500);
    recordCacheFoldsFromBlocks(session, [
        block(2, { createdAt: 0, summary: "a😀bc", startRef: "m00003" }),
        block(4, { summary: "", startRef: "m00002" }),
    ], { V: 600, Vp: 100 });
    assert.deepEqual(getCacheLedger(session).folds, [
        { at: T0 + 500, S: 200, sigma: 2, X: 300, V: 600, Vp: 100, bid: "b2", seq: 1, T: 0, hPct: null, requestsAfter: 0, k: 0 },
        { at: T0 + 4, S: 400, sigma: 0, X: 100, V: 600, Vp: 100, bid: "b4", seq: 2, T: 0, hPct: null, requestsAfter: 0, k: null },
    ]);
});

test("the first new fold closes every legacy open record without replacing objects", () => {
    const session = createSession("legacy-open-folds");
    recordCacheFoldsFromBlocks(session, [block(1), block(2), block(3)]);
    const ledger = getCacheLedger(session);
    const folds = ledger.folds;
    const originals = [...folds];
    folds[0].k = null;
    folds[0].requestsAfter = 2.5;
    folds[1].k = 7;
    folds[1].requestsAfter = 9;
    folds[2].requestsAfter = 0.25;
    recordCacheFoldsFromBlocks(session, [block(4), block(5)]);
    assert.equal(ledger.folds, folds);
    originals.forEach((fold, i) => assert.equal(folds[i], fold));
    assert.deepEqual(folds.map((fold) => fold.k), [2.5, 7, 0.25, 0, null]);
    assert.deepEqual(folds.map((fold) => fold.requestsAfter), [2.5, 9, 0.25, 0, 0]);
});

test("duplicates and out-of-order block IDs keep the existing high-water behavior", () => {
    const session = createSession("mixed-fold-ids");
    recordCacheFoldsFromBlocks(session, [block(1), block(5), block(3), block(5), block(7), block(0)]);
    const ledger = getCacheLedger(session);
    assert.equal(ledger.lastBlockId, 7);
    assert.equal(ledger.foldSeqCounter, 3);
    assert.deepEqual(ledger.folds.map((fold) => [fold.bid, fold.seq, fold.k]), [["b1", 1, 0], ["b5", 2, 0], ["b7", 3, null]]);
});

test("batches and individual calls produce identical complete ledgers and reports across usage samples", () => {
    const batched = createSession("fold-comparison");
    const separate = createSession("fold-comparison");
    for (const session of [batched, separate]) recordCacheSample(session, { at: T0, input: 10_000, cached: 9_000 });
    for (const ids of [[1, 2, 3], [4, 5]]) {
        const blocks = ids.map((id) => block(id));
        for (const session of [batched, separate]) session.state.blocks.push(...blocks);
        recordCacheFoldsFromBlocks(batched, blocks, { V: 10_000, Vp: 8_000 });
        for (const item of blocks) recordCacheFoldsFromBlocks(separate, [item], { V: 10_000, Vp: 8_000 });
        for (const session of [batched, separate]) {
            recordCacheSample(session, { at: T0 + ids.at(-1)! + 0.1, input: 8_000, cached: 7_000 });
            recordCacheSample(session, { at: T0 + ids.at(-1)! + 0.2, input: 8_500, cached: 8_000 });
        }
    }
    assert.deepEqual(getCacheLedger(batched), getCacheLedger(separate));
    assert.deepEqual(buildSessionCacheReport(batched), buildSessionCacheReport(separate));
    assert.deepEqual(getCacheLedger(batched).folds.map((fold) => fold.k), [0, 0, 2, 0, null]);
});

test("an interrupted batch leaves its last successful fold open and retries without duplication", () => {
    const session = createSession("interrupted-fold-batch");
    recordCacheFoldsFromBlocks(session, [block(1)]);
    const ledger = getCacheLedger(session);
    ledger.folds[0].requestsAfter = 3;
    const failure = new Error("summary unavailable");
    const bad = block(3);
    Object.defineProperty(bad, "summary", { get: () => { throw failure; } });
    assert.throws(() => recordCacheFoldsFromBlocks(session, [block(2), bad, block(4)]), (error) => error === failure);
    assert.equal(ledger.lastBlockId, 2);
    assert.equal(ledger.foldSeqCounter, 2);
    assert.deepEqual(ledger.folds.map((fold) => fold.k), [3, null]);
    recordCacheFoldsFromBlocks(session, [block(2), block(3), block(4)]);
    assert.equal(ledger.lastBlockId, 4);
    assert.equal(ledger.foldSeqCounter, 4);
    assert.deepEqual(ledger.folds.map((fold) => fold.k), [3, 0, 0, null]);
});

test("the lazy plugin sample path keeps all newly discovered fold records", () => {
    const session = createSession("lazy-fold-batch");
    recordCacheSample(session, { at: T0, input: 10_000, cached: 9_000 });
    session.state.blocks.push(block(1), block(2), block(3));
    recordCacheSample(session, { at: T0 + 10, input: 8_000, cached: 7_000 });
    const ledger = getCacheLedger(session);
    assert.deepEqual(ledger.folds.map((fold) => [fold.bid, fold.k, fold.requestsAfter]), [["b1", 0, 1], ["b2", 0, 1], ["b3", null, 1]]);
    assert.equal(ledger.lastBlockId, 3);
    assert.equal(buildSessionCacheReport(session).totals.balanced, true);
});
