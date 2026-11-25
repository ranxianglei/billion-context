// #6729: nudge-recommended vs actually-folded recovery attribution (#6720).
// Owner ruling (2026-11-14): a fold in the same or next round after a nudge
// injection, plus the consecutive burst that follows it (≤10min between
// folds), all belong to that nudge; anything else is an ACTIVE compression.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompressionBlock } from "acp-kernel";
import {
    buildSessionCacheReport,
    recordCacheFoldsFromBlocks,
    recordNudgeInject,
} from "../src/cache-ledger.ts";
import type { Session } from "../src/session.ts";

let seq = 0;
function makeSession(): Session {
    seq += 1;
    return {
        id: `rec-${seq}`,
        metadata: {},
        stats: {},
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {} },
    } as unknown as Session;
}

function block(id: string, at: number, S: number): CompressionBlock {
    return {
        blockId: id,
        createdAt: at,
        compressedTokens: S,
        summary: "s".repeat(4096),
    } as unknown as CompressionBlock;
}

/** Deterministic clock: recordNudgeInject stamps Date.now() internally. */
function withClock(ms: number, fn: () => void): void {
    const real = Date.now;
    Date.now = () => ms;
    try {
        fn();
    } finally {
        Date.now = real;
    }
}

const MIN = 60_000;

test("nudge same round + burst chain attribute to the nudge", () => {
    const session = makeSession();
    const t0 = Date.now();
    withClock(t0, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 52000 } }));
    recordCacheFoldsFromBlocks(session, [block("b1", t0 + 5_000, 33000)]);
    recordCacheFoldsFromBlocks(session, [block("b2", t0 + 2 * MIN, 10000)]); // burst: 2min after b1

    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec, "recovery section present");
    assert.equal(rec.events.length, 3);
    assert.equal(rec.events[0].kind, "n");
    assert.equal(rec.events[0].paired, true);
    const f1 = rec.events[1];
    assert.equal(f1.kind, "f");
    assert.equal(f1.mode, "n");
    assert.equal(f1.pending, 52000);
    assert.equal(f1.folded, 33000);
    assert.equal(f1.pct, 63.5);
    const f2 = rec.events[2];
    assert.equal(f2.mode, "n", "burst fold stays attributed to the nudge");
    assert.equal(f2.pending, 52000);
    assert.equal(f2.pct, 19.2);
    assert.equal(rec.summary.nudges, 1);
    assert.equal(rec.summary.folds, 2);
    assert.equal(rec.summary.nudgeFolds, 2);
    assert.equal(rec.summary.activeFolds, 0);
    assert.equal(rec.summary.totalPending, 52000);
    assert.equal(rec.summary.totalFolded, 43000);
    assert.equal(rec.summary.pct, Math.round((43000 / 52000) * 1000) / 10);
});

test("fold with no preceding injection is an active compression", () => {
    const session = makeSession();
    recordCacheFoldsFromBlocks(session, [block("b1", Date.now(), 20000)]);
    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    assert.equal(rec.events[0].kind, "f");
    assert.equal(rec.events[0].mode, "a");
    assert.equal(rec.events[0].pending, 0);
    assert.equal(rec.events[0].pct, null);
    assert.equal(rec.summary.activeFolds, 1);
    assert.equal(rec.summary.nudges, 0);
    assert.equal(rec.summary.pct, null, "no nudge arms → no ratio");
});

test("burst chain expires after 10min; stale nudge (>30min) never attributes", () => {
    const session = makeSession();
    const t0 = Date.now();
    withClock(t0, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 100000 } }));
    recordCacheFoldsFromBlocks(session, [block("b1", t0 + 1 * MIN, 40000)]);
    // 11min after b1: chain broken, nudge predates b1 → active.
    recordCacheFoldsFromBlocks(session, [block("b2", t0 + 12 * MIN, 5000)]);
    // Fresh nudge → next fold attributes to it.
    withClock(t0 + 13 * MIN, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 20000 } }));
    recordCacheFoldsFromBlocks(session, [block("b3", t0 + 13 * MIN + 30_000, 8000)]);
    // 32min after the last nudge: stale — the fold is active again, and the
    // stale nudge's pending must NOT label it.
    recordCacheFoldsFromBlocks(session, [block("b4", t0 + 45 * MIN, 1500)]);

    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    const folds = rec.events.filter((e) => e.kind === "f");
    assert.deepEqual(folds.map((f) => f.mode), ["n", "a", "n", "a"]);
    assert.equal((folds[1] as { pending: number }).pending, 100000, "chain break but nudge still fresh → its pending carries");
    assert.equal((folds[3] as { pending: number }).pending, 0, "stale nudge's pending must not label a newer fold");
    assert.equal(rec.summary.activeFolds, 2);
    assert.equal(rec.summary.nudgeFolds, 2);
});

test("summary pairs each nudge arm once; a never-folded arm counts fully in pending", () => {
    const session = makeSession();
    const t0 = Date.now();
    withClock(t0, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 1000 } }));
    recordCacheFoldsFromBlocks(session, [block("b1", t0 + 1 * MIN, 800)]);
    withClock(t0 + 2 * MIN, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 3000 } }));
    recordCacheFoldsFromBlocks(session, [block("b2", t0 + 3 * MIN, 1200)]);
    // Third arm: the model never folded → the ratchet signal.
    withClock(t0 + 4 * MIN, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 9999 } }));

    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    const nudges = rec.events.filter((e) => e.kind === "n");
    assert.deepEqual(nudges.map((n) => n.paired), [true, true, false]);
    assert.equal(rec.summary.nudges, 3);
    assert.equal(rec.summary.folds, 2);
    assert.equal(rec.summary.nudgeFolds, 2);
    assert.equal(rec.summary.totalPending, 13999);
    assert.equal(rec.summary.totalFolded, 2000, "never-folded arm contributes 0 folded");
    assert.equal(rec.summary.pct, Math.round((2000 / 13999) * 1000) / 10);
});

