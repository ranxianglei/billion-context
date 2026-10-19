import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { ExternalSummaryExecutor, type SummaryCandidate, type SummaryWork } from "../src/external-summary.ts";
import { createSummaryHttpCandidate, _setSummaryRetryDelayForTest, type SummaryHttpTarget } from "../src/external-summary-http.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";
import { composeExternalFailureMessage } from "../src/external-summary-compress.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.ts";
import { renderLaneNudgeText } from "../src/nudge-decide.ts";
import { defaultPrompts, type NudgeDecision } from "acp-kernel";
import {
    ExternalSummaryError,
    classifyError,
    externalFailureClasses,
    externalFailureLatchActive,
    externalFailureStreak,
    externalSummaryFingerprint,
    recordExternalBatchOutcome,
    renderExternalFailureNotice,
} from "../src/external-summary-failures.ts";

process.env.NODE_ENV = "test";
const budget = { totalTimeoutMs: 4000, targetTimeoutMs: 1500, maxSummaryBytes: 2048 };
const summary = "Retained decisions, evidence and unfinished objectives.";

afterEach(() => assert.equal(_liveUpstreamTimersForTest(), 0));

async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>) => void, run: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            handler(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        })().catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try { await run(`http://127.0.0.1:${address.port}`); }
    finally {
        await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
}

function target(url: string): SummaryHttpTarget {
    return { url, protocol: "responses", model: "external-test-model", headers: { authorization: "Bearer test-summary-key" } };
}

test("#3638 reference parts are fitted to the candidate window before sending (drop-oldest)", async () => {
    let captured: Record<string, unknown> | undefined;
    let requests = 0;
    const others = Array.from({ length: 30 }, (_, i) => ({ topic: `t${i}`, summary: `summary-${i}-${"x".repeat(294)}` }));
    const context = Array.from({ length: 10 }, (_, i) => ({ role: "user", text: `ctx-${i}-${"y".repeat(94)}` }));
    const work: SummaryWork = {
        content: "Tiny selected range.",
        instructions: "Summarize the selected range.",
        referenceParts: { submittedSummaryHint: "hint", currentContext: context, otherSummaries: others },
    };
    await upstream((req, res, body) => {
        requests += 1;
        captured = body;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "completed", output_text: summary }));
    }, async (url) => {
        // Window too small for the full 30+10 reference but room for a trimmed one.
        const candidate = createSummaryHttpCandidate({ ...target(url), name: "sm", contextWindow: 1500, outputTokens: 400 }, 4096);
        const result = await new ExternalSummaryExecutor(1).execute(work, [candidate], budget);
        assert.equal(result.status, "success");
    });
    assert.equal(requests, 1);
    assert.ok(captured);
    const wire = JSON.stringify(captured);
    assert.ok(wire.includes("Tiny selected range."));
    const input = String(captured.input ?? "");
    const kept = (input.match(/summary-\d+-/g) ?? []).length;
    assert.ok(kept < 30, `expected trimming, kept ${kept}/30 summaries`);
    if (kept > 0) assert.ok(input.includes("summary-29-"), "newest summary must survive drop-oldest");
    assert.ok(!input.includes("summary-0-") || kept === 0, "oldest summaries drop first");
});

test("#3638 hard overflow dispatches nothing and classifies input_budget_overflow", async () => {
    let requests = 0;
    const work: SummaryWork = { content: "z".repeat(8000), instructions: "Summarize.", referenceParts: { otherSummaries: [] } };
    await upstream(() => { requests += 1; }, async (url) => {
        const candidate = createSummaryHttpCandidate({ ...target(url), name: "sm", contextWindow: 400, outputTokens: 100 }, 4096);
        const result = await new ExternalSummaryExecutor(1).execute(work, [candidate], budget);
        assert.equal(result.status, "failed");
        if (result.status === "failed") {
            assert.equal(result.reason, "exhausted");
            assert.equal(result.attempts[0]?.failure?.cls, "input_budget_overflow");
            assert.match(result.attempts[0]?.failure?.detail ?? "", /exceeds target window 400/);
        }
    });
    assert.equal(requests, 0, "nothing may be sent when the payload cannot fit even empty");
});

test("#3638 provider rejection is classified with the HTTP status only (no body)", async () => {
    // Zero the retry backoff via the #3488 seam: with real sleeps the three
    // attempts consume most of totalTimeoutMs and slow machines classify the
    // last attempt as a deadline timeout instead of the rejection.
    _setSummaryRetryDelayForTest(0);
    try {
        await upstream((req, res) => {
            res.setHeader("content-type", "text/plain");
            res.statusCode = 429;
            res.end("rate limited — bearer super-secret-key echoed by upstream");
        }, async (url) => {
            const candidate = createSummaryHttpCandidate(target(url), 4096);
            const result = await new ExternalSummaryExecutor(1).execute({ content: "c", instructions: "i" }, [candidate], budget);
            assert.equal(result.status, "failed");
            if (result.status === "failed") {
                assert.equal(result.attempts[0]?.outcome, "error");
                assert.equal(result.attempts[0]?.failure?.cls, "provider_rejected");
                assert.equal(result.attempts[0]?.failure?.detail, "HTTP 429");
            }
        });
    } finally {
        _setSummaryRetryDelayForTest(null);
    }
});

