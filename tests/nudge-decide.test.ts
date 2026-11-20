// #2228: unit tests for the model-decided nudge timing logic (src/nudge-decide.ts).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
    applyDecisionReasoningPolicy,
    DEFAULT_DECIDE_MAX_TOKENS,
    DECIDE_FALLBACK_THRESHOLD,
    buildDecisionPrompt,
    buildDirectiveText,
    extractDecisionText,
    ladderMode,
    parseDecision,
    recordDecision,
    resolveDecisionRange,
    stripDecisionReasoningFields,
} from "../src/nudge-decide.ts";
import type { CompressibleRange } from "acp-kernel";

const RANGES: CompressibleRange[] = [
    { startRef: "m00010", endRef: "m00020", count: 11, tokens: 12_000, toolPct: 80, textPct: 20 },
    { startRef: "m00030", endRef: "m00040", count: 11, tokens: 3_000, toolPct: 10, textPct: 90 },
];

test("constants are sane defaults", () => {
    // #5030: 1024 leaves room for short hidden reasoning plus the one-line
    // JSON verdict; 200 starved hybrid-thinking models into empty answers.
    assert.equal(DEFAULT_DECIDE_MAX_TOKENS, 1024);
    assert.equal(DECIDE_FALLBACK_THRESHOLD, 3);
});

test("buildDecisionPrompt lists spans with the marker and strict-JSON contract", () => {
    const q = buildDecisionPrompt(RANGES);
    assert.ok(q.startsWith("[bili-compress-decision]"));
    assert.ok(q.includes('{"compress": false}'));
    assert.ok(q.includes('"range": "mNNNNN-mNNNNN"'));
    assert.ok(q.includes("m00010\u2013m00020  11 msgs  12.0K [tool 80% | text 20%]"));
    assert.ok(q.includes("m00030\u2013m00040  11 msgs  3.0K [tool 10% | text 90%]"));
});

test("buildDecisionPrompt caps the span list and handles an empty view", () => {
    const many = Array.from({ length: 10 }, (_, i): CompressibleRange => ({
        startRef: `m${String(i * 10 + 1).padStart(5, "0")}`,
        endRef: `m${String(i * 10 + 9).padStart(5, "0")}`,
        count: 9,
        tokens: 1000 + i,
        toolPct: 50,
        textPct: 50,
    }));
    const q = buildDecisionPrompt(many);
    assert.ok(q.includes("m00001\u2013m00009"));
    assert.ok(!q.includes("m00091"));
    assert.ok(buildDecisionPrompt([]).includes("No pre-detected compressible spans"));
});

test("buildDirectiveText names the span and optional topic", () => {
    assert.ok(buildDirectiveText("m00010", "m00020").includes("[bili-compress-directive] Compress NOW"));
    assert.ok(buildDirectiveText("m00010", "m00020").includes("Target span: m00010\u2013m00020."));
    assert.ok(buildDirectiveText("m00010", "m00020", "old research").includes('(topic: "old research")'));
});

test("parseDecision accepts clean answers", () => {
    assert.deepEqual(parseDecision('{"compress": false}'), { kind: "no" });
    const yesPlain = parseDecision('{"compress": true}');
    assert.equal(yesPlain.kind, "yes");
    assert.equal(yesPlain.range, undefined);
    const yesRange = parseDecision('{"compress": true, "range": "m00010-m00020"}');
    assert.equal(yesRange.kind, "yes");
    assert.equal(yesRange.range, "m00010-m00020");
    const yesTopic = parseDecision('  {"compress": true, "topic": "  old research  "}  ');
    assert.equal(yesTopic.kind, "yes");
    assert.equal(yesTopic.topic, "old research");
    assert.deepEqual(parseDecision("```json\n{\"compress\": false}\n```"), { kind: "no" });
    const longTopic = "x".repeat(120);
    assert.equal((parseDecision(`{"compress": true, "topic": "${longTopic}"}`) as { topic?: string }).topic?.length, 80);
});

test("parseDecision rejects anything that is not one clean JSON verdict", () => {
    const cases: [string, string][] = [
        ["", "empty response"],
        ["sure, here you go: {\"compress\": true}", "not a bare JSON object"],
        ["[true]", "not a bare JSON object"],
        ["\"no\"", "not a bare JSON object"],
        ["{\"compress\":", "not a bare JSON object"],
        ["{\"compress\": }", "invalid JSON"],
        ["null", "not a bare JSON object"],
        ["{\"compress\": \"yes\"}", "compress must be boolean"],
        ["{\"compress\": true, \"range\": \"m10-m20\"}", "malformed range"],
        ["{\"compress\": true, \"range\": 42}", "malformed range"],
        ["{\"compress\": true, \"topic\": 7}", "topic must be a string"],
    ];
    for (const [raw, detail] of cases) {
        const out = parseDecision(raw);
        assert.equal(out.kind, "failed", `expected failed for ${JSON.stringify(raw)}`);
        const actual = out.kind === "failed" ? out.detail : "";
        assert.ok(actual.startsWith(detail), `detail ${JSON.stringify(actual)} should start with ${JSON.stringify(detail)}`);
    }
});

test("resolveDecisionRange finalizes against the live view only", () => {
    assert.equal(resolveDecisionRange({}, []), undefined);
    assert.deepEqual(resolveDecisionRange({}, RANGES), { startRef: "m00010", endRef: "m00020" });
    assert.deepEqual(resolveDecisionRange({ range: "m00030-m00035" }, RANGES), { startRef: "m00030", endRef: "m00040" });
    assert.deepEqual(resolveDecisionRange({ range: "m00015-m00035" }, RANGES), { startRef: "m00010", endRef: "m00020" });
    assert.deepEqual(resolveDecisionRange({ range: "m00900-m00999" }, RANGES), { startRef: "m00010", endRef: "m00020" });
    assert.deepEqual(resolveDecisionRange({ range: "garbage" }, RANGES), { startRef: "m00010", endRef: "m00020" });
    assert.deepEqual(resolveDecisionRange({ range: "m00040-m00030" }, RANGES), { startRef: "m00010", endRef: "m00020" });
});

