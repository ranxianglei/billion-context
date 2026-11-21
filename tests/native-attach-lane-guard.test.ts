// #5241 phase 1: the one-lane-per-process guard that native-attach.ts adds on
// top of the transplanted lifecycle. The guard exists because two armed lanes
// in one process overwrite each other's BILLION_CONTEXT_PROXY and fetch
// intercept (observed in the #5242 phase-0 stakes) — same lane re-arming is
// the normal test/restart pattern and must stay legal.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { armNativeLane, _resetArmedLaneForTest } from "../src/agent/native-attach.ts";

afterEach(() => {
    _resetArmedLaneForTest();
});

test("armNativeLane: re-arming the SAME lane is fine (tests and restarts do it)", () => {
    armNativeLane("pi");
    armNativeLane("pi");
    armNativeLane("pi");
});

test("armNativeLane: a second, DIFFERENT lane throws a plain-language error", () => {
    armNativeLane("pi");
    assert.throws(
        () => armNativeLane("opencode"),
        /one-per-process.*"pi".*"opencode".*BILLION_CONTEXT_PROXY/s,
    );
});

test("armNativeLane: _resetArmedLaneForTest clears the guard", () => {
    armNativeLane("pi");
    _resetArmedLaneForTest();
    armNativeLane("dsh");
});
