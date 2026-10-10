// #2302 as shipped in v0.1.188+: the one-call reminder is a STATIC line on
// every surface the model reads — renderNudgeText (all wire lanes), the
// post-compress receipt tail — and NOTHING on query-only surfaces
// (acp_status lists ranges, no compress prompting). The expanded skeleton
// grew linearly with the range count and read like a mandatory to-do list;
// these tests pin the static contract from the bili side, including a
// round-trip through the REAL compress parser: the plain-string form the
// hint describes must still parse as a one-string batch once the model
// writes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE_CALL_HINT, renderNudgeText } from "acp-kernel";
import type { CompressibleRange, NudgeDecision } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";

function range(start: number, end: number): CompressibleRange {
    return { startRef: `m${String(start).padStart(5, "0")}`, endRef: `m${String(end).padStart(5, "0")}`, tokens: 1000 } as unknown as CompressibleRange;
}

function makeDecision(overrides: Partial<NudgeDecision> = {}): NudgeDecision {
    return {
        shouldInject: true,
        reason: "test",
        compressibleRanges: [
            range(1, 42),
            range(50, 121),
            range(130, 201),
        ],
        contextUsage: 0.99,
        tier: null,
        breakdown: { emergencyOverride: 1 },
        ...overrides,
    } as NudgeDecision;
}

test("#2302: hint is static — no skeleton markers, fixed shape (#2587 strict-JSON wording)", () => {
    assert.ok(ONE_CALL_HINT.startsWith("ONE call"), "framing");
    assert.ok(ONE_CALL_HINT.includes("OBJECT ARRAY"), "object array is the preferred form");
    assert.ok(ONE_CALL_HINT.includes("quoted JSON string"), "string form stays legal but quoted");
    assert.ok(!ONE_CALL_HINT.includes("<topic>"), "no skeleton header slot");
    assert.ok(!ONE_CALL_HINT.includes("<write your summary"), "no summary slot");
    assert.ok(ONE_CALL_HINT.includes("reappear in later nudges"), "deferral stays licensed");
    assert.ok(ONE_CALL_HINT.includes("never split the batch across separate calls"), "one-call discipline stays");
});

test("#2302: emergency nudge carries the hint; it never grows with range count", () => {
    const few = renderNudgeText(makeDecision({ compressibleRanges: [range(1, 2)] }));
    const many = renderNudgeText(makeDecision({ compressibleRanges: Array.from({ length: 24 }, (_, i) => range(i * 10 + 1, i * 10 + 9)) }));
    for (const text of [few.text, many.text]) {
        assert.ok(text.includes("fold every range you keep into a single compress call"), "hint rides");
        assert.ok(!text.includes("<write your summary of this range>"), "no expanded skeleton");
    }
    const occurrences = many.text.split("fold every range you keep into a single compress call").length - 1;
    assert.equal(occurrences, 1, "hint appears exactly once regardless of range count");
});

test("#2302: the plain-string form the hint describes still round-trips through the real compress parser", () => {
    // the model writes the line form itself — the hint only DESCRIBES it
    const handWritten =
        "m00001–m00042 topic one\nsummary body long enough for the minimum length check\n\nm00050–m00121 topic two\nanother summary body long enough for the minimum length check";
    const parsed = parseCompressInput({ content: handWritten });
    assert.equal(parsed.ranges.length, 2, "one string → both ranges");
    assert.equal(parsed.ranges[0]?.startRef, "m00001");
    assert.equal(parsed.ranges[0]?.endRef, "m00042");
    assert.equal(parsed.ranges[1]?.startRef, "m00050");
    assert.equal(parsed.ranges[1]?.endRef, "m00121");
    assert.ok(parsed.ranges.every((r) => (r.summary ?? "").includes("summary body long enough")), "line-form bodies become summaries");
});
