// #7675 — the pre-spawn second-writer gate was blind to MANUAL daemons.
//
// quiesceSameLanePredecessor (#7156) only looked at instances whose lane
// EQUALS the launching lane. A manual `bili start` registers with NO lane,
// so it was invisible: with one sitting on a lane's target port, the lane
// launch found the port occupied, laddered to base+1, and spawned a full
// second proxy writing the SAME shared sessions dir — silently. Field state
// on the corruption host (2026-11-24): three manual daemons on 18873/4/5
// plus two pi-lane daemons drifted to 18876/18877 by exactly this ladder —
// five live writers over one index.db.
//
// The fix under test (src/launcher.ts): a LIVE no-lane, non-user-zone
// instance on the launch's target port becomes a gate predecessor. It is
// neither attachable (no lane identity) nor wedge-takeover-eligible (the
// user's own process — no automatic kills), so the gate REFUSES with an
// actionable error: pid + origin + the two remedies (its own port zone, or
// stop it). Same-lane behavior (healthy allow / wedge refusal / drain grace)
// is unchanged.
//
// #3617 both directions: the refusal row AND the "does NOT trigger" rows
// (dead pid, foreign port, same-lane healthy peer, lane-less launch).

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyInstanceFile } from "../src/instance.ts";
import { removeStartingMarker } from "../src/instance.ts";
import {
    ensureProxyRunning,
    type SpawnChild,
    type SpawnFn,
} from "../src/launcher.ts";

const SCRATCH_STATE = path.join(os.tmpdir(), `bili-state-7675-${process.pid}`);
fs.mkdirSync(path.join(SCRATCH_STATE, "billion-context"), { recursive: true });
process.env.XDG_STATE_HOME = SCRATCH_STATE;

const HOST = "127.0.0.1";
const PORT = 18787;
const ORIGIN = `http://${HOST}:${PORT}`;
const CHILD_PID = 42_471;
const CHILD_ORIGIN = `http://${HOST}:${PORT + 1}`; // the laddered child binds base+1

const FP_SCRIPT = path.join(os.tmpdir(), `bili-fp-7675-${process.pid}.js`);
fs.writeFileSync(FP_SCRIPT, "// fingerprint fixture\n");
const FP_HASH = createHash("sha256").update(fs.readFileSync(FP_SCRIPT)).digest("hex");

function makeClock() {
    let t = 1_000_000_000;
    return {
        now: () => t,
        sleep: (ms: number) => new Promise<void>((res) => { t += Math.max(1, ms); res(); }),
    };
}

interface World {
    clock: ReturnType<typeof makeClock>;
    /** pid → alive. The holder runs under process.pid (alive) unless a row
     *  says otherwise; the fake child pid is dead, as in the real kill(0). */
    pids: Map<number, boolean>;
    /** Origins answering the connect probe RIGHT NOW. Rows seed it with the
     *  holder's origin when it is listening; spawnImpl adds the launch's own
     *  origin (the child bound + became healthy). */
    upOrigins: Set<string>;
    spawnCalls: number;
}

function makeWorld(): World {
    return {
        clock: makeClock(),
        pids: new Map([[process.pid, true], [CHILD_PID, false]]),
        upOrigins: new Set(),
        spawnCalls: 0,
    };
}

function manualHolder(overrides?: Partial<ProxyInstanceFile>): ProxyInstanceFile {
    return {
        origin: ORIGIN,
        instanceId: "manual-instance",
        pid: process.pid,
        startedAt: Date.now(),
        host: HOST,
        port: PORT,
        passthrough: false,
        mitmDomains: [],
        modelWindows: {},
        codeFingerprint: FP_HASH, // same build — the attachable shareable-daemon case
        launchToken: "manual-token",
        // No `lane` field: a manual `bili start` registers without one.
        ...overrides,
    };
}

function makeFakeChild(pid: number): SpawnChild {
    return { pid, unref() {}, kill() { return true; }, on() {} };
}

type Deps = NonNullable<Parameters<typeof ensureProxyRunning>[1]>;

