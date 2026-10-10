import test from "node:test";
import assert from "node:assert/strict";
import { resolveToolTimeoutMs } from "../src/agent/native-bootstrap.ts";

test("tool timeout default is 600s — one compression round can legitimately run minutes", () => {
    assert.equal(resolveToolTimeoutMs({}), 600_000);
});

test("tool timeout: a finite positive env value wins", () => {
    assert.equal(resolveToolTimeoutMs({ BILI_TOOL_TIMEOUT_MS: "120000" }), 120_000);
    assert.equal(resolveToolTimeoutMs({ BILI_TOOL_TIMEOUT_MS: "60000" }), 60_000);
    // envMillis floors fractional input
    assert.equal(resolveToolTimeoutMs({ BILI_TOOL_TIMEOUT_MS: "30000.9" }), 30_000);
});

test("tool timeout: blank/garbage/non-positive falls back to the default", () => {
    for (const bad of ["", "   ", "abc", "0", "-5", "NaN", "Infinity"]) {
        assert.equal(resolveToolTimeoutMs({ BILI_TOOL_TIMEOUT_MS: bad }), 600_000, `value ${JSON.stringify(bad)}`);
    }
});
