// #4383: a tiny but REAL usage-grade sample under the session id (title-gen /
// probe sidecar request) settles into lastUsageGradeTokens and blinds every
// input-baseline reader: the kernel's growth reference is a low-water mark
// (#1595) and rides down to the tiny reading, so growth stays ≡0, the pressure
// bands die, and auto-folding is disabled for hours until an unrelated external
// event lands a real report (repro: one 4733-token sample froze a 303k context
// at usage=1% for 4h07m — 154 nudges all idle, pendingT1 106k→284k, zero folds;
// recovery only when a model switch produced input=252154). #1595's written
// promise "nudge decisions ride local estimates until a usage-grade sample
// lands" was never implemented in the baseline readers. Fix: shared stale-small
// guard — an anchor below 25% of the billing-caliber local estimate of the
// current outbound (contextEstimateTokens) AND superseded by a later main send
// (contextTokensSource === "estimate": the relay chokepoint stamps it per send,
// settleUsageReport flips it back to "usage") is demoted to that estimate. The
// freshness gate is what keeps a FRESH small sample authoritative (#1820 B: a
// real usage-grade sample supersedes the post-rebuild anchor immediately); only
// a small sample OUTLIVED by larger main sends is sidecar poison. Anchors above
// the estimate keep their #1839 precedence (one-directional). These tests pin
// the guard matrix on both readers plus the end-to-end freeze-breaker (the
// exact repro shape through handleAcpStatus) and its negative control (same
// poison, no estimate → legacy behavior byte-identical).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig } from "acp-kernel";
import { zeroStats, statusInputBaseline, displayContextBest, staleSmallAnchorFallback, type Session } from "../src/session.ts";
import { effectiveTokenCount } from "../src/server.ts";
import { handleAcpStatus } from "../src/acp-status.ts";

const EST = 303093; // the issue's calibrated estimate (output-budget line input~303093)
const POISON = 4733; // the issue's sidecar sample

type Scenario = { name: string; stats: Partial<Session["stats"]>; expected: number };

// Freshness shorthand: "estimate" = a main send has occurred since the last
// settled sample (guard may fire); "usage" = the sample IS the latest event
// (guard must stay off — #1820 B authority).
const FRESH = { contextTokensSource: "estimate" as const };
const SETTLED = { contextTokensSource: "usage" as const };

const SCENARIOS: Scenario[] = [
    { name: "issue repro: 4.7k sidecar sample under a 303k context falls back to the calibrated estimate", stats: { lastInputTokens: POISON, lastInputTokensSource: "usage", lastUsageGradeTokens: POISON, contextEstimateTokens: EST, ...FRESH }, expected: EST },
    { name: "legacy unflagged path: same poison via the retained anchor", stats: { lastInputTokens: POISON, lastUsageGradeTokens: POISON, contextEstimateTokens: EST, ...FRESH }, expected: EST },
    { name: "estimate-grade failure arm swallowed, live estimate wins (armFailureShrink egress)", stats: { lastInputTokens: 1108494, lastInputTokensSource: "estimate", lastUsageGradeTokens: POISON, contextEstimateTokens: EST, ...FRESH }, expected: EST },
    { name: "stale-small overflow-arm demoted too", stats: { lastInputTokens: POISON, lastInputTokensSource: "overflow-arm", lastUsageGradeTokens: POISON, contextEstimateTokens: EST, ...FRESH }, expected: EST },
    { name: "fresh small sample keeps authority even far below the estimate (#1820 B)", stats: { lastInputTokens: POISON, lastInputTokensSource: "usage", lastUsageGradeTokens: POISON, contextEstimateTokens: EST, ...SETTLED }, expected: POISON },
    { name: "legitimate sample inside the estimator error band stays trusted", stats: { lastInputTokens: Math.round(EST / 3), lastInputTokensSource: "usage", lastUsageGradeTokens: Math.round(EST / 3), contextEstimateTokens: EST, ...FRESH }, expected: Math.round(EST / 3) },
    { name: "anchor above the estimate keeps #1839 precedence (one-directional)", stats: { lastInputTokens: 400000, lastInputTokensSource: "usage", lastUsageGradeTokens: 400000, contextEstimateTokens: EST, ...FRESH }, expected: 400000 },
    { name: "real over-window report never clamped even against a low estimate", stats: { lastInputTokens: 800000, lastInputTokensSource: "usage", lastUsageGradeTokens: 800000, contextEstimateTokens: EST, ...FRESH }, expected: 800000 },
    { name: "no estimate yet (legacy session) → anchor verbatim", stats: { lastInputTokens: POISON, lastInputTokensSource: "usage", lastUsageGradeTokens: POISON }, expected: POISON },
    { name: "zero estimate → anchor verbatim", stats: { lastInputTokens: POISON, lastInputTokensSource: "usage", lastUsageGradeTokens: POISON, contextEstimateTokens: 0, ...FRESH }, expected: POISON },
    { name: "unknown sentinel (no anchor) untouched", stats: {}, expected: 0 },
];

