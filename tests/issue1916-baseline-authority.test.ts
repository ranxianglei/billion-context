import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { createInitialState, defaultConfig } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { admitUsageSample, markCompactionBoundary, storeEffectiveConfig } from "../src/session.ts";
import { buildSessionCacheReport, getCacheLedger, settleUsageReport } from "../src/cache-ledger.ts";
import { applyUsageSample } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";

// #1916: two concurrent streams on one session id clobber each other's
// lastInputTokens baseline — a host-internal single-message context-dump call
// (DSH auto-review, "B族") settles its own small usage report onto the main
// stream's baseline as usage-grade, dragging the nudge reference down (#1595
// re-anchor fires on the foreign sample) and poisoning every consumer of the
// baseline (preflight floor, window self-heal, cache ledger, fold metering).
// Fix: an authority gate at the single settle choke point — a usage-grade
// sample may LOWER a usage-grade baseline past one growth interval only when
// it is explained (this request folded / a pending compaction boundary,
// single-use, multi-message shaped) or after a streak of multi-message-shaped
// samples (escape valve). Single-message foreign samples can never move the
// baseline down. Non-usage baselines (overflow-arm / estimate) are always
// superseded by real reports (#1110 arm retirement must not deadlock).
// Pins:
//   A: incident repro — mature usage baseline + foreign low single-message
//      sample quarantined end-to-end (baseline/nudge refs/aggregates/ledger);
//   B: #1595 positive control — an unexplained drop within one margin still
//      retires a stale-high reference (the gate must not eat #1595's fix);
//   C: upward samples always admitted;
//   D: non-usage provenance bypasses the gate (arm retirement, no deadlock);
//   E: request-scoped post-fold explanation admits a big drop;
//   F: compaction-boundary explanation is single-use AND shape-gated (a
//      single-message stream cannot steal the flag);
//   G: escape valve — multi-message streak admits on the third sample;
//      single-message streaks never admit;
//   H: heptaspirit 0.1.180 opening damage (71901 -> 17171) quarantined under
//      the default flat 50k margin;
//   I: plugin lane threads the same parameters (applyUsageSample wiring);
//   K: meter switch (#1536 identity change) admits an incomparable reading;
//   L: young sessions (< REWRITE_MIN_KNOWN_REFS refs) stay unarmed — thin
//      stateless clients keep their stale-baseline rescue (e2e-image-billing);
//   J: helper edges — zero total / absent baseline admit without side effects;
//   M: streak semantics — unshaped spam can't pre-charge the valve, any
//      admission resets the run.

const INCIDENT_BASELINE = 251_655; // A族 input in the #1911 decisive sequence
const FOREIGN_SAMPLE = 69_419; // B族 input — the fold denominator that poisoned #1911
const NUDGE_REF = 247_994; // the reference #1595 wrongly retired to 69419
const MARGIN = 150_000; // owner config compress.nudgeGrowthTokens in the incident

