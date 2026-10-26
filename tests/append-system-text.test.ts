import assert from "node:assert";
import test from "node:test";
import { appendSystemText } from "../src/util.ts";
import type { AnthropicTextBlock } from "acp-kernel/wire";

// #1876: outbound Anthropic system reconstruction must APPEND bili's added
// text instead of merging client blocks into one (kernel buildSystem's old
// behavior broke downstream block-shape detection and relocated client
// cache_control marks). String/absent originals keep the legacy flat join
// byte-identical.

test("array original: client blocks ride out byte-exact, added text becomes ONE trailing unmarked text block", () => {
    const original: AnthropicTextBlock[] = [
        { type: "text", text: "x-anthropic-billing-header: attribution cc_entrypoint=cli" },
        { type: "text", text: "YOU_ARE_CLAUDE_CODE", cache_control: { type: "ephemeral" } },
        { type: "text", text: "REPO_CONVENTIONS" },
    ];
    const out = appendSystemText("COMPRESS_PROMPT", original);
    assert.ok(Array.isArray(out), "array stays array");
    const arr = out as typeof original & { length: number };
    assert.equal(arr.length, 4, "N client blocks + 1 appended block (no merge)");
    assert.deepEqual(arr.slice(0, 3), original, "client blocks byte-exact, order preserved");
    assert.deepEqual(original[1]?.cache_control, { type: "ephemeral" }, "client mark stays on its own block");
    assert.deepEqual(arr[3], { type: "text", text: "COMPRESS_PROMPT" }, "appended block carries only the added text, no mark, no separator");
});

test("array original: input not mutated, returned array is fresh", () => {
    const original: AnthropicTextBlock[] = [{ type: "text", text: "A" }];
    const out = appendSystemText("P", original);
    assert.notEqual(out, original, "new array reference");
    assert.equal((out as typeof original).length, 2);
    assert.equal(original.length, 1, "input untouched");
});

test("array original with image block: image survives byte-exact (old merge destroyed it into 'undefined' text)", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } };
    const original = [{ type: "text", text: "A" }, img];
    const out = appendSystemText("P", original as unknown as AnthropicTextBlock[]) as Array<typeof original[number]>;
    assert.deepEqual(out[1], img, "image block preserved verbatim");
    assert.deepEqual(out[2], { type: "text", text: "P" });
});

test("empty added on array original: shallow copy, no extra block", () => {
    const original: AnthropicTextBlock[] = [{ type: "text", text: "A" }];
    const out = appendSystemText("", original);
    assert.ok(Array.isArray(out));
    assert.deepEqual(out, original, "same content, no appended block");
    assert.notEqual(out, original, "still a fresh array (stamp-by-replacement hazard guard)");
});

test("string original: legacy flat join byte-identical (base + '\\n\\n---\\n\\n' + added)", () => {
    assert.equal(appendSystemText("P", "BASE"), "BASE\n\n---\n\nP");
});

test("absent/empty-string/empty-array original: added alone", () => {
    assert.equal(appendSystemText("P", undefined), "P");
    assert.equal(appendSystemText("P", ""), "P");
    assert.equal(appendSystemText("P", []), "P");
});

test("empty added with string/absent original: base alone (no dangling separator)", () => {
    assert.equal(appendSystemText("", "BASE"), "BASE");
    assert.equal(appendSystemText("", undefined), "");
});
