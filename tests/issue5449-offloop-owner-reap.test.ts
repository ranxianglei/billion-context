import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    WATCHDOG_OWNER_DEAD_CONFIRM_TICKS,
    armEventLoopWatchdog,
    ownerReapVerdict,
} from "../src/event-loop-watchdog.ts";
import { isPidAlive } from "../src/instance.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Synchronous spin — the exact shape of a wedged event loop (#4762): no
 *  heartbeats leave the main thread while the worker's clock keeps running. */
function blockMainLoop(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
}

async function waitUntil(fn: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await sleep(10);
}

/** Spawn a short-lived child and wait until its pid genuinely exits, so
 *  kill-0 on it reads ESRCH before the watchdog arms (#5449 precondition). */
async function spawnEphemeralOwner(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20)"], { stdio: "ignore" });
    if (child.pid === undefined) throw new Error("spawn did not yield a pid");
    const pid = child.pid;
    const deadline = Date.now() + 2_000;
    while (isPidAlive(pid) && Date.now() < deadline) await sleep(10);
    assert.ok(!isPidAlive(pid), "precondition: ephemeral owner must be dead before arming");
    return pid;
}

test("ownerReapVerdict: all three gates must hold together (#5449)", () => {
    assert.equal(WATCHDOG_OWNER_DEAD_CONFIRM_TICKS, 3);
    // streak below confirm threshold — even after a long wedge
    assert.equal(ownerReapVerdict(2, 3, 60_000, 30_000, 0), false);
    // gap below the soft-wedge gate — owner dead, but the loop still yields
    assert.equal(ownerReapVerdict(3, 3, 29_999, 30_000, 0), false);
    // other watcher attached — #7 shared-proxy semantics die with the LAST owner
    assert.equal(ownerReapVerdict(3, 3, 60_000, 30_000, 1), false);
    // all three hold at the boundaries
    assert.equal(ownerReapVerdict(3, 3, 30_000, 30_000, 0), true);
    // over-streak also trips
    assert.equal(ownerReapVerdict(7, 3, 60_000, 30_000, 0), true);
});

test("dead owner + wedged loop + no other watchers trips off-loop reap (#5449)", async () => {
    const ownerPid = await spawnEphemeralOwner();
    let trippedWith: { gapMs: number, reason?: string } | undefined;
    const handle = armEventLoopWatchdog({
        logFile: null,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 30_000,
        parentPid: ownerPid,
        getWatcherCount: () => 0,
        fatalMode: "report",
        onTrip: (gapMs, reason) => { trippedWith = { gapMs, reason }; },
    });
    try {
        assert.ok(handle, "handle expected");
        await sleep(100); // ≥3 tick intervals: dead streak accumulates while beats flow
        blockMainLoop(400); // wedge: no more heartbeats reach the worker
        const deadline = Date.now() + 3_000;
        while (!trippedWith && Date.now() < deadline) await sleep(20);
        assert.ok(trippedWith, "onTrip must fire once the loop wedges with a confirmed-dead owner");
        assert.equal(trippedWith.reason, "parent-gone");
        assert.ok(trippedWith.gapMs >= 60, `gap ${trippedWith.gapMs} must clear the soft-wedge gate`);
    } finally {
        handle?.stop();
        await sleep(20);
    }
});

test("dead owner + wedge but ANOTHER watcher attached never trips (#5449/#7 last-owner guard)", async () => {
    const ownerPid = await spawnEphemeralOwner();
    let trips = 0;
    const handle = armEventLoopWatchdog({
        logFile: null,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 30_000,
        parentPid: ownerPid,
        getWatcherCount: () => 2,
        fatalMode: "report",
        onTrip: () => { trips += 1; },
    });
    try {
        assert.ok(handle, "handle expected");
        await sleep(100);
        blockMainLoop(400);
        await sleep(80);
        assert.equal(trips, 0, "a multi-host proxy must survive the loss of one host");
    } finally {
        handle?.stop();
        await sleep(20);
    }
});

test("live owner + wedge never trips the owner axis (#5449)", async () => {
    let trips = 0;
    const handle = armEventLoopWatchdog({
        logFile: null,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 30_000,
        parentPid: process.pid,
        getWatcherCount: () => 0,
        fatalMode: "report",
        onTrip: () => { trips += 1; },
    });
    try {
        assert.ok(handle, "handle expected");
        await sleep(100);
        blockMainLoop(400);
        await sleep(80);
        assert.equal(trips, 0, "kill-0 on our own pid always reads alive");
    } finally {
        handle?.stop();
        await sleep(20);
    }
});

test("dead owner but a HEALTHY loop never trips — the in-loop reaper keeps its graceful path (#5449 no-regression)", async () => {
    const ownerPid = await spawnEphemeralOwner();
    let trips = 0;
    const handle = armEventLoopWatchdog({
        logFile: null,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 30_000,
        parentPid: ownerPid,
        getWatcherCount: () => 0,
        fatalMode: "report",
        onTrip: () => { trips += 1; },
    });
    try {
        assert.ok(handle, "handle expected");
        await sleep(400); // beats keep flowing: gap stays tiny, gate cannot open
        assert.equal(trips, 0, "worker must not preempt the in-loop reaper's detect→decide→drain path");
    } finally {
        handle?.stop();
        await sleep(20);
    }
});

test("watcher count rides every beat — init-time count must not freeze the guard (#5449/#7)", async () => {
    const ownerPid = await spawnEphemeralOwner();
    let watchers = 1;
    let trippedWith: { gapMs: number, reason?: string } | undefined;
    const handle = armEventLoopWatchdog({
        logFile: null,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 30_000,
        parentPid: ownerPid,
        getWatcherCount: () => watchers,
        fatalMode: "report",
        onTrip: (gapMs, reason) => { trippedWith = { gapMs, reason }; },
    });
    try {
        assert.ok(handle, "handle expected");
        await sleep(100); // init + several beats carry count=1
        watchers = 0; // the last owner exits
        await sleep(45); // ≥2 beat intervals — the worker's frozen count MUST now be 0
        blockMainLoop(400);
        const deadline = Date.now() + 3_000;
        while (!trippedWith && Date.now() < deadline) await sleep(20);
        assert.ok(trippedWith, "trip requires the beat-carried count update, not only the init snapshot");
        assert.equal(trippedWith.reason, "parent-gone");
    } finally {
        handle?.stop();
        await sleep(20);
    }
});

test("no parentPid — axis disabled, zero behavior change for manual bili start (#5449)", async () => {
    const ownerPid = await spawnEphemeralOwner();
    void ownerPid;
    let trips = 0;
    const handle = armEventLoopWatchdog({
        logFile: null,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 30_000,
        getWatcherCount: () => 0,
        fatalMode: "report",
        onTrip: () => { trips += 1; },
    });
    try {
        assert.ok(handle, "handle expected");
        await sleep(100);
        blockMainLoop(400);
        await sleep(80);
        assert.equal(trips, 0, "without BILI_PARENT_PID the worker has nothing to probe");
    } finally {
        handle?.stop();
        await sleep(20);
    }
});
