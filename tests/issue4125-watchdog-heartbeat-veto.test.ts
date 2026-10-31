// #4125: the parent-gone watchdog had TWO disagreeing liveness signals — the
// identity-blind kill-0 existence probe and the identity-anchored owner
// heartbeat (#3544) — and the #3890 kill-0 death streak ran regardless of
// heartbeat freshness. Field case (2026-10-25, DSH web host): three
// consecutive transient OpenProcess failures against a LIVE host burned the
// whole confirm window (~6s) and force-exited a healthy, compressing proxy
// mid-session; the same host pid then re-armed fine on the replacement proxy,
// proving it never died. The shutdown reason string carried no
// [stale-heartbeat] suffix, pinning this to the kill-0 streak path.
// Fix: a FRESH heartbeat vetoes failed probes entirely — the beat is the
// stronger proof (only the true owner posts its own pid over loopback).
// Stale-heartbeat removal is tick-confirmed per #4994 (immediate removal let
// a recycled pid exit ~8s early in one field case); legacy kill-0-only
// semantics are unchanged. Both axes pinned below.

import test from "node:test";
import assert from "node:assert/strict";
import { tickWatchedPid } from "../src/server.ts";

const NOW = 1_000_000;
const OPTS = { heartbeatGraceMs: 15_000, confirmTicks: 3, heartbeatConfirmTicks: 5 };
const dead = (errCode?: string) => ({ alive: false, errCode });
const aliveProbe = { alive: true };

test("#4125 veto: fresh heartbeats keep a pid out of the death streak across consecutive failed probes", () => {
    let d = tickWatchedPid(dead("ESRCH"), NOW - 10_000, NOW, undefined, undefined, OPTS);
    assert.deepEqual(d, { removed: false, staleHeartbeat: false, streak: 0, hbStreak: 0, heartbeatVeto: true });
    d = tickWatchedPid(dead("ESRCH"), NOW - 12_000, NOW + 2_000, d.streak, undefined, OPTS);
    assert.equal(d.removed, false, "second consecutive failure still vetoed while the beat ages but stays fresh");
    assert.equal(d.heartbeatVeto, true);
    d = tickWatchedPid(dead("ESRCH"), NOW - 14_000, NOW + 4_000, d.streak, undefined, OPTS);
    assert.equal(d.removed, false, "third failure too — the confirm window cannot burn under a live heartbeat");
});

test("#4125 veto boundary: a beat exactly at the grace edge is still fresh; one past it counts again", () => {
    const at = tickWatchedPid(dead(), NOW - 15_000, NOW, undefined, undefined, OPTS);
    assert.equal(at.heartbeatVeto, true, "age == grace counts as fresh (<=)");
    const past = tickWatchedPid(dead(), NOW - 15_001, NOW, undefined, undefined, OPTS);
    assert.equal(past.heartbeatVeto, undefined, "stale beat falls back to the #3890 streak");
    assert.equal(past.streak, 1);
});

test("#4125 veto reset: counting resumes from 1 after vetoes, but three unvetoed failures still remove", () => {
    let d = tickWatchedPid(dead(), NOW - 10_000, NOW, undefined, undefined, OPTS);
    assert.equal(d.heartbeatVeto, true);
    d = tickWatchedPid(dead(), NOW - 20_000, NOW + 2_000, d.streak, undefined, OPTS);
    assert.equal(d.streak, 1, "beat went stale → counting resumes, not accumulating pre-veto history");
    d = tickWatchedPid(dead(), NOW - 21_000, NOW + 4_000, d.streak, undefined, OPTS);
    assert.equal(d.streak, 2);
    d = tickWatchedPid(dead(), NOW - 22_000, NOW + 6_000, d.streak, undefined, OPTS);
    assert.equal(d.removed, true, "a genuinely silent owner still exits promptly");
    assert.equal(d.staleHeartbeat, false, "removal here is the kill-0 verdict, not the heartbeat one");
});

test("#4125 regression pin: legacy pids (no heartbeat record) keep #3890 streak semantics exactly", () => {
    let d = tickWatchedPid(dead("ESRCH"), undefined, NOW, undefined, undefined, OPTS);
    assert.equal(d.heartbeatVeto, undefined);
    assert.equal(d.streak, 1);
    d = tickWatchedPid(dead("ESRCH"), undefined, NOW + 2_000, d.streak, undefined, OPTS);
    assert.equal(d.streak, 2);
    d = tickWatchedPid(dead("ESRCH"), undefined, NOW + 4_000, d.streak, undefined, OPTS);
    assert.deepEqual(d, { removed: true, staleHeartbeat: false, streak: 0, hbStreak: 0 });
});

test("#4994 dual-axis pin: an ALIVE process with a stale heartbeat removes only after confirmed ticks", () => {
    assert.deepEqual(tickWatchedPid(aliveProbe, NOW - 1_000, NOW, undefined, undefined, OPTS), { removed: false, staleHeartbeat: false, streak: 0, hbStreak: 0 });
    // a live probe with a fresh beat clears any prior counting on BOTH axes
    assert.deepEqual(tickWatchedPid(aliveProbe, NOW - 1_000, NOW, 2, 4, OPTS), { removed: false, staleHeartbeat: false, streak: 0, hbStreak: 0 });
    let d = tickWatchedPid(aliveProbe, NOW - 16_000, NOW, undefined, undefined, OPTS);
    assert.deepEqual(d, { removed: false, staleHeartbeat: true, streak: 0, hbStreak: 1 }, "first stale-beat tick flags but does not remove");
    for (let i = 2; i <= 4; i++) {
        d = tickWatchedPid(aliveProbe, NOW - 16_000 - i * 1_000, NOW + i * 1_000, d.streak, d.hbStreak, OPTS);
        assert.equal(d.removed, false, `stale-beat tick ${i} must not remove yet`);
        assert.equal(d.hbStreak, i);
    }
    d = tickWatchedPid(aliveProbe, NOW - 21_000, NOW + 5_000, d.streak, d.hbStreak, OPTS);
    assert.deepEqual(d, { removed: true, staleHeartbeat: true, streak: 0, hbStreak: 0 }, "fifth confirmed stale beat removes");
});
