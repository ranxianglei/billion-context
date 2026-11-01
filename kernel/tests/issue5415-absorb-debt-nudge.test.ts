/**
 * #5415: the #5293 abort-absorb starves the nudge cadence in abort-heavy
 * clients. absorbAbortedTurnGrowth() re-anchors the growth reference to the
 * current meter on every user-aborted turn, so the MEASURED growth from the
 * old reference to the pre-abort anchor is zeroed too — 85 absorbs in one
 * reported 4.5h log left "growth 4450 < floor 33750, ready: T1 302220" idle
 * for hours and the session finally compressed at 330K backlog.
 *
 * Fix under test (kernel side, v2 — debt pays only from the SECOND absorb
 * on, so a single abort stays exactly as quiet as #5293 pinned):
 *  1. debt pays the floor — state.nudge.absorbedDebt + absorbCount >= 2
 *     (banked/counted by the host at absorb time) counts into growthReady
 *     like live growth; a SINGLE absorb (count 1) never pays, even with
 *     debt alone over the floor (#5293 pin);
 *  2. backlog-drain guard — count >= 2 + debt > 0 (cadence disturbed by
 *     repeated absorbs) + no outstanding nudge + ready mass >= 2x the T1
 *     threshold drains the backlog without waiting for the starved growth
 *     leg; count 1 keeps the drain off too;
 *  3. debt-free sessions decide byte-identically (no bypass for healthy
 *     pacing), and applyCompression resets the debt bank AND the count.
 *
 * Config (same as nudge.test.ts): modelContextLimit 100000, min band 45%,
 * nudgeGrowthTokens 6000, growthFloor 5000, tierThresholds[1] = 6000,
 * drain multiplier 2 -> 12000.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import { assignRefs } from "../src/refs.js";
import type { Config, CoreMessage } from "../src/types.js";
import type { CompressionState } from "../src/types.js";

function buildConfig(): Config {
    return {
        tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
        nudge: {
            maxContextLimitPct: 0.9,
            minContextLimitPct: 0.45,
            frequency: 1,
            iterationThreshold: 15,
            force: "soft",
            growthRatio: 0.05,
            growthFloor: 6000,
            growthCap: 50000,
            minGrowthFloor: 5000,
            minGrowthRatio: 0.45,
            emergencyThresholdPct: 0.98,
        },
        promotionThreshold: 5,
        truncate: { threshold: 1 },
        merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
        compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
        protectedTools: [],
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
        modelContextLimit: 100000,
    };
}

const textMessage = (id: string, text: string): CoreMessage => ({
    id,
    role: "user",
    contentType: "text",
    text,
});

/** ~5500 estimated tokens each — 10 of these put tier-1 pending >= 55000. */
const bigMessage = (i: number): CoreMessage =>
    textMessage(`m${i}`, `message ${i} `.repeat(2000));

/** Fresh state with a stamped baseline (turn 1 at 46000, small mass, usage
 * 46% — in band, first-sight mass condition false) so every scenario starts
 * from growth-from-reference instead of a zero baseline. */
/** Fresh state that looks mid-session: growth reference stamped at 46,000
 *  (baseline > 0, so the #194 first-sight bypass is off and growth measures
 *  from the reference), no nudge outstanding. */
function seededState(
    debt: number,
    extra?: (s: CompressionState) => void,
    absorbCount = 2, // the host increments once per absorb; 2 = repeat aborts
): CompressionState {
    const state = createInitialState();
    state.nudge.lastPerMessageNudgeTokens = 46_000;
    state.nudge.lastNudgeShownTokens = 0;
    state.nudge.lastShownByTier = {};
    state.nudge.absorbedDebt = debt;
    state.nudge.absorbCount = absorbCount;
    extra?.(state);
    return state;
}

const decide = (state: CompressionState, debtOverwrite?: number) => {
    const core = createCore();
    const config = buildConfig();
    if (debtOverwrite !== undefined) state.nudge.absorbedDebt = debtOverwrite;
    return core.processTurn({
        messages: Array.from({ length: 10 }, (_, i) => bigMessage(i)),
        state,
        config,
        tokenCount: 46_500, // growth 500 < floor 5000, usage 46.5% (normal band)
    }).nudge;
};

