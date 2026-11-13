import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { ExternalSummaryExecutor, SummaryAbortError, summaryAbortSource, type SummaryWork } from "../src/external-summary.ts";
import { createSummaryHttpCandidate, type SummaryHttpTarget } from "../src/external-summary-http.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";
import { setLogCapture } from "../src/logger.ts";

// #4833: internal deadline aborts must not be logged as client disconnects.
// Pins the abort provenance end-to-end: executor outcome details, the HTTP
// warn-line label per source, and the safe-diagnostics fields.

process.env.NODE_ENV = "test";
const work: SummaryWork = { content: "Prior evidence and decisions", reference: "Read-only current task", instructions: "Preserve unfinished objectives" };
const budget = { totalTimeoutMs: 5000, targetTimeoutMs: 5000, maxSummaryBytes: 2048 };

afterEach(() => {
    setLogCapture(null);
    assert.equal(_liveUpstreamTimersForTest(), 0);
});

// Never settles; the executor's deadline aborts it first. String-shaped to satisfy SummaryTarget.
async function hang(): Promise<string> {
    await new Promise(() => {});
    return "";
}

test("issue 4833: an expired per-target budget is recorded as target-timeout, not a client abort", async () => {
    let seenSignal: AbortSignal | undefined;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_w, signal) => { seenSignal = signal; return hang(); } }], { ...budget, targetTimeoutMs: 80 });
    assert.equal(result.status, "failed");
    if (result.status !== "failed") throw new Error("unreachable");
    assert.equal(result.reason, "exhausted");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].outcome, "timeout");
    assert.match(result.attempts[0].detail ?? "", /^target-timeout 80ms \(elapsed \d+ms\)$/);
    assert.ok(seenSignal?.aborted === true);
    assert.ok(seenSignal?.reason instanceof SummaryAbortError);
    assert.equal(summaryAbortSource(seenSignal!), "target-timeout");
});

test("issue 4833: an expired total budget is recorded as batch-deadline even when the per-target budget is larger", async () => {
    let seenSignal: AbortSignal | undefined;
    const result = await new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_w, signal) => { seenSignal = signal; return hang(); } }], { ...budget, totalTimeoutMs: 60 });
    assert.equal(result.status, "deadline");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].outcome, "timeout");
    assert.match(result.attempts[0].detail ?? "", /^batch-deadline 60ms \(elapsed \d+ms\)$/);
    assert.equal(summaryAbortSource(seenSignal!), "batch-deadline");
});

test("issue 4833: a caller-side cancellation is recorded as cancelled with its own detail", async () => {
    let seenSignal: AbortSignal | undefined;
    const parent = new AbortController();
    const pending = new ExternalSummaryExecutor(1).execute(work, [{ summarize: async (_w, signal) => { seenSignal = signal; return hang(); } }], budget, parent.signal);
    const timer = setTimeout(() => parent.abort(), 40);
    try {
        const result = await pending;
        assert.equal(result.status, "cancelled");
        assert.equal(result.attempts.length, 1);
        assert.equal(result.attempts[0].outcome, "cancelled");
        assert.equal(result.attempts[0].detail, "caller abort");
        assert.equal(summaryAbortSource(seenSignal!), "cancelled");
    } finally {
        clearTimeout(timer);
    }
});

async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try { await run(`http://127.0.0.1:${address.port}`); }
    finally {
        await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
}

function target(url: string): SummaryHttpTarget {
    return { url, protocol: "anthropic", model: "external-test-model", headers: { authorization: "Bearer test-summary-key" }, stream: false };
}

test("issue 4833: a stalled response past the target budget logs target-timeout with safe diagnostics, never client-abort", async () => {
    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    await upstream((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); }, async (url) => {
        const candidate = createSummaryHttpCandidate(target(url), 4096, { targetTimeoutMs: 200, totalTimeoutMs: 5000 });
        const result = await new ExternalSummaryExecutor(1).execute(work, [candidate], { ...budget, targetTimeoutMs: 200 });
        assert.equal(result.status, "failed");
        if (result.status !== "failed") throw new Error("unreachable");
        assert.match(result.attempts[0].detail ?? "", /^target-timeout 200ms \(elapsed \d+ms\)$/);
    });
    const failed = lines.filter((line) => line.includes("failed before response"));
    assert.equal(failed.length, 1);
    assert.ok(failed[0].includes("(target-timeout;"));
    assert.ok(!failed[0].includes("client-abort"), failed[0]);
    // Ask #2: elapsed time, configured budgets, wire shape and size estimates.
    assert.ok(/elapsed=\d+ms/.test(failed[0]), failed[0]);
    // #4839 review fix: the value must reflect the real ~200ms hang, not a
    // pre-dispatch snapshot frozen near zero (timers never fire early).
    const elapsedMatch = failed[0].match(/elapsed=(\d+)ms/);
    assert.ok(elapsedMatch, failed[0]);
    assert.ok(Number(elapsedMatch[1]) >= 150, failed[0]);
    assert.ok(failed[0].includes("budget target=200ms total=5000ms"), failed[0]);
    assert.ok(failed[0].includes("protocol=anthropic"), failed[0]);
    assert.ok(failed[0].includes("stream=false"), failed[0]);
    assert.ok(/payload≈\d+B/.test(failed[0]), failed[0]);
    assert.ok(/input≈\d+tok/.test(failed[0]), failed[0]);
    // Diagnostics stay leak-free: no conversation content or credential bytes.
    assert.ok(!failed[0].includes(work.content));
    assert.ok(!failed[0].includes("test-summary-key"));
});

test("issue 4833: a caller-side cancellation of a stalled dispatch keeps the client-abort label", async () => {
    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    await upstream((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); }, async (url) => {
        const candidate = createSummaryHttpCandidate(target(url), 4096, { targetTimeoutMs: 5000, totalTimeoutMs: 5000 });
        const parent = new AbortController();
        const timer = setTimeout(() => parent.abort(), 60);
        try {
            const result = await new ExternalSummaryExecutor(1).execute(work, [candidate], budget, parent.signal);
            assert.equal(result.status, "cancelled");
            assert.equal(result.attempts[0]?.detail, "caller abort");
        } finally {
            clearTimeout(timer);
        }
    });
    const failed = lines.filter((line) => line.includes("failed before response"));
    assert.equal(failed.length, 1);
    assert.ok(failed[0].includes("(client-abort;"), failed[0]);
    assert.ok(!failed[0].includes("target-timeout"), failed[0]);
});

test("issue 4833: an unmarked foreign abort keeps the legacy attribution path", async () => {
    const lines: string[] = [];
    setLogCapture((_level, msg) => lines.push(msg));
    await upstream((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); }, async (url) => {
        const candidate = createSummaryHttpCandidate(target(url), 4096);
        const foreign = new AbortController();
        const pending = candidate.summarize(work, foreign.signal);
        const timer = setTimeout(() => foreign.abort(), 60);
        try {
            await assert.rejects(pending);
        } finally {
            clearTimeout(timer);
        }
    });
    const failed = lines.filter((line) => line.includes("failed before response"));
    assert.equal(failed.length, 1);
    assert.ok(failed[0].includes("(client-abort;"), failed[0]);
    assert.ok(!failed[0].includes("target-timeout") && !failed[0].includes("batch-deadline"), failed[0]);
});
