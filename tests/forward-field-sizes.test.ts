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

    // Exact format pinned: prompt fields carry NO marker, dsh_* fields carry
    // exactly one (both directions of the #7587 gate).
    assert.equal(line, "messages=2B, tools=2B, dsh_session_log=2KB (non-prompt), dsh_plugin_packages=4B (non-prompt)");
});

test("#7587 stays silent for bodies that have no top-level object fields", () => {
    assert.equal(formatForwardFieldSizes(null), undefined);
    assert.equal(formatForwardFieldSizes([]), undefined);
    assert.equal(formatForwardFieldSizes("plain text"), undefined);
    assert.equal(formatForwardFieldSizes({}), undefined);
});
