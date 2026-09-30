// #1501 option C: nameless tool calls on the three VERBATIM-forwarding lanes
// must reach the client untouched (#1039) while producing exactly one warn per
// response (#1484 class) so the observed rate settles the drop-vs-keep policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "acp-kernel";
import { createCore } from "acp-kernel";
import type { Session } from "../src/session.ts";
import { pipePluginChatWithStrip } from "../src/plugin.ts";
import { rewriteOpenaiJsonResponse } from "../src/stream-openai.ts";
import { createResponsesAdapter } from "../src/loop/index.ts";
import type { ParsedStreamEvent } from "../src/loop/index.ts";
import { setLogCapture } from "../src/logger.ts";

function makeSession(): Session {
    return {
        id: "testsess",
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

function sseLf(type: string, data: unknown): string {
    return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collectParseEvents(
    adapter: ReturnType<typeof createResponsesAdapter>,
    stream: ReadableStream<Uint8Array>,
    round: number,
): Promise<ParsedStreamEvent[]> {
    const events: ParsedStreamEvent[] = [];
    for await (const ev of adapter.parseStream(stream, round)) events.push(ev);
    return events;
}

test("lane1 plugin openai: nameless tool_call fragments reach client verbatim + exactly one warn (#1501)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        const events = [
            chatChunk({ role: "assistant" }),
            chatChunk({ tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { arguments: '{"a":' } }] }),
            chatChunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession());
    } finally {
        setLogCapture(null);
    }
    const text = out.join("");
    assert.ok(text.includes("call_abc"), "upstream call-id bytes reach the client untouched");
    assert.ok(text.includes('\\"a\\":'), "first argument fragment passes through verbatim (JSON-escaped on the wire)");
    assert.ok(text.includes("1}"), "second argument fragment passes through verbatim");
    const namelessWarns = warns.filter((m) => m.includes("nameless tool call"));
    assert.equal(namelessWarns.length, 1, "exactly one warn per response");
    const w = namelessWarns[0];
    assert.ok(w.includes("[testsess]"), "warn carries the session id");
    assert.ok(w.includes("openai"), "warn carries the protocol");
    assert.ok(w.includes("idx=0"), "warn carries the tool-call index");
    assert.ok(w.includes("id=call_abc"), "warn carries the call id");
    assert.ok(w.includes("argsLen=7"), "warn carries the argument byte count");
});

test("lane1 plugin openai: NAMED tool calls produce no nameless warn (#1501 negative control)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        const events = [
            chatChunk({ role: "assistant" }),
            chatChunk({ tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "get_weather", arguments: '{"c":' } }] }),
            chatChunk({ tool_calls: [{ index: 0, function: { arguments: "1}" } }] }),
            chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession());
    } finally {
        setLogCapture(null);
    }
    assert.ok(out.join("").includes("get_weather"), "named call passes through verbatim");
    assert.equal(warns.filter((m) => m.includes("nameless tool call")).length, 0, "no warn for well-formed traffic");
});

test("lane1 plugin anthropic: nameless tool_use start block reaches client verbatim + exactly one warn (#1501)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        const events = [
            sseLf("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant" } }),
            sseLf("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1" } }),
            sseLf("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"x":1}' } }),
            sseLf("content_block_stop", { type: "content_block_stop", index: 0 }),
            sseLf("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
            sseLf("message_stop", { type: "message_stop" }),
        ];
        await pipePluginChatWithStrip(streamOf(events), res, "anthropic", makeSession());
    } finally {
        setLogCapture(null);
    }
    const text = out.join("");
    assert.ok(text.includes("toolu_1"), "upstream block bytes reach the client untouched");
    assert.ok(text.includes('\\"x\\":1}'), "argument bytes pass through verbatim (JSON-escaped on the wire)");
    const namelessWarns = warns.filter((m) => m.includes("nameless tool call"));
    assert.equal(namelessWarns.length, 1, "exactly one warn per response");
    const w = namelessWarns[0];
    assert.ok(w.includes("[testsess]"), "warn carries the session id");
    assert.ok(w.includes("anthropic"), "warn carries the protocol");
    assert.ok(w.includes("block=0"), "warn carries the content-block index");
    assert.ok(w.includes("id=toolu_1"), "warn carries the block id");
    assert.ok(w.includes("argsLen=7"), "warn carries the argument byte count");
});

