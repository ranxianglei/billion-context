import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../src/compress.js";
import { createInitialState } from "../src/state.js";
import type { Config, CoreMessage } from "../src/types.js";

// #6876: usage-grade 437,971 (= 42% of a 1,048,576 window) frozen behind the
// egress fuse while the wire body measured 1,068,060 tokens. The fuse blocks
// the request BEFORE it reaches the upstream — so the frozen usage reading
// never refreshes — and every nudge path keyed to that reading sat below gate
// ("growth 17549 < floor 35000, ready: T1 0"). A session in which the model
// has already folded (zero compressible pending) could then 413 every round
// forever. measuredBodyTokens is the #554 meter on the ACTUAL parsed body,
// passed by the host at processTurn time: over the window it arms EMERGENCY
// pressure regardless of the frozen reading (bypassing the growth floor and
// the estimate-grade hold); under the window it must leave every nudge path
// byte-identical (#4383 guard).

const LIMIT = 1_048_576;

function buildConfig(): Config {
    return {
        tiers: { enabled: true, tier2Trigger: 1000, tier3Trigger: 2000 },
        nudge: {
            maxContextLimitPct: 0.75,
            minContextLimitPct: 0.05,
            frequency: 1,
            iterationThreshold: 15,
            force: "soft",
            growthRatio: 0.06,
            growthFloor: 60_000,
            growthCap: 60_000,
            minGrowthFloor: 35_000,
            minGrowthRatio: 0.58, // 0.58 * 60000 = 34800 → floor ~35000 (the field number)
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

// 60 messages × ~30K chars ≈ 45K tokens — enough pending mass for the
// pressure band's minimum-benefit gate, nowhere near the window itself.
function makeMessages(): CoreMessage[] {
    return Array.from({ length: 60 }, (_, i) =>
        textMessage(i % 2 === 0 ? "user" : "assistant", `m${i}`, `message ${i} `.repeat(4000)),
    );
}

test("#6876: a measured body over the window arms EMERGENCY even on a FROZEN sub-band usage reading (growth below floor, usage-grade source)", () => {
    const core = createCore();
    const config = buildConfig();
    const messages = makeMessages();
    let state = createInitialState();

    // Warm-up (first sight of the mass): arms and shows the first nudge —
    // the baseline weld happens here so the FOLLOWING turns judge growth
    // from a settled reference instead of the first-sight mass bypass.
    const warmup = core.processTurn({
        messages,
        state,
        config,
        tokenCount: 437_971,
        tokenCountSource: "usage",
    });
    assert.equal(warmup.nudge!.shouldInject, true, "warm-up: first-sight mass arms the initial nudge");

    // The field's frozen reading on the NEXT turn: 437,971 again = zero
    // growth, usage-grade 42% of the window — well under the 75% over-limit
    // band. The phantom-pressure estimate hold does not even apply here;
    // what holds the nudge is the growth floor (no usage growth behind the
    // fuse).
    const frozen = core.processTurn({
        messages,
        state: warmup.state,
        config,
        tokenCount: 437_971,
        tokenCountSource: "usage",
    });
    assert.equal(frozen.nudge!.shouldInject, false, "control: on the frozen reading alone the nudge sits below gate");
    assert.match(frozen.nudge!.reason, /< floor|< threshold/, `control reason is a non-pressure idle (got: ${frozen.nudge!.reason})`);
    state = frozen.state;

    // Same turn, but the host now hands over the meter on the actual parsed
    // body: 1,068,060 > 1,048,576. EMERGENCY arms, pending mass qualifies.
    const turn = core.processTurn({
        messages,
        state,
        config,
        tokenCount: 437_971,
        tokenCountSource: "usage",
        measuredBodyTokens: 1_068_060,
    });
    assert.equal(turn.nudge!.shouldInject, true, "measured body over the window must arm the nudge despite the frozen usage reading (#6876)");
    assert.equal(turn.nudge!.breakdown.measuredPressure, 1, "the breakdown flags the measured arm");
    assert.equal(turn.nudge!.breakdown.emergencyOverride, 0, "the usage meter itself never crossed — this is the measured arm, not the usage arm");
    assert.match(turn.nudge!.reason, /EMERGENCY/, `reason carries the EMERGENCY label (got: ${turn.nudge!.reason})`);
    assert.match(turn.nudge!.reason, /egress-measured 1068060 tok > window 1048576/, `reason names the measured arm (got: ${turn.nudge!.reason})`);
});

test("#6876: measured-pressure also bypasses the ESTIMATE-grade hold (silent backend + frozen body)", () => {
    const core = createCore();
    const config = buildConfig();
    const messages = makeMessages();
    let state = createInitialState();

    // Warm the baseline so growth is ~0.
    state = core.processTurn({ messages, state, config, tokenCount: 437_971, tokenCountSource: "usage" }).state;

    // Next round: no usage report (estimate grade) AND the body is over the
    // window. The phantom-pressure guard defers estimate-grade pressure up to
    // maxEstimateHoldRounds — measured wire evidence must not be deferred.
    const turn = core.processTurn({
        messages,
        state,
        config,
        tokenCount: 438_000,
        tokenCountSource: "estimate",
        measuredBodyTokens: 1_050_000,
    });
    assert.equal(turn.nudge!.shouldInject, true, "a measured over-window body is live wire evidence — the estimate hold must not defer it");
    assert.equal(turn.nudge!.breakdown.measuredPressure, 1);
    assert.equal(turn.nudge!.breakdown.pressureDeferredNoSample, 0, "no deferral while the measured body is over the window");
});

test("#4383 guard: a measured body UNDER the window leaves the nudge decision byte-identical (with vs without the reading)", () => {
    const core = createCore();
    const config = buildConfig();
    const messages = makeMessages();

    // Reuse one warm-up for both arms so the only difference is the reading.
    const warm = (startState: ReturnType<typeof createInitialState>) =>
        createCore().processTurn({ messages, state: startState, config, tokenCount: 437_971, tokenCountSource: "usage" }).state;

    const stateA = warm(createInitialState());
    const stateB = warm(createInitialState());

    const a = core.processTurn({ messages, state: stateA, config, tokenCount: 445_000, tokenCountSource: "usage" });
    const b = core.processTurn({ messages, state: stateB, config, tokenCount: 445_000, tokenCountSource: "usage", measuredBodyTokens: 900_000 });

    assert.equal(a.nudge!.shouldInject, b.nudge!.shouldInject, "same injection decision below the window");
    assert.equal(a.nudge!.reason, b.nudge!.reason, "identical reason below the window (no measured wording may leak in)");
    assert.equal(b.nudge!.breakdown.measuredPressure, 0, "sub-window reading does not arm");
    const aBreak = { ...a.nudge!.breakdown };
    const bBreak = { ...b.nudge!.breakdown };
    delete aBreak.measuredPressure;
    delete aBreak.measuredBodyTokens;
    delete bBreak.measuredPressure;
    delete bBreak.measuredBodyTokens;
    assert.deepEqual(bBreak, aBreak, "breakdown identical apart from the new (zeroed) fields");
});

test("#6876 suppression path: measured over-window with NOTHING compressible stays suppressed but says WHY (no empty EMERGENCY)", () => {
    const core = createCore();
    const config = buildConfig();
    // Tiny messages → pending far below minPressureBenefit.
    const tiny = Array.from({ length: 4 }, (_, i) => textMessage("user", `t${i}`, `hello ${i}`));
    const state = createInitialState();
    const turn = core.processTurn({
        messages: tiny,
        state,
        config,
        tokenCount: 437_971,
        tokenCountSource: "usage",
        measuredBodyTokens: 1_068_060,
    });
    assert.equal(turn.nudge!.shouldInject, false, "minimum-benefit gate still applies to the measured arm — never offer sub-floor ranges");
    assert.equal(turn.nudge!.breakdown.measuredPressure, 1, "the arm is recorded even when suppressed");
    assert.match(turn.nudge!.reason, /EMERGENCY/, "the suppressed reason keeps the label");
    assert.match(turn.nudge!.reason, /egress-measured body 1068060 tok > window 1048576/, "the suppressed reason names the measured trigger instead of a misleading usage %");
});
