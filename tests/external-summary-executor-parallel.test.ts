import assert from "node:assert/strict";
import test from "node:test";
import { ExternalSummaryExecutor, type SummaryCandidate, type SummaryWork } from "../src/external-summary.ts";

// #2667: executeBatch used to serialize every range regardless of pool size —
// these pin the bound-parallel contract: at most `concurrency` ranges in
// flight, results stay index-aligned with the work array (dense prefix), and
// an early stop (caller abort / shared deadline) leaves unstarted ranges
// undispatched rather than fabricated.

const budget = { totalTimeoutMs: 1000, targetTimeoutMs: 500, maxSummaryBytes: 4096 };
const work: SummaryWork[] = [
    { content: "range one", instructions: "Preserve constraints" },
    { content: "range two", instructions: "Preserve errors" },
    { content: "range three", instructions: "Preserve paths" },
];
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("executor batch: a batch runs up to the pool size concurrently and never beyond", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const candidate: SummaryCandidate = { summarize: (request) => new Promise<string>((resolve) => {
        started.push(request.content);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        gates.push(() => {
            inFlight -= 1;
            resolve(`s:${request.content}`);
        });
    }) };
    const pending = new ExternalSummaryExecutor(2).executeBatch(work, [candidate], budget);
    await flush();
    await flush();
    assert.deepEqual(started, ["range one", "range two"], "the pool admits exactly two ranges before any settles");
    assert.equal(maxInFlight, 2);
    gates.shift()!();
    await flush();
    assert.deepEqual(started, ["range one", "range two", "range three"], "the third range starts only after a slot frees");
    assert.equal(maxInFlight, 2, "in-flight never exceeds the pool size");
    while (gates.length > 0) gates.shift()!();
    const result = await pending;
    assert.equal(result.status, "finished");
    assert.deepEqual(result.results.map((range) => range.status === "success" ? range.summary : null), [
        "s:range one", "s:range two", "s:range three",
    ]);
});

test("executor batch: results stay index-aligned when completion order differs from work order", async () => {
    const candidate: SummaryCandidate = { summarize: (request) => request.content === "range one"
        ? new Promise<string>((resolve) => setTimeout(() => resolve(`s:${request.content}`), 30))
        : Promise.resolve(`s:${request.content}`) };
    const result = await new ExternalSummaryExecutor(2).executeBatch(work, [candidate], budget);
    assert.equal(result.status, "finished");
    assert.deepEqual(result.results.map((range) => range.status === "success" ? range.summary : null),
        work.map((range) => `s:${range.content}`), "results[i] reports work[i] regardless of who finished first");
});

test("executor batch: caller cancellation stops unstarted ranges and keeps the dense prefix aligned", async () => {
    const controller = new AbortController();
    // Both admitted ranges stay in flight (signal-ignoring, resolve at 50ms)
    // until the abort lands at 20ms — so no worker is idle to claim the third
    // index before the stop latch trips. Their late successes must be rejected.
    let dispatches = 0;
    const candidate: SummaryCandidate = { summarize: () => new Promise<string>((resolve) => {
        dispatches += 1;
        if (dispatches === 1) setTimeout(() => controller.abort(), 20);
        setTimeout(() => resolve("late"), 50);
    }) };
    const result = await new ExternalSummaryExecutor(2).executeBatch(work, [candidate], budget, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.equal(result.results.length, 2, "dense prefix: only the two ranges in flight at abort time are reported");
    for (const range of result.results) assert.notEqual(range.status, "success", "late successes after the abort are rejected");
    // The stop latch must have prevented the third range from ever starting:
    // give the event loop a full turn past the abort and count real dispatches.
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(dispatches, 2, `exactly the two pool slots dispatched, never the third range (got ${dispatches})`);
});

test("executor batch: one range hitting the shared deadline stops unstarted ranges", async (t) => {
    let elapsed = 0;
    t.mock.method(performance, "now", () => elapsed);
    let calls = 0;
    const candidate: SummaryCandidate = { summarize: (request) => {
        calls += 1;
        if (calls === 1) {
            elapsed = 80;
            return Promise.resolve("slow ok");
        }
        elapsed = 150;
        return Promise.resolve("too late");
    } };
    const result = await new ExternalSummaryExecutor(1).executeBatch(work, [candidate], { ...budget, totalTimeoutMs: 100 });
    assert.equal(result.status, "deadline");
    assert.deepEqual(result.results.map((range) => range.status), ["success", "deadline"]);
    assert.equal(calls, 2, "the third range never dispatched once the shared deadline passed");
});
