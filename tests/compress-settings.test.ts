import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "acp-kernel";
import {
    mergeCompress,
    resolveCompress,
    applyCompressSettings,
    hasCompressSettings,
    resolveContextLimitValue,
} from "../src/compress-settings.ts";
import { parseRouteEntry, type ProviderRoutes } from "../src/config.ts";

test("mergeCompress: model beats provider beats global, per field", () => {
    const merged = mergeCompress(
        { nudgeGrowthTokens: 50000, emergencyThresholdPercent: 0.8, preserveRecentMessages: 10 },
        { nudgeGrowthTokens: 70000, minCompressRange: 4000 },
        { nudgeGrowthTokens: 90000, emergencyThresholdPercent: 0.9 },
    );
    assert.equal(merged.nudgeGrowthTokens, 90000);
    assert.equal(merged.emergencyThresholdPercent, 0.9);
    assert.equal(merged.preserveRecentMessages, 10);
    assert.equal(merged.minCompressRange, 4000);
});

test("mergeCompress: undefined at deeper level does not clear shallower value", () => {
    const merged = mergeCompress({ nudgeGrowthTokens: 50000 }, undefined, { emergencyThresholdPercent: 0.85 });
    assert.equal(merged.nudgeGrowthTokens, 50000);
    assert.equal(merged.emergencyThresholdPercent, 0.85);
    assert.equal(merged.preserveRecentMessages, undefined);
});

test("mergeCompress: all undefined yields all-undefined settings", () => {
    const merged = mergeCompress(undefined, undefined, undefined);
    assert.equal(hasCompressSettings(merged), false);
});

test("hasCompressSettings: true when any field set", () => {
    assert.equal(hasCompressSettings({}), false);
    assert.equal(hasCompressSettings({ nudgeGrowthTokens: 50000 }), true);
});

test("resolveCompress: deepest matching URL key wins; model compress on a shallower key does NOT apply", () => {
    const routes: ProviderRoutes = {
        "https://api.example.com": {
            models: { "big-model": { compress: { nudgeGrowthTokens: 90000, emergencyThresholdPercent: 0.85 } } },
        },
        "https://api.example.com/v1": {
            compress: { tiers: false },
        },
    };
    const merged = resolveCompress(routes, "https://api.example.com/v1/chat", "big-model", { nudgeGrowthTokens: 50000 });
    assert.equal(merged.tiers, false);
    assert.equal(merged.nudgeGrowthTokens, 50000);
    assert.equal(merged.emergencyThresholdPercent, undefined);
});

test("resolveCompress: model compress overrides provider compress on the same route", () => {
    const routes: ProviderRoutes = {
        "https://api.example.com": {
            compress: { nudgeGrowthTokens: 60000, preserveRecentMessages: 8 },
            models: { "big-model": { compress: { nudgeGrowthTokens: 90000, emergencyThresholdPercent: 0.85 } } },
        },
    };
    const merged = resolveCompress(routes, "https://api.example.com/chat", "big-model", undefined);
    assert.equal(merged.nudgeGrowthTokens, 90000);
    assert.equal(merged.emergencyThresholdPercent, 0.85);
    assert.equal(merged.preserveRecentMessages, 8);
});

test("resolveCompress: shallow key applies when no deeper key matches", () => {
    const routes: ProviderRoutes = {
        "https://api.example.com": {
            compress: { nudgeGrowthTokens: 60000 },
        },
    };
    const merged = resolveCompress(routes, "https://api.example.com/chat", "any-model", undefined);
    assert.equal(merged.nudgeGrowthTokens, 60000);
});

test("resolveCompress: returns empty when URL unknown", () => {
    const routes: ProviderRoutes = { "https://other.com": { compress: { nudgeGrowthTokens: 60000 } } };
    const merged = resolveCompress(routes, "https://api.example.com/chat", "m", undefined);
    assert.equal(hasCompressSettings(merged), false);
});

test("applyCompressSettings: nudgeGrowthTokens flattens growthFloor and growthCap", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200000, { nudgeGrowthTokens: 50000 });
    assert.equal(out.nudge.growthFloor, 50000);
    assert.equal(out.nudge.growthCap, 50000);
});

