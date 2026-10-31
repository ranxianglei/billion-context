import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig, type NudgeDecision } from "acp-kernel";
import { mergeCompress, applyCompressSettings, resolveRequestConfig } from "../src/compress-settings.ts";
import { resolveNudgeEscalationPct, emergencyNudge } from "../src/server/budget.ts";

// #5232: the host-side escalation-nudge line (EMERGENCY_NUDGE_ESCALATION_PCT,
// hardcoded at 0.7) had no config surface. compress.nudgeEscalationPct adds one:
// deepest-wins across global/provider/model, rides the ResolvedKernelConfig rail
// to the prepare call sites, and an absent/non-positive value keeps the 0.7
// default byte-for-byte (behavior unchanged unless a level opts in).

function mkNudge(contextUsage: number): NudgeDecision {
    const breakdown = { usage: 0, growth: 0, growthReference: 0, effectiveThreshold: 0, nudgeGrowthTokens: 0, growthFloor: 0, hasPendingNudge: 0, overLimit: 0, emergencyOverride: 0, pendingT1: 0, pendingT2: 0, pendingT3: 0, maxPending: 0 };
    return {
        shouldInject: false,
        reason: "test",
        contextUsage,
        tier: null,
        compressibleRanges: [{ startRef: "a", endRef: "b", count: 1, tokens: 4000, toolPct: 0, textPct: 1 }],
        breakdown,
    };
}

test("#5232: resolveNudgeEscalationPct defaults to 0.7 when absent or invalid", () => {
    assert.equal(resolveNudgeEscalationPct(undefined), 0.7);
    assert.equal(resolveNudgeEscalationPct(null), 0.7);
    assert.equal(resolveNudgeEscalationPct({}), 0.7);
    assert.equal(resolveNudgeEscalationPct({ nudgeEscalationPct: undefined }), 0.7);
    assert.equal(resolveNudgeEscalationPct({ nudgeEscalationPct: 0 }), 0.7, "non-positive falls back");
    assert.equal(resolveNudgeEscalationPct({ nudgeEscalationPct: -0.5 }), 0.7, "negative falls back");
    assert.equal(resolveNudgeEscalationPct({ nudgeEscalationPct: Number.NaN }), 0.7, "NaN falls back");
    assert.equal(resolveNudgeEscalationPct({ nudgeEscalationPct: "0.85" }), 0.7, "non-number falls back (percent parsing happens upstream)");
});

test("#5232: resolveNudgeEscalationPct honors an explicit positive value", () => {
    assert.equal(resolveNudgeEscalationPct({ nudgeEscalationPct: 0.85 }), 0.85);
    assert.equal(resolveNudgeEscalationPct({ nudgeEscalationPct: 0.99 }), 0.99);
});

test("#5232: applyCompressSettings maps nudgeEscalationPct onto the resolved config", () => {
    const base = defaultConfig(200_000);
    assert.equal(applyCompressSettings(base, 200_000, { nudgeEscalationPct: 0.85 }).nudgeEscalationPct, 0.85);
    assert.equal(applyCompressSettings(base, 200_000, { nudgeEscalationPct: "75%" }).nudgeEscalationPct, 0.75, "percent string parses");
    assert.equal(applyCompressSettings(base, 200_000, {}).nudgeEscalationPct, undefined, "unset leaves it absent -> budget default");
});

test("#5232: mergeCompress deepest-wins for nudgeEscalationPct", () => {
    assert.equal(mergeCompress({ nudgeEscalationPct: 0.6 }, { nudgeEscalationPct: 0.7 }, { nudgeEscalationPct: 0.85 }).nudgeEscalationPct, 0.85);
    assert.equal(mergeCompress({ nudgeEscalationPct: 0.6 }, { nudgeEscalationPct: 0.7 }, {}).nudgeEscalationPct, 0.7);
    assert.equal(mergeCompress({ nudgeEscalationPct: 0.6 }, {}, {}).nudgeEscalationPct, 0.6);
});

test("#5232: resolveRequestConfig carries nudgeEscalationPct onto the resolved rail", () => {
    const base = defaultConfig(200_000);
    const tuned = resolveRequestConfig(base, {}, undefined, "m", 200_000, { nudgeEscalationPct: 0.8 });
    assert.equal(tuned.nudgeEscalationPct, 0.8);
    assert.equal(resolveNudgeEscalationPct(tuned), 0.8);
    const plain = resolveRequestConfig(base, {}, undefined, "m", 200_000, {});
    assert.equal(resolveNudgeEscalationPct(plain), 0.7, "unset everywhere -> base unchanged -> default 0.7");
});

test("#5232: the knob moves the fire line (user scenario: default 0.7 vs raised 0.85)", () => {
    const base = defaultConfig(200_000);
    const defaultLine = resolveNudgeEscalationPct(base);
    const raisedLine = resolveNudgeEscalationPct(applyCompressSettings(base, 200_000, { nudgeEscalationPct: 0.85 }));
    assert.equal(defaultLine, 0.7);
    assert.equal(raisedLine, 0.85);
    const nudge = mkNudge(0.75);
    assert.equal(emergencyNudge(nudge, defaultLine), true, "0.75 >= 0.7 default fires");
    assert.equal(emergencyNudge(nudge, raisedLine), false, "0.75 < 0.85 raised stays silent");
    assert.equal(emergencyNudge(mkNudge(0.9), raisedLine), true, "0.9 >= 0.85 raised fires");
});
