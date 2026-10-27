import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { endsWithAnnouncement, endsWithDraftClose } from "../src/degenerate-turn.ts";
import type { Session } from "../src/session.ts";
import { runCompressLoop, createOpenaiAdapter } from "../src/loop/index.ts";
import { buildCompressSystemPrompt } from "../src/compress-tool.ts";

// #3905: a terminal turn whose ENTIRE visible output is a short promise of the
// next action ("Running verify after formatting:") ending on a colon or
// ellipsis, with no tool call and a clean stop, used to read as a healthy
// completed turn — the model announced the action instead of issuing it, and
// the session stalls until the user types something (verbatim production stub:
// ses_eb6da0d60ffeYpnNQDoGz000Pc, deepseek-v4.1-flash combo member, 24 output
// tokens / 32 visible chars, finish=stop). All three terminal-verdict lanes
// must treat it as non-converged and spend their one-shot continuation nudge
// on it: the plugin chat pipe, the plugin responses pipe, and the compress
// loop — mirroring the #2303 draft-tail suite.

// ---------- detector unit ----------

const ANNOUNCE_STUB = "Running verify after formatting:";

test("endsWithAnnouncement: the production stubs and their ellipsis forms", () => {
    assert.equal(endsWithAnnouncement("\n" + ANNOUNCE_STUB), true, "leading newline is stream residue");
    assert.equal(endsWithAnnouncement(ANNOUNCE_STUB), true);
    assert.equal(endsWithAnnouncement("Now I'll check the three suites:"), true);
    assert.equal(endsWithAnnouncement("Let me look at that output\u2026"), true, "unicode ellipsis");
    assert.equal(endsWithAnnouncement("Let me look at that output..."), true, "ascii ellipsis");
    assert.equal(endsWithAnnouncement(`${ANNOUNCE_STUB}  \r\n`), true, "trailing whitespace");
});

test("endsWithAnnouncement: legitimate short answers ending on a colon or ellipsis are NOT stubs", () => {
    assert.equal(endsWithAnnouncement(""), false);
    assert.equal(endsWithAnnouncement("   \n\t "), false, "whitespace-only is the empty-turn shape, not this one");
    assert.equal(endsWithAnnouncement("All done."), false, "a normal sentence end is not a promise");
    assert.equal(endsWithAnnouncement("Deleted."), false);
    assert.equal(endsWithAnnouncement("The answer is 42:"), false, "colon without an action-intent cue is a complete short answer");
    assert.equal(endsWithAnnouncement("I'm not sure\u2026"), false, "ellipsis without a cue is prose");
    assert.equal(endsWithAnnouncement("I'm not sure..."), false);
    assert.equal(endsWithAnnouncement("Here is how to run it:"), false, "base-form 'run' inside an explanation is not a cue (progressive forms + intent phrases only)");
});

test("endsWithAnnouncement: the 400-char cap stays the length boundary once a cue is present", () => {
    const pad = (total: number) => `${ANNOUNCE_STUB.slice(0, -1)}${"a".repeat(total - ANNOUNCE_STUB.length)}:`;
    assert.equal(endsWithAnnouncement(pad(400)), true, "exactly 400 chars is still inside the cap");
    assert.equal(endsWithAnnouncement(pad(401)), false, "401 chars is past the cap");
    assert.equal(endsWithAnnouncement("y".repeat(400)), false, "no promise tail at all");
});

test("endsWithAnnouncement: an unclosed code fence is the truncation class, not a stall (#1755/#2190)", () => {
    assert.equal(endsWithAnnouncement("Running the tests:\n```\nstep one:"), false, "odd fence count — cut inside a code block");
    assert.equal(endsWithAnnouncement("Running the tests:\n```\nconst a = 1;\n```"), false, "closed fence, and no promise tail either");
});

test("endsWithAnnouncement: disjoint from endsWithDraftClose", () => {
    assert.equal(endsWithAnnouncement("handoff draft\n</summary>"), false, "#2303 owns the draft-close shape");
    assert.equal(endsWithDraftClose(ANNOUNCE_STUB), false, "#3905 owns the announcement shape");
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

/** The production shape (sanitized): the whole visible output is the one-line
 *  promise, delivered as the message's text with no tool call. */
function announceTurn(): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: `\n${ANNOUNCE_STUB}` }), chatStop(), DONE];
}

function proseTurn(text: string): string[] {
    return [chatChunk({ role: "assistant" }), chatChunk({ content: text }), chatStop(), DONE];
}