test("a model-active fold does NOT answer a nudge arm (#6729 pairing is nudge-attributed)", () => {
    const session = makeSession();
    const t0 = Date.now();
    withClock(t0, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 5000 } }));
    // 45min later: the nudge is stale (>30min) → the fold is an active
    // compression. It must not consume the arm — the "not folded" ratchet
    // flag survives the model self-compressing after a nudge.
    recordCacheFoldsFromBlocks(session, [block("b1", t0 + 45 * MIN, 2000)]);
    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    const n = rec.events[0];
    assert.equal(n.kind, "n");
    assert.equal(n.paired, false, "active fold must not pair the nudge arm");
    const f = rec.events[1];
    assert.equal(f.kind, "f");
    assert.equal(f.mode, "a");
    assert.equal(rec.summary.nudgeFolds, 0);
    assert.equal(rec.summary.activeFolds, 1);
    assert.equal(rec.summary.totalFolded, 0, "never-nudge-folded arm contributes 0 folded");
});

test("no injections yet → recovery absent, report shape unchanged", () => {
    const session = makeSession();
    const report = buildSessionCacheReport(session);
    assert.equal(report.recovery, undefined);
});

test("nudge without breakdown (non-T1 tier) books zero pending, still arms attribution", () => {
    const session = makeSession();
    const t0 = Date.now();
    withClock(t0, () => recordNudgeInject(session, { tier: 3, breakdown: undefined }));
    recordCacheFoldsFromBlocks(session, [block("b1", t0 + 30_000, 5000)]);
    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    const f = rec.events[1];
    assert.equal(f.kind, "f");
    assert.equal(f.mode, "n", "the fold followed an actual injection");
    assert.equal(f.pending, 0);
    assert.equal(f.pct, null, "zero pending → no ratio, no NaN");
});

test("episodes: partial folds in one nudge round merge into a single 100% point", () => {
    const session = makeSession();
    const t0 = Date.now();
    withClock(t0, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 52000 } }));
    // The demo shape: 4 burst folds of 13000 each (4×25%) → ONE 100% point.
    recordCacheFoldsFromBlocks(session, [
        block("b1", t0 + 5_000, 13000),
        block("b2", t0 + 30_000, 13000),
        block("b3", t0 + 60_000, 13000),
        block("b4", t0 + 90_000, 13000),
    ]);
    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    assert.equal(rec.episodes.length, 1);
    const ep = rec.episodes[0];
    assert.equal(ep.pending, 52000);
    assert.equal(ep.folded, 52000);
    assert.equal(ep.pct, 100);
    assert.equal(ep.activeFolds, 0);
});

test("episodes: per-round ratios stay separate; in-window actives are markers, not numerator", () => {
    const session = makeSession();
    const t0 = Date.now();
    // Round 1: 52% recovery — the ratchet shape.
    withClock(t0, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 10000 } }));
    recordCacheFoldsFromBlocks(session, [block("b1", t0 + 30_000, 5200)]);
    // An active compression inside round 1's window (11.5min after b1: chain expired).
    recordCacheFoldsFromBlocks(session, [block("b2", t0 + 12 * MIN, 9000)]);
    // Round 2: 40%.
    withClock(t0 + 13 * MIN, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 20000 } }));
    recordCacheFoldsFromBlocks(session, [block("b3", t0 + 13 * MIN + 30_000, 8000)]);
    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    assert.equal(rec.episodes.length, 2);
    assert.equal(rec.episodes[0].pct, 52);
    assert.equal(rec.episodes[0].folded, 5200);
    assert.equal(rec.episodes[0].activeFolds, 1, "active fold rides as a marker, never in the numerator");
    assert.equal(rec.episodes[1].pct, 40);
    assert.equal(rec.summary.pct, Math.round((13200 / 30000) * 1000) / 10);
});

test("episodes: an active fold before the first nudge does not enter any round", () => {
    const session = makeSession();
    const t0 = Date.now();
    recordCacheFoldsFromBlocks(session, [block("b1", t0, 3000)]);
    withClock(t0 + 2 * MIN, () => recordNudgeInject(session, { tier: 1, breakdown: { pendingT1: 4000 } }));
    recordCacheFoldsFromBlocks(session, [block("b2", t0 + 2 * MIN + 30_000, 4000)]);
    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    assert.equal(rec.episodes.length, 1);
    assert.equal(rec.episodes[0].pct, 100);
    assert.equal(rec.episodes[0].activeFolds, 0);
});

test("episodes: non-T1 nudge round keeps pct null (no NaN)", () => {
    const session = makeSession();
    const t0 = Date.now();
    withClock(t0, () => recordNudgeInject(session, { tier: 3, breakdown: undefined }));
    recordCacheFoldsFromBlocks(session, [block("b1", t0 + 30_000, 5000)]);
    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    assert.equal(rec.episodes.length, 1);
    assert.equal(rec.episodes[0].pending, 0);
    assert.equal(rec.episodes[0].folded, 5000);
    assert.equal(rec.episodes[0].pct, null);
});

test("folds-only session: no nudge rounds → no episodes", () => {
    const session = makeSession();
    const t0 = Date.now();
    recordCacheFoldsFromBlocks(session, [block("b1", t0, 20000), block("b2", t0 + 5_000, 4000)]);
    const rec = buildSessionCacheReport(session).recovery;
    assert.ok(rec);
    assert.equal(rec.episodes.length, 0);
    assert.equal(rec.summary.nudges, 0);
    assert.equal(rec.summary.activeFolds, 2);
});
