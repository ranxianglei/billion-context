// #1685: the proxy is the only path model output takes, so it WITNESSES every
// complete bili tool call as it streams out. These tests pin the recording
// side of the witness ring on every plugin-mode response lane (openai/anthropic
///google chat SSE, responses SSE, non-stream JSON): stream a named tool call,
// then assert lookupToolWitness names the session — the input the #1685
// routing ladder in handlePluginTool consumes.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../src/session.ts";
import { pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { lookupToolWitness, resetToolRingForTest } from "../src/tool-ring.ts";

function makeSession(id: string): Session {
    return {
        id,
        protocol: "openai",
        upstreamOrigin: "http://127.0.0.1:9/v1",
        label: "test",
        createdAt: 0,
        lastUsedAt: 0,
        requests: 0,
        lastInputTokens: 0,
        stats: {},
        dirty: false,
    } as unknown as Session;
}

function makeRes(chunks: string[]) {
    return {
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

function streamOf(events: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < events.length) {
                controller.enqueue(enc.encode(events[i]));
                i += 1;
            } else {
                controller.close();
            }
        },
    });
}

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function sse(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const COMPRESS_ARGS = JSON.stringify({ startId: "m00001", endId: "m00009", summary: "witness lane test" });

test("chat pipe openai: fragmented named compress call lands in the witness ring", async () => {
    resetToolRingForTest();
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: '{"startId":"m00001",' } }] }),
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"endId":"m00009","summary":"witness lane test"}' } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes([]), "openai", makeSession("w-oai"));
    assert.deepEqual([...lookupToolWitness("compress", COMPRESS_ARGS)], ["w-oai"]);
});

test("chat pipe anthropic: tool_use partial_json accumulation lands in the witness ring", async () => {
    resetToolRingForTest();
    const events = [
        sse("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant" } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "compress" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"startId":"m00001",' } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"endId":"m00009","summary":"witness lane test"}' } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
        sse("message_stop", { type: "message_stop" }),
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes([]), "anthropic", makeSession("w-ant"));
    assert.deepEqual([...lookupToolWitness("compress", COMPRESS_ARGS)], ["w-ant"]);
});

test("chat pipe google: whole-part functionCall lands in the witness ring", async () => {
    resetToolRingForTest();
    const events = [
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { name: "compress", args: { startId: "m00001", endId: "m00009", summary: "witness lane test" } } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }] })}\n\n`,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes([]), "google", makeSession("w-goo"));
    // google args are an OBJECT on the wire; lookup with the string form must match
    assert.deepEqual([...lookupToolWitness("compress", COMPRESS_ARGS)], ["w-goo"]);
});

test("responses pipe: function_call output item + arguments.done lands in the witness ring", async () => {
    resetToolRingForTest();
    const events = [
        sse("response.created", { type: "response.created", response: { id: "resp_1" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", name: "compress", arguments: "" } }),
        sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"startId":"m00001",' }),
        sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: COMPRESS_ARGS }),
        sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", name: "compress", arguments: COMPRESS_ARGS } }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", usage: {} } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), makeRes([]), makeSession("w-res"));
    assert.deepEqual([...lookupToolWitness("compress", COMPRESS_ARGS)], ["w-res"]);
});

test("json pipe: non-stream tool_calls land in the witness ring", async () => {
    resetToolRingForTest();
    const body = JSON.stringify({
        id: "chatcmpl-x", object: "chat.completion", created: 1, model: "qwen",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "compress", arguments: COMPRESS_ARGS } }] }, finish_reason: "tool_calls" }],
    });
    await pipePluginJson(streamOf([body]), makeRes([]), makeSession("w-json"), "openai");
    assert.deepEqual([...lookupToolWitness("compress", COMPRESS_ARGS)], ["w-json"]);
});

test("nameless tool call never becomes a witness (#1484 class)", async () => {
    resetToolRingForTest();
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "", arguments: COMPRESS_ARGS } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes([]), "openai", makeSession("w-noname"));
    assert.equal(lookupToolWitness("compress", COMPRESS_ARGS).size, 0);
    assert.equal(lookupToolWitness("", COMPRESS_ARGS).size, 0);
});

test("witness survives a legacy conversation_id echo in the args (#760 parity)", async () => {
    resetToolRingForTest();
    const withEcho = `{"conversation_id":"pfa-stale","startId":"m00001","endId":"m00009","summary":"witness lane test"}`;
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: withEcho } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes([]), "openai", makeSession("w-echo"));
    assert.deepEqual([...lookupToolWitness("compress", COMPRESS_ARGS)], ["w-echo"], "echoed id never forks the witness key");
});
