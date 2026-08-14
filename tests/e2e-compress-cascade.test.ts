import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "acp-kernel";
import { resolveRequestConfig } from "../src/compress-settings.ts";
import type { CompressSettings, ProviderRoutes } from "../src/config.ts";

// E2E for the proxy's three-level compress cascade. resolveRequestConfig is the
// exact function server.ts:494 calls for every proxied request (extracted from
// the former inline block at server.ts:485-502); it sequences the real
// resolveCompress → resolveContextLimitValue → applyCompressSettings pipeline.
// This is NOT a startServer() HTTP smoke (that lives in e2e-proxy-smoke) — the
// threshold cascade is a pure per-request Config transform with no HTTP symptom.

const UPSTREAM = "http://127.0.0.1:9999";
const BASE = defaultConfig(200_000);

function routes(): ProviderRoutes {
    return {
        [UPSTREAM]: {
            compress: { maxContextLimit: "80%", emergencyThresholdPercent: "92%" },
            models: {
                "gpt-large": {
                    context: 200_000,
                    compress: { maxContextLimit: "70%", nudgeGrowthTokens: 30_000 },
                },
                "gpt-plain": { context: 100_000 },
                "gpt-half": { context: 200_000, compress: { modelContextLimit: "50%" } },
            },
        },
    };
}

const GLOBAL: CompressSettings = {
    maxContextLimit: "75%",
    emergencyThresholdPercent: "90%",
    nudgeGrowthTokens: 50_000,
};

test("e2e compress cascade: model-level overrides win, omitted fields inherit (global → provider → model)", () => {
    const cfg = resolveRequestConfig(BASE, routes(), UPSTREAM, "gpt-large", 200_000, GLOBAL);
    assert.equal(cfg.nudge.maxContextLimitPct, 0.7, "model-level maxContextLimit 70% wins over provider 80% / global 75%");
    assert.equal(cfg.nudge.emergencyThresholdPct, 0.92, "provider-level emergencyThresholdPercent 92% wins over global 90% (model omitted it)");
    assert.equal(cfg.truncate.threshold, 0.92, "emergency mirrors to truncate.threshold");
    assert.equal(cfg.nudge.growthFloor, 30_000, "model-level nudgeGrowthTokens 30000 wins over global 50000");
    assert.equal(cfg.nudge.growthCap, 30_000);
});

test("e2e compress cascade: a model with no model-level entry falls back to provider, then global", () => {
    const cfg = resolveRequestConfig(BASE, routes(), UPSTREAM, "gpt-plain", 100_000, GLOBAL);
    assert.equal(cfg.nudge.maxContextLimitPct, 0.8, "provider-level maxContextLimit 80% (no model entry)");
    assert.equal(cfg.nudge.emergencyThresholdPct, 0.92, "provider-level emergencyThresholdPercent 92%");
    assert.equal(cfg.nudge.growthFloor, 50_000, "global nudgeGrowthTokens 50000 inherited (provider/model omitted it)");
    assert.equal(cfg.modelContextLimit, 100_000, "native model context passed through");
});

test("e2e compress cascade: unknown provider (no matching route) falls back to global only", () => {
    const cfg = resolveRequestConfig(BASE, routes(), "http://127.0.0.1:5555", "gpt-large", 123_456, GLOBAL);
    assert.equal(cfg.nudge.maxContextLimitPct, 0.75, "global maxContextLimit 75% (route miss)");
    assert.equal(cfg.nudge.emergencyThresholdPct, 0.9, "global emergencyThresholdPercent 90%");
    assert.equal(cfg.nudge.growthFloor, 50_000, "global nudgeGrowthTokens 50000");
    assert.equal(cfg.modelContextLimit, 123_456);
});

test("e2e compress cascade: modelContextLimit resolves percent of native window", () => {
    const cfg = resolveRequestConfig(BASE, routes(), UPSTREAM, "gpt-half", 200_000, GLOBAL);
    assert.equal(cfg.modelContextLimit, 100_000, "modelContextLimit '50%' → half of the 200000 native window");
});

test("e2e compress cascade: with nothing configured at any level, base Config is returned unchanged", () => {
    const plain: ProviderRoutes = { [UPSTREAM]: { models: { "m": { context: 200_000 } } } };
    const cfg = resolveRequestConfig(BASE, plain, UPSTREAM, "m", 200_000, undefined);
    assert.equal(cfg, BASE, "no compress settings + limit unchanged → same base object (no allocation)");
});

test("e2e compress cascade: a single resolver call resolves differently per model (proves per-request, not static)", () => {
    const r = routes();
    const large = resolveRequestConfig(BASE, r, UPSTREAM, "gpt-large", 200_000, GLOBAL);
    const plain = resolveRequestConfig(BASE, r, UPSTREAM, "gpt-plain", 100_000, GLOBAL);
    assert.notEqual(large.nudge.maxContextLimitPct, plain.nudge.maxContextLimitPct, "gpt-large 70% != gpt-plain 80%");
});
