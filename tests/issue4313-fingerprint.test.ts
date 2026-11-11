/**
 * #4313: the compress-receipt fingerprint line carries the covered time
 * range when — and ONLY when — every covered message carries a persisted
 * first-sight stamp. Assertions are exact-string: the line is a pure
 * function of (block, state) with no wall clock, so two calls on the same
 * input must be byte-identical (prefix-cache discipline).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTagTime, type CompressionBlock, type CompressionState } from "acp-kernel";
import { summaryFingerprintLine, blockCoverageTimes } from "../src/stream.ts";

const T0 = 1760000000000; // fixed epochs; local formatting is delegated to formatTagTime
const T1 = 1760009999000;

function stubBlock(ids: string[]): CompressionBlock {
    return {
        blockId: "b1",
        runId: "r",
        tier: 1,
        summary: "S",
        directMessageIds: ids,
        effectiveMessageIds: ids,
        directBlockIds: [],
        compressedTokens: 10,
        createdAt: T0,
        survivedCount: 0,
        generation: "young",
        active: true,
        startRef: "m00002",
        endRef: "m00005",
    } as unknown as CompressionBlock;
}

function stubState(stamps?: Record<string, number>): CompressionState {
    return { messageRefs: { byRaw: {}, byRef: {} }, tsStamps: stamps } as unknown as CompressionState;
}

test("summaryFingerprintLine: pre-feature bytes without a range", () => {
    assert.equal(summaryFingerprintLine("b1", "S"), ' · b1 full summary 1ch · head "S" … tail "S"');
    // explicit null behaves like absent (same pre-feature shape)
    assert.equal(summaryFingerprintLine("b1", "S", null), ' · b1 full summary 1ch · head "S" … tail "S"');
});

test("summaryFingerprintLine: appends the local-time span; pure and byte-stable across calls", () => {
    const expected = ` · b1 full summary 1ch [${formatTagTime(T0)} – ${formatTagTime(T1)}] · head "S" … tail "S"`;
    const a = summaryFingerprintLine("b1", "S", { startTs: T0, endTs: T1 });
    const b = summaryFingerprintLine("b1", "S", { startTs: T0, endTs: T1 });
    assert.equal(a, expected, "appends ' [<local start> – <local end>]' after the fingerprint");
    assert.equal(a, b, "no wall-clock read: identical input ⇒ identical bytes");
});

test("blockCoverageTimes: min/max over stamped effective ids", () => {
    const state = stubState({ idA: T1, idB: T0 });
    assert.deepEqual(blockCoverageTimes(stubBlock(["idA", "idB"]), state), { startTs: T0, endTs: T1 });
});

test("blockCoverageTimes: null when any covered id has no stamp (never invent a range)", () => {
    const block = stubBlock(["idA", "idB"]);
    assert.equal(blockCoverageTimes(block, stubState({ idA: T0 })), null);
    assert.equal(blockCoverageTimes(block, stubState(undefined)), null);
});
