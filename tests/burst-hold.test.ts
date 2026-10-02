import test from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import {
    DEFAULT_BURST_HOLD,
    burstHoldCeiling,
    detectToolBurst,
    holdGrowthNudge,
} from "../src/burst-hold.ts";
import { mergeCompress } from "../src/compress-settings.ts";
import { parseCompressSettings } from "../src/config.ts";

// t = user text, c = assistant tool-call, r = tool result ("read" style)
function hist(pattern: string): CoreMessage[] {
    return [...pattern].map((k, i) => {
        if (k === "t") return { id: `m${i}`, role: "user" as const, contentType: "text" as const, text: `x${i}` };
        if (k === "c") return { id: `m${i}`, role: "assistant" as const, contentType: "tool-call" as const, toolName: "read" };
        return { id: `m${i}`, role: "tool" as const, contentType: "tool-result" as const, text: `r${i}` };
    });
}

const STEADY = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? "c" : "r")).join("");
const BATCH = "ttcc" + "r".repeat(10);

test("defaults match the #1487 calibration", () => {
    assert.deepEqual(DEFAULT_BURST_HOLD, { enabled: true, minToolResults: 5, lookbackMessages: 12, minToolShare: 0.55 });
});

test("steady assistant/tool alternation does NOT trip (share 0.5 < 0.55)", () => {
    const det = detectToolBurst(hist(STEADY));
    assert.equal(det.toolResults, 6);
    assert.equal(det.windowSize, 12);
    assert.ok(Math.abs(det.share - 0.5) < 1e-9);
    assert.equal(det.active, false);
});

test("trailing parallel batch trips (10/12 results)", () => {
    const det = detectToolBurst(hist(BATCH));
    assert.equal(det.toolResults, 10);
    assert.equal(det.windowSize, 12);
    assert.ok(det.share > 0.8);
    assert.equal(det.active, true);
});

test("high share but fewer than minToolResults does not trip", () => {
    const det = detectToolBurst(hist("rrrr"));
    assert.equal(det.toolResults, 4);
    assert.equal(det.share, 1);
    assert.equal(det.active, false);
});

test("empty history is inert", () => {
    assert.deepEqual(detectToolBurst([]), { active: false, toolResults: 0, windowSize: 0, share: 0 });
});

test("enabled:false is fully off, even mid-batch", () => {
    assert.deepEqual(detectToolBurst(hist(BATCH), { enabled: false }), { active: false, toolResults: 0, windowSize: 0, share: 0 });
});

test("custom thresholds relax the gate", () => {
    const det = detectToolBurst(hist(STEADY), { minToolResults: 3, minToolShare: 0.4 });
    assert.equal(det.active, true);
});

test("lookback window only inspects the trailing slice", () => {
    const det = detectToolBurst(hist(BATCH), { lookbackMessages: 10 });
    assert.equal(det.windowSize, 10);
    assert.equal(det.toolResults, 10);
    assert.equal(det.active, true);
});

test("ceiling is min(0.7, effective maxContextLimitPct)", () => {
    assert.equal(burstHoldCeiling(), 0.7);
    assert.equal(burstHoldCeiling(0.9), 0.7);
    assert.equal(burstHoldCeiling(0.6), 0.6);
    assert.equal(burstHoldCeiling(0), 0.7);
    assert.equal(burstHoldCeiling(Number.NaN), 0.7);
});

test("hold fires only for growth nudges below the ceiling", () => {
    const burst = detectToolBurst(hist(BATCH));
    assert.equal(holdGrowthNudge(burst, 0.5), true);
    assert.equal(holdGrowthNudge(burst, 0.7), false);
    assert.equal(holdGrowthNudge(burst, 0.8), false);
    assert.equal(holdGrowthNudge(burst, Number.NaN), false);
    const steady = detectToolBurst(hist(STEADY));
    assert.equal(holdGrowthNudge(steady, 0.1), false);
});

test("a lower configured pressure line lowers the hold ceiling", () => {
    const burst = detectToolBurst(hist(BATCH));
    assert.equal(holdGrowthNudge(burst, 0.5, 0.6), true);
    assert.equal(holdGrowthNudge(burst, 0.65, 0.6), false);
});

test("mergeCompress merges burstHold sub-field-wise across levels", () => {
    const merged = mergeCompress(
        { burstHold: { enabled: true, minToolShare: 0.5 } },
        undefined,
        { burstHold: { minToolShare: 0.8 } },
    );
    assert.deepEqual(merged.burstHold, { enabled: true, minToolShare: 0.8 });
    assert.equal(mergeCompress(undefined, undefined, undefined).burstHold, undefined);
});

test("parseCompressSettings accepts a valid burstHold block", () => {
    const parsed = parseCompressSettings({ burstHold: { enabled: false, minToolResults: 3, lookbackMessages: 8, minToolShare: 0.9 } });
    assert.deepEqual(parsed?.burstHold, { enabled: false, minToolResults: 3, lookbackMessages: 8, minToolShare: 0.9 });
});

test("parseCompressSettings rejects malformed burstHold values loudly", () => {
    for (const bad of [
        { burstHold: { enabled: "yes" } },
        { burstHold: { minToolShare: 1.5 } },
        { burstHold: { minToolShare: 0 } },
        { burstHold: { minToolResults: 2.5 } },
        { burstHold: { lookbackMessages: 0 } },
        { burstHold: [] },
    ]) {
        assert.equal(parseCompressSettings(bad), undefined, JSON.stringify(bad));
    }
});
