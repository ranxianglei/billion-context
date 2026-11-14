import { test } from "node:test";
import assert from "node:assert/strict";

import { createInitialState } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";

// #4634: an upstream-truncated request is billed by the provider but leaves
// NO usage record in bili — settle only runs when a usage chunk arrives, and a
// truncated stream never delivers one. The prepare-phase local estimate is
// still pending at truncation time; carry it on the truncation diag (log line
// + client-side meta) so one grep shows how much the dead request billed.
// Both directions asserted (#3617): field present when the estimate is
// pending, absent when it is not.

function makeRes(chunks: string[]) {
    return {
        writes: chunks,
        write(b: Buffer | string) {
            chunks.push(typeof b === "string" ? b : b.toString("utf8"));
            return true;
        },
        end(b?: Buffer | string) {
            if (b !== undefined) chunks.push(typeof b === "string" ? b : b.toString("utf8"));
        },
        once() {},
        destroyed: false,
        writableEnded: false,
    } as unknown as import("node:http").ServerResponse;
}

function streamOf(events: string[], then?: "error"): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else if (then === "error") {
                controller.error(new Error("upstream socket reset mid-stream"));
            } else {
                controller.close();
            }
        },
    });
}

function makeSession(metadata: Record<string, unknown>, lastLocalTextEstimate?: number): Session {
    return {
        id: "sess-4634",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0, ...(lastLocalTextEstimate !== undefined ? { lastLocalTextEstimate } : {}) },
        pendingRetrievals: [],
        metadata,
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

const sse = (e: string, d: Record<string, unknown>) => `event: ${e}\ndata: ${JSON.stringify({ type: e, ...d })}\n\n`;
const responsesShape = () => [
    sse("response.created", { response: { id: "resp_1" } }),
    sse("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1" } }),
];
const openaiChunk = (content?: string) => `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: content !== undefined ? { content } : {}, finish_reason: null }] })}\n\n`;

test("chat pipe (openai) + pending estimate: truncation diag carries outboundEstimateTokens (log + wire meta)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([openaiChunk("partial answer")]),
        makeRes(out),
        "openai",
        makeSession({ pluginAgent: "dsh" }, 728000),
        (m) => logs.push(m),
    );
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line, "log line emitted");
    assert.ok(line!.includes('"outboundEstimateTokens":728000'), line);
    // dsh (non-permitlist) gets the in-band frame; the diag rides its meta too
    const wire = out.join("");
    assert.ok(wire.includes("upstream_stream_truncated"), "in-band frame emitted");
    assert.ok(wire.includes('"outboundEstimateTokens":728000'), "meta carries the estimate");
});

test("chat pipe (openai) + no pending estimate: field absent (negative gate)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([openaiChunk("partial answer")]),
        makeRes(out),
        "openai",
        makeSession({ pluginAgent: "dsh" }),
        (m) => logs.push(m),
    );
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line, "log line emitted");
    assert.ok(!line!.includes("outboundEstimateTokens"), "no fabricated estimate: " + line);
    assert.ok(!out.join("").includes("outboundEstimateTokens"), "meta stays clean");
});

test("chat pipe (openai) + read-error cut: estimate carried on the read-error path too", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginChatWithStrip(
        streamOf([openaiChunk("partial answer")], "error"),
        makeRes(out),
        "openai",
        makeSession({ pluginAgent: "dsh" }, 512000),
        (m) => logs.push(m),
    );
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line, "log line emitted");
    assert.ok(line!.includes('cause=read-error'), line);
    assert.ok(line!.includes('"outboundEstimateTokens":512000'), line);
});

test("responses pipe + pending estimate: field present (second buildTruncationDiag covered)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginResponsesWithStrip(
        streamOf(responsesShape()),
        makeRes(out),
        makeSession({ pluginAgent: "dsh" }, 999000),
        (m) => logs.push(m),
    );
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line, "log line emitted");
    assert.ok(line!.includes('"outboundEstimateTokens":999000'), line);
});

test("responses pipe + session-less passthrough: no crash, no field", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    await pipePluginResponsesWithStrip(streamOf(responsesShape()), makeRes(out), undefined, (m) => logs.push(m));
    const line = logs.find((l) => l.includes("upstream stream truncated"));
    assert.ok(line, "log line emitted");
    assert.ok(!line!.includes("outboundEstimateTokens"), line);
});
