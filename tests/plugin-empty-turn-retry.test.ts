import { test } from "node:test";
import assert from "node:assert/strict";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { loadOptions } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";
import { DEGENERATE_RETRY_NUDGE, injectContinuationNudge } from "../src/degenerate-retry.ts";
import type { Session } from "../src/session.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The plugin pipe is what serves plugin-mode agents (this machine's omp
// sessions among them). A turn whose ONLY text is an echoed render tag is
// emptied by the tag filter, so the host receives a completed turn with no text
// and no tool call and aborts it — the #732/#821 retry, which the compress loop
// already ships for its own request path, is re-issued here on the agent's own
// body. These tests pin the pipe half of that contract.

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

const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

function chatChunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function chatStop(reason = "stop"): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

/** The failing turn in production: the model imitates the render tag it saw in
 *  its prompt and emits nothing else, so the filter empties the whole turn. */
function echoOnlyTurn(): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: `${TAG_OPEN}m00155${TAG_CLOSE}` }), chatStop(), DONE];
}

function proseTurn(text: string): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: text }), chatStop(), DONE];
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function anthropicEchoOnlyTurn(): string[] {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 40 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${TAG_OPEN}m00155${TAG_CLOSE}` } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
        sse("message_stop", { type: "message_stop" }),
    ];
}

function anthropicProseTurn(text: string): string[] {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_2", role: "assistant", usage: { input_tokens: 40 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } }),
        sse("message_stop", { type: "message_stop" }),
    ];
}

function textDeltas(raw: string, protocol: "openai" | "anthropic"): string {
    const re =
        protocol === "anthropic" ? /"type":"text_delta","text":"((?:[^"\\]|\\.)*)"/g : /"content":"((?:[^"\\]|\\.)*)"/g;
    return [...raw.matchAll(re)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

test("plugin chat retries once when the turn's only text was a stripped render-tag echo", async () => {
    const out: string[] = [];
    const res = makeRes(out);
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("real answer after the nudge")));
    };
    await pipePluginChatWithStrip(streamOf(echoOnlyTurn()), res, "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "exactly one re-issue");
    assert.equal(textDeltas(text, "openai"), "real answer after the nudge", "the retry's content reaches the client");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "one turn, one terminal");
    assert.ok(!text.includes("m00155"), "the echoed tag never leaks");
    assert.equal((text.match(/"finish_reason":"stop"/g) ?? []).length, 1, "the first attempt's terminal is dropped, not doubled");
});

test("plugin chat does not retry a turn that already delivered visible text", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf(proseTurn("the model answered")), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "no re-issue when the turn was not empty");
    assert.equal(textDeltas(out.join(""), "openai"), "the model answered");
});

test("plugin chat does not retry a turn that produced a tool call", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ content: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
        chatStop("tool_calls"),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "a tool call is not an empty turn");
    assert.ok(out.join("").includes("compress"), "the agent's own tool call still passes through");
});

test("plugin chat does not retry a turn the provider ended on a non-clean reason", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    const events = [chatChunk({ role: "assistant" }), chatChunk({ content: `${TAG_OPEN}m00155${TAG_CLOSE}` }), chatStop("content_filter"), DONE];
    await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "a filtered turn must not be re-prompted");
});

test("plugin chat passes the empty turn through and warns when the retry is empty too", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => {
        logs.push(msg);
    });
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf([DONE]));
    };
    try {
        await pipePluginChatWithStrip(streamOf(echoOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
    } finally {
        setLogCapture(null);
    }
    const text = out.join("");
    assert.equal(calls, 1, "one attempt only");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "the retry's own terminal closes the turn");
    assert.ok(
        logs.some((l) => l.includes("degenerate")),
        `a still-empty turn stays visible to the operator, got: ${JSON.stringify(logs)}`,
    );
});

test("plugin chat passes the empty turn through when the retry cannot be issued", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => {
        logs.push(msg);
    });
    try {
        await pipePluginChatWithStrip(streamOf(echoOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, () => Promise.resolve(null));
    } finally {
        setLogCapture(null);
    }
    const text = out.join("");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "the original terminal is presented unchanged");
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).filter((l) => !l.includes("[DONE]"));
    for (const l of dataLines) {
        assert.doesNotThrow(() => JSON.parse(l.slice(5).trim()), "every data line stays valid JSON");
    }
});

test("plugin chat (anthropic) lands the retry's content in a block after the client's own", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(anthropicProseTurn("the continuation")));
    };
    await pipePluginChatWithStrip(streamOf(anthropicEchoOnlyTurn()), makeRes(out), "anthropic", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1);
    assert.equal((text.match(/"type":"message_start"/g) ?? []).length, 1, "the retry must not re-open the message");
    assert.equal((text.match(/"type":"message_stop"/g) ?? []).length, 1, "one turn, one terminal");
    assert.equal(textDeltas(text, "anthropic"), "the continuation");
    assert.ok(text.includes('"index":1'), `the retry's block follows the client's closed block 0, got: ${text}`);
});

test("the continuation retry body carries the nudge as a trailing user turn", () => {
    const openaiBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const merged = JSON.parse(injectContinuationNudge("openai", openaiBody)!) as { messages: { role: string; content: string }[] };
    assert.equal(merged.messages.length, 1, "merged into the existing user turn instead of adding a second one");
    assert.equal(merged.messages[0]!.role, "user");
    assert.ok(merged.messages[0]!.content.startsWith("hi"), "the original text is preserved");
    assert.ok(
        merged.messages[0]!.content.includes("ended without a tool call"),
        `the nudge text is appended, got: ${merged.messages[0]!.content}`,
    );

    const anthropicBody = JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    const asBlock = JSON.parse(injectContinuationNudge("anthropic", anthropicBody)!) as {
        messages: { content: { type: string; text: string }[] }[];
    };
    assert.equal(asBlock.messages[0]!.content.length, 2, "anthropic content is a block array");
    assert.equal(asBlock.messages[0]!.content[1]!.text, DEGENERATE_RETRY_NUDGE);

    const assistantLast = JSON.stringify({ messages: [{ role: "assistant", content: "done" }] });
    const appended = JSON.parse(injectContinuationNudge("openai", assistantLast)!) as { messages: { role: string }[] };
    assert.equal(appended.messages.length, 2, "a body ending on the assistant side gets a fresh user turn");

    assert.equal(injectContinuationNudge("openai", JSON.stringify({ foo: 1 })), null, "unusable body is reported, not mangled");
    assert.equal(injectContinuationNudge("openai", "{not json"), null);
});

// The Responses pipe carries the same defect for omp's codex subagent turns,
// but its terminal is a FAMILY (output_text.done, content_part.done,
// output_item.done) decided by response.completed, and every event carries ids
// the client already holds. So the retry holds that family until the completion
// decides, and reframes the retry onto those ids: the client sees one turn.
function responsesEchoOnlyTurn(): string[] {
    return [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: "item_1", output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: "item_1", output_index: 0, text: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.completed", {
            type: "response.completed",
            response: {
                id: "resp_1",
                status: "completed",
                output: [{ id: "item_1", type: "message", content: [{ type: "output_text", text: `${TAG_OPEN}m00155${TAG_CLOSE}` }] }],
            },
        }),
    ];
}

function responsesProseTurn(text: string, responseId = "resp_2", itemId = "item_2", status = "completed"): string[] {
    return [
        sse("response.created", { type: "response.created", response: { id: responseId, status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, delta: text }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, text }),
        // The frame that carries the item's identity NESTED rather than as
        // `item_id`: it reaches the client, so it must be rewritten too.
        sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: itemId, type: "message", content: [{ type: "output_text", text }] } }),
        sse(status === "completed" ? "response.completed" : "response.failed", {
            type: status === "completed" ? "response.completed" : "response.failed",
            response: { id: responseId, status, output: [{ id: itemId, type: "message", content: [{ type: "output_text", text }] }] },
        }),
    ];
}

function responsesDeltas(raw: string): string {
    return [...raw.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

test("plugin responses retries once when the turn's only text was a stripped echo", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("recovered after the nudge")));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesEchoOnlyTurn()), makeRes(out), makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "exactly one re-issue");
    assert.equal(responsesDeltas(text), "recovered after the nudge", "the retry's prose is what the client assembles");
    assert.equal((text.match(/"type":"response\.created"/g) ?? []).length, 1, "the retry does not open a second response");
    assert.equal((text.match(/"type":"response\.completed"/g) ?? []).length, 1, "one turn, one terminal");
    assert.equal((text.match(/"type":"response\.output_item\.added"/g) ?? []).length, 1, "the retry's own added events are dropped");
    assert.ok(!text.includes("m00155"), "the echoed tag never leaks");
    assert.ok(!text.includes("item_2") && !text.includes("resp_2"), `the retry's ids are rewritten onto the client's, got: ${text}`);
    assert.ok(text.includes('"item_id":"item_1"'), "the retry's deltas carry the item id the client already holds");
});

test("plugin responses releases the held done-family events on a healthy turn", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("unwanted")));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesProseTurn("the model answered")), makeRes(out), makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 0, "no re-issue when the turn was not empty");
    assert.equal(responsesDeltas(text), "the model answered");
    const done = text.indexOf('"type":"response.output_text.done"');
    const completed = text.indexOf('"type":"response.completed"');
    assert.ok(done >= 0 && completed > done, `holding must not reorder the turn, got: ${text}`);
});

test("plugin responses does not retry a completed turn whose text arrives only in the done event", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("unwanted")));
    };
    const events = responsesProseTurn("the whole answer off-stream", "resp_3", "item_3").filter((e) => !e.includes("response.output_text.delta"));
    await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession(), undefined, refetch);
    assert.equal(calls, 0, "text the client would receive from the done event is not an empty turn");
});

test("plugin responses does not retry a turn that produced a function call", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("unwanted")));
    };
    const events = [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "function_call", name: "read" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: `${TAG_OPEN}m00155${TAG_CLOSE}` }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ id: "item_1", type: "function_call" }] } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession(), undefined, refetch);
    assert.equal(calls, 0, "a tool call is not an empty turn");
    assert.ok(out.join("").includes('"function_call"'), "the agent's own tool surface still passes through");
});

test("plugin responses does not retry a turn the provider failed or cut", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("unwanted")));
    };
    await pipePluginResponsesWithStrip(
        streamOf(responsesProseTurn(`${TAG_OPEN}m00155${TAG_CLOSE}`, "resp_4", "item_4", "failed")),
        makeRes(out),
        makeSession(),
        undefined,
        refetch,
    );
    assert.equal(calls, 0, "a failed turn is a real terminal, not an empty one");
});

// #721: takeover resets sawTerminal, so a retry that is itself cut must still
// warn the client instead of closing bare.
const TRUNC_MARKER = "upstream_stream_truncated";

/** A single chunk carrying content AND the finish reason — the coalescing some
 *  upstreams do, which the gate must count before it can call a turn empty. */
function coalescedChunk(content: string, reason: string): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { content }, finish_reason: reason }] })}\n\n`;
}

