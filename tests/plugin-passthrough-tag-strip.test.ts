import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginResponsesWithStrip, pipeThroughWithUsage } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

function makeSession(): Session {
    return {
        id: "testsess",
        protocol: "responses",
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

function sse(ev: Record<string, unknown>): string {
    return `event: ${String(ev.type)}\ndata: ${JSON.stringify(ev)}\n\n`;
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

const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

test("plugin passthrough strips render tags from output_text.delta (single event)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } }),
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `leading ${TAG_OPEN}m00042${TAG_CLOSE} trailing` }),
        sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: "done" }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 5 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "render tag content must not pass through");
    assert.ok(text.includes("leading  trailing"), "non-tag prose survives");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 100, "usage still sampled from completed event");
});

test("plugin passthrough strips tags split across deltas and flushes tail before done", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `ok ${TAG_OPEN}m0` }),
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: `0042${TAG_CLOSE} tail` }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 3 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "split tag fully swallowed");
    assert.ok(text.includes("ok "), "first delta prose passes");
    assert.ok(text.includes("tail"), "post-tag tail flushed before completed");
    const blocks = text.split("\n\n").filter((b) => b.trim().length > 0);
    const flushIdx = blocks.findIndex((b) => b.includes("tail"));
    const completedIdx = blocks.findIndex((b) => b.includes("response.completed"));
    assert.ok(flushIdx !== -1 && completedIdx !== -1 && flushIdx < completedIdx, "flushed tail delta must precede the done-family event that triggered it");
    assert.ok((blocks[flushIdx] ?? "").includes("msg_1"), "flushed tail delta carries item_id");
});

test("plugin passthrough keeps function_call and non-tag events byte-identical", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const fc = sse({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", name: "compress", call_id: "call_1", arguments: "{\"content\":[]}" } });
    const plain = sse({ type: "response.output_text.delta", item_id: "msg_2", output_index: 0, delta: "plain text no tags" });
    const events = [fc, plain, sse({ type: "response.completed", response: { usage: { input_tokens: 1 } } })];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(text.includes(fc.trim()), "function_call event untouched");
    assert.ok(text.includes(plain.trim()), "clean delta untouched");
});

test("plugin passthrough strips tags from done-family full-text payloads", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "clean" }),
        sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: `clean ${TAG_OPEN}m00001${TAG_CLOSE}` }),
        sse({ type: "response.completed", response: {} }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(!text.includes("m00001"), "done payload stripped");
    assert.ok(text.includes("clean "), "done payload prose survives");
});

test("plugin passthrough preserves SSE framing for tag-free done-family events (no data lines fused)", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const done = sse({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, text: "done text no tags" });
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "hello" }),
        done,
        sse({ type: "response.output_item.added", output_index: 2, item: { type: "function_call", name: "read", call_id: "c2", arguments: "{}" } }),
        sse({ type: "response.completed", response: { usage: { input_tokens: 9 } } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
    assert.equal(dataLines.length, 4, "event count preserved");
    for (const l of dataLines) {
        let parsed: unknown;
        assert.doesNotThrow(() => {
            parsed = JSON.parse(l.slice(5).trim());
        }, `every data line must stay valid JSON: ${l.slice(0, 120)}`);
        assert.ok(parsed);
    }
    assert.ok(text.includes(done.trim()), "tag-free done event byte-identical");
    assert.ok(text.endsWith("\n\n"), "stream keeps event framing to the end");
});

test("plugin passthrough resolves held tail at stream end without a done-family event", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_9", output_index: 0, delta: `prose ${TAG_OPEN}m0` }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    assert.ok(text.includes("prose "), "clean prefix passes");
    assert.ok(!text.includes("m0"), "content of an unclosed tag is dropped at stream end, not flushed as junk");

    const out2: string[] = [];
    const res2 = makeRes(out2);
    const events2 = [
        sse({ type: "response.output_text.delta", item_id: "msg_9", output_index: 0, delta: `prose \x3cac` }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events2), res2, session);
    const text2 = out2.join("");
    assert.ok(text2.includes(`"delta":"prose \x3cac"`), "ambiguous prefix passes through untouched at stream end");
});

test("plugin passthrough rebuildEvent collapses multi-line data payloads into one line", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const escOpen = TAG_OPEN.replace(/"/g, '\\"');
    const payload = `{ "type": "response.output_text.done",\n"item_id": "msg_1", "text": "done ${escOpen}m00001${TAG_CLOSE}" }`;
    const raw = `event: response.output_text.done\ndata: ${payload.split("\n")[0]}\ndata: ${payload.split("\n")[1]}\n\n`;
    const events = [
        sse({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "x" }),
        raw,
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, session);
    const text = out.join("");
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
    for (const l of dataLines) {
        assert.doesNotThrow(() => JSON.parse(l.slice(5).trim()), `single-line data stays parseable: ${l.slice(0, 100)}`);
    }
    assert.ok(!text.includes("m00001"), "multi-line done payload still stripped");
});