function makeSession(): Session {
    return {
        id: "issue1916-test",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function seedRefs(s: Session, n: number): void {
    for (let i = 0; i < n; i++) {
        s.state.messageRefs.byRaw[`raw-${i}`] = `m${String(i + 1).padStart(5, "0")}`;
        s.state.messageRefs.byRef[`m${String(i + 1).padStart(5, "0")}`] = `raw-${i}`;
    }
}

function captureLogs<T>(fn: () => T): { lines: string[]; result: T } {
    const lines: string[] = [];
    setLogCapture((_level, msg) => { lines.push(msg); });
    try {
        const result = fn();
        return { lines, result };
    } finally {
        setLogCapture(null);
    }
}

/** Mature main-stream baseline exactly as the incident left it before the
 *  foreign sample arrived: usage-grade, high nudge reference, owner-flattened
 *  150k margin (tests F/G pass a smaller margin so post-admission drops stay
 *  beyond one interval of the NEW, lower baseline). */
function matureSession(margin: number = MARGIN): Session {
    const s = makeSession();
    s.stats.lastInputTokens = INCIDENT_BASELINE;
    s.stats.lastUsageGradeTokens = INCIDENT_BASELINE;
    s.stats.lastInputTokensSource = "usage";
    s.stats.inputTokens = 1_000_000;
    s.stats.cachedTokens = 500_000;
    s.stats.cacheSamples = 40;
    s.state.nudge.lastNudgeShownTokens = NUDGE_REF;
    s.state.nudge.lastPerMessageNudgeTokens = 100_000;
    seedRefs(s, 24); // the gate arms at >= REWRITE_MIN_KNOWN_REFS (20) known refs
    const cfg = defaultConfig(1_000_000);
    cfg.nudge.growthFloor = cfg.nudge.growthCap = margin;
    storeEffectiveConfig(s, cfg);
    return s;
}

test("#1916 A: incident repro — foreign low single-message sample is quarantined end-to-end", () => {
    const s = matureSession();
    const ledgerBefore = getCacheLedger(s).lines.length;
    const { lines } = captureLogs(() => {
        settleUsageReport(s, { total: FOREIGN_SAMPLE, reportedCached: 3072, output: 10, protocol: "anthropic", incomingMsgCount: 1 });
    });
    assert.equal(s.stats.lastInputTokens, INCIDENT_BASELINE, "baseline untouched");
    assert.equal(s.stats.lastUsageGradeTokens, INCIDENT_BASELINE, "usage-grade marker untouched");
    assert.equal(s.stats.lastInputTokensSource, "usage");
    assert.equal(s.state.nudge.lastNudgeShownTokens, NUDGE_REF, "#1595 re-anchor unreachable — reference intact");
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 100_000);
    assert.equal(s.stats.inputTokens, 1_000_000, "aggregate input not polluted");
    assert.equal(s.stats.cachedTokens, 500_000, "aggregate cached not polluted");
    assert.equal(s.stats.cacheSamples, 40, "sample count not polluted");
    assert.equal(getCacheLedger(s).lines.length, ledgerBefore, "cache ledger got no foreign entry");
    assert.ok(lines.some((l) => l.includes("quarantined foreign usage sample input=69419")), `quarantine warn missing: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => l.includes("re-anchored")), `re-anchor must not fire on a quarantined sample: ${JSON.stringify(lines)}`);
});

test("#1916 B: positive control — unexplained drop within one margin still retires a stale-high reference (#1595)", () => {
    const s = makeSession();
    s.stats.lastInputTokens = 150_000; // baseline
    s.stats.lastInputTokensSource = "usage";
    s.state.nudge.lastNudgeShownTokens = 300_000; // phantom-high shown reference
    s.state.nudge.lastPerMessageNudgeTokens = 135_000;
    const { lines } = captureLogs(() => {
        settleUsageReport(s, { total: 140_000, reportedCached: null, protocol: "anthropic", incomingMsgCount: 50 });
    });
    assert.equal(s.stats.lastInputTokens, 140_000, "within-margin drop admitted");
    assert.equal(s.state.nudge.lastNudgeShownTokens, 0, "stale-high reference retired");
    assert.equal(s.state.nudge.lastPerMessageNudgeTokens, 140_000);
    assert.ok(lines.some((l) => l.includes("nudge reference re-anchored 300000 -> 140000")), `#1595 re-anchor missing: ${JSON.stringify(lines)}`);
});

test("#1916 C: upward samples are always admitted", () => {
    const s = matureSession();
    const { lines } = captureLogs(() => {
        settleUsageReport(s, { total: 260_000, reportedCached: 250_000, protocol: "anthropic", incomingMsgCount: 1 });
    });
    assert.equal(s.stats.lastInputTokens, 260_000);
    assert.ok(!lines.some((l) => l.includes("quarantined")), `upward sample must pass: ${JSON.stringify(lines)}`);
});

test("#1916 D: non-usage provenance always yields to a real report (arm retirement, no deadlock)", () => {
    const s = makeSession();
    s.stats.lastInputTokens = 1_000_000;
    s.stats.lastInputTokensSource = "overflow-arm";
    s.stats.overflowArmTokens = 1_000_000;
    s.state.nudge.lastNudgeShownTokens = 1_000_000;
    const { lines } = captureLogs(() => {
        settleUsageReport(s, { total: 250_000, reportedCached: 200_000, protocol: "anthropic", incomingMsgCount: 1 });
    });
    assert.equal(s.stats.lastInputTokens, 250_000, "real report superseded the armed estimate");
    assert.equal(s.stats.lastInputTokensSource, "usage");
    assert.equal(s.stats.overflowArmTokens, undefined, "#1110 arm retired by the same report");
    assert.ok(!lines.some((l) => l.includes("quarantined")), `non-usage baseline must not be gated: ${JSON.stringify(lines)}`);
});

test("#1916 E: request-scoped post-fold explanation admits a big drop", () => {
    const s = matureSession();
    const { lines } = captureLogs(() => {
        settleUsageReport(s, { total: FOREIGN_SAMPLE, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 300, postFold: true });
    });
    assert.equal(s.stats.lastInputTokens, FOREIGN_SAMPLE, "post-fold reality adopted");
    assert.ok(lines.some((l) => l.includes("post-fold usage sample input=69419 admitted")), `post-fold admit log missing: ${JSON.stringify(lines)}`);
});

test("#1916 F: compaction-boundary explanation is single-use and shape-gated", () => {
    const s = matureSession(20_000);
    markCompactionBoundary(s);
    const { lines: l1 } = captureLogs(() => {
        settleUsageReport(s, { total: FOREIGN_SAMPLE, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 1 });
    });
    assert.equal(s.stats.lastInputTokens, INCIDENT_BASELINE, "single-message stream cannot steal the boundary flag");
    const b1 = s.metadata.compactionBoundary as Record<string, unknown> | undefined;
    assert.ok(b1 && !("usageConsumedAt" in b1), "flag still unconsumed for the legitimate consumer");
    assert.ok(l1.some((l) => l.includes("quarantined")), `expected quarantine while flag unstealable: ${JSON.stringify(l1)}`);

    const { lines: l2 } = captureLogs(() => {
        settleUsageReport(s, { total: FOREIGN_SAMPLE, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
    });
    assert.equal(s.stats.lastInputTokens, FOREIGN_SAMPLE, "multi-message consumer admitted through the flag");
    const b2 = s.metadata.compactionBoundary as Record<string, unknown> | undefined;
    assert.ok(b2 && "usageConsumedAt" in b2, "flag consumed exactly once");
    assert.ok(l2.some((l) => l.includes("compaction-boundary") && l.includes("admitted")), `boundary admit log missing: ${JSON.stringify(l2)}`);

    const { lines: l3 } = captureLogs(() => {
        settleUsageReport(s, { total: 49_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
    });
    assert.equal(s.stats.lastInputTokens, FOREIGN_SAMPLE, "consumed flag does not admit a further drop beyond the new baseline's interval");
    assert.ok(l3.some((l) => l.includes("quarantined")), `sample after consumption must quarantine: ${JSON.stringify(l3)}`);
});

test("#1916 G: escape valve admits on a multi-message streak, never on single-message streaks", () => {
    const s = matureSession(20_000);
    for (let i = 0; i < 3; i++) {
        captureLogs(() => {
            settleUsageReport(s, { total: FOREIGN_SAMPLE + i, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 1 });
        });
    }
    assert.equal(s.stats.lastInputTokens, INCIDENT_BASELINE, "three single-message foreign samples never move the baseline down");

    const s2 = matureSession(20_000);
    const { lines: l12 } = captureLogs(() => {
        settleUsageReport(s2, { total: 90_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
        settleUsageReport(s2, { total: 91_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
    });
    assert.equal(s2.stats.lastInputTokens, INCIDENT_BASELINE, "first two multi-message samples quarantine (streak building)");
    assert.ok(l12.filter((l) => l.includes("quarantined")).length === 2, `expected two quarantines, got ${JSON.stringify(l12)}`);
    const { lines: l3rd } = captureLogs(() => {
        settleUsageReport(s2, { total: 92_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
    });
    assert.equal(s2.stats.lastInputTokens, 92_000, "third consecutive multi-message sample admitted (legit truncation path)");
    assert.ok(l3rd.some((l) => l.includes("escape valve")), `valve log missing: ${JSON.stringify(l3rd)}`);
    const { lines: lAfter } = captureLogs(() => {
        settleUsageReport(s2, { total: 50_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 1 });
    });
    assert.equal(s2.stats.lastInputTokens, 92_000, "streak reset after admission — a lone single-message drop beyond the new interval quarantines again");
    assert.ok(lAfter.some((l) => l.includes("quarantined")), `post-valve single-message sample must quarantine: ${JSON.stringify(lAfter)}`);
});

test("#1916 H: heptaspirit 0.1.180 opening damage quarantined under the default flat 50k margin", () => {
    const s = makeSession();
    s.stats.lastInputTokens = 71_901;
    s.stats.lastInputTokensSource = "usage";
    s.state.nudge.lastNudgeShownTokens = 71_901;
    seedRefs(s, 24); // their session id carried real history across the capture boundary
    const { lines } = captureLogs(() => {
        settleUsageReport(s, { total: 17_171, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 1 });
    });
    assert.equal(s.stats.lastInputTokens, 71_901, "baseline held (71901 > 17171 + 50000)");
    assert.equal(s.state.nudge.lastNudgeShownTokens, 71_901, "reference not dragged to 17171");
    assert.ok(lines.some((l) => l.includes("quarantined foreign usage sample input=17171")), `quarantine warn missing: ${JSON.stringify(lines)}`);
    assert.ok(!lines.some((l) => l.includes("re-anchored")), `re-anchor must not fire: ${JSON.stringify(lines)}`);
});

test("#1916 I: plugin lane threads the authority parameters (applyUsageSample wiring)", () => {
    const s = matureSession();
    captureLogs(() => {
        applyUsageSample(s, { inputTokens: FOREIGN_SAMPLE, cachedTokens: 3072 }, "anthropic", undefined, 1, false);
    });
    assert.equal(s.stats.lastInputTokens, INCIDENT_BASELINE, "plugin pipe quarantines a single-message foreign sample");
    const s2 = matureSession();
    const { lines } = captureLogs(() => {
        applyUsageSample(s2, { inputTokens: FOREIGN_SAMPLE, cachedTokens: 3072 }, "anthropic");
    });
    assert.equal(s2.stats.lastInputTokens, INCIDENT_BASELINE, "unshaped plugin sample fails closed (valve unavailable)");
    assert.ok(lines.some((l) => l.includes("quarantined")), `expected quarantine: ${JSON.stringify(lines)}`);
});

test("#1916 K: a wire/upstream meter switch is not comparable to the old baseline and admits", () => {
    const s = makeSession();
    settleUsageReport(s, { total: 100_000, reportedCached: 90_000, protocol: "anthropic", upstream: "https://a.example" });
    assert.equal(s.stats.lastInputTokens, 100_000, "first sample establishes baseline");
    seedRefs(s, 24); // armed session so the identity branch is what admits
    const { lines } = captureLogs(() => {
        settleUsageReport(s, { total: 40_000, reportedCached: 0, protocol: "openai", upstream: "https://a.example" });
    });
    assert.equal(s.stats.lastInputTokens, 40_000, "wire-switch sample admitted despite the drop (new meter)");
    assert.ok(lines.some((l) => l.includes("meter-switch")), `meter-switch log missing: ${JSON.stringify(lines)}`);
    const r = buildSessionCacheReport(s);
    assert.equal(r.wireSwitches.count, 1, "the #1536 wire switch is still flagged");

    const s2 = makeSession();
    settleUsageReport(s2, { total: 100_000, reportedCached: 90_000, protocol: "openai", upstream: "https://a.example" });
    seedRefs(s2, 24);
    const { lines: lUp } = captureLogs(() => {
        settleUsageReport(s2, { total: 40_000, reportedCached: 0, protocol: "openai", upstream: "https://b.example" });
    });
    assert.equal(s2.stats.lastInputTokens, 40_000, "upstream-only switch admits too");
    assert.ok(lUp.some((l) => l.includes("meter-switch")), `upstream meter-switch log missing: ${JSON.stringify(lUp)}`);
    assert.equal(buildSessionCacheReport(s2).upstreamSwitches.count, 1, "#1536 upstream switch still flagged");

    const s3 = makeSession();
    settleUsageReport(s3, { total: 100_000, reportedCached: 90_000, protocol: "openai", upstream: "https://a.example" });
    seedRefs(s3, 24);
    const { lines: lSame } = captureLogs(() => {
        settleUsageReport(s3, { total: 40_000, reportedCached: 0, protocol: "openai", upstream: "https://a.example", incomingMsgCount: 1 });
    });
    assert.equal(s3.stats.lastInputTokens, 100_000, "same-meter low single-message sample stays quarantined (no false identity pass)");
    assert.ok(lSame.some((l) => l.includes("quarantined")), `expected quarantine on same meter: ${JSON.stringify(lSame)}`);
});

test("#1916 L: young sessions stay unarmed — thin stateless clients keep their stale-baseline rescue", () => {
    const s = makeSession();
    settleUsageReport(s, { total: 50_000, reportedCached: 40_000, protocol: "openai", upstream: "https://a.example" });
    s.stats.lastInputTokens = 260_144; // stamped stale-high at the window edge (e2e-image-billing incident class)
    s.stats.lastInputTokensSource = "usage";
    seedRefs(s, 3); // far below REWRITE_MIN_KNOWN_REFS: no resident main stream to defend
    const { lines } = captureLogs(() => {
        settleUsageReport(s, { total: 49_775, reportedCached: null, output: 5, protocol: "openai", upstream: "https://a.example", incomingMsgCount: 1 });
    });
    assert.equal(s.stats.lastInputTokens, 49_775, "legitimate low sample from the session's own stream regresses the baseline");
    assert.ok(!lines.some((l) => l.includes("quarantined")), `unarmed session must not quarantine: ${JSON.stringify(lines)}`);

    const armed = makeSession();
    settleUsageReport(armed, { total: 50_000, reportedCached: 40_000, protocol: "openai", upstream: "https://a.example" });
    armed.stats.lastInputTokens = 260_144;
    armed.stats.lastInputTokensSource = "usage";
    seedRefs(armed, 24); // same drop, substantial history present -> the gate arms
    const { lines: lArmed } = captureLogs(() => {
        settleUsageReport(armed, { total: 49_775, reportedCached: null, output: 5, protocol: "openai", upstream: "https://a.example", incomingMsgCount: 1 });
    });
    assert.equal(armed.stats.lastInputTokens, 260_144, "the identical drop IS quarantined once the session carries real history");
    assert.ok(lArmed.some((l) => l.includes("quarantined")), `armed session must quarantine: ${JSON.stringify(lArmed)}`);
});

test("#1916 M: streak semantics — unshaped spam cannot pre-charge the valve, any admission resets the run", () => {
    const s = matureSession(20_000);
    for (let i = 0; i < 3; i++) {
        captureLogs(() => {
            settleUsageReport(s, { total: FOREIGN_SAMPLE + i, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 1 });
        });
    }
    assert.equal(s.foreignSampleStreak, undefined, "unshaped spam neither advances nor pre-charges the run");
    const { lines: lShaped } = captureLogs(() => {
        settleUsageReport(s, { total: 88_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
    });
    assert.equal(s.stats.lastInputTokens, INCIDENT_BASELINE, "first shaped low sample quarantines despite three prior unshaped ones (no stolen streak)");
    assert.ok(lShaped.some((l) => l.includes("quarantined")), `expected quarantine of the shaped sample: ${JSON.stringify(lShaped)}`);
    assert.ok(!lShaped.some((l) => l.includes("escape valve")), `valve must not fire off a pre-charged run: ${JSON.stringify(lShaped)}`);

    const s2 = matureSession(20_000);
    captureLogs(() => {
        settleUsageReport(s2, { total: 90_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
        settleUsageReport(s2, { total: 91_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
        settleUsageReport(s2, { total: 300_000, reportedCached: 250_000, protocol: "anthropic", incomingMsgCount: 12 });
    });
    assert.equal(s2.stats.lastInputTokens, 300_000, "upward sample admitted");
    assert.equal(s2.foreignSampleStreak, undefined, "the admission reset the run");
    const { lines: lAfter } = captureLogs(() => {
        settleUsageReport(s2, { total: 80_000, reportedCached: 3072, protocol: "anthropic", incomingMsgCount: 12 });
    });
    assert.equal(s2.stats.lastInputTokens, 300_000, "post-admission low sample starts a fresh run — quarantined at count one");
    assert.ok(lAfter.some((l) => l.includes("quarantined")), `expected fresh-run quarantine: ${JSON.stringify(lAfter)}`);
    assert.ok(!lAfter.some((l) => l.includes("escape valve")), `valve must not ride a stale pre-admission run: ${JSON.stringify(lAfter)}`);
});

test("#1916 J: helper edge — zero/non-positive and no-baseline states admit without side effects", () => {
    const s = matureSession();
    assert.equal(admitUsageSample(s, 0), true, "zero-total samples skip the gate entirely");
    const fresh = makeSession();
    assert.equal(admitUsageSample(fresh, 5_000, 1), true, "absent baseline (source unset) admits the first real report");
    assert.equal(fresh.foreignSampleStreak, undefined, "no streak bookkeeping on the fast path");
});
