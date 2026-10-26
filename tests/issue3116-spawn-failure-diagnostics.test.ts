// #3116: when a spawned proxy never becomes healthy, every failure message
// pointed at bili-proxy-<port>.log — which is structurally able to stay 0
// bytes (the fd is opened "a" BEFORE spawn, and post-#2864 the child mutes
// its stderr leg into bili.log once its logger is live). Failure paths must
// be self-contained: report the last probe's failure class, classify who (if
// anyone) holds the port, and state the log size explicitly. All probes below
// go through injected seams — no real network I/O in these tests.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProxyRunning, SPAWN_BUDGET_MS, describeProbeFailure, type ProbeOutcome, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

const PORT = 47831;
const LOG_FILE = path.join(os.tmpdir(), `bili-proxy-${PORT}.log`);
const LOG_OLD = `${LOG_FILE}.old`;

function cleanupLogs(): void {
    for (const f of [LOG_FILE, LOG_OLD]) {
        try { fs.unlinkSync(f); } catch {}
    }
}

function fakeClock() {
    let ticks = 0;
    return {
        now: () => ticks * 1000,
        sleep: () => {
            ticks += 1;
            return Promise.resolve();
        },
    };
}

function makeExittingChild(pid: number, code: number): SpawnChild {
    const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
        pid,
        unref() {},
        kill() {
            return true;
        },
        on(event, listener) {
            const list = handlers.get(event) ?? [];
            list.push(listener);
            handlers.set(event, list);
            // queueMicrotask, NOT setImmediate: the fake-clock loop only ever
            // awaits already-resolved promises, so it never reaches the event
            // loop's check phase — a setImmediate emission would land AFTER the
            // whole 60-tick budget burned (microtasks drain on the first yield).
            if (event === "exit") queueMicrotask(() => list.forEach((l) => l(code, null)));
        },
    };
}

test("#3116 timeout with nothing listening: error says so, names the live child, states the empty log", async () => {
    cleanupLogs();
    const clock = fakeClock();
    const kills: Array<NodeJS.Signals | undefined> = [];
    const stderrLines: string[] = [];
    const realError = console.error.bind(console);
    console.error = (...args: unknown[]) => { stderrLines.push(args.join(" ")); };
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "ECONNREFUSED" }),
                spawnImpl: (() => ({
                    pid: 42471,
                    unref() {},
                    kill(signal?: NodeJS.Signals) {
                        kills.push(signal);
                        return true;
                    },
                    on() {},
                })) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        console.error = realError;
        cleanupLogs();
    }
    const msg = (err as Error).message;
    assert.match(msg, new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`));
    assert.ok(msg.includes(`nothing is listening on port ${PORT} — the spawned child (still alive, pid 42471) never bound it`), msg);
    assert.ok(msg.includes("0 bytes — EMPTY, the child produced no output of its own"), msg);
    assert.deepEqual(kills, ["SIGKILL"], "the abandoned child must be hard-killed exactly once");
    const slowStart = stderrLines.find((l) => l.includes("extending wait"));
    assert.ok(slowStart, "the slow-start notice must still fire");
    assert.ok(slowStart!.includes(`nothing is listening on port ${PORT}`), slowStart);
});

test("#3116 timeout with a foreign healthy responder: names the squatter pid", async () => {
    cleanupLogs();
    const clock = fakeClock();
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: true }),
                fetchHealthInfo: async () => ({ ok: true, pid: 99999 }),
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: true }),
                spawnImpl: (() => ({ pid: 42472, unref() {}, kill() { return true; }, on() {} })) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        cleanupLogs();
    }
    const msg = (err as Error).message;
    assert.match(msg, new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`));
    assert.ok(msg.includes(`port ${PORT} is held by a different process (pid 99999) — the spawned child never bound it`), msg);
});

test("#3116 timeout with a non-bili HTTP responder: reports the status", async () => {
    cleanupLogs();
    const clock = fakeClock();
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "HTTP 404" }),
                spawnImpl: (() => ({ pid: 42473, unref() {}, kill() { return true; }, on() {} })) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        cleanupLogs();
    }
    const msg = (err as Error).message;
    assert.match(msg, new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`));
    assert.ok(msg.includes(`port ${PORT} answered HTTP 404 — the listener there is not reporting bili health`), msg);
});

test("#3116 timeout with a foreign 200 responder (non-bili payload): names it instead of 'unknown error'", async () => {
    cleanupLogs();
    const clock = fakeClock();
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => ({ ok: false }),
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: true }),
                spawnImpl: (() => ({ pid: 42475, unref() {}, kill() { return true; }, on() {} })) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        cleanupLogs();
    }
    const msg = (err as Error).message;
    assert.match(msg, new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`));
    assert.ok(msg.includes(`port ${PORT} answered but not with bili's health payload — a foreign service likely holds it`), msg);
});

test("#3116 early exit: code stays in the message, diagnosis marks the child already exited", async () => {
    cleanupLogs();
    const clock = fakeClock();
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "ECONNREFUSED" }),
                spawnImpl: (() => makeExittingChild(42474, 1)) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        cleanupLogs();
    }
    const msg = (err as Error).message;
    assert.match(msg, /exited before becoming healthy \(code 1\)/);
    assert.ok(msg.includes(`nothing is listening on port ${PORT} — the spawned child (already exited, pid 42474) never bound it`), msg);
    assert.ok(msg.includes("0 bytes — EMPTY, the child produced no output of its own"), msg);
});

test("#3116 describeProbeFailure extracts the socket error class", () => {
    const fetchFailed = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:47831"), { code: "ECONNREFUSED" }),
    });
    assert.equal(describeProbeFailure(fetchFailed), "ECONNREFUSED");
    assert.equal(describeProbeFailure(new DOMException("aborted", "TimeoutError")), "timeout after 1500ms");
    assert.equal(describeProbeFailure(new Error("boom")), "boom");
    assert.equal(describeProbeFailure(null), "null");
});
