import assert from "node:assert/strict";
import test from "node:test";
import { ExternalSummaryExecutor, type SummaryCandidate, type SummaryWork } from "../src/external-summary.ts";

const budget = { totalTimeoutMs: 1000, targetTimeoutMs: 500, maxSummaryBytes: 4096 };
const work: SummaryWork[] = [
    { content: "range one", instructions: "Preserve constraints", reference: "current task" },
    { content: "range two", instructions: "Preserve errors" },
    { content: "range three", instructions: "Preserve paths" },
];
const stalled: SummaryCandidate = { summarize: (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
}) };

test("external summary batch: ranges keep order and report partial failure explicitly", async () => {
    const seen: string[] = [];
    const result = await new ExternalSummaryExecutor(1).executeBatch(work, [{ summarize: async (request) => {
        seen.push(request.content);
        if (request.content === "range two") throw new Error("private provider error");
        return `summary of ${request.content}`;
    } }], budget);
    assert.equal(result.status, "finished");
    assert.deepEqual(result.results.map((range) => range.status), ["success", "failed", "success"]);
    assert.deepEqual(seen, work.map((range) => range.content));
    assert.equal(JSON.stringify(result).includes("private provider error"), false);
});

test("external summary batch: each range uses the ordered fallback chain", async () => {
    const calls: string[] = [];
    const result = await new ExternalSummaryExecutor(2).executeBatch(work, [
        { summarize: async (request) => { calls.push(`primary:${request.content}`); throw new Error("401"); } },
        { summarize: async (request) => { calls.push(`backup:${request.content}`); return "backup summary"; } },
        { summarize: async () => { assert.fail("successful backup stops the chain"); } },
    ], budget);
    assert.equal(result.status, "finished");
    assert.deepEqual(result.results.map((range) => range.status === "success" ? range.targetIndex : -1), [1, 1, 1]);
    assert.deepEqual(calls, work.flatMap((range) => [`primary:${range.content}`, `backup:${range.content}`]));
});

test("external summary batch: one deadline covers all ranges, not one renewed budget per range", async () => {
    let calls = 0;
    const started = performance.now();
    const result = await new ExternalSummaryExecutor(1).executeBatch(work, [{ summarize: (request, signal) => {
        calls++;
        return calls === 1 ? Promise.resolve("first summary") : stalled.summarize(request, signal);
    } }], { ...budget, totalTimeoutMs: 50 });
    assert.equal(result.status, "deadline");
    assert.deepEqual(result.results.map((range) => range.status), ["success", "deadline"]);
    assert.equal(calls, 2);
    assert.ok(performance.now() - started < 300);
});

test("external summary batch: target timeout can fall back without resetting the operation deadline", async () => {
    const result = await new ExternalSummaryExecutor(1).executeBatch(work.slice(0, 2), [
        stalled, { summarize: async () => "backup summary" },
    ], { ...budget, targetTimeoutMs: 15 });
    assert.equal(result.status, "finished");
    assert.deepEqual(result.results.map((range) => range.status === "success" ? range.attempts.map((attempt) => attempt.outcome) : []), [
        ["timeout", "success"], ["timeout", "success"],
    ]);
});

test("external summary batch: caller cancellation stops later ranges and preserves earlier results", async () => {
    const controller = new AbortController();
    let calls = 0;
    const result = await new ExternalSummaryExecutor(1).executeBatch(work, [{ summarize: (request, signal) => {
        calls++;
        if (calls === 1) return Promise.resolve("first summary");
        queueMicrotask(() => controller.abort());
        return stalled.summarize(request, signal);
    } }], budget, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.deepEqual(result.results.map((range) => range.status), ["success", "cancelled"]);
    assert.equal(calls, 2);
});

test("external summary batch: pre-aborted requests do not dispatch any range", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new ExternalSummaryExecutor(1).executeBatch(work, [{ summarize: async () => assert.fail("must not dispatch") }], budget, controller.signal);
    assert.deepEqual(result, { status: "cancelled", results: [] });
});

test("external summary batch: queue time consumes the shared deadline", async (t) => {
    let elapsed = 0;
    t.mock.method(performance, "now", () => elapsed);
    const executor = new ExternalSummaryExecutor(1);
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => { entered = resolve; });
    let release!: (value: string) => void;
    const occupied = executor.execute(work[0], [{ summarize: () => { entered(); return new Promise((resolve) => { release = resolve; }); } }], budget);
    await dispatched;
    let calls = 0;
    try {
        const pending = executor.executeBatch(work, [{ summarize: async () => {
            calls++;
            if (calls === 1) {
                elapsed = 60;
                return "first summary";
            }
            elapsed = 121;
            return "late summary";
        } }], { ...budget, totalTimeoutMs: 120 });
        elapsed = 40;
        release("occupying summary");
        const result = await pending;
        assert.equal(result.status, "deadline");
        assert.deepEqual(result.results.map((range) => range.status), ["success", "deadline"]);
        assert.equal(calls, 2);
    } finally {
        release("cleanup summary");
        assert.equal((await occupied).status, "success");
    }
});

test("external summary batch: all work and budget values are snapshotted before dispatch", async () => {
    const requests = work.map((range) => ({ ...range }));
    const limits = { ...budget };
    const seen: string[] = [];
    const candidates: SummaryCandidate[] = [{ summarize: async (request) => {
        seen.push(request.content);
        requests[1].content = "mutated range";
        limits.totalTimeoutMs = 1;
        limits.maxSummaryBytes = 1;
        candidates.length = 0;
        assert.equal(Object.isFrozen(request), true);
        return "original summary";
    } }];
    const result = await new ExternalSummaryExecutor(1).executeBatch(requests, candidates, limits);
    assert.equal(result.status, "finished");
    assert.equal(result.results.every((range) => range.status === "success"), true);
    assert.deepEqual(seen, work.map((range) => range.content));
});