test("plugin JSON passthrough strips render tags for responses protocol", async () => {
    const { pipePluginJson } = await import("../src/plugin.ts");
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const body = JSON.stringify({ output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: `hi ${TAG_OPEN}m00003${TAG_CLOSE}` }] }], usage: { input_tokens: 4 } });
    const stream = streamOf([body]);
    await pipePluginJson(stream, res as unknown as import("node:http").ServerResponse, session, "responses");
    const text = out.join("");
    const parsed = JSON.parse(text) as { output: Array<{ content: Array<{ text: string }> }> };
    assert.ok(!text.includes("m00003"), "tag stripped from non-streaming responses body");
    assert.equal(parsed.output[0]?.content[0]?.text, "hi ", "prose survives");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 4, "usage still sampled");
});

test("plugin JSON passthrough strips render tags for openai protocol (#457)", async () => {
    const { pipePluginJson } = await import("../src/plugin.ts");
    {
        const out: string[] = [];
        const res = makeRes(out);
        const session = makeSession();
        const body = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: `x ${TAG_OPEN}m00005${TAG_CLOSE}` }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
        await pipePluginJson(streamOf([body]), res as unknown as import("node:http").ServerResponse, session, "openai");
        const text = out.join("");
        assert.ok(!text.includes("m00005"), "tag stripped from non-streaming openai body");
        const parsed = JSON.parse(text) as { choices: Array<{ message: { role: string; content: string }; finish_reason: string }> };
        assert.equal(parsed.choices[0]?.message.content, "x ", "prose survives");
        assert.equal(parsed.choices[0]?.message.role, "assistant", "structural fields untouched");
        assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 2, "usage still sampled");
    }
    {
        const out: string[] = [];
        const res = makeRes(out);
        const session = makeSession();
        const tcBody = JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "compress", arguments: "{\"content\":[]}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3 } });
        await pipePluginJson(streamOf([tcBody]), res as unknown as import("node:http").ServerResponse, session, "openai");
        assert.equal(out.join(""), tcBody, "tag-free tool_calls body byte-identical");
    }
});

test("plugin JSON passthrough strips render tags for anthropic protocol (#457)", async () => {
    const { pipePluginJson } = await import("../src/plugin.ts");
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const toolUse = { type: "tool_use", id: "tu_1", name: "compress", input: { content: [] } };
    const body = JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "test", stop_reason: "end_turn", content: [{ type: "text", text: `hey ${TAG_OPEN}m00007${TAG_CLOSE}` }, toolUse], usage: { input_tokens: 8, output_tokens: 2 } });
    await pipePluginJson(streamOf([body]), res as unknown as import("node:http").ServerResponse, session, "anthropic");
    const text = out.join("");
    assert.ok(!text.includes("m00007"), "tag stripped from non-streaming anthropic body");
    const parsed = JSON.parse(text) as { content: Array<{ type: string; text?: string }> };
    assert.equal(parsed.content[0]?.text, "hey ", "prose survives");
    assert.ok(text.includes(JSON.stringify(toolUse)), "tool_use block untouched");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 8, "usage still sampled");
});

test("plugin JSON passthrough stays verbatim for tag-free bodies", async () => {
    const { pipePluginJson } = await import("../src/plugin.ts");
    {
        const out: string[] = [];
        const res = makeRes(out);
        const session = makeSession();
        const body = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: "clean" }] }] });
        await pipePluginJson(streamOf([body]), res as unknown as import("node:http").ServerResponse, session, "responses");
        assert.equal(out.join(""), body, "tag-free responses body byte-identical");
    }
});

test("plugin SSE passthrough strips tags from openai delta.content (#457)", async () => {
    const oai = (o: Record<string, unknown>): string => `data: ${JSON.stringify(o)}\n\n`;
    const roleChunk = oai({ id: "chatcmpl-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] });
    const finishChunk = oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 4 } });
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        roleChunk,
        oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: `hi ${TAG_OPEN}m00042${TAG_CLOSE} there` } }] }),
        finishChunk,
        "data: [DONE]\n\n",
    ];
    await pipeThroughWithUsage(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "render tag swallowed");
    assert.ok(text.includes(`"content":"hi  there"`), "non-tag prose survives in rebuilt delta");
    assert.ok(text.includes(roleChunk.trim()), "role chunk byte-identical");
    assert.ok(text.includes(finishChunk.trim()), "finish chunk byte-identical");
    assert.ok(text.endsWith("data: [DONE]\n\n"), "[DONE] framing preserved");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 30, "usage still sampled");
});

test("plugin SSE passthrough keeps openai tool_calls events byte-identical while stripping prose (#457)", async () => {
    const oai = (o: Record<string, unknown>): string => `data: ${JSON.stringify(o)}\n\n`;
    const tcChunk = oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "compress", arguments: "" } }] } }] });
    const argChunk = oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"content\":[]}" } }] } }] });
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: `note ${TAG_OPEN}m00011${TAG_CLOSE} ok` } }] }),
        tcChunk,
        argChunk,
        oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
    ];
    await pipeThroughWithUsage(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m00011"), "prose tag stripped");
    assert.ok(text.includes(tcChunk.trim()), "tool_call declaration untouched");
    assert.ok(text.includes(argChunk.trim()), "tool_call argument bytes untouched");
});