function makeDeps(w: World, holder: ProxyInstanceFile): Deps {
    // Health answers are keyed by WHO answers at that origin: the holder
    // (armed or not, per world flag) vs the laddered child (always armed).
    let holderArmed = true;
    const healthAt = (origin: string) => {
        if (origin === holder.origin) {
            const base = { ok: true, instanceId: holder.instanceId, pid: holder.pid, version: "0.0.1" };
            return holderArmed ? { ...base, watchdog: { armed: true } } : base;
        }
        if (origin === CHILD_ORIGIN) {
            return { ok: true, instanceId: "mine-1", pid: CHILD_PID, watchdog: { armed: true }, version: "0.0.1" };
        }
        return undefined;
    };
    const deps: Deps = {
        fetchImpl: async (url: string) => ({ ok: w.upOrigins.has(new URL(url).origin) }),
        fetchHealthInfo: async (origin: string) => (w.upOrigins.has(origin) ? healthAt(origin) : undefined),
        readInstanceFile: () => holder,
        // The per-instance registry marker for the (fake) spawned child — the
        // post-spawn pid fallback trusts it; its pid is DEAD in the liveness
        // mock, so the pre-spawn probe never sees it as a live candidate.
        listRegistryInstances: () => [{
            origin: CHILD_ORIGIN,
            instanceId: "mine-1",
            pid: CHILD_PID,
            startedAt: Date.now(),
            host: HOST,
            port: PORT + 1,
            passthrough: false,
            mitmDomains: [],
            modelWindows: {},
            codeFingerprint: FP_HASH,
            lane: "dsh",
            launchToken: "child-token",
        }],
        spawnImpl: (_command: string, _args: readonly string[], _options: Parameters<SpawnFn>[2]): SpawnChild => {
            w.spawnCalls += 1;
            w.upOrigins.add(CHILD_ORIGIN);
            return makeFakeChild(CHILD_PID);
        },
        now: () => w.clock.now(),
        sleep: (ms: number) => w.clock.sleep(ms),
        scriptPath: FP_SCRIPT,
        nodeRuntime: process.execPath,
        registerWatcher: async () => "ok",
        resolveAttachUrl: () => undefined,
        resolveAttachExternal: () => false,
        resolveAttachPolicy: () => "own-lane",
        attachLanePriority: () => [],
        fetchHealthInfoNoReuse: async (origin: string) => (w.upOrigins.has(origin) ? healthAt(origin) : undefined),
        isPidAlive: (pid: number) => w.pids.get(pid) ?? false,
        isConnectable: async (origin: string) => w.upOrigins.has(origin),
        wedgedLedgerPath: () => path.join(SCRATCH_STATE, "billion-context", "wedged-ledger-test.json"),
        processBirthStamp: async (pid: number) => `stamp-${pid}`,
        attachDiag: () => {},
    };
    return { ...deps, setHolderArmed: (armed: boolean) => { holderArmed = armed; } } as Deps & { setHolderArmed: (a: boolean) => void };
}

async function runCycle(
    w: World,
    holder: ProxyInstanceFile,
    flags: { holderListening: boolean; holderHealthy: boolean; lane?: string },
): Promise<Awaited<ReturnType<typeof ensureProxyRunning>> | Error> {
    if (flags.holderListening) w.upOrigins.add(holder.origin);
    const deps = makeDeps(w, holder);
    try {
        return await ensureProxyRunning({
            host: HOST,
            port: PORT,
            passthrough: false,
            debug: false,
            lane: flags.lane,
            parentPid: 999_999,
        }, deps);
    } catch (err) {
        if (err instanceof Error) return err;
        throw err;
    }
}

beforeEach(() => {
    removeStartingMarker();
});

test("#7675: a live MANUAL daemon that the attach tiers veto REFUSES the lane launch", async () => {
    // Field shape (2026-11-24): the manual daemon answered health but was
    // not an attach target (unarmed watchdog, non-user-zone registration),
    // so pre-#7675 the lane laddered to +1 and drifted a second writer.
    // Post-fix the gate refuses with an actionable error instead.
    const w = makeWorld();
    const holder = manualHolder();
    w.upOrigins.add(holder.origin);
    const deps = makeDeps(w, holder) as Deps & { setHolderArmed: (a: boolean) => void };
    deps.setHolderArmed(false); // answers health but un-armed — not an attach target
    let err: unknown;
    try {
        await ensureProxyRunning({
            host: HOST,
            port: PORT,
            passthrough: false,
            debug: false,
            lane: "dsh",
            parentPid: 999_999,
        }, deps);
    } catch (e) {
        err = e;
    }
    assert.ok(err instanceof Error && err.message.includes("refusing to spawn a second writer"), `actionable refusal: ${err instanceof Error ? err.message : String(err)}`);
    assert.ok(err instanceof Error && err.message.includes(String(process.pid)), "the refusal names the holder pid");
    assert.ok(err instanceof Error && err.message.includes("manual launch with no lane"), "the refusal says what the holder is");
    assert.ok(err instanceof Error && err.message.includes("BILI_PORT_ZONE") && err.message.includes("kill"), "the refusal carries both remedies");
    assert.equal(w.spawnCalls, 0, "no second writer may be spawned behind a live manual daemon");
});

