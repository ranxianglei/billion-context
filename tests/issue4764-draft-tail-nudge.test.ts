import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import {
    DEGENERATE_RETRY_NUDGE,
    DRAFT_TAIL_RETRY_NUDGE_COMPLETE,
    DRAFT_TAIL_RETRY_NUDGE_TRUNCATED,
    injectContinuationNudge,
    makeContinuationRefetch,
} from "../src/degenerate-retry.ts";
import { draftTailKind, requestExpectsProseSummaryShape } from "../src/degenerate-turn.ts";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #4764: the compression nudge never told OpenAI-lane models to use the
// `compress` tool, so they wrote the <analysis>/<summary> draft as prose; the
// #2303 draft-tail guard then fired with the GENERIC degenerate nudge ("take
// your next concrete action"), which the model read as permission to do
// anything else — Edit/Bash instead of the compress call, and the compression
// never happened. Three fixes land here:
//   1. the draft-tail retry names the pending action, split by draft shape
//      (complete draft: submit what was written; truncated: finish via the
//      tool) — proxy loop AND both plugin pipes;
//   2. the #2612 escape hatch gains a vendor-agnostic tag-SHAPE twin for the
//      PROXY lane only (hosts whose compaction instruction names the tags
//      without either Claude Code phrasing were being retried like stalled
//      drafts); plugin pipes stay lexical-only because their test view is the
//      WHOLE shipped body, which carries previously injected nudges verbatim;
//   3. the generic wording is preserved byte-for-byte everywhere it is not a
//      draft-tail retry (#732/#821 empty-turn shape unchanged).

// ---------- unit: draftTailKind ----------

test("draftTailKind: classifies the closing tag at the tail", () => {
    assert.equal(draftTailKind("<analysis>\nx\n</analysis>"), "truncated");
    assert.equal(draftTailKind("<analysis>\nx\n</analysis>\n\n"), "truncated");
    assert.equal(draftTailKind("<summary>\nx\n</summary>"), "complete");
    assert.equal(draftTailKind("prose ... </SUMMARY>"), "complete", "case-insensitive (#1731 drift)");
    assert.equal(draftTailKind("</Analysis>"), "truncated");
    // negatives: no draft close at the tail
    assert.equal(draftTailKind(""), null);
    assert.equal(draftTailKind("plain answer text"), null);
    assert.equal(draftTailKind("<summary>open only"), null, "opening tag alone is not a close");
    assert.equal(draftTailKind("... </summry>"), null, "near-miss typo does not match");
    assert.equal(draftTailKind("... </summarize>"), null, "longer word does not match");
});

// ---------- unit: requestExpectsProseSummaryShape ----------

const WORKBUDDY_STYLE_INSTRUCTION =
    "Please summarize the conversation so far. Put your final summary inside <summary> tags and do not call any tools.";

test("requestExpectsProseSummaryShape: tag shape in the instruction is detected without the Claude Code phrases", () => {
    assert.equal(requestExpectsProseSummaryShape(WORKBUDDY_STYLE_INSTRUCTION), true);
    assert.equal(requestExpectsProseSummaryShape("end with an <analysis> block"), true);
    assert.equal(requestExpectsProseSummaryShape("</summary>"), true, "bare closing token counts");
    assert.equal(requestExpectsProseSummaryShape("<conversation_history_summary>x</conversation_history_summary>"), true, "legacy vendor marker substring");
    assert.equal(requestExpectsProseSummaryShape("<Summary> tags please"), true, "case-insensitive");
    // negatives
    assert.equal(requestExpectsProseSummaryShape(undefined), false);
    assert.equal(requestExpectsProseSummaryShape(""), false);
    assert.equal(requestExpectsProseSummaryShape("write a summary of the session"), false, "the word alone is not a tag");
    assert.equal(requestExpectsProseSummaryShape("<summery>typo"), false, "near-miss typo does not match");
});

// ---------- unit: nudge injection plumbing ----------

const OPENAI_MIN_BODY = JSON.stringify({ model: "qwen", messages: [{ role: "user", content: "hi" }] });