test("plugin chat: a coalesced content+finish_reason chunk counts its own text", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf([coalescedChunk("the whole answer", "stop"), DONE]), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "content delivered in the same chunk as the finish reason is not an empty turn");
    assert.equal(textDeltas(out.join(""), "openai"), "the whole answer");
});

test("plugin chat: a coalesced echo+finish_reason chunk still retries once", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("recovered after the coalesced echo")));
    };
    await pipePluginChatWithStrip(streamOf([coalescedChunk(`${TAG_OPEN}m00155${TAG_CLOSE}`, "stop"), DONE]), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "the gate runs after the chunk is processed, so the emptied echo is still seen");
    assert.equal(textDeltas(text, "openai"), "recovered after the coalesced echo");
    assert.ok(!text.includes("m00155"), "the echoed tag never leaks");
});

test("plugin chat: a retry stream that is cut still raises the truncation signal", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf([]));
    };
    await pipePluginChatWithStrip(streamOf(echoOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "the retry was attempted");
    assert.ok(text.includes(TRUNC_MARKER), `a cut retry must still warn the client, got: ${text}`);
    assert.ok(text.includes("data: [DONE]"), "the stream is still terminated for the client");
});

/** The production shape of the unclosed-echo turn: the model opens a render tag,
 *  writes its tool call inside it, and never closes the tag, so the span stays
 *  pending and is released at the terminal. Reconstructed from the client-visible
 *  residue of session 01a0ab88-a02e-7459-b278-56d7dbfe9746 at
 *  2026-09-16T19:43:34.613Z; the wire bytes were not kept anywhere. */
