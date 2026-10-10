import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { looksLikeClientSummaryRequest } from "../src/degenerate-turn.ts";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #2612: a client-NATIVE compaction request (Claude Code /compact + auto-compact)
// instructs the model to hand-write its answer as PLAIN TEXT — an \x3canalysis\x3e
// block then a \x3csummary\x3e block — and forbids tool calls. A turn ending
// \x3c/summary\x3e with no tool call on such a request is the CORRECT completion, so
// the #2303 draft-tail nudge must stand down: retrying it wastes a turn and, when the
// retry ends alike, escalates into the #870 in-band error that aborts the client's own
// compaction. These tests pin that guard in all three lanes AND prove #2303 still fires
// when the request carries no such instruction (no over-suppression).

// The production Claude Code compaction prompt (sanitized to its load-bearing lines).
const CC_REQUEST_TEXT =
    "You are asked to compact this conversation.\n" +
    "Wrap your summary in <summary></summary> tags.\n" +
    "REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block.";

// ---------- detector unit ----------

test("#2612 detector: recognizes the Claude Code compaction instruction (each branch)", () => {
    assert.equal(looksLikeClientSummaryRequest(CC_REQUEST_TEXT), true, "full CC prompt");
    assert.equal(looksLikeClientSummaryRequest("REMINDER: Do NOT call any tools."), true, "no-tools reminder");
    assert.equal(looksLikeClientSummaryRequest("Please do not use any tools here."), true, "use/invoke variant");
    assert.equal(looksLikeClientSummaryRequest("Wrap your summary in <summary> tags."), true, "wrap instruction");
    assert.equal(looksLikeClientSummaryRequest("wrap its summary in </summary>"), true, "closing-tag variant");
    assert.equal(looksLikeClientSummaryRequest("an <analysis> block followed by a <summary> block"), true, "answer-structure instruction");
});

test("#2612 detector: does NOT fire on ordinary agentic text", () => {
    assert.equal(looksLikeClientSummaryRequest(""), false);
    assert.equal(looksLikeClientSummaryRequest("Continue with the plan and run the tests."), false);
    assert.equal(looksLikeClientSummaryRequest("Here is a summary of what we did today."), false, "'summary' alone is not the instruction");
    assert.equal(looksLikeClientSummaryRequest("Let me finish this and end with </summary>"), false, "a draft tail in the RESPONSE is not a request instruction");
});

// ---------- shared fixtures (mirror of issue2303-draft-tail.test.ts) ----------

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

const DRAFT_BODY = "## Handoff\n- ran the suite: `<venv>/python.exe -m pytest -q`\n- next: write the receipt and do the single followup to main control.";
const DRAFT_TAIL = "\n</summary>";

function draftTailTurn(): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: DRAFT_BODY }), chatChunk({ content: DRAFT_TAIL }), chatStop(), DONE];
}

function proseTurn(text: string): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: text }), chatStop(), DONE];
}

function anthropicDraftTailTurn(): string[] {
    return [
        sse("message_start", { type: "message_start", message: { id: "msg_1", role: "assistant", usage: { input_tokens: 40 } } }),
        sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${DRAFT_BODY}${DRAFT_TAIL}` } }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } }),
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

function textDeltas(raw: string): string {
    return [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

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

// ---------- plugin chat pipe (the primary failing lane) ----------

test("#2612 chat(openai): CC compaction request + </summary>-ending reply passes through — NO retry, NO error", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(draftTailTurn()));
    };
    await pipePluginChatWithStrip(streamOf(draftTailTurn()), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch, undefined, undefined, CC_REQUEST_TEXT);
    const text = out.join("");
    assert.equal(calls, 0, "a client's own compaction must not spend the continuation nudge");
    assert.ok(!text.includes("[ACP] stream error"), "no in-band error (#870) — the client's compaction survives");
    assert.ok(!logs.some((l) => l.includes("#2303")), `the #2303 retry log must not fire, got ${JSON.stringify(logs)}`);
    assert.ok(textDeltas(text).includes(DRAFT_BODY), "the client's hand-written summary reaches it intact");
    assert.ok(textDeltas(text).includes("</summary>"), "the closing tag is passed through unfiltered");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "one turn, one terminal");
});

