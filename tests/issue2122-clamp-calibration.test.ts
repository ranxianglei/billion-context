import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

// #2122: output clamp starved a DSH web session (llama.cpp/OpenAI wire, window
// 147456, requested output 32768) down to 3357 tokens while the provider billed
// only ~67–81K input: estimateInputTokens' max(baseline, est) let the RAW chars/4
// local estimate (~137K — the host renders fewer tokens than bili's local view)
// override the fresh usage-grade baseline, so the clamp computed headroom against
// input that never reached the provider. The model was mid-preparation of another
// compression when starved at stopReason=length and the fold never executed.
//
// Fix: scale the LOCAL-EST side by the per-route estimator calibration k̂ (#1933 F1,
// learned from measured/local pairs on the same route), exactly as the preflight
// gate already does — the usage-grade baseline stays unscaled. These tests pin
// both the incident arithmetic (raw path still clamps 32768 -> 4096, the #3071
// capability floor of the naive 3357 cap) and the fix (calibrated path leaves
// 32768 untouched).

import type { CoreMessage } from "acp-kernel";
import { clampOutgoingOutput, estimateInputTokens } from "../src/server/budget.ts";

const ORIGIN = "http://127.0.0.1:8080";

// Pure-ASCII message sized so the raw local estimate (message text + "" system +
// [] tools overhead of 1 token) lands exactly on the incident's logged input~137237.
const MSGS: CoreMessage[] = [{ id: "m00001", role: "user", contentType: "text", text: "x".repeat(548_944) }];

function rawLocalEst(): number {
    return estimateInputTokens(MSGS, "", [], 0, "usage");
}

test("#2122 fixture: raw local estimate reproduces the incident's input~137237", () => {
    assert.equal(rawLocalEst(), 137_237);
});

test("#2122 repro: without calibration the raw est overrides the usage baseline and clamps 32768 -> 4096 (#3071 floor)", () => {
    const body: Record<string, unknown> = { max_tokens: 32_768 };
    clampOutgoingOutput(body, "max_tokens", {
        systemText: "", tools: [], processedMessages: MSGS,
        lastInputTokens: 81_678, lastInputTokensSource: "usage",
        nativeWindow: 147_456, imageTokens: 0,
    }, "t2122", () => {});
    // margin = max(2048, ceil(137237*0.05)=6862); naive cap = floor(147456-137237-6862) = 3357.
    // #3071 floors the emitted budget at min(4096, headroom 10219) = 4096 — the old
    // 3357 pin was exactly the sub-floor starvation the capability floor removes.
    assert.equal(body.max_tokens, 4_096);
});

test("#2122 fix: calibrated local side restores provider-consistent headroom — no clamp", () => {
    const body: Record<string, unknown> = { max_tokens: 32_768 };
    clampOutgoingOutput(body, "max_tokens", {
        systemText: "", tools: [], processedMessages: MSGS,
        lastInputTokens: 81_678, lastInputTokensSource: "usage",
        nativeWindow: 147_456, imageTokens: 0,
        kFactor: 0.6, kOrigin: ORIGIN, origin: `${ORIGIN}/v1`, // path suffix must normalize away
    }, "t2122", () => {});
    // est' = 137237*0.6 ≈ 82342.2; margin = ceil(4117.11) = 4118; cap = floor(60995.8) = 60995 >= 32768
    assert.equal(body.max_tokens, 32_768);
});

test("#2122: the local side is scaled by k̂ on its own route", () => {
    const est = estimateInputTokens(MSGS, "", [], 0, "usage", 0.6, ORIGIN, ORIGIN);
    assert.ok(Math.abs(est - 137_237 * 0.6) < 1e-9, `expected ~${137_237 * 0.6}, got ${est}`);
});

test("#2122: the usage-grade baseline is never scaled by k̂", () => {
    assert.equal(estimateInputTokens([], "", [], 50_000, "usage", 0.6, ORIGIN, ORIGIN), 50_000);
});

test("#2122: k̂ applies only on the route it was learned on (mismatch -> legacy raw)", () => {
    assert.equal(estimateInputTokens(MSGS, "", [], 81_678, "usage", 0.6, ORIGIN, "http://other"), rawLocalEst());
});

test("#2122: absent or invalid k̂ degrades to legacy raw behavior", () => {
    assert.equal(estimateInputTokens(MSGS, "", [], 81_678, "usage"), rawLocalEst());
    assert.equal(estimateInputTokens(MSGS, "", [], 81_678, "usage", Number.NaN, ORIGIN, ORIGIN), rawLocalEst());
    assert.equal(estimateInputTokens(MSGS, "", [], 81_678, "usage", 0, ORIGIN, ORIGIN), rawLocalEst());
});
