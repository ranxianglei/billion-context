import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

// #2558: the output-budget clamp double-counted image tokens. clampOutgoingOutput
// computed inputEstimate = estimateInputTokens(...) + imageTokens, and
// estimateInputTokens returns max(baseline, est). The usage-grade baseline is the
// provider-reported input total, which ALREADY bills those same images (#488) — so
// when the baseline won the max(), every image was charged twice. On a long
// multimodal session the phantom reserve grew with accumulated images (the report:
// input~ 222k–226k against a true usage of 165k), starving the output budget
// (40000 -> as low as 2011 across 590 clamps in an 1849-turn session; zeroing the
// reserve made all 590 clamps disappear).
//
// The preflight trigger and the outbound metering both price the payload
// max(baseline, est + reserve) — only the clamp deviated. Fix: move the image
// reserve onto the local-est arm inside estimateInputTokens, so a usage-grade
// baseline is never re-charged and the est arm (text-only estimateCoreMessages)
 // still carries its images (#488 overflow guarantee preserved).
//
// Signature note (#2391 rebase): estimateInputTokens takes loadedToolTokens as
// its 9th positional param and imageTokens as 10th. The direct calls below pass
// an explicit 0 for the tool slot so the reserve lands on the IMAGE param —
// pre-#2391 the reserve was the 9th arg, and a naive rebase would silently test
// the wrong parameter (still green under identity calibration).

import { clampOutputBudget, clampOutgoingOutput, estimateInputTokens } from "../src/server/budget.ts";
import { readOutputBudget } from "../src/server/side-request.ts";

test("#2558: usage-grade baseline already bills images — the reserve is not added twice", () => {
    // Empty payload: the local est arm is ~0 overhead; add a 30k image reserve.
    const withReserve = estimateInputTokens([], "", [], 100_000, "usage", undefined, undefined, undefined, undefined, 30_000);
    // The 100k usage baseline already includes those images: result == baseline.
    assert.equal(withReserve, 100_000);
    // Regression anchor: the pre-#2558 call site computed max(baseline, est)+reserve.
    const oldCallSite = Math.max(100_000, 0) + 30_000;
    assert.notEqual(withReserve, oldCallSite, "no longer baseline + reserve");
});

test("#2558: the local-est arm STILL carries the image reserve when it outgrows the baseline", () => {
    // A large system prompt makes the local est dominate a small stale baseline, so
    // the est arm wins the max(). Images must be added there or the cap goes too
    // generous (#488: input+output could overflow again).
    const sys = "x".repeat(400_000); // ~100k tokens of system overhead
    const base = estimateInputTokens([], sys, [], 10_000, "usage");
    assert.ok(base > 10_000, "est arm wins over the small baseline");
    const withReserve = estimateInputTokens([], sys, [], 10_000, "usage", undefined, undefined, undefined, undefined, 5_000);
    assert.equal(withReserve, base + 5_000, "reserve rides on the est arm, not dropped");
});

test("#2558: absent source / zero baseline behaves exactly as before (reserve unchanged)", () => {
    const sys = "x".repeat(40_000);
    const noSource = estimateInputTokens([], sys, [], 0);
    const noSourceWithReserve = estimateInputTokens([], sys, [], 0, undefined, undefined, undefined, undefined, 0, 7_000);
    assert.equal(noSourceWithReserve, noSource + 7_000, "est-only path still adds the reserve");
});

test("#2558: accumulated images no longer starve the output clamp (reported repro)", () => {
    // Reported shape: window 240k, requested output 40k, upstream usage 165051 (a
    // usage-grade baseline that already bills the payload's images), images
    // accumulating 56.8k -> 75.9k over an 1849-turn session. Pre-fix every one of
    // these clamped (worst 40000 -> 2011); post-fix none do.
    const window = 240_000;
    const requested = 40_000;
    const usage = 165_051;
    for (const imageTokens of [56_800, 61_600, 75_900]) {
        const rebuilt: Record<string, unknown> = { model: "m", max_tokens: requested };
        clampOutgoingOutput(rebuilt, "max_tokens", {
            systemText: "", tools: [], processedMessages: [],
            lastInputTokens: usage, lastInputTokensSource: "usage",
            nativeWindow: window, imageTokens,
        }, "sess", () => {});
        assert.equal(readOutputBudget(rebuilt, "max_tokens"), requested,
            `imageTokens=${imageTokens}: budget must stay ${requested} (no double-counted clamp)`);
    }
});

test("#2558: the pre-fix formula DID clamp the same inputs (regression teeth)", () => {
    // Reproduce the old inputEstimate = max(baseline, est) + reserve to prove the
    // scenario genuinely overflowed the output budget before the fix.
    const window = 240_000, requested = 40_000, usage = 165_051, imageTokens = 61_600;
    const oldInputEstimate = Math.max(usage, 0) + imageTokens; // 226_651, matches the report's input~226655
    const capped = clampOutputBudget(requested, oldInputEstimate, window);
    assert.ok(capped !== undefined && capped < requested, `old formula clamps (${capped} < ${requested})`);
    // margin = ceil(226651*0.05)=11333; naive cap = floor(240000-226651-11333)=2016.
    // #3071 floors the emitted budget at min(4096, headroom 13349) = 4096 — the tooth
    // still bites (the double-counted estimate still starves the clamp), just no
    // longer below the 4096 capability minimum.
    assert.equal(capped, 4_096);
});