test("failure ladder counts hard failures, resets on any parsed answer", () => {
    const meta: Record<string, unknown> = {};
    assert.equal(ladderMode(meta), "try");
    recordDecision(meta, false);
    recordDecision(meta, false);
    assert.equal(ladderMode(meta), "try");
    recordDecision(meta, false);
    assert.equal(ladderMode(meta), "fallback");
    recordDecision(meta, true);
    assert.equal(ladderMode(meta), "try");
});

test("extractDecisionText pulls the answer per protocol", () => {
    assert.equal(extractDecisionText("anthropic", null), "");
    assert.equal(
        extractDecisionText("anthropic", { content: [{ type: "text", text: '{"compress": false}' }, { type: "tool_use", name: "x", input: {} }] }),
        '{"compress": false}',
    );
    assert.equal(
        extractDecisionText("openai", { choices: [{ message: { role: "assistant", content: '{"compress": true}' } }] }),
        '{"compress": true}',
    );
    assert.equal(
        extractDecisionText("google", { candidates: [{ content: { parts: [{ text: '{"compress": ' }, { text: 'false}'}] } }] }),
        '{"compress": false}',
    );
    assert.equal(extractDecisionText("responses", { output_text: '{"compress": true}' }), '{"compress": true}');
    assert.equal(
        extractDecisionText("responses", { output: [{ type: "message", content: [{ type: "output_text", text: '{"compress": false}' }] }] }),
        '{"compress": false}',
    );
    assert.equal(extractDecisionText("responses", { output: [] }), "");
    assert.equal(extractDecisionText("anthropic", { content: [] }), "");
});

// #5030: the reasoning policy tri-state — "strip" must stay byte-identical
// to the pre-#5030 stripDecisionReasoningFields behavior (unset default),
// "follow" must keep the host's knobs verbatim, and "off" must strip AND
// stamp the protocol-native disable.
test("applyDecisionReasoningPolicy: strip (default) matches #3004 byte-for-byte", () => {
    const protocols = ["openai", "anthropic", "google", "responses"] as const;
    for (const p of protocols) {
        const a: Record<string, unknown> = { max_tokens: 1024, stream: false };
        const b: Record<string, unknown> = { max_tokens: 1024, stream: false };
        if (p === "openai") Object.assign(a, b, { reasoning_effort: "high", thinking: true });
        if (p === "anthropic") Object.assign(a, b, { thinking: { type: "enabled", budget_tokens: 2048 } });
        if (p === "google") {
            a.generationConfig = { thinkingConfig: { thinkingBudget: 1024 }, temperature: 0.7 };
            b.generationConfig = { thinkingConfig: { thinkingBudget: 1024 }, temperature: 0.7 };
        }
        if (p === "responses") Object.assign(a, b, { reasoning: { effort: "high" } });
        applyDecisionReasoningPolicy(p, a, "strip");
        stripDecisionReasoningFields(p, b);
        assert.deepEqual(a, b, `${p}: strip policy must equal the legacy #3004 strip`);
    }
});

test("applyDecisionReasoningPolicy: follow keeps host reasoning knobs verbatim", () => {
    const openai: Record<string, unknown> = { reasoning_effort: "low", thinking: true, max_tokens: 1024 };
    applyDecisionReasoningPolicy("openai", openai, "follow");
    assert.equal(openai.reasoning_effort, "low");
    assert.equal(openai.thinking, true);

    const anthropic: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 512 } };
    applyDecisionReasoningPolicy("anthropic", anthropic, "follow");
    assert.deepEqual(anthropic.thinking, { type: "enabled", budget_tokens: 512 });

    const google: Record<string, unknown> = { generationConfig: { thinkingConfig: { thinkingBudget: 256 }, temperature: 0.7 } };
    applyDecisionReasoningPolicy("google", google, "follow");
    assert.deepEqual((google.generationConfig as Record<string, unknown>).thinkingConfig, { thinkingBudget: 256 });

    const responses: Record<string, unknown> = { reasoning: { effort: "low" } };
    applyDecisionReasoningPolicy("responses", responses, "follow");
    assert.deepEqual(responses.reasoning, { effort: "low" });
});

test("applyDecisionReasoningPolicy: off strips then writes the protocol-native disable", () => {
    const openai: Record<string, unknown> = { reasoning_effort: "high", max_tokens: 1024 };
    applyDecisionReasoningPolicy("openai", openai, "off");
    assert.equal(openai.reasoning_effort, "none");

    const anthropic: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 2048 } };
    applyDecisionReasoningPolicy("anthropic", anthropic, "off");
    assert.deepEqual(anthropic.thinking, { type: "disabled" });

    const google: Record<string, unknown> = { generationConfig: { thinkingConfig: { thinkingBudget: 1024 }, temperature: 0.7 } };
    applyDecisionReasoningPolicy("google", google, "off");
    const gc = google.generationConfig as Record<string, unknown>;
    assert.deepEqual(gc.thinkingConfig, { includeThoughts: false, thinkingBudget: 0 });
    assert.equal(gc.temperature, 0.7, "non-reasoning generationConfig fields survive");

    const responses: Record<string, unknown> = { reasoning: { effort: "high" } };
    applyDecisionReasoningPolicy("responses", responses, "off");
    assert.deepEqual(responses.reasoning, { effort: "none" });
});