test("plugin SSE passthrough flushes held openai tail before finish_reason ([DONE] mid-hold)", async () => {
    const oai = (o: Record<string, unknown>): string => `data: ${JSON.stringify(o)}\n\n`;
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: `ok ${TAG_OPEN}m0` } }] }),
        oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: { content: `0042${TAG_CLOSE} tail` } }] }),
        oai({ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
    ];
    await pipeThroughWithUsage(streamOf(events), res, session, "openai");
    const text = out.join("");
    assert.ok(!text.includes("m00042"), "split tag fully swallowed");
    assert.ok(text.includes(`"content":" tail"`), "post-tag tail flushed as synthetic delta");
    const blocks = text.split("\n\n").filter((b) => b.trim().length > 0);
    const flushIdx = blocks.findIndex((b) => b.includes('"content":" tail"'));
    const finishIdx = blocks.findIndex((b) => b.includes("finish_reason"));
    assert.ok(flushIdx !== -1 && finishIdx !== -1 && flushIdx < finishIdx, "flushed tail must precede the terminal event");
    assert.ok(blocks[flushIdx].includes('"id":"chatcmpl-1"'), "synthetic flush chunk carries upstream chunk fields");
});

test("plugin SSE passthrough is byte-identical for tag-free openai streams", async () => {
    const oai = (o: Record<string, unknown>): string => `data: ${JSON.stringify(o)}\n\n`;
    const e1 = oai({ id: "c", choices: [{ index: 0, delta: { content: "hello" } }] });
    const e2 = oai({ id: "c", choices: [{ index: 0, delta: { content: " world" } }] });
    const e3 = oai({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    await pipeThroughWithUsage(streamOf([e1 + e2 + e3 + "data: [DONE]\n\n"]), res, session, "openai");
    assert.equal(out.join(""), e1 + e2 + e3 + "data: [DONE]\n\n", "tag-free stream byte-identical across event boundaries");
});

test("plugin SSE passthrough strips tags from anthropic text_delta (#457)", async () => {
    const ant = (ev: Record<string, unknown>): string => sse(ev);
    const start = ant({ type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 12 } } });
    const mDelta = ant({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } });
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        start,
        ant({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ant({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `yo ${TAG_OPEN}m00009${TAG_CLOSE} end` } }),
        ant({ type: "content_block_stop", index: 0 }),
        mDelta,
        ant({ type: "message_stop" }),
    ];
    await pipeThroughWithUsage(streamOf(events), res, session, "anthropic");
    const text = out.join("");
    assert.ok(!text.includes("m00009"), "render tag swallowed");
    assert.ok(text.includes(`"text":"yo  end"`), "non-tag prose survives in rebuilt delta");
    assert.ok(text.includes(start.trim()), "message_start untouched");
    assert.ok(text.includes(mDelta.trim()), "message_delta untouched");
    assert.equal((session.stats as Record<string, unknown>)["lastInputTokens"], 12, "nested message_start usage sampled");
});

test("plugin SSE passthrough keeps anthropic tool_use input_json_delta byte-identical (#457)", async () => {
    const ant = (ev: Record<string, unknown>): string => sse(ev);
    const jsonDelta = ant({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"content\":[\"a\"]}" } });
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        ant({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ant({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `go ${TAG_OPEN}m00013${TAG_CLOSE}` } }),
        ant({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "compress" } }),
        jsonDelta,
        ant({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }),
        ant({ type: "message_stop" }),
    ];
    await pipeThroughWithUsage(streamOf(events), res, session, "anthropic");
    const text = out.join("");
    assert.ok(!text.includes("m00013"), "prose tag stripped");
    assert.ok(text.includes(jsonDelta.trim()), "input_json_delta bytes untouched");
});

test("plugin SSE passthrough flushes held anthropic tail before message_stop", async () => {
    const ant = (ev: Record<string, unknown>): string => sse(ev);
    const out: string[] = [];
    const res = makeRes(out);
    const session = makeSession();
    const events = [
        ant({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `pre ${TAG_OPEN}m0` } }),
        ant({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `0050${TAG_CLOSE} post` } }),
        ant({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
        ant({ type: "message_stop" }),
    ];
    await pipeThroughWithUsage(streamOf(events), res, session, "anthropic");
    const text = out.join("");
    assert.ok(!text.includes("m00050"), "split tag fully swallowed");
    assert.ok(text.includes(`"text":" post"`), "post-tag tail flushed as synthetic text_delta");
    const blocks = text.split("\n\n").filter((b) => b.trim().length > 0);
    const flushIdx = blocks.findIndex((b) => b.includes('"text":" post"'));
    const stopIdx = blocks.findIndex((b) => b.includes("message_stop"));
    assert.ok(flushIdx !== -1 && stopIdx !== -1 && flushIdx < stopIdx, "flushed tail must precede message_stop");
    assert.ok(blocks[flushIdx].includes('"index":0'), "synthetic flush carries block index");
});
