import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import type { CompressibleRange, NudgeBreakdown, NudgeDecision } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { _setStoreForTest } from "../src/persist.ts";
import {
    applyFoldTaintToTurn,
    clearFoldTaint,
    filterTaintedRanges,
    filterTaintedRangesAt,
    recordFoldTaintRefusal,
    armedTaintSpansAt,
} from "../src/fold-taint.ts";

// #7049 (per-range fold taint): a span refused twice by the no-net-shrink /
// coverage-regression gate stops being ADVERTISED in the nudge menu (the
// contradictory-instruction leg of the refusal loop: every fresh nudge re-offered
// the same doomed fragment 57 times in the incident). The gate itself is
// untouched — this module only filters the menu and, when the whole T1 menu is
// tainted, drops the nudge for the round.

const s = () => _setStoreForTest(null as never); // no-op store; markDirty only bumps epoch + schedules

type R = { startRef: string; endRef: string };

const ranges = (pairs: Array<[string, string]>): CompressibleRange[] =>
    pairs.map(([startRef, endRef]) => ({ startRef, endRef, count: 1, tokens: 100, toolPct: 0, textPct: 100 }));

const breakdown = (o: Partial<NudgeBreakdown> = {}): NudgeBreakdown => ({
    usage: 0, growth: 0, growthReference: 0, effectiveThreshold: 0, nudgeGrowthTokens: 0,
    growthFloor: 0, hasPendingNudge: 0, overLimit: 0, emergencyOverride: 0,
    pendingT1: 0, pendingT2: 0, pendingT3: 0, maxPending: 0, ...o,
});

function turn(nudge: Partial<NudgeDecision>): { nudge?: NudgeDecision | null } {
    return { nudge: nudge as NudgeDecision };
}

test("recordFoldTaintRefusal: first refusal records but does not arm (no note)", () => {
    s();
    const session = { id: "t1", metadata: {} } as unknown as Session;
    const note = recordFoldTaintRefusal(session, "m00351..m00373");
    assert.equal(note, "");
    // Not armed: nothing filtered yet.
    assert.deepEqual(
        filterTaintedRanges(ranges([["m00351", "m00373"]]), session),
        ranges([["m00351", "m00373"]]),
    );
});

test("recordFoldTaintRefusal: second refusal of the same spec arms the taint and annotates the receipt", () => {
    s();
    const session = { id: "t2", metadata: {} } as unknown as Session;
    recordFoldTaintRefusal(session, "m00351..m00373");
    const note = recordFoldTaintRefusal(session, "m00351..m00373");
    assert.match(note, /REMOVED from the nudge recommendation list/);
    // Armed: the identical menu range is now excluded.
    assert.deepEqual(filterTaintedRanges(ranges([["m00351", "m00373"]]), session), []);
});

test("containment semantics: sub-span of a tainted span is dropped, superset (larger-span escape hatch) survives, disjoint survives", () => {
    s();
    const session = { id: "t3", metadata: {} } as unknown as Session;
    recordFoldTaintRefusal(session, "m00351..m00373");
    recordFoldTaintRefusal(session, "m00351..m00373");
    const kept = filterTaintedRanges(ranges([
        ["m00360", "m00370"],   // inside tainted span → dropped
        ["m00351", "m00373"],   // exact → dropped
        ["m00300", "m00400"],   // superset (fold-a-larger-span) → KEPT
        ["m00374", "m00400"],   // disjoint → KEPT
        ["m00340", "m00360"],   // partially overlaps → KEPT (not contained)
    ]), session).map((r) => `${r.startRef}..${r.endRef}`);
    assert.deepEqual(kept, ["m00300..m00400", "m00374..m00400", "m00340..m00360"]);
});

test("clearFoldTaint: a successful commit clears all taint (mirrors the kernel baseline reset)", () => {
    s();
    const session = { id: "t4", metadata: {} } as unknown as Session;
    recordFoldTaintRefusal(session, "m00010..m00020");
    recordFoldTaintRefusal(session, "m00010..m00020");
    assert.deepEqual(filterTaintedRanges(ranges([["m00010", "m00020"]]), session), []);
    clearFoldTaint(session);
    assert.deepEqual(filterTaintedRanges(ranges([["m00010", "m00020"]]), session), ranges([["m00010", "m00020"]]));
});

