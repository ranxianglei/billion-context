// #4994 (floor 6, Linux): parent-gone suicide via the HEARTBEAT branch — the
// Windows kill-0 false positive got consecutive confirmation in #3890, but the
// stale-while-alive branch stayed single-strike. That reading is taken on the
// proxy's OWN event loop: a long synchronous turn (big compression / big
// forward) starves the /__bili/watcher handler while the parent lives on,
// lastSeen ages past the 15s grace, and the first post-stall tick removed the
// LIVE parent → the proxy committed suicide mid-turn (16 parent-gone events in
// 24h on Linux, where kill-0 never lies; measured event-loop pause 2m39s).
// Pinned here: the branch now requires WATCHER_HEARTBEAT_CONFIRM_TICKS
// consecutive stale ticks, a live re-beat disarms the streak, and the kill-0
// axis (#3890) plus legacy kill-0-only semantics are untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { tickWatchedPid } from "../src/server.ts";
import type { PidProbe } from "../src/instance.ts";

const OPTS = { heartbeatGraceMs: 15_000, confirmTicks: 3, heartbeatConfirmTicks: 5 };
const NOW = 1_000_000;
const TICK = 2_000;
// Last beat beyond the 15s grace — the stale-while-alive state floor 6 hit.
const STALE_SEEN = NOW - 16_000;
const aliveProbe: PidProbe = { alive: true };
const dead = (code = "ESRCH"): PidProbe => ({ alive: false, errCode: code });

test("#4994 tickWatchedPid: a single stale-while-alive reading does NOT remove the pid (pre-fix regression)", () => {
    const d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW, undefined, undefined, OPTS);
    assert.deepEqual(d, { removed: false, staleHeartbeat: true, streak: 0, hbStreak: 1 }, "one stale reading arms the streak but keeps the pid");
});

test("#4994 tickWatchedPid: fewer than heartbeatConfirmTicks stale ticks never remove", () => {
    let d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW, undefined, undefined, OPTS);
    for (let i = 1; i < OPTS.heartbeatConfirmTicks - 1; i++) {
        d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW + TICK * (i + 1), d.streak, d.hbStreak, OPTS);
        assert.equal(d.removed, false, `${i + 1} consecutive stale ticks are not conclusive`);
    }
    assert.equal(d.hbStreak, OPTS.heartbeatConfirmTicks - 1);
});

test("#4994 tickWatchedPid: heartbeatConfirmTicks consecutive stale ticks remove, tagged stale-heartbeat", () => {
    let d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW, undefined, undefined, OPTS);
    for (let i = 1; i < OPTS.heartbeatConfirmTicks; i++) {
        d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW + TICK * (i + 1), d.streak, d.hbStreak, OPTS);
    }
    assert.equal(d.removed, true, "the fifth consecutive stale tick confirms the loss");
    assert.equal(d.staleHeartbeat, true, "removal is attributed to the heartbeat branch");
    assert.equal(d.streak, 0);
});

test("#4994 tickWatchedPid: a live re-beat mid-episode disarms the streak (the reported survival path)", () => {
    let d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW, undefined, undefined, OPTS);
    d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW + TICK, d.streak, d.hbStreak, OPTS);
    assert.equal(d.hbStreak, 2, "two stale ticks accumulated");
    // The parent's next beat lands 5s after the episode starts and is
    // processed on the following 2s tick — it must reset everything.
    d = tickWatchedPid(aliveProbe, NOW + 5_000, NOW + 6_000, d.streak, d.hbStreak, OPTS);
    assert.deepEqual(d, { removed: false, staleHeartbeat: false, streak: 0, hbStreak: 0 }, "the re-beat resets the episode");
    d = tickWatchedPid(aliveProbe, NOW + 6_000, NOW + 6_000 + 16_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.hbStreak, 1, "a later episode starts from zero again");
});

test("#4994 tickWatchedPid: the 5s-interval worst case fits inside 5 ticks (would NOT fit inside 3)", () => {
    // First stale tick at t0; a healthy parent whose next beat is due exactly
    // 5s later has it processed on the t0+6s tick. A 3-tick confirmation would
    // remove at t0+4s — still a false death. 5 ticks remove at t0+8s, only
    // after the t0+6s re-beat has already disarmed the streak.
    let d = tickWatchedPid(aliveProbe, NOW - 16_000, NOW, undefined, undefined, OPTS);
    d = tickWatchedPid(aliveProbe, NOW - 16_000, NOW + 2_000, d.streak, d.hbStreak, OPTS);
    d = tickWatchedPid(aliveProbe, NOW - 16_000, NOW + 4_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, false, "t0+4s: the 3-tick shape would have killed us here");
    d = tickWatchedPid(aliveProbe, NOW + 5_000, NOW + 6_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.hbStreak, 0, "re-beat processed");
    d = tickWatchedPid(aliveProbe, NOW + 6_000, NOW + 8_000, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, false, "t0+8s: fresh beat still current, no removal");
});

test("#4994 tickWatchedPid: legacy registrations (no heartbeat record) keep kill-0-only semantics", () => {
    const d = tickWatchedPid(aliveProbe, undefined, NOW, undefined, undefined, OPTS);
    assert.deepEqual(d, { removed: false, staleHeartbeat: false, streak: 0, hbStreak: 0 }, "alive + never heartbeated stays alive, whatever the clock says");
});

test("#4994 tickWatchedPid: a dead-probe tick breaks the heartbeat run (independent axes, no accumulation)", () => {
    let d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW, undefined, undefined, OPTS);
    d = tickWatchedPid(dead(), STALE_SEEN, NOW + TICK, d.streak, d.hbStreak, OPTS);
    assert.equal(d.removed, false);
    assert.equal(d.streak, 1, "kill-0 axis armed independently");
    assert.equal(d.hbStreak, 0, "the disagreeing tick broke the stale run — episodes don't accumulate across interruptions");
    d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW + 2 * TICK, d.streak, d.hbStreak, OPTS);
    assert.equal(d.hbStreak, 1, "the stale episode restarts from one");
});

test("#4994 tickWatchedPid: a truly recycled pid still dies — confirmation delays, never cancels (#3544 guarantee)", () => {
    // Recycled pid: kill-0 reads alive FOREVER, heartbeats NEVER come again.
    let d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW, undefined, undefined, OPTS);
    for (let i = 1; ; i++) {
        d = tickWatchedPid(aliveProbe, STALE_SEEN, NOW + TICK * (i + 1), d.streak, d.hbStreak, OPTS);
        assert.ok(i <= 10, "the loss is eventually confirmed even without a single re-beat");
        if (d.removed) break;
    }
    assert.equal(d.staleHeartbeat, true);
});
