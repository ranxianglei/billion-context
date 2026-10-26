import assert from "node:assert/strict";
import { test } from "node:test";
import { nudgeOn, resolveLaneDecisions, resolveWireClientProfile, surfaceOffDetail, type NudgeGateInputs } from "../src/server/lane-decisions.js";
import { instructionsFingerprintApplies } from "../src/session-id.js";

// #3482 Step 2.5 equivalence proof: the single nudgeOn() gate must reproduce
// the four legacy hand-copied conjunctions BIT-FOR-BIT over the full boolean
// cube of their raw primitives. The three deliberate per-lane differences are
// explicit inputs:
//   - compactionTrigger: responses only (hasCompactionTrigger(parsed.input))
//   - growth health window: responses codex-intercept only
//   - the standalone `shouldInject` conjunct of openai/google is subsumed by
//     compressSurfaceOn (=== shouldInject && compressReachable)
// anthropic's #3293 drift (missing injectTool conjunct) was ALREADY fixed by
// #3427 — the cube asserts the fixed shape, so a regression to the drifted
// formula fails here too.
interface Primitives {
    injectNudge: boolean; hasNudgePlan: boolean; shouldInject: boolean; compressReachable: boolean;
    compactionTrigger: boolean; suppressionBypassed: boolean; breakerArmed: boolean;
    autoFoldEngaged: boolean; growthFoldingArmed: boolean; modelWantsIt: boolean;
}
function laneInputs(p: Primitives): NudgeGateInputs {
    const compressSurfaceOn = p.shouldInject && p.compressReachable;
    return {
        injectNudge: p.injectNudge,
        hasNudgePlan: p.hasNudgePlan,
        compressSurfaceOn,
        compactionTrigger: p.compactionTrigger,
        suppressionBypassed: p.suppressionBypassed,
        breakerArmed: p.breakerArmed,
        autoFoldEngaged: p.autoFoldEngaged,
        growthFoldingArmed: p.growthFoldingArmed,
        modelWantsIt: p.modelWantsIt,
    };
}
// The legacy formulas, transcribed verbatim from the pre-#3482 prepares.
// dshCompressSurfaceOff === !compressSurfaceOn held on every lane (the alias
// was assigned laneDecisions.compressSurfaceOff).
function legacyAnthropic(p: Primitives): boolean {
    const compressSurfaceOn = p.shouldInject && p.compressReachable;
    return p.injectNudge && p.hasNudgePlan && compressSurfaceOn && p.suppressionBypassed && !p.breakerArmed && !(p.autoFoldEngaged && p.growthFoldingArmed) && p.modelWantsIt;
}
function legacyOpenaiGoogle(p: Primitives): boolean {
    const compressSurfaceOn = p.shouldInject && p.compressReachable;
    return p.injectNudge && p.hasNudgePlan && p.shouldInject && compressSurfaceOn && p.suppressionBypassed && !p.breakerArmed && !(p.autoFoldEngaged && p.growthFoldingArmed) && p.modelWantsIt;
}
function legacyResponses(p: Primitives): boolean {
    const compressSurfaceOn = p.shouldInject && p.compressReachable;
    return p.injectNudge && p.hasNudgePlan && compressSurfaceOn && !p.compactionTrigger && p.suppressionBypassed && !p.breakerArmed && !(p.autoFoldEngaged && p.growthFoldingArmed) && p.modelWantsIt;
}
test("nudgeOn: full boolean cube equals all four legacy formulas (#3482 Step 2.5)", () => {
    const KEYS = Object.keys({ injectNudge: 0, hasNudgePlan: 0, shouldInject: 0, compressReachable: 0, compactionTrigger: 0, suppressionBypassed: 0, breakerArmed: 0, autoFoldEngaged: 0, growthFoldingArmed: 0, modelWantsIt: 0 }) as Array<keyof Primitives>;
    let checked = 0;
    for (let mask = 0; mask < (1 << KEYS.length); mask++) {
        const p = {} as Primitives;
        for (let i = 0; i < KEYS.length; i++) (p as unknown as Record<string, boolean>)[KEYS[i]] = ((mask >> i) & 1) === 1;
        const got = nudgeOn(laneInputs(p));
        // anthropic/openai/google have NO compaction-trigger concept on the
        // wire — that input is unrepresentable there, so their formulas are
        // only comparable on the sub-cube where it is false (the responses
        // lane owns the full cube).
        if (!p.compactionTrigger) {
            assert.equal(got, legacyAnthropic(p), `anthropic cube ${mask}`);
            assert.equal(got, legacyOpenaiGoogle(p), `openai/google cube ${mask}`);
        }
        // responses carries the trigger difference — its formula, its input.
        assert.equal(got, legacyResponses(p), `responses cube ${mask}`);
        checked++;
    }
    assert.equal(checked, 1024);
});
// The three DELIBERATE differences must stay visible as input differences,
// not vanish into the gate: pin the discriminating combos.
test("nudgeOn: deliberate per-lane differences stay explicit (#3482)", () => {
    const base: Primitives = { injectNudge: true, hasNudgePlan: true, shouldInject: true, compressReachable: true, compactionTrigger: false, suppressionBypassed: true, breakerArmed: false, autoFoldEngaged: false, growthFoldingArmed: false, modelWantsIt: true };
    // 1) responses: a compaction-trigger request never carries the nudge.
    assert.equal(nudgeOn(laneInputs({ ...base, compactionTrigger: true })), false);
    //    other lanes never pass the flag (source shape pinned by the guard
    //    reading the prepares below).
    // 2) injectTool subsumed: compressSurfaceOn false ⇒ no nudge, which is
    //    exactly the old standalone `shouldInject &&` conjunct.
    assert.equal(nudgeOn(laneInputs({ ...base, shouldInject: false })), false);
    // 3) codex-intercept health window feeds growthFoldingArmed precomputed —
    //    the gate only sees the boolean.
    assert.equal(nudgeOn(laneInputs({ ...base, autoFoldEngaged: true, growthFoldingArmed: true })), false);
    assert.equal(nudgeOn(laneInputs({ ...base, autoFoldEngaged: true, growthFoldingArmed: false })), true);
});

