import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, defaultPrompts } from "acp-kernel";
import {
    mergeCompress,
    resolveCompress,
    applyCompressSettings,
    hasCompressSettings,
    resolveContextLimitValue,
    resolveCompressPrompts,
} from "../src/compress-settings.ts";
import { parseCompressSettings, parseRouteEntry, type ProviderRoutes } from "../src/config.ts";
import { resolveOutputHeadroomCap } from "../src/util.ts";

test("mergeCompress: model beats provider beats global, per field", () => {
    const merged = mergeCompress(
        { nudgeGrowthTokens: 50000, emergencyThresholdPercent: 0.8, preserveRecentMessages: 10 },
        { nudgeGrowthTokens: 70000, minCompressRange: 4000 },
        { nudgeGrowthTokens: 90000, emergencyThresholdPercent: 0.9 },
    );
    assert.equal(merged.nudgeGrowthTokens, 90000);
    assert.equal(merged.emergencyThresholdPercent, 0.9);
    assert.equal(merged.preserveRecentMessages, 10);
    assert.equal(merged.minCompressRangeChars, 4000);
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

test("resolveCompressPrompts: no prompts configured returns kernel defaults", () => {
    const p = resolveCompressPrompts({ nudgeGrowthTokens: 50000 });
    assert.equal(p, defaultPrompts);
});

test("resolveCompressPrompts: prompts ignored without acknowledgePromptsRisk", () => {
    const p = resolveCompressPrompts({ prompts: { compressPhilosophy: "CUSTOM" } });
    assert.equal(p, defaultPrompts);
    assert.notEqual(p.compressPhilosophy, "CUSTOM");
});

test("resolveCompressPrompts: acknowledgePromptsRisk applies string overrides", () => {
    const p = resolveCompressPrompts({
        prompts: { compressPhilosophy: "CUSTOM PHILOSOPHY", howToCompressRules: 42 as unknown as string },
        acknowledgePromptsRisk: true,
    });
    assert.equal(p.compressPhilosophy, "CUSTOM PHILOSOPHY");
    // Non-string override silently dropped (kernel resolvePrompts), never clobbers a default.
    assert.equal(p.howToCompressRules, defaultPrompts.howToCompressRules);
    assert.equal(p.tier2DistillRules, defaultPrompts.tier2DistillRules);
});

test("mergeCompress: prompts + acknowledgePromptsRisk deepest-wins per field", () => {
    const merged = mergeCompress(
        { prompts: { compressPhilosophy: "GLOBAL" }, acknowledgePromptsRisk: true },
        { prompts: { howToCompressRules: "PROVIDER" } },
        { prompts: { compressPhilosophy: "MODEL" } },
    );
    assert.deepEqual(merged.prompts, { compressPhilosophy: "MODEL", howToCompressRules: "PROVIDER" });
    // Risk flag from the global level survives when deeper levels don't set it.
    assert.equal(merged.acknowledgePromptsRisk, true);
});

test("resolveCompress: prompts cascade end-to-end via provider routes", () => {
    const routes: ProviderRoutes = {
        "https://api.example.com": parseRouteEntry({
            compress: { prompts: { compressPhilosophy: "PROVIDER" } },
            models: { "m": { context: 128000, compress: { prompts: { howToCompressRules: "MODEL RULES" }, acknowledgePromptsRisk: true } } },
        })!,
    };
    const merged = resolveCompress(routes, "https://api.example.com", "m");
    const p = resolveCompressPrompts(merged);
    assert.equal(p.compressPhilosophy, "PROVIDER");
    assert.equal(p.howToCompressRules, "MODEL RULES");
});

test("mergeCompress: stripImages + stripImagesKeepRecent cascade deepest-wins per field", () => {
    const merged = mergeCompress(
        { stripImages: true, stripImagesKeepRecent: 5 },
        { stripImagesKeepRecent: 3 },
        { stripImagesKeepRecent: 1 },
    );
    assert.equal(merged.stripImages, true);
    assert.equal(merged.stripImagesKeepRecent, 1);
});

test("parseCompressSettings: parses stripImages (bool) + stripImagesKeepRecent (number)", () => {
    const ok = parseCompressSettings({ stripImages: true, stripImagesKeepRecent: 7 });
    assert.equal(ok?.stripImages, true);
    assert.equal(ok?.stripImagesKeepRecent, 7);
    // Absent keys stay undefined (no default injected at parse time).
    assert.equal(parseCompressSettings({})?.stripImages, undefined);
    // Malformed types are rejected (whole object discarded).
    assert.equal(parseCompressSettings({ stripImages: "yes" }), undefined);
    assert.equal(parseCompressSettings({ stripImagesKeepRecent: "many" }), undefined);
});

test("mergeCompress: outputHeadroomMaxPct cascades deepest-wins per field (#896)", () => {
    const merged = mergeCompress(
        { outputHeadroomMaxPct: 1 },
        { outputHeadroomMaxPct: "50%" },
        { outputHeadroomMaxPct: 0.25 },
    );
    assert.equal(merged.outputHeadroomMaxPct, 0.25);
    // Absent at a deeper level does not clear a shallower value.
    assert.equal(mergeCompress({ outputHeadroomMaxPct: 0.25 }, undefined, undefined).outputHeadroomMaxPct, 0.25);
    assert.equal(mergeCompress(undefined, { outputHeadroomMaxPct: "50%" }, { nudgeGrowthTokens: 90000 }).outputHeadroomMaxPct, "50%");
});

test("resolveCompress: outputHeadroomMaxPct resolves global → provider → model end-to-end (#896)", () => {
    const routes: ProviderRoutes = {
        "https://api.example.com": {
            compress: { outputHeadroomMaxPct: 0.5 },
            models: { "big-model": { compress: { outputHeadroomMaxPct: "25%" } } },
        },
    };
    assert.equal(resolveCompress(routes, "https://api.example.com/chat", "big-model", { outputHeadroomMaxPct: 1 }).outputHeadroomMaxPct, "25%");
    assert.equal(resolveCompress(routes, "https://api.example.com/chat", "other-model", { outputHeadroomMaxPct: 1 }).outputHeadroomMaxPct, 0.5);
    assert.equal(resolveCompress(routes, "https://other.com/chat", "big-model", { outputHeadroomMaxPct: 1 }).outputHeadroomMaxPct, 1);
});

test("resolveOutputHeadroomCap: unset → 0.25 default; ratio / percent-string pass through (#896)", () => {
    assert.equal(resolveOutputHeadroomCap(undefined), 0.25);
    assert.equal(resolveOutputHeadroomCap(0.25), 0.25);
    assert.equal(resolveOutputHeadroomCap("25%"), 0.25);
    assert.equal(resolveOutputHeadroomCap("0%"), 0);
    assert.equal(resolveOutputHeadroomCap(1), 1);
    assert.equal(Number.isFinite(resolveOutputHeadroomCap("abc")), false, "unparseable → NaN (reserveOutputHeadroom falls back to legacy)");
});

test("parseCompressSettings: parses outputHeadroomMaxPct, rejects negative / malformed (#896)", () => {
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: 0.25 })?.outputHeadroomMaxPct, 0.25);
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: 0 })?.outputHeadroomMaxPct, 0);
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: 1 })?.outputHeadroomMaxPct, 1);
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: 1.5 })?.outputHeadroomMaxPct, 1.5, ">= 1 = legacy full-capability reservation");
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: "25%" })?.outputHeadroomMaxPct, "25%");
    // Absent key stays undefined — no default injected at parse time.
    assert.equal(parseCompressSettings({})?.outputHeadroomMaxPct, undefined);
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: -0.25 }), undefined);
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: "abc" }), undefined);
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: Number.NaN }), undefined);
    assert.equal(parseCompressSettings({ outputHeadroomMaxPct: null }), undefined);
});

