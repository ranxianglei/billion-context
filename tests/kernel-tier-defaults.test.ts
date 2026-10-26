import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.js";
import type { CompressSettings } from "../src/config.js";

// acp-kernel#379 / billion-context#1249: block COUNT is not a need signal.
// Count-triggered tier distillation defaults OFF (tier2Trigger 1000 /
// tier3Trigger 2000) and carries no usage gate — growth and token mass are
// the need signal. These assertions pin that contract into bili's suite so a
// future kernel bump that silently reverts the defaults (or a bili-side
// overlay that starts forcing triggers) fails CI here instead of re-opening
// the prefix-cache sawtooth.

test("kernel defaults: count-triggered tier distillation is default-off (#379)", () => {
    const config = defaultConfig(200_000);
    assert.equal(config.tiers.tier2Trigger, 1000, "tier2Trigger must default to 1000 (count path off)");
    assert.equal(config.tiers.tier3Trigger, 2000, "tier3Trigger must default to 2000 (count path off)");
    assert.equal(config.tiers.enabled, true, "tiers stay enabled — the mass paths still distill");
});

test("applyCompressSettings never overrides tier triggers (#379)", () => {
    const base = defaultConfig(200_000);
    const settings: CompressSettings = { tiers: false, nudgeGrowthTokens: 30000 };
    const applied = applyCompressSettings(base, 200_000, settings);
    assert.equal(applied.tiers.enabled, false, "boolean tiers toggle only flips enabled");
    assert.equal(applied.tiers.tier2Trigger, 1000, "triggers are kernel-owned; bili must not force them");
    assert.equal(applied.tiers.tier3Trigger, 2000, "triggers are kernel-owned; bili must not force them");
    const untouched = applyCompressSettings(base, 200_000, {});
    assert.deepEqual(untouched.tiers, base.tiers, "no tiers setting leaves kernel defaults intact");
});
