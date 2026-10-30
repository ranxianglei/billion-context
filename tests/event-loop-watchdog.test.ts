import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
    WATCHDOG_HEARTBEAT_MS,
    WATCHDOG_HARD_TIMEOUT_MS,
    WATCHDOG_SOFT_WARN_MS,
    armEventLoopWatchdog,
    watchdogVerdict,
} from "../src/event-loop-watchdog.ts";
import { rmrf } from "./tmp-rm.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Synchronous spin — the exact shape of a wedged event loop (#4762): no
 *  heartbeats leave the main thread while the worker's clock keeps running. */
function blockMainLoop(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
}

test("watchdogVerdict: threshold boundaries and warn-once semantics", () => {
    assert.equal(watchdogVerdict(1_000, false, 30_000, 300_000), "ok");
    assert.equal(watchdogVerdict(29_999, false, 30_000, 300_000), "ok");
    assert.equal(watchdogVerdict(30_000, false, 30_000, 300_000), "warn");
    assert.equal(watchdogVerdict(30_000, true, 30_000, 300_000), "ok");
    assert.equal(watchdogVerdict(299_999, true, 30_000, 300_000), "ok");
    assert.equal(watchdogVerdict(300_000, true, 30_000, 300_000), "trip");
});

test("defaults are deadlock-scale, not load-scale (#4762)", () => {
    assert.equal(WATCHDOG_HEARTBEAT_MS, 5_000);
    assert.equal(WATCHDOG_SOFT_WARN_MS, 30_000);
    assert.equal(WATCHDOG_HARD_TIMEOUT_MS, 300_000);
});

test("wedged main loop trips the watchdog: warn + fatal forensic lines land in the log file (#4762)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watchdog-"));
    const logFile = path.join(dir, "bili.log");
    let trippedWith: number | undefined;
    const handle = armEventLoopWatchdog({
        logFile,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 150,
        fatalMode: "report",
        onTrip: (gapMs) => { trippedWith = gapMs; },
    });
    try {
        assert.ok(handle, "handle expected");
        await sleep(50); // beats flowing — worker initialized
        blockMainLoop(400); // synchronous spin: zero heartbeats reach the worker
        await sleep(80); // deliver the queued trip message
        if (typeof trippedWith !== "number") throw new Error(`onTrip must fire after a continuous block past hardTimeoutMs (got ${String(trippedWith)})`);
        assert.ok(trippedWith >= 150, `gap ${trippedWith} must reach the hard threshold`);
        const content = fs.readFileSync(logFile, "utf8");
        // sub-second test thresholds render as ms (production values render as s)
        assert.match(content, /\[event-loop-watchdog\] main event loop silent for \d+(?:ms|s) \(soft threshold 60ms\)/);
        assert.match(content, /\[event-loop-watchdog\] FATAL: main event loop silent for \d+(?:ms|s) \(hard threshold 150ms\)/);
        assert.match(content, /\[v=0\.0\.0-test\]/);
        // report mode latches: exactly ONE fatal line per wedge episode
        assert.equal((content.match(/FATAL/g) ?? []).length, 1);
    } finally {
        // stop() in finally: an assertion failure must not leak the live worker
        handle?.stop();
        await sleep(20);
        await rmrf(dir);
    }
});

test("healthy heartbeat stream never trips (#4762)", async () => {
    let trips = 0;
    const handle = armEventLoopWatchdog({
        logFile: null,
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 100,
        hardTimeoutMs: 300,
        fatalMode: "report",
        onTrip: () => { trips += 1; },
    });
    assert.ok(handle, "handle expected");
    try {
        await sleep(400);
        assert.equal(trips, 0);
    } finally {
        handle?.stop();
        await sleep(20);
    }
});

test("worker spawn failure degrades to unwatched and never throws (#4762)", () => {
    let failure: unknown;
    const handle = armEventLoopWatchdog({
        spawnWorker: () => { throw new Error("spawn denied"); },
        onSpawnFailure: (err) => { failure = err; },
    });
    assert.equal(handle, undefined);
    assert.ok(failure instanceof Error && /spawn denied/.test(failure.message));
});

/** Pipe-capturing spawn seam: the worker's stdio becomes readable streams
 *  instead of inherited fds, so the test can prove WHICH leg carried a line.
 *  (A blocking pipe cannot be proven — only structurally excluded, which is
 *  exactly what the gate under test is.) */
function armWithCapturedStderr(
    opts: Parameters<typeof armEventLoopWatchdog>[0],
): { handle: ReturnType<typeof armEventLoopWatchdog>, stderrBuf: () => string } {
    let buf = "";
    const handle = armEventLoopWatchdog({
        ...opts,
        spawnWorker: (code, o) => {
            // per-stream pipe flags (the pinned @types model these as
            // booleans; runtime maps them onto the stdio array)
            const w = new Worker(code, { ...o, eval: true, stdout: true, stderr: true });
            w.stderr?.on("data", (d) => { buf += String(d); });
            return w;
        },
    });
    return { handle, stderrBuf: () => buf };
}

async function waitUntil(fn: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await sleep(10);
}

test("forensic lines stay OFF the worker's stderr when a file leg exists and stderr is not a TTY (#4762/#5012)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-watchdog-"));
    const logFile = path.join(dir, "bili.log");
    const { handle, stderrBuf } = armWithCapturedStderr({
        logFile,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 150,
        fatalMode: "report",
        stderrTty: false,
    });
    try {
        assert.ok(handle);
        await sleep(50);
        blockMainLoop(400);
        await sleep(80);
        await waitUntil(() => /FATAL/.test(fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : ""), 500);
        const content = fs.readFileSync(logFile, "utf8");
        assert.match(content, /FATAL: main event loop silent/); // file leg carries the record
        await waitUntil(() => stderrBuf().length > 0, 200);
        assert.equal(stderrBuf().trim(), "", "non-TTY stderr is a dead-pipe risk on Windows — never touched (#5012)");
    } finally {
        handle?.stop();
        await sleep(20);
        await rmrf(dir);
    }
});

test("with NO file leg the worker's stderr is the sole forensic record and must carry the FATAL line (#4762)", async () => {
    const { handle, stderrBuf } = armWithCapturedStderr({
        logFile: null,
        version: "0.0.0-test",
        heartbeatMs: 20,
        checkIntervalMs: 20,
        softWarnMs: 60,
        hardTimeoutMs: 150,
        fatalMode: "report",
        stderrTty: false,
    });
    try {
        assert.ok(handle);
        await sleep(50);
        blockMainLoop(400);
        await sleep(80);
        await waitUntil(() => /FATAL/.test(stderrBuf()), 500);
        assert.match(stderrBuf(), /FATAL: main event loop silent/);
    } finally {
        handle?.stop();
        await sleep(20);
    }
});
