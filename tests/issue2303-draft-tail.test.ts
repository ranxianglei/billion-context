import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { endsWithDraftClose } from "../src/degenerate-turn.ts";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #2303: a terminal turn whose visible prose ends with a compression-draft
// closing tag (</summary> / </analysis>) and no tool call used to read as a
// healthy completed turn — the model wrote a handoff/compression draft in prose
// instead of issuing the action it described (149 silent stops / 70 sessions,
// DSH native). All three terminal-verdict lanes must now treat it as non-
// converged and spend their one-shot continuation nudge on it: the plugin chat
// pipe, the plugin responses pipe, and the compress loop.

// ---------- helper ----------

test("endsWithDraftClose: exactly the two production close forms, fully closed", () => {
    assert.equal(endsWithDraftClose("…do the single followup.\n</summary>"), true);
    assert.equal(endsWithDraftClose("…write uncovered rather than proceed.</analysis>"), true);
    assert.equal(endsWithDraftClose("…\n</Summary>\r\n"), true, "case-insensitive, trailing whitespace allowed");
    assert.equal(endsWithDraftClose("</ANALYSIS>"), true);
    assert.equal(endsWithDraftClose("</summa"), false, "truncated forms are a different defect class (#1755/#2190)");
    assert.equal(endsWithDraftClose("</summaries>"), false);
    assert.equal(endsWithDraftClose("plan: end with </summary> then continue"), false, "mid-text occurrence does not count");
    assert.equal(endsWithDraftClose("All done."), false);
    assert.equal(endsWithDraftClose(""), false);
});

// ---------- shared fixtures ----------

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

function chatChunk(delta: Record<string, unknown>): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

const DONE = "data: [DONE]\n\n";

function chatStop(reason = "stop"): string {
    return `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** The production shape (sanitized): a multi-line handoff draft whose last line
 *  is the compression-draft closing tag, delivered as the message's text with
 *  no tool call. The tail arrives in its OWN delta, as real streaming does. */
const DRAFT_BODY = "## Handoff\n- ran the suite: `<venv>/python.exe -m pytest -q`\n- next: write the receipt and do the single followup to main control.";
const DRAFT_TAIL = "\n</summary>";

function draftTailTurn(): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: DRAFT_BODY }), chatChunk({ content: DRAFT_TAIL }), chatStop(), DONE];
}

function proseTurn(text: string): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: text }), chatStop(), DONE];
}

function textDeltas(raw: string): string {
    return [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

// ---------- plugin chat pipe (the DSH native evidence lane) ----------

test("#2303 chat(openai): draft-tail terminal turn spends the continuation nudge once", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("real action issued after the nudge")));
    };
    await pipePluginChatWithStrip(streamOf(draftTailTurn()), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch);
    const text = out.join("");
    assert.equal(calls, 1, "exactly one re-issue");
    assert.ok(textDeltas(text).includes(DRAFT_BODY), "the first attempt's draft still reaches the client");
    assert.ok(textDeltas(text).includes("</summary>"), "the draft's closing tag is not stripped by this fix (exit-layer concern, #2248)");
    assert.ok(textDeltas(text).endsWith("real action issued after the nudge"), "the retry's content appends to the same stream");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "one turn, one terminal");
    assert.equal((text.match(/"finish_reason":"stop"/g) ?? []).length, 1, "the first attempt's terminal is dropped, not doubled");
    assert.ok(logs.some((l) => l.includes("#2303")), `the distinct #2303 log line fired, got: ${JSON.stringify(logs)}`);
});

test("#2303 chat(anthropic): draft-tail terminal turn retries onto a later block", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf([
            sse("message_start", { type: "message_start", message: { id: "msg_2", role: "assistant", usage: { input_tokens: 40 } } }),
            sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
            sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the continuation" } }),
            sse("content_block_stop", { type: "content_block_stop", index: 0 }),
            sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } }),
            sse("message_stop", { type: "message_stop" }),
        ]));
    };
    await pipePluginChatWithStrip(streamOf([
        sse("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 40 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${DRAFT_BODY}${DRAFT_TAIL}` } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } }),
        sse("message_stop", { type: "message_stop" }),
    ]), makeRes(out), "anthropic", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1);
    assert.equal((text.match(/"type":"message_start"/g) ?? []).length, 1, "the retry must not re-open the message");
    assert.equal((text.match(/"type":"message_stop"/g) ?? []).length, 1, "one turn, one terminal");
    assert.ok(text.includes('"index":1'), `the retry's block follows the client's closed block 0, got: ${text}`);
});