// #3482 site 1: billing-block policy in the registry, observation over
// defaults (any request observed carrying the #2189 block keeps it honored).
test("resolveLaneDecisions: billingBlockWanted = profile-declared OR wire-observed (#3482 site 1)", () => {
    const billingSystem = [{ type: "text", text: "x-anthropic-billing-header: acct-123" }, { type: "text", text: "You are helpful." }];
    const plainSystem = [{ type: "text", text: "You are helpful." }];
    const input = (system: unknown, pluginAgent: string | undefined) => ({ protocol: "anthropic" as const, pluginMode: true, pluginAgent, parsed: { system }, shouldInject: true });
    // dsh declares it — even with no block on this wire.
    const dsh = resolveLaneDecisions(input(plainSystem, "dsh"));
    assert.equal(dsh.billingBlockWanted, true);
    assert.equal(dsh.observed.billingBlockObserved, false);
    // anonymous request observed carrying the block — honored regardless of
    // profile (evidence over defaults, same shape as toolsReachable).
    const anon = resolveLaneDecisions(input(billingSystem, undefined));
    assert.equal(anon.billingBlockWanted, true);
    assert.equal(anon.observed.billingBlockObserved, true);
    // string system can never carry the block (extraction needs the array).
    const strSys = resolveLaneDecisions(input("You are helpful.", "dsh"));
    assert.equal(strSys.observed.billingBlockObserved, false);
    assert.equal(strSys.billingBlockWanted, true); // still dsh-declared
    // pi with nothing on the wire — off.
    const pi = resolveLaneDecisions(input(plainSystem, "pi"));
    assert.equal(pi.billingBlockWanted, false);
});

// #3482 site 4: the wire-client registry decides who keys by instructions;
// session-id.ts only observes.
test("wire-client registry: instructionsFingerprintKeyed by observed signals (#3482 site 4)", () => {
    assert.equal(resolveWireClientProfile({ headerNames: new Set(["x-codex-turn-metadata"]), conversationSourceName: undefined, codexUserAgent: false }).instructionsFingerprintKeyed, true);
    assert.equal(resolveWireClientProfile({ headerNames: new Set(), conversationSourceName: undefined, codexUserAgent: true }).instructionsFingerprintKeyed, true);
    assert.equal(resolveWireClientProfile({ headerNames: new Set(), conversationSourceName: "x-claude-code-session-id", codexUserAgent: false }).instructionsFingerprintKeyed, true);
    assert.equal(resolveWireClientProfile({ headerNames: new Set(["x-acp-session"]), conversationSourceName: "x-acp-session", codexUserAgent: false }).identity, ""); // ANONYMOUS
    assert.equal(resolveWireClientProfile({ headerNames: new Set(["x-acp-session"]), conversationSourceName: "x-acp-session", codexUserAgent: false }).instructionsFingerprintKeyed, false);
    // through the session-id wrapper (observation → registry decision)
    assert.equal(instructionsFingerprintApplies({ "x-codex-turn-metadata": "t=1" }), true);
    assert.equal(instructionsFingerprintApplies({ "user-agent": "codex_cli_rs/0.1 (Linux; x86_64) Rust" }), true);
    assert.equal(instructionsFingerprintApplies({ "x-claude-code-session-id": "9ae0…" }), true);
    assert.equal(instructionsFingerprintApplies({ "x-claude-code-session-id": "   " }), false); // blank ≠ signal
    assert.equal(instructionsFingerprintApplies({ "x-acp-session": "abc" }), false);
});

// #3884 owner follow-up: a reachability miss must be greppable in bili.log —
// the next omnibus rename shows up as `surface=off(top-level=[...])` next to
// ARMED-SUPPRESSED instead of two more incidents of user archaeology.
test("surfaceOffDetail: names observed tools on reachability-off, silent otherwise (#3884)", () => {
    const dsh = (parsed: unknown, shouldInject: boolean) => resolveLaneDecisions({ protocol: "anthropic", pluginMode: true, pluginAgent: "dsh", parsed, shouldInject });
    // surface ON (compress declared top-level) → nothing to explain
    assert.equal(surfaceOffDetail(dsh({ tools: [{ name: "compress" }] }, true), true), undefined);
    // recognized omnibus → reachable → nothing to explain (negative direction)
    assert.equal(surfaceOffDetail(dsh({ tools: [{ name: "run_code" }] }, true), true), undefined);
    assert.equal(surfaceOffDetail(dsh({ tools: [{ name: "code_run" }] }, true), true), undefined);
    // off by USER CONFIG (injectTool=false) → no explanation demanded
    assert.equal(surfaceOffDetail(dsh({}, false), false), undefined);
    // scoped lane, no tools at all → honest no-tools shape
    assert.equal(surfaceOffDetail(dsh({}, true), true), "surface=off(no-tools)");
    // scoped lane with unrecognized names → the future-rename signal
    assert.equal(surfaceOffDetail(dsh({ tools: [{ name: "get_weather" }, { name: "code_run2" }] }, true), true), "surface=off(top-level=[get_weather,code_run2])");
});