test("applyCompressSettings: emergencyThresholdPercent maps to emergencyThresholdPct", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200000, { emergencyThresholdPercent: 0.85 });
    assert.equal(out.nudge.emergencyThresholdPct, 0.85);
    assert.equal(out.truncate.threshold, 0.85);
});

test("applyCompressSettings: maxContextLimit maps to maxContextLimitPct", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200000, { maxContextLimit: "80%" });
    assert.equal(out.nudge.maxContextLimitPct, 0.8);
});

test("applyCompressSettings: emergencyThresholdPercent accepts percent string", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200000, { emergencyThresholdPercent: "90%" });
    assert.equal(out.nudge.emergencyThresholdPct, 0.9);
    assert.equal(out.truncate.threshold, 0.9);
});

test("applyCompressSettings: tiers.enabled mapping", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200000, { tiers: false });
    assert.equal(out.tiers.enabled, false);
});

test("applyCompressSettings: preserveRecent + minCompressRange + modelContextLimit", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 500000, {
        preserveRecentMessages: 7,
        preserveRecentTokens: 30000,
        minCompressRange: 4000,
    });
    assert.equal(out.preserveRecentMessages, 7);
    assert.equal(out.preserveRecentTokens, 30000);
    assert.equal(out.compress.minCompressRange, 4000);
    assert.equal(out.modelContextLimit, 500000);
});

test("applyCompressSettings: does not mutate the base config", () => {
    const base = defaultConfig(200000);
    const originalFloor = base.nudge.growthFloor;
    applyCompressSettings(base, 200000, { nudgeGrowthTokens: 99999 });
    assert.equal(base.nudge.growthFloor, originalFloor);
});

test("applyCompressSettings: unset fields inherit the base value", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200000, { nudgeGrowthTokens: 50000 });
    assert.equal(out.preserveRecentMessages, base.preserveRecentMessages);
    assert.equal(out.tiers.enabled, base.tiers.enabled);
});

test("applyCompressSettings: nudgeGrowthTokens <= 0 is ignored (keeps base band)", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200000, { nudgeGrowthTokens: 0 });
    assert.equal(out.nudge.growthFloor, base.nudge.growthFloor);
    assert.equal(out.nudge.growthCap, base.nudge.growthCap);
});

test("resolveContextLimitValue: absolute number used as-is", () => {
    assert.equal(resolveContextLimitValue(200000, 1000000), 200000);
    assert.equal(resolveContextLimitValue(1, 1000000), 1);
});

test("resolveContextLimitValue: percentage string is a fraction of native", () => {
    assert.equal(resolveContextLimitValue("70%", 200000), 140000);
    assert.equal(resolveContextLimitValue("50%", 200000), 100000);
    assert.equal(resolveContextLimitValue("100%", 128000), 128000);
    assert.equal(resolveContextLimitValue("12.5%", 200000), 25000);
});

test("resolveContextLimitValue: undefined falls back to the native window", () => {
    assert.equal(resolveContextLimitValue(undefined, 200000), 200000);
    assert.equal(resolveContextLimitValue(undefined, 1000000), 1000000);
});

test("resolveContextLimitValue: bare numeric string treated as absolute", () => {
    assert.equal(resolveContextLimitValue("300000", 1000000), 300000);
});

test("resolveContextLimitValue: percentage floor is always an integer >= 1", () => {
    assert.equal(resolveContextLimitValue("0.0001%", 200000), 1);
});

test("parseRouteEntry: preserves provider-level and model-level compress", () => {
    const route = parseRouteEntry({
        compress: { nudgeGrowthTokens: 60000 },
        models: { "big-model": { context: 200000, compress: { nudgeGrowthTokens: 90000 } } },
    });
    assert.equal(route?.compress?.nudgeGrowthTokens, 60000);
    assert.equal(route?.models?.["big-model"]?.compress?.nudgeGrowthTokens, 90000);
    assert.equal(route?.models?.["big-model"]?.context, 200000);
});

test("parseRouteEntry: no compress leaves the field absent", () => {
    const route = parseRouteEntry({ models: { "m": { context: 128000 } } });
    assert.equal(route?.compress, undefined);
});
