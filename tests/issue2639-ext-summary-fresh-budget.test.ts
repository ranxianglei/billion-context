import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import type { NamedProviderRecipe } from "../src/config.js";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.js";
import { expandExternalSummaryChain, parseExternalSummaryChain } from "../src/external-summary-settings.js";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.js";
import type { SummaryWork } from "../src/external-summary.js";

process.env.NODE_ENV = "test";

// #2639 — the plan baked its budget as ONE construction-time wall-clock point and
// capped every summarize() against it (`remaining <= 0 -> { status: "deadline",
// results: [] }`). Preflight reuses one plan across every range/round, so after
// ~totalTimeoutMs of folding the point went stale and every later range returned
// "deadline (no result)" without reaching the summarizer. Each summarize() call is
// an independent batch and must get the FULL configured budget fresh.
const WORK: readonly SummaryWork[] = [{
    content: "Prior evidence and decisions",
    reference: "Read-only current task",
    instructions: "Preserve unfinished objectives",
}];
const SUMMARY_TEXT = "Retained decisions, evidence, constraints and unfinished objectives.";
const BUDGET = { totalTimeoutMs: 2000, targetTimeoutMs: 1000, maxSummaryBytes: 65536 };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("#2639: reusing one plan across summarize() calls gives each fold a fresh budget (no starvation)", async (t) => {
    t.after(() => assert.equal(_liveUpstreamTimersForTest(), 0));
    let requests = 0;
    const server = http.createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            requests += 1;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ status: "completed", output_text: SUMMARY_TEXT }));
        })().catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
        const recipes: Record<string, NamedProviderRecipe & { apiKey?: string }> = {
            mock: { baseUrl: `http://127.0.0.1:${address.port}`, api: "responses", apiKey: "test-summary-key", models: { "mock-model": {} } },
        };
        const settings = expandExternalSummaryChain(
            parseExternalSummaryChain({ enabled: true, targets: ["mock/mock-model"], budget: BUDGET }),
            recipes,
        );
        // ONE plan reused across many calls — exactly how preflight drives it.
        const plan = new ConfiguredSummaryPlan(settings);

        // Round 1: a fold right after construction reaches the summarizer.
        const first = await plan.summarize(WORK);
        assert.equal(first.status, "finished", "the first fold's batch completes");
        assert.equal(first.results[0]?.status, "success", "the first range was summarized");
        assert.equal(requests, 1, "the first fold dispatched");

        // Elapse PAST the whole batch budget while the SAME plan sits idle —
        // the preflight case where earlier rounds consumed wall-clock time.
        await sleep(BUDGET.totalTimeoutMs + 500);

        // Round 2: pre-fix this hit `remaining <= 0` against the stale
        // construction-time deadline and returned { status: "deadline", results:
        // [] } ("no result") WITHOUT dispatching. Post-fix each call gets a fresh
        // full budget, so the range is summarized normally.
        const second = await plan.summarize(WORK);
        assert.notEqual(second.status, "deadline", "a later fold must not be harvested by a stale construction-time deadline (#2639)");
        assert.equal(second.status, "finished", "the later fold's batch completes");
        assert.equal(second.results[0]?.status, "success", "the later range was summarized, not dropped");
        assert.equal(requests, 2, "the later range was dispatched, not harvested by a stale deadline");
    } finally {
        await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
});
