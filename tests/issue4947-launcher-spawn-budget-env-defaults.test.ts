// Invalid spawn-budget env values must fall back to the built-in 60s budget
// (envMillis contract, #1365): a bad knob must never shrink or zero the
// budget. Separate file so this node --test process resolves the module
// constants with only the bad values set.

process.env.BILI_SPAWN_WAIT_MS = "not-a-number";
process.env.BILI_SLOW_START_GRACE_MS = "0";

import test from "node:test";
import assert from "node:assert/strict";

const { SPAWN_BUDGET_MS } = await import("../src/launcher.ts");

test("invalid BILI_SPAWN_WAIT_MS / BILI_SLOW_START_GRACE_MS fall back to the built-in budget", () => {
    assert.equal(SPAWN_BUDGET_MS, 60000);
});
