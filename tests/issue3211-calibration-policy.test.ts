import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { settleUsageReport } from "../src/cache-ledger.ts";
import { applyCompressSettings, resolveCompress } from "../src/compress-settings.ts";
import { findRoute, parseCalibrationPolicy, parseCompressSettings, parseRouteEntry, type ProviderRoutes } from "../src/config.ts";

// #3211: a route whose usage reports inflate ~1.9× learns k̂ ≈ 1.86 through
// every evidence gate (the reports ARE consistent), and applying that factor
// pins the decision meter into the pressure band permanently — the band
// bypasses growth-gate + cadence, so every few thousand tokens of pending
// triggers another fold that recovers just enough to dip below the line:
// high-frequency small-yield churn ("fold a little each time we hit the
// line"). Two owner-approved fixes are pinned here:
//   A) providers[<key>].calibration — per-route k̂ policy applied at
//      PUBLICATION time (ring stays raw for audit);
//   A2) compress.minPressureBenefitTokens — plumbing of the kernel's
//      pressure-band minimum-benefit floor (default max(5000, limit×1%)).

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `i3211-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

// One settled pair on a route (same idiom as issue2366-cjk-billed-status):
// pending local estimate of THIS payload + its usage report.
function pair(s: Session, est: number, origin: string, billed: number): void {
    s.stats.lastLocalTextEstimate = est;
    s.stats.lastLocalTextEstimateOrigin = origin;
    settleUsageReport(s, { total: billed, reportedCached: null, upstream: origin });
}

// Stamps the policy slot exactly like handle.ts does at dispatch time.
function stampPolicy(s: Session, policy: { disabled?: boolean; max?: number } | undefined, origin: string | undefined): void {
    s.stats.lastCalibrationPolicy = policy;
    s.stats.lastCalibrationPolicyOrigin = policy ? origin : undefined;
}

const ORIGIN = "https://relay-a.example.com/v1";

// --- A: config parsing ---------------------------------------------------

test("#3211 A: parseCalibrationPolicy accepts the valid shapes", () => {
    assert.equal(parseCalibrationPolicy(undefined), undefined);
    assert.deepEqual(parseCalibrationPolicy({ disabled: true }), { disabled: true });
    assert.deepEqual(parseCalibrationPolicy({ max: 1 }), { max: 1 });
    assert.deepEqual(parseCalibrationPolicy({ max: 0.5, disabled: false }), { max: 0.5, disabled: false });
});

test("#3211 A: parseCalibrationPolicy rejects invalid shapes loudly", () => {
    assert.throws(() => parseCalibrationPolicy("disabled"), /must be an object/);
    assert.throws(() => parseCalibrationPolicy([1]), /must be an object/);
    assert.throws(() => parseCalibrationPolicy({}), /at least one/);
    assert.throws(() => parseCalibrationPolicy({ disabled: "yes" }), /disabled must be a boolean/);
    assert.throws(() => parseCalibrationPolicy({ max: 0 }), /max must be a number > 0/);
    assert.throws(() => parseCalibrationPolicy({ max: -1 }), /max must be a number > 0/);
    // Above the publication clamp (4) the cap is provably inert — reject dead weight.
    assert.throws(() => parseCalibrationPolicy({ max: 5 }), /max must be a number > 0/);
    assert.throws(() => parseCalibrationPolicy({ max: "2" }), /max must be a number > 0/);
    assert.throws(() => parseCalibrationPolicy({ foo: 1 }), /unknown key/);
});

test("#3211 A: parseRouteEntry carries calibration onto the route", () => {
    const route = parseRouteEntry({ calibration: { max: 1 } });
    assert.ok(route);
    assert.deepEqual(route.calibration, { max: 1 });
    assert.equal(parseRouteEntry({})?.calibration, undefined);
    assert.throws(() => parseRouteEntry({ calibration: { max: 9 } }), /max must be a number > 0/);
});

test("#3211 A: findRoute resolves the policy with host-level AND path-scoped keys", () => {
    const routes: ProviderRoutes = {
        "https://host-level.example.com": { calibration: { max: 1 } },
        "https://path-scoped.example.com/v1": { calibration: { disabled: true } },
        "https://path-scoped.example.com/v2": {},
        "https://unrelated.example.com": {},
    };
    assert.equal(findRoute(routes, "https://host-level.example.com/api/chat")?.calibration?.max, 1);
    assert.equal(findRoute(routes, "https://path-scoped.example.com/v1/messages")?.calibration?.disabled, true);
    assert.equal(findRoute(routes, "https://path-scoped.example.com/v2/messages")?.calibration, undefined);
    assert.equal(findRoute(routes, "https://unrelated.example.com/x")?.calibration, undefined);
});

// --- A: publication-time application --------------------------------------

test("#3211 A: absent policy keeps legacy publication byte-identical", () => {
    const s = makeSession();
    pair(s, 10000, ORIGIN, 18600); // ratio 1.86
    assert.equal(s.stats.calibratedEstimate, undefined, "one sample must not publish");
    pair(s, 10000, ORIGIN, 18700); // ratio 1.87
    assert.ok(Math.abs((s.stats.calibratedEstimate ?? 0) - 1.865) < 1e-9, `legacy mean publish, got ${s.stats.calibratedEstimate}`);
});

test("#3211 A: policy {max:1} clamps the published factor, ring stays raw", () => {
    const s = makeSession();
    stampPolicy(s, { max: 1 }, ORIGIN);
    pair(s, 10000, ORIGIN, 18600);
    stampPolicy(s, { max: 1 }, ORIGIN);
    pair(s, 10000, ORIGIN, 18700);
    assert.equal(s.stats.calibratedEstimate, 1, `inflation capped at 1, got ${s.stats.calibratedEstimate}`);
    assert.equal(s.stats.calibratedEstimateOrigin, new URL(ORIGIN).origin);
    const ring = s.stats.calibrationRing;
    assert.ok(ring, "learned ring must survive the policy");
    assert.ok(Math.abs(ring.values[0] - 1.86) < 1e-9 && Math.abs(ring.values[1] - 1.87) < 1e-9, "ring values stay raw for audit");
});

test("#3211 A: policy {max} below the learned mean acts as a deflation-only floor guard", () => {
    const s = makeSession();
    stampPolicy(s, { max: 1.5 }, ORIGIN);
    pair(s, 10000, ORIGIN, 18600);
    stampPolicy(s, { max: 1.5 }, ORIGIN);
    pair(s, 10000, ORIGIN, 18700);
    assert.equal(s.stats.calibratedEstimate, 1.5);
});

test("#3211 A: explicit max below the publication floor is honored (user intent wins)", () => {
    const s = makeSession();
    stampPolicy(s, { max: 0.2 }, ORIGIN);
    pair(s, 10000, ORIGIN, 18600);
    stampPolicy(s, { max: 0.2 }, ORIGIN);
    pair(s, 10000, ORIGIN, 18700);
    assert.equal(s.stats.calibratedEstimate, 0.2);
});

test("#3211 A: policy {disabled:true} suppresses publication but keeps the ring", () => {
    const s = makeSession();
    stampPolicy(s, { disabled: true }, ORIGIN);
    pair(s, 10000, ORIGIN, 18600);
    stampPolicy(s, { disabled: true }, ORIGIN);
    pair(s, 10000, ORIGIN, 18700);
    assert.equal(s.stats.calibratedEstimate, undefined, "no factor may be applied on this route");
    assert.equal(s.stats.calibratedEstimateOrigin, undefined);
    assert.equal(s.stats.calibratedEstimateModel, undefined, "provenance stamp clears with the factor");
    const ring = s.stats.calibrationRing;
    assert.ok(ring && ring.values.length === 2, "raw ring stays auditable");
});

test("#3211 A: policy from a different route origin is voided for this settle", () => {
    const s = makeSession();
    stampPolicy(s, { max: 1 }, "https://other-route.example.com/v1");
    pair(s, 10000, ORIGIN, 18600);
    pair(s, 10000, ORIGIN, 18700);
    assert.ok(Math.abs((s.stats.calibratedEstimate ?? 0) - 1.865) < 1e-9, "foreign-origin policy must not apply");
});

test("#3211 A: clearing the slot (policy-less request) restores legacy publication", () => {
    const s = makeSession();
    stampPolicy(s, { max: 1 }, ORIGIN);
    pair(s, 10000, ORIGIN, 18600);
    stampPolicy(s, undefined, undefined);
    pair(s, 10000, ORIGIN, 18700);
    assert.ok(Math.abs((s.stats.calibratedEstimate ?? 0) - 1.865) < 1e-9, "cleared slot = legacy behavior");
});

test("#3211 A: disabled policy coexists with inconsistent-sample deletion", () => {
    const s = makeSession();
    stampPolicy(s, { disabled: true }, ORIGIN);
    pair(s, 10000, ORIGIN, 18600);
    stampPolicy(s, { disabled: true }, ORIGIN);
    pair(s, 10000, ORIGIN, 39000); // ratio 3.9 — spread ×2.1 breaks consistency
    assert.equal(s.stats.calibratedEstimate, undefined);
    assert.ok(s.stats.calibrationRing && s.stats.calibrationRing.values.length === 2, "ring still accumulates");
});

// --- A2: minPressureBenefitTokens plumbing --------------------------------

test("#3211 A2: applyCompressSettings maps minPressureBenefitTokens onto nudge", () => {
    const base = defaultConfig(200000);
    assert.equal(base.nudge.minPressureBenefitTokens, undefined, "kernel default stays when unset");
    assert.equal(applyCompressSettings(base, 200000, { minPressureBenefitTokens: 50000 }).nudge.minPressureBenefitTokens, 50000);
    // Explicit 0 is meaningful (legacy any-pending) and must pass through.
    assert.equal(applyCompressSettings(base, 200000, { minPressureBenefitTokens: 0 }).nudge.minPressureBenefitTokens, 0);
});

test("#3211 A2: three-level merge — model beats provider beats global, per field", () => {
    const routes: ProviderRoutes = {
        "https://api.example.com/v1": {
            compress: { minPressureBenefitTokens: 50000 },
            models: { "m-big": { compress: { minPressureBenefitTokens: 20000 } } },
        },
    };
    const global = { minPressureBenefitTokens: 10000 };
    assert.equal(resolveCompress(routes, "https://api.example.com/v1/chat", "m-big", global).minPressureBenefitTokens, 20000);
    assert.equal(resolveCompress(routes, "https://api.example.com/v1/chat", "m-other", global).minPressureBenefitTokens, 50000);
    assert.equal(resolveCompress(routes, "https://elsewhere.example.com/v1/chat", "m-other", global).minPressureBenefitTokens, 10000);
    assert.equal(resolveCompress(routes, "https://elsewhere.example.com/v1/chat", "m-other", undefined).minPressureBenefitTokens, undefined);
});

test("#3211 A2: parseCompressSettings validates the floor (rejects negative/non-number)", () => {
    assert.equal(parseCompressSettings({ minPressureBenefitTokens: 50000 })?.minPressureBenefitTokens, 50000);
    assert.equal(parseCompressSettings({ minPressureBenefitTokens: 0 })?.minPressureBenefitTokens, 0);
    // Invalid value rejects the WHOLE compress block (established contract).
    assert.equal(parseCompressSettings({ minPressureBenefitTokens: -1 }), undefined);
    assert.equal(parseCompressSettings({ minPressureBenefitTokens: "50000" }), undefined);
});
