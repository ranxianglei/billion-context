// #5152: the owner-heartbeat SENDER must live on a loop a synchronous turn
// cannot starve. #3544 introduced the beat so a RECYCLED pid could be aged out
// under Windows pid reuse; #4994/#5085 then widened the proxy-side confirmation
// to consecutive ticks. Neither helped when the HOST thread is the thing that
// stalls: the beat could not be SENT at all, so a live owner went silent for the
// whole turn and the proxy confirmed a death that never happened.
//
// Red baseline recorded before this fix (.work/stall/owner-block.mjs — sender
// main thread blocked 45s against a healthy receiver), a LIVE owner was removed:
//     t=26.0s STALE streak=1 age=16002
//     t=30.0s STALE streak=3 age=20005
//     t=34.0s >>> REMOVED (false death) age=24011
// After the fix the worker kept posting throughout (measured 20/20 beats served
// during a 6s host block).
//
// This file pins the contract that matters: beats reach a HEALTHY receiver while
// the sending thread is pinned. The receiver is a separate process on purpose —
// an in-process receiver is pinned by the same block, so the assertion would be
// vacuous.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOwnerHeartbeatWorker, startOwnerHeartbeat, type OwnerBeatWorker } from "../src/launcher.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECEIVER = path.join(HERE, "fixtures", "issue5152-beat-receiver.mjs");

/** Spin the CPU for `ms` — a real synchronous stall, not a timer. */
function stall(ms: number): void {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* the blocked loop */ }
}

/** Wait `ms` without a synchronous stall (timer-driven, loop stays responsive). */
async function wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** A receiver in its OWN process: it must keep answering while our thread is
 *  blocked, which is exactly what the proxy does in production. */
interface Receiver {
    port: number;
    beats(): number[];
    stop(): void;
}