function textDeltas(raw: string): string {
    return [...raw.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string).join("");
}

// ---------- plugin chat pipe (the DSH native evidence lane) ----------

test("#3905 chat(openai): bare-announcement terminal turn spends the continuation nudge once", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("real action issued after the nudge")));
    };
    await pipePluginChatWithStrip(streamOf(announceTurn()), makeRes(out), "openai", makeSession(), (m) => logs.push(m), refetch);
    const text = out.join("");
    assert.equal(calls, 1, "exactly one re-issue");
    assert.ok(textDeltas(text).includes(ANNOUNCE_STUB), "the first attempt's stub still reaches the client");
    assert.ok(textDeltas(text).endsWith("real action issued after the nudge"), "the retry's content appends to the same stream");
    assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1, "one turn, one terminal");
    assert.equal((text.match(/"finish_reason":"stop"/g) ?? []).length, 1, "the first attempt's terminal is dropped, not doubled");
    assert.ok(logs.some((l) => l.includes("#3905")), `the distinct #3905 log line fired, got: ${JSON.stringify(logs)}`);
});

test("#3905 chat: a legitimate short answer ending on a colon is NOT retried", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf(proseTurn("The answer is 42:")), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "no action-intent cue — the delivered answer is never duplicated or re-billed");
});

test("#3905 chat: a legitimate short answer ending on an ellipsis is NOT retried", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    await pipePluginChatWithStrip(streamOf(proseTurn("I'm not sure\u2026")), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "ellipsis without a cue is prose, not a promise");
});

test("#3905 chat: a bare announcement WITH a tool call is NOT retried", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(proseTurn("unwanted")));
    };
    const events = [
        chatChunk({ role: "assistant" }),
        chatChunk({ content: ANNOUNCE_STUB }),
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "compress", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`,
        chatStop("tool_calls"),
        DONE,
    ];
    await pipePluginChatWithStrip(streamOf(events), makeRes(out), "openai", makeSession(), undefined, refetch);
    assert.equal(calls, 0, "a tool call means the step converges");
    assert.ok(out.join("").includes("compress"), "the agent's own tool call still passes through");
});

test("#3905 chat: an announcement RETRY degenerates into the in-band error (#870 path)", async () => {
    const out: string[] = [];
    const refetch = () => Promise.resolve(streamOf(announceTurn()));
    await pipePluginChatWithStrip(streamOf(announceTurn()), makeRes(out), "openai", makeSession(), undefined, refetch);
    const text = out.join("");
    assert.ok(
        text.includes("[ACP] stream error"),
        "the client is told, rather than left with a second silent announcement",
    );
});

// ---------- plugin responses pipe ----------

function responsesAnnounceTurn(responseId = "resp_1", itemId = "item_1"): string[] {
    const text = ANNOUNCE_STUB;
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

test("#3905 responses: bare-announcement completed turn spends the continuation nudge once", async () => {
    const out: string[] = [];
    const logs: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("recovered after the nudge")));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesAnnounceTurn()), makeRes(out), makeSession(), (m) => logs.push(m), refetch);
    const text = out.join("");
    assert.equal(calls, 1, "exactly one re-issue");
    assert.ok(responsesDeltas(text).includes(ANNOUNCE_STUB), "the first attempt's stub still reaches the client");
    assert.ok(responsesDeltas(text).endsWith("recovered after the nudge"), "the retry's prose appends to the same item");
    assert.equal((text.match(/"type":"response\.created"/g) ?? []).length, 1, "the retry does not open a second response");
    assert.equal((text.match(/"type":"response\.completed"/g) ?? []).length, 1, "one turn, one terminal");
    assert.ok(!text.includes("item_2") && !text.includes("resp_2"), `the retry's ids are rewritten onto the client's, got: ${text}`);
    assert.ok(logs.some((l) => l.includes("#3905")), `the distinct #3905 log line fired, got: ${JSON.stringify(logs)}`);
});

test("#3905 responses: a legitimate short answer ending on an ellipsis is NOT retried", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("unwanted")));
    };
    await pipePluginResponsesWithStrip(streamOf(responsesProseTurn("I'm not sure...")), makeRes(out), makeSession(), undefined, refetch);
    assert.equal(calls, 0, "ellipsis without a cue is prose, not a promise");
});

test("#3905 responses: a bare announcement WITH a function call is NOT retried", async () => {
    const out: string[] = [];
    let calls = 0;
    const refetch = () => {
        calls += 1;
        return Promise.resolve(streamOf(responsesProseTurn("unwanted")));
    };
    const events = [
        sse("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
        sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "item_1", type: "function_call", name: "read" } }),
        sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, delta: ANNOUNCE_STUB }),
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

