// #4125: the port log (%TEMP%/bili-proxy-<port>.log) is SHARED across spawns
// (append fd, size-based rotation only). Field case (2026-10-25): a failed
// child wrote 0 bytes, so the failure message quoted the PREVIOUS spawn's
// content — a week-old EADDRINUSE line presented as the current failure's
// evidence — and nothing recorded what the port was doing at SPAWN time.
// Fix: each spawn appends a `=== bili spawn ... ===` header, samples/sizes
// are scoped to this spawn's segment ("N bytes since this spawn"), and every
// terminal failure message carries "(at spawn: <port state>)". All probes go
// through injected seams — no real network I/O.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureProxyRunning, SPAWN_BUDGET_MS, type ProbeOutcome, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

const PORT = 47891;
const LOG_FILE = path.join(os.tmpdir(), `bili-proxy-${PORT}.log`);
const LOG_OLD = `${LOG_FILE}.old`;
const STALE_MARKER = "EADDRINUSE stale evidence from a previous week (pid 38768)";

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

function makeAliveChild(pid: number): SpawnChild {
    return { pid, unref() {}, kill() { return true; }, on() {} };
}

test("#4125 zero-output child with stale shared content: message says 0-bytes-since-spawn, never quotes the stale half", async () => {
    cleanupLogs();
    fs.writeFileSync(LOG_FILE, `old line\n${STALE_MARKER}\n`);
    const clock = fakeClock();
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "ECONNREFUSED" }),
                spawnImpl: (() => makeAliveChild(42481)) as SpawnFn,
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => undefined,
            },
        );
        assert.fail("expected rejection");
    } catch (e) {
        err = e;
    } finally {
        const content = (() => { try { return fs.readFileSync(LOG_FILE, "utf8"); } catch { return ""; } })();
        cleanupLogs();
        const msg = (err as Error).message;
        assert.match(msg, new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`));
        assert.ok(msg.includes("0 bytes since this spawn — EMPTY"), msg);
        assert.ok(!msg.includes(STALE_MARKER), "stale previous-spawn content must not be quoted as this failure's evidence");
        assert.ok(content.includes("=== bili spawn"), "the spawn header must mark this segment in the shared file");
        assert.ok(content.includes(`port=${PORT}`), "the header names the port for attribution (childPid is unknown pre-spawn)");
        assert.ok(content.includes(STALE_MARKER), "previous content stays on disk (rotation policy unchanged) — only the QUOTING changed");
    }
});

test("#4125 child that writes early: the quoted head comes from THIS spawn's segment", async () => {
    cleanupLogs();
    fs.writeFileSync(LOG_FILE, `${STALE_MARKER}\n`);
    const clock = fakeClock();
    let err: unknown;
    try {
        await ensureProxyRunning(
            { host: "127.0.0.1", port: PORT, passthrough: false, debug: false },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => undefined,
                fetchDetailImpl: async (): Promise<ProbeOutcome> => ({ ok: false, detail: "ECONNREFUSED" }),
                spawnImpl: (() => {
                    // A real child cannot write before the parent returns from
                    // spawn() and appends the header — defer like one would.
                    queueMicrotask(() => fs.appendFileSync(LOG_FILE, "child stdout line\n"));
                    return makeAliveChild(42482);
                }) as SpawnFn,
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
        const msg = (err as Error).message;
        assert.ok(msg.includes("bytes since this spawn"), msg);
        assert.ok(msg.includes('child output head: "child stdout line"'), msg);
        assert.ok(!msg.includes(STALE_MARKER), msg);
    }
});

test("#4125 at-spawn port state: a healthy foreign instance holding the planned port is named", async () => {
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
                spawnImpl: (() => makeAliveChild(42483)) as SpawnFn,
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
        const msg = (err as Error).message;
        assert.ok(msg.includes("(at spawn: healthy bili instance (pid 99999))"), msg);
    }
});

test("#4125 at-spawn port state: an empty port reads 'nothing listening'", async () => {
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
                spawnImpl: (() => makeAliveChild(42484)) as SpawnFn,
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
        const msg = (err as Error).message;
        assert.ok(msg.includes("(at spawn: nothing listening)"), msg);
    }
});