test("#2612 chat(openai): SAME reply WITHOUT the instruction still retries (#2303 preserved)", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("real action issued after the nudge")));
    };
    await pipePluginChatWithStrip(streamOf(draftTailTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 1, "without the client-summary instruction a genuine draft-tail stall still spends the nudge");
});

test("#2612 chat(anthropic): CC compaction request + </summary>-ending reply — NO retry", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(anthropicProseTurn("continued")));
    };
    await pipePluginChatWithStrip(streamOf(anthropicDraftTailTurn()), makeRes(out), "anthropic", makeSession(), undefined, refetch, undefined, undefined, CC_REQUEST_TEXT);
    const text = out.join("");
    assert.equal(calls, 0, "anthropic wire: a client's own compaction must not be retried");
    assert.ok(!text.includes("[ACP] stream error"), "no in-band error (#870)");
    assert.equal((text.match(/"type":"message_stop"/g) ?? []).length, 1, "one turn, one terminal");
    assert.ok(text.includes("</summary>"), "the closing tag reaches the client unfiltered");
});

// ---------- plugin responses pipe ----------

test("#2612 responses: CC compaction request + </summary>-ending completed turn — NO retry", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("recovered after the nudge")));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesDraftTailTurn()), makeRes(out), makeSession(), undefined, refetch, undefined, undefined, CC_REQUEST_TEXT);
    const text = out.join("");
    assert.equal(calls, 0, "responses wire: a client's own compaction must not be retried");
    assert.ok(!text.includes("[ACP] stream error"), "no in-band error (#870)");
    assert.ok(responsesDeltas(text).includes("</summary>"), "the closing tag reaches the client unfiltered");
    assert.equal((text.match(/"type":"response\.completed"/g) ?? []).length, 1, "one turn, one terminal");
});

test("#2612 responses: SAME turn WITHOUT the instruction still retries (#2303 preserved)", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("recovered after the nudge")));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesDraftTailTurn()), makeRes(out), makeSession(), undefined, refetch);
    assert.equal(calls, 1, "without the client-summary instruction a genuine draft-tail stall still spends the nudge");
});

// ---------- compress loop (proxy mode) ----------

function makeCtx(id: string, messages: CoreMessage[]) {
    return {
        core: createCore(),
        config: { modelContextLimit: 200000 } as Config,
        messages,
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
        protocol: "openai" as const,
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

const OPENAI_GOOD = openaiSse([
    { id: "chatcmpl_2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: { content: "continued after nudge" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

async function drainOpenai(first: string, retries: string[], id: string, messages: CoreMessage[]): Promise<{ out: string; fetchCalls: number }> {
    let fetchCalls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        const body = retries[fetchCalls - 1] ?? "";
        return new Response(body, { status: 200 });
    }) as typeof fetch;
    const chunks: Buffer[] = [];
    try {
        const ctx = makeCtx(id, messages);
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
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls };
}

test("#2612 loop: CC compaction instruction in history + </summary>-ending reply — NO auto-retry", async () => {
    const ccMsg: CoreMessage = { id: "m_cc", role: "user", contentType: "text", text: CC_REQUEST_TEXT };
    const { fetchCalls } = await drainOpenai(OPENAI_DRAFT_TAIL, [OPENAI_GOOD], "cc-l1", [ccMsg]);
    assert.equal(fetchCalls, 0, "the client's own compaction must not spend the continuation nudge");
});

test("#2612 loop: SAME reply WITHOUT the instruction still auto-retries (#2303 preserved)", async () => {
    const { fetchCalls } = await drainOpenai(OPENAI_DRAFT_TAIL, [OPENAI_GOOD], "dt-l1", []);
    assert.equal(fetchCalls, 1, "without the client-summary instruction a genuine draft-tail stall still spends the nudge");
});