function unclosedEchoTurn(): string[] {
    const pad = " ".repeat(120);
    const residue = ` m00693</cp>${pad}\n${pad}\n <parameter name="i">Checking pocket CLI surface</｜｜DSML｜｜ parameter>`;
    return [chatChunk({ role: "assistant" }), chatChunk({ content: `${TAG_OPEN}${residue}` }), chatStop(), DONE];
}

test("plugin chat retries a turn whose only visible output was an unclosed render tag", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("real answer after the nudge")));
    };
    await pipePluginChatWithStrip(streamOf(unclosedEchoTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    // The dropped tag's interior has already reached the client by the time the
    // terminal arrives, so the retry cannot erase it: what the fix guarantees is
    // that the turn carries content the host can act on, which is what the stall
    // was missing.
    assert.equal(calls, 1, "a tag interior is not visible output, so the turn is retried once");
    assert.ok(
        textDeltas(text, "openai").endsWith("real answer after the nudge"),
        "the retry's content reaches the client after the residue",
    );
});

/** The #4913 production shape (issue dataset: 13/13 double-degenerates were
 *  thinking-only): the model emits only reasoning, then ends cleanly — no
 *  answer prose, no tool call, no stripped echo. */
function thinkingOnlyTurn(text = "The retry still only thought."): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ reasoning_content: text }), chatStop(), DONE];
}

