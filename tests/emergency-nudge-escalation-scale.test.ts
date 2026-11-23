import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, type NudgeDecision } from "acp-kernel";
import {
    EMERGENCY_NUDGE_ESCALATION_PCT,
    emergencyNudgeArmed,
    emergencyNudgeForConfig,
    resolveEmergencyEscalationPct,
} from "../src/server/budget.ts";
import type { Session } from "../src/session.ts";

function makeNudge(contextUsage: number): NudgeDecision {
    return {
        shouldInject: false,
        tier: 1,
        reason: "test",
        contextUsage,
        compressibleRanges: [
            {
                startRef: "m00001",
                endRef: "m00010",
                tokens: 5_000,
                chars: 20_000,
                count: 10,
                toolPct: 0,
                textPct: 100,
            },
        ],
        breakdown: {
            maxPending: 5_000,
            minPressureBenefit: 1_000,
        },
    } as unknown as NudgeDecision;
}

function makeSession(): Session {
    return {
        id: "test-emergency-scale",
        meta: {},
        metadata: {},
        state: createInitialState(),
        createdAt: 1_000,
        lastSeen: 1_000,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        stats: {
            requests: 0,
            tokensSaved: 0,
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            cacheSamples: 0,
            lastInputTokens: 0,
            compressCreditTokens: 0,
            contextTokens: 0,
            retrieveCalls: 0,
            retrieveHits: 0,
            retrieveMisses: 0,
            storedBytes: 0,
            storeBytesSaved: 0,
            rangeRestores: 0,
        },
    };
}

test("resolveEmergencyEscalationPct preserves 0.70 default and shifts proportionally when maxContextLimitPct > 0.75", () => {
    assert.equal(resolveEmergencyEscalationPct(undefined), EMERGENCY_NUDGE_ESCALATION_PCT);
    assert.equal(resolveEmergencyEscalationPct(0.75), 0.7);
    assert.equal(resolveEmergencyEscalationPct(0.6), 0.7);
    assert.ok(Math.abs(resolveEmergencyEscalationPct(0.85) - 0.8) < 1e-9);
    assert.ok(Math.abs(resolveEmergencyEscalationPct(0.78) - 0.73) < 1e-9);
});

test("emergencyNudgeForConfig and emergencyNudgeArmed honor raised maxContextLimitPct instead of firing at hardcoded 0.70", () => {
    const cfg = { compress: { minCompressRange: 1000 }, nudge: { maxContextLimitPct: 0.85 } };
    const at74 = makeNudge(0.74);
    const at81 = makeNudge(0.81);

    assert.equal(emergencyNudgeForConfig(at74, cfg), false);
    assert.equal(emergencyNudgeArmed(makeSession(), at74, 1000, 74_000, undefined, 0.85), false);

    assert.equal(emergencyNudgeForConfig(at81, cfg), true);
    assert.equal(emergencyNudgeArmed(makeSession(), at81, 1000, 81_000, undefined, 0.85), true);
});
