import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "acp-kernel";
import { applyCompressSettings, applyAdaptiveNudgeStep, mergeCompress, hasCompressSettings } from "../src/compress-settings.ts";
import { parseCompressSettings } from "../src/config.ts";
import {
    computeAdaptiveStep,
    ADAPTIVE_WINDOW,
    ADAPTIVE_MIN_SAMPLES,
    ADAPTIVE_PROPORTION,
    ADAPTIVE_DEFAULT_BASE,
    ADAPTIVE_DEFAULT_MIN,
    ADAPTIVE_DEFAULT_MAX,
} from "../src/nudge-adaptive.ts";

// #1997 throughput-adaptive nudge cadence. Pure/deterministic step computation
// + the config-overlay helper. No wall-clock, no network, no server — every
// case drives fixed input-size sequences so results are reproducible (§7.2).

const BOUNDS = { base: 50000, min: 10000, max: 200000 };

test("defaults are pinned (behavior contract)", () => {
    assert.equal(ADAPTIVE_DEFAULT_BASE, 50000);
    assert.equal(ADAPTIVE_DEFAULT_MIN, 10000);
    assert.equal(ADAPTIVE_DEFAULT_MAX, 200000);
    assert.equal(ADAPTIVE_PROPORTION, 1);
    assert.equal(ADAPTIVE_MIN_SAMPLES, 3);
    assert.ok(ADAPTIVE_WINDOW >= ADAPTIVE_MIN_SAMPLES);
});

test("fewer than MIN_SAMPLES -> clamped base (fresh session == static mode)", () => {
    assert.equal(computeAdaptiveStep([], BOUNDS), 50000);
    assert.equal(computeAdaptiveStep([100], BOUNDS), 50000);
    assert.equal(computeAdaptiveStep([100, 200], BOUNDS), 50000);
});

test("steady per-call growth -> S equals mean delta", () => {
    assert.equal(computeAdaptiveStep([100000, 150000, 200000], BOUNDS), 50000);
});

test("burst (large arrivals) -> S widens toward max", () => {
    assert.equal(computeAdaptiveStep([100000, 300000, 500000, 700000], BOUNDS), 200000);
});

test("quiet (small arrivals) -> S narrows toward min", () => {
    assert.equal(computeAdaptiveStep([100000, 105000, 110000, 115000], BOUNDS), 10000);
});

test("S is clamped to [min, max]", () => {
    assert.equal(computeAdaptiveStep([0, 1000000, 2000000], BOUNDS), 200000);
    assert.equal(computeAdaptiveStep([100000, 100001, 100002], BOUNDS), 10000);
});

test("custom bounds are honored", () => {
    assert.equal(computeAdaptiveStep([100000, 150000, 200000], { base: 50000, min: 20000, max: 100000 }), 50000);
    assert.equal(computeAdaptiveStep([100000, 300000, 500000, 700000], { base: 50000, min: 20000, max: 100000 }), 100000);
    // mean delta 500 < min 1000 -> clamped UP to the custom low floor (min is not hard-coded to 10000).
    assert.equal(computeAdaptiveStep([100000, 100500, 101000], { base: 50000, min: 1000, max: 200000 }), 1000);
});

test("non-finite / negative entries are ignored before windowing", () => {
    assert.equal(computeAdaptiveStep([Number.NaN, 100000, 150000, -5, 200000], BOUNDS), 50000);
    assert.equal(computeAdaptiveStep([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], BOUNDS), 50000);
});

test("only the most recent WINDOW samples count (early spike is forgotten)", () => {
    const nine = [0, 900000, 901000, 902000, 903000, 904000, 905000, 906000, 907000];
    assert.equal(nine.length, 9);
    assert.equal(nine.length, ADAPTIVE_WINDOW + 1);
    // slice(-8) drops the leading 0, so the 0->900000 spike never enters the mean.
    assert.equal(computeAdaptiveStep(nine, BOUNDS), 10000);
});

test("deterministic: identical history yields identical step", () => {
    const h = [100000, 250000, 260000, 400000, 405000];
    assert.equal(computeAdaptiveStep(h, BOUNDS), computeAdaptiveStep([...h], BOUNDS));
});

// --- applyAdaptiveNudgeStep: overlays the band onto an already-resolved config ---

function resolved(s = {}) {
    return applyCompressSettings(defaultConfig(200000), 200000, s);
}