test("plugin chat emits an in-band error when the retry degenerates too", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => {
        logs.push(msg);
    });
    // #4913 re-pin: the old pin used a truly BARE second attempt, which is
    // exactly the shape #2756 documents as pass-through — the fix below now
    // gives it that, so the fatal branch is pinned with the production shape
    // instead (issue dataset: every double-degenerate second attempt carried
    // thinking).
    const refetch = () => Promise.resolve(streamOf(thinkingOnlyTurn()));
    try {
        await pipePluginChatWithStrip(streamOf(unclosedEchoTurn()), makeRes(out), "openai", makeSession(), (msg) => logs.push(msg), refetch);
    } finally {
        setLogCapture(null);
    }
    const text = out.join("");
    // #5958: an exhausted retry is a FAILURE, not a completed turn. The default
    // streamErrorShape is "protocol", so the client gets the wire-native error
    // frame — and, critically, NO finish_reason:"stop" terminal that a host like
    // DSH would book as stop/completed while the task is still unfinished.
    assert.ok(text.includes('"code":"stream_error"'), "a protocol-native error frame marks the turn as failed");
    assert.ok(!text.includes('"finish_reason":"stop"'), "an exhausted retry must NOT be serialized as a successful completion");
    assert.ok(!text.includes("[ACP] stream error"), "the legacy completed-turn error shape is off by default");
    // The error's own terminal plus the retry stream's trailing terminator both
    // close the turn; the client stops at the error either way.
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 2, "the error's terminal, then the retry's trailing terminator");
    // #4913 item 3: the fatal log names the signal that qualified the attempt,
    // measured on the RETRY pass (accumulators are reset when the retry takes
    // over), not inherited from the first attempt. #7666 reworded the budget
    // spent as "after N continuation nudge(s)".
    const fatal = logs.find((l) => l.includes("continuation nudge(s)"));
    assert.ok(fatal, `the fatal retry log is present, got: ${JSON.stringify(logs)}`);
    assert.ok(fatal.includes("sawThinking=true"), `the qualifying signal is named, got: ${fatal}`);
    assert.ok(fatal.includes("releasedMarkupChars=0"), "the first attempt's released markup is not inherited into the retry's verdict");
});

