import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { requestExpectsProseSummary } from "../src/degenerate-turn.ts";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #2612: the #2303 draft-tail verdict breaks the CLIENT's own compaction.
// Claude Code's compaction request (/compact, auto-compact, precomputed
// compression) instructs the model to answer with a plain-text <analysis> +
// <summary> block and NO tool call, so a compliant reply necessarily ends with
// </summary> — exactly the #2303 shape. The retry re-asks, the retry also
// complies, and the #870 in-band error turns every compaction into
// "automatic compaction failed". All three #2303 lanes must skip the
// draft-tail retry when the request itself carries the summary instruction.

// ---------- helper unit tests ----------

const CC_COMPACTION_PROMPT =
    "Summarize the conversation so far. Your summary should be about 8-29 sentences. \nWrap your summary in <summary></summary> tags.\nREMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block.";

test("requestExpectsProseSummary: Claude Code compaction phrasing is detected", () => {
    assert.equal(requestExpectsProseSummary(CC_COMPACTION_PROMPT), true);
    assert.equal(requestExpectsProseSummary(`...earlier turns...\nuser: ${CC_COMPACTION_PROMPT}`), true, "matches inside a full wire body too");
    assert.equal(requestExpectsProseSummary("an <analysis> block followed by a <summary> block"), true, "the second production phrase alone");
    assert.equal(requestExpectsProseSummary(undefined), false);
    assert.equal(requestExpectsProseSummary(""), false);
    assert.equal(requestExpectsProseSummary("normal agent turn, no summary instruction"), false);
    // A bare tag in the history (e.g. a bili compress receipt echo) must NOT
    // suppress the retry for ordinary turns — only the instruction phrases do.
    assert.equal(requestExpectsProseSummary("· b1 summary 40ch · head … tail"), false);
    assert.equal(requestExpectsProseSummary("Wrap your summary in <summery></summery> tags"), false, "near-miss typo does not match");
});

// ---------- shared fixtures (mirrors issue2303-draft-tail.test.ts) ----------

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

/** A compliant compaction reply: multi-line analysis + summary, ending with
 *  </summary>, no tool call — the exact production shape from the issue. */
const SUMMARY_REPLY_BODY = "<analysis>\nThe session set up a DSH plugin profile, installed billion-context, and contributed two upstream fixes.\n</analysis>\n<summary>\nDSH profile working; billion-context 0.1.188 installed; PR #2479 merged, PR #2586 pending.\n";
const SUMMARY_REPLY_TAIL = "</summary>";

function compactionReplyTurn(): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: SUMMARY_REPLY_BODY }), chatChunk({ content: SUMMARY_REPLY_TAIL }), chatStop(), DONE];
}

function proseTurn(text: string): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: text }), chatStop(), DONE];
}

function textDeltas(raw: string): string {
    return [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

// ---------- plugin chat pipe (the bili claude lane from the issue) ----------

test("#2612 chat: compliant compaction reply is NOT retried when the request carries the summary instruction", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("must not happen")));
    };
    await pipePluginChatWithStrip(
        streamOf(compactionReplyTurn()), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch,
        undefined, // upstreamOrigin
        false, // absorbInstructed
        CC_COMPACTION_PROMPT, // requestText: the shipped wire body text
    );
    const text = out.join("");
    assert.equal(calls, 0, "no re-issue: the reply is the requested answer, not a stalled draft");
    assert.ok(!logs.some((l) => l.includes("#2303") || l.includes("#870")), `no draft-tail retry, no in-band error, got: ${JSON.stringify(logs)}`);
    assert.ok(!text.includes("[ACP] stream error"), "the client's compaction completes normally");
    assert.ok(textDeltas(text).includes("<summary>"), "the compliant summary passes through verbatim");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "one turn, one terminal");
});

test("#2612 chat: the SAME reply IS still retried when the request has no summary instruction (#2303 preserved)", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("real action issued after the nudge")));
    };
    await pipePluginChatWithStrip(
        streamOf(compactionReplyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch,
    );
    assert.equal(calls, 1, "the #2303 protection is unchanged for ordinary turns");
});

test("#2612 chat: a bare </summary> in the HISTORY does not suppress the retry", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("recovered")));
    };
    // History carries compress-receipt summary text, but no instruction phrase.
    const requestText = '…earlier turns… · b1 summary 40ch · head "…" … tail "…" … Fingerprints show head/tail only.';
    await pipePluginChatWithStrip(
        streamOf(compactionReplyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch,
        undefined, false, requestText,
    );
    assert.equal(calls, 1, "only the instruction phrases gate the retry, not any <summary> mention");
});

// ---------- plugin responses pipe ----------

function responsesCompactionReplyTurn(): string[] {
    const text = `${SUMMARY_REPLY_BODY}${SUMMARY_REPLY_TAIL}`;
    return [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: "item_1", output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: text }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: "item_1", output_index: 0, text }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ id: "item_1", type: "message", content: [{ type: "output_text", text }] }] } }),
    ];
}

test("#2612 responses: compliant compaction reply is NOT retried when the request carries the summary instruction", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf([DONE]));
    };
    await pipePluginResponsesWithStrip(
        streamOf(responsesCompactionReplyTurn()), makeRes(out), makeSession(), undefined, refetch,
        undefined, false, CC_COMPACTION_PROMPT,
    );
    const text = out.join("");
    assert.equal(calls, 0, "no re-issue on the responses wire either");
    assert.ok(!text.includes("[ACP] stream error"), "no in-band error");
    assert.equal((text.match(/"type":"response\.completed"/g) ?? []).length, 1, "one turn, one terminal");
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

const OPENAI_COMPLIANT_REPLY = openaiSse([
    { id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { content: SUMMARY_REPLY_BODY }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: { content: SUMMARY_REPLY_TAIL }, finish_reason: null }] },
    { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
);

const OPENAI_GOOD = openaiSse([
    { id: "chatcmpl_2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: { content: "continued after nudge" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
);

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

test("#2612 loop: compliant compaction reply is NOT retried when the last user message carries the instruction", async () => {
    const messages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "long session elided" },
        { id: "a1", role: "assistant", contentType: "text", text: "long reply elided" },
        { id: "u2", role: "user", contentType: "text", text: CC_COMPACTION_PROMPT },
    ];
    const { out, fetchCalls } = await drainOpenai(OPENAI_COMPLIANT_REPLY, [OPENAI_GOOD], "cc-l1", messages);
    assert.equal(fetchCalls, 0, "no auto-retry: the reply answers the compaction request");
    assert.ok(!out.includes("[ACP] stream error"), "no in-band error");
    assert.ok(out.includes("</summary>"), "the compliant summary reaches the client");
});

test("#2612 loop: the SAME reply IS still retried without the instruction (#2303 preserved)", async () => {
    const messages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "do the followup" },
    ];
    const { fetchCalls } = await drainOpenai(OPENAI_COMPLIANT_REPLY, [OPENAI_GOOD], "cc-l2", messages);
    assert.equal(fetchCalls, 1, "the #2303 protection is unchanged for ordinary turns");
});