test("#7675 (negative): the refusal does not depend on the holder's health", async () => {
    // The manual daemon is the user's own process — even a WEDGED one must
    // not be auto-taken-over; the gate refuses either way.
    const w = makeWorld();
    const holder = manualHolder();
    w.upOrigins.add(holder.origin); // listening but health-silent (wedged)
    const deps = makeDeps(w, holder);
    deps.fetchHealthInfo = async () => undefined;
    deps.fetchHealthInfoNoReuse = async () => undefined;
    let err: unknown;
    try {
        await ensureProxyRunning({
            host: HOST,
            port: PORT,
            passthrough: false,
            debug: false,
            lane: "dsh",
            parentPid: 999_999,
        }, deps);
    } catch (e) {
        err = e;
    }
    assert.ok(err instanceof Error && err.message.includes("refusing to spawn a second writer"),
        `expected the refusal for an unhealthy manual holder: ${err instanceof Error ? err.message : "handle"}`);
    assert.equal(w.spawnCalls, 0, "an unhealthy manual holder is NOT takeover-eligible");
});

test("#7675 (negative, both directions #3617): an ARMED manual daemon is attached, not refused", async () => {
    // The gate extension must not over-suppress the #2877/#1225 shareable-
    // daemon cell: a healthy ARMed manual daemon on the target port is a
    // legitimate attach target — the lane rides it, spawns nothing.
    const w = makeWorld();
    const holder = manualHolder();
    const result = await runCycle(w, holder, { holderListening: true, holderHealthy: true });
    assert.ok(!(result instanceof Error), `armed manual holder must be attachable, not refused: ${result instanceof Error ? result.message : ""}`);
    assert.equal(w.spawnCalls, 0, "attaching to the armed daemon must not spawn a second writer");
});

test("#7675 (negative): a DEAD manual daemon does not block the launch", async () => {
    const w = makeWorld();
    w.pids.set(process.pid, false); // the holder died (kill -9); its instance file is stale
    const result = await runCycle(w, manualHolder(), { holderListening: false, holderHealthy: false });
    assert.ok(!(result instanceof Error), `the dead holder must not block the launch: ${result instanceof Error ? result.message : ""}`);
    assert.equal(w.spawnCalls, 1, "the lane ladders on as usual behind a dead holder");
});

test("#7675 (negative): a manual daemon on a FOREIGN port does not block the launch", async () => {
    // The gate matches the launch's TARGET port only — a manual daemon
    // elsewhere (e.g. the classic 8787) is nobody's predecessor.
    const w = makeWorld();
    const other = manualHolder({ port: PORT + 50, origin: `http://${HOST}:${PORT + 50}` });
    const result = await runCycle(w, other, { holderListening: true, holderHealthy: true });
    assert.ok(!(result instanceof Error && result.message.includes("refusing to spawn")),
        `a foreign-port manual holder must not be refused by the gate: ${result instanceof Error ? result.message : ""}`);
});

test("#7675 regression: a same-lane healthy holder still launches (allow row unchanged)", async () => {
    // The gate extension must not over-suppress: the same-lane healthy peer
    // cell stays an allow (attach/adopt/rotation), exactly as before.
    const w = makeWorld();
    const holder = manualHolder({ lane: "dsh", codeFingerprint: FP_HASH, instanceId: "same-lane-instance" });
    const result = await runCycle(w, holder, { holderListening: true, holderHealthy: true });
    assert.ok(!(result instanceof Error && result.message.includes("refusing to spawn a second")),
        `a same-lane healthy holder must not be refused: ${result instanceof Error ? result.message : ""}`);
});

test("#7675 regression: a lane-less launch (manual bili start) skips the gate entirely", async () => {
    // The gate is a LANE discipline; a second manual daemon behind another
    // manual daemon is the pre-#7675 normal case (user zone, explicit port).
    const w = makeWorld();
    const result = await runCycle(w, manualHolder(), { holderListening: true, holderHealthy: true, lane: undefined });
    assert.ok(!(result instanceof Error && result.message.includes("refusing to spawn")),
        `lane-less launch must not hit the gate: ${result instanceof Error ? result.message : ""}`);
});