test("#2303 chat: a normally-ended prose turn is NOT retried", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf(proseTurn("All done, nothing pending.")), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "no re-issue for a healthy completed turn");
});

test("#2303 chat: a truncated closing form is NOT retried here (#1755/#2190 class)", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf(proseTurn(`${DRAFT_BODY}\n</summa`)), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "truncated forms stay out of scope");
});

test("#2303 chat: a draft-tail turn WITH a tool call is NOT retried", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ content: `${DRAFT_BODY}${DRAFT_TAIL}` }),
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
        chatStop("tool_calls"),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "a tool call means the step converges");
    assert.ok(out.join("").includes("compress"), "the agent's own tool call still passes through");
});

test("#2303 chat: a length-cut draft tail stays on the truncation path, not this one", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf([chatChunk({ role: "assistant" }), chatChunk({ content: `${DRAFT_BODY}${DRAFT_TAIL}` }), chatStop("length"), DONE]), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "finish_reason=length is not a clean terminal for this gate");
});

test("#2303 chat: a draft-tail RETRY degenerates into the in-band error (#870 path)", async () => {
    const out: string[] = [];
    const refetch = () => Promise.resolve(streamOf(draftTailTurn()));
    await pipePluginChatWithStrip(streamOf(draftTailTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.ok(
        text.includes("[ACP] stream error"),
        "the client is told, rather than left with a second silent draft tail",
    );
});

// ---------- plugin responses pipe ----------

function responsesDraftTailTurn(responseId = "resp_1", itemId = "item_1", status = "completed"): string[] {
    const text = `${DRAFT_BODY}${DRAFT_TAIL}`;
    return [
        sse("response.created", { type: "response.created", response: { id: responseId, status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, delta: text }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, text }),
        sse(status === "completed" ? "response.completed" : "response.failed", {
            type: status === "completed" ? "response.completed" : "response.failed",
            response: { id: responseId, status, output: [{ id: itemId, type: "message", content: [{ type: "output_text", text }] }] },
        }),
    ];
}

function responsesProseTurn(text: string, responseId = "resp_2", itemId = "item_2"): string[] {
    return [
        sse("response.created", { type: "response.created", response: { id: responseId, status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, delta: text }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, text }),
        sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: itemId, type: "message", content: [{ type: "output_text", text }] } }),
        sse("response.completed", { type: "response.completed", response: { id: responseId, status: "completed", output: [{ id: itemId, type: "message", content: [{ type: "output_text", text }] }] } }),
    ];
}

function responsesDeltas(raw: string): string {
    return [...raw.matchAll(/"delta":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

test("#2303 responses: draft-tail completed turn spends the continuation nudge once", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("recovered after the nudge")));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesDraftTailTurn()), makeRes(out), makeSession(), undefined, refetch);
    const text = out.join("");
    assert.equal(calls, 1, "exactly one re-issue");
    assert.ok(responsesDeltas(text).includes(DRAFT_BODY), "the first attempt's draft still reaches the client");
    assert.ok(responsesDeltas(text).endsWith("recovered after the nudge"), "the retry's prose appends to the same item");
    assert.equal((text.match(/"type":"response\.created"/g) ?? []).length, 1, "the retry does not open a second response");
    assert.equal((text.match(/"type":"response\.completed"/g) ?? []).length, 1, "one turn, one terminal");
    assert.ok(!text.includes("item_2") && !text.includes("resp_2"), `the retry's ids are rewritten onto the client's, got: ${text}`);
});

test("#2303 responses: a draft-tail turn WITH a function call is NOT retried", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("unwanted")));
    };
    const events = [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "function_call", name: "read" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: `${DRAFT_BODY}${DRAFT_TAIL}` }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ id: "item_1", type: "function_call" }] } }),
    ];
    await pipePluginResponsesWithStrip(streamOf(events), makeRes(out), makeSession(), undefined, refetch);
    assert.equal(calls, 0, "a function call means the step converges");
});

