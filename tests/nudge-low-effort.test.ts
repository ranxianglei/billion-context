import test from "node:test";
import assert from "node:assert/strict";
import { applyNudgeEffortClamp, nudgeLowEffortDecision } from "../src/output-steering.ts";
import { parseCompressSettings } from "../src/config.ts";

test("anthropic: thinking.budget_tokens above floor clamps down to 1024", () => {
    const body = JSON.stringify({ model: "m", thinking: { type: "enabled", budget_tokens: 16000 }, messages: [{ role: "user", content: "hi" }] });
    const out = applyNudgeEffortClamp(body, "anthropic");
    assert.equal(out.changed, true);
    assert.equal(JSON.parse(out.body).thinking.budget_tokens, 1024);
});

test("anthropic: budget at the floor is untouched (byte-identical)", () => {
    const body = JSON.stringify({ model: "m", thinking: { type: "enabled", budget_tokens: 1024 }, messages: [{ role: "user", content: "hi" }] });
    const out = applyNudgeEffortClamp(body, "anthropic");
    assert.equal(out.changed, false);
    assert.equal(out.body, body);
});

test("anthropic: budget below floor is never raised", () => {
    const body = JSON.stringify({ model: "m", thinking: { type: "enabled", budget_tokens: 512 }, messages: [{ role: "user", content: "hi" }] });
    const out = applyNudgeEffortClamp(body, "anthropic");
    assert.equal(out.changed, false);
    assert.equal(JSON.parse(out.body).thinking.budget_tokens, 512);
});

test("openai: reasoning_effort high lowers to low", () => {
    const body = JSON.stringify({ model: "m", reasoning_effort: "high", messages: [{ role: "user", content: "hi" }] });
    const out = applyNudgeEffortClamp(body, "openai");
    assert.equal(out.changed, true);
    assert.equal(JSON.parse(out.body).reasoning_effort, "low");
});

test("openai: reasoning_effort below floor (minimal) is never raised", () => {
    const body = JSON.stringify({ model: "m", reasoning_effort: "minimal", messages: [{ role: "user", content: "hi" }] });
    const out = applyNudgeEffortClamp(body, "openai");
    assert.equal(out.changed, false);
    assert.equal(out.body, body);
});

test("openai: absent reasoning_effort is not injected", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const out = applyNudgeEffortClamp(body, "openai");
    assert.equal(out.changed, false);
    assert.equal(out.body, body);
});

test("google: thinkingBudget above floor clamps to 128", () => {
    const body = JSON.stringify({ model: "m", generationConfig: { thinkingConfig: { thinkingBudget: 8000 } }, contents: [] });
    const out = applyNudgeEffortClamp(body, "google");
    assert.equal(out.changed, true);
    assert.equal(JSON.parse(out.body).generationConfig.thinkingConfig.thinkingBudget, 128);
});

test("google: dynamic (-1) thinkingBudget is left untouched", () => {
    const body = JSON.stringify({ model: "m", generationConfig: { thinkingConfig: { thinkingBudget: -1 } }, contents: [] });
    const out = applyNudgeEffortClamp(body, "google");
    assert.equal(out.changed, false);
    assert.equal(out.body, body);
});

test("responses: reasoning.effort high lowers to low", () => {
    const body = JSON.stringify({ model: "m", instructions: "x", input: [{ type: "message", role: "user", content: "hi" }], reasoning: { effort: "high" } });
    const out = applyNudgeEffortClamp(body, "responses");
    assert.equal(out.changed, true);
    assert.equal(JSON.parse(out.body).reasoning.effort, "low");
});

test("responses: absent reasoning is not injected", () => {
    const body = JSON.stringify({ model: "m", instructions: "x", input: [{ type: "message", role: "user", content: "hi" }] });
    const out = applyNudgeEffortClamp(body, "responses");
    assert.equal(out.changed, false);
    assert.equal(out.body, body);
});

test("idempotent: a second pass over an already-clamped body changes nothing", () => {
    const body = JSON.stringify({ model: "m", thinking: { type: "enabled", budget_tokens: 16000 }, messages: [{ role: "user", content: "hi" }] });
    const first = applyNudgeEffortClamp(body, "anthropic");
    assert.equal(first.changed, true);
    const second = applyNudgeEffortClamp(first.body, "anthropic");
    assert.equal(second.changed, false);
    assert.equal(second.body, first.body);
});

test("safety: malformed JSON returns the input verbatim", () => {
    const out = applyNudgeEffortClamp("{not json", "anthropic");
    assert.equal(out.changed, false);
    assert.equal(out.body, "{not json");
});

test("safety: null protocol returns the input verbatim", () => {
    const body = JSON.stringify({ model: "m", reasoning_effort: "high", messages: [] });
    const out = applyNudgeEffortClamp(body, null);
    assert.equal(out.changed, false);
    assert.equal(out.body, body);
});

test("safety: array body is not treated as a request object", () => {
    const out = applyNudgeEffortClamp("[1,2,3]", "openai");
    assert.equal(out.changed, false);
    assert.equal(out.body, "[1,2,3]");
});

test("classifier-independent: a plain user turn (no tool result) still clamps", () => {
    // applyOutputSteering only lowers effort on kernel-classified mechanical turns;
    // the nudge clamp must fire regardless, because the compression-nudge turn is
    // usually a real task turn, not a tool continuation.
    const body = JSON.stringify({ model: "m", reasoning_effort: "high", messages: [{ role: "user", content: "please compress what you can" }] });
    const out = applyNudgeEffortClamp(body, "openai");
    assert.equal(out.changed, true);
    assert.equal(JSON.parse(out.body).reasoning_effort, "low");
});

test("decision: fresh first nudge of an episode clamps once", () => {
    assert.deepEqual(nudgeLowEffortDecision(true, false, true), { clamp: true, nextPrev: true });
});

test("decision: a deferred nudge retried on the next turn does not re-clamp", () => {
    assert.deepEqual(nudgeLowEffortDecision(true, true, true), { clamp: false, nextPrev: true });
});

test("decision: disabled never clamps but still tracks the episode", () => {
    assert.deepEqual(nudgeLowEffortDecision(true, false, false), { clamp: false, nextPrev: true });
});

test("decision: a non-nudge turn does not clamp and resets the episode", () => {
    assert.deepEqual(nudgeLowEffortDecision(false, false, true), { clamp: false, nextPrev: false });
});

test("decision: full episode cycle — clamp, defer, recover, new-episode re-clamp", () => {
    let prev = false;
    const seq: boolean[] = [];
    for (const injected of [true, true, false, true]) {
        const d = nudgeLowEffortDecision(injected, prev, true);
        seq.push(d.clamp);
        prev = d.nextPrev;
    }
    assert.deepEqual(seq, [true, false, false, true]);
});

test("config: nudgeLowEffort parses a boolean and survives round-trip", () => {
    assert.equal(parseCompressSettings({ nudgeLowEffort: true })?.nudgeLowEffort, true);
    assert.equal(parseCompressSettings({ nudgeLowEffort: false })?.nudgeLowEffort, false);
});

test("config: a non-boolean nudgeLowEffort rejects the whole block", () => {
    assert.equal(parseCompressSettings({ nudgeLowEffort: "yes" }), undefined);
});

test("config: unset nudgeLowEffort stays off (default-off guarantee)", () => {
    const parsed = parseCompressSettings({});
    assert.ok(parsed === undefined || parsed.nudgeLowEffort === undefined);
});
