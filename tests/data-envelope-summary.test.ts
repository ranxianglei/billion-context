import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { extractSummaryFromSse, extractSummaryText, unwrapDataEnvelope } from "../src/preflight.ts";
import { extractDecisionText } from "../src/nudge-decide.ts";
import { createSummaryHttpCandidate, type SummaryHttpTarget } from "../src/external-summary-http.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";
import type { PreflightProtocol } from "../src/preflight.ts";

process.env.NODE_ENV = "test";

afterEach(() => assert.equal(_liveUpstreamTimersForTest(), 0));

const summary = "Retained decisions, evidence, constraints and unfinished objectives.";

// Real-world envelope observed on an OpenAI-compatible relay (api.cline.bot,
// 2026-10): the successful chat-completion body arrives as
// { "data": { choices: [...] } } with nothing else at the top level.
function dataWrappedCompletion(text = summary): Record<string, unknown> {
    return { data: { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop", index: 0 }] } };
}

test("unwrapDataEnvelope strips a single data envelope around a chat completion", () => {
    const unwrapped = unwrapDataEnvelope(dataWrappedCompletion());
    assert.ok(Array.isArray(unwrapped.choices));
    assert.equal((unwrapped.choices as Array<Record<string, unknown>>)[0].finish_reason, "stop");
});

test("unwrapDataEnvelope leaves standard bodies, error objects, arrays and non-body data untouched", () => {
    const standard = { choices: [{ message: { content: summary }, finish_reason: "stop" }] };
    assert.equal(unwrapDataEnvelope(standard), standard);
    const errored = { error: { message: "boom" }, data: { choices: [] } };
    assert.equal(unwrapDataEnvelope(errored), errored);
    const array = [{ choices: [] }];
    assert.equal(unwrapDataEnvelope(array as unknown as Record<string, unknown>), array);
    const dataArray = { data: [{ choices: [] }] };
    assert.equal(unwrapDataEnvelope(dataArray), dataArray);
    const foreignData = { data: { unrelated: true }, id: "x" };
    assert.equal(unwrapDataEnvelope(foreignData), foreignData);
});

test("extractSummaryText reads choices through a data envelope", () => {
    assert.equal(extractSummaryText("openai", dataWrappedCompletion()), summary);
    assert.equal(
        extractSummaryText("openai", { choices: [{ message: { content: summary }, finish_reason: "stop" }] }),
        summary,
    );
});

test("extractSummaryText still returns empty for an error body wearing a data envelope", () => {
    const errored = { error: { message: "empty response content" }, data: { choices: [] } };
    assert.equal(extractSummaryText("openai", errored), "");
});

test("extractSummaryFromSse reads delta content through a per-frame data envelope", () => {
    const sse = "data: " + JSON.stringify({ data: { choices: [{ delta: { content: summary }, index: 0 }] } }) + "\n\n";
    assert.equal(extractSummaryFromSse("openai", sse), summary);
    const double = "data: " + JSON.stringify({ data: { data: { choices: [{ delta: { content: summary }, index: 0 }] } } }) + "\n\n";
    assert.equal(extractSummaryFromSse("openai", double), "");
});

test("extractDecisionText reads the model answer through a data envelope and leaves standard bodies untouched", () => {
    const answer = JSON.stringify({ compress: false });
    assert.equal(extractDecisionText("openai", { data: { choices: [{ message: { role: "assistant", content: answer } }] } }), answer);
    assert.equal(extractDecisionText("openai", { choices: [{ message: { role: "assistant", content: answer } }] }), answer);
});

async function withUpstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
    const server = http.createServer((req, res) => {
        void (async () => {
            for await (const _chunk of req) { /* drain */ }
            handler(req, res);
        })().catch(() => { res.writeHead(500); res.end(); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") { server.close(); throw new Error("no port"); }
    try {
        await run(`http://127.0.0.1:${address.port}/v1/chat/completions`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test("createSummaryHttpCandidate accepts a data-enveloped openai completion body", async () => {
    await withUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(dataWrappedCompletion()));
    }, async (url) => {
        const target: SummaryHttpTarget = {
            protocol: "openai" as PreflightProtocol,
            url,
            model: "relay-model",
            headers: { authorization: "Bearer test" },
            stream: false,
            contextWindow: 200000,
            outputTokens: 256,
        };
        const candidate = createSummaryHttpCandidate(target, 65536);
        const result = await candidate.summarize({ content: "c", reference: "r", instructions: "i" }, new AbortController().signal);
        assert.equal(result, summary);
    });
});

test("createSummaryHttpCandidate still rejects an upstream error wrapped in data", async () => {
    await withUpstream((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "empty response content", type: "bad_response_status_code" }, data: { choices: [] } }));
    }, async (url) => {
        const target: SummaryHttpTarget = {
            protocol: "openai" as PreflightProtocol,
            url,
            model: "relay-model",
            headers: { authorization: "Bearer test" },
            stream: false,
            contextWindow: 200000,
            outputTokens: 256,
        };
        const candidate = createSummaryHttpCandidate(target, 65536);
        await assert.rejects(candidate.summarize({ content: "c", reference: "r", instructions: "i" }, new AbortController().signal));
    });
});