test("plugin chat: a retry attempt the model left genuinely bare passes through instead of dying (#4913)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => {
        logs.push(msg);
    });
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf([chatChunk({ role: "assistant" }), chatStop(), DONE]));
    };
    try {
        await pipePluginChatWithStrip(streamOf(unclosedEchoTurn()), makeRes(out), "openai", makeSession(), (msg) => logs.push(msg), refetch);
    } finally {
        setLogCapture(null);
    }
    const text = out.join("");
    assert.equal(calls, 1, "the first attempt is still retried once");
    // Before the fix this shape died as a fatal in-band error: the #2756 bare
    // exemption sat under the exhausted-retry branch and was unreachable on
    // the second pass. It now takes the same pass-through as the same shape
    // on the first pass — the upstream's own empty answer, not a proxy-invented
    // failure.
    assert.ok(!text.includes("stream_error"), "no protocol error frame for a bare second attempt");
    assert.ok(!text.includes("[ACP] stream error"), "no completed-turn error frame for a bare second attempt");
    assert.ok(text.includes('"finish_reason":"stop"'), "the turn completes as an (empty) answer");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "a single terminal closes the turn");
    const bare = logs.find((l) => l.includes("bare on the retry pass"));
    assert.ok(bare, `the bare-on-retry log is present, got: ${JSON.stringify(logs)}`);
    assert.ok(!logs.some((l) => l.includes("continuation nudge(s)")), "no fatal verdict for a bare second attempt");
});

test("plugin chat (chat wire): a thinking-only second attempt dies with the qualifying signal logged (#4913)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    setLogCapture((_level, msg) => {
        logs.push(msg);
    });
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(thinkingOnlyTurn("second attempt thought again")));
    };
    try {
        await pipePluginChatWithStrip(streamOf(thinkingOnlyTurn("first attempt thought")), makeRes(out), "openai", makeSession(), (msg) => logs.push(msg), refetch);
    } finally {
        setLogCapture(null);
    }
    const text = out.join("");
    assert.equal(calls, 1, "one retry, then the fatal verdict");
    assert.ok(text.includes('"code":"stream_error"'), "the #870 in-band failure is emitted");
    const fatal = logs.find((l) => l.includes("continuation nudge(s)"));
    assert.ok(fatal, `the fatal retry log is present, got: ${JSON.stringify(logs)}`);
    assert.ok(fatal.includes("sawThinking=true"), `the retry's own thinking qualifies the verdict, got: ${fatal}`);
    assert.ok(!fatal.includes("first attempt thought"), "the verdict is measured, not inherited from the first attempt's bytes");
    assert.ok(fatal.includes("visibleTextChars=0") && fatal.includes("answerChars=0"), `the verdict carries the empty-shape counters, got: ${fatal}`);
});

test("plugin chat: a healthy second attempt after a degenerate first completes cleanly", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("the answer arrives on the retry")));
    };
    await pipePluginChatWithStrip(streamOf(thinkingOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "the degenerate first attempt is retried");
    assert.ok(!text.includes("stream_error"), "a recovered turn carries no error");
    assert.ok(textDeltas(text, "openai").endsWith("the answer arrives on the retry"), "the retry's answer reaches the client");
    assert.ok(text.includes('"finish_reason":"stop"'), "the recovered turn completes normally");
});