function trailingUserContent(body: string | null): string | null {
    if (body === null) return null;
    const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
    return parsed.messages[parsed.messages.length - 1]?.content ?? null;
}

test("injectContinuationNudge: default keeps the generic wording byte-for-byte", () => {
    // The openai wire appends the nudge to the EXISTING trailing user message
    // (never a second consecutive user message).
    const injected = injectContinuationNudge("openai", OPENAI_MIN_BODY);
    assert.equal(trailingUserContent(injected), "hi\n\n" + DEGENERATE_RETRY_NUDGE);
});

test("injectContinuationNudge: explicit text replaces the generic wording", () => {
    const injected = injectContinuationNudge("openai", OPENAI_MIN_BODY, DRAFT_TAIL_RETRY_NUDGE_TRUNCATED);
    assert.equal(trailingUserContent(injected), "hi\n\n" + DRAFT_TAIL_RETRY_NUDGE_TRUNCATED);
    assert.ok(!trailingUserContent(injected)!.includes("take your next concrete action"));
});

test("makeContinuationRefetch: threads the caller's nudge into the retry body", async () => {
    const orig = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        if (typeof init?.body === "string") bodies.push(init.body);
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as typeof fetch;
    try {
        const refetch = makeContinuationRefetch({
            protocol: "openai",
            body: OPENAI_MIN_BODY,
            upstreamUrl: "http://127.0.0.1:1/v1/chat/completions",
            reqHeaders: {},
            signal: new AbortController().signal,
            log: () => {},
            label: "testrefetch",
        });
        await refetch(DRAFT_TAIL_RETRY_NUDGE_COMPLETE);
        await refetch();
        assert.equal(bodies.length, 2);
        assert.ok(bodies[0]!.includes(DRAFT_TAIL_RETRY_NUDGE_COMPLETE), "explicit nudge rides the retry body");
        assert.ok(!bodies[0]!.includes("take your next concrete action"));
        assert.ok(bodies[1]!.includes(DEGENERATE_RETRY_NUDGE), "omitted argument falls back to the generic wording");
    } finally {
        globalThis.fetch = orig;
    }
});

// ---------- shared fixtures (mirrors issue2612-compaction-draft-tail.test.ts) ----------

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

const TAG_OPEN = "\x3cacp tokens=\"247\" type=\"text\"\x3e";
const TAG_CLOSE = "\x3c/acp\x3e";

/** The production shape from #4764: a COMPLETE compression draft written as
 *  prose — analysis block, summary block, ends with </summary>, no tool call. */
const COMPLETE_DRAFT = "\x3canalysis\x3e\nThe session consumed its exploration outputs; the build and test results are spent.\n\x3c/analysis\x3e\n\x3csummary\x3e\nBuilt the retry lane; targeted suites green; PR pending.\n\x3c/summary\x3e";
/** A TRUNCATED draft: the analysis finished, the summary block never started. */
const TRUNCATED_DRAFT = "\x3canalysis\x3e\nThe session consumed its exploration outputs.\n\x3c/analysis\x3e";

function proseTurn(text: string): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: text }), chatStop(), DONE];
}

/** The #732/#821 empty-turn shape: the only text is a render-tag echo the
 *  filter empties, leaving a completed turn with nothing visible. */
function echoOnlyTurn(): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: `${TAG_OPEN}m00155${TAG_CLOSE}` }), chatStop(), DONE];
}

function responsesDraftTurn(text: string): string[] {
    return [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "message", content: [] } }),
        sse("response.content_part.added", { type: "response.content_part.added", item_id: "item_1", output_index: 0, part: { type: "output_text", text: "" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: text }),
        sse("response.output_text.done", { type: "response.output_text.done", item_id: "item_1", output_index: 0, text }),
        sse("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ id: "item_1", type: "message", content: [{ type: "output_text", text }] }] } }),
    ];
}

// ---------- plugin chat pipe: the nudge the retry carries ----------