test("#4383: staleSmallAnchorFallback demotes only too-small anchors superseded by a main send", () => {
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: EST, ...FRESH }, POISON), EST);
    // exact-integer boundary (est divisible by 4): at the line → trusted (strict <); one below → demoted
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: 400000, ...FRESH }, 100000), null, "anchor exactly at 25% is trusted (strict <)");
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: 400000, ...FRESH }, 99999), 400000, "one token below the line is demoted");
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: EST, ...FRESH }, Math.round(EST / 3)), null, "estimator-error-band sample survives");
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: EST, ...FRESH }, EST * 10), null, "stale-high keeps precedence");
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: EST, ...FRESH }, 0), null, "unknown sentinel passes");
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: EST, ...FRESH }, -5), null);
    assert.equal(staleSmallAnchorFallback({}, POISON), null, "absent estimate → legacy behavior");
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: 0, ...FRESH }, POISON), null);
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: Number.NaN, ...FRESH }, POISON), null);
    // freshness gate: magnitude alone never demotes a FRESH sample (#1820 B)
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: EST, ...SETTLED }, POISON), null, "settled-latest small sample stays authoritative");
    assert.equal(staleSmallAnchorFallback({ contextEstimateTokens: EST }, POISON), null, "no freshness stamp (legacy session) → legacy behavior");
});

test("#4383: statusInputBaseline demotes stale-small anchors across the provenance matrix", () => {
    for (const sc of SCENARIOS) {
        const session = { stats: { ...zeroStats(), ...sc.stats } } as Session;
        assert.equal(statusInputBaseline(session), sc.expected, sc.name);
    }
});

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeMessages(n: number): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= n; i++) {
        msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(5000)));
    }
    return msgs;
}

function makeSession(stats: Partial<Session["stats"]>): Session {
    return { stats: { ...zeroStats(), ...stats } } as Session;
}

test("#4383: effectiveTokenCount demotes stale-small anchors on both anchor branches", () => {
    const msgs = makeMessages(12);
    const cases: Array<{ name: string; stats: Partial<Session["stats"]>; tokens: number; source: "usage" | "estimate" }> = [
        { name: "branch 1 (trusted source) stale-small → calibrated estimate", stats: { lastInputTokens: POISON, lastInputTokensSource: "usage", lastUsageGradeTokens: POISON, contextEstimateTokens: EST, ...FRESH }, tokens: EST, source: "estimate" },
        { name: "branch 1 fresh small sample keeps authority (#1820 B)", stats: { lastInputTokens: POISON, lastInputTokensSource: "usage", lastUsageGradeTokens: POISON, contextEstimateTokens: EST, ...SETTLED }, tokens: POISON, source: "usage" },
        { name: "branch 1 trusted in-band → unchanged", stats: { lastInputTokens: Math.round(EST / 3), lastInputTokensSource: "usage", lastUsageGradeTokens: Math.round(EST / 3), contextEstimateTokens: EST, ...FRESH }, tokens: Math.round(EST / 3), source: "usage" },
        { name: "branch 1 real over-window → verbatim", stats: { lastInputTokens: 800000, lastInputTokensSource: "usage", lastUsageGradeTokens: 800000, contextEstimateTokens: EST, ...FRESH }, tokens: 800000, source: "usage" },
        { name: "branch 3 (retained grade, non-trusted source) stale-small → calibrated estimate", stats: { lastInputTokens: 1108494, lastInputTokensSource: "estimate", lastUsageGradeTokens: POISON, contextEstimateTokens: EST, ...FRESH }, tokens: EST, source: "estimate" },
        { name: "branch 3 trusted in-band → unchanged", stats: { lastInputTokens: 1108494, lastInputTokensSource: "estimate", lastUsageGradeTokens: Math.round(EST / 3), contextEstimateTokens: EST, ...FRESH }, tokens: Math.round(EST / 3), source: "usage" },
        { name: "poison without any estimate → legacy branch-3 value (byte-identical pre-fix)", stats: { lastInputTokens: 1108494, lastInputTokensSource: "estimate", lastUsageGradeTokens: POISON }, tokens: POISON, source: "usage" },
    ];
    for (const c of cases) {
        assert.deepEqual(effectiveTokenCount(makeSession(c.stats), msgs), { tokens: c.tokens, source: c.source }, c.name);
    }
});