async function startReceiver(dir: string): Promise<Receiver> {
    const log = path.join(dir, "beats.txt");
    const portFile = `${log}.port`;
    const child = spawn(process.execPath, [RECEIVER, log], { stdio: "ignore", detached: true });
    child.unref();
    const deadline = Date.now() + 15_000;
    while (!existsSync(portFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    assert.ok(existsSync(portFile), "receiver must publish its port");
    const port = Number(readFileSync(portFile, "utf8").trim());
    assert.ok(Number.isInteger(port) && port > 0, `receiver port must be a number, got ${port}`);
    return {
        port,
        beats: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(Number) : []),
        stop: () => {
            try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
        },
    };
}

test("#5152 the owner heartbeat keeps POSTing while the sending thread is pinned", async () => {
    const dir = path.join(tmpdir(), `bili-5152-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recv = await startReceiver(dir);
    const BEAT_MS = 300;
    const BLOCK_MS = 6_000;
    let stop: (() => void) | undefined;
    try {
        stop = startOwnerHeartbeat(`http://127.0.0.1:${recv.port}`, process.pid, BEAT_MS);
        assert.equal(typeof stop, "function", "our own pid must be attested");

        // Wait for the worker's FIRST beat rather than a fixed delay: worker
        // cold start varies with host load and a short window would flake.
        const warmDeadline = Date.now() + 15_000;
        while (recv.beats().length === 0 && Date.now() < warmDeadline) {
            await wait(50);
        }
        const beforeBlock = recv.beats().length;
        assert.ok(beforeBlock >= 1, `the worker must already be beating before the stall (got ${beforeBlock})`);

        // A REAL synchronous stall — production's "one big turn" (#5138 records
        // ~19 minutes; scaled down here). Nothing on this thread runs for 6s, so
        // an in-thread beat loop could not post a single beat.
        stall(BLOCK_MS);
        stop?.();
        stop = undefined;

        // The contract is "the beat does not stop while the SENDER's loop is
        // pinned"; pre-fix that is exactly ZERO additional beats, so a sustained
        // trickle is already decisive. Demanding ~90% of the theoretical cadence
        // would instead measure the runner's CPU budget: under --test-concurrency
        // 4 the worker thread competes with other suites and a healthy fix can
        // miss that bar on a loaded shard (observed once locally while a second
        // node process was still running). Poll for a floor so the assertion is
        // about the property, not the scheduler.
        const expectedDuringBlock = Math.floor(BLOCK_MS / BEAT_MS);
        const floor = Math.max(1, Math.ceil(expectedDuringBlock / 2));
        const tallyDeadline = Date.now() + 10_000;
        while (recv.beats().length < beforeBlock + floor && Date.now() < tallyDeadline) {
            await wait(50);
        }
        const total = recv.beats().length;
        assert.ok(
            total >= beforeBlock + floor,
            `a live owner must stay attested through its own stall: beats before=${beforeBlock}, total=${total}, ` +
                `expected >= ${beforeBlock + floor} (>=${floor} of ${expectedDuringBlock} theoretical beats across a ` +
                `${BLOCK_MS}ms block; pre-fix this is 0)`,
        );
    } finally {
        stop?.();
        recv.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5152 an injected post keeps the testing seam and never starts a worker", async () => {
    // The #3544 tests (and any caller that records beats without a server) pass
    // an explicit `post`. That path must stay on the calling thread, post the
    // exact historical body, and honour stop() — no worker is created.
    const posts: string[] = [];
    const stop = startOwnerHeartbeat("http://127.0.0.1:1", process.pid, 20, async (body: string) => {
        posts.push(body);
    });
    assert.equal(typeof stop, "function");
    await wait(120);
    stop!();
    assert.ok(posts.length >= 1, `at least one beat (got ${posts.length})`);
    assert.deepEqual(JSON.parse(posts[0]), { pid: process.pid, hb: true }, "the wire shape is unchanged");
    const frozen = posts.length;
    await wait(80);
    assert.equal(posts.length, frozen, "stop() must halt the beat");
});

test("#5152 a foreign pid is never attested (claude-lane ppid keeps legacy kill-0)", () => {
    const stop = startOwnerHeartbeat("http://127.0.0.1:1", 999_999, 20, async () => { /* would record */ });
    assert.equal(stop, undefined, "only OUR OWN pid can be attested this way");
});

test("#5152 one worker per origin: repeated attach paths share, refcounted stop", async () => {
    const dir = path.join(tmpdir(), `bili-5152-share-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recv = await startReceiver(dir);
    let s1: (() => void) | undefined;
    let s2: (() => void) | undefined;
    try {
        const origin = `http://127.0.0.1:${recv.port}`;
        // Two attach paths for the SAME proxy (spawn + attach, or two lanes).
        s1 = startOwnerHeartbeat(origin, process.pid, 100);
        s2 = startOwnerHeartbeat(origin, process.pid, 100);
        assert.equal(typeof s1, "function");
        assert.equal(typeof s2, "function");

        // Warm up: a worker needs a beat cycle before its first POST lands.
        await wait(2_500);
        const t1 = recv.beats().length;
        const w1 = Date.now();
        await wait(1_000);
        const rateBoth = (recv.beats().length - t1) / ((Date.now() - w1) / 1000);
        // One worker at 100ms ⇒ ~10/s. Two would double it.
        assert.ok(rateBoth <= 14, `two calls must share ONE worker: ${rateBoth.toFixed(1)} beats/s (expected ~10, two workers would be ~20)`);

        // assert.equal does not narrow the type, so release through the optional
        // call — both handles were asserted non-undefined just above.
        s1?.();
        s1 = undefined;
        await wait(1_000);
        const t2 = recv.beats().length;
        const w2 = Date.now();
        await wait(1_000);
        const rateAfterOne = (recv.beats().length - t2) / ((Date.now() - w2) / 1000);
        assert.ok(rateAfterOne >= 5, `the first stop() must not silence a still-attached caller: ${rateAfterOne.toFixed(1)}/s`);
    } finally {
        s1?.();
        s2?.();
        await wait(1_200);
        recv.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5152 a worker that dies mid-flight falls back to the in-thread loop", async () => {
    // A dead worker must not keep its refcount slot while attesting nothing —
    // that would starve every later attach for this origin of beats and hand
    // the proxy back the very false death (#5152) this heartbeat prevents.
    const dir = path.join(tmpdir(), `bili-5152-crash-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recv = await startReceiver(dir);
    const BEAT_MS = 300;
    let stop: (() => void) | undefined;
    let errorListener: ((err: Error) => void) | undefined;
    try {
        const fakeWorker: OwnerBeatWorker = {
            on(event, listener) { if (event === "error") errorListener = listener; },
            unref() { /* the fake holds no loop resource */ },
            postMessage() { /* dead worker */ },
            terminate() { return Promise.resolve(undefined); },
        };
        stop = runOwnerHeartbeatWorker(`http://127.0.0.1:${recv.port}`, process.pid, BEAT_MS, () => fakeWorker);
        assert.equal(typeof stop, "function");

        // Negative direction: while the (pretended) worker is alive, NO beat may
        // come from an in-thread loop — the fallback must not arm prematurely.
        await wait(900);
        assert.equal(recv.beats().length, 0, "no in-thread loop may run before the crash");

        assert.equal(typeof errorListener, "function", "the worker's error handler must be armed");
        errorListener!(new Error("simulated thread death"));
        await wait(1_200);
        assert.ok(recv.beats().length >= 1, `the in-thread fallback must keep attesting after the worker dies (got ${recv.beats().length} beats)`);

        stop!();
        stop = undefined;
        const frozen = recv.beats().length;
        await wait(900);
        assert.equal(recv.beats().length, frozen, "stop() must silence the fallback together with the entry");
    } finally {
        stop?.();
        recv.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#5152 a host where the worker cannot start keeps beating from the in-thread loop", async () => {
    // The other direction of the same gate: construction itself fails (a
    // locked-down runtime without usable worker threads) ⇒ fall back BEFORE
    // anything is armed, and still attest.
    const dir = path.join(tmpdir(), `bili-5152-nostart-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const recv = await startReceiver(dir);
    const BEAT_MS = 300;
    let stop: (() => void) | undefined;
    try {
        stop = runOwnerHeartbeatWorker(`http://127.0.0.1:${recv.port}`, process.pid, BEAT_MS, () => {
            throw new Error("worker_threads unavailable");
        });
        assert.equal(typeof stop, "function", "construction failure must still return a live handle");
        await wait(1_200);
        assert.ok(recv.beats().length >= 1, `the in-thread fallback must attest immediately (got ${recv.beats().length} beats)`);
    } finally {
        stop?.();
        recv.stop();
        rmSync(dir, { recursive: true, force: true });
    }
});
