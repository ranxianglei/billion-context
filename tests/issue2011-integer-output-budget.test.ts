import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { clampOutputBudget } from "../src/server/budget.ts";
import { writeOutputBudget } from "../src/server/side-request.ts";

// #2011: since 0.1.181 inputEstimate can carry a fraction (e.g. 85032.5), so the
// #453 output clamp produced a FRACTIONAL cap that was written verbatim into the wire's
// max_tokens / max_completion_tokens / max_output_tokens. Those fields are integer-typed on
// every protocol, so strict upstreams rejected the whole turn with
//   400 {"error":{"type":"server_error","message":"Upstream request failed: max_tokens: Input should be a valid integer"}}
//   or 422 "...Endpoint is unavailable."
// The fix guarantees an integer at BOTH layers: the clamp decision point (clampOutputBudget)
// and the sole wire writer (writeOutputBudget), so no caller can ever emit a fractional count.

// ---- clampOutputBudget: the decision point ----------------------------------

test("#2011 clampOutputBudget: fractional inputEstimate yields an INTEGER cap", () => {
    // Exact values from the 0.1.181 production log (#2011): each produced a fractional
    // max_tokens that a strict upstream rejected. margin = max(2048, ceil(est*0.05)).
    const capA = clampOutputBudget(384_000, 85_032.5, 200_000);
    assert.ok(capA !== undefined, "must clamp");
    assert.ok(Number.isInteger(capA!), `cap must be an integer (got ${capA})`);
    assert.equal(capA!, 110_715, "floor of exact headroom (window - input - margin)");
    assert.ok((capA ?? 0) + 85_032.5 <= 200_000, "input + clamped output never exceeds the window");

    const capB = clampOutputBudget(384_000, 99_364.25, 200_000);
    assert.ok(Number.isInteger(capB!), `cap must be an integer (got ${capB})`);
    assert.equal(capB!, 95_666, "floor of exact headroom");
});

test("#2011 clampOutputBudget: integer inputEstimate is unchanged by the floor (no drift)", () => {
    // Regression guard against over-correcting: with whole-number estimates the cap must be
    // byte-identical to the pre-fix behavior (existing #453 repro shape).
    const margin = Math.max(2048, Math.ceil(130_000 * 0.05));
    assert.equal(clampOutputBudget(131_072, 130_000, 262_144), 262_144 - 130_000 - margin);
});

// ---- writeOutputBudget: the sole wire writer --------------------------------

test("#2011 writeOutputBudget: fractional token counts are written as integers (all field shapes)", () => {
    // Values straight from the 0.1.181 log so the regression is anchored to real incidents.
    const flat: Record<string, unknown> = {};
    writeOutputBudget(flat, "max_tokens", 110_715.5);
    assert.equal(flat.max_tokens, 110_715, "OpenAI chat max_tokens floored to integer");

    const mc: Record<string, unknown> = {};
    writeOutputBudget(mc, "max_completion_tokens", 95_666.75);
    assert.equal(mc.max_completion_tokens, 95_666, "OpenAI responses max_completion_tokens floored");

    const resp: Record<string, unknown> = {};
    writeOutputBudget(resp, "max_output_tokens", 88_015.5);
    assert.equal(resp.max_output_tokens, 88_015, "Responses-API max_output_tokens floored");

    const gemini: Record<string, unknown> = {};
    writeOutputBudget(gemini, "generationConfig.maxOutputTokens", 157_518.5);
    assert.equal((gemini.generationConfig as Record<string, unknown>).maxOutputTokens, 157_518, "Gemini generationConfig.maxOutputTokens floored");
});

test("#2011 writeOutputBudget: integer values pass through unchanged (no drift)", () => {
    const body: Record<string, unknown> = {};
    writeOutputBudget(body, "max_tokens", 40_000);
    assert.equal(body.max_tokens, 40_000, "whole-number budget is untouched");
});