test("#4764 chat: complete draft tail retries with the compress-naming nudge (complete variant)", async () => {
    const out: string[] = [];
    const nudges: Array<string | undefined> = [];
    const refetch = (n?: string) => {
        nudges.push(n);
        return Promise.resolve(streamOf(proseTurn("compress issued")));
    };
    await pipePluginChatWithStrip(
        streamOf(proseTurn(COMPLETE_DRAFT)), makeRes(out), "openai", makeSession(), undefined, refetch,
    );
    assert.equal(nudges.length, 1, "the #2303 guard fires exactly once");
    assert.equal(nudges[0], DRAFT_TAIL_RETRY_NUDGE_COMPLETE, "steers at the pending compress call, not the generic action");
    assert.ok(!out.join("").includes("[ACP] stream error"));
});

test("#4764 chat: truncated draft tail retries with the truncated variant", async () => {
    const out: string[] = [];
    const nudges: Array<string | undefined> = [];
    const refetch = (n?: string) => {
        nudges.push(n);
        return Promise.resolve(streamOf(proseTurn("recover")));
    };
    await pipePluginChatWithStrip(
        streamOf(proseTurn(TRUNCATED_DRAFT)), makeRes(out), "openai", makeSession(), undefined, refetch,
    );
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0], DRAFT_TAIL_RETRY_NUDGE_TRUNCATED);
});

test("#4764 chat: the EMPTY-TURN shape (#732/#821) still gets the generic nudge, byte-for-byte", async () => {
    const out: string[] = [];
    const nudges: Array<string | undefined> = [];
    const refetch = (n?: string) => {
        nudges.push(n);
        return Promise.resolve(streamOf(proseTurn("recovered")));
    };
    await pipePluginChatWithStrip(
        streamOf(echoOnlyTurn()), makeRes(out), "openai", makeSession(), undefined, refetch,
    );
    assert.equal(nudges.length, 1, "empty-turn retry still fires");
    assert.equal(nudges[0], undefined, "no explicit text → the byte-identical generic default");
});

test("#4764 chat: literal draft tags in the SHIPPED BODY do not suppress the retry (lexical-only asymmetry)", async () => {
    const out: string[] = [];
    const nudges: Array<string | undefined> = [];
    const refetch = (n?: string) => {
        nudges.push(n);
        return Promise.resolve(streamOf(proseTurn("recovered")));
    };
    // A previously injected anthropic-lane note rides the host's resent history
    // verbatim — literal <analysis>/<summary> tokens, neither Claude Code
    // phrase. Extending the shape twin to this view would suppress the guard
    // forever; the retry must fire.
    const requestText = `earlier turns ... Never emit <analysis> or <summary> tags in your reply text — they are not parsed ... current request`;
    await pipePluginChatWithStrip(
        streamOf(proseTurn(COMPLETE_DRAFT)), makeRes(out), "openai", makeSession(), undefined, refetch,
        undefined, false, requestText,
    );
    assert.equal(nudges.length, 1, "the guard is NOT suppressed by injected-note tags in history");
    assert.equal(nudges[0], DRAFT_TAIL_RETRY_NUDGE_COMPLETE);
});

// ---------- plugin responses pipe: same contract ----------

test("#4764 responses: complete draft tail retries with the compress-naming nudge", async () => {
    const out: string[] = [];
    const nudges: Array<string | undefined> = [];
    const refetch = (n?: string) => {
        nudges.push(n);
        return Promise.resolve(streamOf([DONE]));
    };
    await pipePluginResponsesWithStrip(
        streamOf(responsesDraftTurn(COMPLETE_DRAFT)), makeRes(out), makeSession(), undefined, refetch,
    );
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0], DRAFT_TAIL_RETRY_NUDGE_COMPLETE);
    assert.ok(!out.join("").includes("[ACP] stream error"));
});

test("#4764 responses: truncated draft tail retries with the truncated variant", async () => {
    const out: string[] = [];
    const nudges: Array<string | undefined> = [];
    const refetch = (n?: string) => {
        nudges.push(n);
        return Promise.resolve(streamOf([DONE]));
    };
    await pipePluginResponsesWithStrip(
        streamOf(responsesDraftTurn(TRUNCATED_DRAFT)), makeRes(out), makeSession(), undefined, refetch,
    );
    assert.equal(nudges.length, 1);
    assert.equal(nudges[0], DRAFT_TAIL_RETRY_NUDGE_TRUNCATED);
});