test("TTL: taint expires after 10 minutes even without a commit (explicit clock)", () => {
    s();
    const session = { id: "t5", metadata: {} } as unknown as Session;
    recordFoldTaintRefusal(session, "m00010..m00020");
    recordFoldTaintRefusal(session, "m00010..m00020");
    const t0 = Date.now();
    assert.equal(armedTaintSpansAt(session, t0).length, 1);
    // 9 min 59 s in: still armed; just past the 10 min TTL: stale.
    assert.equal(armedTaintSpansAt(session, t0 + (10 * 60 * 1000 - 1000)).length, 1);
    assert.equal(armedTaintSpansAt(session, t0 + 10 * 60 * 1000 + 1).length, 0);
    assert.deepEqual(filterTaintedRangesAt(ranges([["m00010", "m00020"]]), session, t0), []);
    assert.deepEqual(filterTaintedRangesAt(ranges([["m00010", "m00020"]]), session, t0 + 10 * 60 * 1000 + 1), ranges([["m00010", "m00020"]]));
});

test("applyFoldTaintToTurn: partial taint shrinks the advertised menu, keeps tier/shouldInject", () => {
    s();
    const session = { id: "t6", metadata: {} } as unknown as Session;
    recordFoldTaintRefusal(session, "m00351..m00373");
    recordFoldTaintRefusal(session, "m00351..m00373");
    const t = turn({
        tier: 1,
        shouldInject: true,
        reason: "growth",
        breakdown: breakdown(),
        compressibleRanges: ranges([
            ["m00351", "m00373"],
            ["m00380", "m00500"],
        ]),
    });
    const excluded = applyFoldTaintToTurn(t, session);
    assert.equal(excluded, 1);
    assert.equal(t.nudge?.tier, 1);
    assert.equal(t.nudge?.shouldInject, true);
    assert.deepEqual(t.nudge?.compressibleRanges, ranges([["m00380", "m00500"]]));
});

test("applyFoldTaintToTurn: whole T1 menu tainted → nudge dropped for the round (tier null, shouldInject false)", () => {
    s();
    const session = { id: "t7", metadata: {} } as unknown as Session;
    recordFoldTaintRefusal(session, "m00300..m00400");
    recordFoldTaintRefusal(session, "m00300..m00400");
    const t = turn({
        tier: 1,
        shouldInject: true,
        reason: "growth",
        breakdown: breakdown(),
        compressibleRanges: ranges([
            ["m00310", "m00340"],
            ["m00350", "m00380"],
        ]),
    });
    const excluded = applyFoldTaintToTurn(t, session);
    assert.equal(excluded, 2);
    assert.equal(t.nudge?.tier, null);
    assert.equal(t.nudge?.shouldInject, false);
    assert.deepEqual(t.nudge?.compressibleRanges, []);
});

test("applyFoldTaintToTurn: EMERGENCY (rangeless) and T2/T3 (block-id) nudges are untouched", () => {
    s();
    const session = { id: "t8", metadata: {} } as unknown as Session;
    recordFoldTaintRefusal(session, "m00300..m00400");
    recordFoldTaintRefusal(session, "m00300..m00400");
    const emergency = turn({
        tier: 1,
        shouldInject: true,
        reason: "pressure",
        breakdown: breakdown({ emergencyOverride: 1 }),
        compressibleRanges: ranges([["m00310", "m00320"]]),
    });
    assert.equal(applyFoldTaintToTurn(emergency, session), 0);
    assert.deepEqual(emergency.nudge?.compressibleRanges, ranges([["m00310", "m00320"]]));
    const t2 = turn({
        tier: 2,
        shouldInject: true,
        reason: "t2",
        breakdown: breakdown(),
        compressibleRanges: ranges([["m00310", "m00320"]]),
        tierTargetBlocks: [],
    });
    assert.equal(applyFoldTaintToTurn(t2, session), 0);
    assert.equal(t2.nudge?.tier, 2);
});

test("unparseable refs fail open (kept)", () => {
    s();
    const session = { id: "t9", metadata: {} } as unknown as Session;
    recordFoldTaintRefusal(session, "m00300..m00400");
    recordFoldTaintRefusal(session, "m00300..m00400");
    // No digit run at all → refNum 0 → the containment check never runs.
    // (b7/b9 would NOT hit this branch: refNum extracts the first digit run,
    // so "b7" parses to 7 and is kept by containment, not by fail-open.)
    assert.deepEqual(filterTaintedRanges([{ startRef: "abc", endRef: "def" }] as unknown as R[], session), [{ startRef: "abc", endRef: "def" }]);
});
