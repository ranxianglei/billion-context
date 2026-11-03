import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import type { Config, CoreMessage } from "acp-kernel";
import { noteOutboundContextEstimates, settleUsageReport } from "../src/cache-ledger.ts";
import { executeProxyTool } from "../src/loop/core.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { effectiveTokenCount } from "../src/server.ts";
import { zeroStats, type Session } from "../src/session.ts";

// #5135: a successful T1 fold nets its savings into lastInputTokens and parks
// them as compressCreditTokens (stream.ts applyRanges), while
// lastUsageGradeTokens keeps carrying the PRE-fold usage report until the next
// prepare's processTurn materializes the fold and clears the credit. In proxy
// mode the client resends the covered originals every request, so at that
// decision point the raw inbound upper bound legitimately towers over the last
// OUTBOUND snapshot on long sessions — the #4805/#4849 anchorImpossible guard
// misreads the session's own honest credited anchor as side-lane pollution,
// refuses it, and hands the kernel the stale pre-fold grade. With usage above
// maxContextLimitPct the kernel takes the pressure branch and injects a false
// OVER-LIMIT T2 distill immediately after the fold that just shrank the
// context. Incident shape (bili 0.1.209, Kimi Code + MCP + OpenAI Responses,
// budget 375000, limit 70%): anchor 180353 (credited) / grade 269449 /
// credit 89096 / last outbound upper 604273 / resent raw upper 38720353 chars.
// Fix: pending credit proves THIS conversation executed its own fold since the
// last settle (credit cannot be minted by foreign usage samples), so the
// credited baseline wins for exactly that window; every other path is
// byte-identical to master (credit == 0 keeps #4805 fully armed, #4383
// cycle-stale still outranks, estimate-grade never promotes).

function incidentSession(overrides: Partial<Session["stats"]> = {}): Session {
    return {
        id: "credit-repro",
        meta: {},
        metadata: {},
        stats: {
            ...zeroStats(),
            lastInputTokens: 180_353,
            lastInputTokensSource: "usage",
            lastUsageGradeTokens: 269_449,
            contextTokens: 180_353,
            contextTokensSource: "usage",
            compressCreditTokens: 89_096,
            lastUsagePayloadUpper: 604_273,
            ...overrides,
        },
        state: createInitialState(),
        createdAt: 0,
        lastSeen: 0,
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        transient: {},
    };
}

// The incident's resend shape: one covered original whose char mass alone
// towers over every anchor (10M chars >= 8x of both 180353 and 604273).
const towerHistory = (): CoreMessage[] => [
    { id: "covered", role: "user", contentType: "text", text: "x".repeat(10_000_000) },
];

test("T1 credited post-fold baseline rides the meter (incident shape)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const s = incidentSession();
    const r1 = effectiveTokenCount(s, towerHistory());
    assert.deepEqual(r1, { tokens: 180_353, source: "usage" }, "credited anchor wins over the stale pre-fold grade");
    // Reads never consume: a repeated sizing (status surfaces, preflight, the
    // nudge recompute) must see the same number and leave the ledger intact.
    const r2 = effectiveTokenCount(s, towerHistory());
    assert.deepEqual(r2, { tokens: 180_353, source: "usage" });
    assert.equal(s.stats.compressCreditTokens, 89_096, "repeated reads must not double-consume the credit");
    assert.equal(s.stats.lastInputTokens, 180_353, "repeated reads must not re-net the baseline");
});

test("T2 no pending credit: the #4805 anchor refusal stays armed", () => {
    const s = incidentSession({ compressCreditTokens: 0 });
    const r = effectiveTokenCount(s, towerHistory());
    assert.deepEqual(r, { tokens: 269_449, source: "usage" },
        "with no credit the towering payload still proves the anchor foreign — stale-grade fallthrough unchanged");
});

test("T3 drained-to-zero credit reading is a valid usage baseline", () => {
    const s = incidentSession({ lastInputTokens: 0, contextTokens: 0 });
    const r = effectiveTokenCount(s, towerHistory());
    assert.deepEqual(r, { tokens: 0, source: "usage" },
        "a fold that nets the baseline to zero still beats the pre-fold grade (kernel reads 0 as unknown)");
});

test("T4 estimate-grade baselines are not promoted by pending credit", () => {
    const s = incidentSession({ lastInputTokens: 719_521, lastInputTokensSource: "estimate" });
    const r = effectiveTokenCount(s, towerHistory());
    assert.deepEqual(r, { tokens: 269_449, source: "usage" },
        "#1492: only usage-grade baselines size the meter — credit presence must not launder an estimate");
});

test("T5 #4383 cycle-stale outranks the credit exemption (unreported send rides its own measurement)", () => {
    const s = incidentSession();
    noteOutboundContextEstimates(s, { upperBound: 350_000, scaledText: 190_000, imageTokens: 0, calibrated: true });
    const r = effectiveTokenCount(s, towerHistory());
    assert.deepEqual(r, { tokens: 350_000, source: "estimate" },
        "a newer unreported main send postdates the settle — its calibrated estimate wins (#4383)");
});

test("T6 a new post-fold usage report takes over once settled", () => {
    const s = incidentSession({ compressCreditTokens: 0, localInputEstimate: 400_000 });
    settleUsageReport(s, { total: 174_000, reportedCached: null, protocol: "responses" });
    assert.equal(s.stats.lastInputTokens, 174_000);
    const r = effectiveTokenCount(s, towerHistory());
    assert.deepEqual(r, { tokens: 174_000, source: "usage" }, "the fresh report supersedes everything");
    assert.equal(s.stats.inputTokens, 174_000, "cumulative billing counts the report exactly once");
});

