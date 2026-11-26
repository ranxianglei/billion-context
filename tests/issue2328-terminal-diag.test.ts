import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerResponse } from "node:http";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";

function makeRes(writes: string[]): ServerResponse {
    return {
        write(chunk: Buffer | string) {
            writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
            return true;
        },
        end(chunk?: Buffer | string) {
            if (chunk !== undefined) writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as ServerResponse;
}

function streamOf(events: string[], failure?: Error): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (index < events.length) controller.enqueue(encoder.encode(events[index++]!));
            else if (failure) controller.error(failure);
            else controller.close();
        },
    });
}

function truncationErrorFrame(writes: string[]): Record<string, unknown> {
    for (const frame of writes.join("").split("\n\n")) {
        const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data: "));
        const data = dataLine?.slice("data: ".length);
        if (!data || data === "[DONE]") continue;
        try {
            const event = JSON.parse(data) as Record<string, unknown>;
            const error = event["error"] as Record<string, unknown> | undefined;
            const nestedError = error?.["error"] as Record<string, unknown> | undefined;
            if (event["code"] === "upstream_stream_truncated" || error?.["code"] === "upstream_stream_truncated" || error?.["status"] === "UNAVAILABLE" || nestedError?.["code"] === "upstream_stream_truncated") return event;
        } catch {
            continue;
        }
    }
    throw new Error("Expected an upstream truncation SSE frame");
}

function diagFromLogs(logs: string[]): Record<string, unknown> {
    const line = logs.find((entry) => entry.includes("upstream stream truncated"));
    const serialized = line?.match(/; diag=(\{.*\})\]$/)?.[1];
    if (!serialized) throw new Error("Expected truncation diagnostics in local logs");
    return JSON.parse(serialized) as Record<string, unknown>;
}

const openaiChunk = (text: string) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;

test("OpenAI truncation keeps transport causes and trace IDs in local logs only", async () => {
    const writes: string[] = [];
    const logs: string[] = [];
    const socketError = Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" });
    const failure = new TypeError("terminated", { cause: socketError });

    await pipePluginChatWithStrip(
        streamOf([openaiChunk("partial")], failure),
        makeRes(writes),
        "openai",
        undefined,
        (line) => logs.push(line),
        undefined,
        undefined,
        undefined,
        undefined,
        {
            status: 200,
            contentType: "text/event-stream",
            requestId: "01a1bf31-7f88-7c2c-a1b8-62b2ecd1d3a5",
            opencodeLogId: "log-7f88",
            cfRay: "a57b139e8f1bb5af-LHR",
        },
    );

    const event = truncationErrorFrame(writes);
    const error = event["error"] as Record<string, unknown>;
    assert.equal(error["code"], "upstream_stream_truncated");
    assert.equal(error["meta"], undefined);
    assert.ok(!writes.join("").includes("other side closed"));

    const diag = diagFromLogs(logs);
    assert.deepEqual(diag["readErrorCause"], [{ name: "SocketError", code: "UND_ERR_SOCKET" }]);
    assert.equal(diag["upstreamRequestId"], "01a1bf31-7f88-7c2c-a1b8-62b2ecd1d3a5");
    assert.equal(diag["upstreamLogId"], "log-7f88");
    assert.equal(diag["upstreamCfRay"], "a57b139e8f1bb5af-LHR");
    assert.equal(diag["upstreamStatus"], 200);
    assert.equal(diag["upstreamContentType"], "text/event-stream");
    assert.ok(!JSON.stringify(diag).includes("other side closed"));
});

test("Responses EOF records classification locally and emits no diagnostic metadata", async () => {
    const writes: string[] = [];
    const logs: string[] = [];
    const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

    await pipePluginResponsesWithStrip(
        streamOf([
            sse("response.created", { response: { id: "resp_1" } }),
            sse("response.output_text.delta", { output_index: 0, delta: "hi" }),
        ]),
        makeRes(writes),
        undefined,
        (line) => logs.push(line),
    );

    const event = truncationErrorFrame(writes);
    assert.equal(event["code"], "upstream_stream_truncated");
    assert.equal(event["meta"], undefined);
    const diag = diagFromLogs(logs);
    assert.equal(diag["classification"], "no-terminal-seen");
    assert.equal(diag["cause"], "eof");
});

test("Google truncation retains its protocol error shape without exposing diagnostics", async () => {
    const writes: string[] = [];
    const logs: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }] })}\n\n`]),
        makeRes(writes),
        "google",
        undefined,
        (line) => logs.push(line),
    );

    const event = truncationErrorFrame(writes);
    const error = event["error"] as Record<string, unknown>;
    assert.equal(error["code"], 503);
    assert.equal(error["status"], "UNAVAILABLE");
    assert.equal(error["meta"], undefined);
    assert.equal(diagFromLogs(logs)["classification"], "no-terminal-seen");
});

test("Anthropic truncation keeps provider error shape without client diagnostics", async () => {
    const writes: string[] = [];
    const logs: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n\n`]),
        makeRes(writes),
        "anthropic",
        undefined,
        (line) => logs.push(line),
    );

    const event = truncationErrorFrame(writes);
    const error = event["error"] as Record<string, unknown>;
    assert.equal(error["code"], "upstream_stream_truncated");
    assert.equal(error["meta"], undefined);
    const diag = diagFromLogs(logs);
    assert.equal(diag["protocol"], "anthropic");
    assert.equal(diag["cause"], "eof");
});
