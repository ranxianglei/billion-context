import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RolloutFileConfig } from "../src/config.js";

// #5403 watermark fastpath experimental-grey release surface (owner ruling
// 2026-11-02): default ~5% cohort + one-time intro notice visible to EVERY
// install until closed or an explicit rollout override exists. Pins the two
// new pieces: featureOverrideAbsent (nag only users who never chose) and the
// generalized per-instance notice store (wm-fastpath-intro id, same
// dismissal contract as #5079's pck-default-off).

const dir = mkdtempSync(path.join(tmpdir(), "bili-wmnotice-"));
process.env.XDG_STATE_HOME = dir;

const { featureOverrideAbsent, ROLLOUT_FEATURES } = await import("../src/rollout.js");
const { PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, dismissedUpgradeNotices, dismissUpgradeNotice } = await import("../src/pck-notice.js");

test("wm fastpath: baked plan — TEMP-ON 100% for #5576 pre-merge verification push", () => {
    // REVERT before merge: the shipped default is { percent: 5 } (owner ruling
    // 2026-11-02: small cohort first, web switch + intro notice alongside; a
    // regression to 100 at merge time would ship an unreviewed trust-model
    // change). This push temporarily forces 100 so remote CI — including the
    // windows scenarios not reproducible locally (npm ci / install lanes) —
    // exercises the full watermark path end-to-end.
    const plan = ROLLOUT_FEATURES["pluginFullResendWatermark"];
    assert.equal(plan.percent, 100);
});

test("#5403 unit: featureOverrideAbsent — nags only users who never chose", () => {
    // untouched config shapes → absent (intro notice shows)
    const absent: Array<RolloutFileConfig | undefined> = [undefined, {}, { features: {} }, { features: { pluginIncrementalTurns: true } }, { installId: "pinned" }];
    for (const file of absent) {
        assert.equal(featureOverrideAbsent("pluginFullResendWatermark", file), true, JSON.stringify(file));
    }
    const touched: Array<number | boolean | Record<string, unknown>> = [true, false, 42, 0, 100, { enabled: true }, { percent: 10 }, { salt: "a", base: "b" }];
    // any explicit entry for the feature counts as "touched" → no nag
    for (const o of touched) {
        assert.equal(
            featureOverrideAbsent("pluginFullResendWatermark", { features: { pluginFullResendWatermark: o } }),
            false,
            JSON.stringify(o)
        );
    }
});

test("#5403 unit: upgrade-notice store accepts the wm intro id (#5079 contract kept)", () => {
    const env = { ...process.env, XDG_STATE_HOME: mkdtempSync(path.join(tmpdir(), "bili-wmnotice-env-")) };
    // unknown ids stay rejected
    assert.equal(dismissUpgradeNotice("foreign-id", env), false);
    assert.equal(dismissUpgradeNotice(WM_FASTPATH_INTRO_ID, env), true);
    assert.equal(dismissUpgradeNotice(WM_FASTPATH_INTRO_ID, env), true); // idempotent
    let seen = dismissedUpgradeNotices(env);
    assert.ok(seen.has(WM_FASTPATH_INTRO_ID));
    assert.ok(!seen.has(PCK_NOTICE_ID)); // independent id — dismissing wm does not touch pck
    // #5079's own id keeps working through the same allowlist
    assert.equal(dismissUpgradeNotice(PCK_NOTICE_ID, env), true);
    seen = dismissedUpgradeNotices(env);
    assert.ok(seen.has(PCK_NOTICE_ID) && seen.has(WM_FASTPATH_INTRO_ID));
});

test("teardown", () => rmSync(dir, { recursive: true, force: true }));
