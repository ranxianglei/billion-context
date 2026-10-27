import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, CoreMessage } from "acp-kernel";
import { createCore, createInitialState } from "acp-kernel";
import { pipePluginChatWithStrip, pipePluginResponsesWithStrip } from "../src/plugin.ts";
import { endsWithAnnouncement, endsWithDraftClose } from "../src/degenerate-turn.ts";
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

test("endsWithAnnouncement: the production stub, its ellipsis forms, and the prose boundary", () => {
    // Verbatim production stub (ses_eb6da0d60ffeYpnNQDoGz000Pc, 2026-10-19 11:21:43Z,
    // 24 output tokens / 32 visible chars, finish=stop, no tool call).
    assert.equal(endsWithAnnouncement("\nRunning verify after formatting:"), true);
    assert.equal(endsWithAnnouncement("Running verify after formatting:"), true);
    assert.equal(endsWithAnnouncement("Now I'll check the three suites:"), true);
    assert.equal(endsWithAnnouncement("Let me look at that output\u2026"), true, "unicode ellipsis");
    assert.equal(endsWithAnnouncement("Let me look at that output..."), true, "ascii ellipsis");
    assert.equal(endsWithAnnouncement("Running verify after formatting:  \r\n"), true, "trailing whitespace");
});

test("endsWithAnnouncement: rejects everything that is not a stub", () => {
    assert.equal(endsWithAnnouncement(""), false);
    assert.equal(endsWithAnnouncement("   \n\t "), false, "whitespace-only is the empty-turn shape, not this one");
    assert.equal(endsWithAnnouncement("All done."), false, "a normal sentence end is not a promise");
    assert.equal(endsWithAnnouncement("Deleted."), false);
    assert.equal(endsWithAnnouncement("The answer is 42:"), true, "documented cost: a very short answer ending on a colon is indistinguishable from a stub");
    // The 400-char cap is the entire recall/precision boundary: a long answer
    // that happens to end on a colon is prose.
    assert.equal(endsWithAnnouncement("x".repeat(399) + ":"), true, "exactly 400 chars is still inside the cap");
    assert.equal(endsWithAnnouncement("x".repeat(400) + ":"), false, "401 chars is past the cap");
    assert.equal(endsWithAnnouncement("y".repeat(400)), false, "no promise tail at all");
});

test("endsWithAnnouncement: disjoint from endsWithDraftClose", () => {
    assert.equal(endsWithAnnouncement("handoff draft\n</summary>"), false, "#2303 owns the draft-close shape");
    assert.equal(endsWithDraftClose("Running verify after formatting:"), false, "#3905 owns the announcement shape");
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

const ANNOUNCE_STUB = "Running verify after formatting:";

const OPENAI_ANNOUNCE = openaiSse([
    { id: "chatcmpl_a1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_a1", choices: [{ index: 0, delta: { content: ANNOUNCE_STUB }, finish_reason: null }] },
    { id: "chatcmpl_a1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]);

const OPENAI_ANSWER_END_COLON = openaiSse([
    { id: "chatcmpl_n1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl_n1", choices: [{ index: 0, delta: { content: "Here is the full explanation of the three failing suites:" }, finish_reason: null }] },
    { id: "chatcmpl_n1", choices: [{ index: 0, delta: { content: " 1) aaaa 2) bbbb 3) cccc and the remainder of a genuinely long answer that keeps going well past the cap" }, finish_reason: null }] },
    { id: "chatcmpl_n1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
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

test("#3905 loop: a long answer ending on a colon is NOT retried", async () => {
    const { fetchCalls } = await drainOpenai(OPENAI_ANSWER_END_COLON, [OPENAI_GOOD], "at-l3");
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
