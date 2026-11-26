/**
 * #5415 (host side): absorbAbortedTurnGrowth() must bank the MEASURED growth
 * it skips AND count the absorbs. Before this fix the re-anchor to the
 * current meter silently zeroed growth from the old reference up to the
 * pre-abort anchor — real, usage-grade growth — on every user abort.
 * Abort-heavy clients (85 absorbs in one 4.5h log) starved the nudge
 * cadence and compressed only at ~330K backlog. The kernel pays
 * state.nudge.absorbedDebt into the growth floor only from absorbCount >= 2
 * (kernel/tests/issue5415-absorb-debt-nudge.test.ts pins that a SINGLE
 * absorb stays exactly as quiet as #5293); this file pins the host-side
 * booking arithmetic — debt + count — and its edge cases.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ABORT_REANCHOR_MAX_AGE_MS,
    absorbAbortedTurnGrowth,
    noteAbortedTurn,
} from "../src/session.ts";

import type { Session } from "../src/session.ts";

const makeSession = (reference: number, lastInputTokens: number): Session =>
    ({
        id: "s5415",
        stats: { lastInputTokens },
        state: {
            nudge: {
                lastPerMessageNudgeTokens: reference,
                lastNudgeShownTokens: 12_000,
                baselineTokens: 0,
                anchors: {},
                lastShownByTier: { 1: 12_000 },
            },
        },
        transient: {} as Session["transient"],
    }) as unknown as Session;

test("5415: absorb banks the skipped measured growth (anchor − reference)", () => {
    const s = makeSession(50_000, 60_000); // reference 50k, aborted input 60k
    noteAbortedTurn(s); // anchor = 60_000
    absorbAbortedTurnGrowth(s, 70_000); // meter moved past the anchor
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 70_000, "reference still re-anchors to the meter (#5293 shape)");
    assert.equal(s.state.nudge.absorbedDebt, 10_000, "skipped measured growth (60k − 50k) is banked");
    assert.equal(s.state.nudge.absorbCount, 1, "the absorb is counted; the kernel pays only from the second one on");
    // #5293 shape kept: the pending nudge died with its turn.
    assert.equal(s.state.nudge.lastNudgeShownTokens, 0);
    assert.deepEqual(s.state.nudge.lastShownByTier, {});
});

test("5415: repeated aborts accumulate the debt — starvation is bounded", () => {
    const s = makeSession(50_000, 60_000);
    noteAbortedTurn(s);
    absorbAbortedTurnGrowth(s, 70_000); // banks 60k − 50k = 10k
    // +3k of real growth happens, THEN another abort at input 73k, absorbed at 75k
    s.stats.lastInputTokens = 73_000;
    noteAbortedTurn(s);
    absorbAbortedTurnGrowth(s, 75_000); // banks 73k − 70k = 3k
    s.stats.lastInputTokens = 80_000;
    noteAbortedTurn(s);
    absorbAbortedTurnGrowth(s, 82_000); // banks 80k − 75k = 5k
    assert.equal(s.state.nudge.absorbedDebt, 18_000, "debt accumulates across absorbs until a compression resets it");
    assert.equal(s.state.nudge.absorbCount, 3, "every absorb counts; count >= 2 unlocks the kernel-side debt/drain");
});

test("5415: reference already past the anchor banks nothing (nothing was skipped)", () => {
    const s = makeSession(90_000, 85_000); // reference 90k > anchor 85k
    noteAbortedTurn(s);
    absorbAbortedTurnGrowth(s, 95_000);
    assert.equal(s.state.nudge.absorbedDebt, undefined, "no measured growth was skipped — politeness only");
    assert.equal(s.state.nudge.absorbCount, 1, "the abort still counts — repeated politeness-only aborts unlock the drain too");
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 95_000);
});

test("5415: flag survives while the meter has not passed the anchor", () => {
    const s = makeSession(50_000, 60_000);
    noteAbortedTurn(s);
    absorbAbortedTurnGrowth(s, 58_000); // still below the anchor
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 50_000, "no re-anchor yet");
    assert.equal(s.state.nudge.absorbedDebt, undefined);
    assert.ok(s.transient?.abortReanchor, "flag waits for the meter to move past the anchor");
});

test("5415: stale flag (older than ABORT_REANCHOR_MAX_AGE_MS) is dropped untouched", () => {
    const s = makeSession(50_000, 60_000);
    noteAbortedTurn(s);
    s.transient!.abortReanchor!.at = Date.now() - ABORT_REANCHOR_MAX_AGE_MS - 1;
    absorbAbortedTurnGrowth(s, 70_000);
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 50_000);
    assert.equal(s.state.nudge.absorbedDebt, undefined);
});
