import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginJson, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import type { Session } from "../src/session.ts";

process.env.NODE_ENV = "test";

// Render-tag pieces are assembled from hex escapes so no literal tag sequence
// appears in this file's source.
const LT = "\x3c";
const GT = "\x3e";
const TAG = (id: string) => `${LT}acp tokens="247" type="text"${GT}${id}${LT}/acp${GT}`;
const OPEN_MARK = `${LT}acp `;
const CLOSE_MARK = `${LT}/acp${GT}`;
const LONE_OPEN = `${LT}acp tokens="2" type="text"${GT}`;

function makeSession(): Session {
    return {
        id: "sess1039",
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

function dataLines(text: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const block of text.split("\n\n")) {
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const s = line.slice(5).replace(/^ /, "").trim();
        if (!s || s === "[DONE]") continue;
        try {
            out.push(JSON.parse(s));
        } catch {
            continue;
        }
    }
    return out;
}

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

function asString(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function asObj(v: unknown): Record<string, unknown> {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function openaiToolArgs(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        for (const ch of asArr(ev["choices"]) as Array<Record<string, unknown>>) {
            const d = asObj(ch["delta"]);
            for (const tc of asArr(d["tool_calls"]) as Array<Record<string, unknown>>) {
                out += asString(asObj(tc["function"])["arguments"]);
            }
        }
    }
    return out;
}

function openaiContents(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        for (const ch of asArr(ev["choices"]) as Array<Record<string, unknown>>) {
            out += asString(asObj(ch["delta"])["content"]);
        }
    }
    return out;
}

function anthropicInput(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        if (ev["type"] !== "content_block_delta") continue;
        const d = asObj(ev["delta"]);
        if (d["type"] === "input_json_delta") out += asString(d["partial_json"]);
    }
    return out;
}

function anthropicText(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        if (ev["type"] !== "content_block_delta") continue;
        const d = asObj(ev["delta"]);
        if (d["type"] === "text_delta") out += asString(d["text"]);
    }
    return out;
}

function responsesArgs(events: Record<string, unknown>[]): string {
    let out = "";
    for (const ev of events) {
        if (ev["type"] === "response.function_call_arguments.delta") out += asString(ev["delta"]);
    }
    return out;
}

test("#1039 openai chat: render tag echoed into tool_calls function.arguments passes through verbatim", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const tag = TAG("m00042");
    const fullArgs = JSON.stringify({ note: `see ${tag} "x"` });
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ content: `Sure ${TAG("m00055")} checking ` }),
        chatChunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "get_report", arguments: fullArgs.slice(0, 20) } }] }),
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: fullArgs.slice(20, 50) } }] }),
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: fullArgs.slice(50) } }] }),
        chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
    ];
    await pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession());
    const parsed = dataLines(out.join(""));
    assert.equal(openaiToolArgs(parsed), fullArgs, "arguments must be byte-identical to upstream (tag included)");
    assert.ok(JSON.parse(openaiToolArgs(parsed)).note.includes(tag), "tag survives into the host");
    const prose = openaiContents(parsed);
    assert.equal(prose, "Sure  checking ", "prose still stripped of its echoed tag");
    assert.ok(!prose.includes(OPEN_MARK), "prose leaked an open tag");
    assert.ok(!prose.includes(CLOSE_MARK), "prose leaked a close tag");
});

test("#1039 openai chat: unclosed render tag inside arguments keeps the payload parseable", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const fullArgs = JSON.stringify({ cmd: `echo ${LONE_OPEN}AFTER_A` });
    const fragLen = 9;
    const events: string[] = [chatChunk({ role: "assistant" })];
    for (let i = 0; i < fullArgs.length; i += fragLen) {
        events.push(chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: fullArgs.slice(i, i + fragLen) } }] }));
    }
    events.push(chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n");
    await pipePluginChatWithStrip(streamOf(events), res, "openai", makeSession());
    const args = openaiToolArgs(dataLines(out.join("")));
    assert.equal(args, fullArgs, "verbatim passthrough preserves the unclosed-tag payload byte-for-byte");
    assert.deepEqual(JSON.parse(args), { cmd: `echo ${LONE_OPEN}AFTER_A` }, "host JSON.parse succeeds on the untouched payload");
});

