import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { diagNudge, nudgeDiagLogLevel } from "../src/server.ts";

// #5928 Part A (visibility): after a resume-miss the conversation lands on a
// fresh key whose meter reads 0 (no usage report, no prior-turn estimate)
// while pendingT1 already sits far over its T1 threshold — decideNudge is
// structurally idle for that turn and used to log it as an ordinary info
// line ("nudge idle: usage=0% … pendingT1=260393/50000"). These pin the
// visibility contract with both-direction gate assertions (#3617): warn and
// the baseline=unknown tag appear EXACTLY in the blind-backlog state and
// nowhere else, so healthy turns stay byte-identical.

const BLIND_TURN = {
    nudge: {
        shouldInject: false,
        reason: "max compressible 260393 < threshold 50000; growth 0 < floor 22500",
        contextUsage: 0,
        tier: null,
        breakdown: { growth: 0, growthFloor: 22500, nudgeGrowthTokens: 50000, pendingT1: 260393, growthReference: 0 },
    },
};

function withBreakdown(breakdown: Record<string, number>, shouldInject = false) {
    return { shouldInject, breakdown };
}

test("nudgeDiagLogLevel: warn only for blind meter with backlog at/over the T1 threshold", () => {
    // positive — the #5928 state
    assert.equal(nudgeDiagLogLevel(0, BLIND_TURN.nudge), "warn");
    // boundary — pendingT1 exactly at the interval still warns
    assert.equal(nudgeDiagLogLevel(0, withBreakdown({ ...BLIND_TURN.nudge.breakdown, pendingT1: 50000 })), "warn");
    // negative — a measured meter never warns, whatever the backlog
    assert.equal(nudgeDiagLogLevel(473091, BLIND_TURN.nudge), "info");
    assert.equal(nudgeDiagLogLevel(1, BLIND_TURN.nudge), "info");
    // negative — blind meter but the backlog is below threshold: an ordinary
    // fresh session, stay quiet
    assert.equal(nudgeDiagLogLevel(0, withBreakdown({ ...BLIND_TURN.nudge.breakdown, pendingT1: 49999 })), "info");
    // negative — blind meter but the nudge fires anyway: normal info line
    assert.equal(nudgeDiagLogLevel(0, { ...BLIND_TURN.nudge, shouldInject: true }), "info");
    // negative — no decision or degenerate breakdown
    assert.equal(nudgeDiagLogLevel(0, null), "info");
    assert.equal(nudgeDiagLogLevel(0, undefined), "info");
    assert.equal(nudgeDiagLogLevel(0, { shouldInject: false }), "info");
    assert.equal(nudgeDiagLogLevel(0, withBreakdown({})), "info");
});

test("diagNudge: names the unknown baseline iff the meter read 0", () => {
    const blind = diagNudge(BLIND_TURN, "sess-x", 0, 356250, "gpt-6.1-sol", false);
    assert.ok(blind.includes("usage=0% (0/356250)"), blind);
    assert.ok(blind.includes("pendingT1=260393/50000, baseline=unknown"), blind);
    const measured = diagNudge(BLIND_TURN, "sess-x", 135683, 356250, "gpt-6.1-sol", false);
    assert.ok(!measured.includes("baseline=unknown"), measured);
    assert.ok(measured.includes("pendingT1=260393/50000 model="), measured);
});
