// #5152: the watchdog's stale-heartbeat reading is taken on the PROXY's own
// event loop, so it is only meaningful while that loop can run.
//
// The reading comes from POST /__bili/watcher being HANDLED, and the ticker
// that consumes it runs on the SAME loop. One long synchronous turn therefore
// starves both: the beat is never recorded, its age grows through no fault of
// the owner, and the first tick after recovery removes a LIVE pid.
//
// This file pins the pure seam (`effectiveHeartbeatGrace`) and the removal
// semantics it must not break. The real timing geometry is pinned separately in
// tests/issue5152-watchdog-loop-lag-timing.test.ts, and the sender side in
// tests/issue5152-owner-beat-survives-host-stall.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { tickWatchedPid, effectiveHeartbeatGrace } from "../src/server.ts";
import type { PidProbe } from "../src/instance.ts";

const OPTS = { heartbeatGraceMs: 15_000, confirmTicks: 3, heartbeatConfirmTicks: 5 };
const NOW = 1_000_000;
const TICK = 2_000;
const alive: PidProbe = { alive: true };
const dead: PidProbe = { alive: false, errCode: "ESRCH" };

test("#5152 effectiveHeartbeatGrace: no measurement is a no-op (historical behavior preserved)", () => {
    assert.equal(effectiveHeartbeatGrace(15_000, undefined), 15_000, "no measurement ⇒ the historical constant");
    assert.equal(effectiveHeartbeatGrace(15_000, 0), 15_000, "zero lag extends nothing");
});

test("#5152 effectiveHeartbeatGrace: the window widens by the measured pause", () => {
    assert.equal(effectiveHeartbeatGrace(15_000, 20_000), 35_000, "a 20s pause must buy a 20s wider window");
    assert.equal(effectiveHeartbeatGrace(15_000, 12_000), 27_000);
});

test("#5152 effectiveHeartbeatGrace: garbage never makes the watchdog STRICTER", () => {
    assert.equal(effectiveHeartbeatGrace(15_000, Number.NaN), 15_000, "NaN is not a measurement");
    assert.equal(effectiveHeartbeatGrace(15_000, Number.POSITIVE_INFINITY), 15_000, "Infinity is not a measurement");
    assert.equal(effectiveHeartbeatGrace(15_000, -5_000), 15_000, "a clock oddity must not shrink the window");
});

test("#3544 guardrail: the extension is UNCAPPED but NOT STICKY, so a recycled pid still dies", () => {
    // #5138 records a real pause of ~19 minutes. Any cap below the true length
    // would re-create exactly the false death this change removes, so there is
    // no cap. Safety comes from freshness instead of a bound: every tick
    // re-measures, and once the loop runs again the window snaps back to the
    // constant — a recycled pid just dies that much later (#3544 intact).
    assert.equal(effectiveHeartbeatGrace(15_000, 10_000_000), 10_015_000, "the window must cover the real pause, however long");
    assert.equal(effectiveHeartbeatGrace(15_000, undefined), 15_000, "the next unstarved tick restores the plain constant");
});

test("#5152 the residual hole: an aged reading burns a LIVE pid once the confirmation run completes (pre-fix it took ONE tick)", () => {
    // A 40s stall: by the time the loop recovers, the last beat is 40s old —
    // far past the raw 15s grace on every tick of the run.
    let hbStreak: number | undefined;
    let d = tickWatchedPid(alive, NOW - 40_000, NOW, undefined, hbStreak, OPTS);
    hbStreak = d.hbStreak;
    for (let i = 1; i < 5; i += 1) {
        d = tickWatchedPid(alive, NOW - 40_000, NOW + i * TICK, undefined, d.hbStreak, OPTS);
    }
    assert.equal(d.removed, true, "wall-clock age past the grace still kills a live pid through the stale-heartbeat branch");
    assert.equal(d.staleHeartbeat, true, "and it is tagged as heartbeat expiry, not a kill-0 failure");
});

test("#5152 the fix: the SAME episode survives once the grace absorbs the starvation", () => {
    const widened = effectiveHeartbeatGrace(15_000, 40_000);
    const d = tickWatchedPid(alive, NOW - 40_000, NOW, undefined, undefined, { ...OPTS, heartbeatGraceMs: widened });
    assert.equal(widened, 55_000);
    assert.equal(d.removed, false, "a stall the loop itself caused must not be read as the owner dying");
    assert.equal(d.hbStreak, 0, "and no streak arms while the widened window covers the age");
});

test("#5152 the fix still dies when the owner is genuinely silent past the widened window", () => {
    const widened = effectiveHeartbeatGrace(15_000, 40_000);
    let hbStreak: number | undefined;
    let d = tickWatchedPid(alive, NOW - 200_000, NOW, undefined, hbStreak, { ...OPTS, heartbeatGraceMs: widened });
    hbStreak = d.hbStreak;
    for (let i = 1; i < 5; i += 1) {
        d = tickWatchedPid(alive, NOW - 200_000, NOW + i * TICK, undefined, d.hbStreak, { ...OPTS, heartbeatGraceMs: widened });
    }
    assert.equal(d.removed, true, "an owner silent for 200s is dead even with the lag absorbed");
});

test("#3890 the kill-0 axis is untouched by this change", () => {
    const one = tickWatchedPid(dead, undefined, NOW, undefined, undefined, OPTS);
    assert.equal(one.removed, false, "one flake is not conclusive");
    assert.equal(one.streak, 1);
    const three = tickWatchedPid(dead, undefined, NOW, 2, undefined, OPTS);
    assert.equal(three.removed, true, "confirmTicks consecutive failures still remove");
});