test("#1039 anthropic: render tag echoed into input_json_delta passes through verbatim", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const tag = TAG("m00007");
    const fullJson = JSON.stringify({ q: `ref ${tag}` });
    const events = [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 5 } } })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Result: ${TAG("m00066")} done ` } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "get_report" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: fullJson.slice(0, 20) } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: fullJson.slice(20, 40) } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: fullJson.slice(40) } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ];
    await pipePluginChatWithStrip(streamOf(events), res, "anthropic", makeSession());
    const parsed = dataLines(out.join(""));
    const input = anthropicInput(parsed);
    assert.equal(input, fullJson, "assembled tool input must be byte-identical to upstream (tag included)");
    assert.deepEqual(JSON.parse(input), { q: `ref ${tag}` }, "host JSON.parse succeeds on the untouched payload");
    const prose = anthropicText(parsed);
    assert.equal(prose, "Result:  done ", "text block still stripped of its echoed tag");
    assert.ok(!prose.includes(OPEN_MARK) && !prose.includes(CLOSE_MARK), "text block leaked a tag");
});

test("#1039 responses: function_call_arguments deltas and done payloads pass through verbatim", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    const tag = TAG("m00011");
    const dirtyArgs = `{"a": "see ${tag}"}`;
    const events = [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "created" } })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_report", arguments: "" } })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: dirtyArgs.slice(0, 15) })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: dirtyArgs.slice(15, 35) })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: dirtyArgs.slice(35) })}\n\n`,
        `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 1, summary_index: 0, delta: `thinking ${TAG("m00009")} more` })}\n\n`,
        `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", arguments: dirtyArgs })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_report", arguments: dirtyArgs } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "get_report", arguments: dirtyArgs }] } })}\n\n`,
    ];
    await pipePluginResponsesWithStrip(streamOf(events), res, makeSession());
    const text = out.join("");
    const parsed = dataLines(text);
    assert.equal(responsesArgs(parsed), dirtyArgs, "delta-assembled arguments must be byte-identical to upstream");
    const done = parsed.find((e) => e["type"] === "response.function_call_arguments.done") ?? {};
    assert.equal(asString(done["arguments"]), dirtyArgs, "done payload arguments untouched");
    const itemDone = parsed.find((e) => e["type"] === "response.output_item.done") ?? {};
    assert.equal(asString(asObj(itemDone["item"])["arguments"]), dirtyArgs, "output_item.done arguments untouched");
    const completed = parsed.find((e) => e["type"] === "response.completed") ?? {};
    const outItem = asObj(asArr(asObj(completed["response"])["output"])[0]);
    assert.equal(asString(outItem["arguments"]), dirtyArgs, "response.completed arguments untouched");
    assert.ok(text.includes("m00009"), "unified invariant: reasoning summary rides verbatim (#2267)");
});

test("#1039 non-streaming: pipePluginJson leaves tool-call argument payloads verbatim, strips prose tags", async () => {
    const tag = TAG("m00031");
    const cases = [
        {
            protocol: "openai" as const,
            body: { choices: [{ message: { role: "assistant", content: `ok ${TAG("m00032")}`, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: `{"n": "x${tag}y"}` } }] } }] },
            expectArgs: `{"n": "x${tag}y"}`,
            expectContent: "ok ",
        },
        {
            protocol: "anthropic" as const,
            body: { content: [{ type: "text", text: `say ${TAG("m00033")}` }, { type: "tool_use", id: "t1", name: "f", input: { n: `x${tag}y` } }] },
            expectArgs: `x${tag}y`,
            expectContent: "say ",
        },
        {
            protocol: "responses" as const,
            body: { output: [{ type: "message", content: [{ type: "output_text", text: `hi ${TAG("m00034")}` }] }, { type: "function_call", id: "fc1", call_id: "c1", name: "f", arguments: `{"n": "x${tag}y"}` }] },
            expectArgs: `{"n": "x${tag}y"}`,
            expectContent: "hi ",
        },
    ];
    for (const c of cases) {
        const out: string[] = [];
        const res = makeRes(out);
        await pipePluginJson(streamOf([JSON.stringify(c.body)]), res, makeSession(), c.protocol);
        const got = JSON.parse(out.join("")) as Record<string, unknown>;
        let args: unknown;
        let content: unknown;
        if (c.protocol === "openai") {
            const msg = asObj(asObj(asArr(got["choices"])[0])["message"]);
            const tc = asObj(asArr(msg["tool_calls"])[0]);
            args = asObj(tc["function"])["arguments"];
            content = msg["content"];
        } else if (c.protocol === "anthropic") {
            const items = asArr(got["content"]);
            args = asObj(items[1])["input"] && (asObj(asObj(items[1])["input"])["n"]);
            content = asObj(items[0])["text"];
        } else {
            const items = asArr(got["output"]);
            args = asObj(items[1])["arguments"];
            content = asObj(asArr(asObj(items[0])["content"])[0])["text"];
        }
        assert.equal(String(args), c.expectArgs, `${c.protocol}: arguments verbatim (tag included)`);
        assert.equal(String(content), c.expectContent, `${c.protocol}: prose stripped`);
    }
});
