// #1615: shared surrogate-safe excerpt helpers. safePrefix/safeSuffix are the
// #816/#828 family fix (a raw slice can strand a lone surrogate at the cut,
// which JSON.stringify escapes as a bare \uXXXX that strict upstreams reject
// for the whole body); scrubLoneSurrogates covers inputs that already carry
// unpaired halves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safePrefix, safeSuffix, scrubLoneSurrogates } from "../src/text-safe.ts";

const E = "\u{1F4E5}";

test("safePrefix: plain cuts and pair-straddle back-off", () => {
    assert.equal(safePrefix("abcdef", 3), "abc");
    assert.equal(safePrefix("abcdef", 100), "abcdef");
    assert.equal(safePrefix("abcdef", 0), "");
    assert.equal(safePrefix(`ab${E}cd`, 3), "ab");
    assert.equal(safePrefix(`${E}cd`, 1), "");
    assert.equal(safePrefix(`ab${E}`, 4), `ab${E}`);
});

test("safeSuffix: plain cuts and pair-straddle advance", () => {
    assert.equal(safeSuffix("abcdef", 3), "def");
    assert.equal(safeSuffix("abcdef", 100), "abcdef");
    assert.equal(safeSuffix("abcdef", 0), "");
    assert.equal(safeSuffix(`abcd${E}`, 3), `d${E}`);
    assert.equal(safeSuffix(`c${E}ab`, 4), `${E}ab`);
    assert.equal(safeSuffix(`c${E}ab`, 3), "ab");
});

test("scrubLoneSurrogates: clean text passes through, unpaired halves become U+FFFD", () => {
    const clean = `prefix ${E} middle 中文 suffix`;
    assert.equal(scrubLoneSurrogates(clean), clean);
    assert.equal(scrubLoneSurrogates("\ud83d"), "\uFFFD");
    assert.equal(scrubLoneSurrogates("\udc00"), "\uFFFD");
    assert.equal(scrubLoneSurrogates(E), E);
    assert.equal(scrubLoneSurrogates("a\ud83db\udee5c"), "a" + "\uFFFD" + "b" + "\uFFFD" + "c");
});
