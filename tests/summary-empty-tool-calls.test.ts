import { test } from "node:test";
import assert from "node:assert/strict";
import { createSummaryHttpCandidate } from "../src/external-summary-http.ts";
import { withFetchTransport } from "../src/fetch-transport.ts";
import { _liveUpstreamTimersForTest } from "../src/fetch-util.ts";

const text = "Preserved decisions and unfinished objectives.";
const work = { content: "Evidence to retain", reference: "Current task", instructions: "Keep decisions" };

async function summarize(stream: boolean, calls: unknown, finishReason = "stop"): Promise<string> {
    const choice = stream
        ? { delta: { content: text, tool_calls: calls }, finish_reason: finishReason }
        : { message: { content: text, tool_calls: calls }, finish_reason: finishReason };
    const body = stream ? `data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n` : JSON.stringify({ choices: [choice] });
    const candidate = createSummaryHttpCandidate({
        url: "https://summary.invalid/v1/chat/completions", protocol: "openai", model: "test",
        headers: {}, stream,
    }, 4096);
    return withFetchTransport(async () => new Response(body, {
        headers: { "content-type": stream ? "text/event-stream" : "application/json" },
    }), () => candidate.summarize(work, AbortSignal.timeout(4000)));
}

for (const stream of [false, true]) {
    for (const calls of [undefined, null, []]) test(`completed ${stream ? "SSE" : "JSON"} summaries accept ${JSON.stringify(calls)} tool_calls`, async () => {
        assert.equal(await summarize(stream, calls), text);
        assert.equal(_liveUpstreamTimersForTest(), 0);
    });
    for (const calls of [[{ id: "call_1", type: "function" }], { malformed: true }]) test(`${stream ? "SSE" : "JSON"} summaries still reject nonempty tool requests`, async () => {
        await assert.rejects(() => summarize(stream, calls), /did not complete/);
        assert.equal(_liveUpstreamTimersForTest(), 0);
    });
    test(`${stream ? "SSE" : "JSON"} summaries with empty tool_calls still require a complete finish reason`, async () => {
        await assert.rejects(() => summarize(stream, [], "length"), /did not complete/);
        assert.equal(_liveUpstreamTimersForTest(), 0);
    });
}
