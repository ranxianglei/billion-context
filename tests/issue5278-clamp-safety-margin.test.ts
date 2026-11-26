// #5278: the #453 output clamp's safety margin was sized FROM the input
// estimate (est * 5%) while its job is to absorb the ESTIMATOR's error — and
// the heuristic estimator (defaultCountTokens: CJK 1 token/char, rest chars/4)
// systematically understates CJK-heavy payloads by ~5%, the same order. On
// those sessions margin < actual error by construction, so the clamped total
// landed at exactly window+1 -> upstream ContextWindowExceededError 502.
// Three independent field incidents (bili 0.1.206/0.1.209, DSH desktop,
// deepseek-v4.1-flash, window 262144, client-reported max_tokens 384000):
// billed/estimated ratios 1.050011 / 1.050016 / 1.050020, each total = 262145.
// Fix: judge on a safety-inflated estimate (x1.12) before sizing both the
// subtraction and the margin; fall back to the raw formula when the inflated
// estimate drops below the capability floor (the #2490/#3071 pinned regimes).
import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { clampOutputBudget } from "../src/server/budget.ts";

const WINDOW = 262_144; // the incidents' deepseek-v4.1-flash window
const REQUESTED = 384_000; // the restored client-reported max_tokens in all three logs

// (inputEstimate as logged, real input billed upstream) — straight from the
// issue's proxy.log lines. Pre-fix every one clamped to window - est - margin,
// i.e. real + clamped = 262145 = window + 1.
const INCIDENTS: Array<{ est: number; real: number }> = [
    { est: 101_358, real: 106_427 },
    { est: 120_381, real: 126_402 },
    { est: 73_490, real: 77_166 },
];

test("#5278: the three incident requests no longer overflow the window", () => {
    for (const { est, real } of INCIDENTS) {
        const capped = clampOutputBudget(REQUESTED, est, WINDOW);
        assert.ok(capped !== undefined, `est=${est}: must clamp`);
        assert.ok(capped! + real <= WINDOW, `est=${est}: real(${real}) + clamped(${capped}) = ${capped! + real} must be <= ${WINDOW}`);
    }
});

test("#5278: the clamped values match the owner-validated patch arithmetic", () => {
    assert.equal(clampOutputBudget(REQUESTED, 101_358, WINDOW), 142_946);
    assert.equal(clampOutputBudget(REQUESTED, 120_381, WINDOW), 120_575);
    assert.equal(clampOutputBudget(REQUESTED, 73_490, WINDOW), 175_719);
});

test("#5278: systematic property — any underestimate up to the safety factor stays inside the window", () => {
    // Guarantee under the safe path: true input T <= 1.12*est cannot overflow
    // (both the cap path and the #3071 floor path bound their output against
    // the inflated basis). Sweep u across [0, 0.12] while the true input still
    // leaves room for a minimum reply — beyond that, input alone is preflight
    // territory and no output budget recovers it (by design, unchanged).
    for (const u of [0.0, 0.03, 0.05, 0.1, 0.12]) {
        for (let est = 1_000; est <= 220_000; est += 500) {
            const real = Math.round(est * (1 + u));
            if (real + 4_096 > WINDOW) continue;
            const capped = clampOutputBudget(REQUESTED, est, WINDOW);
            assert.ok(capped !== undefined && capped! + real <= WINDOW,
                `u=${u} est=${est}: clamped=${capped} real=${real} total=${capped === undefined ? "n/a" : capped! + real}`);
        }
    }
});

test("#5278: fitting requests stay untouched (no wire churn where nothing was wrong)", () => {
    assert.equal(clampOutputBudget(8_192, 10_000, 200_000), undefined);
    assert.equal(clampOutputBudget(4_096, 10_000, 200_000), undefined);
});

test("#5278: the sub-floor fallback keeps the #2490/#3071 pinned shapes byte-identical", () => {
    // Inflated estimate crosses the wall -> raw-formula fallback applies:
    assert.equal(clampOutputBudget(384_000, 900_000, 1_000_000), 55_000, "#2490 incident clamp unchanged");
    assert.equal(clampOutputBudget(131_072, 247_162, WINDOW), 4_096, "#3071 planning-floor case unchanged");
    assert.equal(clampOutputBudget(8_000, 8_500, 12_000), 3_500, "#3071 headroom-bounded floor unchanged");
    // Genuine surrender (input alone past the window even raw): untouched.
    assert.equal(clampOutputBudget(384_000, 990_000, 1_000_000), undefined);
    assert.equal(clampOutputBudget(100_000, 199_000, 200_000), undefined);
});