// displayContextBest is deliberately UNCHANGED by #4383 — the field dynamics
// already keep it honest in the poison state: while main sends continue the
// relay chokepoint has flipped contextTokensSource to "estimate", so the panel
// serves the calibrated estimate (kind "estimate"); only between a settle and
// the next main send does it show the just-settled sample, which at that
// instant IS the newest measurement. These cases pin that existing behavior so
// a future reader-side change cannot silently re-introduce a stale usage-kind
// reading into the panel.
test("#4383: displayContextBest stays honest across the poison lifecycle (unchanged behavior)", () => {
    const steadyPoison = {
        stats: { contextTokens: 900000, contextTokensSource: "estimate" as const, lastUsageGradeTokens: POISON, lastInputTokensSource: "usage" as const, contextEstimateTokens: EST, contextEstimateCalibrated: true },
        metadata: {},
    };
    assert.deepEqual(displayContextBest(steadyPoison), { tokens: EST, kind: "estimate", calibrated: true });
    const freshSettle = {
        stats: { contextTokens: POISON, contextTokensSource: "usage" as const, lastUsageGradeTokens: POISON, lastInputTokensSource: "usage" as const, contextEstimateTokens: EST },
        metadata: { contextTokensAt: 1761191519122 },
    };
    assert.deepEqual(displayContextBest(freshSettle), { tokens: POISON, kind: "usage", at: 1761191519122 });
    const legacy = {
        stats: { contextTokens: POISON, contextTokensSource: "usage" as const, lastUsageGradeTokens: POISON, lastInputTokensSource: "usage" as const },
        metadata: {},
    };
    assert.deepEqual(displayContextBest(legacy), { tokens: POISON, kind: "usage" });
});

// End-to-end freeze-breaker: the issue's exact shape — limit 750000, one 4733
// usage-grade sample settled, kernel reference already ridden down to it
// (lastPerMessageNudgeTokens=4733), ~60×5000-char messages pending (~70k+ T1
// mass). Pre-fix the meter fed 4733 (usage 1%, growth 0/22500, idle forever —
// the 4h07m zero-fold signature); post-fix it feeds the calibrated estimate
// and the growth gate opens immediately.
const LIMIT = 750000;

function makeCtx(stats: Session["stats"], frozenRef: boolean): { seen: number[]; nudges: Array<{ shouldInject: boolean; reason: string; breakdown: Record<string, number> }> } {
    const messages = makeMessages(60);
    const refs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 });
    const session: Session = {
        id: "issue4383-e2e",
        meta: {},
        stats,
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
    session.state.messageRefs = refs.map;
    if (frozenRef) session.state.nudge.lastPerMessageNudgeTokens = POISON;
    const core = createCore();
    const seen: number[] = [];
    const nudges: Array<{ shouldInject: boolean; reason: string; breakdown: Record<string, number> }> = [];
    const orig = core.processTurn.bind(core);
    core.processTurn = (input: Parameters<typeof orig>[0]) => {
        seen.push(input.tokenCount);
        const out = orig(input);
        nudges.push({ shouldInject: out.nudge?.shouldInject ?? false, reason: out.nudge?.reason ?? "", breakdown: (out.nudge?.breakdown ?? {}) as Record<string, number> });
        return out;
    };
    handleAcpStatus({}, { core, config: defaultConfig(LIMIT), messages, session });
    return { seen, nudges };
}

test("#4383: the frozen meter opens on the calibrated estimate (issue repro)", () => {
    // contextTokensSource "estimate": main sends have continued since the
    // sidecar sample settled — the issue's steady-state freeze window.
    const stats: Session["stats"] = { ...zeroStats(), lastInputTokens: POISON, lastInputTokensSource: "usage", lastUsageGradeTokens: POISON, contextEstimateTokens: EST, contextTokensSource: "estimate" };
    const { seen, nudges } = makeCtx(stats, true);
    // #4340 added a second kernel reader inside handleAcpStatus (uncoveredHistoryRuns);
    // BOTH readers must see the demoted estimate — the frozen meter opens on every path.
    assert.deepEqual(seen, [EST, EST], "tokenCount handed to the kernel is the calibrated estimate, not the poison");
    // #4340 added a second reader; the nudge decision rides the FIRST (liveCompressionRanges).
    const nudge = nudges[0];
    assert.ok(nudge?.shouldInject, `nudge must INJECT after the fix (got: ${nudge?.reason})`);
    assert.equal(nudge.breakdown.growthReference, POISON, "growth reference still rides the low-water mark");
    assert.ok(nudge.breakdown.growth! >= 22500, `growth crosses the floor (${nudge.breakdown.growth})`);
    assert.match(nudge.reason, /T1 effective \d+ >= 50000/);
});

test("#4383: negative control — same poison without an estimate keeps legacy behavior", () => {
    const stats: Session["stats"] = { ...zeroStats(), lastInputTokens: POISON, lastInputTokensSource: "usage", lastUsageGradeTokens: POISON };
    const { seen, nudges } = makeCtx(stats, true);
    assert.deepEqual(seen, [POISON, POISON], "without contextEstimateTokens the reader is byte-identical pre-fix");
    assert.equal(nudges[0]?.shouldInject, false, "the frozen meter stays frozen (documented legacy behavior)");
    assert.match(nudges[0]?.reason ?? "", /growth 0 < floor 22500/);
});
