import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import workerThreads, { Worker, type WorkerOptions } from "node:worker_threads";
import { workerResolveHost } from "../src/tunnel-guard.ts";

// #7407: the one-shot DNS fallback worker is throwaway, but on the inner
// deadline the parent used to clear its outer timer and reject WITHOUT
// stopping the worker — the expired probe (and its still-queued
// getaddrinfo) kept a whole thread plus a libuv pool slot alive until
// unrelated native work finished. These tests run the REAL Worker
// implementation (only the lookup boundary is stalled via a prelude the
// harness prepends to the worker source) and assert the worker thread is
// actually gone once the probe has settled.
//
// Gate discipline (#3617): the stalled-lookup case is the regression
// (fails on the unfixed base — the expired worker stays alive); the outer
// deadline and the successful-lookup cases are the "does not over-trigger"
// controls (termination still works there, success exits normally).

const OBSERVE_EXIT_GRACE_MS = 1000;

function observeWorker(t: TestContext, prelude = "") {
    const workers: Array<{ worker: Worker; exited: Promise<number> }> = [];
    class ObservedWorker extends Worker {
        constructor(source: string | URL, options?: WorkerOptions) {
            assert.ok(typeof source === "string" && options?.eval, "the probe must use the real eval-worker plumbing");
            super(`${prelude}\n${source}`, { ...options, execArgv: [] });
            workers.push({ worker: this, exited: new Promise((resolve) => this.once("exit", resolve)) });
        }
    }
    const replacement = t.mock.method(workerThreads, "Worker", ObservedWorker);
    syncBuiltinESMExports();
    t.after(async () => {
        replacement.mock.restore();
        syncBuiltinESMExports();
        await Promise.all(workers.map(({ worker }) => worker.terminate()));
    });
    return async () => {
        assert.equal(workers.length, 1, "one-shot probe — exactly one worker");
        const { worker, exited } = workers[0]!;
        const outcome = await Promise.race([
            exited.then((code) => ({ code })),
            delay(OBSERVE_EXIT_GRACE_MS, undefined, { ref: false }).then(() => ({ code: null })),
        ]);
        assert.notEqual(outcome.code, null, "the settled one-shot probe must not retain a live worker");
        assert.equal(worker.threadId, -1);
        return outcome.code;
    };
}

test("#7407 regression: the inner lookup deadline stops its one-shot worker", async (t) => {
    const exited = observeWorker(t, `
        require("node:dns").promises.lookup = () => {
            setInterval(() => {}, 10000); // anchor: an unfixed worker provably outlives the observation window
            return new Promise(() => {}); // stalled getaddrinfo boundary
        };
    `);
    await assert.rejects(workerResolveHost("stalled-lookup.invalid"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as NodeJS.ErrnoException).code, "ETIMEDOUT");
        assert.match(error.message, /worker dns lookup failed/);
        return true;
    });
    assert.equal(await exited(), 1, "termination, not natural exit");
});

test("#7407 control: the outer deadline still stops a worker that cannot send its inner verdict", async (t) => {
    const exited = observeWorker(t, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);");
    await assert.rejects(workerResolveHost("localhost"), { code: "ETIMEDOUT", message: "ETIMEDOUT" });
    assert.equal(await exited(), 1);
});

test("#7407 control: a successful native lookup exits normally and keeps its addresses", async (t) => {
    const exited = observeWorker(t);
    const addresses = await workerResolveHost("localhost");
    assert.ok(addresses.includes("127.0.0.1") || addresses.includes("::1"));
    assert.equal(await exited(), 0, "success path must keep its natural exit");
});
