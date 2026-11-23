import assert from "node:assert/strict";
import test from "node:test";
import { hammingHex, simhashHex } from "../src/affinity-simhash.ts";

test("SimHash retains repeated-shingle votes throughout the feature budget", () => {
    for (const word of ["alpha", "部署"]) {
        const expected = simhashHex(`${word} ${word}`);
        for (const features of [1, 127, 128, 129, 255, 256, 257, 511, 512]) {
            const actual = simhashHex(Array(features + 1).fill(word).join(" "));
            assert.equal(actual, expected, `${word}: ${features} shingles`);
        }
    }
});

test("unrelated repeated messages keep distinct sketches at the sampling cap", () => {
    const first = simhashHex(Array(257).fill("alpha").join(" "));
    const second = simhashHex(Array(257).fill("omega").join(" "));
    assert.notEqual(first, second);
    assert.equal(hammingHex(first, second), hammingHex(simhashHex("alpha alpha"), simhashHex("omega omega")));
});

test("SimHash sampling preserves persisted sketches across stride boundaries", () => {
    // Captured from the original full-shingle implementation. Distinct tokens
    // make a shifted sample observable, unlike a repeated-shingle fixture.
    const sketches: [number, string][] = [
        [2, "896b965e996b0ce5"],
        [128, "015bb052e72a4ca9"],
        [255, "017b4012ee3a4d91"],
        [256, "037b4012ee3a4d91"],
        [257, "037b4012ee3a4d91"],
        [258, "00486102fe224e09"],
        [511, "00880302ffbac609"],
        [512, "00880102ff3ac609"],
        [513, "00880102ff3ac609"],
        [100_000, "009213c27f3acc29"],
    ];
    for (const [count, expected] of sketches) {
        const canonical = Array.from({ length: count }, (_, i) => `word${i % 997}`).join(" ");
        assert.equal(simhashHex(canonical), expected, `${count} tokens`);
    }
    const unicode = Array.from({ length: 1025 }, (_, i) => `中${i % 257}é`).join(" ");
    assert.equal(simhashHex(unicode), "568a84089d1b5303");
    assert.equal(simhashHex(""), "1f2be47c811c9dc5");
    assert.equal(simhashHex("!!! 😀"), "74c4a446e2763713");
    assert.equal(simhashHex("唯一"), "50817b0bf9fa05fa");
});
