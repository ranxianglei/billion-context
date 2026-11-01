import assert from "node:assert/strict";
import test from "node:test";
import { decideFastpath, parsePfCount, type FastpathGateInput } from "../src/server/fastpath-gate.ts";

// The all-satisfied baseline: every condition green ⇒ the fastpath is taken.
function base(): FastpathGateInput {
    return {
        rolloutEnabled: true,
        pluginMode: true,
        agent: "dsh",
        protocol: "openai",
        pfCountHeader: "42",
        storedWatermark: 42,
        storageReadable: true,
        divertConflict: false,
        circuitBroken: false,
        hasActiveBlocks: true,
    };
}

test("positive: all conditions satisfied takes the fastpath", () => {
    const d = decideFastpath(base());
    assert.deepEqual(d, { take: true, reason: "take" });
});

// Bidirectional matrix (#3617): one NEGATIVE row per gate condition — flip only
// that condition, keep everything else satisfied, and assert the decision is
// NOT-take AND names exactly that condition. The positive row above covers the
// other direction of every cell.
const negativeRows: [string, Partial<FastpathGateInput>, string][] = [
    ["circuit breaker tripped", { circuitBroken: true }, "circuit-broken"],
    ["another lane claimed the request", { divertConflict: true }, "divert-conflict"],
    ["rollout disabled", { rolloutEnabled: false }, "rollout-off"],
    ["not plugin mode", { pluginMode: false }, "not-plugin-mode"],
    ["agent out of PR#1 scope (pi)", { agent: "pi" }, "agent-out-of-scope"],
    ["agent absent", { agent: undefined }, "agent-out-of-scope"],
    ["protocol out of scope (anthropic)", { protocol: "anthropic" }, "protocol-out-of-scope"],
    ["protocol null", { protocol: null }, "protocol-out-of-scope"],
    ["no active fold blocks yet", { hasActiveBlocks: false }, "no-active-blocks"],
    ["count header missing", { pfCountHeader: undefined }, "header-missing"],
    ["count header empty", { pfCountHeader: "" }, "header-missing"],
    ["stored watermark never set", { storedWatermark: null }, "watermark-missing"],
    ["count does not match stored watermark", { pfCountHeader: "43", storedWatermark: 42 }, "watermark-mismatch"],
    ["storage not readable", { storageReadable: false }, "storage-unreadable"],
];

for (const [label, override, expectedReason] of negativeRows) {
    test(`negative: ${label} ⇒ not taken (${expectedReason})`, () => {
        const d = decideFastpath({ ...base(), ...override });
        assert.equal(d.take, false, label);
        assert.equal(d.reason, expectedReason, label);
    });
}

test("invalid count header shapes all degrade (never parse a bad K)", () => {
    for (const bad of ["abc", "-3", "3.5", "1e2", " 4", "4 ", "0x4", "+4", "", "\n"]) {
        const d = decideFastpath({ ...base(), pfCountHeader: bad });
        // empty string is classified as missing by the gate; the rest as invalid.
        assert.equal(d.take, false, `header ${JSON.stringify(bad)}`);
        assert.ok(["header-missing", "header-invalid"].includes(d.reason), `header ${JSON.stringify(bad)} → ${d.reason}`);
    }
});

test("parsePfCount: valid non-negative integers pass, anything else is null", () => {
    assert.equal(parsePfCount(undefined), null);
    assert.equal(parsePfCount(""), null);
    assert.equal(parsePfCount("0"), 0);
    assert.equal(parsePfCount("42"), 42);
    assert.equal(parsePfCount("123456789012"), 123456789012);
    assert.equal(parsePfCount("-1"), null);
    assert.equal(parsePfCount("1.0"), null);
    assert.equal(parsePfCount("1e3"), null);
    assert.equal(parsePfCount(" 1"), null);
    assert.equal(parsePfCount("1 "), null);
    assert.equal(parsePfCount("0x10"), null);
    assert.equal(parsePfCount("+1"), null);
    // Beyond safe-integer range is rejected rather than silently truncated.
    assert.equal(parsePfCount("99999999999999999999"), null);
});

test("precedence is fixed: an earlier check wins when several conditions fail", () => {
    // Circuit-breaker outranks everything (once broken, never re-arm).
    assert.equal(decideFastpath({ ...base(), circuitBroken: true, rolloutEnabled: false }).reason, "circuit-broken");
    // Divert outranks rollout.
    assert.equal(decideFastpath({ ...base(), divertConflict: true, rolloutEnabled: false }).reason, "divert-conflict");
    // Rollout outranks agent/protocol scope.
    assert.equal(decideFastpath({ ...base(), rolloutEnabled: false, agent: "pi" }).reason, "rollout-off");
    // Header validity is judged before watermark comparison.
    assert.equal(decideFastpath({ ...base(), pfCountHeader: "abc", storedWatermark: null }).reason, "header-invalid");
});