test("T7 normal path (size guard not firing) is byte-identical", () => {
    const s = incidentSession({
        lastInputTokens: 500,
        lastUsageGradeTokens: 500,
        contextTokens: 500,
        compressCreditTokens: 200,
        lastUsagePayloadUpper: 400,
    });
    const small: CoreMessage[] = Array.from({ length: 3 }, (_, i) => ({
        id: `m${i}`, role: i % 2 === 0 ? "user" as const : "assistant" as const, contentType: "text" as const, text: "x".repeat(6_000),
    }));
    const r = effectiveTokenCount(s, small);
    assert.deepEqual(r, { tokens: 500, source: "usage" },
        "delta below the 25K absolute floor keeps the legacy fast path (both branches agree here)");
});

test("E2E real fold -> next sizing -> processTurn: no false pressure T2; the old baseline reproduces it", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const core = createCore();
    const base = defaultConfig(375_000);
    const config: Config = {
        ...base,
        preserveRecentTokens: 0,
        nudge: {
            ...base.nudge,
            maxContextLimitPct: 0.7,
            growthFloor: 80_000,
            growthCap: 80_000,
            tierGrowthTokens: { ...(base.nudge.tierGrowthTokens ?? {}), t2: 50_000, t3: 50_000 },
        },
    };
    const tail: CoreMessage[] = Array.from({ length: 8 }, (_, i) => ({
        id: `t${i + 1}`,
        role: i % 2 === 0 ? "user" as const : "assistant" as const,
        contentType: "text" as const,
        text: `tail message ${i + 1} carries enough body to stay visible across turns. `.repeat(2),
    }));
    const raw: CoreMessage[] = [
        { id: "covered", role: "user", contentType: "text", text: "x".repeat(10_000_000) },
        { id: "a", role: "user", contentType: "text", text: "y".repeat(20_000) },
        { id: "b", role: "assistant", contentType: "text", text: "z".repeat(20_000) },
        ...tail,
    ];
    const s = incidentSession({
        lastInputTokens: 269_449,
        lastUsageGradeTokens: 269_449,
        contextTokens: 269_449,
        compressCreditTokens: 0,
        inputTokens: 269_449,
    });
    // The session already carries an active T1 block covering the giant
    // original (incident: b1411..b1415), so its mass is out of the fresh-range
    // recommendation — T2 pending is the largest reclaimable mass, exactly the
    // incident's "max pending … (T1 effective 0, T2 …)" shape.
    s.state.blocks.push({
        blockId: "b1",
        runId: "r1",
        tier: 1,
        active: true,
        generation: "young",
        survivedCount: 0,
        summary: "Archived decision. ".repeat(1_400),
        compressedTokens: 2_500_000,
        createdAt: 0,
        directMessageIds: ["covered"],
        effectiveMessageIds: ["covered"],
        directBlockIds: [],
    });
    s.state.nextBlockId = 2;

    // Request N: the fold runs mid-loop after the pre-fold report landed.
    const turnA = core.processTurn({ messages: raw, state: s.state, config, tokenCount: 269_449, renderTags: "none" });
    s.state = turnA.state;
    const refA = s.state.messageRefs.byRaw["a"];
    const refB = s.state.messageRefs.byRaw["b"];
    assert.ok(refA && refB, "refs assigned for the fold range");
    const unit = "Folded exchange between a and b: decisions preserved. ";
    const summary = unit.repeat(Math.floor(16_000 / unit.length));
    assert.ok(summary.length > 0 && summary.length <= config.compress.maxSummaryLength, "summary fits the length gate");
    const res = executeProxyTool("compress", { content: [{ startId: refA, endId: refB, summary }] }, {
        core,
        config,
        messages: [...turnA.messages],
        compressMessages: raw,
        session: s,
        log: () => {},
    }, "credit-compress");
    assert.equal(res.outcome, "applied", `fold applied (got ${res.outcome}: ${res.text.slice(0, 200)})`);
    assert.ok((s.stats.compressCreditTokens ?? 0) > 0, "pending credit minted by the fold");
    const netted = s.stats.lastInputTokens;
    assert.ok(netted < 262_500, `netted baseline ${netted} sits below the 70% line (262_500)`);

    // Request N+1 prepare: the sizing the host feeds the kernel's nudge.
    const sizing = effectiveTokenCount(s, raw);
    assert.equal(sizing.tokens, netted, "the meter rides the credited post-fold baseline, not the pre-fold grade");
    assert.equal(sizing.source, "usage");

    const stateAfterCompress = structuredClone(s.state);
    const turnB = core.processTurn({ messages: [...raw], state: s.state, config, tokenCount: sizing.tokens, renderTags: "none" });
    assert.ok(turnB.nudge, "nudge decision present");
    assert.equal(turnB.nudge.shouldInject, false,
        `no false pressure nudge right after a successful fold (reason=${turnB.nudge.reason})`);
    assert.ok(turnB.nudge.breakdown.pendingT2 > turnB.nudge.breakdown.minPressureBenefit,
        "pending T2 mass sits ABOVE the benefit floor — the stale baseline WOULD have fired");
    assert.ok(turnB.nudge.breakdown.pendingT2 < 50_000, "…but below the regular T2 growth gate (no need signal)");

    // Counterfactual: identical state, the pre-fix meter input.
    const counter = core.processTurn({ messages: [...raw], state: stateAfterCompress, config, tokenCount: 269_449, renderTags: "none" });
    assert.equal(counter.nudge?.shouldInject, true, "the stale pre-fold grade reproduces the incident");
    assert.equal(counter.nudge?.tier, 2, "…as the false OVER-LIMIT T2 distill (#5135 signature)");
});