test("off (nudgeAdaptive unset) -> returns the SAME config, untouched", () => {
    const cfg = resolved({ nudgeGrowthTokens: 150000 });
    const out = applyAdaptiveNudgeStep(cfg, [100000, 300000, 500000], {});
    assert.equal(out, cfg);
    assert.equal(cfg.nudge.growthFloor, 150000);
    assert.equal(cfg.nudge.growthCap, 150000);
});

test("on + empty history -> seeded band (clamped base)", () => {
    const out = applyAdaptiveNudgeStep(resolved(), [], { nudgeAdaptive: true });
    assert.equal(out.nudge.growthFloor, ADAPTIVE_DEFAULT_BASE);
    assert.equal(out.nudge.growthCap, ADAPTIVE_DEFAULT_BASE);
});

test("on + burst history -> wide band; overrides the static nudgeGrowthTokens", () => {
    const cfg = resolved({ nudgeGrowthTokens: 150000 });
    const out = applyAdaptiveNudgeStep(cfg, [100000, 300000, 500000, 700000], { nudgeAdaptive: true, nudgeGrowthTokens: 150000 });
    assert.equal(out.nudge.growthFloor, ADAPTIVE_DEFAULT_MAX);
    assert.equal(out.nudge.growthCap, ADAPTIVE_DEFAULT_MAX);
});

test("on + quiet history -> narrow band (lean folds during interaction)", () => {
    const out = applyAdaptiveNudgeStep(resolved(), [100000, 105000, 110000, 115000], { nudgeAdaptive: true });
    assert.equal(out.nudge.growthFloor, ADAPTIVE_DEFAULT_MIN);
    assert.equal(out.nudge.growthCap, ADAPTIVE_DEFAULT_MIN);
});

test("does not mutate the input config", () => {
    const cfg = resolved({ nudgeGrowthTokens: 150000 });
    const out = applyAdaptiveNudgeStep(cfg, [100000, 300000, 500000, 700000], { nudgeAdaptive: true });
    assert.notEqual(out, cfg);
    assert.equal(cfg.nudge.growthFloor, 150000);
    assert.equal(cfg.nudge.growthCap, 150000);
});

test("changes ONLY the nudge band; every other field is preserved (no collateral wire drift)", () => {
    const cfg = resolved({ nudgeGrowthTokens: 150000, emergencyThresholdPercent: 0.8, preserveRecentMessages: 12 });
    const out = applyAdaptiveNudgeStep(cfg, [100000, 300000, 500000, 700000], { nudgeAdaptive: true });
    assert.notDeepEqual(out.nudge, cfg.nudge);
    assert.equal(out.modelContextLimit, cfg.modelContextLimit);
    assert.equal(out.preserveRecentMessages, cfg.preserveRecentMessages);
    assert.deepEqual(out.truncate, cfg.truncate);
    assert.deepEqual(out.tiers, cfg.tiers);
});

test("mergeCompress: new fields merge per-field deepest-wins", () => {
    const merged = mergeCompress(
        { nudgeAdaptive: true, nudgeGrowthMin: 5000 },
        { nudgeGrowthMax: 120000 },
        {},
    );
    assert.equal(merged.nudgeAdaptive, true);
    assert.equal(merged.nudgeGrowthMin, 5000);
    assert.equal(merged.nudgeGrowthMax, 120000);
    const modelWins = mergeCompress({ nudgeAdaptive: false }, undefined, { nudgeAdaptive: true });
    assert.equal(modelWins.nudgeAdaptive, true);
});

test("hasCompressSettings: nudgeAdaptive counts as a set field (disables the base short-circuit)", () => {
    assert.equal(hasCompressSettings({ nudgeAdaptive: true }), true);
    assert.equal(hasCompressSettings({ nudgeGrowthMin: 1 }), true);
});

test("parseCompressSettings: accepts valid nudgeAdaptive/min/max", () => {
    const p = parseCompressSettings({ nudgeAdaptive: true, nudgeGrowthMin: 20000, nudgeGrowthMax: 120000 });
    assert.ok(p);
    assert.equal(p!.nudgeAdaptive, true);
    assert.equal(p!.nudgeGrowthMin, 20000);
    assert.equal(p!.nudgeGrowthMax, 120000);
});

test("parseCompressSettings: rejects non-boolean nudgeAdaptive / non-numeric bounds", () => {
    assert.equal(parseCompressSettings({ nudgeAdaptive: "yes" }), undefined);
    assert.equal(parseCompressSettings({ nudgeGrowthMin: "big" }), undefined);
    assert.equal(parseCompressSettings({ nudgeGrowthMax: null }), undefined);
});
