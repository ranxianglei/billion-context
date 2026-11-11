import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import type { Session } from "../src/session.ts";
import {
    SELF_HEAL_WINDOW,
    evaluateSelfHealRound,
    nudgeSuppressed,
    pluginLaneDegraded,
} from "../src/session-self-heal.ts";

// #4578: self-heal counted INJECTED nudges, not ignored ones. The hook runs
// on every main request round (the kernel emits a NudgeDecision whether it
// injects or not; only injected/gated rounds carry nudgeActive=true), but a
// fold lands BETWEEN injections and its new block is first observed by an
// ordinary non-nudge round. That round consumed the reduction key WITHOUT
// resetting idleStreak, so the next injected round saw reduction=false and
// kept climbing — on plugin-route hosts (biliToolUses forever 0) exactly the
// 5th injected nudge armed "nudge idle for 5 rounds" even though compressions
// had landed in every window in between.

const noop = () => {};

function mkSession(): Session {
    return {
        id: "s1",
        metadata: {},
        state: { nextBlockId: 1 },
        lastCompress: undefined,
    } as unknown as Session;
}

const NUDGE_ROUND = { pluginHeaderPresent: false, biliToolsDeclared: true, nudgeActive: true, biliToolUses: 0, degradeAvailable: true };
const PLAIN_ROUND = { ...NUDGE_ROUND, nudgeActive: false };

test("unit: #4578 a fold landing in a non-nudge round resets the idle streak — obeyed nudges never arm", () => {
    const s = mkSession();
    for (let i = 0; i < SELF_HEAL_WINDOW; i++) {
        // Injected nudge, then the model obeys and folds: the new block is
        // first seen by the very next ordinary round (nudgeActive=false).
        evaluateSelfHealRound(s, NUDGE_ROUND, noop);
        s.state.nextBlockId += 1;
        evaluateSelfHealRound(s, PLAIN_ROUND, noop);
        assert.equal(nudgeSuppressed(s), false, `cycle ${i + 1}: an intervening compression is not an ignored nudge`);
        assert.equal(pluginLaneDegraded(s), false, `cycle ${i + 1}: no degrade either`);
    }
});

test("unit: #4578 a visible bili tool use seen on a non-nudge round also resets the idle streak", () => {
    const s = mkSession();
    for (let i = 0; i < SELF_HEAL_WINDOW; i++) {
        evaluateSelfHealRound(s, NUDGE_ROUND, noop);
        evaluateSelfHealRound(s, { ...PLAIN_ROUND, biliToolUses: 1 }, noop);
        assert.equal(nudgeSuppressed(s), false, `cycle ${i + 1}: tool use is engagement evidence wherever observed`);
    }
});

test("unit: #4578 non-nudge rounds without evidence are neutral — they neither reset nor earn credit", () => {
    const s = mkSession();
    for (let i = 0; i < SELF_HEAL_WINDOW - 1; i++) {
        evaluateSelfHealRound(s, NUDGE_ROUND, noop);
        evaluateSelfHealRound(s, PLAIN_ROUND, noop);
        assert.equal(nudgeSuppressed(s), false, `cycle ${i + 1}: window not reached`);
    }
    evaluateSelfHealRound(s, NUDGE_ROUND, noop);
    evaluateSelfHealRound(s, PLAIN_ROUND, noop);
    assert.equal(nudgeSuppressed(s), true, "five ignored nudges with quiet rounds between them still arm");
});

test("unit: five consecutive injected rounds with no evidence still arm (no over-correction)", () => {
    const s = mkSession();
    for (let i = 0; i < SELF_HEAL_WINDOW - 1; i++) {
        evaluateSelfHealRound(s, NUDGE_ROUND, noop);
        assert.equal(nudgeSuppressed(s), false, `round ${i + 1}: window not reached`);
    }
    const logs: string[] = [];
    evaluateSelfHealRound(s, NUDGE_ROUND, (l: string, m: string) => logs.push(`${l}:${m}`));
    assert.equal(nudgeSuppressed(s), true, "genuinely ignored five times: suppression arms");
    assert.equal((s.metadata.selfHeal as { detected: string }).detected, "nudge-idle");
    assert.ok(logs.some((x) => x.includes("nudge idle")), "arming is logged");
});
