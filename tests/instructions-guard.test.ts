import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    checkInstructionsOverflow,
    dedupInstructionsKeepLatest,
    RESPONSES_INSTRUCTIONS_CHAR_LIMIT,
} from "../src/instructions-guard.js";

describe("checkInstructionsOverflow", () => {
    it("returns null when parsed is null", () => {
        assert.equal(checkInstructionsOverflow(null), null);
    });

    it("returns null when parsed is not an object", () => {
        assert.equal(checkInstructionsOverflow("string"), null);
        assert.equal(checkInstructionsOverflow(42), null);
        assert.equal(checkInstructionsOverflow(undefined), null);
    });

    it("returns null when instructions field is absent", () => {
        assert.equal(checkInstructionsOverflow({ model: "gpt-4" }), null);
    });

    it("returns null when instructions is not a string", () => {
        assert.equal(checkInstructionsOverflow({ instructions: 42 }), null);
        assert.equal(checkInstructionsOverflow({ instructions: null }), null);
        assert.equal(checkInstructionsOverflow({ instructions: {} }), null);
    });

    it("returns null when instructions is under the limit", () => {
        const body = { instructions: "a".repeat(RESPONSES_INSTRUCTIONS_CHAR_LIMIT - 1) };
        assert.equal(checkInstructionsOverflow(body), null);
    });

    it("returns null when instructions is exactly at the limit", () => {
        const body = { instructions: "a".repeat(RESPONSES_INSTRUCTIONS_CHAR_LIMIT) };
        assert.equal(checkInstructionsOverflow(body), null);
    });

    it("returns overflow info when instructions exceeds the limit (positive)", () => {
        const overflowLen = RESPONSES_INSTRUCTIONS_CHAR_LIMIT + 100;
        const body = { instructions: "a".repeat(overflowLen) };
        const result = checkInstructionsOverflow(body);
        assert.notEqual(result, null);
        assert.equal(result!.length, overflowLen);
        assert.equal(result!.limit, RESPONSES_INSTRUCTIONS_CHAR_LIMIT);
    });

    it("returns overflow info for a realistic DSH accumulation (19 copies × ~100KB)", () => {
        // Simulate 19 copies of a ~100KB system prompt joined by \n\n
        const copy = "x".repeat(100_000);
        const instructions = Array(19).fill(copy).join("\n\n");
        const body = { instructions };
        const result = checkInstructionsOverflow(body);
        assert.notEqual(result, null);
        assert.ok(result!.length > RESPONSES_INSTRUCTIONS_CHAR_LIMIT);
        assert.equal(result!.limit, RESPONSES_INSTRUCTIONS_CHAR_LIMIT);
    });
});

describe("dedupInstructionsKeepLatest", () => {
    it("returns unmodified when parsed is null", () => {
        const result = dedupInstructionsKeepLatest(null);
        assert.equal(result.modified, false);
        assert.equal(result.body, null);
    });

    it("returns unmodified when parsed is not an object", () => {
        const result = dedupInstructionsKeepLatest("string");
        assert.equal(result.modified, false);
        assert.equal(result.body, "string");
    });

    it("returns unmodified when instructions field is absent", () => {
        const body = { model: "gpt-4" };
        const result = dedupInstructionsKeepLatest(body);
        assert.equal(result.modified, false);
        assert.equal(result.body, body);
    });

    it("returns unmodified when instructions is not a string", () => {
        const body = { instructions: 42 };
        const result = dedupInstructionsKeepLatest(body);
        assert.equal(result.modified, false);
        assert.equal(result.body, body);
    });

    it("returns unmodified when instructions is under the limit (negative)", () => {
        const body = { instructions: "system prompt" };
        const result = dedupInstructionsKeepLatest(body);
        assert.equal(result.modified, false);
        assert.equal(result.body, body);
    });

    it("returns unmodified when instructions has no \\n\\n separator (negative)", () => {
        // A single long copy with no \n\n separator — nothing to dedup
        const body = { instructions: "a".repeat(RESPONSES_INSTRUCTIONS_CHAR_LIMIT + 100) };
        const result = dedupInstructionsKeepLatest(body);
        assert.equal(result.modified, false);
        assert.equal(result.body, body);
    });

    it("dedupes to the last part when instructions has \\n\\n separators (positive)", () => {
        // Simulate 3 copies joined by \n\n, total exceeds the limit
        const copy1 = "A".repeat(400_000);
        const copy2 = "B".repeat(400_000);
        const copy3 = "C".repeat(300_000);
        const instructions = [copy1, copy2, copy3].join("\n\n");
        assert.ok(instructions.length > RESPONSES_INSTRUCTIONS_CHAR_LIMIT);

        const body = { instructions, model: "gpt-4" };
        const result = dedupInstructionsKeepLatest(body);
        assert.equal(result.modified, true);
        const deduped = result.body as Record<string, unknown>;
        assert.equal(deduped.instructions, copy3);
        assert.equal(deduped.model, "gpt-4");
        // Original object is not mutated
        assert.equal(body.instructions, instructions);
    });

    it("rescues a realistic DSH session (19 copies × ~100KB → keep last ~100KB)", () => {
        // Simulate 19 copies of a ~100KB system prompt joined by \n\n
        const copies: string[] = [];
        for (let i = 0; i < 19; i++) {
            copies.push(`SYSTEM_PROMPT_COPY_${i} ` + "x".repeat(100_000));
        }
        const instructions = copies.join("\n\n");
        const body = { instructions };

        const overflow = checkInstructionsOverflow(body);
        assert.notEqual(overflow, null);

        const result = dedupInstructionsKeepLatest(body);
        assert.equal(result.modified, true);
        const deduped = result.body as Record<string, unknown>;
        const dedupedInstructions = deduped.instructions as string;
        // The last part is the last copy (or a fragment if the copy itself
        // contains \n\n — in this test it doesn't, so it's the full last copy)
        assert.ok(dedupedInstructions.length < instructions.length);
        assert.ok(dedupedInstructions.startsWith("SYSTEM_PROMPT_COPY_18"));
        // The deduped instructions should be well under the limit
        assert.ok(dedupedInstructions.length <= RESPONSES_INSTRUCTIONS_CHAR_LIMIT);
    });

    it("handles the edge case where the last part is not shorter (no-op)", () => {
        // If the split produces only one part (no \n\n found), no dedup
        const body = { instructions: "a".repeat(RESPONSES_INSTRUCTIONS_CHAR_LIMIT + 10) };
        const result = dedupInstructionsKeepLatest(body);
        assert.equal(result.modified, false);
    });

    it("does not mutate the input object", () => {
        const instructions = "A".repeat(600_000) + "\n\n" + "B".repeat(600_000);
        const body = { instructions, other: "field" };
        const result = dedupInstructionsKeepLatest(body);
        assert.equal(result.modified, true);
        // Original is unchanged
        assert.equal(body.instructions, instructions);
        assert.equal(body.other, "field");
        // New object has the deduped instructions
        const deduped = result.body as Record<string, unknown>;
        assert.notEqual(deduped, body);
        assert.equal(deduped.instructions, "B".repeat(600_000));
        assert.equal(deduped.other, "field");
    });
});

describe("RESPONSES_INSTRUCTIONS_CHAR_LIMIT", () => {
    it("is 1,048,576 (the OpenAI Responses API hard limit)", () => {
        assert.equal(RESPONSES_INSTRUCTIONS_CHAR_LIMIT, 1_048_576);
    });
});
