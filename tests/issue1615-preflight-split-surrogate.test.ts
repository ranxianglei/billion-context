// #1615 family (review addition to PR #1618): splitSummaryContent cuts rendered
// content at raw token-budget offsets; a budget boundary landing between the two
// halves of an astral char stranded a lone surrogate in the ephemeral
// summarization request body, which strict upstreams reject for the whole body.
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSummaryContent } from "../src/preflight.ts";

const E = "\u{1F4E5}";
const identity = (t: string) => t.length;

function hasUnpairedSurrogate(s: string): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
            if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
            i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            const p = i > 0 ? s.charCodeAt(i - 1) : 0;
            if (!(p >= 0xd800 && p <= 0xdbff)) return true;
        }
    }
    return false;
}

test("splitSummaryContent: budget boundary straddling a pair steps back, no data loss", () => {
    const content = "a".repeat(9) + E + "b".repeat(50);
    const chunks = splitSummaryContent(content, 10, identity);
    assert.ok(chunks.every((c) => !hasUnpairedSurrogate(c)));
    assert.equal(chunks.join(""), content);
    assert.equal(chunks[0], "a".repeat(9));
    assert.equal(chunks[1], E + "b".repeat(8));
});

test("splitSummaryContent: pair fully inside the window is preserved verbatim", () => {
    const content = "a".repeat(8) + E + "b".repeat(92);
    const chunks = splitSummaryContent(content, 10, identity);
    assert.ok(chunks.every((c) => !hasUnpairedSurrogate(c)));
    assert.equal(chunks.join(""), content);
    assert.equal(chunks[0], "a".repeat(8) + E);
});

test("splitSummaryContent: clean ASCII content is byte-identical to naive slicing", () => {
    const content = "x".repeat(100);
    const chunks = splitSummaryContent(content, 10, identity);
    assert.deepEqual(chunks, Array.from({ length: 10 }, () => "x".repeat(10)));
});
