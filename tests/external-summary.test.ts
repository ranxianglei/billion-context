import assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalSummaryExecutor, type SummaryBudget, type SummaryCandidate, type SummaryWork } from "../src/external-summary.ts";

const work: SummaryWork = { content: "Historical task evidence", instructions: "Preserve constraints and unfinished work", reference: "Read-only current task" };
const budget: SummaryBudget = { totalTimeoutMs: 2000, targetTimeoutMs: 500, maxSummaryBytes: 200 };

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function successful(value = "Stored summary"): SummaryCandidate {
    return { summarize: async () => value };
}

test("external summary: first success stops the ordered chain and preserves bytes", async () => {
    let backup = 0;
    const source = { ...work };
    const result = await new ExternalSummaryExecutor(2).execute(source, [{ summarize: async (request) => {
        assert.deepEqual(request, source);
        assert.equal(Object.isFrozen(request), true);
        return "  Exact summary\n";
    } }, { summarize: async () => { backup++; return "unwanted"; } }], budget);
    assert.deepEqual(result, { status: "success", summary: "  Exact summary\n", targetIndex: 0, attempts: [{ targetIndex: 0, outcome: "success" }] });
    assert.equal(backup, 0);
    assert.deepEqual(source, work);
});

test("external summary: failed targets run once in order, without leaking provider errors", async () => {
    const order: number[] = [];
    const result = await new ExternalSummaryExecutor(2).execute(work, [
        { summarize: async () => { order.push(0); throw new Error("private-key private-url source-content"); } },
        { summarize: async () => { order.push(1); throw new Error("HTTP 401"); } },
        { summarize: async () => { order.push(2); return "backup"; } },
    ], budget);
    assert.deepEqual(order, [0, 1, 2]);
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["error", "error", "success"]);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(result.status, "success");
});

test("external summary: exhaustion never invents a summary or main-model fallback", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => { throw new Error("failed"); } }], budget);
    assert.deepEqual(result, { status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "error" }] });
    assert.equal("summary" in result, false);
});

test("external summary: empty and oversized UTF-8 output fail over", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [successful(" \n"), successful("\u4e2d".repeat(70)), successful("valid")], budget);
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["invalid_summary", "invalid_summary", "success"]);
    assert.equal(result.status, "success");
});

test("external summary: invalid plans dispatch no calls", async () => {
    const executor = new ExternalSummaryExecutor(1);
    let calls = 0;
    const target: SummaryCandidate = { summarize: async () => { calls++; return "summary"; } };
    for (const bad of [0, -1, NaN, Infinity, 0.5, 2_147_483_648]) {
        assert.equal((await executor.execute(work, [target], { ...budget, totalTimeoutMs: bad })).status, "failed");
        assert.equal((await executor.execute(work, [target], { ...budget, targetTimeoutMs: bad })).status, "failed");
    }
    for (const [request, targets, limits] of [
        [{ ...work, content: " " }, [target], budget],
        [{ ...work, instructions: " " }, [target], budget],
        [work, [], budget],
        [work, [target], { ...budget, maxSummaryBytes: 0 }],
    ] as const) {
        assert.deepEqual(await executor.execute(request, targets, limits), { status: "failed", reason: "invalid_plan", attempts: [] });
    }
    assert.equal(calls, 0);
    for (const bad of [0, -1, 0.5, Infinity, NaN]) assert.throws(() => new ExternalSummaryExecutor(bad), TypeError);
});

test("external summary: a pre-aborted caller never dispatches", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => { calls++; return "summary"; } }], budget, controller.signal);
    assert.deepEqual(result, { status: "cancelled", attempts: [] });
    assert.equal(calls, 0);
});

test("external summary: cancellation aborts the active target without starting backup", async () => {
    const controller = new AbortController();
    let backup = 0;
    let seen: AbortSignal | undefined;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_request, signal) => {
        seen = signal;
        controller.abort();
        throw new Error("cancelled");
    } }, { summarize: async () => { backup++; return "backup"; } }], budget, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.equal(seen?.aborted, true);
    assert.equal(backup, 0);
});

test("external summary: a target timeout aborts transport and tries the next candidate", async () => {
    let first: AbortSignal | undefined;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_request, signal) => {
        first = signal;
        return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } }, successful("backup")], { ...budget, targetTimeoutMs: 15 });
    assert.equal(first?.aborted, true);
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["timeout", "success"]);
    assert.equal(result.status, "success");
});

test("external summary: total deadline prevents spending the remaining chain", async () => {
    let backup = 0;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_request, signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }) }, { summarize: async () => { backup++; return "backup"; } }], { ...budget, totalTimeoutMs: 15 });
    assert.equal(result.status, "deadline");
    assert.equal(backup, 0);
});

