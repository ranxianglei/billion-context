// #context-analysis — per-session context observability (init size, nudge
// cadence, compression acceptance rate, plain-language verdict).
// Born from the 2026-11-08 session-aedc188c investigation: the session sat at
// 40-52% and nobody could say whether it was the init size, the nudge cadence,
// or the model under-harvesting the offered mass — that took hours of manual
// log forensics. These tests pin the four dimensions + the caps.
import assert from "node:assert";
import { test } from "node:test";

import {
    contextAnalysisView,
    formatContextAnalysis,
    HARVEST_WINDOW_MS,
    recordCompressCommit,
    recordNudgeObservation,
    resetContextAnalysisForTest,
} from "../src/context-analysis.js";

function msg(id: string, chars: number, role: "user" | "assistant" = "user") {
    return { id: `m${id}`, role, contentType: "text" as const, text: "x".repeat(chars) };
}

function nudgeTurn(pendingT1: number, pendingT2 = 0, growth = 1000, reason = "idle") {
    return {
        nudge: {
            shouldInject: pendingT1 >= 50000 && growth >= 22500,
            reason,
            contextUsage: 0.4,
            tier: 1,
            breakdown: { nudgeGrowthTokens: 50000, pendingT1, pendingT2, pendingT3: 0, growth, growthFloor: 22500 },
        },
        messages: [msg("1", 4000), msg("2", 900)],
    };
}

/** Stub Date.now with a controllable clock; restored on exit. */
function withClock(fn: (now: () => number, set: (t: number) => void) => void): void {
    const realNow = Date.now;
    let t = realNow() - 3_600_000; // one hour of history (verdicts need ≥1 min)
    try {
        Date.now = () => t;
        fn(() => t, (x) => (t = x));
    } finally {
        Date.now = realNow;
    }
}

test("young sessions report nothing (requests < 2)", () => {
    resetContextAnalysisForTest();
    assert.equal(formatContextAnalysis("s-young"), null, "no requests yet");
    recordNudgeObservation("s-young", nudgeTurn(60000, 0, 30000), 300_000, 750_000, false);
    assert.equal(formatContextAnalysis("s-young"), null, "must be null with <2 requests");
});

test("first request snapshots the init profile (size + per-message sample)", () => {
    resetContextAnalysisForTest();
    recordNudgeObservation(
        "s-init",
        { nudge: null, messages: [msg("1", 200_000), msg("2", 4000), msg("3", 3000)] },
        50_000,
        750_000,
        false,
    );
    recordNudgeObservation("s-init", { nudge: null }, 52_000, 750_000, false);
    const v = contextAnalysisView("s-init")!;
    if (!v.init) throw new Error("init profile captured");
    if (v.init.messageCount !== 3) throw new Error("messageCount");
    if (!(v.init.estTokens > 40_000)) throw new Error("estimated tokens reflect the 200KB message");
    const top = v.init.perMessage[0]!;
    const second = v.init.perMessage[1]!;
    if (!(top.estTokens > second.estTokens)) throw new Error("largest first");
    const lines = formatContextAnalysis("s-init")!;
    if (!lines.some((l) => l.startsWith("init:"))) throw new Error(`init line present: ${lines.join(" | ")}`);
});

test("heavy-init verdict fires when the first request already carries ≥15% of the window", () => {
    resetContextAnalysisForTest();
    withClock((now, set) => {
        recordNudgeObservation("s-heavy", { nudge: null, messages: [msg("1", 900_000)] }, 150_000, 750_000, false);
        set(now() + 90_000); // verdict needs a ≥60s span
        recordNudgeObservation("s-heavy", { nudge: null }, 152_000, 750_000, false);
        const lines = formatContextAnalysis("s-heavy", now())!;
        if (!lines.some((l) => l.includes("session started heavy"))) throw new Error(lines.join(" | "));
    });
});