test("plugin chat keeps the legacy completed-turn shape when streamErrorShape is \"completion\"", async () => {
    const out: string[] = [];
    // #4913 re-pin: a bare second attempt now passes through, so the legacy
    // error shape is pinned with the thinking-only (production) second attempt.
    const refetch = () => Promise.resolve(streamOf(thinkingOnlyTurn()));
    await pipePluginChatWithStrip(
        streamOf(unclosedEchoTurn()), makeRes(out), "openai", makeSession(), undefined, refetch,
        undefined, undefined, undefined, undefined, undefined, "completion",
    );
    const text = out.join("");
    // The opt-in escape hatch restores the #870/#2689 shape: the error text rides
    // inside a well-formed completed turn (finish_reason:"stop") for hosts that
    // need it visible as turn content rather than a protocol error frame.
    assert.ok(text.includes("[ACP] stream error"), "the legacy in-band error text is present on opt-in");
    assert.ok(text.includes('"finish_reason":"stop"'), "the legacy completed-turn terminal is preserved on opt-in");
});

/** Parse the emitted SSE text back into {event, data} pairs (test-side only). */
function sseEvents(raw: string): { event: string; data: Record<string, unknown> }[] {
    return raw.split("\n\n")
        .map((block) => {
            const evLine = block.split("\n").find((l) => l.startsWith("event:"));
            const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
            if (!evLine || !dataLine) return null;
            try {
                return { event: evLine.slice("event: ".length).trim(), data: JSON.parse(dataLine.slice("data: ".length).trim()) as Record<string, unknown> };
            } catch {
                return null;
            }
        })
        .filter((e): e is { event: string; data: Record<string, unknown> } => e !== null);
}

// #7235: the Anthropic protocol (Claude Code) accepts an empty end_turn, so the
// second-failure fallback passes the empty turn through instead of emitting an
// in-band error (which the host would record as an assistant message in the
// persisted session record). The OpenAI/Responses/Google paths keep the #870
// in-band error because their wires require a non-empty completion.
test("plugin chat (anthropic) #7235: the second-failure fallback passes through (no in-band error)", async () => {
    const out: string[] = [];
    const refetch = () => Promise.resolve(streamOf(anthropicEchoOnlyTurn()));
    await pipePluginChatWithStrip(
        streamOf(anthropicEchoOnlyTurn()), makeRes(out), "anthropic", makeSession(), undefined, refetch,
        undefined, undefined, undefined, undefined, undefined, "completion",
    );
    const text = out.join("");
    // #7235: the Anthropic protocol passes the empty turn through on the second
    // failure — no in-band error is emitted.
    assert.ok(!text.includes("[ACP] stream error"), "no in-band error for anthropic (#7235)");
    assert.ok(!text.includes("event: error"), "no native error event for anthropic (#7235)");
});

test("plugin chat (anthropic) #7235: the second-failure fallback passes through (no native error event)", async () => {
    const out: string[] = [];
    const refetch = () => Promise.resolve(streamOf(anthropicEchoOnlyTurn()));
    await pipePluginChatWithStrip(streamOf(anthropicEchoOnlyTurn()), makeRes(out), "anthropic", makeSession(), undefined, refetch);
    const text = out.join("");
    // #7235: the Anthropic protocol passes the empty turn through on the second
    // failure — no native error event is emitted.
    assert.ok(!text.includes("event: error"), "no native Anthropic error event (#7235)");
    assert.ok(!text.includes('"code":"stream_error"'), "no stream_error code (#7235)");
    assert.ok(!text.includes("[ACP] stream error"), "no synthetic completed-turn error block (#7235)");
});

