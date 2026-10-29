// #4994: when the launchToken handshake starves for the whole budget because
// clobbered instance records hide our child from every per-poll fallback, the
// timeout path must NOT kill a child the spawner itself can prove healthy —
// the health payload's pid matching the spawned pid is the same identity proof
// the stale-record fallback trusts per-poll. Rung 1: the preferred port answers
// under our pid. Rung 2: the child laddered off the preferred port and its own
// listen line (pid-tagged) points at where it bound. Unproven children are
// still hard-killed exactly as before (#2260(A)/#2187 zombie rationale holds
// whenever identity cannot be established).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { ensureProxyRunning, SPAWN_BUDGET_MS, type SpawnChild, type SpawnFn } from "../src/launcher.ts";

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-4994-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

const CHILD_PID = 43310;
const SQUATTER_PID = 43311;

/** A LIVE foreign record (alive pid, different launchToken) — the clobber that
 *  starves the launchToken match AND blocks the stale-record fallback (the
 *  record's owner pid is alive, so the record is not "stale"). */
function foreignInstance(port: number): ProxyInstanceFile {
    return {
        origin: `http://127.0.0.1:${port}`,
        instanceId: "foreign-1",
        pid: process.pid,
        startedAt: Date.now(),
        host: "127.0.0.1",
        port,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        launchToken: "somebody-else",
        codeFingerprint: "not-our-build",
    };
}

function makeFakeChild(pid: number, kills: Array<NodeJS.Signals | undefined>, logPath?: string): SpawnChild {
    return {
        pid,
        unref() {},
        kill(signal) {
            kills.push(signal);
            return true;
        },
        on() {},
    };
}

function fakeClock() {
    let ticks = 0;
    return {
        now: () => ticks * 1000,
        sleep: () => {
            ticks += 1;
            return Promise.resolve();
        },
        ticks: () => ticks,
    };
}

const PORTS = [18991, 18992, 18993, 18994, 18995];
for (const p of PORTS) {
    const lp = path.join(os.tmpdir(), `bili-proxy-${p}.log`);
    try { fs.unlinkSync(lp); } catch {}
    try { fs.unlinkSync(`${lp}.old`); } catch {}
}

test("#4994 rung 1: proven-healthy child on the preferred port is adopted, not killed", async () => {
    const clock = fakeClock();
    const kills: Array<NodeJS.Signals | undefined> = [];
    const port = PORTS[0];
    const preferred = `http://127.0.0.1:${port}`;
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port, passthrough: false, debug: false, parentPid: 1 },
        {
            fetchImpl: async () => ({ ok: true }),
            // The starvation shape: records clobbered live (no token match, no
            // registry entry, record not stale) so no per-poll fallback ever
            // fires — but the health endpoint tells the truth about who serves.
            fetchHealthInfo: async (origin) => (origin === preferred ? { ok: true, pid: CHILD_PID } : { ok: false }),
            spawnImpl: (): SpawnChild => makeFakeChild(CHILD_PID, kills),
            now: clock.now,
            sleep: clock.sleep,
            readInstanceFile: () => foreignInstance(port),
            listRegistryInstances: () => [],
        },
    );
    assert.equal(handle.origin, preferred);
    assert.equal(handle.port, port);
    assert.ok(handle.child, "the healthy child was kept, not abandoned");
    assert.deepEqual(kills, [], "a proven-healthy child is never killed");
    assert.ok(clock.ticks() >= 59, `adoption happens AT budget exhaustion (${clock.ticks()}s), not earlier`);
});

test("#4994 rung 2: laddered child found via its own pid-tagged listen line is adopted", async () => {
    const clock = fakeClock();
    const kills: Array<NodeJS.Signals | undefined> = [];
    const port = PORTS[1];
    const ladderPort = PORTS[2];
    const preferred = `http://127.0.0.1:${port}`;
    const ladder = `http://127.0.0.1:${ladderPort}`;
    const logPath = path.join(os.tmpdir(), `bili-proxy-${port}.log`);
    const handle = await ensureProxyRunning(
        { host: "127.0.0.1", port, passthrough: false, debug: false, parentPid: 1 },
        {
            fetchImpl: async () => ({ ok: true }),
            // Preferred port is held by a squatter (different pid); the child
            // hopped +N and announced its real bind in its own log segment.
            fetchHealthInfo: async (origin) =>
                origin === preferred ? { ok: true, pid: SQUATTER_PID } : origin === ladder ? { ok: true, pid: CHILD_PID } : { ok: false },
            spawnImpl: (): SpawnChild => {
                // Simulate the child's bind announcement landing AFTER the
                // spawner captured spawnLogOffset (append-only port log).
                fs.appendFileSync(
                    logPath,
                    `2026-10-27T15:48:00.000Z [info] acp-proxy v0.1.208 (pid ${CHILD_PID}, id deadbeef) listening on ${ladder}\n`,
                );
                return makeFakeChild(CHILD_PID, kills);
            },
            now: clock.now,
            sleep: clock.sleep,
            readInstanceFile: () => foreignInstance(port),
            listRegistryInstances: () => [],
        },
    );
    assert.equal(handle.origin, ladder, "the child's self-reported bind wins over the squatted preferred port");
    assert.equal(handle.port, ladderPort);
    assert.ok(handle.child);
    assert.deepEqual(kills, []);
});

test("#4994 negative: an UNPROVEN child still burns the budget and gets killed (unchanged)", async () => {
    const clock = fakeClock();
    const kills: Array<NodeJS.Signals | undefined> = [];
    const port = PORTS[3];
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port, passthrough: false, debug: false, parentPid: 1 },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async () => ({ ok: false }),
                spawnImpl: (): SpawnChild => makeFakeChild(CHILD_PID, kills),
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => foreignInstance(port),
                listRegistryInstances: () => [],
            },
        ),
        new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`),
    );
    assert.ok(clock.ticks() >= 59, `the full budget was consumed before failing, got ${clock.ticks()}s`);
    assert.deepEqual(kills, ["SIGKILL"], "an unidentifiable child is hard-killed exactly once");
});

test("#4994 negative: a healthy FOREIGN responder on the preferred port is never adopted", async () => {
    const clock = fakeClock();
    const kills: Array<NodeJS.Signals | undefined> = [];
    const port = PORTS[4];
    const preferred = `http://127.0.0.1:${port}`;
    await assert.rejects(
        ensureProxyRunning(
            { host: "127.0.0.1", port, passthrough: false, debug: false, parentPid: 1 },
            {
                fetchImpl: async () => ({ ok: false }),
                fetchHealthInfo: async (origin) => (origin === preferred ? { ok: true, pid: SQUATTER_PID } : { ok: false }),
                spawnImpl: (): SpawnChild => makeFakeChild(CHILD_PID, kills),
                now: clock.now,
                sleep: clock.sleep,
                readInstanceFile: () => foreignInstance(port),
                listRegistryInstances: () => [],
            },
        ),
        new RegExp(`did not become healthy within ${SPAWN_BUDGET_MS}ms`),
    );
    assert.deepEqual(kills, ["SIGKILL"], "a squatter's health answer must not mask the dead-end");
});
