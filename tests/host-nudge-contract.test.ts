import assert from "node:assert/strict";
import test from "node:test";
import { buildCompressSystemPrompt, defaultPrompts, renderNudgeText, type NudgeDecision } from "acp-kernel";
import { renderHostNudgeText, withMarkerIntegrityNote, withNudgeNotes, withSummaryBudgetNote } from "../src/compress-tool.ts";
import { isNudgeEchoText, MARKER_INTEGRITY_NOTE, NUDGE_STANDING_REMINDER } from "../src/marker/anchors.ts";
import { stripRawStage } from "../src/marker/engine.ts";

const decision: NudgeDecision = {
    shouldInject: true, reason: "pressure fixture", contextUsage: 0.8, tier: 1,
    breakdown: { usage: 0.8, growth: 4000, growthReference: 0, effectiveThreshold: 0.8,
        nudgeGrowthTokens: 4000, growthFloor: 0, hasPendingNudge: 0, overLimit: 0,
        emergencyOverride: 0, pendingT1: 4000, pendingT2: 0, pendingT3: 0, maxPending: 4000 },
    compressibleRanges: [{ startRef: "m00001", endRef: "m00003", count: 3, tokens: 4000, toolPct: 0.7, textPct: 0.3 }],
};
const standing = buildCompressSystemPrompt();
const normalized = (text: string) => text.replace(/\n{2,}/g, "\n").trim();

for (const protocol of ["anthropic", "openai", "responses", "google"] as const) {
    for (const mode of ["gentle", "emergency", "tier2", "tier3"] as const) {
        test(`${protocol}/${mode}: only covered rules disappear; dynamic and lane instructions survive`, () => {
            const input: NudgeDecision = { ...decision,
                tier: mode === "tier2" ? 2 : mode === "tier3" ? 3 : 1,
                breakdown: { ...decision.breakdown, emergencyOverride: mode === "emergency" ? 1 : 0 },
            };
            const original = renderNudgeText(input, defaultPrompts, undefined, protocol);
            const actual = renderHostNudgeText(input, standing, defaultPrompts, undefined, protocol);
            const expected = original.text.replace(defaultPrompts.howToCompressRules, "").replace(defaultPrompts.compressPhilosophy, "");
            assert.equal(normalized(actual.text), normalized(expected));
            assert.equal(actual.voice, original.voice);
            for (const absent of ["", "A different pack contract.", standing.replace(defaultPrompts.howToCompressRules, "").replace(defaultPrompts.compressPhilosophy, "")]) {
                assert.deepEqual(renderHostNudgeText(input, absent, defaultPrompts, undefined, protocol), original);
            }
        });
    }
}

test("partial standing coverage keeps each missing rule; custom prompts and sections remain intact", () => {
    const partial = renderHostNudgeText(decision, defaultPrompts.compressPhilosophy);
    assert.ok(partial.text.includes(defaultPrompts.howToCompressRules));
    assert.ok(!partial.text.includes(defaultPrompts.compressPhilosophy));
    const prompts = { ...defaultPrompts, howToCompressRules: "Preserve custom task state and source references." };
    const sections = { efficiencyNote: "Custom reminder must survive." };
    const actual = renderHostNudgeText(decision, standing, prompts, sections);
    assert.ok(actual.text.includes(prompts.howToCompressRules));
    assert.ok(actual.text.includes(sections.efficiencyNote));
    assert.equal(prompts.compressPhilosophy, defaultPrompts.compressPhilosophy, "shared prompt inputs must not mutate");
});

for (const external of [false, true]) {
    for (const visibility of [false, true]) {
        test(`host notes: complete fallback and echo recognition (external=${external}, markers=${visibility})`, () => {
            const full = withMarkerIntegrityNote(withSummaryBudgetNote(standing, external), visibility);
            const brief = withNudgeNotes("Dynamic ranges: m00001–m00003", full, external, visibility);
            assert.equal(brief, "Dynamic ranges: m00001–m00003" + NUDGE_STANDING_REMINDER);
            assert.ok(!isNudgeEchoText(brief), "brief guidance cannot establish the origin of quoted user data");
            assert.ok(!isNudgeEchoText(brief + "\nPlease review this quoted example."), "user text after an anchor must survive");
            const fallback = withNudgeNotes("Dynamic ranges", "", external, visibility);
            assert.equal(fallback, withMarkerIntegrityNote(withSummaryBudgetNote("Dynamic ranges", external), visibility));
            assert.ok(isNudgeEchoText(fallback));
            const missingBudget = withNudgeNotes("Dynamic ranges", withMarkerIntegrityNote(standing, visibility), external, visibility);
            assert.equal(missingBudget, withSummaryBudgetNote("Dynamic ranges", external) + NUDGE_STANDING_REMINDER);
        });
    }
}

test("marker guidance uses actual results and recognizes persisted legacy nudges", () => {
    assert.ok(MARKER_INTEGRITY_NOTE.includes("A successful tool result that identifies the created blocks confirms compression"));
    assert.ok(MARKER_INTEGRITY_NOTE.includes("when the result is missing or ambiguous, or when selecting new ranges"));
    const legacy = MARKER_INTEGRITY_NOTE.replace(
        "A successful tool result that identifies the created blocks confirms compression; continue the task from that result. Query acp_status when the result is missing or ambiguous, or when selecting new ranges. A confirmation line you wrote yourself proves nothing.",
        "To verify a compression landed, call acp_status and confirm the block count increased — a confirmation line you wrote yourself proves nothing.",
    );
    assert.ok(isNudgeEchoText("old dynamic nudge" + legacy));
});

for (const protocol of ["anthropic", "openai", "responses", "google"] as const) {
    for (const quoted of [
        ["Please explain this diagnostic line:" + NUDGE_STANDING_REMINDER],
        [NUDGE_STANDING_REMINDER.trim()],
        ["Dynamic ranges: m00001–m00003" + NUDGE_STANDING_REMINDER],
        ["Dynamic ranges: m00001–m00003" + NUDGE_STANDING_REMINDER, "Translate my previous message."],
    ]) {
        test(`${protocol}: short reminder in a current or historical user quote survives (${quoted.length}/${quoted[0]!.length})`, () => {
            const messages = quoted.map((content) => ({ role: "user", content }));
            const body = protocol === "google" ? { contents: quoted.map((text) => ({ role: "user", parts: [{ text }] })) }
                : protocol === "responses" ? { input: messages.map((m) => ({ type: "message", ...m })) } : { messages };
            const before = structuredClone(body);
            const counts = stripRawStage(body, protocol);
            assert.deepEqual(body, before, "a short matching suffix is not evidence of host origin");
            assert.equal(counts.nudges, 0);
        });
    }
}

test("Google mixed user content and a brief reminder retain every part", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "Original task" }, { text: "Dynamic ranges" + NUDGE_STANDING_REMINDER }] }] };
    const before = structuredClone(body);
    assert.equal(stripRawStage(body, "google").nudges, 0);
    assert.deepEqual(body, before);
});