// ---------- compress loop (proxy mode): retry body + shape escape hatch ----------

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

function compliantReplySse(body: string, tail: string): string {
    return openaiSse([
        { id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { id: "chatcmpl_1", choices: [{ index: 0, delta: { content: body }, finish_reason: null }] },
        { id: "chatcmpl_1", choices: [{ index: 0, delta: { content: tail }, finish_reason: null }] },
        { id: "chatcmpl_1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
}

const OPENAI_GOOD = openaiSse([
    { id: "chatcmpl_2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: { content: "continued after nudge" }, finish_reason: null }] },
    { id: "chatcmpl_2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

async function drainCapturing(first: string, retries: string[], id: string, messages: CoreMessage[]): Promise<{ out: string; fetchCalls: number; bodies: string[] }> {
    let fetchCalls = 0;
    const bodies: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        fetchCalls++;
        if (typeof init?.body === "string") bodies.push(init.body);
        return new Response(retries[fetchCalls - 1] ?? "", { status: 200 });
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
    return { out: Buffer.concat(chunks).toString("utf8"), fetchCalls, bodies };
}

test("#4764 loop: complete draft tail retries with the complete-variant nudge in the retry body", async () => {
    const messages: CoreMessage[] = [{ id: "u1", role: "user", contentType: "text", text: "do the followup" }];
    const { fetchCalls, bodies } = await drainCapturing(compliantReplySse(COMPLETE_DRAFT, ""), [OPENAI_GOOD], "l4764-a", messages);
    assert.equal(fetchCalls, 1, "the #2303 guard fires");
    assert.ok(bodies[0]!.includes(DRAFT_TAIL_RETRY_NUDGE_COMPLETE), "retry body steers at the compress call");
    assert.ok(!bodies[0]!.includes("take your next concrete action"), "the generic wording no longer rides this path");
});

test("#4764 loop: truncated draft tail retries with the truncated-variant nudge", async () => {
    const messages: CoreMessage[] = [{ id: "u1", role: "user", contentType: "text", text: "do the followup" }];
    const { fetchCalls, bodies } = await drainCapturing(compliantReplySse(TRUNCATED_DRAFT, ""), [OPENAI_GOOD], "l4764-b", messages);
    assert.equal(fetchCalls, 1);
    assert.ok(bodies[0]!.includes(DRAFT_TAIL_RETRY_NUDGE_TRUNCATED));
    assert.ok(!bodies[0]!.includes("take your next concrete action"));
});

test("#4764 loop: tag-shape compaction instruction in the LAST user message suppresses the retry (shape twin)", async () => {
    const messages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: "long session elided" },
        { id: "u2", role: "user", contentType: "text", text: WORKBUDDY_STYLE_INSTRUCTION },
    ];
    const { out, fetchCalls } = await drainCapturing(compliantReplySse(COMPLETE_DRAFT, ""), [OPENAI_GOOD], "l4764-c", messages);
    assert.equal(fetchCalls, 0, "no auto-retry: the reply answers the host's own summary request");
    assert.ok(out.includes("\x3c/summary\x3e"), "the compliant summary reaches the client");
});

test("#4764 loop: tag shape in an EARLIER user message does not suppress the retry (last-user-message only)", async () => {
    const messages: CoreMessage[] = [
        { id: "u1", role: "user", contentType: "text", text: WORKBUDDY_STYLE_INSTRUCTION },
        { id: "a1", role: "assistant", contentType: "text", text: "done" },
        { id: "u2", role: "user", contentType: "text", text: "now continue the task" },
    ];
    const { fetchCalls } = await drainCapturing(compliantReplySse(COMPLETE_DRAFT, ""), [OPENAI_GOOD], "l4764-d", messages);
    assert.equal(fetchCalls, 1, "only the final user message carries a live compaction instruction");
});