const OPENAI_ANNOUNCE = openaiSse([
    { id: "chatcmpl_a1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_a1", choices: [{ index: 0, delta: { content: ANNOUNCE_STUB }, finish_reason: null }] },
    { id: "chatcmpl_a1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

const OPENAI_GOOD = openaiSse([
    { id: "chatcmpl_g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_g1", choices: [{ index: 0, delta: { content: "continued after nudge" }, finish_reason: null }] },
    { id: "chatcmpl_g1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
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

test("#3905 loop: a bare announcement → one invisible retry with the continuation nudge", async () => {
    const { out, fetchCalls, bodies } = await drainOpenai(OPENAI_ANNOUNCE, [OPENAI_GOOD], "at-l1");
    assert.equal(fetchCalls, 1, "exactly one announcement-tail auto-retry");
    assert.ok(bodies[0]!.includes("ended without a tool call"), "the retry carries the continuation nudge");
    assert.ok(out.includes(ANNOUNCE_STUB), "the stub itself reached the client (the host already rendered it)");
    assert.ok(out.includes("continued after nudge"), "the retried turn's content was delivered");
});

test("#3905 loop: one-shot bound — an announcement RETRY is not retried again", async () => {
    const { fetchCalls } = await drainOpenai(OPENAI_ANNOUNCE, [OPENAI_ANNOUNCE], "at-l2");
    assert.equal(fetchCalls, 1, "one retry max; a second announcement falls through to the plain completion");
});

test("#3905 loop: a cue-bearing answer PAST the 400-char cap is NOT retried", async () => {
    // 441 chars with a real action cue ("Running") and a colon tail: ONLY the
    // length cap can deny it, so this pins the cap itself at loop level.
    const longCueAnswer = ("Running through the failing suites: " + "lorem ipsum dolor sit amet ".repeat(15)).trimEnd() + ":";
    assert.ok(longCueAnswer.length > 400, `fixture drifted: ${longCueAnswer.length}`);
    const longTurn = openaiSse([
        { id: "chatcmpl_n1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { id: "chatcmpl_n1", choices: [{ index: 0, delta: { content: longCueAnswer }, finish_reason: null }] },
        { id: "chatcmpl_n1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const { fetchCalls } = await drainOpenai(longTurn, [OPENAI_GOOD], "at-l3");
    assert.equal(fetchCalls, 0, "the 400-char cap keeps real prose out of the retry");
});

test("#3905 loop: a normal completed turn is NOT retried", async () => {
    const normal = openaiSse([
        { id: "chatcmpl_z1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { id: "chatcmpl_z1", choices: [{ index: 0, delta: { content: "all steps finished, nothing pending" }, finish_reason: null }] },
        { id: "chatcmpl_z1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    const { fetchCalls } = await drainOpenai(normal, [OPENAI_GOOD], "at-l4");
    assert.equal(fetchCalls, 0);
});

test("#3905 loop: an announcement WITH a tool call is NOT retried", async () => {
    const withCall = openaiSse([
        { id: "chatcmpl_t1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { id: "chatcmpl_t1", choices: [{ index: 0, delta: { content: ANNOUNCE_STUB }, finish_reason: null }] },
        { id: "chatcmpl_t1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }] }, finish_reason: null }] },
        { id: "chatcmpl_t1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const { fetchCalls } = await drainOpenai(withCall, [OPENAI_GOOD], "at-l5");
    assert.equal(fetchCalls, 0, "a tool call means the step converges");
});

test("#3905 loop: a length-cut announcement retries like the #2303 sibling", async () => {
    const lengthCut = openaiSse([
        { id: "chatcmpl_l1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
        { id: "chatcmpl_l1", choices: [{ index: 0, delta: { content: ANNOUNCE_STUB }, finish_reason: null }] },
        { id: "chatcmpl_l1", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
    ]);
    const { fetchCalls } = await drainOpenai(lengthCut, [OPENAI_GOOD], "at-l6");
    // Verified against the shipped #2303 implementation: a draft tail ending on
    // finish=length is retried there too (fetchCalls === 1). The loop's gate
    // excludes only failed/incomplete/error, so `length` is in scope for both
    // shapes — matching the sibling rather than inventing a stricter rule.
    assert.equal(fetchCalls, 1, "matches the #2303 sibling's treatment of finish=length");
});
