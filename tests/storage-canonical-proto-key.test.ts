import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalDigest, canonicalize, sha256 } from "../src/storage/canonical.ts";

test("canonical storage views preserve an own __proto__ field without changing the prototype", () => {
    const input: unknown = JSON.parse('{"text":"kept","__proto__":{"text":"original"}}');
    const output = canonicalize(input) as Record<string, unknown>;
    assert.equal(Object.hasOwn(output, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(output), Object.prototype);
    assert.equal(JSON.stringify(output), '{"__proto__":{"text":"original"},"text":"kept"}');
});

test("storage digests distinguish changes and deletion of __proto__ content", () => {
    const before: unknown = JSON.parse('{"__proto__":{"value":"original"},"text":"kept"}');
    const changed: unknown = JSON.parse('{"__proto__":{"value":"changed"},"text":"kept"}');
    const missing = { text: "kept" };
    assert.notEqual(canonicalDigest(before), canonicalDigest(changed));
    assert.notEqual(canonicalDigest(before), canonicalDigest(missing));
    for (const value of [before, changed, missing]) {
        assert.equal(canonicalDigest(value), sha256(JSON.stringify(canonicalize(value))));
    }
});

test("scalar and nested prototype-named fields remain part of retained tool content", () => {
    const makeView = (value: string) => ({
        blockContents: new Map([["b1", { full: JSON.parse(`{"tool":{"arguments":{"__proto__":${value}}}}`) as unknown }]]),
    });
    const digests = ["null", "false", "0", '"original"', '{"nested":true}'].map((value) => canonicalDigest(makeView(value)));
    assert.equal(new Set(digests).size, digests.length);
});

test("ordinary canonical key order and excluded storage provenance stay unchanged", () => {
    const first = { text: "same", constructor: "data", nested: { b: 2, a: 1 }, storageMode: "full", tailGaps: 4 };
    const second = { nested: { a: 1, b: 2 }, constructor: "data", text: "same", storageMode: "shadow", tailGaps: 0 };
    assert.equal(canonicalDigest(first), canonicalDigest(second));
    assert.equal(canonicalDigest(first), sha256('{"constructor":"data","nested":{"a":1,"b":2},"text":"same"}'));
});