test("external summary batch: event-loop stalls cannot accept late success or dispatch another range", async () => {
    let calls = 0;
    const result = await new ExternalSummaryExecutor(1).executeBatch(work, [{ summarize: async () => {
        calls++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
        return "too late";
    } }], { ...budget, totalTimeoutMs: 10 });
    assert.equal(result.status, "deadline");
    assert.deepEqual(result.results.map((range) => range.status), ["deadline"]);
    assert.equal(calls, 1);
});

async function waitFor(flag: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 1000; i++) {
        if (flag()) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`timed out waiting for ${what}`);
}

test("external summary batch: a scoped pool admits concurrent work while it is in flight (#2657)", async () => {
    const executor = new ExternalSummaryExecutor(1);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let aStarted = false;
    let bStarted = false;
    const candidateA: SummaryCandidate = { summarize: async () => { aStarted = true; await gateA; return "A"; } };
    const candidateB: SummaryCandidate = { summarize: async () => { bStarted = true; return "B"; } };
    try {
        const pendingA = executor.execute(work[0], [candidateA], budget, undefined, { concurrency: 4 });
        await waitFor(() => aStarted, "A to start");
        // Base pool is 1, yet B must be admitted by A's in-flight scope of 4.
        const pendingB = executor.execute(work[1], [candidateB], budget);
        await waitFor(() => bStarted, "B to start while A holds its slot");
        releaseA();
        assert.equal((await pendingA).status, "success");
        assert.equal((await pendingB).status, "success");
    } finally {
        releaseA();
    }
});

test("external summary batch: the pool returns to base size once the scoped work settles (#2657)", async () => {
    const executor = new ExternalSummaryExecutor(1);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let aStarted = false;
    const candidateA: SummaryCandidate = { summarize: async () => { aStarted = true; await gateA; return "A"; } };
    try {
        const pendingA = executor.execute(work[0], [candidateA], budget, undefined, { concurrency: 4 });
        await waitFor(() => aStarted, "A to start");
        releaseA();
        assert.equal((await pendingA).status, "success");
        // With A settled the pool is back to base 1: B must queue behind C.
        let releaseC!: () => void;
        const gateC = new Promise<void>((resolve) => { releaseC = resolve; });
        let cStarted = false;
        let bStarted = false;
        const candidateC: SummaryCandidate = { summarize: async () => { cStarted = true; await gateC; return "C"; } };
        const candidateB: SummaryCandidate = { summarize: async () => { bStarted = true; return "B"; } };
        try {
            const pendingC = executor.execute(work[2], [candidateC], budget);
            await waitFor(() => cStarted, "C to start");
            const pendingB = executor.execute(work[1], [candidateB], budget);
            // B must stay queued for every tick until C releases the only permit.
            for (let i = 0; i < 50 && !bStarted; i++) await new Promise((resolve) => setImmediate(resolve));
            assert.equal(bStarted, false);
            releaseC();
            await waitFor(() => bStarted, "B to start after C released");
            assert.equal((await pendingB).status, "success");
            assert.equal((await pendingC).status, "success");
        } finally {
            releaseC();
        }
    } finally {
        releaseA();
    }
});

test("external summary batch: an oversized scope yields to a larger in-flight demand (#2657)", async () => {
    const executor = new ExternalSummaryExecutor(1);
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let aStarted = false;
    let bStarted = false;
    const candidateA: SummaryCandidate = { summarize: async () => { aStarted = true; await gateA; return "A"; } };
    const candidateB: SummaryCandidate = { summarize: async () => { bStarted = true; return "B"; } };
    try {
        const pendingA = executor.execute(work[0], [candidateA], budget, undefined, { concurrency: 8 });
        await waitFor(() => aStarted, "A to start");
        const pendingB = executor.execute(work[1], [candidateB], budget, undefined, { concurrency: 3 });
        await waitFor(() => bStarted, "B to start under the larger in-flight demand");
        releaseA();
        assert.equal((await pendingA).status, "success");
        assert.equal((await pendingB).status, "success");
    } finally {
        releaseA();
    }
});

test("external summary batch: an invalid pool scope rejects without dispatch (#2657)", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const candidate: SummaryCandidate = { summarize: async () => assert.fail("must not dispatch") };
    // Non-positive values reject before dispatch; the 1..32 product range is
    // owned by the settings layer, the executor takes any positive integer.
    await assert.rejects(executor.execute(work[0], [candidate], budget, undefined, { concurrency: 0 }), TypeError);
    await assert.rejects(executor.executeBatch(work, [candidate], budget, undefined, { concurrency: -1 }), TypeError);
});

test("external summary batch: invalid operation plans fail without dispatch", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const candidates = [{ summarize: async () => assert.fail("must not dispatch") }];
    const expected = { status: "failed", reason: "invalid_plan", results: [] };
    assert.deepEqual(await executor.executeBatch([], candidates, budget), expected);
    assert.deepEqual(await executor.executeBatch(work, [], budget), expected);
    assert.deepEqual(await executor.executeBatch(work, candidates, { ...budget, totalTimeoutMs: 0 }), expected);
    assert.deepEqual(await executor.executeBatch(work, candidates, { ...budget, targetTimeoutMs: 2_147_483_648 }), expected);
});