test("idle gate classification: mass / growth / cadence; unclassified (count-ready T2) → other", () => {
    resetContextAnalysisForTest();
    recordNudgeObservation("s-gate", nudgeTurn(30000, 0, 5000, "max compressible 30000 < threshold 50000"), 200_000, 750_000, false);
    recordNudgeObservation("s-gate", nudgeTurn(60000, 0, 5000, "growth 5000 + absorbed 0 held (single abort) < floor 22500"), 201_000, 750_000, false);
    recordNudgeObservation("s-gate", nudgeTurn(60000, 0, 30000, "max compressible 60000, growth 30000, blocked: T1 (cadence)"), 202_000, 750_000, false);
    // The kernel emits no distill-specific idle reason — count-ready T2 idles
    // land in other (T2 readiness is reported from lastReadiness/verdict).
    recordNudgeObservation("s-gate", nudgeTurn(60000, 76_000, 30000, "max compressible 60000, growth 30000, ready: T2 5 blocks (count)"), 203_000, 750_000, false);
    const v = contextAnalysisView("s-gate")!;
    if (v.idleGates.mass !== 1) throw new Error(`mass: ${JSON.stringify(v.idleGates)}`);
    if (v.idleGates.growth !== 1) throw new Error(`growth: ${JSON.stringify(v.idleGates)}`);
    if (v.idleGates.cadence !== 1) throw new Error(`cadence: ${JSON.stringify(v.idleGates)}`);
    if (v.idleGates.other !== 1) throw new Error(`other: ${JSON.stringify(v.idleGates)}`);
});

test("INJECT is recorded and returns a digest line; commit pairs into a harvest record", () => {
    resetContextAnalysisForTest();
    recordNudgeObservation("s-h", { nudge: null, messages: [msg("1", 1000)] }, 300_000, 750_000, false);
    const line = recordNudgeObservation("s-h", nudgeTurn(52_000, 8000, 30_000, "ready"), 310_000, 750_000, true);
    if (!line) throw new Error("digest line returned on INJECT");
    if (!line.includes("INJECT T1")) throw new Error(line);
    recordCompressCommit("s-h", 20_000, 1); // 20K of the offered 52K
    const v = contextAnalysisView("s-h")!;
    if (v.injectTotal !== 1) throw new Error("injectTotal");
    if (v.compressCommits !== 1) throw new Error("compressCommits");
    if (v.harvests.length !== 1) throw new Error(`harvests: ${JSON.stringify(v.harvests)}`);
    const ratio = v.harvests[0]!.ratio;
    if (Math.abs(ratio - 20_000 / 52_000) > 0.01) throw new Error(`ratio ${ratio}`);
    const lines = formatContextAnalysis("s-h")!;
    if (!lines.some((l) => l.startsWith("harvest:"))) throw new Error(lines.join(" | "));
});

test("harvest denominator follows the injected tier (T2 offer vs T2 mass)", () => {
    resetContextAnalysisForTest();
    recordNudgeObservation("s-t2", { nudge: null, messages: [msg("1", 1000)] }, 400_000, 750_000, false);
    recordNudgeObservation(
        "s-t2",
        {
            nudge: {
                shouldInject: true,
                reason: "ready",
                contextUsage: 0.53,
                tier: 2,
                breakdown: { nudgeGrowthTokens: 50000, pendingT1: 0, pendingT2: 80_000, pendingT3: 0, growth: 30_000, growthFloor: 22500 },
            },
            messages: [msg("1", 1000)],
        },
        400_000,
        750_000,
        true,
    );
    recordCompressCommit("s-t2", 80_000, 1); // model folded exactly the offered T2 mass
    const v = contextAnalysisView("s-t2")!;
    if (v.harvests.length !== 1) throw new Error(`harvests: ${JSON.stringify(v.harvests)}`);
    const h = v.harvests[0]!;
    if (h.offered !== 80_000) throw new Error(`offered must be the T2 mass, got ${h.offered}`);
    if (Math.abs(h.ratio - 1) > 1e-9) throw new Error(`full execution must read ratio 1, got ${h.ratio}`);
});

test("under-harvest verdict: 2 of 4 offers answered at <50%", () => {
    resetContextAnalysisForTest();
    withClock((now, set) => {
        recordNudgeObservation("s-u", { nudge: null, messages: [msg("1", 1000)] }, 300_000, 750_000, false);
        for (let i = 0; i < 4; i++) {
            set(now() + 300_000);
            recordNudgeObservation("s-u", nudgeTurn(50_000, 0, 30_000, "ready"), 300_000 + i * 10_000, 750_000, true);
            set(now() + 60_000); // commit inside the 120s harvest window
            const got = i % 2 === 0 ? 10_000 : 55_000; // under, over
            recordCompressCommit("s-u", got, 1);
        }
        const v = contextAnalysisView("s-u")!;
        const under = v.harvests.filter((h) => h.ratio < 0.5);
        if (under.length !== 2) throw new Error(`under-harvest count: ${JSON.stringify(v.harvests)}`);
        const lines = formatContextAnalysis("s-u", now())!;
        if (!lines.some((l) => l.includes("under-harvested"))) throw new Error(lines.join(" | "));
    });
});