test("#3638 composed failure message distinguishes per-candidate classes and stays bounded", async () => {
    const slow: SummaryCandidate = { summarize: () => new Promise<string>(() => {}) };
    const rejected: SummaryCandidate = { summarize: () => Promise.reject(new ExternalSummaryError({ cls: "provider_rejected", detail: "HTTP 503" })) };
    const batch = await new ExternalSummaryExecutor(1).executeBatch(
        [{ content: "c", instructions: "i" }],
        [rejected, slow],
        { totalTimeoutMs: 300, targetTimeoutMs: 200, maxSummaryBytes: 2048 },
    );
    const message = composeExternalFailureMessage(batch, [
        { name: "alpha", protocol: "responses", model: "m-a" },
        { name: "beta", protocol: "openai", model: "m-b" },
    ]);
    assert.match(message, /Compression FAILED/);
    assert.match(message, /alpha \(responses\/m-a\): provider_rejected — HTTP 503/);
    assert.match(message, /beta \(openai\/m-b\): timeout/);
    assert.match(message, /compress\.externalSummary\.enabled=false/);
    assert.ok(message.length <= 901, `message must stay bounded, got ${message.length}`);
});

test("#3638 failure latch arms after consecutive all-failed batches and clears on success", () => {
    const settings = {
        enabled: true,
        targets: [{ name: "sm", protocol: "responses", url: "https://api.example/v1/chat/completions", model: "m", apiKey: "super-secret-key-value", contextWindow: 1000, outputTokens: 100 }],
        budget: { totalTimeoutMs: 50000, targetTimeoutMs: 25000, maxSummaryBytes: 65536 },
    };
    const fingerprint = externalSummaryFingerprint(settings);
    assert.ok(typeof fingerprint === "string" && fingerprint !== "off");
    assert.ok(!fingerprint.includes("super-secret-key-value"), "credential values must never enter the fingerprint");
    const metadata: Record<string, unknown> = {};
    assert.equal(externalFailureLatchActive(metadata, fingerprint), false);
    recordExternalBatchOutcome(metadata, { successes: 0, total: 1, classes: ["provider_rejected"], fingerprint, dispatched: true });
    assert.equal(externalFailureLatchActive(metadata, fingerprint), false, "one failure does not arm the latch");
    recordExternalBatchOutcome(metadata, { successes: 0, total: 1, classes: ["provider_rejected", "timeout"], fingerprint, dispatched: true });
    assert.equal(externalFailureStreak(metadata), 2);
    assert.equal(externalFailureLatchActive(metadata, fingerprint), true);
    recordExternalBatchOutcome(metadata, { successes: 0, total: 1, classes: [], fingerprint, dispatched: false });
    assert.equal(externalFailureStreak(metadata), 2, "congestion (no dispatch) neither arms nor clears");
    const notice = renderExternalFailureNotice(2, externalFailureClasses(metadata), externalFailureStreak(metadata));
    assert.match(notice, /EXTERNAL SUMMARY UNAVAILABLE/);
    assert.ok(!notice.includes("Target tier-1 blocks"), "the standing notice must not re-inject the block catalog");
    recordExternalBatchOutcome(metadata, { successes: 1, total: 1, classes: [], fingerprint, dispatched: true });
    assert.equal(externalFailureLatchActive(metadata, fingerprint), false, "a successful fold disarms the latch");
    recordExternalBatchOutcome(metadata, { successes: 0, total: 1, classes: ["timeout"], fingerprint, dispatched: true });
    recordExternalBatchOutcome(metadata, { successes: 0, total: 1, classes: ["timeout"], fingerprint, dispatched: true });
    assert.equal(externalFailureLatchActive(metadata, fingerprint), true, "re-arms after a clear");
    const changed = externalSummaryFingerprint({ ...settings, targets: [{ ...settings.targets[0] as object, model: "m2" }] as never });
    recordExternalBatchOutcome(metadata, { successes: 0, total: 1, classes: ["timeout"], fingerprint: changed, dispatched: true });
    assert.equal(externalFailureStreak(metadata), 1, "a config change resets the streak");
    assert.equal(externalFailureLatchActive(metadata, fingerprint), false);
});

