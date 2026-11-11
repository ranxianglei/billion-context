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
