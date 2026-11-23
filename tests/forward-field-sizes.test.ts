import { test } from "node:test";
import assert from "node:assert/strict";
import { formatForwardFieldSizes } from "../src/preflight.ts";

test("#7587 lists top-level field sizes and marks transport-only DSH fields", () => {
    const line = formatForwardFieldSizes({
        messages: [],
        tools: [],
        dsh_session_log: "x".repeat(2048),
        dsh_plugin_packages: "{}",
    });

    assert.ok(line);
    assert.match(line, /messages=2B/);
    assert.match(line, /dsh_session_log=2KB \(non-prompt\)/);
    assert.match(line, /dsh_plugin_packages=4B \(non-prompt\)/);
});

test("#7587 stays silent for bodies that have no top-level object fields", () => {
    assert.equal(formatForwardFieldSizes(null), undefined);
    assert.equal(formatForwardFieldSizes([]), undefined);
    assert.equal(formatForwardFieldSizes("plain text"), undefined);
    assert.equal(formatForwardFieldSizes({}), undefined);
});