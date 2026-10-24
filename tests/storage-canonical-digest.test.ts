import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalDigest, canonicalize, sha256 } from "../src/storage/canonical.ts";

function matchesLegacy(value: unknown): void {
    assert.equal(canonicalDigest(value), sha256(JSON.stringify(canonicalize(value))));
}

test("streaming digest preserves storage normalization and collection order", () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    matchesLegacy({
        metadata: { biliVersion: "0.1.204", storageMode: "full", savedAt: 1_700_000_000_000 },
        tailGaps: 3,
        state: { nextBlockId: 42, ids: new Set([uuid, "b2"]) },
        blockContents: new Map<unknown, unknown>([
            [uuid, { full: { text: "original" }, traceId: uuid }],
            [1_700_000_000_000, [null, true, false, -0, NaN, Infinity]],
            [{ storageMode: "raw map key", traceId: uuid }, new Map([["b1", "summary"]])],
        ]),
    });
    assert.notEqual(canonicalDigest(new Map([["b1", 1], ["b2", 2]])),
        canonicalDigest(new Map([["b2", 2], ["b1", 1]])));
});

test("streaming digest preserves JSON omissions, sparse arrays and property order", () => {
    matchesLegacy({ z: undefined, f: () => 1, s: Symbol("ignored"), a: [undefined, , Symbol("null")], "10": "ten", "2": "two" });
    matchesLegacy(JSON.parse('{"__proto__":{"ignored":true},"constructor":"kept","value":1}'));
    for (const value of [null, true, 0, "text", [], {}, new Map(), new Set()]) matchesLegacy(value);
});

test("streaming digest escapes long strings without splitting surrogate pairs", () => {
    matchesLegacy({
        text: "x".repeat(65_535) + "\uD83D\uDE80" + "\n\t\u0000\"\\\u4E2D\u6587".repeat(20_000),
        loneSurrogates: "\uD800" + "y".repeat(65_534) + "\uDC00",
        ["key\"\\\n\uD83D\uDE80"]: "escaped key",
    });
});

test("streaming digest changes when retained history changes", () => {
    const before = { blockContents: new Map([["b1", { full: { text: "original" } }]]) };
    const after = { blockContents: new Map([["b1", { full: { text: "changed" } }]]) };
    matchesLegacy(before);
    matchesLegacy(after);
    assert.notEqual(canonicalDigest(before), canonicalDigest(after));
});