// #4913: compat.degenerateTurn="passthrough" (env BILI_DEGENERATE_TURN wins)
// opts the chat lane back into the pre-#870 terminal for an EXHAUSTED
// degenerate-turn retry — the empty turn passes through as a normal completion
// instead of the fatal in-band error. Only the chat pipe has the fatal branch;
// the proxy lane and responses wire already pass this condition through.
test("plugin chat: an exhausted degenerate retry passes through when degenerateTurn=passthrough (#4913)", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(thinkingOnlyTurn("second attempt thought again")));
    };
    await pipePluginChatWithStrip(
        streamOf(thinkingOnlyTurn("first attempt thought")),
        makeRes(out),
        "openai",
        makeSession(),
        (msg) => logs.push(msg),
        refetch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        "passthrough",
    );
    const text = out.join("");
    assert.equal(calls, 1, "the degenerate first attempt is retried once");
    assert.ok(!text.includes("stream_error"), "passthrough mode carries no in-band error");
    assert.ok(text.includes('"finish_reason":"stop"'), "the empty turn passes through as a normal completion");
    const passthrough = logs.find((l) => l.includes('compat.degenerateTurn="passthrough"'));
    assert.ok(passthrough, `the passthrough verdict is logged with the counters, got: ${JSON.stringify(logs)}`);
    assert.ok(passthrough.includes("sawThinking=true"), `the logged signal is the retry's own thinking, got: ${passthrough}`);
    assert.ok(!logs.some((l) => l.includes("emitting an in-band error")), "no fatal branch ran");
});

test("plugin chat: an exhausted degenerate retry still dies when degenerateTurn=error is explicit (#4913)", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(thinkingOnlyTurn("second attempt thought again")));
    };
    await pipePluginChatWithStrip(
        streamOf(thinkingOnlyTurn("first attempt thought")),
        makeRes(out),
        "openai",
        makeSession(),
        undefined,
        refetch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        "error",
    );
    assert.equal(calls, 1);
    assert.ok(out.join("").includes('"code":"stream_error"'), "the explicit error value keeps the #870 in-band failure");
});

// #4913 config wiring: file compat.degenerateTurn + env BILI_DEGENERATE_TURN,
// env > file > default("error"), unknown values fall back to the default.
test("config: compat.degenerateTurn resolves env > file > default (#4913)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-4913-"));
    const cfg = path.join(dir, "config.json");
    try {
        const prevFile = process.env["BILI_CONFIG_FILE"];
        const prevEnv = process.env["BILI_DEGENERATE_TURN"];
        try {
            process.env["BILI_CONFIG_FILE"] = cfg;
            writeFileSync(cfg, JSON.stringify({ compat: { degenerateTurn: "passthrough" } }));
            assert.equal(loadOptions({}).degenerateTurn, "passthrough", "the file value applies");
            writeFileSync(cfg, JSON.stringify({ compat: { degenerateTurn: "error" } }));
            assert.equal(loadOptions({}).degenerateTurn, "error", "error value parses");
            assert.equal(loadOptions({ BILI_DEGENERATE_TURN: "passthrough" }).degenerateTurn, "passthrough", "env wins over the file");
            assert.equal(loadOptions({ BILI_DEGENERATE_TURN: "error" }).degenerateTurn, "error", "env error wins");
            writeFileSync(cfg, JSON.stringify({ compat: { degenerateTurn: "bogus" } }));
            assert.equal(loadOptions({}).degenerateTurn, "error", "unknown file values fall back to the default");
            writeFileSync(cfg, JSON.stringify({}));
            assert.equal(loadOptions({}).degenerateTurn, "error", "absent value defaults to error (status quo)");
        } finally {
            if (prevFile === undefined) delete process.env["BILI_CONFIG_FILE"]; else process.env["BILI_CONFIG_FILE"] = prevFile;
            if (prevEnv === undefined) delete process.env["BILI_DEGENERATE_TURN"]; else process.env["BILI_DEGENERATE_TURN"] = prevEnv;
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