test("commits outside the harvest window do not pair", () => {
    resetContextAnalysisForTest();
    withClock((now, set) => {
        recordNudgeObservation("s-w", { nudge: null, messages: [msg("1", 1000)] }, 300_000, 750_000, false);
        recordNudgeObservation("s-w", nudgeTurn(50_000, 0, 30_000, "ready"), 300_000, 750_000, true);
        set(now() + HARVEST_WINDOW_MS + 5000); // commit too late to be the answer
        recordCompressCommit("s-w", 50_000, 1);
        const v = contextAnalysisView("s-w")!;
        if (v.harvests.length !== 0) throw new Error("no pairing outside the window");
        if (v.compressCommits !== 1) throw new Error("compressCommits");
    });
});

test("usage/commit rings power the inflow-vs-drain verdict", () => {
    resetContextAnalysisForTest();
    withClock((now, set) => {
        recordNudgeObservation("s-b", { nudge: null, messages: [msg("1", 1000)] }, 200_000, 750_000, false);
        set(now() + 1_800_000); // 30-min steps
        recordNudgeObservation("s-b", nudgeTurn(50_000, 0, 30_000, "ready"), 300_000, 750_000, true);
        set(now() + 60_000);
        recordCompressCommit("s-b", 10_000, 1);
        set(now() + 1_200_000);
        recordNudgeObservation("s-b", nudgeTurn(50_000, 0, 30_000, "ready"), 400_000, 750_000, true);
        set(now() + 60_000);
        recordCompressCommit("s-b", 10_000, 1);
        set(now() + 1_200_000);
        recordNudgeObservation("s-b", nudgeTurn(50_000, 0, 30_000, "ready"), 500_000, 750_000, true);
        set(now() + 60_000);
        recordCompressCommit("s-b", 10_000, 1);
        // inflow 100K/h vs cumulative drain 20K/h → climbing
        const lines = formatContextAnalysis("s-b", now())!;
        if (!lines.some((l) => l.includes("usage climbing"))) throw new Error(lines.join(" | "));
    });
});

test("session cap evicts the coldest session (LRU)", () => {
    resetContextAnalysisForTest();
    withClock((now, set) => {
        for (let i = 0; i < 300; i++) {
            set(now() + 1000);
            recordNudgeObservation(`s-${i}`, { nudge: null, messages: [msg("1", 100)] }, 100_000, 750_000, false);
            recordNudgeObservation(`s-${i}`, { nudge: null }, 100_500, 750_000, false);
        }
        // 256 cap: s-0..s-43 evicted, s-299 kept
        if (contextAnalysisView("s-0") !== null) throw new Error("s-0 must be evicted");
        if (!contextAnalysisView("s-299")) throw new Error("newest session survives");
        // LRU: touching s-255 keeps it alive while 40 more land
        recordNudgeObservation("s-255", { nudge: null }, 101_000, 750_000, false);
        for (let i = 300; i < 340; i++) {
            set(now() + 1000);
            recordNudgeObservation(`s-${i}`, { nudge: null }, 101_000, 750_000, false);
            recordNudgeObservation(`s-${i}`, { nudge: null }, 101_500, 750_000, false);
        }
        if (!contextAnalysisView("s-255")) throw new Error("touched session survives the next 40");
    });
});

test("digest line format: label, usage, report joined; idle stays quiet except every 60th gate", () => {
    resetContextAnalysisForTest();
    recordNudgeObservation("s-f", { nudge: null, messages: [msg("1", 1000)] }, 300_000, 750_000, false);
    const line = recordNudgeObservation("s-f", nudgeTurn(52_000, 0, 30_000, "ready"), 310_000, 750_000, true);
    if (!line || !line.startsWith("[context-analysis] s-f INJECT T1 @41% — ")) throw new Error(line ?? "null line");
    if (!line.includes("injects: 1")) throw new Error(line);
    for (let i = 0; i < 59; i++) {
        const l = recordNudgeObservation("s-f", nudgeTurn(30_000, 0, 1000, "max compressible 30000 < threshold 50000"), 311_000, 750_000, false);
        if (l !== null) throw new Error(`idle line ${i} must be quiet: ${l}`);
    }
    const every60th = recordNudgeObservation("s-f", nudgeTurn(30_000, 0, 1000, "max compressible 30000 < threshold 50000"), 312_000, 750_000, false);
    if (!every60th) throw new Error("60th idle gate logs a digest");
    if (!every60th.includes("idle @42%")) throw new Error(every60th);
});
