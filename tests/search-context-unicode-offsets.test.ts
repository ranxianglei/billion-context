import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, type CompressionBlock } from "acp-kernel";
import { executeSearchContext } from "../src/decompress-shared.ts";

function search(summary: string, query: string): string {
    const state = createInitialState();
    const block: CompressionBlock = {
        blockId: "b-unicode", runId: "test", tier: 1, topic: "Evidence", summary,
        directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
        compressedTokens: 0, createdAt: 0, survivedCount: 0, generation: "young", active: true,
    };
    state.blocks.push(block);
    const out = executeSearchContext({ query }, createCore(), state);
    assert.match(out.text, /^Found 1 block\(s\)/);
    return out.text.split("\n").find((line) => line.startsWith("  ")) ?? "";
}

test("positions a distant evidence window in the original summary after expanding lowercase characters", () => {
    const summary = "İ".repeat(400) + " needle-target original evidence";
    const preview = search(summary, "needle-target");
    assert.ok(preview.includes("【needle-target】 original evidence"), preview);
    assert.ok(preview.startsWith("  ... "));
});

test("highlights the original match after an expanding lowercase prefix in a short summary", () => {
    assert.equal(search("İİİİİ needle-target remains verbatim", "needle-target"), "  İİİİİ 【needle-target】 remains verbatim");
});

test("does not include following text when the matched term itself expands on lowercasing", () => {
    assert.equal(search("Visit İstanbul tomorrow", "İstanbul"), "  Visit 【İstanbul】 tomorrow");
});

test("maps an expanded code point back to one original character", () => {
    assert.equal(search("İNDIGO", "i"), "  【İ】NDIGO");
});

test("retains ordinary case-insensitive evidence highlighting", () => {
    assert.equal(search("before NeEdLe after", "needle"), "  before 【NeEdLe】 after");
});

test("retains whole-string lowercase matching for contextual Greek final sigma", () => {
    assert.equal(search("before ΟΣ after", "ος"), "  before 【ΟΣ】 after");
});

test("keeps astral prefix and match characters intact", () => {
    assert.equal(search("İ😀 𐐀𐐁 remains", "𐐨𐐩"), "  İ😀 【𐐀𐐁】 remains");
});
