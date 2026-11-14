import { test } from "node:test";
import assert from "node:assert/strict";
import { sizePressureOf, SIZE_PRESSURE_WARN_RATIO } from "../src/size-pressure.ts";

// #4959 option B: sizePressureOf is the single definition every surface
// (/acp line, web badge, /__bili/sessions field) renders from. Lock both
// directions of the gate plus the denominator choice — a diagnostic that
// false-alarms on healthy sessions is as bad as one that stays silent.

test("warns when a usage reading sits far past the judging window (#4959)", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 3_200_000, contextTokensSource: "usage", lastInputTokensSource: "usage" },
        metadata: { reservedContextLimit: 800_000 },
    });
    assert.ok(r);
    assert.equal(r.tokens, 3_200_000);
    assert.equal(r.target, 800_000);
    assert.equal(r.warn, true);
    assert.ok(Math.abs(r.ratio - 4) < 1e-9);
});

test("warns on an anchored estimate reading past the window", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 2_800_000, contextTokensSource: "estimate", lastUsageGradeTokens: 500_000, contextEstimateTokens: 2_800_000 },
        metadata: { reservedContextLimit: 800_000 },
    });
    assert.ok(r);
    assert.equal(r.tokens, 2_800_000);
    assert.equal(r.warn, true);
});

test("warns on a never-reporting upper-bound reading past the window", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 9_000_000, contextTokensSource: "estimate" },
        metadata: { reservedContextLimit: 2_000_000 },
    });
    assert.ok(r);
    assert.equal(r.tokens, 9_000_000);
    assert.equal(r.warn, true);
});

test("does NOT warn below the threshold but still reports the measured ratio", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 1_500_000, contextTokensSource: "usage", lastInputTokensSource: "usage" },
        metadata: { reservedContextLimit: 800_000 },
    });
    assert.ok(r);
    assert.equal(r.warn, false);
    assert.ok(r.ratio > 0 && r.ratio < SIZE_PRESSURE_WARN_RATIO);
});

test("exactly at the threshold warns (>= semantics)", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 2_400_000, contextTokensSource: "usage", lastInputTokensSource: "usage" },
        metadata: { reservedContextLimit: 800_000 },
    });
    assert.ok(r);
    assert.equal(r.warn, true);
    assert.ok(Math.abs(r.ratio - SIZE_PRESSURE_WARN_RATIO) < 1e-9);
});

test("returns null when no judging window is known (no false alarm)", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 3_200_000, contextTokensSource: "usage", lastInputTokensSource: "usage" },
        metadata: {},
    });
    assert.equal(r, null);
});

test("returns null when nothing has been observed yet", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 0 },
        metadata: { reservedContextLimit: 800_000 },
    });
    assert.equal(r, null);
});

test("denominator prefers the reserved judging window over the declared wall", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 3_200_000, contextTokensSource: "usage", lastInputTokensSource: "usage" },
        metadata: { reservedContextLimit: 800_000, effectiveContextLimit: 400_000 },
    });
    assert.ok(r);
    assert.equal(r.target, 800_000);
    assert.ok(Math.abs(r.ratio - 4) < 1e-9);
});

test("falls back to the declared wall when only effectiveContextLimit is stamped", () => {
    const r = sizePressureOf({
        stats: { contextTokens: 3_200_000, contextTokensSource: "usage", lastInputTokensSource: "usage" },
        metadata: { effectiveContextLimit: 800_000 },
    });
    assert.ok(r);
    assert.equal(r.target, 800_000);
    assert.equal(r.warn, true);
});