// ---------- compress loop (proxy mode) ----------

function makeCtx(id: string, protocol: "responses" | "openai" = "openai") {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages: [] as CoreMessage[],
        session: {
            id,
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
        } as unknown as Session,
        log: () => {},
        protocol,
    };
}

function openaiSse(frames: Array<Record<string, unknown>>): string {
    return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + "data: [DONE]\n\n";
}

const OPENAI_DRAFT_TAIL = openaiSse([
    { id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { content: DRAFT_BODY }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { content: DRAFT_TAIL }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

const OPENAI_NORMAL = openaiSse([
    { id: "chatcmpl_4", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_4", choices: [{ index: 0, delta: { content: "all steps finished, nothing pending" }, finish_reason: null }] },
    { id: "chatcmpl_4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

const OPENAI_GOOD = openaiSse([
    { id: "chatcmpl_2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: { content: "continued after nudge" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

async function drainOpenai(first: string, retries: string[], id: string): Promise<{ out: string; fetchCalls: number; bodies: string[] }> {
    let fetchCalls = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        if (init?.body !== undefined) bodies.push(typeof init.body === "string" ? init.body : String(init.body));
        const body = retries[fetchCalls - 1] ?? "";
        return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    try {
        const ctx = makeCtx(id, "openai");
        for await (const chunk of runCompressLoop(
            new Response(first, { status: 200 }).body!,
            ctx,
            { model: "deepseek-chat", stream: true },
            { url: "http://mock", headers: {} },
            createOpenaiAdapter({ model: "deepseek-chat", stream: true }),
            buildCompressSystemPrompt(),
        )) {
            chunks.push(chunk);
        }
    } finally {
        globalThis.fetch = orig;
    }
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls, bodies };
}

test("#2303 loop: draft-tail terminal turn → one invisible retry with the continuation nudge", async () => {
    const { out, fetchCalls, bodies } = await drainOpenai(OPENAI_DRAFT_TAIL, [OPENAI_GOOD], "dt-l1");
    assert.equal(fetchCalls, 1, "re-request + exactly one draft-tail auto-retry");
    assert.ok(bodies.length >= 1, "retry request observed");
    assert.ok(
        bodies[0]!.includes("ended without a tool call"),
        "the retry body carries the ephemeral continuation nudge",
    );
    // Single-line fragments: inside the SSE frames the draft's newlines are
    // JSON-escaped, so a multi-line includes() cannot match the wire bytes.
    const draftFrag = "write the receipt and do the single followup";
    assert.ok(out.includes(draftFrag), "the first attempt's draft reached the client");
    assert.ok(out.includes("</summary>"), "the draft's closing tag reaches the client unfiltered (exit-layer concern stays #2248)");
    assert.ok(out.includes("continued after nudge"), "the retried turn's content was delivered to the client");
    assert.ok(out.indexOf(draftFrag) < out.indexOf("continued after nudge"), "the draft precedes the retried content");
});

test("#2303 loop: one-shot bound — a draft-tail RETRY is not retried again", async () => {
    const { fetchCalls } = await drainOpenai(OPENAI_DRAFT_TAIL, [OPENAI_DRAFT_TAIL], "dt-l2");
    assert.equal(fetchCalls, 1, "one retry max; the second draft tail falls through to the plain completion");
});

test("#2303 loop: a normally-ended prose turn is NOT retried", async () => {
    const { fetchCalls } = await drainOpenai(OPENAI_NORMAL, [OPENAI_GOOD], "dt-l3");
    assert.equal(fetchCalls, 0, "no auto-retry for a healthy completed turn");
});

test("#2303 loop: a truncated closing form is NOT retried here", async () => {
    const cut = openaiSse([
        { id: "chatcmpl_5", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { id: "chatcmpl_5", choices: [{ index: 0, delta: { content: `${DRAFT_BODY}\n</summa` }, finish_reason: null }] },
        { id: "chatcmpl_5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const { fetchCalls } = await drainOpenai(cut, [OPENAI_GOOD], "dt-l4");
    assert.equal(fetchCalls, 0, "truncated forms stay out of scope");
});