test("lane1 plugin google: nameless functionCall part reaches client verbatim + exactly one warn (#1501)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const warns: string[] = [];
    setLogCapture((level, msg) => { if (level === "warn") warns.push(msg); });
    try {
        const events = [
            `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: "model", parts: [{ functionCall: { args: { x: 1 } } }] } }] })}\n\n`,
            DONE,
        ];
        await pipePluginChatWithStrip(streamOf(events), res, "google", makeSession());
    } finally {
        setLogCapture(null);
    }
    assert.ok(out.join("").includes("functionCall"), "upstream part reaches the client untouched");
    const namelessWarns = warns.filter((m) => m.includes("nameless tool call"));
    assert.equal(namelessWarns.length, 1, "exactly one warn per response");
    const w = namelessWarns[0];
    assert.ok(w.includes("[testsess]"), "warn carries the session id");
    assert.ok(w.includes("google"), "warn carries the protocol");
    assert.ok(w.includes("candidate=0/part=0"), "warn carries the candidate/part position");
    assert.ok(w.includes("argsLen=7"), "warn carries the argument byte count");
});

test("lane2 non-stream JSON: nameless tool_call kept verbatim + ctx.log warn (#1501)", () => {
    const logs: string[] = [];
    const body = {
        id: "chatcmpl-x", object: "chat.completion", created: 1, model: "gpt",
        choices: [{
            index: 0,
            message: {
                role: "assistant", content: null,
                tool_calls: [
                    { id: "call_1", type: "function", function: { name: "", arguments: "{}" } },
                    { id: "call_2", type: "function", function: { name: "get_weather", arguments: "{}" } },
                ],
            },
            finish_reason: "tool_calls",
        }],
    };
    const out = rewriteOpenaiJsonResponse(structuredClone(body), {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        session: makeSession(),
        log: (m: string) => logs.push(m),
    }) as typeof body;
    const tcs = out.choices[0].message.tool_calls as Array<{ function?: { name?: string } }>;
    assert.equal(tcs.length, 2, "both calls survive — bytes untouched");
    assert.equal(tcs[0].function?.name, "", "nameless call kept verbatim");
    assert.equal(tcs[1].function?.name, "get_weather", "named call untouched");
    const namelessLogs = logs.filter((l) => l.includes("nameless tool call"));
    assert.equal(namelessLogs.length, 1, "exactly one log per response");
    assert.ok(namelessLogs[0].includes("index 0"), "log carries the offending index");
});

test("lane2 non-stream JSON: all-named tool_calls produce no warn (#1501 negative control)", () => {
    const logs: string[] = [];
    const body = {
        id: "chatcmpl-y", object: "chat.completion", created: 1, model: "gpt",
        choices: [{
            index: 0,
            message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
            finish_reason: "tool_calls",
        }],
    };
    rewriteOpenaiJsonResponse(structuredClone(body), {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [],
        session: makeSession(),
        log: (m: string) => logs.push(m),
    });
    assert.equal(logs.filter((l) => l.includes("nameless tool call")).length, 0, "no warn for well-formed traffic");
});

test("lane3 responses adapter: nameless function_call raw-replayed + exactly one diag warn per round (#1501)", async () => {
    const s = sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_n1", call_id: "call_n1", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_n1", output_index: 0, delta: '{"q":"' })
        + sseLf("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: "fc_n1", output_index: 0, arguments: '{"q":"x"}' })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_n1", call_id: "call_n1", arguments: '{"q":"x"}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 1);
    const metas = events.filter((e) => e.kind === "meta");
    assert.ok(metas.some((e) => e.kind === "meta" && e.chunk.toString("utf8").includes("fc_n1")), "raw upstream bytes forwarded to the client");
    const diags = events.filter((e) => e.kind === "diag");
    assert.equal(diags.length, 1, "exactly one diag per round");
    const d = diags[0];
    if (d.kind !== "diag") throw new Error("unreachable: diag expected");
    assert.equal(d.level, "warn");
    assert.ok(d.message.includes("round 1"), "diag carries the round");
    assert.ok(d.message.includes("item=fc_n1"), "diag carries the item id");
    assert.ok(d.message.includes("id=call_n1"), "diag carries the call id");
    assert.ok(d.message.includes("argsLen=9"), "diag carries the final argument byte count");
});

test("lane3 responses adapter: NAMED function_call produces no diag (#1501 negative control)", async () => {
    const s = sseLf("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_ok", call_id: "call_ok", name: "get_weather", arguments: "" } })
        + sseLf("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_ok", output_index: 0, delta: '{"c":1}' })
        + sseLf("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_ok", call_id: "call_ok", name: "get_weather", arguments: '{"c":1}' } })
        + sseLf("response.completed", { type: "response.completed", response: { id: "resp_2", status: "completed", output: [] } });
    const events = await collectParseEvents(createResponsesAdapter(), streamOf([s]), 1);
    assert.equal(events.filter((e) => e.kind === "diag").length, 0, "no diag for well-formed traffic");
});
