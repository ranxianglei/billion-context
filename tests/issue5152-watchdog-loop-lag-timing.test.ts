// #5152: the watchdog's stale-heartbeat reading is sampled on the
// PROXY's own event loop, so it is only meaningful while that loop can run.
//
// Ticks are not time: a single synchronous turn longer than the whole staleness
// window (WATCHER_HEARTBEAT_GRACE_MS = 15s) leaves the last recorded beat
// arbitrarily old, and the first tick after recovery removes a LIVE owner. The
// fix measures the ticker's OWN scheduling drift and widens the window by it —
// blindness the loop caused must not be charged to the owner.
//
// This file pins the TIMING path in both directions: the lag-widened window
// must survive a stall the loop caused itself, and the RAW window must still
// burn the same geometry (the death completing over #4994's consecutive
// confirmation — this file isolates the grace axis, not the confirmation one).
// The pure seam is pinned in tests/issue5152-watchdog-own-loop-blindness.test.ts
// and the sender side in tests/issue5152-owner-beat-survives-host-stall.test.ts.
// Scale-invariant: the same geometry runs at TICK=100ms / GRACE=600ms.
import test from "node:test";
import assert from "node:assert/strict";
import { effectiveHeartbeatGrace, tickWatchedPid } from "../src/server.ts";
import type { PidProbe } from "../src/instance.ts";

const TICK = 100;
const GRACE = 600;
const CONFIRM = 3;
const HB_CONFIRM = 5;
const OPTS = { confirmTicks: CONFIRM, heartbeatConfirmTicks: HB_CONFIRM };
const alive: PidProbe = { alive: true };

/** Mirrors the production watchdog tick: measure this ticker's OWN scheduling
 *  drift, widen the grace by it, then feed the real tickWatchedPid. */
class WatchdogTiming {
    private prevTickAt: number | null = null;
    private streak: number | undefined;
    private hbStreak: number | undefined;
    removed = false;
    lastLag = 0;
    lastGrace = GRACE;

    tick(nowMs: number, lastSeenAt: number | undefined): void {
        const lag = this.prevTickAt === null ? 0 : nowMs - this.prevTickAt - TICK;
        this.prevTickAt = nowMs;
        this.lastLag = lag;
        this.lastGrace = effectiveHeartbeatGrace(GRACE, lag);
        const d = tickWatchedPid(alive, lastSeenAt, nowMs, this.streak, this.hbStreak, { ...OPTS, heartbeatGraceMs: this.lastGrace });
        this.streak = d.streak;
        this.hbStreak = d.hbStreak;
        if (d.removed) this.removed = true;
    }
}

test("#5152 the tick-drift measurement turns a long synchronous stall into a WORKING lag", () => {
    const wd = new WatchdogTiming();
    const beatAt = 1_000_000;
    for (let i = 0; i < 5; i += 1) wd.tick(beatAt + i * TICK, beatAt);
    assert.equal(wd.lastLag, 0, "a healthy loop reports no lag");
    const recoveredAt = beatAt + 5 * TICK + 1_200;
    wd.tick(recoveredAt, beatAt);
    assert.ok(wd.lastLag >= 1_100, `the stall itself must be visible as lag, got ${wd.lastLag}ms`);
    assert.ok(wd.lastGrace >= GRACE + 1_100, `the grace must absorb the stall, got ${wd.lastGrace}ms`);
});

test("#5152 a 1.2s stall (2× the whole staleness window) does NOT remove a live owner", () => {
    const wd = new WatchdogTiming();
    const beatAt = 1_000_000;
    for (let i = 0; i < 5; i += 1) wd.tick(beatAt + i * TICK, beatAt);
    const stallUntil = beatAt + 5 * TICK + 1_200;
    wd.tick(stallUntil, beatAt);
    assert.equal(wd.removed, false, "the stall was the proxy's own blindness, not the owner's death");
});

test("#5152 the SAME geometry DOES remove a live owner without the lag measurement (regression)", () => {
    const beatAt = 1_000_000;
    const stallUntil = beatAt + 5 * TICK + 1_200;
    let streak: number | undefined;
    let hbStreak: number | undefined;
    let removed = false;
    for (let i = 0; i < HB_CONFIRM + 1; i += 1) {
        const d = tickWatchedPid(alive, beatAt, stallUntil + i * TICK, streak, hbStreak, { ...OPTS, heartbeatGraceMs: GRACE });
        streak = d.streak;
        hbStreak = d.hbStreak;
        removed = removed || d.removed;
    }
    assert.equal(removed, true, "pre-fix: wall-clock age alone burns a stall the loop caused itself (confirmation completes within the run)");
});

test("#5152 a genuinely dead owner is still removed once the lag-widened grace expires", () => {
    const wd = new WatchdogTiming();
    const beatAt = 1_000_000;
    for (let i = 0; i < 5; i += 1) wd.tick(beatAt + i * TICK, beatAt);
    const stallUntil = beatAt + 5 * TICK + 1_200;
    wd.tick(stallUntil, beatAt);
    // The owner never beats again and the loop recovers (no further lag), so
    // the window snaps back to the constant and silence confirms over
    // consecutive ticks — #3544's anti-reuse guarantee survives.
    for (let i = 1; i <= HB_CONFIRM; i += 1) wd.tick(stallUntil + i * TICK, beatAt);
    assert.equal(wd.removed, true, "#3544's anti-reuse guarantee survives: silence past the window is death");
});