test("external summary: aggregate concurrency bounds distinct operations", async () => {
    const executor = new ExternalSummaryExecutor(2);
    const entered = deferred<void>();
    const leave = deferred<string>();
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const target: SummaryCandidate = { summarize: async () => {
        calls++; active++; maximum = Math.max(maximum, active);
        if (calls === 2) entered.resolve();
        try { return await leave.promise; } finally { active--; }
    } };
    const jobs = Array.from({ length: 5 }, () => executor.execute(work, [target], budget));
    await entered.promise;
    assert.equal(calls, 2);
    leave.resolve("summary");
    assert.ok((await Promise.all(jobs)).every((item) => item.status === "success"));
    assert.equal(maximum, 2);
    assert.equal(calls, 5);
});

test("external summary: queued work can hit its total deadline without dispatching", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const entered = deferred<void>();
    const leave = deferred<string>();
    const holder = executor.execute(work, [{ summarize: async () => { entered.resolve(); return leave.promise; } }], budget);
    await entered.promise;
    let calls = 0;
    const queued = await executor.execute(work, [{ summarize: async () => { calls++; return "queued"; } }], { ...budget, totalTimeoutMs: 15 });
    assert.deepEqual(queued, { status: "deadline", attempts: [] });
    assert.equal(calls, 0);
    leave.resolve("holder");
    assert.equal((await holder).status, "success");
    assert.equal((await executor.execute(work, [successful()], budget)).status, "success");
});

test("external summary: a cancelled queue entry cannot block the next operation", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const entered = deferred<void>();
    const leave = deferred<string>();
    const holder = executor.execute(work, [{ summarize: async () => { entered.resolve(); return leave.promise; } }], budget);
    await entered.promise;
    const controller = new AbortController();
    const cancelled = executor.execute(work, [successful()], budget, controller.signal);
    const next = executor.execute(work, [successful("next")], budget);
    controller.abort();
    assert.deepEqual(await cancelled, { status: "cancelled", attempts: [] });
    leave.resolve("holder");
    assert.equal((await holder).status, "success");
    assert.equal((await next).status, "success");
});

test("external summary: late non-cooperative results cannot succeed or exceed capacity", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const leave = deferred<string>();
    let backup = 0;
    const result = await executor.execute(work, [{ summarize: async () => leave.promise }, { summarize: async () => { backup++; return "backup"; } }], { ...budget, totalTimeoutMs: 35, targetTimeoutMs: 10 });
    assert.equal(result.status, "deadline");
    assert.equal(backup, 0);
    leave.resolve("late result must not commit");
    await leave.promise;
    assert.equal(result.status, "deadline");
    assert.equal((await executor.execute(work, [successful()], budget)).status, "success");
});

test("external summary: late rejections are observed and release capacity", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const leave = deferred<string>();
    const result = await executor.execute(work, [{ summarize: async () => leave.promise }], { ...budget, targetTimeoutMs: 10 });
    assert.deepEqual(result, { status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "timeout" }] });
    leave.reject(new Error("late private provider error"));
    await leave.promise.catch(() => undefined);
    assert.equal((await executor.execute(work, [successful()], budget)).status, "success");
});

test("external summary: elapsed total deadlines reject success even before the timer can fire", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return "too late";
    } }], { ...budget, totalTimeoutMs: 5 });
    assert.equal(result.status, "deadline");
    assert.equal("summary" in result, false);
});

test("external summary: elapsed target deadlines fail over before a delayed timer fires", async () => {
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        return "too late";
    } }, successful("backup")], { ...budget, targetTimeoutMs: 5 });
    assert.equal(result.status, "success");
    assert.deepEqual(result.attempts.map((item) => item.outcome), ["timeout", "success"]);
});

test("external summary: a caller cannot mutate the budget of an in-flight operation", async () => {
    const mutableBudget = { ...budget };
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async () => {
        mutableBudget.maxSummaryBytes = 1;
        return "summary";
    } }], mutableBudget);
    assert.equal(result.status, "success");
});

test("external summary: queued time does not spend the per-target dispatch budget", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const entered = deferred<void>();
    const leave = deferred<string>();
    const controller = new AbortController();
    const holder = executor.execute(work, [{ summarize: async () => { entered.resolve(); return leave.promise; } }], budget, controller.signal);
    await entered.promise;
    const queued = executor.execute(work, [successful("queued")], { ...budget, targetTimeoutMs: 100 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    controller.abort();
    assert.equal((await holder).status, "cancelled");
    leave.resolve("holder");
    assert.equal((await queued).status, "success");
});