test("mergeCompress: reasoningGuard merges sub-field-wise deepest-wins (#739)", () => {
    const merged = mergeCompress(
        { reasoningGuard: { enabled: true, maxContinue: 3, base: 518 } },
        { reasoningGuard: { offset: -4, maxContinue: 2 } },
        { reasoningGuard: { maxTierN: 4 } },
    );
    assert.equal(merged.reasoningGuard?.enabled, true);
    assert.equal(merged.reasoningGuard?.maxContinue, 2);
    assert.equal(merged.reasoningGuard?.maxTierN, 4);
    assert.equal(merged.reasoningGuard?.base, 518);
    assert.equal(merged.reasoningGuard?.offset, -4);
});

test("mergeCompress: reasoningGuard absent at all levels stays undefined", () => {
    const merged = mergeCompress({ nudgeGrowthTokens: 50000 }, { tiers: false }, undefined);
    assert.equal(merged.reasoningGuard, undefined);
});

test("parseCompressSettings: parses reasoningGuard sub-fields and rejects malformed (#739)", () => {
    const ok = parseCompressSettings({
        reasoningGuard: { enabled: true, maxContinue: 3, maxTierN: 6, markerText: " go ", base: 518, offset: -2, debugLog: true },
    });
    assert.equal(ok?.reasoningGuard?.enabled, true);
    assert.equal(ok?.reasoningGuard?.maxContinue, 3);
    assert.equal(ok?.reasoningGuard?.maxTierN, 6);
    assert.equal(ok?.reasoningGuard?.markerText, "go");
    assert.equal(ok?.reasoningGuard?.base, 518);
    assert.equal(ok?.reasoningGuard?.offset, -2);
    assert.equal(ok?.reasoningGuard?.debugLog, true);
    assert.equal(parseCompressSettings({})?.reasoningGuard, undefined);
    assert.equal(parseCompressSettings({ reasoningGuard: { enabled: "yes" } }), undefined);
    assert.equal(parseCompressSettings({ reasoningGuard: { enabled: true, models: ["gpt-5"] } })?.reasoningGuard?.enabled, true);
    assert.equal(parseCompressSettings({ reasoningGuard: { base: "518" } }), undefined);
    assert.equal(parseCompressSettings({ reasoningGuard: [] }), undefined);
});

// — #1425: proxy-lane CCR default-on arming gate (unit pin of resolveCcrArming) —

test("resolveCcrArming: #1425 proxy-lane default-on semantics", async () => {
    const { resolveCcrArming } = await import("../src/compress-settings.ts");
    // unset → armed with the explicit default-on block
    assert.deepEqual(resolveCcrArming(undefined), { enabled: true });
    // explicit false at any merge level → disarmed (undefined = no arming stamp)
    assert.equal(resolveCcrArming({ enabled: false }), undefined);
    assert.equal(resolveCcrArming({ enabled: false, minToolTokens: 50 }), undefined);
    // explicit true passes through untouched
    assert.deepEqual(resolveCcrArming({ enabled: true, minToolTokens: 50 }), { enabled: true, minToolTokens: 50 });
    // partial block (no enabled) → armed, other fields preserved (store.effectiveCcr
    // requires an explicit boolean; a partial block must not be silently dropped)
    assert.deepEqual(resolveCcrArming({ minToolTokens: 100 }), { minToolTokens: 100, enabled: true });
});