test("#3638 lane seam: renderLaneNudgeText swaps the tier>=2 catalog for the standing notice", () => {
    // Windows deliberately omitted: parseExternalSummarySettings fills them, so
    // this fixture is exactly the case where fingerprinting parsed settings vs
    // the raw rail chain would disagree and silently dead the latch.
    const chain = {
        enabled: true,
        targets: [{ name: "sm", protocol: "responses", url: "https://api.example/v1/chat/completions", model: "m", apiKey: "super-secret-key-value" }],
        budget: { totalTimeoutMs: 50000, targetTimeoutMs: 25000, maxSummaryBytes: 65536 },
    };
    const config = { externalSummary: chain }; // full request-Config shape, not the bare chain
    assert.equal(new ConfiguredSummaryPlan(chain).fingerprint, externalSummaryFingerprint(chain), "plan fingerprints the raw rail chain");

    function decision(tier: number | null): NudgeDecision {
        return {
            shouldInject: true,
            reason: "test",
            compressibleRanges: [{ startRef: "m00001", endRef: "m00042", tokens: 1000 }],
            contextUsage: 0.99,
            tier,
            breakdown: { emergencyOverride: 1 },
        } as NudgeDecision;
    }
    const metadata: Record<string, unknown> = {};
    const recordFailure = () => recordExternalBatchOutcome(metadata, { successes: 0, total: 1, classes: ["provider_rejected"], fingerprint: externalSummaryFingerprint(chain), dispatched: true });

    recordFailure();
    const once = renderLaneNudgeText(decision(2), defaultPrompts, undefined, metadata, config);
    assert.ok(!once.text.includes("EXTERNAL SUMMARY UNAVAILABLE"), "one failed batch does not arm the latch");
    assert.match(once.text, /TIER 2 DISTILLATION/, "unswapped tier-2 nudge keeps the full catalog");

    recordFailure();
    const swapped = renderLaneNudgeText(decision(2), defaultPrompts, undefined, metadata, config);
    assert.equal(swapped.voice, "gentle");
    assert.match(swapped.text, /EXTERNAL SUMMARY UNAVAILABLE — TIER 2 DISTILLATION PAUSED/);
    assert.ok(!swapped.text.includes("TIER 2 DISTILLATION TRIGGER"), "the standing notice must not re-inject the block catalog");
    assert.match(swapped.text, /provider_rejected/);

    assert.match(renderLaneNudgeText(decision(3), defaultPrompts, undefined, metadata, config).text, /TIER 3 CONDENSATION PAUSED/);

    // Negative rows: tier-1 untouched; mode disabled untouched even with the latch armed.
    assert.ok(!renderLaneNudgeText(decision(1), defaultPrompts, undefined, metadata, config).text.includes("EXTERNAL SUMMARY UNAVAILABLE"));
    const offConfig = { externalSummary: { ...chain, enabled: false } };
    assert.ok(!renderLaneNudgeText(decision(2), defaultPrompts, undefined, metadata, offConfig).text.includes("EXTERNAL SUMMARY UNAVAILABLE"));
});

test("#3638 classifyError maps legacy messages, transport codes and typed errors", () => {
    assert.equal(classifyError(new Error("External summary candidate unavailable")).cls, "candidate_unavailable");
    assert.equal(classifyError(new Error("External summary input exceeds the target context budget")).cls, "input_budget_overflow");
    assert.equal(classifyError(new Error("External summary upstream rejected the request")).cls, "provider_rejected");
    assert.equal(classifyError(new Error("External summary response exceeds its byte budget")).cls, "output_budget_overflow");
    assert.equal(classifyError(new Error("External summary response contains no summary")).cls, "invalid_output");
    const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) });
    const network = classifyError(refused);
    assert.equal(network.cls, "network_error");
    assert.match(network.detail ?? "", /connection refused/);
    const unknown = classifyError(new Error("boom https://secret.example/key"));
    assert.equal(unknown.cls, "unknown_error");
    assert.equal(unknown.detail, undefined, "raw provider text must never enter the result");
    const typed = new ExternalSummaryError({ cls: "timeout", detail: "target deadline" });
    assert.equal(classifyError(typed).cls, "timeout");
    assert.equal(classifyError(typed).detail, "target deadline");
});

test("#3638 timeout attempts carry the classified timeout failure", async () => {
    const slow: SummaryCandidate = { summarize: () => new Promise<string>((resolve) => { setTimeout(() => resolve(summary), 1000); }) };
    const result = await new ExternalSummaryExecutor(1).execute({ content: "c", instructions: "i" }, [slow], { totalTimeoutMs: 3000, targetTimeoutMs: 100, maxSummaryBytes: 2048 });
    assert.equal(result.status, "failed");
    if (result.status === "failed") {
        assert.equal(result.attempts[0]?.outcome, "timeout");
        assert.equal(result.attempts[0]?.failure?.cls, "timeout");
    }
});
