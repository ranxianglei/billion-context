import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #3674: the nudge growth references are LOW-WATER marks. The reporter's
// session (QQ-bridged, 872K window, flat 50K step, floor 22500) compressed at
// 75%, and the first post-compression reading landed at a TRANSITIONAL 92106
// while the context was still settling — 20 seconds later the real level was
// 44038. The old weld pinned the baseline at 92106 and the only downward
// channel required a SINGLE drop spanning the full 50K interval: 92106 −
// 44038 = 48068 fell 1932 short, the reference stayed at the phantom high for
// 13 hours, growth was permanently negative and every mid-band nudge stayed
// silent until the 75% over-limit band. These tests replay that trajectory
// turn by turn with the reporter's numbers.

const LIMIT = 872_000;
const STEP = 50_000;
const FLOOR = 22_500;

function buildConfig(): Config {
    return {
        tiers: { enabled: true, tier2Trigger: 5, tier3Trigger: 10 },
        nudge: {
            maxContextLimitPct: 0.75,
            minContextLimitPct: 0.05,
            frequency: 1,
            iterationThreshold: 15,
            force: "soft",
            growthRatio: 0.06, // 872000 * 0.06 = 52320, capped to the 50000 step
            growthFloor: STEP,
            growthCap: STEP,
            minGrowthFloor: FLOOR,
            minGrowthRatio: 0.45, // 0.45 * 50000 = 22500 — the reporter's floor
            emergencyThresholdPct: 0.98,
        },
        promotionThreshold: 5,
        truncate: { threshold: 1 },
        merge: { maxSummaryLength: 3000, minOldGenBlocks: 3 },
        compress: { minCompressRange: 0, maxSummaryLength: 0, minSummaryLength: 0 },
        protectedTools: [],
        preserveRecentMessages: 0,
        preserveRecentTokens: 0,
        modelContextLimit: LIMIT,
    };
}

function textMessage(role: CoreMessage["role"], id: string, text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

// A history whose compressible mass clears the 50K T1 threshold (each turn
// ~28K chars ≈ 7K tokens by the kernel's calibrated counter).
function makeMessages(count: number): CoreMessage[] {
    return Array.from({ length: count }, (_, i) =>
        textMessage(i % 2 === 0 ? "user" : "assistant", `m${i}`, `message ${i} `.repeat(4000)),
    );
}

test("#3674 replay: reference follows the settle, growth re-arms from the valley", () => {
    const core = createCore();
    const config = buildConfig();
    const messages = makeMessages(40);
    let state = createInitialState();

    // Warm the session to the pre-compression level, then hit the 75% band
    // exactly as the reporter's log did (03:46:57 INJECT usage=75%).
    state = core.processTurn({ messages, state, config, tokenCount: 650_092 }).state;
    // The compression itself succeeded — applyCompression clears the
    // references (this reset stays; #194's first-sight bypass depends on it).
    state = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00003", summary: "folded" }],
        messages,
        state,
        config,
    }).state;
    assert.equal(state.nudge.lastPerMessageNudgeTokens, 0, "baseline cleared post-compress");

    // 03:48:02 — first reading after the reset is TRANSITIONAL (the fold is
    // still settling): the weld takes 92106.
    state = core.processTurn({ messages, state, config, tokenCount: 92_106 }).state;
    assert.equal(state.nudge.lastPerMessageNudgeTokens, 92_106, "weld at the transitional reading");

    // 03:48:21 — the context settles to 44038. Old code: the drop (48068) fell
    // 1932 short of the full 50K interval, the reference stayed at 92106 and
    // growth was pinned at −48068 forever. Low-water: the reference follows.
    state = core.processTurn({ messages, state, config, tokenCount: 44_038 }).state;
    assert.equal(state.nudge.lastPerMessageNudgeTokens, 44_038, "reference rides down to the settled level");

    // 07:49:55 — thirteen hours later the context regrew to 67967 (usage 8%).
    // Climb from the valley: 67967 − 44038 = 23929 ≥ floor 22500 → the
    // mid-band nudge fires instead of sitting at `nudge idle` until 75%.
    const turn = core.processTurn({ messages, state, config, tokenCount: 67_967 });
    assert.equal(
        turn.nudge.shouldInject,
        true,
        `mid-band nudge re-armed from the valley, got reason: ${turn.nudge.reason}`,
    );
    assert.equal(turn.nudge.tier, 1, "growth-sized climb routes to T1");
});

test("#3674: a drop short of one interval no longer dead-zones the tier cadence", () => {
    // The #478 shape (host mirror retired with it): an estimate-grade overshoot
    // stamps the shown reference at a phantom high; the real level then settles
    // within one interval BELOW it but ABOVE the baseline. Growth keyed to the
    // shown reference was negative forever — the low-water mark retires the
    // phantom level on the very next sample, at any grade, no full-interval
    // drop event needed.
    const core = createCore();
    const config = buildConfig();
    const messages = makeMessages(24);
    let state = createInitialState();

    state = core.processTurn({ messages, state, config, tokenCount: 60_000 }).state;
    // T1 fires at 60K (baseline 60000→ first turn welds 60000, growth 0 — so
    // run one more climb to actually inject and stamp the shown reference).
    state = core.processTurn({ messages, state, config, tokenCount: 115_000 }).state; // +55000 ≥ floor → inject, shown=115000
    assert.ok(state.nudge.lastNudgeShownTokens > 0, "shown reference stamped at inject");
    const phantom = state.nudge.lastNudgeShownTokens;

    // Estimate overshoot settles 49K below the phantom shown (short of the
    // 50K interval) while still above the baseline band.
    state = core.processTurn({ messages, state, config, tokenCount: phantom - 49_000 }).state;
    assert.equal(
        state.nudge.lastNudgeShownTokens,
        phantom - 49_000,
        "shown reference rides down with the settle (#478 phantom retired)",
    );

    // Growth is measured from the retired level: +23000 ≥ 22500 re-fires.
    const turn = core.processTurn({ messages, state, config, tokenCount: phantom - 49_000 + 23_000 });
    assert.equal(
        turn.nudge.shouldInject,
        true,
        `cadence re-armed after the phantom retired, got reason: ${turn.nudge.reason}`,
    );
});