test("5415: debt pays the growth floor — absorbed growth fires the cadence", () => {
    const state = seededState(4_500); // 500 live + 4500 debt (2 absorbs) >= 5000 floor
    const nudge = decide(state);
    assert.equal(nudge?.shouldInject, true, `expected inject, got: ${nudge?.reason}`);
    assert.equal(nudge?.tier, 1);
});

test("5415: single absorb stays quiet — #5293 pin (count 1, debt over the floor)", () => {
    // One abort after a long quiet stretch can bank a whole interval of
    // debt; paying it on the redirect turn is exactly what #5293 pinned as
    // the bug, so count 1 must hold BOTH the floor-pay and the drain guard.
    const state = seededState(9_000, undefined, 1); // 500 + 9000 >= floor, mass 55000 >= 12000
    const nudge = decide(state);
    assert.equal(
        nudge?.shouldInject,
        false,
        `single abort must not re-fire the cadence: ${nudge?.reason}`,
    );
    assert.match(
        nudge?.reason ?? "",
        /growth 500 \+ absorbed 9000 held \(single abort, #5293\) < floor 5000/,
        `reason should surface the held debt: ${nudge?.reason}`,
    );
});

test("5415: control — same shape without debt stays idle", () => {
    const state = seededState(0);
    const nudge = decide(state);
    assert.equal(nudge?.shouldInject, false);
    assert.match(nudge?.reason ?? "", /growth 500 < floor 5000/);
});

test("5415: debt surfaced in the idle reason for diagnosability", () => {
    // small mass keeps the backlog-drain guard (2x threshold) out of the
    // picture so the idle reason is what we inspect
    const state = seededState(4_100);
    const core = createCore();
    const config = buildConfig();
    const nudge = core.processTurn({
        messages: [textMessage("s0", "small 0 ".repeat(100))],
        state,
        config,
        tokenCount: 46_500, // growth 500 + debt 4100 (2 absorbs) < floor 5000 -> idle
    }).nudge;
    assert.equal(nudge?.shouldInject, false);
    assert.match(
        nudge?.reason ?? "",
        /growth 500 \+ absorbed 4100 across 2 aborts < floor 5000/,
        `reason should show the debt: ${nudge?.reason}`,
    );
});

test("5415: backlog-drain guard — repeated absorbs + mass >= 2x threshold drains now", () => {
    const state = seededState(10); // tiny debt, 2 absorbs: growth 510 < floor, but mass 55000 >= 12000
    const nudge = decide(state);
    assert.equal(nudge?.shouldInject, true, `expected drain, got: ${nudge?.reason}`);
    assert.equal(nudge?.tier, 1);
});

test("5415: drain guard off while a nudge is outstanding (ignored nudge keeps the stamp)", () => {
    const state = seededState(10, (s) => {
        s.nudge.lastNudgeShownTokens = 46_000;
    });
    const nudge = decide(state);
    assert.equal(nudge?.shouldInject, false, `must not re-fire on an ignored nudge: ${nudge?.reason}`);
});

test("5415: drain guard off for debt-free sessions — healthy pacing byte-identical", () => {
    const state = seededState(0);
    const nudge = decide(state);
    assert.equal(nudge?.shouldInject, false);
    // mass 55000 >= 12000 yet no bypass: the guard requires debt > 0.
    assert.match(nudge?.reason ?? "", /growth 500 < floor 5000/);
});

test("5415: applyCompression resets the debt bank and absorb count with the other baselines", () => {
    const core = createCore();
    const config = buildConfig();
    const state = seededState(4_500);
    const messages = Array.from({ length: 10 }, (_, i) => bigMessage(i));
    state.messageRefs = assignRefs(messages, {
        existing: state.messageRefs,
        nextIndex: 1,
    }).map;
    const applied = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00005", summary: "first five" }],
        messages,
        state,
        config,
    });
    assert.equal(applied.result.errors.length, 0, JSON.stringify(applied.result.errors));
    assert.equal(applied.state.nudge.absorbedDebt ?? 0, 0, "debt bank must drain with the backlog");
    assert.equal(applied.state.nudge.absorbCount ?? 0, 0, "absorb count must reset with the bank");
});
